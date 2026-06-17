import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { classifyExtension, parseResourcesOption, resolvePluginState } from './plugins.js'
import { State } from './state.js'

// Synthetic stat for files served from the bundle in load mode. Webpack's resolver
// + module factory call inputFileSystem.stat() to check existence and read size;
// we don't keep the real mtime/mode/etc., they're not security-relevant here (the
// lockfile already attests content via hash; getFile re-verifies on every read).
function bundleStat(size) {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size,
    mtime: new Date(0),
    mtimeMs: 0,
    atime: new Date(0),
    atimeMs: 0,
    ctime: new Date(0),
    ctimeMs: 0,
    birthtime: new Date(0),
    birthtimeMs: 0,
    mode: 0o100644,
    uid: 0,
    gid: 0,
    ino: 0,
    nlink: 1,
    rdev: 0,
    blksize: 4096,
    blocks: 0,
    dev: 0,
  }
}

export class StasisWebpack {
  #seen = new Set()
  #state
  #resources

  constructor(options = {}) {
    const { resources, ...rest } = options
    this.#resources = parseResourcesOption('StasisWebpack', resources)
    const { state } = resolvePluginState('StasisWebpack', rest, process.cwd())
    this.#state = state  // null when plugin should be inert
  }

  apply(compiler) {
    if (!this.#state) return
    if (this.#state.config.loadBundle) {
      this.#applyLoadMode(compiler)
      return
    }
    this.#applyCaptureMode(compiler)
  }

  // Load mode: mirrors `stasis run --bundle=load` for the webpack plugin context.
  // The decision "serve from bundle vs defer to disk" depends solely on bundle
  // mode + scope, never on whether the path happens to live in the bundle -- a
  // missing in-scope file is a hard error, not a silent disk fallback.
  //   In scope:
  //     - full scope: every path under state.root is in scope; everything outside
  //       the project root is genuinely external (system files, OS paths) and
  //       defers to disk
  //     - node_modules scope: node_modules paths under state.root only; app
  //       sources are deliberately disk-served
  //   Wiring:
  //     - inputFileSystem.readFile / stat: in-scope paths MUST come from
  //       state.getFile (which re-verifies the hash against the lockfile); a path
  //       the bundle doesn't carry throws rather than falling back to disk
  //     - normalModuleFactory.hooks.beforeResolve: in-scope (issuer, request)
  //       edges MUST resolve via state.getImport; if the bundle doesn't attest
  //       the edge, the throw surfaces as a webpack resolution error
  //     - Out-of-scope paths defer to disk
  //
  //   KNOWN LIMITATION: bundle=load works today only for module graphs that
  //   don't cross node_modules. The Node run loader doesn't capture the
  //   package.json files webpack's resolver reads via fs.readFile through
  //   DescriptionFilePlugin, and `state.getFile` throws on the intermediate
  //   directory stats the resolver does while walking. Both happen regardless
  //   of scope. The no-deps full-scope round-trip is the verified surface
  //   today; see `tests/webpack.test.js` and its skipped TODO for the broader
  //   case.
  #applyLoadMode(compiler) {
    const state = this.#state
    const orig = compiler.inputFileSystem

    // True iff `p` is a path the bundle is supposed to cover under load mode.
    // `state.relative` throws for paths outside `state.root`, which we treat as
    // out-of-scope (system files, /tmp scratch, ...). state.inNodeModules is
    // itself tolerant of un-canonicalizable URLs.
    const inScope = (p) => {
      if (typeof p !== 'string') return false
      try { state.relative(p) } catch { return false }
      if (state.config.full) return true
      return state.inNodeModules(pathToFileURL(p).toString())
    }

    // getFile re-verifies the hash against the lockfile on every read (tampered
    // bundle fails closed), and throws on a file the bundle doesn't carry --
    // so an in-scope path the bundle is missing surfaces here, not via a silent
    // disk fallback.
    const serveFromBundle = (p) => state.getFile(pathToFileURL(p).toString()).source

    // Wrap inputFileSystem. CachedInputFileSystem stores internal state on `this`,
    // so a naive Object.create or Object.assign would strand methods like readdir
    // / lstat / purge that aren't intercepted; a Proxy keeps `this` pointing at
    // orig for forwarded calls and only overrides readFile and stat.
    const wrappedReadFile = (p, options, callback) => {
      if (typeof options === 'function') { callback = options; options = undefined }
      if (inScope(p)) {
        try {
          const src = serveFromBundle(p)
          const buf = Buffer.isBuffer(src) ? src : Buffer.from(src)
          return callback(null, buf)
        } catch (err) {
          return callback(err)
        }
      }
      // Only forward `options` when caller actually provided one. webpack's
      // CachedInputFileSystem.readFile is `(path, callback)`-shaped (no options
      // slot); passing `undefined` in the middle would land in its callback
      // position and Storage.finished would later try to invoke `undefined(...)`.
      if (options === undefined) return orig.readFile(p, callback)
      return orig.readFile(p, options, callback)
    }
    const wrappedStat = (p, callback) => {
      if (inScope(p)) {
        try {
          const src = serveFromBundle(p)
          // Use byte length, not String.length -- a multibyte-UTF-8 code source
          // (sources are strings; see state.getFile) has fewer JS-chars than
          // bytes-on-disk. Webpack 4 only uses stat.size for display, but the
          // discrepancy would still be wrong if any downstream consumer slices.
          const size = typeof src === 'string' ? Buffer.byteLength(src) : src.length
          return callback(null, bundleStat(size))
        } catch (err) {
          return callback(err)
        }
      }
      return orig.stat(p, callback)
    }
    compiler.inputFileSystem = new Proxy(orig, {
      get(target, prop) {
        if (prop === 'readFile') return wrappedReadFile
        if (prop === 'stat') return wrappedStat
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })

    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      nmf.hooks.beforeResolve.tap('Stasis', (data) => {
        const issuer = data.contextInfo?.issuer
        if (!issuer) return  // entries: already absolute, inputFileSystem covers them
        // An in-scope parent's resolution MUST come from the bundle's import map;
        // if state.getImport throws ERR_MODULE_NOT_FOUND, the bundle is missing the
        // attested edge and we let it propagate (webpack surfaces it as a
        // resolution error). Out-of-scope parents (e.g. nm-scope app code,
        // webpack-internal loader resolution) defer to webpack's resolver --
        // they were never the bundle's responsibility to attest.
        if (!inScope(issuer)) return
        const parentURL = pathToFileURL(issuer).toString()
        const { url } = state.getImport(parentURL, data.request)
        // Redirect the resolver to the absolute bundle path; our stat wrapper
        // then reports it exists, so the resolver short-circuits without
        // walking node_modules or trying extension fallbacks.
        data.request = fileURLToPath(url)
      })
    })
  }

  #applyCaptureMode(compiler) {
    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      nmf.hooks.afterResolve.tap('Stasis', (data) => {
        // resourceResolveData.path is the resolved on-disk path without query/fragment;
        // data.resource may carry a `?query` (inline-loader, asset import suffixes) or
        // be a synthetic resource (data:, null-loader). We track the resolved file only.
        //
        // Silent skip: data: URIs, null-loader stubs, and any resolution that
        // produced no on-disk path bypass capture entirely. If the same underlying
        // file is reachable through a non-null-loader path elsewhere in the graph
        // it'll get captured then; otherwise it stays unattested. This matches
        // webpack's view -- those resolutions don't have a real source file we
        // could hash.
        const filePath = data.resourceResolveData?.path
        if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) return

        const kind = classifyExtension(filePath, this.#resources)
        if (kind === 'unknown') {
          throw new Error(
            `StasisWebpack: unsupported extension for '${filePath}' -- ` +
            `add its extension to the plugin's resources option or stop importing it`
          )
        }

        const url = pathToFileURL(filePath).toString()
        const issuer = data.resourceResolveData.context?.issuer
        const isEntry = !issuer

        if (kind === 'code' && !isEntry) {
          const parentURL = pathToFileURL(path.resolve(issuer)).toString()
          this.#state.addImport(parentURL, data.rawRequest, url)
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          const source = readFileSync(filePath)
          // Code-classified files must be UTF-8. A code extension with non-UTF-8
          // bytes is malformed input (e.g. a .json mis-saved as UTF-16); refuse
          // it rather than silently encoding it as a resource. Resource-classified
          // files are passed through as-is -- State picks 'resource' vs
          // 'resource:base64' from content.
          if (kind === 'code') {
            assert.ok(isUtf8(source), `StasisWebpack: code-classified file has non-UTF-8 bytes: ${filePath}`)
          }
          this.#state.addFile(url, { source, isEntry, resource: kind === 'resource' })
        }
      })
    })

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them when the
    // compiler finishes -- but only on a clean build. A failed compilation has incomplete
    // state, and lock=replace would otherwise overwrite a good lockfile with a partial one.
    if (this.#state !== State.preload) {
      compiler.hooks.done.tap('Stasis', (stats) => {
        if (stats.hasErrors()) return
        this.#state.write()
      })
    }
  }
}
