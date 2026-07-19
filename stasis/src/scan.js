import { readFileSync, existsSync } from 'node:fs'
import { extname, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'

// Static require/import graph walker. Reads source files and parses them; never
// loads or executes any user code. Resolves specifiers through Node's own
// resolver (`createRequire(parent).resolve(spec, { conditions: Set })`), which
// reads package.json manifests and applies `exports` conditions but never runs
// the target module. Dynamic specifiers (`require(name)`, `import('./'+x)`)
// are recorded as unresolved -- a fundamental limit of static analysis for
// CJS, not a tooling shortcoming. Files that fail to parse are recorded in
// `parseErrors` (and flagged with `parseError` in `files`): for script (CJS)
// files oxc's recovered AST still yields the edges (Node's module wrapper
// accepts code oxc rejects, e.g. top-level `return`), while module files keep
// no edges -- a missed static edge is a hole consumers can't enumerate.

const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const RESOLVABLE_EXTS = new Set([...SCRIPT_EXTS, '.json'])

// oxc-parser is a regular dependency, required lazily so non-JS bundlers (which
// never reach getParser()) don't load the native parser.
let _parser
function getParser() {
  _parser ??= createRequire(import.meta.url)('oxc-parser')
  return _parser
}

// Format per Node's own rules. TypeScript files get Node's type-stripping
// formats ('module-typescript' / 'commonjs-typescript'), matching what Node's
// load hook reports for them. For .js/.ts the module system comes from the
// nearest package.json `type`; when that's absent (or unrecognized), Node
// falls back to module-syntax detection, which requires the parse — null
// signals "detect from syntax" to the caller.
function formatForFile(file) {
  const ext = extname(file)
  if (ext === '.mjs') return 'module'
  if (ext === '.cjs') return 'commonjs'
  if (ext === '.json') return 'json'
  if (ext === '.mts') return 'module-typescript'
  if (ext === '.cts') return 'commonjs-typescript'
  const type = packageType(file)
  if (type === null) return null
  const suffix = ext === '.ts' ? '-typescript' : ''
  return `${type}${suffix}`
}

function literalSpec(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked
  }
  return null
}

// Walk the AST for require() and dynamic import() calls. ESM static imports and
// re-exports are picked up separately from oxc-parser's `module.staticImports` /
// `module.staticExports` -- much cheaper than walking the whole tree for them.
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
      // `import lib = require('./dep.cts')`: TS-only CJS import form. Node's
      // type stripping refuses to run it (non-erasable syntax), but the
      // dependency edge is real — record it like a require() so the bundle
      // stays self-contained for transform-types users and external analysis.
      // Qualified-name references (`import A = B.C`) carry no file edge.
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

  // `conditions` is *additive* on top of the format-derived base set: ESM parents
  // get ['node', 'import'] and CJS parents get ['node', 'require'], with any
  // user-supplied conditions (e.g. 'browser', 'development') merged in. This
  // matches what the runtime loader records when Node reports conditions for an
  // edge -- different edges in the same scan can end up under different keys.
  //
  // `resolve` optionally replaces Node's own resolver with a custom one (the
  // legacy-field resolver in resolve-fields.js drives `stasis bundle --mainFields`).
  // It is called `(parentFile, specifier, conditions)` and returns
  // `{ url } | { empty: true } | { builtin: true } | null` -- `empty` marks a
  // browser/react-native `false` redirect (an empty-module stub the caller
  // materialises), the rest mirror Node resolution. When set, it also handles
  // builtins, so the built-in `isBuiltin` short-circuit is skipped.
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

  // Match the runtime resolver's full condition set. Node 22 passes
  // `['node', import|require, 'module-sync', 'node-addons']` to the resolve
  // hook; if we omit any of these, a package whose `exports` map gates on the
  // runtime-only conditions (e.g. `"module-sync": "./a.js", "import": "./b.js"`)
  // resolves to a different file under static scan than under plain Node.
  // Confirmed by reproducer with module-sync: plain node hits sync.js, static
  // bundle loads with async.js -- silently runs different code.
  #conditionsFor(format) {
    const base = ['module', 'module-typescript'].includes(format)
      ? ['node', 'import', 'module-sync', 'node-addons']
      : ['node', 'require', 'module-sync', 'node-addons']
    return new Set([...base, ...this.extraConditions])
  }

  // `recovered: false` means the parser crashed on this file and nothing was
  // salvaged -- its edges are entirely unknown. `recovered: true` means oxc
  // returned, but we discarded its partial module records (module-family
  // formats only; see #scanFile).
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

    // declared === null: typeless package, where Node decides .js/.ts by
    // module-syntax detection — that needs the parse, so resolve it below.
    const declared = formatForFile(file)
    const src = readFileSync(file, 'utf8')

    // Resolve the parser outside the per-file try below: a missing oxc-parser is
    // an environment error, not a property of this file, so it must not be
    // swallowed into a silent zero-edge leaf.
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

    // Match Node's module-syntax detection for typeless packages: ESM syntax
    // (import/export/import.meta) selects the module variant. Recording the
    // commonjs variant here would make `--bundle=load` feed the source to the
    // wrong translator, which throws instead of reparsing as ESM the way
    // Node's on-disk loader does.
    let format = declared
      ?? `${parsed.module.hasModuleSyntax ? 'module' : 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`

    // oxc-parser recovers from syntax errors instead of throwing: it reports
    // them in `parsed.errors` and returns whatever AST/module records it could
    // salvage. (Warning/advice-severity diagnostics don't imply a broken parse
    // and are not errors.)
    const nonWarning = (p) => (p.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')
    let errors = nonWarning(parsed)

    // Node's detector also counts top-level await as module syntax, which
    // oxc's hasModuleSyntax does not flag: a typeless file whose ESM-ness
    // rests on TLA alone parses here as a broken script while plain node runs
    // it as a clean module. Mirror Node's parse-as-CJS-retry-as-ESM: when the
    // detected-commonjs parse has errors but a module parse is clean, the
    // module parse wins. Genuine CJS salvage cases (e.g. a top-level `return`
    // guard) error under BOTH source types and stay on the script path.
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
      // A partially-parsed module file may be missing static link-time edges
      // -- holes we can't enumerate -- so don't pretend we know its imports.
      if (format.startsWith('module')) {
        this.#recordParseError(url, format, parseError, true)
        return
      }
      // Script (CJS) files: Node's module wrapper accepts code oxc rejects
      // (e.g. a top-level `return` guard), and oxc's recovered AST keeps the
      // require()/import() calls -- salvage the edges, record the error, and
      // let callers decide how loud to be.
      this.parseErrors.push({ url, format, message: parseError, recovered: true })
    }

    const specs = []
    // ESM static imports + re-exports come from oxc's pre-extracted module info.
    // Type-only edges (`import type ... from`, `export type ... from`) are
    // erased before runtime and never loaded by Node; skip them so the bundle
    // matches Node's actual load graph. A mixed `import { type A, B }` still
    // loads, and bare side-effect imports have no entries — both are kept.
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
    // require() and dynamic import() come from the AST.
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
      // Custom (legacy-field) resolver: it owns builtin handling and adds the
      // `empty` outcome (a browser/react-native `false` redirect). An empty edge
      // is recorded but neither queued (an empty module has no edges) nor counted
      // as unresolved (it resolved -- to nothing).
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
