import Module, { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Node's CommonJS resolution algorithm (`Module._resolveFilename` with a `conditions` set, i.e.
// what `createRequire(parent).resolve(spec, { conditions })` computes) reimplemented over a
// `host` (see host.js) instead of the real filesystem, so the static bundler can resolve
// through an in-memory node_modules. It mirrors lib/internal/modules/cjs/loader.js and
// esm/resolve.js step for step: lookup paths, extension probing (Module._extensions), directory
// `main`/index, package `exports`/`imports` with conditions and patterns, self-reference, and the
// realpath of every hit. Global folders (NODE_PATH, ~/.node_modules) are deliberately not
// consulted: a virtual tree must resolve hermetically. Errors carry Node's `code`s
// (MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED, ERR_PACKAGE_IMPORT_NOT_DEFINED,
// ERR_INVALID_PACKAGE_TARGET, ERR_INVALID_PACKAGE_CONFIG, ERR_INVALID_MODULE_SPECIFIER).

const codedError = (code, message) => Object.assign(new Error(message), { code })

// esm/resolve.js's deprecatedInvalidSegmentRegEx: a `.`, `..` or `node_modules` segment
// (percent-encoded spellings included) is invalid in a target/subpath. (Node's wider
// invalidSegmentRegEx also matches an EMPTY segment, which it merely deprecates, so that case is
// not an error here either.)
const deprecatedInvalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/iu
const encodedSepRegEx = /%2F|%5C/iu
// Module._findPath's bare-package matcher: `name` or `@scope/name`, optional `/subpath`.
const EXPORTS_PATTERN = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/u
// cjs/loader.js's character tests as regexes. `.`, `..`, `./x`, `../x` are relative requests; a
// request ending in `/`, or being/ending in a `.` or `..` segment, asks for a directory (no file
// probes); and only `.`, `./…` and `..…` (`..x` included, `.x` not) skip the node_modules lookup.
const RELATIVE_REQUEST = /^\.\.?(?:\/|$)/u
const TRAILING_SLASH = /\/$|(?:^|\/)\.\.?$/u
const RELATIVE_LOOKUP = /^\.(?:$|[./])/u

const isArrayIndex = (key) => {
  const n = Number(key)
  return `${n}` === key && n >= 0 && n < 0xFF_FF_FF_FF
}

function patternKeyCompare(a, b) {
  const aIdx = a.indexOf('*')
  const bIdx = b.indexOf('*')
  const baseLenA = aIdx === -1 ? a.length : aIdx + 1
  const baseLenB = bIdx === -1 ? b.length : bIdx + 1
  if (baseLenA > baseLenB) return -1
  if (baseLenB > baseLenA) return 1
  if (aIdx === -1) return 1
  if (bIdx === -1) return -1
  if (a.length > b.length) return -1
  if (b.length > a.length) return 1
  return 0
}

function isConditionalExportsMainSugar(exports, pkgPath) {
  if (typeof exports === 'string' || Array.isArray(exports)) return true
  if (typeof exports !== 'object' || exports === null) return false
  const keys = Object.keys(exports)
  const isSugar = (key) => key === '' || key[0] !== '.'
  const sugar = keys.length > 0 && isSugar(keys[0])
  if (keys.some((key) => isSugar(key) !== sugar)) {
    throw codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pkgPath}. "exports" cannot contain some keys starting with '.' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.`)
  }
  return sugar
}

// The best `*` pattern key of `map` (an exports/imports object) for `subpath` -- the loop
// packageExportsResolve and packageImportsResolve share in esm/resolve.js: -> [key, wildcard] or null.
function bestPatternMatch(map, subpath) {
  let bestMatch = ''
  let bestMatchSubpath
  for (const key of Object.keys(map)) {
    const patternIndex = key.indexOf('*')
    if (patternIndex === -1 || !subpath.startsWith(key.slice(0, patternIndex))) continue
    const patternTrailer = key.slice(patternIndex + 1)
    if (subpath.length >= key.length && subpath.endsWith(patternTrailer) && patternKeyCompare(bestMatch, key) === 1 && key.lastIndexOf('*') === patternIndex) {
      bestMatch = key
      bestMatchSubpath = subpath.slice(patternIndex, subpath.length - patternTrailer.length)
    }
  }
  return bestMatch ? [bestMatch, bestMatchSubpath] : null
}

// esm/resolve.js's parsePackageName: -> { packageName, packageSubpath, isScoped }.
function parsePackageName(specifier, base) {
  let separatorIndex = specifier.indexOf('/')
  const isScoped = specifier[0] === '@'
  let valid = true
  if (isScoped) {
    if (separatorIndex === -1) valid = false
    else separatorIndex = specifier.indexOf('/', separatorIndex + 1)
  }
  const packageName = separatorIndex === -1 ? specifier : specifier.slice(0, separatorIndex)
  if (!valid || /^\.|%|\\/u.test(packageName)) {
    throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${specifier}" is not a valid package name imported from ${fileURLToPath(base)}`)
  }
  return { packageName, packageSubpath: `.${separatorIndex === -1 ? '' : specifier.slice(separatorIndex)}`, isScoped }
}

// Module._nodeModulePaths(from): every ancestor's node_modules, skipping node_modules dirs themselves.
function nodeModulePaths(from) {
  if (from === '/') return ['/node_modules']
  const parts = from.split('/')
  const paths = []
  for (let i = parts.length; i > 0; i--) {
    if (parts[i - 1] !== 'node_modules') paths.push(`${parts.slice(0, i).join('/')}/node_modules`)
  }
  return paths
}

export function createNodeResolver(host) {
  // package.json reads, memoized per path: { exists, path, name, main, exports, imports }; a
  // malformed manifest throws ERR_INVALID_PACKAGE_CONFIG like Node's reader, on every access.
  const parsePackage = (pjsonPath) => {
    if (!host.stat(pjsonPath)?.isFile()) return { exists: false }
    let data
    try {
      data = JSON.parse(host.readFile(pjsonPath).toString('utf8'))
    } catch (cause) {
      return codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pjsonPath}: ${cause.message}`)
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {}
    const string = (value) => (typeof value === 'string' ? value : undefined)
    return { exists: true, path: pjsonPath, name: string(data.name), main: string(data.main), exports: data.exports, imports: data.imports }
  }
  const pkgCache = new Map()
  const readPackage = (pjsonPath) => {
    let pkg = pkgCache.get(pjsonPath)
    if (pkg === undefined) pkgCache.set(pjsonPath, pkg = parsePackage(pjsonPath))
    if (pkg instanceof Error) throw pkg
    return pkg
  }

  // Nearest package.json for a FILE path, never crossing up out of a node_modules dir (Node's
  // readPackageScope): -> pkg record or null.
  const readPackageScope = (checkPath) => {
    for (let dir = dirname(checkPath); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
      const pkg = readPackage(join(dir, 'package.json'))
      if (pkg.exists) return pkg
      if (dirname(dir) === dir) break
    }
    return null
  }

  // internalModuleStat: 0 file, 1 dir, -1 missing.
  const stat = (p) => {
    const st = host.stat(p)
    return st === null ? -1 : st.isDirectory() ? 1 : 0
  }
  const tryFile = (p) => (stat(p) === 0 ? host.realpath(p) : false)
  const tryExtensions = (base, exts) => {
    for (const ext of exts) {
      const hit = tryFile(base + ext)
      if (hit) return hit
    }
    return false
  }
  const tryPackage = (requestPath, exts, originalPath) => {
    const pkg = readPackage(join(requestPath, 'package.json'))
    const index = () => tryExtensions(resolve(requestPath, 'index'), exts)
    if (!pkg.exists || pkg.main === undefined) return index()
    const filename = resolve(requestPath, pkg.main)
    const actual = tryFile(filename) || tryExtensions(filename, exts) || tryExtensions(resolve(filename, 'index'), exts) || index()
    if (actual) return actual
    throw Object.assign(
      codedError('MODULE_NOT_FOUND', `Cannot find module '${filename}'. Please verify that the package.json has a valid "main" entry`),
      { path: join(requestPath, 'package.json'), requestPath: originalPath },
    )
  }

  // --- esm/resolve.js: exports / imports ---

  const fileExists = (url) => stat(fileURLToPath(url)) === 0

  const throwInvalidPackageTarget = (subpath, target, packageJSONUrl, internal) => {
    const rel = fileURLToPath(new URL('.', packageJSONUrl))
    const t = typeof target === 'string' ? target : JSON.stringify(target)
    throw codedError('ERR_INVALID_PACKAGE_TARGET',
      internal
        ? `Invalid "imports" target ${t} defined for '${subpath}' in the package config ${rel}package.json`
        : `Invalid "exports" ${subpath === '.' ? 'main' : 'target'} ${t} defined for '${subpath}' in the package config ${rel}package.json`)
  }

  const resolvePackageTargetString = (target, subpath, match, packageJSONUrl, pattern, internal, conditions) => {
    if (subpath !== '' && !pattern && !target.endsWith('/')) throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    if (!target.startsWith('./')) {
      // A bare `imports` target (`"#x": "dep"`) is a package specifier, resolved the ESM way.
      if (internal && !target.startsWith('../') && !target.startsWith('/') && !URL.canParse(target)) {
        return packageResolve(pattern ? target.replaceAll('*', subpath) : target + subpath, packageJSONUrl, conditions)
      }
      throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    }
    if (deprecatedInvalidSegmentRegEx.test(target.slice(2))) throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    const resolved = new URL(target, packageJSONUrl)
    if (!resolved.pathname.startsWith(new URL('.', packageJSONUrl).pathname)) throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    if (subpath === '') return resolved
    if (deprecatedInvalidSegmentRegEx.test(subpath)) {
      const request = pattern ? match.replace('*', subpath) : match + subpath
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${request}" request is not a valid match in pattern "${match}" for the "${internal ? 'imports' : 'exports'}" resolution of ${fileURLToPath(packageJSONUrl)}`)
    }
    if (pattern) return new URL(resolved.href.replaceAll('*', () => subpath))
    return new URL(subpath, resolved)
  }

  const resolvePackageTarget = (packageJSONUrl, target, subpath, packageSubpath, pattern, internal, conditions) => {
    if (typeof target === 'string') {
      return resolvePackageTargetString(target, subpath, packageSubpath, packageJSONUrl, pattern, internal, conditions)
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null
      let lastException
      for (const item of target) {
        let resolved
        try {
          resolved = resolvePackageTarget(packageJSONUrl, item, subpath, packageSubpath, pattern, internal, conditions)
        } catch (e) {
          lastException = e
          if (e.code === 'ERR_INVALID_PACKAGE_TARGET') continue
          throw e
        }
        if (resolved === undefined) continue
        if (resolved === null) {
          lastException = null
          continue
        }
        return resolved
      }
      if (lastException == null) return lastException
      throw lastException
    }
    if (typeof target === 'object' && target !== null) {
      const keys = Object.keys(target)
      if (keys.some(isArrayIndex)) {
        throw codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${fileURLToPath(packageJSONUrl)}. "exports" cannot contain numeric property keys.`)
      }
      for (const key of keys) {
        if (key !== 'default' && !conditions.has(key)) continue
        const resolved = resolvePackageTarget(packageJSONUrl, target[key], subpath, packageSubpath, pattern, internal, conditions)
        if (resolved !== undefined) return resolved
      }
      return undefined
    }
    if (target === null) return null
    throwInvalidPackageTarget(packageSubpath, target, packageJSONUrl, internal)
  }

  const throwExportsNotFound = (subpath, packageJSONUrl) => {
    const pkgPath = fileURLToPath(new URL('.', packageJSONUrl))
    throw codedError('ERR_PACKAGE_PATH_NOT_EXPORTED',
      subpath === '.'
        ? `No "exports" main defined in ${pkgPath}package.json`
        : `Package subpath '${subpath}' is not defined by "exports" in ${pkgPath}package.json`)
  }

  const packageExportsResolve = (packageJSONUrl, packageSubpath, packageConfig, conditions) => {
    let exports = packageConfig.exports
    if (isConditionalExportsMainSugar(exports, fileURLToPath(packageJSONUrl))) exports = { '.': exports }
    let resolved
    if (Object.hasOwn(exports, packageSubpath) && !packageSubpath.includes('*') && !packageSubpath.endsWith('/')) {
      resolved = resolvePackageTarget(packageJSONUrl, exports[packageSubpath], '', packageSubpath, false, false, conditions)
    } else {
      const match = bestPatternMatch(exports, packageSubpath)
      if (match) resolved = resolvePackageTarget(packageJSONUrl, exports[match[0]], match[1], match[0], true, false, conditions)
    }
    if (resolved == null) throwExportsNotFound(packageSubpath, packageJSONUrl)
    return resolved
  }

  const packageImportsResolve = (name, base, conditions) => {
    // (`#/x` is merely "not defined" in Node 24, so it is not screened here.)
    if (name === '#' || name.endsWith('/')) {
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${name}" is not a valid internal imports specifier name imported from ${fileURLToPath(base)}`)
    }
    const packageConfig = readPackageScope(fileURLToPath(base))
    const packageJSONUrl = packageConfig ? pathToFileURL(packageConfig.path) : undefined
    const imports = packageConfig?.imports
    if (imports) {
      let resolved
      if (Object.hasOwn(imports, name) && !name.includes('*')) {
        resolved = resolvePackageTarget(packageJSONUrl, imports[name], '', name, false, true, conditions)
      } else {
        const match = bestPatternMatch(imports, name)
        if (match) resolved = resolvePackageTarget(packageJSONUrl, imports[match[0]], match[1], match[0], true, true, conditions)
      }
      if (resolved != null) return resolved
    }
    throw codedError('ERR_PACKAGE_IMPORT_NOT_DEFINED',
      `Package import specifier "${name}" is not defined${packageJSONUrl ? ` in package ${fileURLToPath(packageJSONUrl)}` : ''} imported from ${fileURLToPath(base)}`)
  }

  const legacyMainResolve = (packageJSONUrl, packageConfig, base) => {
    let guess
    if (packageConfig.main !== undefined) {
      for (const suffix of ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node']) {
        if (fileExists(guess = new URL(`./${packageConfig.main}${suffix}`, packageJSONUrl))) return guess
      }
    }
    for (const index of ['./index.js', './index.json', './index.node']) {
      if (fileExists(guess = new URL(index, packageJSONUrl))) return guess
    }
    throw codedError('ERR_MODULE_NOT_FOUND', `Cannot find package '${fileURLToPath(new URL('.', packageJSONUrl))}' imported from ${fileURLToPath(base)}`)
  }

  // ESM-style bare resolution, reached only through a bare `imports` target (`"#x": "dep"`).
  const packageResolve = (specifier, base, conditions) => {
    if (isBuiltin(specifier)) return new URL(`node:${specifier}`)
    const { packageName, packageSubpath, isScoped } = parsePackageName(specifier, base)
    const scope = readPackageScope(fileURLToPath(base))
    if (scope && scope.exports != null && scope.name === packageName) {
      return packageExportsResolve(pathToFileURL(scope.path), packageSubpath, scope, conditions)
    }
    let packageJSONUrl = new URL(`./node_modules/${packageName}/package.json`, base)
    let packageJSONPath = fileURLToPath(packageJSONUrl)
    let lastPath
    do {
      if (stat(packageJSONPath.slice(0, -'/package.json'.length)) !== 1) {
        lastPath = packageJSONPath
        packageJSONUrl = new URL(`${isScoped ? '../../../../node_modules/' : '../../../node_modules/'}${packageName}/package.json`, packageJSONUrl)
        packageJSONPath = fileURLToPath(packageJSONUrl)
        continue
      }
      const packageConfig = readPackage(packageJSONPath)
      if (packageConfig.exports != null) return packageExportsResolve(packageJSONUrl, packageSubpath, packageConfig, conditions)
      if (packageSubpath === '.') return legacyMainResolve(packageJSONUrl, packageConfig, base)
      return new URL(packageSubpath, packageJSONUrl)
    } while (packageJSONPath.length !== lastPath.length)
    throw codedError('ERR_MODULE_NOT_FOUND', `Cannot find package '${packageName}' imported from ${fileURLToPath(base)}`)
  }

  // --- cjs/loader.js glue ---

  const createEsmNotFoundErr = (request, path) => Object.assign(codedError('MODULE_NOT_FOUND', `Cannot find module '${request}'`), path ? { path } : {})

  // An esm/resolve.js answer under CJS rules (Module._resolveFilename's finalizeEsmResolution and
  // the catch around it): a builtin stays a marker, the file must exist (realpathed), and an ESM
  // "not found" becomes CJS's MODULE_NOT_FOUND naming `request` (at `errPath`).
  const viaEsm = (resolveUrl, request, errPath, parentPath, pkgDir) => {
    let resolved
    try {
      resolved = resolveUrl()
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') throw createEsmNotFoundErr(request, errPath)
      throw e
    }
    if (resolved.protocol === 'node:') return { builtin: resolved.pathname }
    if (encodedSepRegEx.test(resolved.pathname)) {
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${resolved.pathname}" must not include encoded "/" or "\\" characters imported from ${parentPath}`)
    }
    const filename = fileURLToPath(resolved)
    const actual = tryFile(filename)
    if (actual) return actual
    throw createEsmNotFoundErr(filename, resolve(pkgDir, 'package.json'))
  }

  // Self-reference: a request naming the enclosing package, through its `exports`.
  const trySelf = (parentPath, request, conditions) => {
    const pkg = readPackageScope(parentPath)
    if (!pkg || pkg.exports == null || pkg.name === undefined) return false
    let expansion
    if (request === pkg.name) expansion = '.'
    else if (request.startsWith(`${pkg.name}/`)) expansion = `.${request.slice(pkg.name.length)}`
    else return false
    return viaEsm(() => packageExportsResolve(pathToFileURL(pkg.path), expansion, pkg, conditions), request, pkg.path, parentPath, dirname(pkg.path))
  }

  // A bare request into `nmPath` whose package has `exports`.
  const resolveExports = (nmPath, request, conditions) => {
    const m = EXPORTS_PATTERN.exec(request)
    if (!m) return false
    const [, name, expansion = ''] = m
    const pkgPath = resolve(nmPath, name)
    const pkg = readPackage(`${pkgPath}/package.json`)
    if (!pkg.exists || pkg.exports == null) return false
    return viaEsm(() => packageExportsResolve(pathToFileURL(pkg.path), `.${expansion}`, pkg, conditions), request, pkg.path, null, pkgPath)
  }

  // Module._findPath over `paths`: `exports` first for a bare request, then the file itself, its
  // extension completions (Module._extensions, so a `.ts`/`.node` probe tracks the running Node)
  // and the directory's `main`/index.
  const findPath = (request, paths, conditions) => {
    const absoluteRequest = isAbsolute(request)
    if (absoluteRequest) paths = ['']
    else if (!paths || paths.length === 0) return false
    const trailingSlash = TRAILING_SLASH.test(request)
    const insidePath = !(RELATIVE_REQUEST.test(request) && normalize(request).startsWith('..'))
    const exts = Object.keys(Module._extensions)
    for (const curPath of paths) {
      if (insidePath && curPath && stat(curPath) < 1) continue
      if (!absoluteRequest) {
        const exportsResolved = resolveExports(curPath, request, conditions)
        if (exportsResolved) return exportsResolved
      }
      const basePath = resolve(curPath, request)
      const rc = stat(basePath)
      let filename = false
      if (!trailingSlash) filename = (rc === 0 && host.realpath(basePath)) || tryExtensions(basePath, exts)
      if (!filename && rc === 1) filename = tryPackage(basePath, exts, request)
      if (filename) return filename
    }
    return false
  }

  const notFound = (request, parentFile) => Object.assign(codedError('MODULE_NOT_FOUND', `Cannot find module '${request}'\nRequire stack:\n- ${parentFile}`), { requireStack: [parentFile] })

  // Module._resolveFilename: -> the resolved file's real path, or a `{ builtin }` marker when a `#`
  // import maps to a builtin.
  const resolveFilename = (parentFile, request, conditions) => {
    if (typeof request !== 'string') throw codedError('ERR_INVALID_ARG_TYPE', `The "request" argument must be of type string. Received ${typeof request}`)
    if (isBuiltin(request)) return request
    if (request === '') throw notFound(request, parentFile)
    if (request[0] === '#') {
      const pkg = readPackageScope(parentFile)
      if (pkg?.imports != null) return viaEsm(() => packageImportsResolve(request, pathToFileURL(parentFile), conditions), request, undefined, parentFile, dirname(pkg.path))
    }
    const paths = RELATIVE_LOOKUP.test(request) ? [dirname(parentFile)] : nodeModulePaths(dirname(parentFile))
    const hit = trySelf(parentFile, request, conditions) || findPath(request, paths, conditions)
    if (hit) return hit
    throw notFound(request, parentFile)
  }

  return {
    // `conditions`: an iterable of condition names (a Set is used as-is). A builtin request (or a
    // `#` import mapped to one) returns its id, as `require.resolve` does.
    resolve(parentFile, request, conditions) {
      const set = conditions instanceof Set ? conditions : new Set(conditions ?? ['require', 'node', 'node-addons'])
      const hit = resolveFilename(resolve(parentFile), request, set)
      return typeof hit === 'string' ? hit : hit.builtin
    },
  }
}
