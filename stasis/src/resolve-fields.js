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

// Metro divergence toggle. When a package's browser map maps its OWN entry to `false` (under
// Metro's matching rules, which include bare keys like {"buf": false} for main "./buf.js"),
// Metro's `getPackageEntryPoint` ignores the non-string replacement and keeps `main`. The
// `--metro` resolver matches that by default; flip this to `false` to fail closed instead:
// a `false` match on the entry then yields an EMPTY module. Note the off state is deliberately
// stricter than both tools -- for a bare-key `false`, Metro keeps `main` and esbuild would not
// match the entry at all -- it exists as an escape hatch, not an esbuild-parity mode. This only
// affects the `--metro` path; the `--mainFields` path always empties (matching esbuild).
// Tests can override per-resolver via createFieldResolver's `metroKeepEntryOnBrowserFalse`.
const METRO_KEEP_ENTRY_ON_BROWSER_FALSE = true

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

// Metro's entry-variant list for `main` (getPackageEntryPoint, metro-resolver
// PackageResolve.js): the main spelling and its ./-toggled twin, each expanded to
// [self, +'.js', +'.json', ext-stripped]. ORDER MATTERS -- the first variant with ANY mapping
// (string or false) decides, so this must reproduce Metro's list exactly, duplicates included.
function metroEntryVariants(main) {
  const toggled = main.startsWith('./') ? main.slice(2) : `./${main}`
  return [main, toggled].flatMap((v) => [v, `${v}.js`, `${v}.json`, v.replace(/\.(?:js|json)$/u, '')])
}

// Resolve the package ENTRY (from mainFields) through the package's own redirect map.
// Returns { entry } (the redirected or original entry to resolve) or { empty: true }.
// Both halves of the entry semantics -- WHICH keys match, and what `false` means -- live here
// so no caller can get one without the other:
// - metro: Metro's getPackageEntryPoint. First matching variant (Metro's order) wins; a string
//   redirects; `false` (any non-string) keeps `main`, unless the keep-on-false toggle is off,
//   in which case it fails closed to an empty module (see METRO_KEEP_ENTRY_ON_BROWSER_FALSE).
// - default (--mainFields): esbuild-shaped candidates; `false` empties the entry, matching
//   esbuild. The extension-STRIPPED bare spelling is not probed: for an extensioned main,
//   esbuild treats it as a bare module name, not the entry. (For an extensionless main the
//   `bare` candidate covers it -- esbuild does match that spelling; verified empirically.)
function resolveEntryThroughMap(map, main, opts) {
  if (map.size === 0) return { entry: main }
  let cands
  if (opts.metro) {
    cands = metroEntryVariants(main)
  } else {
    const bare = main.replace(/^\.\//u, '')
    const stripped = bare.replace(/\.(?:js|json)$/u, '')
    cands = [
      `./${bare}`, bare,
      `./${stripped}`,
      `./${stripped}.js`, `${stripped}.js`,
      `./${stripped}.json`, `${stripped}.json`,
    ]
  }
  for (const cand of cands) {
    const v = map.get(cand)
    if (typeof v === 'string') return { entry: v }
    if (v === false) {
      if (opts.metro && opts.metroKeepEntryOnBrowserFalse) return { entry: main }
      return { empty: true }
    }
  }
  return { entry: main }
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
// `base.<platform>.<ext>`, `base.native.<ext>` (native only), `base.<ext>`. `platform: null`
// disables suffixes. Under metro, every SUFFIXED candidate first passes through the candidate's
// own package redirect map -- mirroring Metro's resolveSourceFileForExt, which runs
// redirectModulePath on each non-bare candidate: `false` short-circuits the whole probe to an
// empty module (e.g. browser { "./index.ios.js": false }), and a string redirect re-lands the
// candidate package-root-relative. Returns a path, { empty: true } (metro only), or null.
function resolveSourceFile(base, opts) {
  // Candidates share base's directory, hence its package scope; resolve it lazily, once.
  let scope
  const redirectCandidate = (p) => {
    if (scope === undefined) {
      const pkg = nearestPackage(base)
      scope = pkg ? { pkgDir: pkg.pkgDir, map: mergeRedirectMap(pkg.pkg, opts.mainFields) } : null
    }
    if (!scope || scope.map.size === 0) return p
    const rel = `./${relative(scope.pkgDir, p).split(/[\\/]/u).join('/')}`
    const r = matchRedirect(scope.map, rel)
    if (r === false) return false
    if (typeof r === 'string') return isAbsolute(r) ? r : resolvePath(scope.pkgDir, r)
    return p
  }
  // `suffix` is everything appended to `base`; Metro redirect-checks suffixed candidates only.
  const probe = (suffix) => {
    let p = `${base}${suffix}`
    if (opts.metro && suffix !== '') {
      const r = redirectCandidate(p)
      if (r === false) return { empty: true }
      p = r
    }
    return isFile(p) ? p : null
  }
  const tryExt = (sourceExt) => {
    if (opts.platform) {
      const hit = probe(`.${opts.platform}${sourceExt}`)
      if (hit) return hit
    }
    if (opts.preferNative && sourceExt !== '') {
      const hit = probe(`.native${sourceExt}`)
      if (hit) return hit
    }
    return probe(sourceExt)
  }
  const bare = tryExt('')
  if (bare) return bare
  for (const ext of opts.sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  return null
}

// Resolve absolute `base` as a file (ext probing) else as a directory (package.json `main` via
// mainFields + entry redirect, else `index`). `exports` is NOT consulted — Node applies it only to
// bare package-name imports, not to a path landing on a directory.
function resolveFileOrDir(base, opts) {
  // resolveSourceFile yields a path, { empty: true } (a metro candidate-redirect hit), or null.
  const asResolution = (hit) => (hit == null ? null : typeof hit === 'string' ? { url: pathToFileURL(hit).toString() } : hit)
  const file = asResolution(resolveSourceFile(base, opts))
  if (file) return file
  if (isDir(base)) {
    const dpkg = readJson(join(base, 'package.json'))
    if (dpkg) {
      const r = resolveEntryThroughMap(mergeRedirectMap(dpkg, opts.mainFields), packageEntry(dpkg, opts.mainFields), opts)
      if (r.empty) return { empty: true }
      // Node's LOAD_AS_DIRECTORY resolves `main` as a file, else as a directory index
      // (`main: "./lib/"` -> lib/index.js); a broken `main` falls back to the package index below.
      const entryBase = join(base, r.entry)
      const inner = asResolution(resolveSourceFile(entryBase, opts) ?? resolveSourceFile(join(entryBase, 'index'), opts))
      if (inner) return inner
    }
    const index = asResolution(resolveSourceFile(join(base, 'index'), opts))
    if (index) return index
  }
  return null
}

// Build a resolver bound to options: `conditions` gates `exports` packages (delegated to Node),
// `mainFields`/`platform`/`preferNative`/`sourceExts` drive the legacy-field + suffix probing.
// `metro` opts into Metro's package-entry + candidate-redirect semantics (see
// resolveEntryThroughMap and resolveSourceFile); leave it off for the esbuild-parity
// `--mainFields` path. `metroKeepEntryOnBrowserFalse` overrides the module-level toggle
// (METRO_KEEP_ENTRY_ON_BROWSER_FALSE) per resolver -- primarily so tests can cover both branches.
export function createFieldResolver({
  conditions = [],
  mainFields = ['main'],
  platform = null,
  preferNative = false,
  sourceExts = ['js', 'json', 'ts'],
  metro = false,
  metroKeepEntryOnBrowserFalse = METRO_KEEP_ENTRY_ON_BROWSER_FALSE,
} = {}) {
  const opts = { platform, preferNative, sourceExts, mainFields, metro, metroKeepEntryOnBrowserFalse }
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
