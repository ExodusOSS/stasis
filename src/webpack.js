import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from './state.js'

const state = State.instance
assert.ok(state, 'Stasis preload is not active')

export class StasisWebpack {
  #seen = new Set()

  constructor(options) {
    assert.equal(options, undefined, 'No options expected')
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
          state.addImport(parentURL, data.rawRequest, url)
        }

        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          state.addFile(url, { isEntry })
        }
      })
    })
  }
}
