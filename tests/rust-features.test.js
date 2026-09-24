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
  satisfiesCargoReq,
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
    '[dependencies]', 'plain = "1" # registry', 'opt = { version = "1", optional = true, default-features = false, features = ["a"] }', 'pm-crate = { version = "3", optional = true }',
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
  // the key is the `use` spelling, the name the manifest's (an optional dep's implicit feature name)
  t.assert.deepEqual([m.deps.get('pm_crate').key, m.deps.get('pm_crate').name, m.deps.get('pm_crate').optional], ['pm_crate', 'pm-crate', true])
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

test('satisfiesCargoReq implements Cargo requirement semantics', (t) => {
  // caret is the default; the leftmost non-zero part may not change
  t.assert.equal(satisfiesCargoReq('1.5.0', '1'), true)
  t.assert.equal(satisfiesCargoReq('2.0.0', '1'), false)
  t.assert.equal(satisfiesCargoReq('1.2.9', '1.2'), true)
  t.assert.equal(satisfiesCargoReq('1.1.0', '1.2'), false)
  t.assert.equal(satisfiesCargoReq('0.9.3', '0.9'), true)
  t.assert.equal(satisfiesCargoReq('0.10.3', '0.9'), false)
  t.assert.equal(satisfiesCargoReq('0.10.3', '0.10'), true)
  t.assert.equal(satisfiesCargoReq('0.0.3', '0.0.3'), true)
  t.assert.equal(satisfiesCargoReq('0.0.4', '0.0.3'), false)
  t.assert.equal(satisfiesCargoReq('0.5.0', '^0'), true)
  t.assert.equal(satisfiesCargoReq('1.0.0', '^0'), false)
  // tilde, wildcard, exact, comparisons, several comparators
  t.assert.equal(satisfiesCargoReq('1.2.9', '~1.2.3'), true)
  t.assert.equal(satisfiesCargoReq('1.3.0', '~1.2.3'), false)
  t.assert.equal(satisfiesCargoReq('1.7.0', '1.*'), true)
  t.assert.equal(satisfiesCargoReq('1.7.0', '1.2.*'), false)
  t.assert.equal(satisfiesCargoReq('1.2.3', '=1.2.3'), true)
  t.assert.equal(satisfiesCargoReq('1.2.4', '=1.2.3'), false)
  t.assert.equal(satisfiesCargoReq('1.2.4', '=1.2'), true)
  t.assert.equal(satisfiesCargoReq('1.9.0', '>=1.2, <2.0'), true)
  t.assert.equal(satisfiesCargoReq('2.0.0', '>=1.2, <2.0'), false)
  t.assert.equal(satisfiesCargoReq('9.9.9', '*'), true)
  // a prerelease sorts below its release
  t.assert.equal(satisfiesCargoReq('1.0.0-beta.1', '>=1.0.0'), false)
  t.assert.equal(satisfiesCargoReq('junk', '1'), false)
})

// --- feature resolution from the manifests ---

test('createCargoContext resolves features like `cargo build` of the entry package: defaults, implications, dep requests', (t) => {
  const cargo = createCargoContext(featuresFixture, { entries: ['src/main.rs'] })
  t.assert.deepEqual(enabledOf(cargo), {
    '.': ['default', 'fast'],
    // `features = ["extra"]` from app + its own default; `std = ["extra-dep"]` names the optional dep's
    // implicit feature, spelled as in the manifest (hyphen), and activates the dep.
    'crates/lib-a': ['default', 'extra', 'extra-dep', 'std'],
    'vendor/extra-dep': [],
    'vendor/winnowish': ['default', 'std'], // 0.6.1, via app
    'vendor/winnowish-0.5.0': ['default', 'std'], // 0.5.0, via lib-a
    // serde: optional and never enabled; proptest: a dev-dependency, out of a resolver-2 build
  })
  t.assert.deepEqual(sorted(cargo.featuresFor('crates/lib-a/src/lib.rs')), ['default', 'extra', 'extra-dep', 'std'])
  t.assert.equal(cargo.featuresFor('vendor/serde/src/lib.rs'), null) // not in the build: unknown, so its gated code is kept
  t.assert.equal(cargo.featuresFor('vendor/proptest/src/lib.rs'), null)
})

test('createCargoContext picks the vendored version each package depends on from Cargo.lock, by requirement when a package depends on two', (t) => {
  const cargo = createCargoContext(featuresFixture, { entries: ['src/main.rs'] })
  // app depends on `winnowish = "0.6"` AND `winnowish0-5 = { package = "winnowish", version = "0.5" }`: the lock
  // lists both versions under app, and the requirement says which dependency is which.
  t.assert.equal(cargo.resolveCrate('winnowish', 'src/main.rs'), 'vendor/winnowish/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('winnowish0_5', 'src/main.rs'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('winnowish', 'crates/lib-a/src/lib.rs'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('lib_a', 'src/main.rs'), 'crates/lib-a/src/lib.rs')
})

test('createCargoContext falls back to the requirement when there is no Cargo.lock', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-nolock-'))
  try {
    cpSync(featuresFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'Cargo.lock'))
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.equal(cargo.resolveCrate('winnowish', 'src/main.rs'), 'vendor/winnowish/src/lib.rs') // "0.6" -> 0.6.1
    t.assert.equal(cargo.resolveCrate('winnowish0_5', 'src/main.rs'), 'vendor/winnowish-0.5.0/src/lib.rs') // "0.5" -> 0.5.0
    t.assert.equal(cargo.resolveCrate('winnowish', 'crates/lib-a/src/lib.rs'), 'vendor/winnowish-0.5.0/src/lib.rs') // "0.5"
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createCargoContext honours the root feature flags: --features (incl. pkg/feat), --no-default-features, --all-features', (t) => {
  const withSerde = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['with-serde'] })
  t.assert.deepEqual(enabledOf(withSerde), {
    '.': ['default', 'fast', 'with-serde'],
    'crates/lib-a': ['default', 'extra', 'extra-dep', 'serde', 'std'], // `lib-a/serde` from with-serde
    'vendor/extra-dep': [],
    'vendor/serde': ['default', 'std'], // `dep:serde` activated the optional dep
    'vendor/winnowish': ['default', 'std'],
    'vendor/winnowish-0.5.0': ['default', 'std'],
  })
  const scoped = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['app/with-serde', 'nope/x'] })
  t.assert.deepEqual(enabledOf(scoped)['.'], ['default', 'fast', 'with-serde'])

  const noDefault = createCargoContext(featuresFixture, { entries: ['src/main.rs'], noDefaultFeatures: true })
  t.assert.deepEqual(enabledOf(noDefault)['.'], [])
  t.assert.deepEqual(enabledOf(noDefault)['crates/lib-a'], ['default', 'extra', 'extra-dep', 'std']) // deps keep their own defaults

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

test('resolutionFromMetadata maps `cargo metadata` packages to features and dependency edges, locating registry crates in vendor/', (t) => {
  const base = '/work/proj'
  const metadata = {
    packages: [
      { id: 'app 0.1.0 (path+file:///work/proj)', name: 'app', version: '0.1.0', manifest_path: '/work/proj/Cargo.toml' },
      { id: 'lib-a 0.2.0 (path+file:///work/proj/crates/lib-a)', name: 'lib-a', version: '0.2.0', manifest_path: '/work/proj/crates/lib-a/Cargo.toml' },
      // read from vendor/ (a .cargo/config.toml redirects crates.io there)
      { id: 'winnowish 0.6.1 (registry+…)', name: 'winnowish', version: '0.6.1', manifest_path: '/work/proj/vendor/winnowish/Cargo.toml' },
      // read from the registry cache (no redirect), but vendored: located by name + version
      { id: 'serde 1.0.0 (registry+…)', name: 'serde', version: '1.0.0', manifest_path: '/home/u/.cargo/registry/src/x/serde-1.0.0/Cargo.toml' },
      // read from the registry cache and not vendored: dropped
      { id: 'proc-macro2 1.0.9 (registry+…)', name: 'proc-macro2', version: '1.0.9', manifest_path: '/home/u/.cargo/registry/src/x/proc-macro2-1.0.9/Cargo.toml' },
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
        { id: 'serde 1.0.0 (registry+…)', features: ['std'], deps: [{ name: 'proc_macro2', pkg: 'proc-macro2 1.0.9 (registry+…)' }] },
        { id: 'proc-macro2 1.0.9 (registry+…)', features: [], deps: [] },
      ],
    },
  }
  const vendoredDirs = new Map([['serde 1.0.0', 'vendor/serde']])
  const locate = (name, version) => vendoredDirs.get(`${name} ${version}`) ?? null
  const { enabled, deps } = resolutionFromMetadata(metadata, base, { locate })
  t.assert.deepEqual([...enabled].map(([d, s]) => [d, sorted(s)]), [
    ['.', ['default', 'fast']],
    ['crates/lib-a', ['default', 'extra', 'std']],
    ['vendor/winnowish', ['std']],
    ['vendor/serde', ['std']],
  ])
  t.assert.deepEqual([...deps.get('.')], [['lib_a', 'crates/lib-a'], ['winnowish', 'vendor/winnowish'], ['serde', 'vendor/serde']])
  t.assert.deepEqual([...deps.get('vendor/serde')], []) // proc-macro2 isn't in-tree
  // Without a locator, a registry-cache package is simply outside the root.
  t.assert.ok(!resolutionFromMetadata(metadata, base).enabled.has('vendor/serde'))
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
    'crates/lib-a/src/extra.rs', 'crates/lib-a/src/lib.rs', 'crates/lib-a/src/std_impl.rs', 'crates/lib-a/src/with_extra.rs',
    'src/fast.rs', 'src/main.rs', 'src/util.rs',
    'vendor/extra-dep/src/lib.rs',
    'vendor/winnowish-0.5.0/src/lib.rs', 'vendor/winnowish-0.5.0/src/std_impl.rs',
    'vendor/winnowish/src/lib.rs', 'vendor/winnowish/src/std_impl.rs',
  ])
  // Out: src/ser.rs and lib-a's ser.rs (with-serde off), lib-a's no_std_impl.rs (std on), both winnowish
  // _tutorial.rs/debug.rs (features off), serde (optional dep off), proptest (dev-dependency).
  t.assert.deepEqual([...bundle.modules].map(([dir, m]) => [dir, m.name, m.version, m.ecosystem]).toSorted(), [
    ['.', 'app', '0.1.0', undefined],
    ['crates/lib-a', 'lib-a', '0.2.0', undefined],
    ['vendor/extra-dep', 'extra-dep', '1.0.0', 'cargo'],
    ['vendor/winnowish', 'winnowish', '0.6.1', 'cargo'],
    ['vendor/winnowish-0.5.0', 'winnowish', '0.5.0', 'cargo'],
  ])
  const imports = bundle.imports.get('rust')
  t.assert.equal(imports.get('crates/lib-a/src/with_extra.rs').get('use extra_dep'), 'vendor/extra-dep/src/lib.rs')
  t.assert.equal(imports.get('src/main.rs').get('use winnowish'), 'vendor/winnowish/src/lib.rs')
  t.assert.equal(imports.get('src/main.rs').get('use winnowish0_5'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(imports.get('crates/lib-a/src/lib.rs').get('use winnowish'), 'vendor/winnowish-0.5.0/src/lib.rs')
  t.assert.equal(imports.get('src/main.rs').get('mod fast'), 'src/fast.rs')
  t.assert.ok(!imports.get('src/main.rs').has('mod ser'))
})

test('buildRustBundle applies the cargo feature overrides to the entries\' packages', async (t) => {
  const withSerde = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'], cargoFeatures: ['with-serde'] })
  const files = sorted(withSerde.sources.keys())
  for (const f of ['src/ser.rs', 'crates/lib-a/src/ser.rs', 'vendor/serde/src/lib.rs', 'vendor/serde/src/std_impl.rs']) t.assert.ok(files.includes(f), f)
  t.assert.equal(withSerde.imports.get('rust').get('src/ser.rs').get('use serde'), 'vendor/serde/src/lib.rs')
  t.assert.deepEqual([...withSerde.modules.keys()].toSorted(), ['.', 'crates/lib-a', 'vendor/extra-dep', 'vendor/serde', 'vendor/winnowish', 'vendor/winnowish-0.5.0'])

  const noDefault = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'], cargoNoDefaultFeatures: true })
  t.assert.ok(!noDefault.sources.has('src/fast.rs')) // `fast` is only a default feature
  t.assert.ok(noDefault.sources.has('crates/lib-a/src/std_impl.rs')) // dependencies keep their own defaults

  const all = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'], cargoAllFeatures: true })
  t.assert.ok(all.sources.has('src/fast.rs'))
  t.assert.ok(all.sources.has('src/ser.rs'))
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
