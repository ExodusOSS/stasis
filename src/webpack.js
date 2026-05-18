import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { State, resolvePluginState } from './state.js'

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
        assert.equal(data.resource, data.resourceResolveData.path)
        const filePath = path.resolve(data.resource)
        const url = pathToFileURL(filePath).toString()
        const issuer = data.resourceResolveData.context?.issuer
        const isEntry = !issuer

        if (!isEntry) {
          const parentURL = pathToFileURL(path.resolve(issuer)).toString()
          this.#state.addImport(parentURL, data.rawRequest, url)
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          this.#state.addFile(url, { isEntry })
        }
      })
    })

    // The stasis preload owns its own write via beforeExit/exit hooks (src/loader.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them when
    // the compiler is done -- otherwise sidecar bundles never reach disk.
    if (this.#state !== State.preload) {
      compiler.hooks.done.tap('Stasis', () => {
        this.#state.write()
      })
    }
  }
}
