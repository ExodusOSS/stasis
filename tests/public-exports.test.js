import { test } from 'node:test'

import { Bundle } from '@exodus/stasis/bundle'
import { Lockfile } from '@exodus/stasis/lockfile'

test('@exodus/stasis/bundle exports Bundle class', (t) => {
  t.assert.equal(typeof Bundle, 'function')
  t.assert.equal(Bundle.VERSION, 0)
})

test('@exodus/stasis/lockfile exports Lockfile class', (t) => {
  t.assert.equal(typeof Lockfile, 'function')
  t.assert.equal(Lockfile.VERSION, 0)
})

test('Lockfile round-trip preserves structure', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: {
      '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } },
    },
    modules: {
      'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } },
    },
  })
  const first = Lockfile.parse(text).serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
})

test('Bundle.serializeCode round-trip preserves sources, formats, imports', (t) => {
  const bundle = new Bundle({ config: { scope: 'full' } })
  bundle.sources.set('src/a.js', 'export const x = 1\n')
  bundle.formats.set('src/a.js', 'module')
  bundle.imports.set('*', new Map([['src/a.js', new Map([['./b.js', 'src/b.js']])]]))

  const buf = bundle.serializeCode()
  const parsed = Bundle.parseCode(buf)

  t.assert.equal(parsed.sources.get('src/a.js'), 'export const x = 1\n')
  t.assert.equal(parsed.formats.get('src/a.js'), 'module')
  t.assert.equal(parsed.imports.get('*').get('src/a.js').get('./b.js'), 'src/b.js')
})

test('Bundle.serializeResources round-trip', (t) => {
  const bundle = new Bundle()
  bundle.resources.set('node_modules/foo/asset.bin', Buffer.from('hello').toString('base64'))

  const buf = bundle.serializeResources()
  const parsed = Bundle.parseResources(buf)

  t.assert.equal(parsed.resources.get('node_modules/foo/asset.bin'), Buffer.from('hello').toString('base64'))
})
