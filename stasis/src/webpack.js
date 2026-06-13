import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { State, isTrackedPath, resolvePluginState } from '@exodus/stasis-core/state'

export class StasisWebpack {
  #seen = new Set()
  #state

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisWebpack', options, process.cwd())
    this.#state = state  // null when plugin should be inert
  }

  apply(compiler) {
    if (!this.#state) return
    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      nmf.hooks.afterResolve.tap('Stasis', (data) => {
        // resourceResolveData.path is the resolved on-disk path without query/fragment;
        // data.resource may carry a `?query` (inline-loader, asset import suffixes) or
        // be a synthetic resource (data:, null-loader). We track the resolved file only.
        const filePath = data.resourceResolveData?.path
        if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) return
        // Untracked extensions (.css, .png, .wasm, asset modules, ...) don't go in the
        // lockfile -- the loader can't load them as JS anyway and bundle=load has no path
        // to round-trip them. Webpack handles them with its own loaders / asset modules.
        if (!isTrackedPath(filePath)) return
        const url = pathToFileURL(filePath).toString()
        const issuer = data.resourceResolveData.context?.issuer
        const isEntry = !issuer

        if (!isEntry) {
          const parentURL = pathToFileURL(path.resolve(issuer)).toString()
          this.#state.addImport(parentURL, data.rawRequest, url)
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          // Tracked extensions are text formats; read + sniff in case a JSON-with-BOM or
          // similar edge case slipped past the extension filter.
          const source = readFileSync(filePath)
          const binary = !isUtf8(source)
          this.#state.addFile(url, { source, isEntry, isBinary: binary })
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
