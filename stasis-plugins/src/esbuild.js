import { isUtf8 } from 'node:buffer'
import { isBuiltin } from 'node:module'
import { extname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from '@exodus/stasis-core/bundle'
import { resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route esbuild's reads through the capture hook.
import { realReadFile } from '@exodus/stasis-core/state-util'
import { classifyExtension } from '@exodus/stasis-core/util'

export class StasisEsbuild {
  #seen = new Set()
  #state
  #resources
  #loaders

  // Build starts observed by this instance (across rebuilds and separate build()/context() calls);
  // the second is refused in onStart.
  #captureBuildCount = 0

  constructor(options = {}, { loaders } = {}) {
    // A caller that owns a State (e.g. `stasis build`) can pass it directly; a foreign-copy State
    // fails closed via the instanceof miss.
    const state = options instanceof State
      ? options
      : resolvePluginState('StasisEsbuild', options, process.cwd()).state
    this.#state = state  // null when plugin should be inert
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
    // Per-extension esbuild loader overrides (e.g. { '.js' -> 'jsx' } for RN's JSX-in-.js),
    // keyed by extname with the dot; falls back to #loaderFor.
    this.#loaders = loaders ?? new Map()
  }

  // esbuild loader for a served file: configured override, else derived from extension
  // (.cjs/.mjs/.cts/.mts strip their module letter to js/ts).
  #loaderFor(path) {
    const ext = extname(path)
    return this.#loaders.get(ext) ?? ext.replace(/^\.[cm]?/u, '')
  }

  get name() {
    return 'stasis'
  }

  setup = ({ onResolve, onLoad, onStart, onEnd, resolve, initialOptions }) => {
    if (!this.#state) return  // noop plugin

    // Watch/rebuild capture is unsupported: dedupe is keyed by PATH not content, so a rebuild with
    // changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Rebuilds re-fire
    // onStart against the same registrations, so an instance counter catches the second and errors.
    if (!this.#state.config.loadBundle) {
      onStart(() => {
        this.#captureBuildCount += 1
        if (this.#captureBuildCount === 1) return undefined
        return {
          errors: [{
            text: 'StasisEsbuild: watch/rebuild is not supported for capture -- run a one-shot build (rebuilds would silently attest stale content)',
          }],
        }
      })
    }

    // The preload writes itself (hooks.js); standalone/sidecar States are written on build finish --
    // only on a clean build (a partial one would overwrite the user's good file).
    if (this.#state !== State.preload) {
      onEnd((result) => {
        if (result.errors.length > 0) return
        this.#state.write()
      })
    }

    // Load mode: resolution comes from the bundle's import map, not esbuild's resolver -- the file
    // may not be on disk. Keep namespace:'file' with the original absolute path (esbuild doesn't stat
    // plugin-returned paths) so output bytes -- banners, asset names, source maps -- match a capture build.
    onResolve({ filter: /$/ }, ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
      if (!this.#state.config.loadBundle) return undefined
      // Built-ins are never bundled or recorded as edges; hand them back to esbuild (undefined)
      // so it externalizes under platform:'node', rather than getImport throwing ERR_MODULE_NOT_FOUND.
      if (isBuiltin(specifier)) return undefined
      const isEntry = resolveKind === 'entry-point'
      let url
      if (isEntry) {
        // Bare/relative entries are anchored to cwd (like the run loader), so the file needn't be on disk.
        url = specifier.startsWith('file:')
          ? specifier
          : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
        if (this.#state.config.full) this.#state.assertEntry(url)
      } else {
        const parentURL = pathToFileURL(importer).toString()
        // Forward import attributes (`with { type: 'json' }`) so plugin-capture round-trips to
        // plugin-load, both keyed under `* (with: ...)`. KNOWN GAP: a Node-loader-captured bundle
        // keys attributed edges under specific conditions the plugin's `*` lookup won't match.
        try {
          ;({ url } = this.#state.getImport(parentURL, specifier, { importAttributes: attrs }))
        } catch (err) {
          // No attested edge -- at a successful capture that's an EXTERNAL (never recorded as an
          // edge), so hand it back to esbuild. File BYTES still fail closed at onLoad.
          // A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
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
      // A non-empty `suffix` (some CSS-modules plugins set one) can't be persisted to the bundle,
      // so refuse it rather than silently dropping it at capture.
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
        // Record the edge for BOTH code and resource targets (never entries): load mode resolves
        // every specifier through this map, so a resource with no edge would miss at bundle=load and
        // fall through to esbuild's disk resolver -- serving the asset UNATTESTED. kind is code|resource here.
        if (!isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          // Forward import attributes symmetrically with load: addImport keys by attributes so
          // getImport finds the same edge.
          this.#state.addImport(parentURL, specifier, url, { importAttributes: attrs })
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry, kind } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      const kind = pluginData?.kind ?? 'skip'
      if (kind === 'skip') return undefined
      // Accept only the `type` import attribute; other attributes aren't persistable to the lockfile yet.
      for (const k of Object.keys(attrs)) {
        assert.equal(k, 'type', `unsupported import attribute: ${k}`)
      }

      // Load mode: serve bytes the bundle attested. getFile verifies the hash and throws on a file
      // the bundle doesn't carry -- a missing in-scope file is a hard error, not a disk fallback.
      if (this.#state.config.loadBundle) {
        const { source } = this.#state.getFile(pathToFileURL(path).toString())
        if (kind === 'resource') {
          // Plugin-provided contents with no `loader` default to `js` (esbuild applies the build's
          // per-extension loader only on its own load path), so replay the configured loader from
          // initialOptions.loader. No configured loader fails symmetrically with a capture build.
          const loader = initialOptions.loader?.[extname(path)]
          return loader ? { contents: source, loader } : { contents: source }
        }
        return { contents: source, loader: this.#loaderFor(path) }
      }

      const source = await realReadFile(path)

      if (kind === 'resource') {
        // Mark as a resource (State picks 'resource' vs 'resource:base64' from bytes). Return no
        // contents/loader: emission is esbuild's job via the build's own `loader` config.
        if (!this.#seen.has(path)) {
          this.#seen.add(path)
          this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, resource: true, reason: 'StasisEsbuild' })
        }
        return undefined
      }

      // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
      assert.ok(isUtf8(source), `StasisEsbuild: code-classified file has non-UTF-8 bytes: ${path}`)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, reason: 'StasisEsbuild' })
      }

      return { contents: source, loader: this.#loaderFor(path) }
    })
  }
}
