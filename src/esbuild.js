import { readFile } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { extname } from 'node:path'
import assert from 'node:assert/strict'

// TODO

export class StasisEsbuild {
  get name() {
    return 'stasis'
  }

  setup({ onResolve, onLoad, resolve }) {
    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, ...args }) => {
      const res = await resolve(specifier, { ...args, namespace: 'stasis' })
      assert.equal(res.errors.length, 0)
      assert.equal(res.warnings.length, 0)
      assert.equal(res.suffix, '')
      assert.equal(res.pluginData, undefined)
      const { path, errors, warnings, suffix, pluginData, ...meta } = res
      console.debug({ errors, warnings, suffix, pluginData })
      console.log('resolve', specifier, path, meta)
      return res
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, ...args }) => {
      console.log('load', path, args)
      const source = await readFile(path)
      assert.ok(isUtf8(source))
      assert.equal(Object.keys(args.with).length, 0) // TODO: 'with' statements
      const loader = extname(path).replace(/^\.[cm]?/, '')
      assert(['js', 'ts', 'jsx', 'tsx'].includes(loader))
      return { contents: source, loader }
    })
  }
}
