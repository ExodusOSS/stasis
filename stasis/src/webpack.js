import assert from 'node:assert'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

const state = State.instance
assert.ok(state, 'Stasis preload is not active')

// Webpack plugin interface
export class StasisWebpack {
  #seen = new Set()

  constructor(options) {
    assert.equal(options, undefined, 'No options expected')
  }

  apply(compiler) {
    compiler.plugin('normal-module-factory', (nmf) => {
      nmf.plugin('after-resolve', (data, callback) => {
        assert(data.resource === data.resourceResolveData.path)
        const filePath = path.resolve(data.resource) // resolve just in case, don't remove

        // TODO: record resolutions
        /*
        const meta = {
          resource: data.resource,
          source: data.resourceResolveData.context.issuer,
          query: data.rawRequest,
          // Note: data.userRequest is different and can contain loader prefixes
          moduleName: data.resourceResolveData.descriptionFileData.name,
          modulePackage: data.resourceResolveData.descriptionFilePath,
        }

        console.log(meta)
        //state.addImport(parentURL, specifier, url, { conditions: 'webpack ...', format })
        */

        if (!this.#seen.has(filePath)) {
          state.addFile(pathToFileURL(filePath).toString())
          this.#seen.add(filePath)
        }

        return callback(null, data)
      })
    })
  }
}
