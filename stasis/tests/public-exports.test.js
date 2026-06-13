import { test } from 'node:test'

import { Bundle } from '@exodus/stasis/bundle'
import { buildBundle, bundleCommand } from '@exodus/stasis/cmd/bundle'
import { Lockfile } from '@exodus/stasis/lockfile'

test('@exodus/stasis/bundle exports Bundle class', (t) => {
  t.assert.equal(typeof Bundle, 'function')
  t.assert.equal(Bundle.VERSION, 1)
})

test('@exodus/stasis/cmd/bundle exports the bundle command and its in-memory API', (t) => {
  t.assert.equal(typeof buildBundle, 'function')
  t.assert.equal(typeof bundleCommand, 'function')
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

test('Lockfile round-trip preserves imports and a legacy lockfile stays without them', (t) => {
  const withImports = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: {
      '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } },
    },
    modules: {},
    imports: {
      'node, import': { 'src/a.js': { './b.js': 'src/b.js' } },
    },
  })
  const parsed = Lockfile.parse(withImports)
  t.assert.equal(parsed.imports.get('node, import').get('src/a.js').get('./b.js'), 'src/b.js')
  const first = parsed.serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
  t.assert.ok(JSON.parse(first).imports, 'imports must survive serialization')

  // A legacy lockfile (no imports key) parses to imports === null and
  // round-trips without gaining the key.
  const legacy = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } } },
  })
  const legacyParsed = Lockfile.parse(legacy)
  t.assert.equal(legacyParsed.imports, null)
  t.assert.equal(JSON.parse(legacyParsed.serialize()).imports, undefined)
})

test('Lockfile round-trip preserves formats and a legacy lockfile stays without them', (t) => {
  const withFormats = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: { '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } } },
    modules: {},
    formats: { 'src/a.js': 'module' },
  })
  const parsed = Lockfile.parse(withFormats)
  t.assert.equal(parsed.formats.get('src/a.js'), 'module')
  const first = parsed.serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
  t.assert.deepEqual(JSON.parse(first).formats, { 'src/a.js': 'module' })

  // A legacy lockfile (no formats key) parses to formats === null and
  // round-trips without gaining the key.
  const legacy = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } } },
  })
  const legacyParsed = Lockfile.parse(legacy)
  t.assert.equal(legacyParsed.formats, null)
  t.assert.equal(JSON.parse(legacyParsed.serialize()).formats, undefined)
})

test('Lockfile.parse rejects malformed formats (escaping path / non-string value)', (t) => {
  const base = {
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  }
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { '../evil.js': 'module' } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { 'a/../../evil.js': 'module' } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { 'src/a.js': 42 } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: [] })))
})

test('Lockfile.parse rejects imports whose paths escape the project root', (t) => {
  const base = {
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  }
  const escapingTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': '../outside.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(escapingTarget))
  // A mid-path `..` that pops above the root is rejected too: plain
  // startsWith('..') would have let this through.
  const midPathTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 'a/../../outside.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(midPathTarget))
  const escapingParent = JSON.stringify({
    ...base,
    imports: { '*': { '../outside.js': { './b.js': 'src/b.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(escapingParent))
  const nonStringTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 42 } } },
  })
  t.assert.throws(() => Lockfile.parse(nonStringTarget))
})

test('Bundle.parseCode rejects imports whose paths escape the project root', (t) => {
  const base = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'x' } } },
    formats: {},
  }
  const escapingTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': '../outside.js' } } },
  })
  t.assert.throws(() => Bundle.parseCode(escapingTarget))
  const midPathTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 'a/../../outside.js' } } },
  })
  t.assert.throws(() => Bundle.parseCode(midPathTarget))
  const escapingParent = JSON.stringify({
    ...base,
    imports: { '*': { '../outside.js': { './b.js': 'src/b.js' } } },
  })
  t.assert.throws(() => Bundle.parseCode(escapingParent))
  // An array `imports` (malformed shape) is rejected, matching Lockfile.parse.
  const arrayImports = JSON.stringify({ ...base, imports: [] })
  t.assert.throws(() => Bundle.parseCode(arrayImports))
})

test('Bundle.parseCode rejects a non-object formats (malformed shape)', (t) => {
  // formats is attested under frozen bundles, so a non-plain-object value is rejected at
  // parse time -- mirroring `imports` above and Lockfile.parse's `formats` check, rather
  // than the weaker truthiness test that let an array/number through.
  const base = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'x' } } },
    imports: {},
  }
  t.assert.throws(() => Bundle.parseCode(JSON.stringify({ ...base, formats: [] })))
  t.assert.throws(() => Bundle.parseCode(JSON.stringify({ ...base, formats: 5 })))
  t.assert.ok(Bundle.parseCode(JSON.stringify({ ...base, formats: {} })))
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

  const text = bundle.serializeCode()
  t.assert.equal(typeof text, 'string')
  const parsed = Bundle.parseCode(text)

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

  const text = bundle.serializeResources()
  t.assert.equal(typeof text, 'string')
  const parsed = Bundle.parseResources(text)

  t.assert.equal(parsed.modules.get('node_modules/foo').files['asset.bin'], Buffer.from('hello').toString('base64'))
  t.assert.equal(parsed.sources.get('node_modules/foo/asset.bin'), Buffer.from('hello').toString('base64'))
})

test('Bundle.parseCode exposes the parsed version (v0 stays at 0 in memory)', (t) => {
  const v0 = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { 'src/a.js': 'export const x = 1\n' },
  })
  const parsed = Bundle.parseCode(v0)
  t.assert.equal(parsed.version, 0)
  // Re-save promotes to v1; the in-memory v0 carries no entries/modules metadata,
  // so a downstream caller (State.addFile) has to fill them before serializeCode.
})

test('Bundle.parseCode regroups v0 flat sources by inferred module dir', (t) => {
  const v0 = JSON.stringify({
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
  })
  const parsed = Bundle.parseCode(v0)

  t.assert.deepEqual([...parsed.modules.keys()].toSorted(), [
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
  const text = JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0', files: {} } },
    modules: {},
    formats: {},
    imports: {},
  })
  t.assert.throws(() => Bundle.parseCode(text), /at least one entry/)
})

test('Lockfile.parse rejects a node_modules module missing name', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(text))
})

test('Lockfile.parse rejects a node_modules module missing version', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', files: { 'i.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(text))
})

test('Lockfile.serialize rejects a node_modules module missing name/version', (t) => {
  const lock = new Lockfile({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'i.js': 'sha512-x' } }],
    ]),
  })
  t.assert.throws(() => lock.serialize())
})

test('Bundle.serializeCode rejects a node_modules module missing name/version', (t) => {
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'i.js': 'x' } }],
    ]),
  })
  t.assert.throws(() => bundle.serializeCode())
})

test('Bundle.serializeResources rejects a node_modules module missing name/version', (t) => {
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'a.bin': 'eA==' } }],
    ]),
  })
  t.assert.throws(() => bundle.serializeResources())
})
