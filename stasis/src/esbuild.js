import { readFile } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State } from '@exodus/stasis-core/state'

const state = State.instance
assert.ok(state, 'Stasis preload is not active')

export class StasisEsbuild {
  #seen = new Set()

  get name() {
    return 'stasis'
  }

  setup = ({ onResolve, onLoad, resolve }) => {
    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, ...args }) => {
      // Recurse with a synthetic namespace so esbuild's default resolver runs without re-entering us
      const res = await resolve(specifier, { ...args, namespace: 'stasis' })
      if (res.errors.length > 0) return res
      assert.equal(res.warnings.length, 0)
      assert.equal(res.suffix, '')

      const isEntry = !args.importer
      if (res.namespace === 'file' && !res.external) {
        if (!isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          state.addImport(parentURL, specifier, url)
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      assert.equal(Object.keys(attrs).length, 0) // TODO: 'with' statements
      const source = await readFile(path)
      const isBinary = !isUtf8(source)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, isBinary })
      }

      if (isBinary) return { contents: source, loader: 'binary' }

      const loader = extname(path).replace(/^\.[cm]?/, '')
      assert(['js', 'ts', 'jsx', 'tsx', 'json'].includes(loader))
      return { contents: source, loader }
    })
  }
}
