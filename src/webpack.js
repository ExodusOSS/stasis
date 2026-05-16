import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from './state.js'
import { assertOptionsMatchConfig, validatePluginOptions } from './config.js'

export class StasisWebpack {
  #seen = new Set()
  #state

  constructor(options = {}) {
    validatePluginOptions('StasisWebpack', options)
    if (State.instance) {
      assertOptionsMatchConfig(State.instance.config, options)
      this.#state = State.instance
    } else {
      this.#state = new State(process.cwd(), options)
    }
  }

  apply(compiler) {
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
  }
}
