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
// Under `jsx`, these get parsed with JSX enabled. Excludes the .ts family: TypeScript's `<T>`
// generics collide with JSX, so tsc/oxc reserve JSX for .tsx — JSX-in-TS belongs in a .tsx file.
const JSX_EXTS = new Set(['.js', '.cjs', '.mjs'])
// The inherently-JSX extensions (oxc parses them as JSX/TSX purely from the filename, no flag).
// Scanned + carried only under `--jsx`: off by default the scanner treats them as opaque leaves,
// so a bundle whose toolchain can't build JSX never silently ships .jsx/.tsx source. Under `--jsx`
// they join SCRIPT_EXTS/RESOLVABLE_EXTS (see the constructor) so a reached .jsx/.tsx dependency
// — e.g. a package whose React Native entry is src/index.tsx — is parsed and carried like any .ts.
const JSX_FILE_EXTS = new Set(['.jsx', '.tsx'])

// Flow type syntax lives in the JS (non-TS) family; oxc parses TS natively, and running
// flow-remove-types over a .ts file would corrupt TS-only constructs, so --flow only strips these.
const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs'])

// Required lazily so non-JS bundlers don't load the native oxc parser.
let _parser
function getParser() {
  _parser ??= createRequire(import.meta.url)('oxc-parser')
  return _parser
}

// flow-remove-types is an optional dependency, loaded lazily and only under --flow: it strips
// Flow type syntax down to plain JS before oxc (which parses JS/TS, not Flow) sees it. A missing
// dep is an env error, so surface it with an actionable install hint rather than a bare resolve throw.
let _flowRemoveTypes
function getFlowRemoveTypes() {
  if (_flowRemoveTypes) return _flowRemoveTypes
  try {
    _flowRemoveTypes = createRequire(import.meta.url)('flow-remove-types')
  } catch (cause) {
    throw new Error(
      "--flow needs the optional 'flow-remove-types' dependency; install it (e.g. `npm i flow-remove-types`)",
      { cause }
    )
  }
  return _flowRemoveTypes
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

  // `conditions` is additive on top of the edge-context base set. `resolve` optionally
  // replaces Node's resolver (resolve-fields.js): returns `{ url } | { empty } | { builtin } | null`
  // (`empty` = a browser/react-native `false` redirect) and owns builtin handling when set.
  // `jsx` opts the .js/.cjs/.mjs family into JSX syntax (React Native's JSX-in-.js convention);
  // off by default because oxc, like tsc, only auto-enables JSX for .jsx/.tsx by extension.
  // `flow`: strip Flow type syntax from JS-family sources before parsing (see #scanFile).
  constructor({ conditions = [], resolve = null, jsx = false, flow = false } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.jsx = jsx
    this.flow = flow
    // --jsx widens the script/resolvable extension sets to include .jsx/.tsx, so those files are
    // parsed (not left as opaque leaves) and queued when reached. Off by default the base sets apply.
    this.scriptExts = jsx ? new Set([...SCRIPT_EXTS, ...JSX_FILE_EXTS]) : SCRIPT_EXTS
    this.resolvableExts = jsx ? new Set([...RESOLVABLE_EXTS, ...JSX_FILE_EXTS]) : RESOLVABLE_EXTS
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

  // Must match the runtime resolver's condition set (omitting one resolves `exports`-gated
  // packages to a different file) AND its order: the recorded key must equal the runtime
  // hooks' string for exact lookups. Extras go where Node puts user conditions in each set.
  #conditionSet(context) {
    return context === 'import'
      ? new Set(['node', 'import', 'module-sync', 'node-addons', ...this.extraConditions])
      : new Set(['require', 'node', 'node-addons', ...this.extraConditions, 'module-sync'])
  }

  // `recovered`: false = parser crashed, nothing salvaged; true = oxc returned but we
  // discarded its partial module records (module-family only; see #scanFile).
  #recordParseError(url, format, message, recovered) {
    this.files.set(url, { format, edges: [], parseError: message })
    this.parseErrors.push({ url, format, message, recovered })
  }

  // Strip Flow type syntax to plain JS via the optional flow-remove-types dep (resolved lazily; a
  // missing dep is an env error and propagates). Only invoked as a parse fallback (see #scanFile),
  // so plain-JS files never reach it. Returns the rewritten source, or null when the transform
  // itself fails on this file -- the caller then keeps oxc's original parse error.
  #stripFlow(src, file) {
    const flowRemoveTypes = getFlowRemoveTypes()
    try {
      // `all: true` ignores the @flow/@noflow pragma (RN sources mix both); the transform blanks
      // types with whitespace, so byte offsets and every import specifier are preserved.
      return flowRemoveTypes(src, { all: true }).toString()
    } catch (cause) {
      console.warn(`[stasis] --flow: could not strip Flow types from ${file}; leaving it to oxc (${cause.message})`)
      return null
    }
  }

  #scanFile(url, queue) {
    const file = fileURLToPath(url)
    const ext = extname(file)
    if (ext === '.json') {
      this.files.set(url, { format: 'json', edges: [] })
      return
    }
    if (!this.scriptExts.has(ext)) {
      this.files.set(url, { format: null, edges: [] })
      return
    }

    // declared === null: typeless package; Node decides .js/.ts by syntax, resolved after parse.
    const declared = formatForFile(file)
    const src = readFileSync(file, 'utf8')

    // Resolve the parser outside the try: a missing oxc-parser is an env error, not this
    // file's — it must not be swallowed into a silent zero-edge leaf.
    const parser = getParser()
    // oxc picks JS/TS + JSX from the filename; the .js family lands on plain JS (no JSX), so
    // force the JSX variant when opted in (`--jsx`) to parse React Native's JSX-in-.js source.
    const lang = this.jsx && JSX_EXTS.has(ext) ? 'jsx' : undefined
    const parseOptions = (sourceType) => (lang ? { sourceType, lang } : { sourceType })
    const baseSourceType = declared === null ? 'unambiguous'
      : declared.startsWith('module') ? 'module' : 'script'
    let parsed
    try {
      parsed = parser.parseSync(file, src, parseOptions(baseSourceType))
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
        const asModule = parser.parseSync(file, src, parseOptions('module'))
        if (nonWarning(asModule).length === 0) {
          parsed = asModule
          format = `module${ext === '.ts' ? '-typescript' : ''}`
          errors = []
        }
      } catch { /* keep the script parse and its recorded errors */ }
    }

    // --flow: oxc parses JS/TS but not Flow, so a Flow-typed .js/.cjs/.mjs file lands here with
    // parse errors. Only now -- after a raw oxc parse actually failed -- strip Flow types and
    // re-parse, so plain-JS files never pay the transform cost. Only the parse input is rewritten;
    // the bundle stores the pristine on-disk source (State/buildResolvedJsBundle re-read it), so
    // attestation still covers the real bytes. A clean re-parse replaces the errored one; otherwise
    // we keep the original result so a genuine (non-Flow) parse error still surfaces.
    if (errors.length > 0 && this.flow && FLOW_EXTS.has(ext)) {
      const flowSrc = this.#stripFlow(src, file)
      if (flowSrc !== null) {
        try {
          const asFlow = parser.parseSync(file, flowSrc, parseOptions(baseSourceType))
          if (nonWarning(asFlow).length === 0) {
            parsed = asFlow
            format = declared ?? `${parsed.module.hasModuleSyntax ? 'module' : 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
            errors = []
          }
        } catch { /* keep the original parse + its errors */ }
      }
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

    // The edge KIND picks the resolution context, not the parent's format: createRequire()d
    // require() inside ESM resolves under REQUIRE conditions, literal import() inside CJS under
    // IMPORT conditions -- the parent-format set baked the wrong `exports` branch into the bundle.
    // The custom (legacy-field) resolver keeps the format set: bundlers don't split per edge.
    const formatContext = ['module', 'module-typescript'].includes(format) ? 'import' : 'require'
    const req = createRequire(file)
    const edges = []
    const specMaps = new Map() // condition key -> specifier -> child URL
    const record = (key, spec, childURL) => {
      if (!specMaps.has(key)) specMaps.set(key, new Map())
      specMaps.get(key).set(spec, childURL)
    }

    for (const s of specs) {
      if (s.dynamic) {
        edges.push(s)
        this.unresolved.push({ parentURL: url, kind: s.kind, reason: 'dynamic' })
        continue
      }
      const context = this.customResolve ? formatContext : (s.kind === 'require' ? 'require' : 'import')
      const conditions = this.#conditionSet(context)
      const key = condKey(conditions)
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
          record(key, s.spec, r.url)
          if (this.resolvableExts.has(extname(fileURLToPath(r.url)))) queue.push(r.url)
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
        record(key, s.spec, childURL)
        const childExt = extname(childPath)
        if (this.resolvableExts.has(childExt)) queue.push(childURL)
      } catch (cause) {
        edges.push({ ...s, error: cause.code ?? cause.message })
        this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason: cause.code ?? cause.message })
      }
    }

    for (const [key, specMap] of specMaps) {
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
