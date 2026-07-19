import { readFileSync, existsSync } from 'node:fs'
import { extname, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'
import { classifyFormat } from '@exodus/stasis-core/util'

// Static require/import graph walker: parses source, never loads or executes user code.
// Dynamic specifiers (`require(name)`, `import('./'+x)`) are recorded as unresolved.

const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const RESOLVABLE_EXTS = new Set([...SCRIPT_EXTS, '.json'])

// Required lazily so non-JS bundlers don't load the native oxc parser.
let _parser
function getParser() {
  _parser ??= createRequire(import.meta.url)('oxc-parser')
  return _parser
}

// classifyFormat is the shared name->format authority (static and runtime bundles must agree); it
// returns null for the .js/.ts family whose module system comes from package.json `type` (null =
// detect from syntax, signaled up as null).
function formatForFile(file) {
  const format = classifyFormat(file)
  if (format != null) return format
  const type = packageType(file)
  if (type === null) return null
  return `${type}${extname(file) === '.ts' ? '-typescript' : ''}`
}

function literalSpec(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked
  }
  return null
}

// Walks require()/import() calls only; ESM static imports/re-exports come from oxc module records.
function findCallSpecifiers(ast, push) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const c of node) visit(c)
      return
    }
    if (typeof node.type !== 'string') return

    if (node.type === 'CallExpression') {
      const { callee, arguments: args } = node
      if (callee.type === 'Identifier' && callee.name === 'require' && args.length >= 1) {
        const spec = literalSpec(args[0])
        if (spec != null) push({ kind: 'require', spec })
        else push({ kind: 'require', dynamic: true })
      }
    } else if (node.type === 'ImportExpression') {
      const spec = literalSpec(node.source)
      if (spec != null) push({ kind: 'dynamic-import', spec })
      else push({ kind: 'dynamic-import', dynamic: true })
    } else if (node.type === 'TSImportEqualsDeclaration') {
      // `import lib = require('./dep.cts')`: TS-only CJS import; record the real edge.
      // Qualified-name form (`import A = B.C`) carries no file edge.
      if (node.moduleReference?.type === 'TSExternalModuleReference') {
        const spec = literalSpec(node.moduleReference.expression)
        if (spec != null) push({ kind: 'require', spec })
        else push({ kind: 'require', dynamic: true })
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
  }
  visit(ast)
}

function condKey(set) {
  return [...set].join(', ')
}

export class Scan {
  files = new Map()
  imports = new Map()
  unresolved = []
  parseErrors = []
  entries = new Set()

  // `conditions` is additive on top of the format-derived base set. `resolve` optionally
  // replaces Node's resolver (resolve-fields.js): returns `{ url } | { empty } | { builtin } | null`
  // (`empty` = a browser/react-native `false` redirect) and owns builtin handling when set.
  constructor({ conditions = [], resolve = null } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
  }

  walk(entries) {
    const queue = []
    for (const entry of entries) {
      const abs = resolvePath(entry)
      assert.ok(existsSync(abs), `entry not found: ${abs}`)
      const url = pathToFileURL(abs).toString()
      this.entries.add(url)
      queue.push(url)
    }
    while (queue.length > 0) {
      const url = queue.shift()
      if (this.files.has(url)) continue
      this.#scanFile(url, queue)
    }
    return this
  }

  // Must match the runtime resolver's full condition set (Node 22: node, import|require,
  // module-sync, node-addons); omitting any resolves `exports`-gated packages to a different file.
  #conditionsFor(format) {
    const base = ['module', 'module-typescript'].includes(format)
      ? ['node', 'import', 'module-sync', 'node-addons']
      : ['node', 'require', 'module-sync', 'node-addons']
    return new Set([...base, ...this.extraConditions])
  }

  // `recovered`: false = parser crashed, nothing salvaged; true = oxc returned but we
  // discarded its partial module records (module-family only; see #scanFile).
  #recordParseError(url, format, message, recovered) {
    this.files.set(url, { format, edges: [], parseError: message })
    this.parseErrors.push({ url, format, message, recovered })
  }

  #scanFile(url, queue) {
    const file = fileURLToPath(url)
    const ext = extname(file)
    if (ext === '.json') {
      this.files.set(url, { format: 'json', edges: [] })
      return
    }
    if (!SCRIPT_EXTS.has(ext)) {
      this.files.set(url, { format: null, edges: [] })
      return
    }

    // declared === null: typeless package; Node decides .js/.ts by syntax, resolved after parse.
    const declared = formatForFile(file)
    const src = readFileSync(file, 'utf8')

    // Resolve the parser outside the try: a missing oxc-parser is an env error, not this
    // file's — it must not be swallowed into a silent zero-edge leaf.
    const parser = getParser()
    let parsed
    try {
      parsed = parser.parseSync(file, src, {
        sourceType: declared === null ? 'unambiguous'
          : declared.startsWith('module') ? 'module' : 'script',
      })
    } catch (cause) {
      this.#recordParseError(url, declared, cause.message, false)
      return
    }

    // Match Node's syntax detection for typeless packages: ESM syntax picks the module variant
    // (mislabeling as commonjs makes `--bundle=load` feed the wrong translator).
    let format = declared
      ?? `${parsed.module.hasModuleSyntax ? 'module' : 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`

    // oxc recovers from syntax errors (reports them in parsed.errors) rather than throwing;
    // Warning/Advice severities aren't real parse errors.
    const nonWarning = (p) => (p.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')
    let errors = nonWarning(parsed)

    // oxc's hasModuleSyntax misses top-level await, so a TLA-only ESM file parses here as a
    // broken script; mirror Node by retrying as module and preferring a clean module parse.
    if (errors.length > 0 && declared === null && !format.startsWith('module')) {
      try {
        const asModule = parser.parseSync(file, src, { sourceType: 'module' })
        if (nonWarning(asModule).length === 0) {
          parsed = asModule
          format = `module${ext === '.ts' ? '-typescript' : ''}`
          errors = []
        }
      } catch { /* keep the script parse and its recorded errors */ }
    }

    let parseError
    if (errors.length > 0) {
      parseError = errors.map((e) => e.message).join('; ')
      // A partially-parsed module file may be missing link-time edges we can't enumerate.
      if (format.startsWith('module')) {
        this.#recordParseError(url, format, parseError, true)
        return
      }
      // Script (CJS) files: oxc's recovered AST still yields the require()/import() edges — salvage them.
      this.parseErrors.push({ url, format, message: parseError, recovered: true })
    }

    const specs = []
    // Type-only edges (`import type`, `export type`) are erased before runtime — skip them so the
    // bundle matches Node's load graph. Mixed (`{ type A, B }`) and bare side-effect imports are kept.
    if (parsed.module?.staticImports) {
      for (const imp of parsed.module.staticImports) {
        if (imp.entries.length > 0 && imp.entries.every((e) => e.isType)) continue
        specs.push({ kind: 'import', spec: imp.moduleRequest.value })
      }
    }
    if (parsed.module?.staticExports) {
      for (const exp of parsed.module.staticExports) {
        for (const entry of exp.entries) {
          if (entry.moduleRequest && !entry.isType) specs.push({ kind: 'export-from', spec: entry.moduleRequest.value })
        }
      }
    }
    findCallSpecifiers(parsed.program, (s) => specs.push(s))

    const conditions = this.#conditionsFor(format)
    const key = condKey(conditions)
    const req = createRequire(file)
    const edges = []
    const specMap = new Map()

    for (const s of specs) {
      if (s.dynamic) {
        edges.push(s)
        this.unresolved.push({ parentURL: url, kind: s.kind, reason: 'dynamic' })
        continue
      }
      // Custom (legacy-field) resolver owns builtin handling and the `empty` outcome (browser/RN
      // `false` redirect): an empty edge is recorded but neither queued nor counted as unresolved.
      if (this.customResolve) {
        const r = this.customResolve(file, s.spec, conditions)
        if (r?.builtin) {
          edges.push({ ...s, builtin: true })
        } else if (r?.empty) {
          edges.push({ ...s, empty: true })
        } else if (r?.url) {
          edges.push({ ...s, child: r.url })
          specMap.set(s.spec, r.url)
          if (RESOLVABLE_EXTS.has(extname(fileURLToPath(r.url)))) queue.push(r.url)
        } else {
          edges.push({ ...s, error: 'MODULE_NOT_FOUND' })
          this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason: 'MODULE_NOT_FOUND' })
        }
        continue
      }
      if (isBuiltin(s.spec)) {
        edges.push({ ...s, builtin: true })
        continue
      }
      try {
        const childPath = req.resolve(s.spec, { conditions })
        const childURL = pathToFileURL(childPath).toString()
        edges.push({ ...s, child: childURL })
        specMap.set(s.spec, childURL)
        const childExt = extname(childPath)
        if (RESOLVABLE_EXTS.has(childExt)) queue.push(childURL)
      } catch (cause) {
        edges.push({ ...s, error: cause.code ?? cause.message })
        this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason: cause.code ?? cause.message })
      }
    }

    if (specMap.size > 0) {
      if (!this.imports.has(key)) this.imports.set(key, new Map())
      this.imports.get(key).set(url, specMap)
    }
    this.files.set(url, parseError ? { format, edges, parseError } : { format, edges })
  }

  toRelative(root) {
    const rel = (url) => {
      const abs = fileURLToPath(url)
      const r = relative(root, abs)
      if (r.startsWith('..')) throw new Error(`Path outside root: ${abs}`)
      return r
    }
    const relEdge = (e) => (e.child ? { ...e, child: rel(e.child) } : e)
    return {
      entries: new Set([...this.entries].map(rel)),
      files: new Map(
        [...this.files].map(([k, v]) => [rel(k), { ...v, edges: v.edges.map(relEdge) }])
      ),
      imports: new Map(
        [...this.imports].map(([cond, byParent]) => [
          cond,
          new Map(
            [...byParent].map(([p, specs]) => [
              rel(p),
              new Map([...specs].map(([spec, child]) => [spec, rel(child)])),
            ])
          ),
        ])
      ),
      unresolved: this.unresolved.map(({ parentURL, ...rest }) => ({ parent: rel(parentURL), ...rest })),
      parseErrors: this.parseErrors.map(({ url, ...rest }) => ({ file: rel(url), ...rest })),
    }
  }
}

export function scan(entries, options = {}) {
  return new Scan(options).walk(entries)
}
