import { readFile } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State, resolvePluginState } from './state.js'

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

    // The stasis preload owns its own write via beforeExit/exit hooks (src/loader.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them when
    // the build finishes -- but only on a clean build, otherwise a partial bundle/
    // lockfile would overwrite the user's good file.
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
      if (res.namespace === 'file' && !res.external) {
        if (!isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          this.#state.addImport(parentURL, specifier, url)
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      // Accept any standard JS import attribute that doesn't change the loaded bytes; we
      // currently only encounter `type` (e.g. `with { type: 'json' }`). Reject anything
      // else loudly since saving import-attribute state to the lockfile isn't designed yet.
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

      // Map common extensions to known esbuild loaders; fall back to 'default' so esbuild
      // can pick based on its own extension config rather than crash. .cjs/.mjs get the
      // js loader via the leading-letter strip; everything unknown -> 'default'.
      const ext = extname(path).replace(/^\.[cm]?/, '')
      const KNOWN = new Set(['js', 'ts', 'jsx', 'tsx', 'json', 'css', 'text'])
      const loader = KNOWN.has(ext) ? ext : 'default'
      return { contents: source, loader }
    })
  }
}
