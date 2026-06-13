import { readFile } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State, isTrackedPath, resolvePluginState } from '@exodus/stasis-core/state'

export class StasisEsbuild {
  #seen = new Set()
  #state

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisEsbuild', options, process.cwd())
    this.#state = state  // null when plugin should be inert
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

    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, ...args }) => {
      // Recurse with a synthetic namespace so esbuild's default resolver runs without re-entering us
      const res = await resolve(specifier, { ...args, namespace: 'stasis' })
      if (res.errors.length > 0) return res
      // Warnings from sibling plugins or esbuild itself (deprecation notices, etc.) are
      // not our concern -- propagate them upward, don't crash.
      assert.equal(res.suffix, '')

      const isEntry = !args.importer
      // Untracked extensions (.css, .wasm, asset modules, ...) skip addImport/addFile --
      // the lockfile can't attest formats outside js/ts/json, so widening here would
      // record bytes that bundle=load could never round-trip.
      const tracked = isTrackedPath(res.path)
      if (res.namespace === 'file' && !res.external && tracked) {
        if (!isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          this.#state.addImport(parentURL, specifier, url)
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry, tracked } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      // Untracked extensions fall through to esbuild's default load handling -- we
      // don't attest to them.
      if (!pluginData?.tracked) return undefined
      // Accept the `type` import attribute (e.g. `with { type: 'json' }`); reject
      // anything else loudly since saving import-attribute state to the lockfile
      // isn't designed yet.
      for (const k of Object.keys(attrs)) {
        assert.equal(k, 'type', `unsupported import attribute: ${k}`)
      }
      const source = await readFile(path)
      const isBinary = !isUtf8(source)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, isBinary })
      }

      if (isBinary) return { contents: source, loader: 'binary' }

      // .cjs/.mjs/.cts/.mts strip to 'js'/'ts' via the leading-letter peel; the other
      // tracked extensions map 1:1 to esbuild's loader names.
      const loader = extname(path).replace(/^\.[cm]?/, '')
      return { contents: source, loader }
    })
  }
}
