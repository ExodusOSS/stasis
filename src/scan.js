import { readFileSync, existsSync } from 'node:fs'
import { extname, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin, findPackageJSON } from 'node:module'
import assert from 'node:assert/strict'

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
// The parser (oxc-parser) is loaded lazily as an optional peer dependency.

const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs'])
const RESOLVABLE_EXTS = new Set([...SCRIPT_EXTS, '.json'])

let _parser
function getParser() {
  if (_parser) return _parser
  const req = createRequire(import.meta.url)
  try {
    _parser = req('oxc-parser')
  } catch (cause) {
    throw new Error(
      'stasis scan requires the oxc-parser peer dependency. Install it: `pnpm add oxc-parser` (or `npm i oxc-parser`).',
      { cause }
    )
  }
  return _parser
}

// Raw "type" of the file's nearest package.json scope: 'module', 'commonjs',
// or undefined when there is no package.json or it has no "type" field -- the
// ambiguous case where Node applies module-syntax detection to .js files. A
// malformed package.json is treated as an explicit 'commonjs' (no detection).
function packageType(file) {
  const pkg = findPackageJSON(pathToFileURL(file).toString())
  if (!pkg) return undefined
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).type
  } catch {
    return 'commonjs'
  }
}

function formatForFile(file) {
  const ext = extname(file)
  if (ext === '.mjs') return { format: 'module' }
  if (ext === '.cjs') return { format: 'commonjs' }
  if (ext === '.json') return { format: 'json' }
  if (ext === '.js') {
    const type = packageType(file)
    // type undefined = ambiguous scope: plain node runs the file as ESM if it
    // contains module syntax (detect-module); the caller re-checks after parse.
    return { format: type === 'module' ? 'module' : 'commonjs', detectModule: type === undefined }
  }
  return { format: null }
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
  constructor({ conditions = [] } = {}) {
    this.extraConditions = [...conditions]
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
    const base = format === 'module'
      ? ['node', 'import', 'module-sync', 'node-addons']
      : ['node', 'require', 'module-sync', 'node-addons']
    return new Set([...base, ...this.extraConditions])
  }

  // `recovered: false` means the parser crashed on this file and nothing was
  // salvaged -- its edges are entirely unknown. `recovered: true` means oxc
  // returned, but we discarded its partial module records (module-format
  // files only; see #scanFile).
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

    let { format, detectModule = false } = formatForFile(file)
    let isESM = format === 'module'
    const src = readFileSync(file, 'utf8')

    // Resolve the parser OUTSIDE the per-file try: a missing oxc-parser peer
    // is an environment error, not a property of this file. Swallowing it
    // here turned every file into a silent zero-edge leaf -- the original
    // "bundles just the entry, exit 0" failure -- instead of surfacing the
    // actionable install hint from getParser().
    const parser = getParser()
    let parsed
    try {
      parsed = parser.parseSync(file, src, { sourceType: isESM ? 'module' : 'script' })
      // Node's detect-module: an ambiguous .js (no "type" in the nearest
      // package.json scope) that contains module syntax runs as ESM in plain
      // node. oxc accepts module syntax in script mode and flags it via
      // hasModuleSyntax (true for import/export/import.meta, false for
      // dynamic import() -- matching Node's detector), so re-parse as a
      // module to make the recorded format, strictness, and resolution
      // conditions all match what plain node would do.
      if (detectModule && !isESM && parsed.module?.hasModuleSyntax) {
        format = 'module'
        isESM = true
        parsed = parser.parseSync(file, src, { sourceType: 'module' })
      }
    } catch (cause) {
      this.#recordParseError(url, format, cause.message, false)
      return
    }

    // oxc-parser recovers from syntax errors instead of throwing: it reports
    // them in `parsed.errors` and returns whatever AST/module records it could
    // salvage. (Warning/advice-severity diagnostics don't imply a broken parse
    // and are not errors.)
    let parseError
    const errors = (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')
    if (errors.length > 0) {
      parseError = errors.map((e) => e.message).join('; ')
      // A partially-parsed module file may be missing static link-time edges
      // -- holes we can't enumerate -- so don't pretend we know its imports.
      if (isESM) {
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
    if (parsed.module?.staticImports) {
      for (const imp of parsed.module.staticImports) {
        specs.push({ kind: 'import', spec: imp.moduleRequest.value })
      }
    }
    if (parsed.module?.staticExports) {
      for (const exp of parsed.module.staticExports) {
        for (const entry of exp.entries) {
          if (entry.moduleRequest) specs.push({ kind: 'export-from', spec: entry.moduleRequest.value })
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
