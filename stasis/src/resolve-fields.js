import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

// Static module resolver for legacy package fields. `scan` (src/scan.js) resolves
// through Node's own resolver, which only understands `main` + `exports`/conditions.
// Older packages (and the React Native ecosystem) also rely on legacy `mainFields`
// that Node has no equivalent for, and this module reproduces them so a static
// `stasis bundle --mainFields` picks the same files those tools would:
//
//   * Legacy package `mainFields` (`react-native`/`browser`/`main`): the entry field
//     consulted in order (first non-empty string wins; default `index`), PLUS the
//     browser-field-spec object form -- a `{ "./a.js": "./b.js", "mod": false }` map
//     that redirects specific subpaths/bare modules to another file or to an empty
//     module (`false`). See https://github.com/defunctzombie/package-browser-field-spec.
//
// `exports` still wins over `mainFields` when a package declares it, and Node resolves
// `exports`/conditions correctly, so packages with an `exports` field are delegated to
// Node's resolver. Everything else is resolved here, against the real filesystem (no
// user code is executed -- this only stats/reads package.json and probes paths).
//
// Returns, for each specifier:
//   { url }      resolved to a real file (file: URL string)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin (`fs`, `node:path`, ...)
//   null         unresolved (caller records it like any other miss)

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null // absent / unreadable -- no package manifest here
  }
  // A manifest that EXISTS but is malformed must fail closed: Node throws
  // ERR_INVALID_PACKAGE_CONFIG rather than resolving past it, and a bundle that
  // resolved where real Node rejects would diverge silently.
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Walk up from `fromDir` to the nearest `node_modules/<pkg>` directory for the bare
// specifier `spec` (handling `@scope/name`). Returns { pkgDir, subpath } where subpath
// is '' for a bare package import or the in-package path otherwise, or null when the
// package isn't installed anywhere up the tree. Mirrors Node's node_modules walk.
function locatePackage(fromDir, spec) {
  const parts = spec.split('/')
  const pkgLen = spec.startsWith('@') ? 2 : 1
  if (parts.length < pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const pkgName = parts.slice(0, pkgLen).join('/')
  const subpath = parts.slice(pkgLen).join('/')
  let dir = fromDir
  while (true) {
    // Don't descend into a node_modules whose own last segment is node_modules
    // (basename, not endsWith -- a dir like `my-node_modules` must not be skipped).
    if (basename(dir) !== 'node_modules') {
      const pkgDir = join(dir, 'node_modules', pkgName)
      if (isDir(pkgDir)) return { pkgDir, subpath }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Nearest package.json at or above `file`'s directory. Returns { pkgDir, pkg } or null.
// This is the package whose `browser`/`react-native` map governs `file`'s own imports.
function nearestPackage(file) {
  let dir = dirname(file)
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath)
      if (pkg) return { pkgDir: dir, pkg }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// First `mainFields` entry that is a non-empty string, else `index`. (Object-valued
// fields are redirection maps, handled separately.)
function packageEntry(pkg, mainFields) {
  for (const name of mainFields) {
    if (typeof pkg?.[name] === 'string' && pkg[name].length > 0) return pkg[name]
  }
  return 'index'
}

// Merge the object-valued `mainFields` (browser-spec maps) into one redirection map.
// Iterate in REVERSE so earlier mainFields win on a key conflict (earlier fields take
// precedence). Keys are matched VERBATIM: a relative key is written `./x` (a `./`-less
// `x` is a BARE module name, not `./x`), and bare module keys -- including dotted ones
// like `socket.io` -- stay bare. Values are a string target or `false` (ignore ->
// empty module).
function mergeRedirectMap(pkg, mainFields) {
  const map = new Map()
  for (let i = mainFields.length - 1; i >= 0; i--) {
    const field = pkg?.[mainFields[i]]
    if (!field || typeof field !== 'object') continue
    for (const [key, value] of Object.entries(field)) {
      if (typeof value !== 'string' && value !== false) continue
      map.set(key, value)
    }
  }
  return map
}

// Match the package ENTRY against the browser map. A string target redirects the
// entry; `false` disables it (empty module), per the browser-field spec. `main` and
// the key may each be written with or without a leading `./`, so probe both spellings
// (plus the extension stripped / `.js`/`.json` appended). The bare, extension-LESS form
// is deliberately EXCLUDED: a `./`-less, extension-less key is a BARE MODULE name per
// the spec (e.g. remapping the `stream` module used inside the package), not the
// package's own entry file -- matching it here would wrongly hijack a same-basename
// entry (esbuild and browser-resolve don't).
function entryRedirect(map, entry) {
  if (map.size === 0) return undefined
  const bare = entry.replace(/^\.\//u, '')
  const stripped = bare.replace(/\.(?:js|json)$/u, '')
  const cands = [
    `./${bare}`, bare,
    `./${stripped}`,
    `./${stripped}.js`, `${stripped}.js`,
    `./${stripped}.json`, `${stripped}.json`,
  ]
  for (const cand of cands) {
    const v = map.get(cand)
    if (v === false || typeof v === 'string') return v
  }
  return undefined
}

// Match a package-relative path (`./x`) against the redirect map, trying the path as
// written and with `.js`/`.json` appended. Returns the mapped value (string | false)
// or undefined when nothing matches.
function matchRedirect(map, relPath) {
  if (map.size === 0) return undefined
  for (const cand of [relPath, `${relPath}.js`, `${relPath}.json`]) {
    if (map.has(cand)) return map.get(cand)
  }
  return undefined
}

// Match a bare specifier (`mod`, `mod/sub`) against the redirect map's bare keys.
function matchBareRedirect(map, spec) {
  return map.size === 0 ? undefined : map.get(spec)
}

// Probe `base` (an absolute path without a guaranteed extension) for a source file:
// the bare path first (handles imports that already include the extension), then
// `base.<ext>` for each source extension in order.
function resolveSourceFile(base, { sourceExts }) {
  if (isFile(base)) return base
  for (const ext of sourceExts) {
    const cand = `${base}.${ext}`
    if (isFile(cand)) return cand
  }
  return null
}

// Resolve an absolute `base` as a file (with extension probing) or, failing that, as a
// directory: its package.json `main` (via mainFields, with the browser-map entry
// redirect), else `index`. `exports` is deliberately NOT consulted here -- Node only
// applies it to BARE package-name imports, not to a relative/absolute path that lands
// on a directory, so `main`/`index` win exactly as Node's directory resolution does.
function resolveFileOrDir(base, opts) {
  const file = resolveSourceFile(base, opts)
  if (file) return { url: pathToFileURL(file).toString() }
  if (isDir(base)) {
    const dpkg = readJson(join(base, 'package.json'))
    if (dpkg) {
      let entry = packageEntry(dpkg, opts.mainFields)
      const redirect = entryRedirect(mergeRedirectMap(dpkg, opts.mainFields), entry)
      if (redirect === false) return { empty: true } // browser map disables the package entry
      if (typeof redirect === 'string') entry = redirect
      // Node's LOAD_AS_DIRECTORY resolves `main` as a file AND, failing that, as a
      // directory (its index) -- so `main: "./lib/"` resolves `lib/index.js`. A broken
      // `main` then falls back to the package's own index below.
      const entryBase = join(base, entry)
      const inner = resolveSourceFile(entryBase, opts) ?? resolveSourceFile(join(entryBase, 'index'), opts)
      if (inner) return { url: pathToFileURL(inner).toString() }
    }
    const index = resolveSourceFile(join(base, 'index'), opts)
    if (index) return { url: pathToFileURL(index).toString() }
  }
  return null
}

// Build a resolver bound to a set of options. `conditions` is the full condition set
// used for `exports`-bearing packages (delegated to Node); `mainFields` drives the
// legacy-field path; `sourceExts` are the extensions probed when an entry/redirect
// target names no extension.
export function createFieldResolver({
  conditions = [],
  mainFields = ['main'],
  sourceExts = ['js', 'json', 'ts'],
} = {}) {
  const opts = { sourceExts, mainFields }
  // `callConditions` (when scan passes it) is the parent file's format-driven
  // condition set (ESM -> import, CJS -> require, + the configured extras), so
  // `exports` delegation matches how Node would resolve from THAT file. Falls back to
  // the resolver's configured `conditions` when called without one.
  return function resolve(parentFile, specifier, callConditions) {
    const conds = new Set(callConditions ?? conditions)
    // `#name` subpath imports use the `imports` field + conditions; Node handles them.
    if (specifier.startsWith('#')) {
      try {
        const req = createRequire(parentFile)
        return { url: pathToFileURL(req.resolve(specifier, { conditions: conds })).toString() }
      } catch {
        return null
      }
    }

    let spec = specifier
    // Redirect the specifier via the IMPORTER's package browser/react-native map. This
    // runs BEFORE the builtin check on purpose: replacing Node-only modules is the
    // browser field's whole purpose, so a map entry can disable or shim a builtin
    // (`{"crypto": false}` / `{"crypto": "crypto-browserify"}`), per the browser-field
    // spec (the key is "the name of a module or file you wish to replace").
    const imp = nearestPackage(parentFile)
    if (imp) {
      const map = mergeRedirectMap(imp.pkg, mainFields)
      let r
      if (spec.startsWith('.') || isAbsolute(spec)) {
        const abs = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
        r = matchRedirect(map, `./${relative(imp.pkgDir, abs).split(/[\\/]/u).join('/')}`)
      } else {
        r = matchBareRedirect(map, spec)
      }
      if (r === false) return { empty: true }
      if (typeof r === 'string') {
        // Browser-map targets are relative to the PACKAGE ROOT (not the importing
        // file), per the browser-field spec. A relative or absolute target resolves
        // there directly; a bare-module target re-enters resolution below (and may
        // itself be a builtin, e.g. remapping one builtin onto another).
        if (r.startsWith('.') || isAbsolute(r)) {
          return resolveFileOrDir(isAbsolute(r) ? r : resolvePath(imp.pkgDir, r), opts)
        }
        spec = r
      }
    }

    // A builtin the browser map did not remap resolves to the builtin itself.
    if (isBuiltin(spec)) return { builtin: true }

    if (spec.startsWith('.') || isAbsolute(spec)) {
      const base = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
      return resolveFileOrDir(base, opts)
    }

    // Bare specifier.
    const loc = locatePackage(dirname(parentFile), spec)
    if (!loc) return null
    const pkg = readJson(join(loc.pkgDir, 'package.json')) ?? {}
    // `exports` wins over mainFields; Node resolves it (with conditions) correctly.
    if (pkg.exports != null) {
      try {
        const req = createRequire(parentFile)
        return { url: pathToFileURL(req.resolve(spec, { conditions: conds })).toString() }
      } catch {
        return null
      }
    }
    // A bare package import resolves the package directory through the SAME directory
    // algorithm as any other dir (main -> file/index, entry redirect, index fallback).
    if (loc.subpath === '') return resolveFileOrDir(loc.pkgDir, opts)
    const sub = `./${loc.subpath}`
    const r = matchRedirect(mergeRedirectMap(pkg, mainFields), sub)
    if (r === false) return { empty: true }
    const target = typeof r === 'string' ? r : sub
    return resolveFileOrDir(join(loc.pkgDir, target), opts)
  }
}

// True when `format` is an ESM family (drives the base condition set, mirroring scan).
function isModuleFormat(format) {
  return format === 'module' || format === 'module-typescript'
}

// The condition set a field-based resolution asserts for a parent of the given format:
// Node's format-driven base (matching scan's #conditionsFor) plus the supplied extras
// (e.g. `react-native`, `browser`). Returned as an array (order is irrelevant -- Node
// membership-tests it against the package's own `exports` key order).
export function resolveConditions(format, extras = []) {
  const base = isModuleFormat(format)
    ? ['node', 'import', 'module-sync', 'node-addons']
    : ['node', 'require', 'module-sync', 'node-addons']
  return [...new Set([...base, ...extras])]
}
