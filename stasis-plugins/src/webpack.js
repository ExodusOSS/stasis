import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
import { realReadFileSync } from '@exodus/stasis-core/state-util'
import { classifyExtension } from '@exodus/stasis-core/util'

// CJS require anchored here, used only to locate the PROJECT's babel-plugin-module-resolver below.
const require = createRequire(import.meta.url)

// Recovered package.json "imports" subpaths ('#app/abc.js'), keyed by (importerAbsolute, NUL,
// rewrittenRequest) -> array of original '#'-specifier(s) (several aliases can collide on one key,
// so afterResolve records an edge for each). Module-level so the single patch and every instance's
// lookup share it; never cleared (keys deterministic, values deduped).
const subpathOriginals = new Map()
const edgeKey = (importerAbsolute, request) => `${importerAbsolute}\u0000${request}`

// Marks an already-wrapped chokepoint so we don't double-wrap babel-plugin-module-resolver.
const PATCHED = Symbol('stasis.modresolver.patched')

// Synthetic stat for bundle-served files in load mode: webpack's resolver only needs existence +
// size; mtime/mode aren't security-relevant (the lockfile attests content via hash).
function bundleStat(size, isDir = false) {
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
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
    mode: isDir ? 0o040755 : 0o100644,
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

  // Number of compilers this instance drives (final by the first `done`): 1 for a lone compiler,
  // N for a MultiCompiler. Only the multi case accumulates across N `done`s and defers its write.
  #captureApplyCount = 0

  // Deferred-write bookkeeping for the multi-compiler case (see #deferWrite). #armed: the single
  // flush pair is registered; #dirty: a clean build completed since the last flush.
  #deferredWriteArmed = false
  #deferredWriteDirty = false

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisWebpack', options, process.cwd())
    this.#state = state  // null when plugin should be inert
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  apply(compiler) {
    if (!this.#state) return
    if (this.#state.config.loadBundle) {
      this.#applyLoadMode(compiler)
      return
    }
    this.#applyCaptureMode(compiler)
  }

  // Load mode: mirrors `stasis run --bundle=load`. In-scope paths MUST come from the bundle
  // (getFile re-verifies the hash); a missing in-scope file is a hard error, never a silent disk
  // fallback. In scope = full (everything under state.root) or node_modules-only per scope.
  // "The bundle" is the FAMILY -- this State plus its parent when running as a sidecar (both under
  // one shared lockfile). KNOWN LIMITATION: package.json the resolver reads via fs.readFile
  // (DescriptionFilePlugin) that no family bundle carries still fails closed -- see tests/webpack.test.js TODO.
  #applyLoadMode(compiler) {
    const state = this.#state
    const orig = compiler.inputFileSystem

    // True iff `p` is in scope for load mode. state.relative throws outside state.root (treated
    // as out-of-scope: system files, scratch).
    const inScope = (p) => {
      if (typeof p !== 'string') return false
      try { state.relative(p) } catch { return false }
      if (state.config.full) return true
      return state.inNodeModules(pathToFileURL(p).toString())
    }

    // Family = the sidecar's own app-graph bundle first, then its parent (loaders + resolution-path
    // dirs the ambient preload captured). Both share one lockfile; no parent -> just [state].
    const family = state.parent ? [state, state.parent] : [state]
    // First family State that attests `url` (file or dir), else undefined. Pure existence check.
    const ownerOf = (url) => family.find((s) => s.getFsStat(url) !== undefined)

    // Serve from whichever family bundle carries the path; getFile re-verifies the hash and throws
    // on a miss (the fail-closed gate -- never a silent disk fallback).
    const serveFromBundle = (p) => {
      const url = pathToFileURL(p).toString()
      return (ownerOf(url) ?? state).getFile(url).source
    }

    // Proxy (not Object.assign): CachedInputFileSystem stores state on `this`, so forwarded calls
    // must keep `this` = orig; we override only readFile and stat.
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
      // Forward `options` only when provided: CachedInputFileSystem.readFile is (path, callback);
      // an undefined middle arg lands in the callback slot and later crashes Storage.finished.
      if (options === undefined) return orig.readFile(p, callback)
      return orig.readFile(p, options, callback)
    }
    const wrappedStat = (p, callback) => {
      if (inScope(p)) {
        // Directories have no bundle content, so serve a synthetic dir Stats from the family's
        // existence record (getFsStat) -- webpack's resolver stat()s intermediate dirs while walking.
        const url = pathToFileURL(p).toString()
        if (ownerOf(url)?.getFsStat(url) === 'directory') {
          return callback(null, bundleStat(0, true))
        }
        try {
          const src = serveFromBundle(p)
          // Byte length, not String.length -- a multibyte-UTF-8 source has fewer JS chars than bytes.
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
        // Out-of-scope parents were never the bundle's responsibility -- defer to webpack's resolver.
        if (!inScope(issuer)) return
        // Built-ins are never bundled or recorded as edges; skip up front. SECURITY: never consult
        // getImport for a builtin name, so a tampered bundle can't redirect `fs` to an arbitrary file.
        if (isBuiltin(data.request)) return
        const parentURL = pathToFileURL(issuer).toString()
        let resolved
        try {
          resolved = state.getImport(parentURL, data.request)
        } catch (err) {
          // No attested edge -- at a successful capture that's an EXTERNAL (never recorded as an
          // edge), so defer to webpack. File BYTES still fail closed at the inputFileSystem wrapper.
          // A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
          if (err?.code === 'ERR_MODULE_NOT_FOUND') return
          throw err
        }
        // Redirect the resolver to the absolute bundle path; the stat wrapper then reports it exists.
        data.request = fileURLToPath(resolved.url)
      })
    })
  }

  // webpack 4's enhanced-resolve has no imports-field support, so babel-plugin-module-resolver
  // rewrites '#app/abc.js' subpaths in a loader before the parser -- by afterResolve the original
  // '#'-specifier is gone. Wrap the plugin's rewrite chokepoint (v5 lib/mapPath default export, or
  // v3/v4 lib/utils.mapPathString) to record (importer, rewritten) -> original, so afterResolve can
  // key the edge by the portable original. Best-effort, side-effect-only passthrough; absent package
  // skips the patch; PATCHED guards against re-wrapping.
  #patchModuleResolver() {
    const paths = [this.#state.root, process.cwd()]
    // Deep /lib/... requires resolve (no "exports" map). Try v5 then v3/v4; wrap every shape present.
    const candidates = [
      { sub: 'babel-plugin-module-resolver/lib/mapPath', prop: 'default' },
      { sub: 'babel-plugin-module-resolver/lib/utils', prop: 'mapPathString' },
    ]
    for (const { sub, prop } of candidates) {
      let mod
      try {
        mod = require(require.resolve(sub, { paths }))
      } catch {
        continue  // package absent, or this major lacks this submodule
      }
      const original = mod?.[prop]
      if (typeof original !== 'function' || original[PATCHED]) continue
      const wrapped = function stasisModuleResolverHook(nodePath, state) {
        const before = nodePath?.node?.value
        const result = original.apply(this, arguments)
        try {
          const after = nodePath?.node?.value
          // Only '#'-prefixed subpaths are recovered (other aliases keep webpack's rawRequest);
          // an unchanged node records nothing.
          if (typeof before === 'string' && before.startsWith('#') &&
              typeof after === 'string' && after !== before) {
            const importer = state?.file?.opts?.filename
            if (typeof importer === 'string') {
              // Append (deduped), don't overwrite: aliases colliding on one key each need an edge.
              const key = edgeKey(path.resolve(importer), after)
              const originals = subpathOriginals.get(key)
              if (originals === undefined) subpathOriginals.set(key, [before])
              else if (!originals.includes(before)) originals.push(before)
            }
          }
        } catch {
          // A recorder fault must never break the build -- the rewrite already ran above.
        }
        return result
      }
      wrapped[PATCHED] = true
      mod[prop] = wrapped
    }
  }

  #applyCaptureMode(compiler) {
    this.#captureApplyCount += 1
    // Install the module-resolver hook now (apply() runs at webpack() construction, before
    // compiler.run()), so the recorder is populated before afterResolve looks an edge up.
    this.#patchModuleResolver()
    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      // webpack 4's resolver reuses rrd.context.issuer across factory invocations, so by
      // afterResolve it can hold an EARLIER resolution's issuer (repro: webpack@4.15.1/4.47.0, see
      // tests/fixtures/webpack-stale-issuer-repro/NOTES.md). beforeResolve's contextInfo.issuer is
      // fresh, so capture it there in a WeakMap keyed by dep[0] (the same ref flows through create()).
      const issuerByDep = new WeakMap()
      nmf.hooks.beforeResolve.tap('Stasis', (data) => {
        const dep = data?.dependencies?.[0]
        const issuer = data?.contextInfo?.issuer
        if (dep && issuer) issuerByDep.set(dep, issuer)
      })

      nmf.hooks.afterResolve.tap('Stasis', (data) => {
        // Cross-version unwrap: webpack 5 nests rawRequest/resourceResolveData under createData;
        // webpack 4 hangs them off data. Fall through to data when createData is absent.
        const cd = data.createData ?? data
        // Track the resolved on-disk path (resourceResolveData.path, no query/fragment). Silently
        // skip data: URIs, null-loader stubs, and any resolution with no on-disk file to hash.
        const filePath = cd.resourceResolveData?.path
        if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) return

        const kind = classifyExtension(filePath, this.#resources)
        if (kind === 'unknown') {
          throw new Error(
            `StasisWebpack: unsupported extension for '${filePath}' -- ` +
            `add its extension or filename to the plugin's resources option or stop importing it`
          )
        }

        const url = pathToFileURL(filePath).toString()
        // Issuer attribution, most reliable first: (1) beforeResolve WeakMap (dodges the webpack 4
        // stale-issuer bug), (2) contextInfo.issuer (fresh on webpack 5), (3) rrd.context.issuer
        // (webpack 4 only; enhanced-resolve 5 removed it).
        const dep = data?.dependencies?.[0]
        const issuer = (dep && issuerByDep.get(dep))
          ?? data.contextInfo?.issuer
          ?? cd.resourceResolveData?.context?.issuer
        const isEntry = !issuer
        const rawRequest = cd.rawRequest ?? data.rawRequest

        if (kind === 'code' && !isEntry) {
          const issuerAbsolute = path.resolve(issuer)
          const parentURL = pathToFileURL(issuerAbsolute).toString()
          // If babel-plugin-module-resolver rewrote '#' subpaths into this rawRequest, key the edge
          // by each recorded ORIGINAL (portable, round-trips at load) instead of the relative path;
          // no rewrite -> fall back to rawRequest.
          const originals = subpathOriginals.get(edgeKey(issuerAbsolute, rawRequest))
          for (const specifier of originals ?? [rawRequest]) {
            this.#state.addImport(parentURL, specifier, url)
          }
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          // Real reader (state-util.js): plugin bookkeeping, must not be re-recorded under --fs.
          const source = realReadFileSync(filePath)
          // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
          if (kind === 'code') {
            assert.ok(isUtf8(source), `StasisWebpack: code-classified file has non-UTF-8 bytes: ${filePath}`)
          }
          this.#state.addFile(url, { source, isEntry, resource: kind === 'resource', reason: 'webpack' })
        }
      })
    })

    // Watch-mode capture is unsupported: dedupe is keyed by PATH not content, so a rebuild with
    // changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. watchRun fires
    // only under compiler.watch(), before the first build, so throwing here refuses the whole session.
    compiler.hooks.watchRun.tap('Stasis', () => {
      throw new Error(
        'StasisWebpack: watch mode is not supported for capture -- ' +
        'run a one-shot build (watch rebuilds would silently attest stale content)'
      )
    })

    // The preload writes itself (hooks.js); standalone/sidecar States are written on compiler
    // finish -- only on a clean build (a partial one would overwrite a good lockfile).
    if (this.#state !== State.preload) {
      compiler.hooks.done.tap('Stasis', (stats) => {
        if (stats.hasErrors()) return
        // Single compiler: write now (one `done`). Multi-compiler: defer -- `done` fires per child,
        // so writing each time pays N super-linear brotli passes over a growing bundle; coalesce to one.
        if (this.#captureApplyCount === 1) this.#state.write()
        else this.#deferWrite()
      })
    }
  }

  // Mark dirty and register a single end-of-process flush so a MultiCompiler's per-child `done`
  // events coalesce into one write of the final bundle. KNOWN LIMITATION: the flush runs at
  // beforeExit/exit, so a signal death (SIGINT/SIGTERM/SIGKILL) bypasses it -- same capture-then-exit
  // assumption as the preload's write (hooks.js).
  #deferWrite() {
    this.#deferredWriteDirty = true
    if (this.#deferredWriteArmed) return
    this.#deferredWriteArmed = true
    const flush = () => {
      if (!this.#deferredWriteDirty) return  // already flushed; exit backstop is a no-op
      this.#state.write()                    // sync write; on throw, dirty stays set so exit retries
      this.#deferredWriteDirty = false       // clear ONLY after a successful write
    }
    // beforeExit for the natural drain; exit is the sync backstop for process.exit() (write is sync).
    process.on('beforeExit', flush)
    process.on('exit', flush)
  }
}
