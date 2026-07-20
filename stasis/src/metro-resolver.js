import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Adapter that drives the PROJECT's own `metro-resolver` from stasis's static scanner, so
// `stasis bundle --metro --metro-resolver` resolves modules EXACTLY the way that project's
// installed Metro does -- rather than the hand-rolled Metro/RN approximation in
// resolve-fields.js. `metro-resolver` is a leaf of the Metro toolchain (it takes a context of
// filesystem callbacks and does no I/O of its own), so we load whichever copy the project
// already ships and feed it a synchronous, disk-backed ResolutionContext.
//
// Returns, for each specifier, the same shape scan.js expects from a custom resolver:
//   { url }      resolved to a real file (file: URL string)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin (Metro itself has none; we classify a bare-name miss)
//   null         unresolved
//
// It is deliberately version-agnostic: it never imports metro-resolver internals (the
// `./private/*` subpath), only the public `resolve`. `resolve` applies the browser-field
// redirect via its own bundled helper, so the `redirectModulePath` we place on the context is
// an inert placeholder that satisfies the type but is never consulted for base resolution.

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null // absent / unreadable -- no package manifest here
  }
  // A manifest that EXISTS but is malformed must fail closed (Metro would throw, not resolve past it).
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
}

// 'f' | 'd' | null for a path, without throwing.
function pathType(p) {
  try {
    const s = statSync(p)
    return s.isFile() ? 'f' : s.isDirectory() ? 'd' : null
  } catch {
    return null
  }
}

// Metro's `getPackageForModule`: the closest package scope for an absolute candidate path
// (which need not exist). The candidate can be a package DIRECTORY (a bare import lands on
// `<node_modules>/<pkg>`), so probing starts at the path itself, then walks up. `packageRelativePath`
// is '' when the candidate IS the package root -- Metro's exports resolver maps '' to the '.' subpath,
// and a stray '.' there would mismatch the exports key.
function getPackageForModule(absModulePath) {
  let dir = pathType(absModulePath) === 'd' ? absModulePath : dirname(absModulePath)
  while (true) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg) {
      const rel = dir === absModulePath ? '' : absModulePath.slice(dir.length + 1)
      return { rootPath: dir, packageJson: pkg, packageRelativePath: rel }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Build a resolver bound to a platform. `metro-resolver` is required from `projectDir` so we
// honour the version the project's Metro uses; a missing package throws with actionable guidance.
// `sourceExts` are the extensions Metro probes (kept to what a source bundle can carry, so the
// resolver never lands on a file the bundle would reject). `mainFields` drives the browser-field
// spec; `conditionNames` are the extra `exports`/`imports` conditions on top of the ones Metro
// derives itself (default + require|import + platform).
export function createMetroResolver({
  projectDir,
  platform,
  sourceExts = ['js', 'json', 'ts'],
  mainFields = ['react-native', 'browser', 'main'],
  conditionNames = ['react-native'],
  conditionsByPlatform = { web: ['browser'] },
  enablePackageExports = true,
} = {}) {
  const require = createRequire(join(projectDir, 'noop.js'))
  let resolve
  try {
    ;({ resolve } = require('metro-resolver'))
  } catch (cause) {
    throw new Error(
      `StasisMetroResolver: couldn't load 'metro-resolver' from ${projectDir}. --metro-resolver ` +
      'resolves through the project\'s own Metro; install it (it ships with react-native/metro) ' +
      'or drop --metro-resolver to use the built-in resolver.',
      { cause }
    )
  }

  // A React Native app has no Node builtins by default; Metro only prefers native suffixes off web.
  const base = {
    allowHaste: false,
    assetExts: new Set(),
    customResolverOptions: {},
    disableHierarchicalLookup: false,
    doesFileExist: (p) => pathType(p) === 'f',
    extraNodeModules: null,
    dev: false,
    getPackage: (packageJsonPath) => readJson(packageJsonPath),
    getPackageForModule,
    fileSystemLookup: (p) => {
      const abs = isAbsolute(p) ? p : join(projectDir, p)
      const type = pathType(abs)
      if (!type) return { exists: false }
      let realPath = abs
      try {
        realPath = realpathSync(abs)
      } catch { /* keep the lexical path when realpath fails (e.g. a broken symlink) */ }
      return { exists: true, type, realPath }
    },
    mainFields,
    nodeModulesPaths: [],
    preferNativePlatform: platform !== 'web',
    resolveAsset: (dirPath, assetName, ext) => {
      const f = join(dirPath, `${assetName}${ext}`)
      return pathType(f) === 'f' ? [f] : null
    },
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    // Inert placeholder: `resolve` redirects via its own bundled helper, never this (see header).
    redirectModulePath: (modulePath) => modulePath,
    sourceExts,
    unstable_conditionNames: conditionNames,
    unstable_conditionsByPlatform: conditionsByPlatform,
    unstable_enablePackageExports: enablePackageExports,
    unstable_incrementalResolution: false,
    unstable_logWarning: () => {}, // a static build must not spam on exports fallbacks
  }

  return function resolveOne(parentFile, specifier, callConditions) {
    // Metro splits `exports` on whether the edge was an ESM import vs a CJS require. scan.js hands
    // us the parent's format-derived condition set, so 'import' membership is that signal.
    const isESMImport = callConditions instanceof Set ? callConditions.has('import') : false
    const context = { ...base, originModulePath: parentFile, isESMImport }
    let res
    try {
      res = resolve(context, specifier, platform)
    } catch {
      // Metro carries no Node builtins: an unmapped builtin fails to resolve here. The browser-field
      // remap of a builtin (`{"crypto": false}` / a shim) is handled inside resolve() before this.
      if (isBuiltin(specifier)) return { builtin: true }
      return null
    }
    if (!res) return null
    if (res.type === 'empty') return { empty: true }
    if (res.type === 'sourceFile') return { url: pathToFileURL(res.filePath).toString() }
    // Assets are off (assetExts empty) for a code bundle, but map defensively to the first variant.
    if (res.type === 'assetFiles' && res.filePaths?.length) return { url: pathToFileURL(res.filePaths[0]).toString() }
    return null
  }
}
