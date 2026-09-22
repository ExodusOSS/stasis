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

// Same regex as esm/resolve.js's deprecatedInvalidSegmentRegEx: a `.`, `..` or `node_modules`
// segment (percent-encoded spellings included) is invalid in a target/subpath. (Node's wider
// invalidSegmentRegEx additionally matches an EMPTY segment, which it merely deprecates, so that
// case is not an error here either.)
const deprecatedInvalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/iu
const encodedSepRegEx = /%2F|%5C/iu
// Module._findPath's bare-package matcher: `name` or `@scope/name`, optional `/subpath`.
const EXPORTS_PATTERN = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/u

function isArrayIndex(key) {
  const n = Number(key)
  if (`${n}` !== key) return false
  return n >= 0 && n < 0xFF_FF_FF_FF
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
  let sugar = false
  let i = 0
  for (const key of Object.keys(exports)) {
    const cur = key === '' || key[0] !== '.'
    if (i++ === 0) sugar = cur
    else if (sugar !== cur) {
      throw codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pkgPath}. "exports" cannot contain some keys starting with '.' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.`)
    }
  }
  return sugar
}

// The extensions Node probes for an extensionless request: exactly the running Node's registered
// CJS loaders, so a `.ts` (type-stripping builds) or `.node` probe tracks the runtime.
function cjsExtensions() {
  return Object.keys(Module._extensions)
}

export function createNodeResolver(host) {
  // package.json reads, memoized per path: { exists, data, path } (a malformed manifest throws
  // ERR_INVALID_PACKAGE_CONFIG like Node's reader, on every access).
  const pkgCache = new Map()
  const readPackage = (pjsonPath) => {
    let cached = pkgCache.get(pjsonPath)
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached
      return cached
    }
    const st = host.stat(pjsonPath)
    if (st === null || !st.isFile()) {
      cached = { exists: false }
    } else {
      let data
      try {
        data = JSON.parse(host.readFile(pjsonPath).toString('utf8'))
      } catch (cause) {
        cached = codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pjsonPath}: ${cause.message}`)
        pkgCache.set(pjsonPath, cached)
        throw cached
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {}
      cached = {
        exists: true,
        path: pjsonPath,
        name: typeof data.name === 'string' ? data.name : undefined,
        main: typeof data.main === 'string' ? data.main : undefined,
        type: data.type === 'module' || data.type === 'commonjs' ? data.type : 'none',
        exports: data.exports,
        imports: data.imports,
      }
    }
    pkgCache.set(pjsonPath, cached)
    return cached
  }

  // Nearest package.json for a FILE path, never crossing up out of a node_modules dir
  // (Node's readPackageScope / getPackageScopeConfig): -> pkg record or null.
  const readPackageScope = (checkPath) => {
    let dir = dirname(checkPath)
    while (true) {
      if (basename(dir) === 'node_modules') return null
      const pkg = readPackage(join(dir, 'package.json'))
      if (pkg.exists) return pkg
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  // internalModuleStat: 0 file, 1 dir, -1 missing.
  const stat = (p) => {
    const st = host.stat(p)
    if (st === null) return -1
    return st.isDirectory() ? 1 : 0
  }
  const toRealPath = (p) => host.realpath(p)
  const tryFile = (p) => (stat(p) === 0 ? toRealPath(p) : false)
  const tryExtensions = (base, exts) => {
    for (const ext of exts) {
      const hit = tryFile(base + ext)
      if (hit) return hit
    }
    return false
  }

  const tryPackage = (requestPath, exts, originalPath) => {
    const pkg = readPackage(join(requestPath, 'package.json'))
    if (!pkg.exists || pkg.main === undefined) return tryExtensions(resolve(requestPath, 'index'), exts)
    const filename = resolve(requestPath, pkg.main)
    let actual = tryFile(filename) || tryExtensions(filename, exts) || tryExtensions(resolve(filename, 'index'), exts)
    if (actual === false) {
      actual = tryExtensions(resolve(requestPath, 'index'), exts)
      if (!actual) {
        throw Object.assign(
          codedError('MODULE_NOT_FOUND', `Cannot find module '${filename}'. Please verify that the package.json has a valid "main" entry`),
          { path: join(requestPath, 'package.json'), requestPath: originalPath },
        )
      }
    }
    return actual
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

  const resolvePackageTargetString = (target, subpath, match, packageJSONUrl, pattern, internal, isPathMap, conditions) => {
    if (subpath !== '' && !pattern && target[target.length - 1] !== '/') throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    if (!target.startsWith('./')) {
      if (internal && !target.startsWith('../') && !target.startsWith('/')) {
        let isURL = false
        try {
          new URL(target) // eslint-disable-line no-new
          isURL = true
        } catch { /* not a URL: a bare specifier */ }
        if (!isURL) {
          const exportTarget = pattern ? target.replaceAll('*', subpath) : target + subpath
          return packageResolve(exportTarget, packageJSONUrl, conditions)
        }
      }
      throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    }
    if (deprecatedInvalidSegmentRegEx.test(target.slice(2))) throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    const resolved = new URL(target, packageJSONUrl)
    const resolvedPath = resolved.pathname
    const packagePath = new URL('.', packageJSONUrl).pathname
    if (!resolvedPath.startsWith(packagePath)) throwInvalidPackageTarget(match, target, packageJSONUrl, internal)
    if (subpath === '') return resolved
    if (deprecatedInvalidSegmentRegEx.test(subpath)) {
      const request = pattern ? match.replace('*', subpath) : match + subpath
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${request}" request is not a valid match in pattern "${match}" for the "${internal ? 'imports' : 'exports'}" resolution of ${fileURLToPath(packageJSONUrl)}`)
    }
    if (pattern) return new URL(resolved.href.replaceAll('*', () => subpath))
    return new URL(subpath, resolved)
  }

  const resolvePackageTarget = (packageJSONUrl, target, subpath, packageSubpath, pattern, internal, isPathMap, conditions) => {
    if (typeof target === 'string') {
      return resolvePackageTargetString(target, subpath, packageSubpath, packageJSONUrl, pattern, internal, isPathMap, conditions)
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null
      let lastException
      for (const item of target) {
        let resolved
        try {
          resolved = resolvePackageTarget(packageJSONUrl, item, subpath, packageSubpath, pattern, internal, isPathMap, conditions)
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
      if (lastException === undefined || lastException === null) return lastException
      throw lastException
    }
    if (typeof target === 'object' && target !== null) {
      const keys = Object.keys(target)
      for (const key of keys) {
        if (isArrayIndex(key)) {
          throw codedError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${fileURLToPath(packageJSONUrl)}. "exports" cannot contain numeric property keys.`)
        }
      }
      for (const key of keys) {
        if (key === 'default' || conditions.has(key)) {
          const resolved = resolvePackageTarget(packageJSONUrl, target[key], subpath, packageSubpath, pattern, internal, isPathMap, conditions)
          if (resolved === undefined) continue
          return resolved
        }
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
    if (Object.hasOwn(exports, packageSubpath) && !packageSubpath.includes('*') && !packageSubpath.endsWith('/')) {
      const resolved = resolvePackageTarget(packageJSONUrl, exports[packageSubpath], '', packageSubpath, false, false, false, conditions)
      if (resolved == null) throwExportsNotFound(packageSubpath, packageJSONUrl)
      return resolved
    }
    let bestMatch = ''
    let bestMatchSubpath
    for (const key of Object.keys(exports)) {
      const patternIndex = key.indexOf('*')
      if (patternIndex !== -1 && packageSubpath.startsWith(key.slice(0, patternIndex))) {
        const patternTrailer = key.slice(patternIndex + 1)
        if (packageSubpath.length >= key.length && packageSubpath.endsWith(patternTrailer)
          && patternKeyCompare(bestMatch, key) === 1 && key.lastIndexOf('*') === patternIndex) {
          bestMatch = key
          bestMatchSubpath = packageSubpath.slice(patternIndex, packageSubpath.length - patternTrailer.length)
        }
      }
    }
    if (bestMatch) {
      const resolved = resolvePackageTarget(packageJSONUrl, exports[bestMatch], bestMatchSubpath, bestMatch, true, false, packageSubpath.endsWith('/'), conditions)
      if (resolved == null) throwExportsNotFound(packageSubpath, packageJSONUrl)
      return resolved
    }
    throwExportsNotFound(packageSubpath, packageJSONUrl)
  }

  const packageImportsResolve = (name, base, conditions) => {
    // (`#/x` is merely "not defined" in Node 24, so it is not screened here.)
    if (name === '#' || name.endsWith('/')) {
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${name}" is not a valid internal imports specifier name imported from ${fileURLToPath(base)}`)
    }
    const packageConfig = readPackageScope(fileURLToPath(base))
    let packageJSONUrl
    if (packageConfig) {
      packageJSONUrl = pathToFileURL(packageConfig.path)
      const imports = packageConfig.imports
      if (imports) {
        if (Object.hasOwn(imports, name) && !name.includes('*')) {
          const resolved = resolvePackageTarget(packageJSONUrl, imports[name], '', name, false, true, false, conditions)
          if (resolved != null) return resolved
        } else {
          let bestMatch = ''
          let bestMatchSubpath
          for (const key of Object.keys(imports)) {
            const patternIndex = key.indexOf('*')
            if (patternIndex !== -1 && name.startsWith(key.slice(0, patternIndex))) {
              const patternTrailer = key.slice(patternIndex + 1)
              if (name.length >= key.length && name.endsWith(patternTrailer)
                && patternKeyCompare(bestMatch, key) === 1 && key.lastIndexOf('*') === patternIndex) {
                bestMatch = key
                bestMatchSubpath = name.slice(patternIndex, name.length - patternTrailer.length)
              }
            }
          }
          if (bestMatch) {
            const resolved = resolvePackageTarget(packageJSONUrl, imports[bestMatch], bestMatchSubpath, bestMatch, true, true, false, conditions)
            if (resolved != null) return resolved
          }
        }
      }
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

  const parsePackageName = (specifier, base) => {
    let separatorIndex = specifier.indexOf('/')
    let validPackageName = true
    let isScoped = false
    if (specifier[0] === '@') {
      isScoped = true
      if (separatorIndex === -1 || specifier.length === 0) validPackageName = false
      else separatorIndex = specifier.indexOf('/', separatorIndex + 1)
    }
    const packageName = separatorIndex === -1 ? specifier : specifier.slice(0, separatorIndex)
    if (/^\.|%|\\/u.test(packageName)) validPackageName = false
    if (!validPackageName) {
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${specifier}" is not a valid package name imported from ${fileURLToPath(base)}`)
    }
    const packageSubpath = `.${separatorIndex === -1 ? '' : specifier.slice(separatorIndex)}`
    return { packageName, packageSubpath, isScoped }
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

  // A resolved URL to the real file it names (or a builtin marker), failing closed on a missing file.
  const finalizeEsmResolution = (resolved, parentPath, pkgPath) => {
    if (resolved.protocol === 'node:') return { builtin: resolved.pathname }
    if (encodedSepRegEx.test(resolved.pathname)) {
      throw codedError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${resolved.pathname}" must not include encoded "/" or "\\" characters imported from ${parentPath}`)
    }
    const filename = fileURLToPath(resolved)
    const actual = tryFile(filename)
    if (actual) return actual
    throw createEsmNotFoundErr(filename, resolve(pkgPath, 'package.json'))
  }

  const trySelf = (parentPath, request, conditions) => {
    const pkg = readPackageScope(parentPath)
    if (!pkg || pkg.exports == null || pkg.name === undefined) return false
    let expansion
    if (request === pkg.name) expansion = '.'
    else if (request.startsWith(`${pkg.name}/`)) expansion = `.${request.slice(pkg.name.length)}`
    else return false
    try {
      return finalizeEsmResolution(packageExportsResolve(pathToFileURL(pkg.path), expansion, pkg, conditions), parentPath, dirname(pkg.path))
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') throw createEsmNotFoundErr(request, pkg.path)
      throw e
    }
  }

  const resolveExports = (nmPath, request, conditions) => {
    const m = EXPORTS_PATTERN.exec(request)
    if (!m) return false
    const [, name, expansion = ''] = m
    const pkgPath = resolve(nmPath, name)
    const pkg = readPackage(`${pkgPath}/package.json`)
    if (pkg.exists && pkg.exports != null) {
      try {
        return finalizeEsmResolution(packageExportsResolve(pathToFileURL(`${pkgPath}/package.json`), `.${expansion}`, pkg, conditions), null, pkgPath)
      } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') throw createEsmNotFoundErr(request, `${pkgPath}/package.json`)
        throw e
      }
    }
    return false
  }

  // Module._nodeModulePaths(from): every ancestor's node_modules, skipping node_modules dirs themselves.
  const nodeModulePaths = (from) => {
    from = resolve(from)
    if (from === '/') return ['/node_modules']
    const paths = []
    const parts = from.split('/')
    for (let i = parts.length; i > 0; i--) {
      if (parts[i - 1] === 'node_modules') continue
      paths.push(`${parts.slice(0, i).join('/') || ''}/node_modules`)
    }
    return paths
  }

  const isRelativeRequest = (request) =>
    request.charCodeAt(0) === 46 /* . */ && (request.length === 1 || request.charCodeAt(1) === 47 /* / */
      || (request.charCodeAt(1) === 46 && (request.length === 2 || request.charCodeAt(2) === 47)))

  const hasTrailingSlash = (request) => {
    const len = request.length
    if (len === 0) return false
    const last = request.charCodeAt(len - 1)
    if (last === 47) return true
    if (last !== 46) return false
    return len === 1 || request.charCodeAt(len - 2) === 47
      || (request.charCodeAt(len - 2) === 46 && (len === 2 || request.charCodeAt(len - 3) === 47))
  }

  const findPath = (request, paths, conditions) => {
    const absoluteRequest = isAbsolute(request)
    if (absoluteRequest) paths = ['']
    else if (!paths || paths.length === 0) return false
    const trailingSlash = hasTrailingSlash(request)
    const isRelative = isRelativeRequest(request)
    let insidePath = true
    if (isRelative && normalize(request).startsWith('..')) insidePath = false
    let exts
    for (const curPath of paths) {
      if (insidePath && curPath && stat(curPath) < 1) continue
      if (!absoluteRequest) {
        const exportsResolved = resolveExports(curPath, request, conditions)
        if (exportsResolved) return exportsResolved
      }
      const basePath = resolve(curPath, request)
      let filename
      const rc = stat(basePath)
      if (!trailingSlash) {
        if (rc === 0) filename = toRealPath(basePath)
        if (!filename) {
          exts ??= cjsExtensions()
          filename = tryExtensions(basePath, exts)
        }
      }
      if (!filename && rc === 1) {
        exts ??= cjsExtensions()
        filename = tryPackage(basePath, exts, request)
      }
      if (filename) return filename
    }
    return false
  }

  const resolveLookupPaths = (request, parentFile) => {
    // Bare (and absolute) requests walk node_modules; `./`, `../`, `.`, `..` resolve from the parent's dir.
    if (request.charAt(0) !== '.' || (request.length > 1 && request.charAt(1) !== '.' && request.charAt(1) !== '/')) {
      return nodeModulePaths(dirname(parentFile))
    }
    return [dirname(parentFile)]
  }

  // -> absolute path of the resolved file (realpathed), or a `{ builtin }` marker when a `#` import
  // maps to a builtin. `conditions` is the Set Node would use (`require`/`import` + user extras).
  const notFound = (request, parentFile) => {
    const err = codedError('MODULE_NOT_FOUND', `Cannot find module '${request}'\nRequire stack:\n- ${parentFile}`)
    err.requireStack = [parentFile]
    return err
  }

  const resolveFilename = (parentFile, request, conditions) => {
    if (typeof request !== 'string') {
      throw codedError('ERR_INVALID_ARG_TYPE', `The "request" argument must be of type string. Received ${typeof request}`)
    }
    if (isBuiltin(request)) return request
    if (request === '') throw notFound(request, parentFile)
    if (request[0] === '#') {
      const pkg = readPackageScope(parentFile)
      if (pkg?.imports != null) {
        try {
          return finalizeEsmResolution(packageImportsResolve(request, pathToFileURL(parentFile), conditions), parentFile, dirname(pkg.path))
        } catch (e) {
          if (e.code === 'ERR_MODULE_NOT_FOUND') throw createEsmNotFoundErr(request)
          throw e
        }
      }
    }
    const selfResolved = trySelf(parentFile, request, conditions)
    if (selfResolved) return selfResolved
    const filename = findPath(request, resolveLookupPaths(request, parentFile), conditions)
    if (filename) return filename
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
