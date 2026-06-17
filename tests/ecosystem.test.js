import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// The `ecosystem` field records which package ecosystem a dependency came from
// (`npm` for node_modules packages — whatever the bundle's language — and
// `composer` for Composer vendor packages). It sits next to `name`/`version`
// and is written only for dependency buckets — the workspace/top-level "."
// bucket never carries one.
// These tests pin the on-disk shape and the parse→serialize round-trip for both
// the Lockfile and the Bundle (code + resources).

test('Lockfile serializes `ecosystem` next to name/version for an npm dep and omits it for the workspace', (t) => {
  const lock = new Lockfile({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-aaa' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-bbb' } }],
    ]),
  })

  const json = JSON.parse(lock.serialize())
  // Dependency: ecosystem present, and positioned right after name/version.
  t.assert.deepEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'files'])
  t.assert.equal(json.modules['node_modules/dep'].ecosystem, 'npm')
  // Workspace/top-level: no ecosystem key at all.
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'ecosystem'))

  // Round-trips back to the same in-memory shape.
  const parsed = Lockfile.parse(lock.serialize())
  t.assert.equal(parsed.modules.get('node_modules/dep').ecosystem, 'npm')
  t.assert.equal(parsed.modules.get('.').ecosystem, undefined)
})

test('Lockfile carries a `composer` ecosystem on a (non-node_modules) vendor dep in the sources section', (t) => {
  const lock = new Lockfile({
    config: { scope: 'full' },
    entries: new Set(['index.php']),
    modules: new Map([
      ['.', { name: 'acme/app', version: '0.0.0', files: { 'index.php': 'sha512-a' } }],
      ['vendor/acme/lib', { name: 'acme/lib', version: '1.4.2', ecosystem: 'composer', files: { 'src/Client.php': 'sha512-b' } }],
    ]),
  })

  const json = JSON.parse(lock.serialize())
  // A Composer vendor package isn't under node_modules, so it lands in the
  // `sources` section — but still carries its `composer` ecosystem.
  t.assert.equal(json.sources['vendor/acme/lib'].ecosystem, 'composer')
  t.assert.deepEqual(Object.keys(json.sources['vendor/acme/lib']), ['name', 'version', 'ecosystem', 'files'])
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'ecosystem'))

  const parsed = Lockfile.parse(lock.serialize())
  t.assert.equal(parsed.modules.get('vendor/acme/lib').ecosystem, 'composer')
  t.assert.equal(parsed.modules.get('.').ecosystem, undefined)
})

test('Bundle code round-trips `ecosystem` for deps and omits it for the workspace', (t) => {
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'export const x = 1\n' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'export const y = 2\n' } }],
    ]),
  })

  const json = JSON.parse(bundle.serialize())
  t.assert.deepEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'files'])
  t.assert.equal(json.modules['node_modules/dep'].ecosystem, 'npm')
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'ecosystem'))

  const parsed = Bundle.parse(bundle.serialize())
  t.assert.equal(parsed.modules.get('node_modules/dep').ecosystem, 'npm')
  t.assert.equal(parsed.modules.get('.').ecosystem, undefined)
})

test('Bundle round-trips `ecosystem` for resource deps', (t) => {
  // Resources live in the unified bundle, tagged by per-file format. ecosystem still
  // rides on the node_modules bucket and is omitted for the workspace.
  const bundle = new Bundle({
    config: { scope: 'full' },
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'a.bin': 'AAA=' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', ecosystem: 'npm', files: { 'b.bin': 'BBB=' } }],
    ]),
    formats: new Map([['a.bin', 'resource:base64'], ['node_modules/dep/b.bin', 'resource:base64']]),
  })

  const json = JSON.parse(bundle.serialize())
  t.assert.equal(json.modules['node_modules/dep'].ecosystem, 'npm')
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'ecosystem'))

  const parsed = Bundle.parse(bundle.serialize())
  t.assert.equal(parsed.modules.get('node_modules/dep').ecosystem, 'npm')
  t.assert.equal(parsed.modules.get('.').ecosystem, undefined)
})

test('a module with no `ecosystem` serializes without the key (clean omission)', (t) => {
  const lock = new Lockfile({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'sha512-x' } }],
    ]),
  })
  const text = lock.serialize()
  t.assert.ok(!text.includes('ecosystem'), 'no ecosystem key when none is set')
  t.assert.equal(Lockfile.parse(text).modules.get('node_modules/dep').ecosystem, undefined)
})

test('lockfiles/bundles predating `ecosystem` still parse (backward compatible)', (t) => {
  // Hand-written, ecosystem-less inputs — exactly what older files on disk look like.
  const lockText = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'sha512-x' } } },
  })
  t.assert.doesNotThrow(() => Lockfile.parse(lockText))
  t.assert.equal(Lockfile.parse(lockText).modules.get('node_modules/dep').ecosystem, undefined)

  const bundleText = JSON.stringify({
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export const x = 1\n' } } },
    formats: {},
    imports: {},
  })
  t.assert.doesNotThrow(() => Bundle.parse(bundleText))
  t.assert.equal(Bundle.parse(bundleText).modules.get('node_modules/dep').ecosystem, undefined)
})

test('a non-string `ecosystem` is rejected at parse time', (t) => {
  const lockText = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', ecosystem: 123, files: { 'index.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(lockText))

  const bundleText = JSON.stringify({
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', ecosystem: 123, files: { 'index.js': 'export const x = 1\n' } } },
    formats: {},
    imports: {},
  })
  t.assert.throws(() => Bundle.parse(bundleText))
})
