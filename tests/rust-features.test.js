import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createCargoContext,
  parseCargoLock,
  parseCargoManifest,
  parseTomlValue,
  resolutionFromMetadata,
} from '../stasis/src/loaders/cargo.js'
import { buildRustBundle } from '../stasis/src/cmd/bundle.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rust-bundle')
const featuresFixture = join(fixtures, 'features')

const sorted = (iter) => [...iter].toSorted()
const enabledOf = (cargo) => Object.fromEntries([...cargo.resolvedFeatures()].map(([dir, set]) => [dir, sorted(set)]).toSorted())

// --- TOML subset ---

test('parseTomlValue reads arrays, inline tables, strings and bools', (t) => {
  t.assert.deepEqual(parseTomlValue('["a", "b-c", \'d\']'), ['a', 'b-c', 'd'])
  t.assert.deepEqual(parseTomlValue('{ version = "1", features = ["x", "y"], optional = true, default-features = false }'), {
    version: '1', features: ['x', 'y'], optional: true, 'default-features': false,
  })
  t.assert.equal(parseTomlValue('"a\\"b"'), 'a"b')
  t.assert.deepEqual(parseTomlValue('[]'), [])
})

test('parseCargoManifest reads multi-line arrays, feature tables, dependency kinds and patches', (t) => {
  const m = parseCargoManifest([
    '[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"', 'resolver = "2"',
    '[dependencies]', 'plain = "1" # registry', 'opt = { version = "1", optional = true, default-features = false, features = ["a"] }',
    '[dependencies.sub]', 'version = "2"', 'features = [', '    "one",', '    "two", # trailing comment', ']',
    '[dev-dependencies]', 'plain = { version = "1", features = ["dev-only"] }',
    '[build-dependencies]', 'cc = "1"',
    "[target.'cfg(unix)'.dependencies]", 'nix = "0.29"',
    '[features]', 'default = ["std"]', 'std = []', 'full = [', '  "std",', '  "dep:opt",', '  "sub/two",', '  "opt?/extra",', ']',
    '[patch.crates-io]', 'plain = { path = "patches/plain" }',
  ].join('\n'))
  t.assert.deepEqual(m.package, { name: 'app', version: '0.1.0', versionFromWorkspace: false, edition: '2021' })
  t.assert.equal(m.resolver, '2')
  t.assert.deepEqual([...m.features], [['default', ['std']], ['std', []], ['full', ['std', 'dep:opt', 'sub/two', 'opt?/extra']]])
  const dep = (k) => {
    const d = m.deps.get(k)
    return { version: d.version, optional: d.optional, defaultFeatures: d.defaultFeatures, features: d.features, kinds: sorted(d.kinds) }
  }
  t.assert.deepEqual(dep('plain'), { version: '1', optional: false, defaultFeatures: true, features: ['dev-only'], kinds: ['dev', 'normal'] })
  t.assert.deepEqual(dep('opt'), { version: '1', optional: true, defaultFeatures: false, features: ['a'], kinds: ['normal'] })
  t.assert.deepEqual(dep('sub'), { version: '2', optional: false, defaultFeatures: true, features: ['one', 'two'], kinds: ['normal'] })
  t.assert.deepEqual(dep('cc').kinds, ['build'])
  t.assert.deepEqual(dep('nix').kinds, ['normal'])
  t.assert.deepEqual([...m.patches], [['plain', { path: 'patches/plain' }]])
})

test('parseCargoLock indexes packages and their (possibly versioned) dependency edges', (t) => {
  const lock = parseCargoLock([
    'version = 3', '', '[[package]]', 'name = "app"', 'version = "0.1.0"', 'dependencies = [', ' "lib-a",', ' "winnowish 0.6.1",', ']', '',
    '[[package]]', 'name = "lib-a"', 'version = "0.2.0"', 'dependencies = ["winnowish 0.5.0"]', '',
    '[[package]]', 'name = "winnowish"', 'version = "0.5.0"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', '',
    '[[package]]', 'name = "winnowish"', 'version = "0.6.1"',
  ].join('\n'))
  t.assert.deepEqual(lock.byId.get('app 0.1.0').deps, [{ name: 'lib_a', version: null }, { name: 'winnowish', version: '0.6.1' }])
  t.assert.deepEqual(lock.byId.get('lib_a 0.2.0').deps, [{ name: 'winnowish', version: '0.5.0' }])
  t.assert.deepEqual(lock.byName.get('winnowish').map((p) => p.version), ['0.5.0', '0.6.1'])
  t.assert.equal(parseCargoLock(null), null)
})

// --- feature resolution from the manifests ---

test('createCargoContext resolves features like `cargo build` of the entry package: defaults, implications, dep requests', (t) => {
  const cargo = createCargoContext(featuresFixture, { entries: ['src/main.rs'] })
  t.assert.deepEqual(enabledOf(cargo), {
    '.': ['default', 'fast'],
    'crates/lib-a': ['default', 'extra', 'std'], // `features = ["extra"]` from app + its own default
    'vendor/winnowish': ['default', 'std'], // 0.6.1, via app
    'vendor/winnowish-0.5.0': ['default', 'std'], // 0.5.0, via lib-a
    // serde: optional and never enabled; proptest: a dev-dependency, out of a resolver-2 build
  })
  t.assert.deepEqual(sorted(cargo.featuresFor('crates/lib-a/src/lib.rs')), ['default', 'extra', 'std'])
  t.assert.equal(cargo.featuresFor('vendor/serde/src/lib.rs'), null) // not in the build: unknown, so its gated code is kept
  t.assert.equal(cargo.featuresFor('vendor/proptest/src/lib.rs'), null)
})

test('createCargoContext picks the vendored version each package depends on from Cargo.lock', (t) => {
  const cargo = createCargoContext(featuresFixture, { entries: ['src/main.rs'] })
  t.assert.equal(cargo.resolveCrate('winnowish', 'src/main.rs'), 'vendor/winnowish/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('winnowish', 'crates/lib-a/src/lib.rs'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('lib_a', 'src/main.rs'), 'crates/lib-a/src/lib.rs')
})

test('createCargoContext honours the root feature flags: --features (incl. pkg/feat), --no-default-features, --all-features', (t) => {
  const withSerde = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['with-serde'] })
  t.assert.deepEqual(enabledOf(withSerde), {
    '.': ['default', 'fast', 'with-serde'],
    'crates/lib-a': ['default', 'extra', 'serde', 'std'], // `lib-a/serde` from with-serde
    'vendor/serde': ['default', 'std'], // `dep:serde` activated the optional dep
    'vendor/winnowish': ['default', 'std'],
    'vendor/winnowish-0.5.0': ['default', 'std'],
  })
  const scoped = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['app/with-serde', 'nope/x'] })
  t.assert.deepEqual(enabledOf(scoped)['.'], ['default', 'fast', 'with-serde'])

  const noDefault = createCargoContext(featuresFixture, { entries: ['src/main.rs'], noDefaultFeatures: true })
  t.assert.deepEqual(enabledOf(noDefault)['.'], [])
  t.assert.deepEqual(enabledOf(noDefault)['crates/lib-a'], ['default', 'extra', 'std']) // deps keep their own defaults

  const all = createCargoContext(featuresFixture, { entries: ['src/main.rs'], allFeatures: true })
  t.assert.deepEqual(enabledOf(all)['.'], ['default', 'fast', 'with-serde'])
  t.assert.deepEqual(enabledOf(all)['vendor/serde'], ['default', 'std'])
})

test('createCargoContext unifies dev-dependency features under resolver 1 (edition 2018) but not resolver 2', (t) => {
  const v1 = createCargoContext(join(fixtures, 'features-v1'), { entries: ['src/main.rs'] })
  t.assert.deepEqual(enabledOf(v1), { '.': [], 'vendor/devonly': ['x'] })
})

test('createCargoContext leaves features unknown when no package owns the entries', (t) => {
  const cargo = createCargoContext(join(fixtures, 'basic'), { entries: ['src/main.rs'] })
  t.assert.equal(cargo.featuresFor('src/main.rs'), null)
  t.assert.deepEqual([...cargo.resolvedFeatures()], [])
})

// --- cargo metadata ---

test('resolutionFromMetadata maps `cargo metadata` packages inside the bundle root to features and dependency edges', (t) => {
  const base = '/work/proj'
  const metadata = {
    packages: [
      { id: 'app 0.1.0 (path+file:///work/proj)', name: 'app', manifest_path: '/work/proj/Cargo.toml' },
      { id: 'lib-a 0.2.0 (path+file:///work/proj/crates/lib-a)', name: 'lib-a', manifest_path: '/work/proj/crates/lib-a/Cargo.toml' },
      { id: 'winnowish 0.6.1 (registry+…)', name: 'winnowish', manifest_path: '/work/proj/vendor/winnowish/Cargo.toml' },
      { id: 'serde 1.0.0 (registry+…)', name: 'serde', manifest_path: '/home/u/.cargo/registry/src/x/serde-1.0.0/Cargo.toml' },
    ],
    resolve: {
      nodes: [
        { id: 'app 0.1.0 (path+file:///work/proj)', features: ['default', 'fast'], deps: [
          { name: 'lib_a', pkg: 'lib-a 0.2.0 (path+file:///work/proj/crates/lib-a)' },
          { name: 'winnowish', pkg: 'winnowish 0.6.1 (registry+…)' },
          { name: 'serde', pkg: 'serde 1.0.0 (registry+…)' },
        ] },
        { id: 'lib-a 0.2.0 (path+file:///work/proj/crates/lib-a)', features: ['default', 'std', 'extra'], deps: [] },
        { id: 'winnowish 0.6.1 (registry+…)', features: ['std'], deps: [] },
        { id: 'serde 1.0.0 (registry+…)', features: ['std'], deps: [] },
      ],
    },
  }
  const { enabled, deps } = resolutionFromMetadata(metadata, base)
  t.assert.deepEqual([...enabled].map(([d, s]) => [d, sorted(s)]), [
    ['.', ['default', 'fast']],
    ['crates/lib-a', ['default', 'extra', 'std']],
    ['vendor/winnowish', ['std']],
  ])
  // serde lives in the registry cache, outside the root: not bundleable, dropped from both maps.
  t.assert.deepEqual([...deps.get('.')], [['lib_a', 'crates/lib-a'], ['winnowish', 'vendor/winnowish']])
})

const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0

test('createCargoContext({ cargo: true }) takes the resolution from a real `cargo metadata`', { skip: hasCargo ? false : 'cargo not on PATH' }, (t) => {
  // Path dependencies only, so `cargo metadata` needs neither network nor a registry index.
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-cargo-'))
  try {
    cpSync(join(fixtures, 'workspace'), tmp, { recursive: true })
    const cargo = createCargoContext(tmp, { entries: ['crates/app/src/main.rs'], cargo: true })
    const enabled = enabledOf(cargo)
    t.assert.deepEqual(Object.keys(enabled).toSorted(), ['crates/app', 'crates/tools', 'crates/util'])
    t.assert.equal(cargo.resolveCrate('util', 'crates/app/src/main.rs'), 'crates/util/src/util_lib.rs')
    t.assert.equal(cargo.resolveCrate('tools', 'crates/app/src/main.rs'), 'crates/tools/src/lib.rs')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createCargoContext({ cargo: true }) fails loudly when cargo cannot run', { skip: hasCargo ? 'cargo is on PATH' : false }, (t) => {
  t.assert.throws(() => createCargoContext(featuresFixture, { entries: ['src/main.rs'], cargo: true }), /cargo metadata could not run/u)
})

// --- bundling ---

test('buildRustBundle leaves feature-gated code that is off out of the bundle, per crate and per version', async (t) => {
  const bundle = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'] })
  t.assert.deepEqual(sorted(bundle.sources.keys()), [
    'crates/lib-a/src/extra.rs', 'crates/lib-a/src/lib.rs', 'crates/lib-a/src/std_impl.rs',
    'src/fast.rs', 'src/main.rs', 'src/util.rs',
    'vendor/winnowish-0.5.0/src/lib.rs', 'vendor/winnowish-0.5.0/src/std_impl.rs',
    'vendor/winnowish/src/lib.rs', 'vendor/winnowish/src/std_impl.rs',
  ])
  // Out: src/ser.rs and lib-a's ser.rs (with-serde off), lib-a's no_std_impl.rs (std on), both winnowish
  // _tutorial.rs/debug.rs (features off), serde (optional dep off), proptest (dev-dependency).
  t.assert.deepEqual([...bundle.modules].map(([dir, m]) => [dir, m.name, m.version, m.ecosystem]).toSorted(), [
    ['.', 'app', '0.1.0', undefined],
    ['crates/lib-a', 'lib-a', '0.2.0', undefined],
    ['vendor/winnowish', 'winnowish', '0.6.1', 'cargo'],
    ['vendor/winnowish-0.5.0', 'winnowish', '0.5.0', 'cargo'],
  ])
  const imports = bundle.imports.get('rust')
  t.assert.equal(imports.get('src/main.rs').get('use winnowish'), 'vendor/winnowish/src/lib.rs')
  t.assert.equal(imports.get('crates/lib-a/src/lib.rs').get('use winnowish'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(imports.get('src/main.rs').get('mod fast'), 'src/fast.rs')
  t.assert.ok(!imports.get('src/main.rs').has('mod ser'))
})

test('buildRustBundle treats a feature that is on as firm: a missing gated module is fatal', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-features-'))
  try {
    cpSync(featuresFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'src', 'fast.rs')) // `fast` is a default feature
    await t.assert.rejects(
      () => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] }),
      /Unresolved module: mod fast from src\/main\.rs/u,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
