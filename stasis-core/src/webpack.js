import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePluginState } from './plugins.js'
import { State } from './state.js'
import { realReadFileSync } from './state-util.js'
import { classifyExtension } from './util.js'

// A CJS require anchored at this ESM module, used only to optionally locate the
// PROJECT's babel-plugin-module-resolver for the capture-time monkey-patch below.
// stasis-core stays zero-dependency: the package is never imported statically, and
// a project without it just skips the patch.
const require = createRequire(import.meta.url)

// Original package.json "imports" subpath specifiers ('#app/abc.js') recovered by the
// babel-plugin-module-resolver monkey-patch (see StasisWebpack#patchModuleResolver),
// keyed by `${importerAbsolute}\0${rewrittenRequest}` -> the original '#'-specifier(s).
// The value is an ARRAY: usually one, but more than one when several subpath aliases map to the
// SAME file from the same importer (they all rewrite to the identical relative request, colliding
// on one key). afterResolve records an edge for EACH, so no subpath import is silently dropped.
// Module-level (not per-instance) so the single patch -- installed by whichever plugin
// instance applies first -- and every instance's afterResolve lookup share one map; the
// patch wrapper and the lookup both live in THIS module, so the closure reference agrees.
// Intentionally never cleared: keys are deterministic (absolute importer + rewritten request)
// and values are deduped, so a watch rebuild RE-RECORDS the same entries idempotently rather
// than accumulating -- bounded by the project's '#'-edge count. Not scoped per build because a
// parallel MultiCompiler would race a per-`done` clear,
// and entries are tiny (~a path + a short specifier). The only unbounded case is a long-lived
// process building MANY DISTINCT graphs (e.g. a build server with per-run temp dirs); that's
// outside stasis's per-`stasis run`-process model, so the simplicity wins.
const subpathOriginals = new Map()
const edgeKey = (importerAbsolute, request) => `${importerAbsolute}\u0000${request}`

// Marks an already-wrapped chokepoint so watch rebuilds / multiple plugin instances
// don't double-wrap babel-plugin-module-resolver.
const PATCHED = Symbol('stasis.modresolver.patched')

// Synthetic stat for files served from the bundle in load mode. Webpack's resolver
// + module factory call inputFileSystem.stat() to check existence and read size;
// we don't keep the real mtime/mode/etc., they're not security-relevant here (the
// lockfile already attests content via hash; getFile re-verifies on every read).
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

  // Number of compilers this (capture-mode) instance is applied to. webpack constructs every
  // compiler -- and runs every plugin's apply() -- before any build starts, so by the first
  // `done` this is final: 1 for a lone compiler, N when one shared instance drives a
  // MultiCompiler's N child compilers. Only the latter accumulates files into one State across
  // N `done`s, which is the case worth deferring (see the done hook).
  #captureApplyCount = 0

  // Deferred-write bookkeeping for the MULTI-compiler one-shot case, see #deferWrite. #armed:
  // whether the single beforeExit/exit flush pair has been registered (idempotent across the
  // N child-compiler `done`s a MultiCompiler fires). #dirty: a clean build completed since the
  // last flush, so there is something to write.
  #deferredWriteArmed = false
  #deferredWriteDirty = false

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisWebpack', options, process.cwd())
    this.#state = state  // null when plugin should be inert
    // resources is a Config field now (validated + coordinated against any preload in
    // resolvePluginState); cache the resolved Set for the per-file classify hot path.
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
  //     - inputFileSystem.readFile / stat: in-scope paths MUST come from the
  //       bundle (getFile re-verifies the hash against the lockfile); a path no
  //       bundle carries throws rather than falling back to disk. "The bundle"
  //       here is the FAMILY -- this State plus its parent when the plugin runs
  //       as a sidecar (its app-graph bundle alongside the ambient preload's
  //       build-closure bundle, both under the one shared lockfile). stat serves
  //       a synthetic directory Stats for any dir the family records (explicit
  //       capture or one implied by a bundled descendant) so the resolver's walk
  //       over intermediate dirs short-circuits without touching disk
  //     - normalModuleFactory.hooks.beforeResolve: an in-scope (issuer, request)
  //       edge the bundle attests is redirected to its absolute bundle path. A
  //       request the bundle records no edge for is not a file the bundle carries
  //       -- at a successful capture it was EXTERNALIZED (a Node built-in,
  //       `electron` under an electron target, a user `externals` entry); those
  //       are never recorded as edges, so we defer to webpack's resolver/externals
  //       handling. This relaxes only the resolve-time EDGE lookup; the fail-closed
  //       gate for in-scope file BYTES stays the inputFileSystem wrapper above,
  //       which still serves every in-scope read from the bundle or throws.
  //     - Out-of-scope paths defer to disk
  //
  //   KNOWN LIMITATION: every path the resolver touches must be attested by some
  //   family bundle. Intermediate-directory stats are covered (getFsStat over the
  //   family, including dirs implied by a parent-bundle file -- e.g. a webpack
  //   loader's directory). The residual gap is the package.json files webpack's
  //   resolver reads via fs.readFile through DescriptionFilePlugin: the Node run
  //   loader captures modules Node IMPORTS, not arbitrary resolver fs.readFile
  //   calls, so a package.json neither bundle carries still fails closed here.
  //   Capturing those (or a description-file shortcut) is the remaining work; see
  //   `tests/webpack.test.js` and its skipped TODO.
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

    // The plugin's State may be a SIDECAR: when its bundleFile differs from the
    // ambient preload's, resolvePluginState (Rule 6) gives the plugin its own
    // State carrying the webpack app graph, parented to the ambient. The webpack
    // app graph lives in the sidecar's bundle, but build-time machinery the
    // resolver must see -- webpack loaders (babel-loader, ts-loader, ...) and the
    // directories/package.json along their resolution path -- lives in the PARENT
    // (ambient) bundle, captured when `stasis run` drove the build. Both bundles
    // validate against the SAME shared lockfile (the sidecar inherits the parent's
    // #lockImports/#lockFormats), so the attested set the build may touch is the
    // whole family: this State plus its parent. Consult them in order -- the
    // sidecar's own app graph first -- so a path either bundle attests is served
    // from the bundle that carries it. With no parent (the reuse case: one unified
    // bundle) the family is just `state`, and behavior is unchanged.
    const family = state.parent ? [state, state.parent] : [state]
    // The first family State that attests `url` (as a file or directory), else
    // undefined. getFsStat is a pure existence check over each bundle's recorded
    // files/resources/dirs; it never reads bytes or touches disk.
    const ownerOf = (url) => family.find((s) => s.getFsStat(url) !== undefined)

    // getFile re-verifies the hash against the lockfile on every read (tampered
    // bundle fails closed). Serve from whichever family bundle carries the path;
    // a path NO family bundle attests falls through to state.getFile, whose throw
    // is the canonical fail-closed gate -- an in-scope miss surfaces here, never
    // a silent disk fallback.
    const serveFromBundle = (p) => {
      const url = pathToFileURL(p).toString()
      return (ownerOf(url) ?? state).getFile(url).source
    }

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
        // A directory has no bundle content, so serveFromBundle/getFile (which only
        // attests files) throws "file not attested" on it. webpack's resolver stat()s
        // intermediate directories (`<root>`, `<root>/node_modules`, `.../<pkg>`) while
        // walking, so serve a directory Stats from the family's existence record
        // (getFsStat covers explicit `directory` captures AND dirs implied by a bundled
        // file under them -- e.g. `node_modules/<loader>` implied by the loader's files
        // in the PARENT bundle). This is what the async resolver tripped on; the sync
        // path happened to work only because the Proxy wraps stat but not statSync.
        const url = pathToFileURL(p).toString()
        if (ownerOf(url)?.getFsStat(url) === 'directory') {
          return callback(null, bundleStat(0, true))
        }
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
        // Out-of-scope parents (nm-scope app code, webpack-internal loader
        // resolution) were never the bundle's responsibility to attest -- defer
        // to webpack's resolver.
        if (!inScope(issuer)) return
        // Node built-ins (`constants`, `fs`, `node:path`, ...) are never bundled and
        // never recorded as edges: the capture-side resolve hook and CJS resolution
        // shim (stasis-core/hooks.js) short-circuit isBuiltin() specifiers to Node
        // before addImport sees them. Skip them up front -- defer to webpack
        // (target:'node' externalizes them, a browser target polyfills them) and,
        // crucially, NEVER consult getImport for a builtin name, so a tampered
        // bundle can't smuggle in an edge that redirects `fs` to an arbitrary file.
        if (isBuiltin(data.request)) return
        const parentURL = pathToFileURL(issuer).toString()
        let resolved
        try {
          resolved = state.getImport(parentURL, data.request)
        } catch (err) {
          // No attested edge. getImport tried the recorded edge under every conditions
          // bucket (resolveBundled), so a miss means the request names nothing the
          // bundle carries. At a SUCCESSFUL capture that is an EXTERNAL -- a module
          // webpack externalized instead of bundling: `electron` under an electron
          // target, anything the target's
          // externals preset covers, or a user `externals` entry. Externals are
          // never recorded as edges (afterResolve only records resolutions with an
          // on-disk path; see #applyCaptureMode), exactly like built-ins -- so defer
          // to webpack's resolver/externals handling rather than failing the build.
          // This relaxes ONLY the resolve-time edge lookup: a genuinely missing
          // in-scope FILE still fails closed at the inputFileSystem wrapper (it
          // serves in-scope bytes from the bundle or throws), so no disk fallback
          // is introduced. A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
          if (err?.code === 'ERR_MODULE_NOT_FOUND') return
          throw err
        }
        // Redirect the resolver to the absolute bundle path; our stat wrapper
        // then reports it exists, so the resolver short-circuits without
        // walking node_modules or trying extension fallbacks.
        data.request = fileURLToPath(resolved.url)
      })
    })
  }

  // babel-plugin-module-resolver is the babel plugin webpack-4 builds use to make
  // package.json "imports" subpaths resolvable: webpack 4's enhanced-resolve has no
  // imports-field support, so a '#app/abc.js' specifier MUST be rewritten in source
  // (to an importer-relative '../../abc.js') before webpack's parser sees it. That
  // rewrite happens in a LOADER, before the parser builds the dependency, so by
  // afterResolve webpack's rawRequest is the resolved relative path and the original
  // '#'-specifier is gone from every field. To record the ORIGINAL specifier as the
  // import key -- it's portable (resolves within the importer's OWN package regardless
  // of layout) and is what every other capture backend records (the Node loader's
  // resolve hook and Metro both key edges by the as-written specifier) -- hook the
  // rewrite at its source. The plugin has a single rewrite chokepoint that reads the
  // original `nodePath.node.value`, resolves it, then replaceWith()s the result;
  // across majors it is `lib/mapPath.js`'s default export (v5) or `lib/utils.js`'s
  // `mapPathString` (v3/v4). Wrap whichever the PROJECT'S copy exposes and record
  // (importer, rewritten) -> original for each '#'-rewrite; afterResolve then keys the
  // edge by the original instead of the resolved relative rawRequest.
  //
  // Best-effort and side-effect-only: a project without babel-plugin-module-resolver
  // (no '#'-rewriting in play) skips the patch entirely and capture is unchanged. The
  // wrapper is a transparent passthrough -- it never alters the rewrite, only observes
  // it -- so leaving it installed across watch rebuilds is harmless; PATCHED guards
  // against re-wrapping. stasis-core takes no dependency on the package: it is located
  // via the project's own node_modules (createRequire) and absent-package errors are
  // swallowed.
  #patchModuleResolver() {
    const paths = [this.#state.root, process.cwd()]
    // No `"exports"` map in any major, so deep `/lib/...` requires resolve fine. Try the
    // v5 chokepoint first, then the v3/v4 one; wrap every shape the copy actually exposes
    // (a stale-but-uninvoked export is never called, so a double-wrap can't double-record).
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
          // Only package.json "imports" subpaths ('#'-prefixed) are recovered; any other
          // module-resolver alias keeps webpack's rawRequest. A node that didn't actually
          // change (after === before) records nothing.
          if (typeof before === 'string' && before.startsWith('#') &&
              typeof after === 'string' && after !== before) {
            const importer = state?.file?.opts?.filename
            if (typeof importer === 'string') {
              // Append, don't overwrite: two distinct subpath aliases that resolve to the same
              // file from this importer rewrite to the identical `after`, so they share one key.
              // Keeping both (deduped) lets afterResolve record an edge for each.
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
    // Count compilers this instance drives (final by the first `done`; see the field comment).
    this.#captureApplyCount += 1
    // Install the babel-plugin-module-resolver hook before the build runs (apply() is
    // called synchronously at webpack() construction, before compiler.run()), so the
    // recorder is populated by the loader pass before afterResolve looks an edge up.
    this.#patchModuleResolver()
    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      // webpack 4's resolver reuses `resourceResolveData.context.issuer` across
      // factory invocations -- by the time `afterResolve` fires for a given
      // dependency, that field can hold the issuer from an EARLIER resolution.
      // The resolved path (rrd.path) is still correct, so webpack's bundle is
      // fine, but a plugin reading rrd.context.issuer for parent attribution
      // would mis-bucket the edge. Reproduced under webpack@4.15.1 and 4.47.0
      // (see tests/fixtures/webpack-stale-issuer-repro/NOTES.md for the
      // BEFORE-vs-AFTER trace evidence).
      //
      // beforeResolve's `data.contextInfo.issuer` is the fresh value passed
      // into create() for this exact dependency, so capture it there keyed
      // by the dependency object and look it up in afterResolve. The same
      // `data.dependencies[0]` reference flows through the create() pipeline
      // unchanged (NormalModuleFactory passes the array through to factory()
      // -> resolver -> afterResolve), so a WeakMap keyed on dep[0] keeps the
      // mapping correct without holding refs after the dep is GC'd.
      const issuerByDep = new WeakMap()
      nmf.hooks.beforeResolve.tap('Stasis', (data) => {
        const dep = data?.dependencies?.[0]
        const issuer = data?.contextInfo?.issuer
        if (dep && issuer) issuerByDep.set(dep, issuer)
      })

      nmf.hooks.afterResolve.tap('Stasis', (data) => {
        // Cross-version field unwrap: webpack 5 wraps `rawRequest` and
        // `resourceResolveData` inside `data.createData` (the bundle of fields
        // that will populate the NormalModule), whereas webpack 4 hangs them off
        // `data` directly. Same field names underneath, just one level of
        // indirection -- fall through to `data` when `createData` is absent so
        // both shapes flow through the same code path below.
        const cd = data.createData ?? data
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
        // Issuer attribution -- tier the sources from most reliable to least:
        //   1. beforeResolve-captured value (works on both webpack 4 and 5;
        //      necessary on webpack 4 to dodge the stale rrd.context.issuer bug)
        //   2. data.contextInfo.issuer (fresh in webpack 5's afterResolve, often
        //      undefined in webpack 4's, but harmless when set)
        //   3. createData.resourceResolveData.context.issuer (webpack 4 only --
        //      enhanced-resolve 5 removed `context.issuer` from ResolveRequest, so
        //      tier 3 is structurally dead under webpack 5. Kept as a defensive
        //      last resort for any stacked plugin that reached afterResolve
        //      without firing beforeResolve on webpack 4.)
        const dep = data?.dependencies?.[0]
        const issuer = (dep && issuerByDep.get(dep))
          ?? data.contextInfo?.issuer
          ?? cd.resourceResolveData?.context?.issuer
        const isEntry = !issuer
        const rawRequest = cd.rawRequest ?? data.rawRequest

        if (kind === 'code' && !isEntry) {
          const issuerAbsolute = path.resolve(issuer)
          const parentURL = pathToFileURL(issuerAbsolute).toString()
          // When babel-plugin-module-resolver rewrote one or more package.json "imports"
          // subpaths ('#app/abc.js') into this resolved-relative rawRequest, the monkey-patch
          // (#patchModuleResolver) recorded the original specifier(s) for this exact
          // (importer, rewritten-request) edge. Key the edge by each ORIGINAL instead of the
          // position-coupled relative path: it round-trips at load (where the same subpath
          // reaches beforeResolve) and activates state.js's resolveBundled '#'-handling. Several
          // aliases can collapse onto one rawRequest, so record an edge per original. No rewrite
          // seen -> fall back to webpack's rawRequest unchanged.
          const originals = subpathOriginals.get(edgeKey(issuerAbsolute, rawRequest))
          for (const specifier of originals ?? [rawRequest]) {
            this.#state.addImport(parentURL, specifier, url)
          }
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          // Read through the REAL reader: this capture read is the plugin's own bookkeeping,
          // not a program fs read, so under `stasis run --fs` it must not be recorded into
          // the preload/main bundle (it belongs to THIS plugin's bundle). See state-util.js.
          const source = realReadFileSync(filePath)
          // Code-classified files must be UTF-8. A code extension with non-UTF-8
          // bytes is malformed input (e.g. a .json mis-saved as UTF-16); refuse
          // it rather than silently encoding it as a resource. Resource-classified
          // files are passed through as-is -- State picks 'resource' vs
          // 'resource:base64' from content.
          if (kind === 'code') {
            assert.ok(isUtf8(source), `StasisWebpack: code-classified file has non-UTF-8 bytes: ${filePath}`)
          }
          this.#state.addFile(url, { source, isEntry, resource: kind === 'resource', reason: 'StasisWebpack' })
        }
      })
    })

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them when the
    // compiler finishes -- but only on a clean build. A failed compilation has incomplete
    // state, and lock=replace would otherwise overwrite a good lockfile with a partial one.
    if (this.#state !== State.preload) {
      // Watch-mode detection. compiler.hooks.watchRun fires ONLY under compiler.watch() (both
      // webpack 4 and 5) and always before that build's `done`, so the flag is set in time.
      // The flag is per-compiler (this closure), which is what we want: each compiler reports
      // its own run kind even when one shared plugin instance drives several.
      let watching = false
      compiler.hooks.watchRun.tap('Stasis', () => { watching = true })
      compiler.hooks.done.tap('Stasis', (stats) => {
        if (stats.hasErrors()) return
        // Write immediately when the bundle cannot grow across `done`s:
        //   - watch mode: a watcher keeps the event loop alive, so a deferred flush would never
        //     fire; per-rebuild freshness is the point, and State.write's compare-and-skip keeps
        //     an unchanged rebuild a ~no-op; and
        //   - a single compiler: only one `done`, so there is no N-write amplification and no
        //     reason to give up the old write-by-`done` durability (the bundle is on disk by the
        //     time compiler.run()'s callback resolves).
        // Defer ONLY the multi-compiler one-shot case. compiler.hooks.done fires once PER CHILD
        // COMPILER, so a MultiCompiler with N targets sharing this one State's growing bundle
        // would otherwise pay N brotli + writeFileSync passes over an ever-larger payload (the
        // dominant, super-linear cost). Deferral collapses those into ONE write of the final
        // bundle at process exit -- mirroring how the preload writes (hooks.js). esbuild / metro
        // are deliberately NOT changed: their write hook fires once per build (no per-child
        // amplification), and stasis build reads esbuild output in-process, so their synchronous
        // write is load-bearing in a way webpack's per-child `done` write is not.
        if (watching || this.#captureApplyCount === 1) this.#state.write()
        else this.#deferWrite()
      })
    }
  }

  // Mark the State dirty and ensure a single end-of-process flush is registered, so a
  // MultiCompiler's per-child-compiler `done` events coalesce into one write of the final
  // bundle rather than re-serializing + brotli-compressing (quality 11, super-linear in size)
  // an ever-growing bundle on every target's completion.
  //
  // KNOWN LIMITATION: the flush runs at process exit, so a multi-compiler one-shot build inside
  // a process that never exits normally -- one that stays alive after building and is then
  // killed by a signal (SIGINT/SIGTERM/SIGKILL), which bypass both beforeExit and exit -- would
  // not flush. That is the same capture-then-exit assumption the preload already relies on
  // (hooks.js) and metro documents; the common build-and-exit and watch (`--watch`, dev-server)
  // flows are unaffected, and a single-compiler build never reaches here (it writes on `done`).
  #deferWrite() {
    this.#deferredWriteDirty = true
    if (this.#deferredWriteArmed) return
    this.#deferredWriteArmed = true
    const flush = () => {
      if (!this.#deferredWriteDirty) return  // already flushed; the exit backstop is then a no-op
      this.#state.write()                    // synchronous; if it throws, dirty stays set so the
      this.#deferredWriteDirty = false       // exit backstop retries -- clear ONLY after success
    }
    // beforeExit handles the natural event-loop drain; exit is the synchronous backstop for an
    // explicit process.exit(). state.write() is fully synchronous (writeFileSync/brotliCompressSync),
    // so it is safe in the exit handler, and the dirty guard makes the second of the two a no-op.
    process.on('beforeExit', flush)
    process.on('exit', flush)
  }
}
