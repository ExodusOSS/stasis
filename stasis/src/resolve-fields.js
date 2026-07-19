import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

// Static module resolver for legacy package fields (`react-native`/`browser`/`main` + browser-spec
// redirect maps) and platform suffixes (`.ios`/`.android`/`.native`), reproducing Metro/React-Native
// resolution that Node's own resolver (used by scan.js) can't. `exports`-bearing packages are
// delegated to Node. No user code is executed (only package.json is stat/read).
//
// Returns, for each specifier:
//   { url }      resolved to a real file (file: URL string)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin
//   null         unresolved

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null // absent / unreadable -- no package manifest here
  }
  // A manifest that EXISTS but is malformed must fail closed (Node throws rather than resolving past it).
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

// Nearest node_modules/<pkg> up from `fromDir` (handles @scope/name). Returns { pkgDir, subpath }
// (subpath '' = bare package import), or null if not installed up the tree.
function locatePackage(fromDir, spec) {
  const parts = spec.split('/')
  const pkgLen = spec.startsWith('@') ? 2 : 1
  if (parts.length < pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const pkgName = parts.slice(0, pkgLen).join('/')
  const subpath = parts.slice(pkgLen).join('/')
  let dir = fromDir
  while (true) {
    // Skip a dir literally named node_modules (basename, not endsWith — `my-node_modules` must not match).
    if (basename(dir) !== 'node_modules') {
      const pkgDir = join(dir, 'node_modules', pkgName)
      if (isDir(pkgDir)) return { pkgDir, subpath }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Nearest package.json at/above `file`'s dir — the package whose browser/RN map governs its imports.
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

// First mainFields entry that's a non-empty string, else `index` (object-valued fields are redirect maps).
function packageEntry(pkg, mainFields) {
  for (const name of mainFields) {
    if (typeof pkg?.[name] === 'string' && pkg[name].length > 0) return pkg[name]
  }
  return 'index'
}

// Merge object-valued mainFields (browser-spec maps) into one redirect map. Iterate in REVERSE
// so earlier mainFields win on conflict. Keys are verbatim: `./x` relative vs bare `x` (kept bare).
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

// Match the package ENTRY against the browser map (string redirects, `false` = empty module).
// Probe with/without leading `./` and with ext stripped or `.js`/`.json` appended — but NOT the
// bare extension-less form: that spelling is a BARE MODULE name, not the entry file.
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

// Match a package-relative path (`./x`) against the redirect map, trying `.js`/`.json` appended.
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

// Probe `base` for a source file in platform order: bare name first, then per ext
// `base.<platform>.<ext>`, `base.native.<ext>` (native only), `base.<ext>`. `platform: null` disables suffixes.
function resolveSourceFile(base, { platform, preferNative, sourceExts }) {
  const tryExt = (sourceExt) => {
    if (platform) {
      const p = `${base}.${platform}${sourceExt}`
      if (isFile(p)) return p
    }
    if (preferNative && sourceExt !== '') {
      const n = `${base}.native${sourceExt}`
      if (isFile(n)) return n
    }
    const b = `${base}${sourceExt}`
    return isFile(b) ? b : null
  }
  const bare = tryExt('')
  if (bare) return bare
  for (const ext of sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  return null
}

// Resolve absolute `base` as a file (ext probing) else as a directory (package.json `main` via
// mainFields + entry redirect, else `index`). `exports` is NOT consulted — Node applies it only to
// bare package-name imports, not to a path landing on a directory.
function resolveFileOrDir(base, opts) {
  const file = resolveSourceFile(base, opts)
  if (file) return { url: pathToFileURL(file).toString() }
  if (isDir(base)) {
    const dpkg = readJson(join(base, 'package.json'))
    if (dpkg) {
      let entry = packageEntry(dpkg, opts.mainFields)
      const redirect = entryRedirect(mergeRedirectMap(dpkg, opts.mainFields), entry)
      if (redirect === false) return { empty: true }
      if (typeof redirect === 'string') entry = redirect
      // Node's LOAD_AS_DIRECTORY resolves `main` as a file, else as a directory index
      // (`main: "./lib/"` -> lib/index.js); a broken `main` falls back to the package index below.
      const entryBase = join(base, entry)
      const inner = resolveSourceFile(entryBase, opts) ?? resolveSourceFile(join(entryBase, 'index'), opts)
      if (inner) return { url: pathToFileURL(inner).toString() }
    }
    const index = resolveSourceFile(join(base, 'index'), opts)
    if (index) return { url: pathToFileURL(index).toString() }
  }
  return null
}

// Build a resolver bound to options: `conditions` gates `exports` packages (delegated to Node),
// `mainFields`/`platform`/`preferNative`/`sourceExts` drive the legacy-field + suffix probing.
export function createFieldResolver({
  conditions = [],
  mainFields = ['main'],
  platform = null,
  preferNative = false,
  sourceExts = ['js', 'json', 'ts'],
} = {}) {
  const opts = { platform, preferNative, sourceExts, mainFields }
  // `callConditions` (from scan) is the parent's format-driven condition set, so `exports`
  // delegation matches Node resolving from THAT file; falls back to configured `conditions`.
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
    // Redirect via the IMPORTER's browser/react-native map, BEFORE the builtin check on purpose:
    // a map entry can disable or shim a builtin (`{"crypto": false}` / `"crypto-browserify"`).
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
        // Browser-map targets are relative to the PACKAGE ROOT, not the importing file; a
        // bare-module target re-enters resolution below.
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
    // A bare package import resolves its directory via the same dir algorithm as any other.
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

// Condition set for a parent of the given format: Node's format-driven base (matching scan's
// #conditionsFor) plus extras. Order is irrelevant (Node membership-tests against exports key order).
export function resolveConditions(format, extras = []) {
  const base = isModuleFormat(format)
    ? ['node', 'import', 'module-sync', 'node-addons']
    : ['node', 'require', 'module-sync', 'node-addons']
  return [...new Set([...base, ...extras])]
}
