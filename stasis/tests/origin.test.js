import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// The `origin` field records which package ecosystem a dependency came from
// (`npm` for node_modules packages — whatever the bundle's language — and
// `composer` for Composer vendor packages). It sits next to `name`/`version`
// and is written only for dependency buckets — the workspace/top-level "."
// bucket never carries one.
// These tests pin the on-disk shape and the parse→serialize round-trip for both
// the Lockfile and the Bundle (code + resources).

test('Lockfile serializes `origin` next to name/version for an npm dep and omits it for the workspace', (t) => {
  const lock = new Lockfile({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-aaa' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', origin: 'npm', files: { 'index.js': 'sha512-bbb' } }],
    ]),
  })

  const json = JSON.parse(lock.serialize())
  // Dependency: origin present, and positioned right after name/version.
  t.assert.deepEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'origin', 'files'])
  t.assert.equal(json.modules['node_modules/dep'].origin, 'npm')
  // Workspace/top-level: no origin key at all.
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'origin'))

  // Round-trips back to the same in-memory shape.
  const parsed = Lockfile.parse(lock.serialize())
  t.assert.equal(parsed.modules.get('node_modules/dep').origin, 'npm')
  t.assert.equal(parsed.modules.get('.').origin, undefined)
})

test('Lockfile carries a `composer` origin on a (non-node_modules) vendor dep in the sources section', (t) => {
  const lock = new Lockfile({
    config: { scope: 'full' },
    entries: new Set(['index.php']),
    modules: new Map([
      ['.', { name: 'acme/app', version: '0.0.0', files: { 'index.php': 'sha512-a' } }],
      ['vendor/acme/lib', { name: 'acme/lib', version: '1.4.2', origin: 'composer', files: { 'src/Client.php': 'sha512-b' } }],
    ]),
  })

  const json = JSON.parse(lock.serialize())
  // A Composer vendor package isn't under node_modules, so it lands in the
  // `sources` section — but still carries its `composer` origin.
  t.assert.equal(json.sources['vendor/acme/lib'].origin, 'composer')
  t.assert.deepEqual(Object.keys(json.sources['vendor/acme/lib']), ['name', 'version', 'origin', 'files'])
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'origin'))

  const parsed = Lockfile.parse(lock.serialize())
  t.assert.equal(parsed.modules.get('vendor/acme/lib').origin, 'composer')
  t.assert.equal(parsed.modules.get('.').origin, undefined)
})

test('Bundle code round-trips `origin` for deps and omits it for the workspace', (t) => {
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'export const x = 1\n' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', origin: 'npm', files: { 'index.js': 'export const y = 2\n' } }],
    ]),
  })

  const json = JSON.parse(bundle.serializeCode())
  t.assert.deepEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'origin', 'files'])
  t.assert.equal(json.modules['node_modules/dep'].origin, 'npm')
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'origin'))

  const parsed = Bundle.parseCode(bundle.serializeCode())
  t.assert.equal(parsed.modules.get('node_modules/dep').origin, 'npm')
  t.assert.equal(parsed.modules.get('.').origin, undefined)
})

test('Bundle resources round-trips `origin` for deps', (t) => {
  const bundle = new Bundle({
    config: { scope: 'full' },
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'a.bin': 'AAA=' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', origin: 'npm', files: { 'b.bin': 'BBB=' } }],
    ]),
  })

  const json = JSON.parse(bundle.serializeResources())
  t.assert.equal(json.modules['node_modules/dep'].origin, 'npm')
  t.assert.ok(!Object.hasOwn(json.sources['.'], 'origin'))

  const parsed = Bundle.parseResources(bundle.serializeResources())
  t.assert.equal(parsed.modules.get('node_modules/dep').origin, 'npm')
  t.assert.equal(parsed.modules.get('.').origin, undefined)
})

test('a module with no `origin` serializes without the key (clean omission)', (t) => {
  const lock = new Lockfile({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'sha512-x' } }],
    ]),
  })
  const text = lock.serialize()
  t.assert.ok(!text.includes('origin'), 'no origin key when none is set')
  t.assert.equal(Lockfile.parse(text).modules.get('node_modules/dep').origin, undefined)
})

test('lockfiles/bundles predating `origin` still parse (backward compatible)', (t) => {
  // Hand-written, origin-less inputs — exactly what older files on disk look like.
  const lockText = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'sha512-x' } } },
  })
  t.assert.doesNotThrow(() => Lockfile.parse(lockText))
  t.assert.equal(Lockfile.parse(lockText).modules.get('node_modules/dep').origin, undefined)

  const bundleText = JSON.stringify({
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export const x = 1\n' } } },
    formats: {},
    imports: {},
  })
  t.assert.doesNotThrow(() => Bundle.parseCode(bundleText))
  t.assert.equal(Bundle.parseCode(bundleText).modules.get('node_modules/dep').origin, undefined)
})

test('a non-string `origin` is rejected at parse time', (t) => {
  const lockText = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', origin: 123, files: { 'index.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(lockText))

  const bundleText = JSON.stringify({
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', origin: 123, files: { 'index.js': 'export const x = 1\n' } } },
    formats: {},
    imports: {},
  })
  t.assert.throws(() => Bundle.parseCode(bundleText))
})
