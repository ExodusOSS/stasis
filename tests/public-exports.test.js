import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis/bundle'
import { Lockfile } from '@exodus/stasis/lockfile'

test('@exodus/stasis/bundle exports Bundle class', (t) => {
  t.assert.equal(typeof Bundle, 'function')
  t.assert.equal(Bundle.VERSION, 1)
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

test('Bundle.serializeCode round-trip preserves entries, modules, formats, imports', (t) => {
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/a.js']),
    modules: new Map([
      ['.', { name: 'x', version: '1.0.0', files: { 'src/a.js': 'export const x = 1\n' } }],
      ['node_modules/w', { name: 'w', version: '1.0.0', files: { 'i.js': 'export const y = 2\n' } }],
    ]),
    formats: new Map([['src/a.js', 'module']]),
    imports: new Map([['*', new Map([['src/a.js', new Map([['./b.js', 'src/b.js']])]])]]),
  })

  const buf = bundle.serializeCode()
  const parsed = Bundle.parseCode(buf)

  t.assert.deepEqual([...parsed.entries], ['src/a.js'])
  t.assert.equal(parsed.modules.get('.').name, 'x')
  t.assert.equal(parsed.modules.get('.').version, '1.0.0')
  t.assert.equal(parsed.modules.get('.').files['src/a.js'], 'export const x = 1\n')
  t.assert.equal(parsed.modules.get('node_modules/w').name, 'w')
  t.assert.equal(parsed.modules.get('node_modules/w').version, '1.0.0')
  t.assert.equal(parsed.modules.get('node_modules/w').files['i.js'], 'export const y = 2\n')
  t.assert.equal(parsed.sources.get('src/a.js'), 'export const x = 1\n')
  t.assert.equal(parsed.sources.get('node_modules/w/i.js'), 'export const y = 2\n')
  t.assert.equal(parsed.formats.get('src/a.js'), 'module')
  t.assert.equal(parsed.imports.get('*').get('src/a.js').get('./b.js'), 'src/b.js')
})

test('Bundle.serializeResources round-trip', (t) => {
  const bundle = new Bundle({
    modules: new Map([
      ['node_modules/foo', { name: 'foo', version: '1.0.0', files: { 'asset.bin': Buffer.from('hello').toString('base64') } }],
    ]),
  })

  const buf = bundle.serializeResources()
  const parsed = Bundle.parseResources(buf)

  t.assert.equal(parsed.modules.get('node_modules/foo').files['asset.bin'], Buffer.from('hello').toString('base64'))
  t.assert.equal(parsed.sources.get('node_modules/foo/asset.bin'), Buffer.from('hello').toString('base64'))
})

test('Bundle.parseCode exposes the parsed version (v0 stays at 0 in memory)', (t) => {
  const v0 = brotliCompressSync(JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { 'src/a.js': 'export const x = 1\n' },
  }))
  const parsed = Bundle.parseCode(v0)
  t.assert.equal(parsed.version, 0)
  // Re-save promotes to v1; the in-memory v0 carries no entries/modules metadata,
  // so a downstream caller (State.addFile) has to fill them before serializeCode.
})

test('Bundle.parseCode regroups v0 flat sources by inferred module dir', (t) => {
  const v0 = brotliCompressSync(JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: {
      'src/a.js': 'a',
      'src/lib/b.js': 'b',
      'node_modules/foo/index.js': 'foo',
      'node_modules/foo/lib/x.js': 'foox',
      'node_modules/@scope/pkg/index.js': 'scoped',
      'node_modules/foo/node_modules/bar/i.js': 'nested',
    },
  }))
  const parsed = Bundle.parseCode(v0)

  t.assert.deepEqual([...parsed.modules.keys()].sort(), [
    '.',
    'node_modules/@scope/pkg',
    'node_modules/foo',
    'node_modules/foo/node_modules/bar',
  ])
  // workspace bucket keeps the full project-relative path as rel
  t.assert.equal(parsed.modules.get('.').files['src/a.js'], 'a')
  t.assert.equal(parsed.modules.get('.').files['src/lib/b.js'], 'b')
  // node_modules buckets keep package-relative paths
  t.assert.equal(parsed.modules.get('node_modules/foo').files['index.js'], 'foo')
  t.assert.equal(parsed.modules.get('node_modules/foo').files['lib/x.js'], 'foox')
  t.assert.equal(parsed.modules.get('node_modules/@scope/pkg').files['index.js'], 'scoped')
  t.assert.equal(parsed.modules.get('node_modules/foo/node_modules/bar').files['i.js'], 'nested')
  // node_modules buckets carry the inferred package name; the workspace "."
  // bucket has no inferable name. v0 records no version, so version stays null.
  t.assert.equal(parsed.modules.get('.').name, null)
  t.assert.equal(parsed.modules.get('node_modules/foo').name, 'foo')
  t.assert.equal(parsed.modules.get('node_modules/@scope/pkg').name, '@scope/pkg')
  t.assert.equal(parsed.modules.get('node_modules/foo/node_modules/bar').name, 'bar')
  for (const dir of parsed.modules.keys()) {
    t.assert.equal(parsed.modules.get(dir).version, null, `${dir} version`)
  }
  // sources getter still presents a flat project-relative view
  t.assert.equal(parsed.sources.get('node_modules/foo/index.js'), 'foo')
  t.assert.equal(parsed.sources.get('node_modules/foo/node_modules/bar/i.js'), 'nested')
})

test('Bundle.parseCode rejects a v1 full-scope bundle with empty entries', (t) => {
  const buf = brotliCompressSync(JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0', files: {} } },
    modules: {},
    formats: {},
    imports: {},
  }))
  t.assert.throws(() => Bundle.parseCode(buf), /at least one entry/)
})
