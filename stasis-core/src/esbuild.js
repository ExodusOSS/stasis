import { isUtf8 } from 'node:buffer'
import { isBuiltin } from 'node:module'
import { extname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from './bundle.js'
import { resolvePluginState } from './plugins.js'
import { State } from './state.js'
// Pre-patch snapshot, NOT `import { readFile } from 'node:fs/promises'`: under
// `stasis run --fs=async` that builtin is monkey-patched, and this plugin loads after
// the patch, so a direct import would route esbuild's own source reads through the
// --fs capture hook. The snapshot in state-util (taken during the --import preload) is
// the genuine reader.
import { realReadFile } from './state-util.js'
import { classifyExtension } from './util.js'

export class StasisEsbuild {
  #seen = new Set()
  #state
  #resources

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisEsbuild', options, process.cwd())
    this.#state = state  // null when plugin should be inert
    // resources is a Config field now (validated + coordinated against any preload in
    // resolvePluginState); cache the resolved Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  get name() {
    return 'stasis'
  }

  setup = ({ onResolve, onLoad, onEnd, resolve }) => {
    if (!this.#state) return  // noop plugin

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them when the
    // build finishes -- but only on a clean build, otherwise a partial bundle/lockfile
    // would overwrite the user's good file.
    if (this.#state !== State.preload) {
      onEnd((result) => {
        if (result.errors.length > 0) return
        this.#state.write()
      })
    }

    // Load mode: resolution comes from the bundle's import map, not esbuild's
    // resolver. The on-disk file may not even exist -- the bundle is the source
    // of truth (mirrors `stasis run --bundle=load`; see stasis-core/src/hooks.js).
    // We keep `namespace: 'file'` with the original absolute path, even though the
    // file isn't on disk: esbuild stats the path only when its own default resolver
    // produced it; paths returned from a plugin's onResolve are trusted as-is. That
    // gives the same output bytes as a capture-mode build -- esbuild's path-banner
    // comments, asset names, and source maps all use the original paths.
    onResolve({ filter: /$/ }, ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
      if (!this.#state.config.loadBundle) return undefined
      // Node built-ins (`constants`, `node:fs`, ...) are never carried in the bundle
      // and never recorded as import edges -- the capture side (and the Node run
      // loader, stasis-core/hooks.js) defer isBuiltin() specifiers before addImport
      // sees them. Returning undefined hands the builtin back to esbuild's own
      // resolution, which externalizes it under platform:'node' exactly as in a build
      // without this plugin; state.getImport would instead throw ERR_MODULE_NOT_FOUND
      // ("Cannot find module 'constants' imported from <file>"). Mirrors the webpack
      // plugin's load-mode builtin guard.
      if (isBuiltin(specifier)) return undefined
      const isEntry = resolveKind === 'entry-point'
      let url
      if (isEntry) {
        // esbuild's entryPoints are typically absolute, but a bare/relative entry
        // is anchored to cwd just like the run loader does (resolvePath(cwd, ...))
        // so the entry file doesn't need to be on disk.
        url = specifier.startsWith('file:')
          ? specifier
          : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
        if (this.#state.config.full) this.#state.assertEntry(url)
      } else {
        const parentURL = pathToFileURL(importer).toString()
        // Forward import attributes (e.g. `with { type: 'json' }`) so a
        // plugin-captured bundle round-trips to plugin-load symmetrically: both
        // sides key the edge under `* (with: ...)` (no conditions because the
        // plugin doesn't know them). KNOWN GAP: a bundle captured by the Node
        // run loader keys edges under specific conditions like `node, import,
        // ... (with: ...)`; the plugin's `*`-keyed lookup misses that, and the
        // wildcard fallback in state.getImport only falls back to `*` (without
        // attrs), so a Node-loader-captured bundle with attributed imports
        // won't reload via the esbuild plugin without further work
        // (state.getImport would need a multi-conditions match scan, or the
        // Node loader would need to mirror under '*' too).
        try {
          ;({ url } = this.#state.getImport(parentURL, specifier, { importAttributes: attrs }))
        } catch (err) {
          // No attested edge. getImport already tried the recorded edges AND the
          // under-recorded bundle-file-set fallback (resolveBundled), so a miss
          // means the request names nothing the bundle carries -- at a successful
          // capture it was an EXTERNAL (a user `external` entry; built-ins are
          // handled above). Externals are never recorded as edges, so return
          // undefined to hand it back to esbuild, which externalizes it as it would
          // without this plugin. This relaxes only the resolve-time edge lookup:
          // a genuinely missing in-scope FILE still fails closed at onLoad
          // (state.getFile serves in-scope bytes from the bundle or throws), so no
          // disk fallback is introduced. A non-MODULE_NOT_FOUND error is a real
          // fault -- rethrow it.
          if (err?.code === 'ERR_MODULE_NOT_FOUND') return undefined
          throw err
        }
      }
      const format = this.#state.getFormat(url)
      const kind = Bundle.isResourceFormat(format) ? 'resource' : 'code'
      return { path: fileURLToPath(url), namespace: 'file', pluginData: { isEntry, kind } }
    })

    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, with: attrs, ...args }) => {
      const isEntry = !args.importer

      // Recurse with a synthetic namespace so esbuild's default resolver runs without re-entering us
      const res = await resolve(specifier, { ...args, with: attrs, namespace: 'stasis' })
      if (res.errors.length > 0) return res
      // Warnings from sibling plugins or esbuild itself (deprecation notices, etc.) are
      // not our concern -- propagate them upward, don't crash.
      // A non-empty `suffix` is set by sibling plugins that want to preserve a
      // query-style suffix on the resolved path (some CSS-modules plugins do).
      // stasis doesn't know how to persist suffixes to the bundle, so we refuse
      // them explicitly rather than silently dropping the suffix at capture time.
      assert.equal(res.suffix, '',
        `StasisEsbuild: a sibling plugin set res.suffix='${res.suffix}' on '${specifier}'; ` +
        `stasis can't persist suffixes to the bundle. Disable that plugin or drop suffix from its resolve result.`)

      let kind = 'skip'
      if (res.namespace === 'file' && !res.external) {
        kind = classifyExtension(res.path, this.#resources)
        if (kind === 'unknown') {
          return {
            errors: [{
              text: `StasisEsbuild: unsupported extension for '${res.path}' -- add its extension or filename to the plugin's resources option or stop importing it`,
            }],
          }
        }
        if (kind === 'code' && !isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          // Forward import attributes (e.g. `with { type: 'json' }`) symmetrically
          // with the load path: addImport stores under a conditions-with-attributes
          // key when attributes are present, so getImport at load time can find
          // the same edge.
          this.#state.addImport(parentURL, specifier, url, { importAttributes: attrs })
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry, kind } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      const kind = pluginData?.kind ?? 'skip'
      if (kind === 'skip') return undefined
      // Accept the `type` import attribute (e.g. `with { type: 'json' }`); reject
      // anything else loudly since saving import-attribute state to the lockfile
      // isn't designed yet.
      for (const k of Object.keys(attrs)) {
        assert.equal(k, 'type', `unsupported import attribute: ${k}`)
      }

      // Load mode: serve bytes the bundle attested. `getFile` verifies the hash
      // against the lockfile (when one is loaded), and throws on a file the
      // bundle doesn't carry -- a missing in-scope file is a hard error, not a
      // silent disk fallback. Resources return `{ contents }` only; esbuild's
      // loader config (file/dataurl/copy/...) interprets and emits them by
      // extension, the same way capture mode lets esbuild's loader machinery
      // handle resource emission.
      if (this.#state.config.loadBundle) {
        const { source } = this.#state.getFile(pathToFileURL(path).toString())
        if (kind === 'resource') return { contents: source }
        const loader = extname(path).replace(/^\.[cm]?/, '')
        return { contents: source, loader }
      }

      const source = await realReadFile(path)

      if (kind === 'resource') {
        // Mark this file as a resource. State picks the encoding from its bytes:
        // 'resource' (raw UTF-8 -- e.g. SVG stays human-readable in the bundle)
        // for valid UTF-8 content, 'resource:base64' for binary. We do NOT return
        // contents/loader: emission is esbuild's job via the build's own `loader`
        // config (file, dataurl, copy, ...), the same way webpack's file-loader
        // runs independently of stasis's afterResolve hook. An asset with no
        // configured loader errors in esbuild, which
        // is the user's responsibility (symmetric with file-loader being required).
        if (!this.#seen.has(path)) {
          this.#seen.add(path)
          this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, resource: true })
        }
        return undefined
      }

      // Code-classified files must be UTF-8. A code extension with non-UTF-8 bytes
      // is malformed input (e.g. a .json mis-saved as UTF-16); refuse it rather
      // than silently encoding it as a resource and hiding the underlying problem.
      assert.ok(isUtf8(source), `StasisEsbuild: code-classified file has non-UTF-8 bytes: ${path}`)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry })
      }

      // .cjs/.mjs/.cts/.mts strip to 'js'/'ts' via the leading-letter peel; the other
      // code extensions map 1:1 to esbuild's loader names.
      const loader = extname(path).replace(/^\.[cm]?/, '')
      return { contents: source, loader }
    })
  }
}
