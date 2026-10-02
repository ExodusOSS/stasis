import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HOST_UNIT,
  createCargoContext,
  evalCfg,
  findCargoLock,
  parseCargoManifest,
  parseFeatureList,
  parseRustcCfg,
  resolutionFromMetadata,
  rustcTargetCfgs,
} from '../stasis/src/loaders/cargo.js'
import { buildRustBundle } from '../stasis/src/cmd/bundle.js'
import { buildRustTree, collectRustBundle, collectRustFilesFromDisk } from '../stasis/src/loaders/rust.js'
import { rustFixture } from './rust-fixtures.helper.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rust-bundle')
const featuresFixture = join(fixtures, 'features')

const sorted = (iter) => [...iter].toSorted()
const enabledOf = (cargo, context) => Object.fromEntries([...cargo.resolvedFeatures(context)].map(([dir, set]) => [dir, sorted(set)]).toSorted())
// The packages built only maybe, or with features on only maybe: dir -> those features.
const maybeOf = (cargo, context) => Object.fromEntries([...cargo.featureResolution(context)].filter(([dir, r]) => r.maybe.size > 0 || !cargo.resolvedFeatures(context).has(dir)).map(([dir, r]) => [dir, sorted(r.maybe)]).toSorted())

// A throwaway project: `files` maps project-relative paths to their text.
const writeProject = (files) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-cargo-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true })
    writeFileSync(join(tmp, rel), text)
  }
  return tmp
}
const withProject = (files, fn) => {
  const tmp = writeProject(files)
  try {
    return fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
const captureWarningsAsync = async (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: await fn(), warnings }
  } finally {
    console.warn = original
  }
}
const withProjectAsync = async (files, fn) => {
  const tmp = writeProject(files)
  try {
    return await fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Warnings `fn` prints, and its result.
const captureWarningsSync = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}
// Warnings, less the notice that the features come from a replay of the manifests (see the test of it).
const besidesReplay = (warnings) => warnings.filter((w) => !w.startsWith('[stasis] Rust features from a replay of the manifests'))
const vendoredPackage = (name, version) => ({
  [`vendor/${name}-${version}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "${version}"\n`,
  [`vendor/${name}-${version}/src/lib.rs`]: '',
})

// --- Cargo.toml / Cargo.lock ---

test('parseCargoManifest reads multi-line arrays, feature tables, dependency kinds and patches', (t) => {
  const m = parseCargoManifest([
    '[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"', 'resolver = "2"',
    '[dependencies]', 'plain = "1" # registry', 'opt = { version = "1", optional = true, default-features = false, features = ["a"] }', 'pm-crate = { version = "3", optional = true }',
    '[dependencies.sub]', 'version = "2"', 'features = [', '    "one",', '    "two", # trailing comment', ']',
    '[dev-dependencies]', 'plain = { version = "1", features = ["dev-only"] }',
    '[build-dependencies]', 'cc = "1"',
    "[target.'cfg(unix)'.dependencies]", 'nix = "0.29"',
    '[features]', 'default = ["std"]', 'std = []', 'full = [', '  "std",', '  "dep:opt",', '  "sub/two",', '  "opt?/extra",', ']',
    '[patch.crates-io]', 'plain = { path = "patches/plain" }', 'dotted.path = "patches/dotted"',
    '[patch.crates-io.subbed]', 'path = "patches/subbed"',
  ].join('\n'))
  t.assert.deepEqual(m.package, { name: 'app', version: '0.1.0', edition: '2021', build: null })
  t.assert.equal(m.resolver, 2)
  // cargo's feature map: as written, and a feature for the optional dependency no `dep:` names
  t.assert.deepEqual([...m.features], [['default', ['std']], ['std', []], ['full', ['std', 'dep:opt', 'sub/two', 'opt?/extra']], ['pm-crate', ['dep:pm-crate']]])
  const dep = (k) => Object.fromEntries([...m.deps.get(k).kinds].toSorted())
  const ask = (pkg, version, more) => ({ kind: 'normal', target: null, version, path: null, source: 'registry', origin: null, package: pkg, renamed: false, inherited: false, optional: false, defaultFeatures: true, features: [], ...more })
  // Each dependency table is its own request, for the crate it names: a dev-dependency's features
  // stay out of the normal one.
  t.assert.deepEqual(dep('plain'), { dev: ask('plain', '1', { kind: 'dev', features: ['dev-only'] }), normal: ask('plain', '1') })
  t.assert.deepEqual(dep('opt'), { normal: ask('opt', '1', { optional: true, defaultFeatures: false, features: ['a'] }) })
  t.assert.deepEqual(dep('sub'), { normal: ask('sub', '2', { features: ['one', 'two'] }) })
  t.assert.deepEqual(Object.keys(dep('cc')), ['build'])
  // A target-specific table is a request of its own, beside the plain one.
  t.assert.deepEqual(Object.keys(dep('nix')), ['normal@cfg(unix)'])
  t.assert.deepEqual([dep('nix')['normal@cfg(unix)'].kind, dep('nix')['normal@cfg(unix)'].target], ['normal', 'cfg(unix)'])
  // the key is the `use` spelling, the name the manifest's (an optional dep's implicit feature name)
  t.assert.deepEqual([m.deps.get('pm_crate').key, m.deps.get('pm_crate').name, m.deps.get('pm_crate').kinds.get('normal').optional], ['pm_crate', 'pm-crate', true])
  // `[patch.<source>]` entries in every spelling: inline table, dotted key, sub-table.
  t.assert.deepEqual(Object.entries(m.cargo.patch['crates-io']).map(([name, spec]) => [name, spec.source.path]), [['plain', 'patches/plain'], ['dotted', 'patches/dotted'], ['subbed', 'patches/subbed']])
})

test('parseCargoManifest reads a workspace-inherited edition, from its own [workspace] or the root given', (t) => {
  const root = parseCargoManifest(['[workspace]', '[workspace.package]', 'edition = "2021"', '[package]', 'name = "app"', 'version = "0.1.0"', 'edition.workspace = true'].join('\n'))
  t.assert.equal(root.package.edition, '2021')
  const member = '[package]\nname = "lib"\nedition = { workspace = true }\n'
  t.assert.equal(parseCargoManifest(member, 'crates/lib/Cargo.toml', root).package.edition, '2021')
  t.assert.throws(() => parseCargoManifest(member, 'crates/lib/Cargo.toml'), { name: 'LockfileError', message: 'crates/lib/Cargo.toml: package.edition: inherits from a workspace, and no workspace root is given' })
})

test('parseCargoManifest splits dotted dependency keys and survives multi-line strings', (t) => {
  const root = parseCargoManifest('[workspace]\n[workspace.dependencies]\nutil = { path = "crates/util" }\n')
  const m = parseCargoManifest([
    '[package]', 'name = "app"', 'description = """', 'Not a table: [x]', 'nor a key = value', '"""', 'version = "0.4.0"',
    '[dependencies]', 'util.workspace = true', 'util.features = ["extra"]', "serde.version = '1'", 'serde.features = [', '  "derive",', ']',
  ].join('\n'), 'crates/app/Cargo.toml', root)
  t.assert.equal(m.package.version, '0.4.0')
  t.assert.deepEqual([...m.deps.keys()], ['util', 'serde'])
  const util = m.deps.get('util').kinds.get('normal')
  t.assert.deepEqual([util.inherited, util.path, util.features], [true, 'crates/util', ['extra']]) // the path is the workspace root's
  t.assert.equal(m.deps.get('serde').kinds.get('normal').version, '1')
  t.assert.deepEqual(m.deps.get('serde').kinds.get('normal').features, ['derive'])
})

test('parseCargoManifest reads a pair by the table it lands in, whichever way that is spelled', (t) => {
  // `[dependencies.foo] features = […]`, `[dependencies] foo.features = […]` and `foo = { features = […] }` are one thing
  const spellings = [
    '[dependencies.foo]\nversion = "1"\nfeatures = ["x"]\n',
    '[dependencies]\nfoo.version = "1"\nfoo.features = ["x"]\n',
    '[dependencies]\nfoo = { version = "1", features = ["x"] }\n',
  ]
  for (const text of spellings) {
    const normal = parseCargoManifest(`[package]\nname = "app"\n${text}`).deps.get('foo').kinds.get('normal')
    t.assert.deepEqual([normal.version, normal.features], ['1', ['x']], text)
  }
  const m = parseCargoManifest([
    '[package]', 'name = "app"', 'version = { workspace = true }',
    '[package.metadata.docs.rs]', 'all-features = true', // a deeper table under [package] is not a package field
    "[target.'cfg(windows)'.dev-dependencies.winapi]", 'version = "0.3"',
    '[patch.crates-io.plain]', 'path = "patches/plain"',
    '[workspace.package]', 'version = "0.9.0"', // a [workspace.*] table alone makes this a workspace root
  ].join('\n'))
  t.assert.deepEqual(m.package, { name: 'app', version: '0.9.0', edition: '2015', build: null })
  t.assert.deepEqual([...m.deps.get('winapi').kinds].map(([request, r]) => [request, r.version]), [['dev@cfg(windows)', '0.3']])
  t.assert.deepEqual(Object.keys(m.cargo.patch['crates-io']), ['plain'])
  t.assert.equal(m.isWorkspace, true)
})

test('parseCargoManifest refuses text that is not TOML, or not a manifest cargo reads, naming the file and line', (t) => {
  t.assert.throws(() => parseCargoManifest('[package]\nname = "app"\nversion = 0.1.0\n', 'crates/app/Cargo.toml'), {
    name: 'TomlError', message: 'crates/app/Cargo.toml: expected a value, found "0.1.0" at line 3',
  })
  t.assert.throws(() => parseCargoManifest('[dependencies]\nserde = { version = "1", version = "2" }\n'), { message: 'duplicate key "version" at line 2' })
  // what cargo would refuse, or read in a way the reader can't tell: @preventive/lockfile's word
  t.assert.throws(() => parseCargoManifest('[package]\nname = "app"\n[features]\nstd = ["nothing"]\n', 'Cargo.toml'), {
    name: 'LockfileError', message: 'Cargo.toml: features.std: "nothing" is neither a feature nor a dependency',
  })
  t.assert.throws(() => parseCargoManifest('[package]\nname = "app"\n[replace]\n"foo:1.0.0" = { path = "foo" }\n', 'Cargo.toml'), { name: 'LockfileError', message: 'Cargo.toml: replace: [replace] is not supported' })
  // through the context, with the manifest's project-relative path
  withProject({
    'Cargo.toml': '[workspace]\nmembers = ["crates/app"]\n',
    'crates/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0\n',
    'crates/app/src/main.rs': 'fn main() {}\n',
  }, (tmp) => {
    t.assert.throws(() => createCargoContext(tmp).packageInfo('crates/app/src/main.rs'), { name: 'TomlError', message: 'crates/app/Cargo.toml: unterminated string at line 3', line: 2 })
  })
})

test('createCargoContext refuses a Cargo.lock older than version 3, or not TOML, naming it', (t) => {
  const files = (lock) => ({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nrand = "0.8"\n',
    'Cargo.lock': lock,
    'src/main.rs': '',
    ...vendoredPackage('rand', '0.8.5'),
  })
  const v2 = '[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["rand"]\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
  withProject(files(v2), (tmp) => {
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/main.rs'] }).resolveCrate('rand', 'src/main.rs'), {
      name: 'LockfileError', message: 'Cargo.lock: version: no `version`: this is lockfile version 1 or 2, which is not read here, where 3 and 4 are',
    })
  })
  withProject(files('version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["a" "b"]\n'), (tmp) => {
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/main.rs'] }).resolveCrate('rand', 'src/main.rs'), {
      name: 'TomlError', message: 'Cargo.lock: expected "," or "]", found "\\"b\\"]" at line 6',
    })
  })
})

test('parseFeatureList splits cargo\'s repeatable, comma- or space-separated feature flags', (t) => {
  t.assert.deepEqual(parseFeatureList(['a,b', ' c d ', 'a', ',']), ['a', 'b', 'c', 'd'])
  t.assert.deepEqual(parseFeatureList([]), [])
})

test('findCargoLock finds the lock beside the workspace root (a member dir\'s is its workspace\'s), never one further up', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-lock-'))
  try {
    mkdirSync(join(tmp, 'ws', 'crates', 'app'), { recursive: true })
    writeFileSync(join(tmp, 'Cargo.lock'), 'version = 3\n') // some other project's, above the workspace
    writeFileSync(join(tmp, 'ws', 'Cargo.toml'), '[workspace]\nmembers = ["crates/app"]\n')
    writeFileSync(join(tmp, 'ws', 'crates', 'app', 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n')
    t.assert.equal(findCargoLock(join(tmp, 'ws', 'crates', 'app')), null)
    t.assert.equal(findCargoLock(join(tmp, 'ws')), null)
    writeFileSync(join(tmp, 'ws', 'Cargo.lock'), 'version = 3\n')
    t.assert.equal(findCargoLock(join(tmp, 'ws', 'crates', 'app')), join(tmp, 'ws', 'Cargo.lock'))
    t.assert.equal(findCargoLock(join(tmp, 'ws')), join(tmp, 'ws', 'Cargo.lock'))
    // A package outside any workspace: its own lock, and nothing above it.
    mkdirSync(join(tmp, 'solo'))
    writeFileSync(join(tmp, 'solo', 'Cargo.toml'), '[package]\nname = "solo"\nversion = "0.1.0"\n')
    t.assert.equal(findCargoLock(join(tmp, 'solo')), null)
    writeFileSync(join(tmp, 'solo', 'Cargo.lock'), 'version = 3\n')
    t.assert.equal(findCargoLock(join(tmp, 'solo')), join(tmp, 'solo', 'Cargo.lock'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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
    'vendor/md-5': [],
    'vendor/winnowish': ['default', 'std'], // 0.6.1, via app
    'vendor/winnowish-0.5.0': ['default', 'std'], // 0.5.0, via lib-a
    // serde: optional and never enabled; proptest: a dev-dependency, out of a resolver-2 build
  })
  // An integration-test entry is `cargo test`'s build: the package's dev-dependencies join, with their features.
  const testBuild = createCargoContext(featuresFixture, { entries: ['tests/it.rs'] })
  t.assert.deepEqual(enabledOf(testBuild)['vendor/proptest'], ['default', 'std'])
  t.assert.equal(testBuild.isTestTarget('tests/it.rs'), true)
  t.assert.equal(testBuild.isTestTarget('src/main.rs'), false)
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
  // `md-5` is used as `md5`: its `[lib] name` differs from the package name
  t.assert.equal(cargo.resolveCrate('md5', 'src/main.rs'), 'vendor/md-5/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('md5', 'crates/tools/src/lib.rs'), 'vendor/md-5/src/lib.rs') // no manifest declares it: by vendored lib name
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

test('createCargoContext applies a bare --cargo-features name to every root package that has it', (t) => {
  withProject({
    'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
    'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[features]\nserde = []\n',
    'a/src/lib.rs': '',
    'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n[features]\nserde = []\n',
    'b/src/lib.rs': '',
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['a/src/lib.rs', 'b/src/lib.rs'], features: ['serde'] })
    t.assert.deepEqual(enabledOf(cargo), { a: ['serde'], b: ['serde'] })
  })
})

test('createCargoContext keeps a target-specific dependency table apart from the plain one', (t) => {
  withProject({
    'Cargo.toml': ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"',
      '[dependencies]', 'dep = "1"',
      "[target.'cfg(unix)'.dependencies]", 'dep = { version = "1", default-features = false, optional = true }',
      "[target.'cfg(windows)'.dependencies]", 'win = "1"'].join('\n'),
    'src/main.rs': '',
    'vendor/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\n[features]\ndefault = ["std"]\nstd = []\n',
    'vendor/dep/src/lib.rs': '',
    'vendor/win/Cargo.toml': '[package]\nname = "win"\nversion = "1.0.0"\n[features]\ndefault = ["api"]\napi = []\n',
    'vendor/win/src/lib.rs': '',
  }, (tmp) => {
    // The plain `dep = "1"` keeps its defaults and stays in the graph; the unix table's optional,
    // default-less request is a second one. A target-only dependency is built only maybe (the
    // target's cfgs are unknown): its features are on only maybe, neither on nor off.
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.deepEqual(enabledOf(cargo), { '.': [], 'vendor/dep': ['default', 'std'] })
    t.assert.deepEqual(maybeOf(cargo), { 'vendor/win': ['api', 'default'] })
  })
})

test('createCargoContext picks the feature resolver from a workspace-inherited edition', (t) => {
  const files = (edition) => ({
    'Cargo.toml': ['[workspace]', '[workspace.package]', `edition = "${edition}"`, '[package]', 'name = "app"', 'version = "0.1.0"', 'edition.workspace = true',
      '[dev-dependencies]', 'devdep = "1"'].join('\n'),
    'src/main.rs': '',
    'vendor/devdep/Cargo.toml': '[package]\nname = "devdep"\nversion = "1.0.0"\n',
    'vendor/devdep/src/lib.rs': '',
  })
  // edition 2021 → resolver 2: the root's dev-dependencies stay out of a normal build
  withProject(files('2021'), (tmp) => t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'] })), { '.': [] }))
  // edition 2018 → resolver 1: they join
  withProject(files('2018'), (tmp) => t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'] })), { '.': [], 'vendor/devdep': [] }))
})

test('createCargoContext takes the feature resolver from the build\'s workspace, never from a vendored crate an entry is in', (t) => {
  // cargo runs in app/ (edition 2021: resolver 2), whatever the edition of the vendored crate the
  // first entry is in (2015: resolver 1): the root's dev-dependencies stay out of a normal build
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nold = "1"\n[dev-dependencies]\ndevdep = "1"\n',
    'src/main.rs': '',
    'vendor/old/Cargo.toml': '[package]\nname = "old"\nversion = "1.0.0"\nedition = "2015"\n', 'vendor/old/src/lib.rs': '',
    'vendor/devdep/Cargo.toml': '[package]\nname = "devdep"\nversion = "1.0.0"\n', 'vendor/devdep/src/lib.rs': '',
  }, (tmp) => t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['vendor/old/src/lib.rs', 'src/main.rs'] })), { '.': [], 'vendor/old': [] }))
})

test('createCargoContext applies a weak `dep?/feat` once the dependency is active, whichever table activates it', (t) => {
  const files = (deps) => ({
    'Cargo.toml': ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"',
      '[features]', 'default = ["std"]', 'std = ["dep?/std"]', 'with-dep = ["dep:dep"]', ...deps].join('\n'),
    'src/main.rs': '',
    'vendor/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\n[features]\nstd = []\n',
    'vendor/dep/src/lib.rs': '',
  })
  // optional and inactive: the weak feature asks nothing
  withProject(files(['[dependencies]', 'dep = { version = "1", optional = true }']), (tmp) => {
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'] })), { '.': ['default', 'std'] })
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'], features: ['with-dep'] })), { '.': ['default', 'std', 'with-dep'], 'vendor/dep': ['std'] })
  })
  // optional in one table, required in another: active from the start
  withProject(files(['[dependencies]', 'dep = { version = "1", optional = true }', '[build-dependencies]', 'dep = { version = "1", default-features = false }']), (tmp) => {
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'] }), 'host'), { 'vendor/dep': ['std'] })
  })
  // optional, and required only on a target: without one, the target table makes the dependency's `std` a maybe
  withProject(files(['[dependencies]', 'dep = { version = "1", optional = true }', "[target.'cfg(unix)'.dependencies]", 'dep = { version = "1", default-features = false }']), (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.deepEqual(enabledOf(cargo), { '.': ['default', 'std'] })
    t.assert.deepEqual(maybeOf(cargo), { 'vendor/dep': ['std'] })
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX })), { '.': ['default', 'std'], 'vendor/dep': ['std'] })
  })
  // `dep?/std` of a dependency no table makes optional is a manifest cargo refuses
  withProject(files(['[dependencies]', 'dep = { version = "1", default-features = false }']), (tmp) => {
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/main.rs'] }).featuresFor('src/main.rs'), { name: 'LockfileError', message: 'Cargo.toml: features.std: "dep?/std" names "dep", which is not an optional dependency' })
  })
})

test('createCargoContext applies a weak `dep?/feat` from --cargo-features once `default` has activated the dependency', (t) => {
  withProject({
    'Cargo.toml': ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"',
      '[features]', 'default = ["with-dep"]', 'with-dep = ["dep:dep"]',
      '[dependencies]', 'dep = { version = "1", optional = true }'].join('\n'),
    'src/main.rs': '',
    'vendor/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\n[features]\nstd = []\n',
    'vendor/dep/src/lib.rs': '',
  }, (tmp) => {
    // `dep` is activated by `default` inside the fixed-point loop; the flag has to wait for it.
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'], features: ['dep?/std'] })), { '.': ['default', 'with-dep'], 'vendor/dep': ['std'] })
    // and asks nothing while the dependency stays inactive
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/main.rs'], features: ['dep?/std'], noDefaultFeatures: true })), { '.': [] })
  })
})

test('createCargoContext honours the root feature flags: --features (incl. pkg/feat), --no-default-features, --all-features', (t) => {
  const withSerde = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['with-serde'] })
  t.assert.deepEqual(enabledOf(withSerde), {
    '.': ['default', 'fast', 'with-serde'],
    'crates/lib-a': ['default', 'extra', 'extra-dep', 'serde', 'std'], // `lib-a/serde` from with-serde
    'vendor/extra-dep': [],
    'vendor/md-5': [],
    'vendor/serde': ['default', 'std'], // `dep:serde` activated the optional dep
    'vendor/winnowish': ['default', 'std'],
    'vendor/winnowish-0.5.0': ['default', 'std'],
  })
  const scoped = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['app/with-serde'] })
  t.assert.deepEqual(enabledOf(scoped)['.'], ['default', 'fast', 'with-serde'])
  // cargo's `dep/feat` form: a feature of a dependency of the root, not of a root package named `dep`
  const depFeat = createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['lib-a/serde'] })
  t.assert.deepEqual(enabledOf(depFeat)['crates/lib-a'], ['default', 'extra', 'extra-dep', 'serde', 'std'])
  t.assert.deepEqual(enabledOf(depFeat)['vendor/serde'], ['default', 'std'])
  t.assert.deepEqual(enabledOf(depFeat)['.'], ['default', 'fast'])
  // an unknown name is reported, not silently dropped
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    createCargoContext(featuresFixture, { entries: ['src/main.rs'], features: ['nope/x', 'bogus'] }).resolvedFeatures()
  } finally {
    console.warn = original
  }
  t.assert.deepEqual(warnings, [
    "[stasis] --cargo-features: 'nope/x' names no feature of the entries' packages, nor a dependency of theirs",
    "[stasis] --cargo-features: 'bogus' names no feature of the entries' packages, nor a dependency of theirs",
  ])

  const noDefault = createCargoContext(featuresFixture, { entries: ['src/main.rs'], noDefaultFeatures: true })
  t.assert.deepEqual(enabledOf(noDefault)['.'], [])
  t.assert.deepEqual(enabledOf(noDefault)['crates/lib-a'], ['default', 'extra', 'extra-dep', 'std']) // deps keep their own defaults

  const all = createCargoContext(featuresFixture, { entries: ['src/main.rs'], allFeatures: true })
  t.assert.deepEqual(enabledOf(all)['.'], ['default', 'fast', 'with-serde'])
  t.assert.deepEqual(enabledOf(all)['vendor/serde'], ['default', 'std'])
})

test('createCargoContext unifies the root\'s dev-dependency features under resolver 1 (edition 2018) but not resolver 2, and never a dependency\'s own', (t) => {
  const v1 = createCargoContext(join(fixtures, 'features-v1'), { entries: ['src/main.rs'] })
  // devonly's own `[dev-dependencies] other = { features = ["y"] }` is nobody's build: `other` stays out.
  t.assert.deepEqual(enabledOf(v1), { '.': [], 'vendor/devonly': ['x'] })
  // features (resolver 2): lib-a's `[dev-dependencies] winnowish = { features = ["debug"] }` doesn't reach winnowish 0.5.0
  const v2 = createCargoContext(featuresFixture, { entries: ['src/main.rs'] })
  t.assert.deepEqual(enabledOf(v2)['vendor/winnowish-0.5.0'], ['default', 'std'])
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
    t.assert.deepEqual([...cargo.featureResolution().keys()].toSorted(), ['crates/app', 'crates/tools', 'crates/util'])
    // metadata's one feature set per package is every build's union: each feature in it on only maybe
    t.assert.deepEqual(enabledOf(cargo), {})
    t.assert.equal(cargo.resolveCrate('util', 'crates/app/src/main.rs'), 'crates/util/src/util_lib.rs')
    t.assert.equal(cargo.resolveCrate('tools', 'crates/app/src/main.rs'), 'crates/tools/src/lib.rs')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createCargoContext({ cargo: true }) fails loudly when cargo cannot run', { skip: hasCargo ? 'cargo is on PATH' : false }, (t) => {
  t.assert.throws(() => createCargoContext(featuresFixture, { entries: ['src/main.rs'], cargo: true }), /cargo metadata could not run/u)
})

test('parseCargoManifest reads [package] build', (t) => {
  t.assert.equal(parseCargoManifest('[package]\nname = "a"\nversion = "0.1.0"\nbuild = "build/main.rs"\n').package.build, 'build/main.rs')
  t.assert.equal(parseCargoManifest('[package]\nname = "a"\nversion = "0.1.0"\nbuild = false\n').package.build, false)
  t.assert.equal(parseCargoManifest('[package]\nname = "a"\nversion = "0.1.0"\n').package.build, null)
})

test('createCargoContext names each package\'s manifests, build script, and the lockfile and cargo configs that apply', (t) => {
  withProject({
    'Cargo.toml': '[workspace]\nmembers = ["crates/app", "crates/nobuild"]\n',
    'Cargo.lock': 'version = 3\n',
    '.cargo/config.toml': '[build]\ntarget-dir = "out"\n',
    'crates/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'crates/app/build.rs': 'fn main() {}\n',
    'crates/app/src/main.rs': '',
    'crates/nobuild/Cargo.toml': '[package]\nname = "nobuild"\nversion = "0.1.0"\nedition = "2021"\nbuild = false\n',
    'crates/nobuild/build.rs': 'fn main() {}\n',
    'crates/nobuild/src/lib.rs': '',
    'vendor/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\nbuild = "scripts/build.rs"\n',
    'vendor/dep/.cargo-checksum.json': '{"files":{},"package":"0"}',
    'vendor/dep/Cargo.lock': 'version = 3\n', // as published: not the build's
    'vendor/dep/.cargo/config.toml': '[build]\n',
    'vendor/dep/scripts/build.rs': 'fn main() {}\n',
    'vendor/dep/src/lib.rs': '',
    'vendor/plain/Cargo.toml': '[package]\nname = "plain"\nversion = "1.0.0"\n',
    'vendor/plain/src/lib.rs': '',
    'loose.rs': '',
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['crates/app/src/main.rs'] })
    const paths = (file) => cargo.buildFilesFor(file).map((f) => `${f.kind}:${f.path}`)
    t.assert.deepEqual(paths('crates/app/src/main.rs'), ['manifest:crates/app/Cargo.toml', 'manifest:Cargo.toml', 'lock:Cargo.lock', 'config:.cargo/config.toml'])
    // A vendored crate: its manifest and the checksums cargo checks it against, never the lock or
    // config it was published with (the build's are the workspace's, carried with its packages).
    t.assert.deepEqual(paths('vendor/dep/src/lib.rs'), ['manifest:vendor/dep/Cargo.toml', 'checksum:vendor/dep/.cargo-checksum.json'])
    t.assert.deepEqual(paths('vendor/plain/src/lib.rs'), ['manifest:vendor/plain/Cargo.toml'])
    t.assert.deepEqual(paths('loose.rs'), []) // no [package] claims it: the root manifest is a bare [workspace]
    t.assert.equal(cargo.buildScriptOf('crates/app/src/main.rs'), 'crates/app/build.rs')
    t.assert.equal(cargo.buildScriptOf('crates/nobuild/src/lib.rs'), null) // `build = false`
    t.assert.equal(cargo.buildScriptOf('vendor/dep/src/lib.rs'), 'vendor/dep/scripts/build.rs')
    t.assert.equal(cargo.buildScriptOf('vendor/plain/src/lib.rs'), null) // no build.rs on disk
    t.assert.equal(cargo.buildScriptOf('loose.rs'), null)
    t.assert.equal(cargo.isVendored('vendor/dep/src/lib.rs'), true)
    t.assert.equal(cargo.isVendored('crates/app/src/main.rs'), false)
    // A member bundled on its own: the workspace's lockfile lies above the bundle root.
    const member = createCargoContext(join(tmp, 'crates/app'), { entries: ['src/main.rs'] })
    t.assert.deepEqual(member.buildFilesFor('src/main.rs'), [{ path: 'Cargo.toml', kind: 'manifest' }])
  })
  // A workspace nested below the bundle root: its lockfile, and the configs of its directory and
  // of every one above it up to the bundle root, which cargo reads too.
  withProject({
    '.cargo/config.toml': '[net]\n',
    'rust/Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'rust/Cargo.lock': 'version = 3\n',
    'rust/.cargo/config': '[build]\n', // the extensionless file, which cargo prefers when both exist
    'rust/.cargo/config.toml': '[build]\n',
    'rust/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'rust/app/src/main.rs': '',
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['rust/app/src/main.rs'] })
    t.assert.deepEqual(cargo.buildFilesFor('rust/app/src/main.rs').map((f) => f.path), ['rust/app/Cargo.toml', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/.cargo/config', '.cargo/config.toml'])
  })
})

test('buildRustBundle --cargo-manifests carries the manifests, lockfile and cargo config as written, or refuses them', async (t) => {
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = { git = "https://x-access-token:TOKEN@github.com/o/foo.git", branch = "main" }\n',
    'Cargo.lock': 'version = 3\n\n[[package]]\nname = "foo"\nversion = "1.0.0"\nsource = "git+https://x-access-token:TOKEN@github.com/o/foo.git?branch=main&access_token=TOKEN#0123abcd"\n',
    '.cargo/config.toml': '# vendoring\n[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n[registries.private]\ntoken = "t0k3n"\n[target.x86_64-unknown-linux-gnu]\nrunner = "qemu-x86_64"\n',
    'src/main.rs': 'fn main() {}\n',
  }
  await withProjectAsync(files, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true })
    // Byte for byte, whatever they hold: stasis doesn't edit what it carries.
    for (const p of ['Cargo.toml', 'Cargo.lock', '.cargo/config.toml']) t.assert.equal(bundle.sources.get(p), files[p], p)
    // A file that isn't UTF-8 text can't be carried as written: refused, not altered.
    writeFileSync(join(tmp, 'Cargo.lock'), Buffer.concat([Buffer.from('version = 3\n# '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]))
    await t.assert.rejects(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true }), { message: 'Rust manifest is not valid UTF-8: Cargo.lock' })
  })
})

test('buildRustBundle holds a vendored crate\'s includes, #[path]s and build script to its own package', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nevil = "1"\n',
    '.git/config': '[remote "origin"]\n\turl = https://user:token@example.com/repo.git\n',
    '.env': 'SECRET=1\n',
    'secret.rs': 'pub const KEY: &str = "k";\n',
    'LICENSE': 'MIT\n',
    'src/main.rs': 'use evil::f;\nconst L: &str = include_str!("../LICENSE");\n',
    'vendor/evil/Cargo.toml': '[package]\nname = "evil"\nversion = "1.0.0"\nbuild = "../../.env"\n',
    'vendor/evil/src/lib.rs': [
      'pub fn f() {}',
      'const A: &str = include_str!("../../../.git/config");',
      'const B: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env"));',
      '#[cfg(steal)]', // gated on a cfg the loader can't decide: tolerated when nothing is found
      '#[path = "../../../secret.rs"]',
      'mod stolen;',
      'const OK: &str = include_str!("../README.md");',
      'mod fine;',
    ].join('\n'),
    'vendor/evil/README.md': 'evil\n',
    'vendor/evil/src/fine.rs': '',
  }, async (tmp) => {
    const { result: bundle, warnings } = await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true }))
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), [
      'Cargo.toml', 'LICENSE', 'src/main.rs', // the project's own include may reach anywhere in the root
      'vendor/evil/Cargo.toml', 'vendor/evil/README.md', 'vendor/evil/src/fine.rs', 'vendor/evil/src/lib.rs',
    ])
    t.assert.ok(warnings.some((w) => w.includes('Refusing include outside its package: ../../../.git/config from vendor/evil/src/lib.rs')), warnings.join('\n'))
    t.assert.ok(warnings.some((w) => w.includes('Refusing include outside its package: ../../.env from vendor/evil/src/lib.rs')), warnings.join('\n'))
    t.assert.ok(warnings.some((w) => w.includes('Refusing build script outside its package: ../../.env in vendor/evil')), warnings.join('\n'))
    // Without the gate, a `#[path]` outside the package is a missing module: fatal for the bundle.
    writeFileSync(join(tmp, 'vendor/evil/src/lib.rs'), '#[path = "../../../secret.rs"]\nmod stolen;\n')
    await t.assert.rejects(
      () => captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true })),
      /Unresolved module: mod stolen from vendor\/evil\/src\/lib\.rs/u,
    )
  })
})

test('buildRustBundle holds a vendored crate to its package through symlinks, an inline module\'s #[path] and its [lib] path', { skip: process.platform === 'win32' ? 'symlinks' : false }, async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nevil = "1"\nevil2 = "1"\n',
    '.env': 'SECRET=1\n',
    'private_mod.rs': 'pub const KEY: u8 = 1;\n',
    'outside_dir/mod.rs': 'pub const OUT: u8 = 2;\n',
    'src/main.rs': 'use evil::f;\nuse evil2::g;\n',
    'vendor/evil/Cargo.toml': '[package]\nname = "evil"\nversion = "1.0.0"\n',
    'vendor/evil/src/lib.rs': [
      'pub fn f() {}',
      '#[cfg(steal)] #[path = "../../.."] mod m { mod private_mod; }', // an inline module's #[path] climbing out: refused (gated: tolerated)
      '#[cfg(steal)] mod linked_file;', // a symlink to a project file
      '#[cfg(steal)] mod linked_dir;', // a symlink to a project directory
      '#[cfg(steal)] const E: &str = include_str!("env_link");', // a symlink to the project's .env
    ].join('\n'),
    'vendor/evil2/Cargo.toml': '[package]\nname = "evil2"\nversion = "1.0.0"\n[lib]\npath = "../../private_mod.rs"\n',
  }, async (tmp) => {
    symlinkSync(join(tmp, 'private_mod.rs'), join(tmp, 'vendor/evil/src/linked_file.rs'))
    symlinkSync(join(tmp, 'outside_dir'), join(tmp, 'vendor/evil/src/linked_dir'))
    symlinkSync(join(tmp, '.env'), join(tmp, 'vendor/evil/src/env_link'))
    const { result: bundle, warnings } = await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true }))
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['Cargo.toml', 'src/main.rs', 'vendor/evil/Cargo.toml', 'vendor/evil/src/lib.rs'])
    for (const expected of [
      'Refusing file outside its package: vendor/evil/src/linked_file.rs (a link out of vendor/evil)',
      'Refusing file outside its package: vendor/evil/src/linked_dir/mod.rs (a link out of vendor/evil)',
      'Refusing file outside its package: vendor/evil/src/env_link (a link out of vendor/evil)',
      'Refusing lib path outside its package: ../../private_mod.rs in vendor/evil2',
    ]) t.assert.ok(warnings.some((w) => w.includes(expected)), `${expected}\n${warnings.join('\n')}`)
    t.assert.ok(!warnings.some((w) => w.includes('private_mod.rs') && w.includes('Refusing file')), warnings.join('\n')) // the inline #[path] never names it: no file to refuse
    // Ungated, every refused module is missing: fatal.
    writeFileSync(join(tmp, 'vendor/evil/src/lib.rs'), 'pub fn f() {}\n#[path = "../../.."] mod m { mod private_mod; }\nmod linked_file;\nmod linked_dir;\n')
    await t.assert.rejects(
      () => captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'], cargoManifests: true })),
      /Unresolved module: mod m::private_mod from vendor\/evil\/src\/lib\.rs[\s\S]*mod linked_file[\s\S]*mod linked_dir/u,
    )
  })
})

test('buildRustBundle scans a file named by both `mod` and `include_str!` as Rust', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'const SRC: &str = include_str!("shown.rs");\nmod shown;\nmod util;\n',
    'src/shown.rs': 'use crate::util::helper;\npub fn f() { helper() }\n',
    'src/util.rs': 'pub fn helper() {}\n',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.equal(bundle.formats.get('src/shown.rs'), 'rust') // a module first, its text second
    t.assert.deepEqual(Object.fromEntries(bundle.imports.get('rust').get('src/shown.rs')), { 'crate::util::helper': 'src/util.rs' })
    t.assert.deepEqual(Object.fromEntries(bundle.imports.get('rust').get('src/lib.rs')), { 'include_str shown.rs': 'src/shown.rs', 'mod shown': 'src/shown.rs', 'mod util': 'src/util.rs' })
    // Named the other way round, too.
    writeFileSync(join(tmp, 'src/lib.rs'), 'mod util;\nmod shown;\nconst SRC: &str = include_str!("shown.rs");\n')
    const swapped = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.equal(swapped.formats.get('src/shown.rs'), 'rust')
  })
})

test('buildRustBundle --cargo-manifests compiles build scripts for the host, not --cargo-target', async (t) => {
  await withProjectAsync({
    'Cargo.toml': [
      '[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"', 'build = "build.rs"',
      "[target.'cfg(windows)'.dependencies]", 'win = "1"',
      "[target.'cfg(windows)'.build-dependencies]", 'winbuild = "1"',
    ].join('\n'),
    'build.rs': '#[cfg(windows)]\nmod registry;\nfn main() { winbuild::probe(); }\n',
    'registry.rs': '',
    'src/lib.rs': '#[cfg(windows)]\nmod win;\n#[cfg(windows)]\nfn f() { win::g(); }\n',
    'src/win.rs': 'pub fn g() {}\n',
    'vendor/win/Cargo.toml': '[package]\nname = "win"\nversion = "1.0.0"\n',
    'vendor/win/src/lib.rs': '',
    'vendor/winbuild/Cargo.toml': '[package]\nname = "winbuild"\nversion = "1.0.0"\n',
    'vendor/winbuild/src/lib.rs': 'pub fn probe() {}\n',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoManifests: true, cargoTarget: LINUX })
    // The library drops its Windows module; the build script keeps its own (the host may be Windows),
    // and its Windows-only build-dependency counts.
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['Cargo.toml', 'build.rs', 'registry.rs', 'src/lib.rs', 'vendor/winbuild/Cargo.toml', 'vendor/winbuild/src/lib.rs'])
    const edges = bundle.imports.get('rust')
    t.assert.deepEqual(Object.fromEntries(edges.get('build.rs')), { 'mod registry': 'registry.rs', 'use winbuild': 'vendor/winbuild/src/lib.rs' })
    t.assert.deepEqual(Object.fromEntries(edges.get('src/lib.rs')), {})
  })
})

test('buildRustBundle --cargo-manifests carries manifests, the lockfile and cargo config, and walks build scripts as crate roots', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'Cargo.lock': 'version = 3\n',
    '.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n',
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\ndep = "1"\n[build-dependencies]\ncc = "1"\n',
    'app/build.rs': 'mod gen;\nfn main() { cc::Build::new(); gen::run(); }\n',
    'app/gen.rs': 'pub fn run() {}\n',
    'app/src/main.rs': 'fn main() { dep::f(); }\n',
    'vendor/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\n[build-dependencies]\nautocfg = "1"\n',
    'vendor/dep/build.rs': 'fn main() { autocfg::new(); }\n',
    'vendor/dep/src/lib.rs': 'pub fn f() {}\n',
    'vendor/cc/Cargo.toml': '[package]\nname = "cc"\nversion = "1.0.0"\n',
    'vendor/cc/src/lib.rs': 'pub struct Build;\n',
    'vendor/autocfg/Cargo.toml': '[package]\nname = "autocfg"\nversion = "1.0.0"\n',
    'vendor/autocfg/src/lib.rs': 'pub fn new() {}\n',
    'vendor/unused/Cargo.toml': '[package]\nname = "unused"\nversion = "1.0.0"\n',
    'vendor/unused/src/lib.rs': '',
  }, async (tmp) => {
    const plain = await buildRustBundle({ cwd: tmp, entries: ['app/src/main.rs'] })
    t.assert.deepEqual([...plain.sources.keys()].toSorted(), ['app/src/main.rs', 'vendor/dep/src/lib.rs'])
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['app/src/main.rs'], cargoManifests: true })
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), [
      '.cargo/config.toml', 'Cargo.lock', 'Cargo.toml',
      'app/Cargo.toml', 'app/build.rs', 'app/gen.rs', 'app/src/main.rs',
      'vendor/autocfg/Cargo.toml', 'vendor/autocfg/src/lib.rs', // dep's build-dependency, through dep's build script
      'vendor/cc/Cargo.toml', 'vendor/cc/src/lib.rs', // app's build-dependency, through app's build script
      'vendor/dep/Cargo.toml', 'vendor/dep/build.rs', 'vendor/dep/src/lib.rs',
    ])
    t.assert.equal(bundle.formats.get('app/Cargo.toml'), 'resource')
    t.assert.equal(bundle.formats.get('Cargo.lock'), 'resource')
    t.assert.equal(bundle.formats.get('.cargo/config.toml'), 'resource')
    t.assert.equal(bundle.formats.get('app/build.rs'), 'rust')
    t.assert.equal(bundle.entries.has('app/build.rs'), false) // a crate root of the walk, not an entry of the bundle
    const edges = bundle.imports.get('rust')
    t.assert.deepEqual(Object.fromEntries(edges.get('app/build.rs')), { 'mod gen': 'app/gen.rs', 'gen::run': 'app/gen.rs', 'use cc': 'vendor/cc/src/lib.rs' })
    t.assert.deepEqual(Object.fromEntries(edges.get('vendor/dep/build.rs')), { 'use autocfg': 'vendor/autocfg/src/lib.rs' })
    // Buckets: each manifest sits with its package; the root-level files in the workspace bucket.
    t.assert.deepEqual(Object.keys(bundle.modules.get('vendor/dep').files).toSorted(), ['Cargo.toml', 'build.rs', 'src/lib.rs'])
    t.assert.equal(bundle.modules.get('vendor/dep').ecosystem, 'cargo')
    t.assert.deepEqual(Object.keys(bundle.modules.get('app').files).toSorted(), ['Cargo.toml', 'build.rs', 'gen.rs', 'src/main.rs'])
    t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['.cargo/config.toml', 'Cargo.lock', 'Cargo.toml'])
  })
})

test('parseRustcCfg reads rustc --print cfg output as a set of leaves', (t) => {
  t.assert.deepEqual([...parseRustcCfg('debug_assertions\npanic="unwind"\ntarget_os="linux"\n\nunix\n')], ['debug_assertions', 'panic="unwind"', 'target_os="linux"', 'unix'])
})

// A Linux target as rustc would describe it, for tests that must not depend on rustc.
const LINUX = { triple: 'x86_64-unknown-linux-gnu', cfgs: new Set(['unix', 'target_os="linux"', 'target_family="unix"', 'target_arch="x86_64"', 'target_env="gnu"', 'target_pointer_width="64"']) }

test('createCargoContext decides target-specific dependency tables when the target is known', (t) => {
  const files = {
    'Cargo.toml': ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"',
      "[target.'cfg(windows)'.dependencies]", 'win = "1"',
      "[target.'cfg(unix)'.dependencies]", 'nix = "1"',
      '[target.x86_64-unknown-linux-gnu.dependencies]', 'gnu = "1"',
      '[target.aarch64-apple-darwin.dependencies]', 'mac = "1"',
      "[target.'cfg(loom)'.dependencies]", 'loom = "1"'].join('\n'),
    'src/main.rs': '',
  }
  for (const name of ['win', 'nix', 'gnu', 'mac', 'loom']) {
    files[`vendor/${name}/Cargo.toml`] = `[package]\nname = "${name}"\nversion = "1.0.0"\n[features]\ndefault = ["std"]\nstd = []\n`
    files[`vendor/${name}/src/lib.rs`] = ''
  }
  withProject(files, (tmp) => {
    // Without a target every table's dependency is built only maybe.
    const none = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.deepEqual(Object.keys(enabledOf(none)), ['.'])
    t.assert.deepEqual(Object.keys(maybeOf(none)), ['vendor/gnu', 'vendor/loom', 'vendor/mac', 'vendor/nix', 'vendor/win'])
    const linux = createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX })
    t.assert.equal(linux.targetTriple, 'x86_64-unknown-linux-gnu')
    t.assert.ok(linux.targetCfgs.has('unix'))
    // `cfg(loom)` is a custom cfg the loader can't decide: its dependency is built only maybe.
    t.assert.deepEqual(Object.keys(enabledOf(linux)), ['.', 'vendor/gnu', 'vendor/nix'])
    t.assert.deepEqual(Object.keys(maybeOf(linux)), ['vendor/loom'])
    const plain = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.equal(plain.targetTriple, null)
    t.assert.equal(plain.targetCfgs, null)
  })
})

// A crate whose lib declares one module per platform and one per state of its `std` feature.
const platformCrate = (name, extra = '') => ({
  [`vendor/${name}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "1.0.0"\n${extra}[features]\ndefault = ["std"]\nstd = []\n`,
  [`vendor/${name}/src/lib.rs`]: '#[cfg(windows)]\nmod win;\n#[cfg(unix)]\nmod nix;\n#[cfg(feature = "std")]\nmod with_std;\n#[cfg(not(feature = "std"))]\nmod no_std;\n',
  [`vendor/${name}/src/win.rs`]: '',
  [`vendor/${name}/src/nix.rs`]: '',
  [`vendor/${name}/src/with_std.rs`]: '',
  [`vendor/${name}/src/no_std.rs`]: '',
})
const bundled = (bundle, name) => [...bundle.sources.keys()].filter((p) => p.startsWith(`vendor/${name}/src/`)).map((p) => p.slice(`vendor/${name}/src/`.length)).toSorted()

test('buildRustBundle compiles proc-macro crates and what they depend on for the host, not the target', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\npm = "1"\nlib = "1"\n',
    'src/lib.rs': 'pub use pm::Derive;\npub use lib::f;\n',
    'vendor/pm/Cargo.toml': '[package]\nname = "pm"\nversion = "1.0.0"\n[lib]\nproc-macro = true\n[dependencies]\nhelper = "1"\n',
    'vendor/pm/src/lib.rs': '#[cfg(windows)]\nmod win;\n#[cfg(unix)]\nmod nix;\nuse helper::x;\n',
    'vendor/pm/src/win.rs': '',
    'vendor/pm/src/nix.rs': '',
    ...platformCrate('helper'),
    ...platformCrate('lib'),
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX })
    // The target's cfgs decide the target's code only; the host (a Linux target says nothing of it) keeps every platform.
    t.assert.deepEqual(bundled(bundle, 'lib'), ['lib.rs', 'nix.rs', 'with_std.rs'])
    t.assert.deepEqual(bundled(bundle, 'pm'), ['lib.rs', 'nix.rs', 'win.rs'])
    t.assert.deepEqual(bundled(bundle, 'helper'), ['lib.rs', 'nix.rs', 'win.rs', 'with_std.rs'])
    // `--cargo-target=host` says the host is the target: then its cfgs decide the host's code too.
    const cargo = createCargoContext(tmp, { entries: ['src/lib.rs'], target: 'host' })
    t.assert.equal(cargo.platformOf('host|host'), cargo.platformOf('target|target'))
  })
})

test('buildRustBundle keeps what a crate built both for the target and for a build script compiles as either', async (t) => {
  const files = (edition) => ({
    'Cargo.toml': `[package]\nname = "app"\nversion = "0.1.0"\nedition = "${edition}"\n[dependencies]\nshared = { version = "1", default-features = false }\n[build-dependencies]\nshared = "1"\n`,
    'build.rs': 'use shared::f;\nfn main() {}\n',
    'src/lib.rs': 'pub use shared::f;\n',
    ...platformCrate('shared'),
  })
  // Resolver 2: the build script's `shared` has `std`, the target's hasn't; the host's platform is unknown.
  await withProjectAsync(files('2021'), async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX, cargoManifests: true })
    t.assert.deepEqual(bundled(bundle, 'shared'), ['lib.rs', 'nix.rs', 'no_std.rs', 'win.rs', 'with_std.rs'])
    const cargo = createCargoContext(tmp, { entries: ['src/lib.rs'] })
    t.assert.deepEqual([enabledOf(cargo)['vendor/shared'], enabledOf(cargo, 'host')['vendor/shared']], [[], ['default', 'std']])
    // Without the build script in the bundle, `shared` is the target's alone: `no_std` is what it compiles.
    const lib = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX })
    t.assert.deepEqual(bundled(lib, 'shared'), ['lib.rs', 'nix.rs', 'no_std.rs'])
  })
  // Resolver 1 unifies the two: `std` is on for both.
  await withProjectAsync(files('2018'), async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX })
    t.assert.deepEqual(bundled(bundle, 'shared'), ['lib.rs', 'nix.rs', 'with_std.rs'])
  })
})

test('buildRustBundle walks a crate root the tree asks for as what the asking code is compiled as', async (t) => {
  // The build script binds `log` as a fn, so the walk doesn't load the crate; the tree finds
  // `log::info!` names it and asks for it -- from code compiled for the host.
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[build-dependencies]\nlog = "1"\n',
    'build.rs': 'mod util;\nuse crate::util::log;\nfn main() { log(); log::info!("x"); }\n',
    'util.rs': 'pub fn log() {}\n',
    'src/lib.rs': '',
    ...platformCrate('log'),
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX, cargoManifests: true })
    t.assert.deepEqual(bundled(bundle, 'log'), ['lib.rs', 'nix.rs', 'win.rs', 'with_std.rs'])
  })
})

test('buildRustBundle does not presume off a custom cfg the build script or the rustflags may set', async (t) => {
  const project = (extra) => ({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'mod fast;\nmod slow;\nmod user;\n#[cfg(fast)] pub use fast::F;\n#[cfg(not(fast))] pub use slow::F;\n',
    'src/fast.rs': 'pub struct F;\n',
    'src/slow.rs': 'pub struct F;\n',
    'src/user.rs': 'fn f() { crate::F; }\n',
    ...extra,
  })
  const target = async (extra) => withProjectAsync(project(extra), async (tmp) => (await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })).imports.get('rust').get('src/user.rs').get('crate::F'))
  // Nothing sets `fast`: a default build lacks it, so `not(fast)`'s is the answer.
  t.assert.equal(await target({}), 'src/slow.rs')
  t.assert.equal(await target({ 'build.rs': 'fn main() { println!("cargo:rustc-check-cfg=cfg(fast)"); }\n' }), 'src/slow.rs') // declared, not set
  // The build script may set it (literally, through a module of its own, or under a name it
  // formats), or the rustflags do: neither is presumed, and the edge is both, each under its cfg.
  const either = new Map([['fast', 'src/fast.rs'], ['not(fast)', 'src/slow.rs']])
  t.assert.deepEqual(await target({ 'build.rs': 'fn main() { println!("cargo:rustc-cfg=fast"); }\n' }), either)
  t.assert.deepEqual(await target({ 'build.rs': 'mod probe;\nfn main() { probe::run() }\n', 'probe.rs': 'pub fn run() { println!("cargo::rustc-cfg=fast"); }\n' }), either)
  t.assert.deepEqual(await target({ 'build.rs': 'fn main() { let n = "fast"; println!("cargo:rustc-cfg={n}"); }\n' }), either)
  t.assert.deepEqual(await target({ '.cargo/config.toml': '[build]\nrustflags = ["--cfg", "fast"]\n' }), either)
  t.assert.deepEqual(await target({ '.cargo/config.toml': "[target.'cfg(unix)']\nrustflags = \"--cfg=fast\"\n" }), either)
})

test('buildRustBundle resolves a macro\'s include against the outermost call, and keeps every same-named macro\'s assets', async (t) => {
  // `outer!()` in sub/mod.rs expands `inner!()`, whose `include_str!` rustc resolves beside the
  // outermost call site -- sub/data.txt -- not beside m.rs, where `inner!` is written.
  await withProjectAsync({
    'src/lib.rs': '#[macro_use]\nmod m;\nmod sub;\n',
    'src/m.rs': 'macro_rules! outer { () => { inner!(); } }\nmacro_rules! inner { () => { const X: &str = include_str!("data.txt"); } }\n',
    'src/sub/mod.rs': 'outer!();\n',
    'src/sub/data.txt': 'right\n',
    'src/data.txt': 'wrong\n',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.ok(bundle.sources.has('src/sub/data.txt'))
    t.assert.ok(!bundle.sources.has('src/data.txt'))
    t.assert.equal(bundle.imports.get('rust').get('src/sub/mod.rs').get('include_str data.txt'), 'src/sub/data.txt')
  })
  // Two `macro_rules! asset`, one per platform: both bodies' assets are carried.
  await withProjectAsync({
    'src/lib.rs': '#[cfg(unix)]\n#[macro_use]\nmod a;\n#[cfg(windows)]\n#[macro_use]\nmod b;\nmod user;\n',
    'src/a.rs': 'macro_rules! asset { () => { include_str!("a.txt") } }\n',
    'src/b.rs': 'macro_rules! asset { () => { include_str!("b.txt") } }\n',
    'src/user.rs': 'fn f() -> &\'static str { asset!() }\n',
    'src/a.txt': 'a\n',
    'src/b.txt': 'b\n',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.ok(bundle.sources.has('src/a.txt') && bundle.sources.has('src/b.txt'))
  })
})

test('buildRustBundle refuses a Rust source or include_str! file that isn\'t UTF-8, and carries an include_bytes! one as base64', async (t) => {
  const bad = Buffer.from([0x66, 0x6e, 0x20, 0xff, 0x0a])
  await withProjectAsync({ 'src/lib.rs': 'mod m;\n' }, async (tmp) => {
    writeFileSync(join(tmp, 'src/m.rs'), bad)
    await t.assert.rejects(() => buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] }), { message: 'Rust source is not valid UTF-8: src/m.rs' })
  })
  await withProjectAsync({ 'src/lib.rs': 'const S: &str = include_str!("s.txt");\nconst B: &[u8] = include_bytes!("b.bin");\n' }, async (tmp) => {
    writeFileSync(join(tmp, 'src/b.bin'), bad)
    writeFileSync(join(tmp, 'src/s.txt'), 'ok\n')
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.deepEqual([bundle.formats.get('src/b.bin'), bundle.sources.get('src/b.bin')], ['resource:base64', bad.toString('base64')])
    writeFileSync(join(tmp, 'src/s.txt'), bad)
    await t.assert.rejects(() => buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] }), { message: 'include_str! file is not valid UTF-8: src/s.txt' })
  })
})

test('buildRustTree reports a missing dependency the manifest declares, whatever a glob into a missing crate may bring in', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nserde = "1"\ntokio = "1"\n',
    'src/lib.rs': 'use serde::*;\nuse tokio::runtime;\nuse de::Error;\n',
  }, async (tmp) => {
    const entries = ['src/lib.rs']
    const cargo = createCargoContext(tmp, { entries })
    const sources = await collectRustFilesFromDisk(tmp, entries, { cargo })
    const tree = buildRustTree(sources, { roots: entries, baseDir: tmp, cargo })
    // `tokio` is a declared dependency, so the crate (a `use` path whose lead a glob also
    // provides is ambiguous to rustc); `de` is declared nowhere: serde's glob may well bring it.
    t.assert.deepEqual(sorted(tree.unresolvedCrates), ['serde', 'tokio'])
  })
})

test('createCargoContext counts a feature only a target-specific table enables as maybe, until the target decides it', async (t) => {
  await withProjectAsync({
    'Cargo.toml': ['[package]', 'name = "app"', 'version = "0.1.0"', 'edition = "2021"',
      '[dependencies]', 'dep = { version = "1", default-features = false }',
      "[target.'cfg(windows)'.dependencies]", 'dep = { version = "1", features = ["std"] }'].join('\n'),
    'src/lib.rs': 'pub use dep::f;\n',
    ...platformCrate('dep'),
  }, async (tmp) => {
    // No target: `std` may be on (a Windows build) or off -- both modules stay.
    const cargo = createCargoContext(tmp, { entries: ['src/lib.rs'] })
    t.assert.deepEqual([enabledOf(cargo)['vendor/dep'], maybeOf(cargo)['vendor/dep']], [[], ['default', 'std']]) // that table keeps the defaults
    t.assert.deepEqual(bundled(await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] }), 'dep'), ['lib.rs', 'nix.rs', 'no_std.rs', 'win.rs', 'with_std.rs'])
    // A Linux target: the Windows table doesn't apply, `std` is off.
    t.assert.deepEqual(bundled(await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX }), 'dep'), ['lib.rs', 'nix.rs', 'no_std.rs'])
  })
})

test('buildRustBundle with a target leaves out the other targets\' modules and path variants', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': '#[cfg_attr(unix, path = "sys/unix.rs")]\n#[cfg_attr(windows, path = "sys/windows.rs")]\nmod sys;\n#[cfg(windows)]\nmod win;\n#[cfg(not(windows))]\nmod other;\n',
    'src/sys/unix.rs': '',
    'src/sys/windows.rs': '',
    'src/win.rs': '',
    'src/other.rs': '',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX })
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['src/lib.rs', 'src/other.rs', 'src/sys/unix.rs'])
    const lib = bundle.imports.get('rust').get('src/lib.rs')
    t.assert.equal(lib.get('mod sys'), 'src/sys/unix.rs') // one file: no cfg-keyed map
    t.assert.equal(lib.get('mod other'), 'src/other.rs')
    const all = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.deepEqual([...all.sources.keys()].toSorted(), ['src/lib.rs', 'src/other.rs', 'src/sys/unix.rs', 'src/sys/windows.rs', 'src/win.rs'])
  })
})

test('rustcTargetCfgs runs $RUSTC when set: a target only another toolchain knows', { skip: process.platform === 'win32' ? 'POSIX shell script' : false }, (t) => {
  // Stands in for Solana's platform-tools rustc, which knows `sbf-solana-solana` where a rustup one does not.
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-rustc-'))
  const fake = join(tmp, 'rustc')
  writeFileSync(fake, [
    '#!/bin/sh',
    `printf '%s\\n%s\\n' "$PWD" "$RUSTUP_AUTO_INSTALL" > "${tmp}/ran"`,
    'case "$*" in',
    '  "-vV") printf "rustc 1.79.0-dev\\nhost: sbf-solana-solana\\n" ;;',
    '  "--print cfg --target sbf-solana-solana") printf \'target_arch="sbf"\\ntarget_os="solana"\\ntarget_family="solana"\\ntarget_pointer_width="64"\\ntarget_endian="little"\\n\' ;;',
    '  *) echo "unknown target" >&2; exit 1 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 })
  const previous = process.env.RUSTC
  process.env.RUSTC = fake
  try {
    const sbf = rustcTargetCfgs('sbf-solana-solana')
    t.assert.equal(sbf.triple, 'sbf-solana-solana')
    t.assert.deepEqual([...sbf.cfgs], ['target_arch="sbf"', 'target_os="solana"', 'target_family="solana"', 'target_pointer_width="64"', 'target_endian="little"'])
    t.assert.equal(rustcTargetCfgs('host').triple, 'sbf-solana-solana')
    t.assert.throws(() => rustcTargetCfgs('x86_64-unknown-linux-gnu'), /rustc --print cfg --target x86_64-unknown-linux-gnu failed \(exit 1\):\nunknown target/u)
    // `#[cfg(not(target_os = "solana"))]` is dead under it.
    t.assert.equal(evalCfg('not(target_os = "solana")', { target: sbf.cfgs }), false)
    // rustc ran from the user's home directory (never the project being bundled, whose
    // `rust-toolchain` file could name any binary, nor a world-writable temp dir), with rustup's
    // auto-install off.
    t.assert.deepEqual(readFileSync(join(tmp, 'ran'), 'utf8').trim().split('\n'), [homedir(), '0'])
    mkdirSync(join(tmp, 'project', 'home'), { recursive: true })
    mkdirSync(join(tmp, 'elsewhere'))
    rustcTargetCfgs('sbf-solana-solana', join(tmp, 'project'))
    t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], homedir())
    // A home directory that is the bundle root, or inside it, would let the project's toolchain
    // file choose: the filesystem root then.
    const home = process.env.HOME
    process.env.HOME = join(tmp, 'project', 'home')
    try {
      rustcTargetCfgs('sbf-solana-solana', join(tmp, 'project'))
      t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], parse(process.cwd()).root)
      rustcTargetCfgs('sbf-solana-solana', join(tmp, 'project', 'home'))
      t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], parse(process.cwd()).root)
      rustcTargetCfgs('sbf-solana-solana', join(tmp, 'elsewhere'))
      t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], join(tmp, 'project', 'home'))
      // Through a link, either way round: real paths decide.
      symlinkSync(join(tmp, 'project', 'home'), join(tmp, 'home-link'))
      symlinkSync(join(tmp, 'project'), join(tmp, 'project-link'))
      process.env.HOME = join(tmp, 'home-link')
      rustcTargetCfgs('sbf-solana-solana', join(tmp, 'project'))
      t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], parse(process.cwd()).root)
      process.env.HOME = join(tmp, 'project', 'home')
      rustcTargetCfgs('sbf-solana-solana', join(tmp, 'project-link'))
      t.assert.equal(readFileSync(join(tmp, 'ran'), 'utf8').split('\n')[0], parse(process.cwd()).root)
    } finally {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  } finally {
    if (previous === undefined) delete process.env.RUSTC
    else process.env.RUSTC = previous
    rmSync(tmp, { recursive: true, force: true })
  }
})

const hasRustc = spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0

test('rustcTargetCfgs asks rustc for a target\'s cfg set, and for the host triple', { skip: hasRustc ? false : 'rustc not on PATH' }, (t) => {
  const host = rustcTargetCfgs('host')
  t.assert.match(host.triple, /^\w+-/u)
  t.assert.ok([...host.cfgs].some((c) => c.startsWith('target_os=')))
  t.assert.ok(host.cfgs.has('unix') || host.cfgs.has('windows'))
  // Any target rustc knows, without its standard library installed.
  const wasm = rustcTargetCfgs('wasm32-unknown-unknown')
  t.assert.equal(wasm.triple, 'wasm32-unknown-unknown')
  t.assert.ok(wasm.cfgs.has('target_arch="wasm32"'))
  t.assert.ok(!wasm.cfgs.has('unix') && !wasm.cfgs.has('windows'))
  t.assert.deepEqual(createCargoContext(featuresFixture, { entries: ['src/main.rs'], target: 'wasm32-unknown-unknown' }).targetCfgs, wasm.cfgs)
  t.assert.throws(() => rustcTargetCfgs('no-such-target'), /rustc --print cfg --target no-such-target failed/u)
})

test('createCargoContext finds vendored crates in the directory .cargo/config.toml names', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\ndep = "1"\n',
    '.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "third_party/crates"\n',
    'src/main.rs': '',
    'third_party/crates/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "1.0.0"\n',
    'third_party/crates/dep/src/lib.rs': '',
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.equal(cargo.vendorDir, 'third_party/crates')
    t.assert.equal(cargo.resolveCrate('dep', 'src/main.rs'), 'third_party/crates/dep/src/lib.rs')
    t.assert.deepEqual(enabledOf(cargo), { '.': [], 'third_party/crates/dep': [] })
  })
  t.assert.equal(createCargoContext(featuresFixture, { entries: ['src/main.rs'] }).vendorDir, 'vendor')
  // Whatever the source is named and however the tables are spelled out, through a chain of
  // replacements; a stale `vendor/` beside the configured directory is not what cargo builds from.
  const manifest = '[package]\nname = "app"\nversion = "0.1.0"\n'
  const depFiles = (dir) => ({ [`${dir}/dep/Cargo.toml`]: '[package]\nname = "dep"\nversion = "1.0.0"\n', [`${dir}/dep/src/lib.rs`]: '' })
  withProject({
    'Cargo.toml': `${manifest}[dependencies]\ndep = "1"\n`,
    '.cargo/config': '[source]\ncrates-io = { replace-with = "mirror" }\nmirror = { replace-with = "local" }\nlocal = { directory = "deps/" }\n',
    'src/main.rs': '',
    ...depFiles('deps'),
    ...depFiles('vendor'),
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.equal(cargo.vendorDir, 'deps')
    t.assert.equal(cargo.resolveCrate('dep', 'src/main.rs'), 'deps/dep/src/lib.rs')
  })
  // A source no `replace-with` names is not the build's; a configured directory that is missing says so.
  withProject({ 'Cargo.toml': manifest, '.cargo/config.toml': '[source.other]\ndirectory = "elsewhere"\n' }, (tmp) => {
    t.assert.equal(createCargoContext(tmp).vendorDir, 'vendor')
  })
  withProject({ 'Cargo.toml': manifest, '.cargo/config.toml': '[source.crates-io]\nreplace-with = "v"\n[source.v]\ndirectory = "gone"\n' }, (tmp) => {
    const warnings = []
    const warn = console.warn
    console.warn = (m) => warnings.push(m)
    try {
      t.assert.equal(createCargoContext(tmp).vendorDir, 'gone')
    } finally {
      console.warn = warn
    }
    t.assert.deepEqual(warnings, ['[loader.cargo] .cargo/config.toml names a vendored source directory that doesn\'t exist: gone'])
  })
  // A cargo config, Cargo.toml or Cargo.lock that exists but isn't TOML stops the build, naming it.
  withProject({ 'Cargo.toml': manifest, '.cargo/config.toml': '[source.vendored-sources]\ndirectory = third_party\n' }, (tmp) => {
    t.assert.throws(() => createCargoContext(tmp), { name: 'TomlError', message: '.cargo/config.toml: expected a value, found "third_party" at line 2' })
  })
  withProject({ 'Cargo.toml': '[package]\nname = "app"\nname = "again"\n', 'src/main.rs': '' }, (tmp) => {
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/main.rs'] }).packageInfo('src/main.rs'), { name: 'TomlError', message: 'Cargo.toml: duplicate key "name" at line 3' })
  })
})

// --- bundling ---

test('buildRustBundle carries include!d source and include_str!/include_bytes! assets as resources', async (t) => {
  const bundle = await buildRustBundle({ cwd: rustFixture('includes'), entries: ['src/lib.rs'] })
  t.assert.deepEqual(sorted(bundle.sources.keys()), ['README.md', 'data/blob.bin', 'data/table.txt', 'src/gated.rs', 'src/generated/consts.rs', 'src/lib.rs', 'src/macros.rs'])
  t.assert.deepEqual([bundle.formats.get('src/generated/consts.rs'), bundle.formats.get('data/table.txt'), bundle.formats.get('data/blob.bin')], ['rust', 'resource', 'resource:base64'])
  t.assert.equal(bundle.sources.get('data/blob.bin'), Buffer.from([0, 0xff, 0xfe, 1]).toString('base64'))
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['README.md', 'data/blob.bin', 'data/table.txt', 'src/gated.rs', 'src/generated/consts.rs', 'src/lib.rs', 'src/macros.rs'])
})

test('buildRustBundle leaves feature-gated code that is off out of the bundle, per crate and per version', async (t) => {
  const bundle = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'] })
  t.assert.deepEqual(sorted(bundle.sources.keys()), [
    'crates/lib-a/src/extra.rs', 'crates/lib-a/src/lib.rs', 'crates/lib-a/src/std_impl.rs', 'crates/lib-a/src/with_extra.rs',
    'src/fast.rs', 'src/main.rs', 'src/util.rs',
    'vendor/extra-dep/src/lib.rs',
    'vendor/md-5/src/lib.rs',
    'vendor/winnowish-0.5.0/src/lib.rs', 'vendor/winnowish-0.5.0/src/std_impl.rs',
    'vendor/winnowish/src/lib.rs', 'vendor/winnowish/src/std_impl.rs',
  ])
  // Out: src/ser.rs and lib-a's ser.rs (with-serde off), lib-a's no_std_impl.rs (std on), both winnowish
  // _tutorial.rs/debug.rs (features off), serde (optional dep off), proptest (dev-dependency).
  t.assert.deepEqual([...bundle.modules].map(([dir, m]) => [dir, m.name, m.version, m.ecosystem]).toSorted(), [
    ['.', 'app', '0.1.0', undefined],
    ['crates/lib-a', 'lib-a', '0.2.0', undefined],
    ['vendor/extra-dep', 'extra-dep', '1.0.0', 'cargo'],
    ['vendor/md-5', 'md-5', '0.10.6', 'cargo'],
    ['vendor/winnowish', 'winnowish', '0.6.1', 'cargo'],
    ['vendor/winnowish-0.5.0', 'winnowish', '0.5.0', 'cargo'],
  ])
  const imports = bundle.imports.get('rust')
  t.assert.equal(imports.get('crates/lib-a/src/with_extra.rs').get('use extra_dep'), 'vendor/extra-dep/src/lib.rs')
  t.assert.equal(imports.get('src/main.rs').get('use md5'), 'vendor/md-5/src/lib.rs')
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
  t.assert.deepEqual([...withSerde.modules.keys()].toSorted(), ['.', 'crates/lib-a', 'vendor/extra-dep', 'vendor/md-5', 'vendor/serde', 'vendor/winnowish', 'vendor/winnowish-0.5.0'])

  const noDefault = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'], cargoNoDefaultFeatures: true })
  t.assert.ok(!noDefault.sources.has('src/fast.rs')) // `fast` is only a default feature
  t.assert.ok(noDefault.sources.has('crates/lib-a/src/std_impl.rs')) // dependencies keep their own defaults

  const all = await buildRustBundle({ cwd: featuresFixture, entries: ['src/main.rs'], cargoAllFeatures: true })
  t.assert.ok(all.sources.has('src/fast.rs'))
  t.assert.ok(all.sources.has('src/ser.rs'))
})

test('buildRustBundle compiles a tests/ entry with cfg(test): its #[test] fns and #[cfg(test)] modules are live, dev-deps join', async (t) => {
  const bundle = await buildRustBundle({ cwd: featuresFixture, entries: ['tests/it.rs'] })
  // `use proptest::prelude::*` is live in a test target; proptest is a dev-dependency with `std` requested.
  t.assert.deepEqual(sorted(bundle.sources.keys()), ['tests/it.rs', 'vendor/proptest/src/lib.rs', 'vendor/proptest/src/std_impl.rs'])
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

test('buildRustBundle loads a crate root the tree pass asks for: a crate whose name the file also binds as a value', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nlog = "0.4"\n',
    'src/main.rs': 'mod util;\nuse crate::util::log;\nfn main() { log(); log::info!("x"); }\n',
    'src/util.rs': 'pub fn log() {}\n',
    'vendor/log/Cargo.toml': '[package]\nname = "log"\nversion = "0.4.0"\n',
    'vendor/log/src/lib.rs': 'pub mod macros;\n',
    'vendor/log/src/macros.rs': '',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] })
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['src/main.rs', 'src/util.rs', 'vendor/log/src/lib.rs', 'vendor/log/src/macros.rs'])
    t.assert.deepEqual(Object.fromEntries(bundle.imports.get('rust').get('src/main.rs')), { 'mod util': 'src/util.rs', 'crate::util::log': 'src/util.rs', 'use log': 'vendor/log/src/lib.rs' })
  })
})

test('buildRustBundle reads a package-defined quote! body as macro input while walking, whichever file defines it first', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': '#[macro_use]\nmod m;\nmod user;\n',
    'src/m.rs': '#[macro_use]\nmod inner;\n', // the definition is a wave deeper than user.rs: met after user.rs was scanned
    'src/m/inner.rs': 'macro_rules! quote { ($($t:tt)*) => {} }\n',
    'src/user.rs': 'quote! { mod hidden; }\n',
    'src/user/hidden.rs': 'pub fn h() {}\n',
    'vendor/other/Cargo.toml': '[package]\nname = "other"\nversion = "1.0.0"\n',
    'vendor/other/src/lib.rs': 'fn g() { quote! { mod nothere; } }\n', // another package: a template, skipped
  }, async (tmp) => {
    const { result: bundle, warnings } = await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/lib.rs', 'vendor/other/src/lib.rs'] }))
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['src/lib.rs', 'src/m.rs', 'src/m/inner.rs', 'src/user.rs', 'src/user/hidden.rs', 'vendor/other/src/lib.rs'])
    t.assert.deepEqual(Object.fromEntries(bundle.imports.get('rust').get('src/user.rs')), { 'mod hidden': 'src/user/hidden.rs', 'quote!': 'src/m/inner.rs' })
    t.assert.deepEqual(besidesReplay(warnings), [])
  })
})

test('buildRustTree with a target holds every file to the target\'s cfgs: mio\'s Waker is the linux one, not the first written', (t) => {
  // mio's sys/unix/mod.rs declares the selector (with its own `Waker` for the poll backend)
  // before the waker module; a Linux build has the eventfd waker.
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'mod sys;\nmod waker;\n',
    'src/sys/mod.rs': '#[cfg(unix)]\ncfg_os_poll! {\n    mod unix;\n    pub use self::unix::*;\n}\n',
    'src/sys/unix/mod.rs': 'cfg_os_poll! {\n    #[cfg_attr(any(mio_unsupported_force_poll_poll, target_os = "aix", target_os = "solaris"), path = "selector/poll.rs")]\n    #[cfg_attr(all(not(mio_unsupported_force_poll_poll), any(target_os = "android", target_os = "linux")), path = "selector/epoll.rs")]\n    mod selector;\n    pub(crate) use self::selector::*;\n    #[cfg_attr(any(mio_unsupported_force_waker_pipe, target_os = "aix", target_os = "solaris"), path = "waker/pipe.rs")]\n    #[cfg_attr(all(not(mio_unsupported_force_waker_pipe), any(target_os = "android", target_os = "linux")), path = "waker/eventfd.rs")]\n    mod waker;\n    pub(crate) use self::waker::Waker;\n}\n',
    'src/sys/unix/selector/poll.rs': 'pub struct Selector;\npub struct Waker;\n',
    'src/sys/unix/selector/epoll.rs': 'pub struct Selector;\n',
    'src/sys/unix/waker/pipe.rs': 'pub struct Waker;\n',
    'src/sys/unix/waker/eventfd.rs': 'pub struct Waker;\n',
    'src/waker.rs': 'use crate::sys;\nfn f() { sys::Waker::new(); sys::Selector::new(); }\n',
  }
  withProject(files, (tmp) => {
    const entries = ['src/lib.rs']
    const sources = new Map(Object.entries(files).filter(([f]) => f.endsWith('.rs')))
    const plain = buildRustTree(sources, { roots: entries, baseDir: tmp, cargo: createCargoContext(tmp, { entries }) })
    // Without a target nothing rules either waker file out (`any(mio_unsupported_force_waker_pipe,
    // aix, solaris)` may hold on aix): the edge is both, each under its cfg. With a Linux target the
    // aix and solaris alternatives are out, the custom cfg is presumably off, and the eventfd
    // branch's `any(android, linux)` holds: that one.
    t.assert.deepEqual(Object.fromEntries(plain.resolutions.get('src/waker.rs'))['sys::Waker::new'], new Map([
      ['all(cfg_os_poll!, unix)', 'src/sys/unix/waker/pipe.rs'],
      ['all(any(mio_unsupported_force_poll_poll, target_os = "aix", target_os = "solaris"), cfg_os_poll!, unix)', 'src/sys/unix/selector/poll.rs'],
    ]))
    const linux = buildRustTree(sources, { roots: entries, baseDir: tmp, cargo: createCargoContext(tmp, { entries, target: LINUX }) })
    t.assert.equal(Object.fromEntries(linux.resolutions.get('src/waker.rs'))['sys::Waker::new'], 'src/sys/unix/waker/eventfd.rs')
    t.assert.equal(Object.fromEntries(linux.resolutions.get('src/waker.rs'))['sys::Selector::new'], 'src/sys/unix/selector/epoll.rs')
  })
})

test('buildRustBundle declares a template\'s mod in each module of its package invoking the macro: no false "crate not found"', async (t) => {
  // `decl!` is defined in lib.rs and invoked in a.rs: its `pub mod gm1;` is a's, src/a/gm1.rs
  // (src/gm1.rs, beside the definition, is no module rustc looks for), and `use a::*;` brings it
  // into the root; b reaches it through the root's `extern crate self as app;`. vendor/other
  // invokes a `decl!` too -- another package's, which declares nothing here. `lone!` is invoked
  // only by path: its `mod solo;` is walked beside the definition.
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'extern crate self as app;\nmacro_rules! decl { () => { pub mod gm1; } }\npub mod a;\nmod b;\nuse a::*;\nuse gm1::X;\n#[macro_export]\nmacro_rules! lone { () => { mod solo; } }\ncrate::lone!();\n',
    'src/solo.rs': 'mod deeper;\n',
    'src/solo/deeper.rs': '',
    'src/a.rs': 'decl!();\n',
    'src/a/gm1.rs': 'pub struct X;\n',
    'src/gm1.rs': 'pub struct X;\n',
    'src/b.rs': 'use app::a::gm1::X;\nfn f() { app::a::gm1::X; }\n',
    'vendor/other/Cargo.toml': '[package]\nname = "other"\nversion = "1.0.0"\n',
    'vendor/other/src/lib.rs': 'decl!();\n',
    'vendor/other/src/gm1.rs': '',
  }, async (tmp) => {
    const entries = ['src/lib.rs', 'vendor/other/src/lib.rs']
    const { result: bundle, warnings } = await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries }))
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['src/a.rs', 'src/a/gm1.rs', 'src/b.rs', 'src/lib.rs', 'src/solo.rs', 'src/solo/deeper.rs', 'vendor/other/src/lib.rs'])
    const imports = bundle.imports.get('rust')
    t.assert.deepEqual(Object.fromEntries(imports.get('src/a.rs')), { 'decl!': 'src/lib.rs', 'mod gm1': 'src/a/gm1.rs' })
    t.assert.equal(imports.get('src/lib.rs').get('gm1::X'), 'src/a/gm1.rs')
    t.assert.equal(imports.get('src/lib.rs').get('mod solo'), 'src/solo.rs')
    t.assert.equal(imports.get('src/b.rs').get('app::a::gm1::X'), 'src/a/gm1.rs')
    t.assert.deepEqual(besidesReplay(warnings), [])
    const cargo = createCargoContext(tmp, { entries })
    const sources = await collectRustFilesFromDisk(tmp, entries, { cargo })
    t.assert.deepEqual(sorted(buildRustTree(sources, { roots: entries, baseDir: tmp, cargo }).unresolvedCrates), [])
  })
})

test('createCargoContext resolves each dependency table on its own: one version per table, the asking file\'s table', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nrand = "0.7"\n[build-dependencies]\nrand = "0.8"\n[dev-dependencies]\nfake = { package = "rand", version = "0.8" }\n',
    'src/main.rs': '', 'build.rs': '', 'tests/it.rs': '',
    ...vendoredPackage('rand', '0.7.3'), ...vendoredPackage('rand', '0.8.5'),
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    const { result, warnings } = captureWarningsSync(() => [
      cargo.resolveCrate('rand', 'src/main.rs'), cargo.resolveCrate('rand', 'build.rs'), cargo.resolveCrate('rand', 'tests/it.rs'), cargo.resolveCrate('fake', 'tests/it.rs'),
    ])
    t.assert.deepEqual(result, ['vendor/rand-0.7.3/src/lib.rs', 'vendor/rand-0.8.5/src/lib.rs', 'vendor/rand-0.7.3/src/lib.rs', 'vendor/rand-0.8.5/src/lib.rs'])
    t.assert.deepEqual(warnings, [])
    // both are in the build: the normal one for the target, the build-dependency for the host
    t.assert.deepEqual([...cargo.featureResolution('target').keys(), ...cargo.featureResolution('host').keys()].toSorted(), ['.', 'vendor/rand-0.7.3', 'vendor/rand-0.8.5'])
  })
})

test('createCargoContext takes a Cargo.lock pin only when the requirement allows it', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nrand = "0.8"\n',
    // out of date: the manifest moved on to 0.8, the lock still says 0.7.3
    'Cargo.lock': 'version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["rand"]\n\n[[package]]\nname = "rand"\nversion = "0.7.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    'src/main.rs': '',
    ...vendoredPackage('rand', '0.7.3'), ...vendoredPackage('rand', '0.8.5'),
  }, (tmp) => {
    const { result, warnings } = captureWarningsSync(() => createCargoContext(tmp, { entries: ['src/main.rs'] }).resolveCrate('rand', 'src/main.rs'))
    t.assert.equal(result, 'vendor/rand-0.8.5/src/lib.rs')
    t.assert.deepEqual(warnings, ['[loader.cargo] Cargo.lock pins app 0.1.0 to rand 0.7.3, which 0.8 doesn\'t allow: the lock is out of date'])
  })
})

test('createCargoContext applies a [patch] only where it fits, from the manifest or the cargo config', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nfoo = "1"\nbar = "1"\nbaz = "1"\n[patch.crates-io]\nfoo = { path = "patches/foo" }\nbaz = { path = "../outside/baz" }\n',
    '.cargo/config.toml': '[patch.crates-io]\nbar = { path = "patches/bar" }\n',
    'src/main.rs': '',
    'patches/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "2.0.0"\n', 'patches/foo/src/lib.rs': '', // doesn't satisfy `1`
    'patches/bar/Cargo.toml': '[package]\nname = "bar"\nversion = "1.5.0"\n', 'patches/bar/src/lib.rs': '',
    ...vendoredPackage('foo', '1.0.0'), ...vendoredPackage('bar', '1.0.0'), ...vendoredPackage('baz', '1.0.0'),
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    const { result, warnings } = captureWarningsSync(() => ['foo', 'bar', 'baz'].map((name) => cargo.resolveCrate(name, 'src/main.rs')))
    // foo: the patch isn't used, the registry's (vendored) 1.0.0 is; bar: the config's patch; baz:
    // patched with a crate outside the bundle, which is not some vendored copy of that name
    t.assert.deepEqual(result, ['vendor/foo-1.0.0/src/lib.rs', 'patches/bar/src/lib.rs', null])
    t.assert.deepEqual(warnings, [
      '[loader.cargo] Cargo.toml\'s patch of foo (2.0.0) doesn\'t satisfy app 0.1.0\'s requirement 1: not used',
      '[loader.cargo] Cargo.toml patches baz with a path outside the bundle root',
    ])
  })
})

test('createCargoContext says when a path dependency lies outside the bundle root or names no package', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nfar = { path = "../far" }\nempty = { path = "crates/empty" }\n',
    'src/main.rs': '', 'crates/empty/README.md': '',
    ...vendoredPackage('far', '1.0.0'),
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    const { result, warnings } = captureWarningsSync(() => [cargo.resolveCrate('far', 'src/main.rs'), cargo.resolveCrate('empty', 'src/main.rs')])
    t.assert.deepEqual(result, [null, null])
    t.assert.deepEqual(warnings, [
      '[loader.cargo] app 0.1.0\'s dependency far is a path outside the bundle root: ../far',
      '[loader.cargo] app 0.1.0\'s dependency empty names crates/empty, which holds no Cargo.toml with a [package]',
    ])
  })
})

test('buildRustBundle ends when a crate root it wants is refused, and reports every crate it lacks, vendor dir or not', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks')
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nlinked = "1"\nmissing = "1"\nfar = { path = "../far" }\n',
    'src/main.rs': 'use linked::X;\nuse missing::Y;\nuse far::Z;\nfn main() {}\n',
    'vendor/linked/Cargo.toml': '[package]\nname = "linked"\nversion = "1.0.0"\n',
    'secret.rs': 'pub struct X;\n',
  }, async (tmp) => {
    // a vendored crate whose root is a link out of its package: the walk refuses it, the tree pass asks for it
    mkdirSync(join(tmp, 'vendor', 'linked', 'src'))
    symlinkSync(join('..', '..', '..', 'secret.rs'), join(tmp, 'vendor', 'linked', 'src', 'lib.rs'))
    const { result: bundle, warnings } = await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] }))
    t.assert.deepEqual([...bundle.sources.keys()], ['src/main.rs'])
    t.assert.deepEqual([...new Set(besidesReplay(warnings))], [
      '[loader.cargo] app 0.1.0\'s dependency far is a path outside the bundle root: ../far',
      '[loader.rust] Refusing file outside its package: vendor/linked/src/lib.rs (a link out of vendor/linked)',
      '[stasis] 3 crates referenced but not in the bundle: far, linked (vendor/linked/src/lib.rs), missing',
    ])
  })
})

// --- ninth round: @preventive/lockfile's reading and cargo's resolver ---

// A workspace cargo locked and vendored, and in recorded.json what cargo itself made of it: the
// features `cargo build --unit-graph` built each package with for a few command lines under
// resolver 1 and 2, null where cargo refused one, and the targets' `rustc --print cfg`. It is
// @preventive/lockfile's fixture (PreventiveMeasures/libraries#56, MIT), recorded there by
// lockfile/scripts/record-cargo.js.
const cargoRecorded = rustFixture('cargo-recorded')
const recordedProject = (resolver) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-recorded-'))
  cpSync(cargoRecorded, tmp, { recursive: true })
  if (resolver === '1') writeFileSync(join(tmp, 'Cargo.toml'), readFileSync(join(tmp, 'Cargo.toml'), 'utf8').replace('[workspace]\n', '[workspace]\nresolver = "1"\n'))
  return tmp
}

test('createCargoContext turns on the features cargo builds each package with, given the lockfile and the target', (t) => {
  const recorded = JSON.parse(readFileSync(join(cargoRecorded, 'recorded.json'), 'utf8'))
  const dirOf = new Map([
    ...Object.entries(recorded.manifests).map(([key, path]) => [key, dirname(path)]),
    ...Object.entries(recorded.vendored).map(([key, directory]) => [key, `vendor/${directory}`]),
  ])
  const memberDir = { app: '.', lib: 'crates/lib', macros: 'crates/macros' }
  const platform = (triple) => ({ triple, cfgs: parseRustcCfg(recorded.cfg[triple].join('\n')) })
  for (const [resolver, builds] of Object.entries(recorded.features)) {
    const tmp = recordedProject(resolver)
    try {
      for (const build of builds) {
        const label = `resolver ${resolver}: ${JSON.stringify({ ...build, built: undefined })}`
        const names = build.packages === 'all' ? ['lib', 'macros', 'app'] : build.packages
        const entries = names.map((name) => posix.join(memberDir[name], build.dev ? 'tests/t.rs' : 'src/lib.rs'))
        const cargo = () => createCargoContext(tmp, {
          entries,
          features: build.features ?? [],
          noDefaultFeatures: build.noDefaultFeatures === true,
          allFeatures: build.allFeatures === true,
          target: platform(build.target ?? recorded.host),
          host: platform(recorded.host),
        })
        if (build.built === null) {
          t.assert.throws(() => cargo().featuresFor('src/lib.rs'), { name: 'LockfileError' }, label)
          continue
        }
        const ctx = cargo()
        const got = (unit) => {
          const [key, fk] = [unit.slice(0, unit.lastIndexOf(' ')), unit.slice(unit.lastIndexOf(' ') + 1)]
          return ctx.resolvedFeatures(fk === 'normal' ? 'target' : 'host').get(dirOf.get(key))
        }
        for (const [unit, on] of Object.entries(build.built)) t.assert.deepEqual(sorted(got(unit) ?? []), on, `${label}: ${unit}`)
        if (resolver === '1') continue // one set per package, both ways
        // Nothing else is built, but the proc-macro member for the target, which cargo's resolver
        // lists in case it has more targets than its library.
        for (const [context, fk] of [['target', 'normal'], ['host', 'host']]) {
          for (const dir of ctx.resolvedFeatures(context).keys()) {
            const key = [...dirOf].find(([, d]) => d === dir)[0]
            if (!(`${key} ${fk}` in build.built)) t.assert.deepEqual([key, fk], ['macros 0.1.0', 'normal'], label)
          }
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
})

test('createCargoContext resolves through cargo\'s graph: each table\'s source, the [patch], the proc-macro for the host', (t) => {
  const tmp = recordedProject('2')
  try {
    const recorded = JSON.parse(readFileSync(join(tmp, 'recorded.json'), 'utf8'))
    const ctx = createCargoContext(tmp, { entries: ['src/lib.rs'], features: ['fmt,git'], target: { triple: recorded.host, cfgs: parseRustcCfg(recorded.cfg[recorded.host].join('\n')) } })
    for (const dir of ['vendor/itoa', 'vendor/itoa-0.4.8', 'vendor/itoa-1.0.0', 'patched/cfg-if', 'crates/lib', 'crates/macros']) mkdirSync(join(tmp, dir, 'src'), { recursive: true })
    for (const dir of ['vendor/itoa', 'vendor/itoa-0.4.8', 'vendor/itoa-1.0.0', 'patched/cfg-if', 'crates/lib', 'crates/macros']) writeFileSync(join(tmp, dir, 'src', 'lib.rs'), '')
    // `itoa = "1"` from crates.io, `itoa04 = { package = "itoa", version = "0.4" }`, `itoa-git` from
    // git at tag 1.0.0: three copies, each the one its table names
    t.assert.equal(ctx.resolveCrate('itoa', 'src/lib.rs'), 'vendor/itoa/src/lib.rs')
    t.assert.equal(ctx.resolveCrate('itoa04', 'src/lib.rs'), 'vendor/itoa-0.4.8/src/lib.rs')
    t.assert.equal(ctx.resolveCrate('itoa_git', 'src/lib.rs'), 'vendor/itoa-1.0.0/src/lib.rs')
    // `[target.'cfg(windows)'.dependencies] cfg-if`: no crate of a Linux build; a Windows one's is
    // the [patch.crates-io] path
    t.assert.equal(ctx.resolveCrate('cfg_if', 'src/lib.rs'), null)
    const windows = createCargoContext(tmp, { entries: ['src/lib.rs'], features: ['fmt,git'], target: { triple: 'x86_64-pc-windows-msvc', cfgs: parseRustcCfg(recorded.cfg['x86_64-pc-windows-msvc'].join('\n')) } })
    t.assert.equal(windows.resolveCrate('cfg_if', 'src/lib.rs'), 'patched/cfg-if/src/lib.rs')
    t.assert.equal(ctx.resolveCrate('macros', 'src/lib.rs'), 'crates/macros/src/lib.rs')
    // the proc-macro and what it depends on are built for the host, with the host's features
    t.assert.deepEqual(sorted(ctx.featuresFor('crates/macros/src/lib.rs', HOST_UNIT)), [])
    t.assert.deepEqual(sorted(ctx.featuresFor('vendor/memchr/src/lib.rs', HOST_UNIT)), ['alloc'])
    t.assert.deepEqual(sorted(ctx.featuresFor('vendor/memchr/src/lib.rs')), ['alloc', 'std'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createCargoContext stops the build where the lockfile and the vendored copies disagree, and replays the manifests where it lacks a package', (t) => {
  const recorded = JSON.parse(readFileSync(join(cargoRecorded, 'recorded.json'), 'utf8'))
  const target = { triple: recorded.host, cfgs: parseRustcCfg(recorded.cfg[recorded.host].join('\n')) }
  const tmp = recordedProject('2')
  try {
    // a vendored copy whose checksum isn't the lockfile's: cargo refuses to build from it
    const sums = join(tmp, 'vendor', 'paste', '.cargo-checksum.json')
    const original = readFileSync(sums, 'utf8')
    writeFileSync(sums, original.replace(/"package":"[\da-f]{64}"/u, `"package":"${'0'.repeat(64)}"`))
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/lib.rs'], target }).featuresFor('src/lib.rs'), { name: 'LockfileError', message: /^Cargo\.lock: paste 1\.0\.15 .*: "paste" holds it with checksum 0{64}, where the lockfile has / })
    writeFileSync(sums, original)
    // a manifest the lockfile is out of date with: lib's entry in it has no cfg-if
    const manifest = readFileSync(join(tmp, 'crates', 'lib', 'Cargo.toml'), 'utf8')
    writeFileSync(join(tmp, 'crates', 'lib', 'Cargo.toml'), manifest.replace('[target.', 'cfg-if = "1"\n[target.'))
    t.assert.throws(() => createCargoContext(tmp, { entries: ['src/lib.rs'], target }).featuresFor('src/lib.rs'), { name: 'LockfileError', message: /^Cargo\.lock: lib 0\.2\.0: the lockfile resolves no "cfg-if", which the members' features turn on: is it out of date\?$/u })
    writeFileSync(join(tmp, 'crates', 'lib', 'Cargo.toml'), manifest)
    // a package the lockfile has and the vendor directory doesn't: the replay decides, as without a lockfile
    rmSync(join(tmp, 'vendor', 'paste'), { recursive: true })
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/lib.rs'], target }))['.'], ['default', 'fast'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// A registry package's `.cargo-checksum.json` and lockfile checksum; a git checkout's has none.
const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
const sha = (c) => c.repeat(64)
const vendoredCopy = (dir, manifest, checksum) => ({
  [`vendor/${dir}/Cargo.toml`]: manifest,
  [`vendor/${dir}/.cargo-checksum.json`]: JSON.stringify({ files: {}, package: checksum }),
  [`vendor/${dir}/src/lib.rs`]: '',
})

test('createCargoContext resolves a host it doesn\'t know both ways: its target-specific tables only maybe', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[target.\'cfg(unix)\'.build-dependencies]\ncc = { version = "1", features = ["parallel"] }\n',
    'Cargo.lock': `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["cc"]\n\n[[package]]\nname = "cc"\nversion = "1.0.0"\nsource = "${REGISTRY}"\nchecksum = "${sha('c')}"\n`,
    'src/lib.rs': '', 'build.rs': '',
    ...vendoredCopy('cc', '[package]\nname = "cc"\nversion = "1.0.0"\n[features]\nparallel = []\n', sha('c')),
  }, (tmp) => {
    // the target known, the host not: the build-dependency's table is about the host
    const cross = createCargoContext(tmp, { entries: ['src/lib.rs'], target: LINUX })
    t.assert.equal(cross.featuresFor('vendor/cc/src/lib.rs', HOST_UNIT).size, 0)
    t.assert.deepEqual(sorted(cross.maybeFeaturesFor('vendor/cc/src/lib.rs', HOST_UNIT)), ['parallel'])
    // the host known: decided
    const native = createCargoContext(tmp, { entries: ['src/lib.rs'], target: LINUX, host: LINUX })
    t.assert.deepEqual(sorted(native.featuresFor('vendor/cc/src/lib.rs', HOST_UNIT)), ['parallel'])
    t.assert.equal(native.maybeFeaturesFor('vendor/cc/src/lib.rs', HOST_UNIT), null)
  })
})

test('createCargoContext takes a git dependency\'s copy from a git checkout, a registry one\'s from the registry, lockfile or not', (t) => {
  const git = 'git+https://github.com/dtolnay/itoa?tag=1.0.0#e6a8f6f2f193aa852a3d2d84f2721e75d4517bff'
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nitoa = "1"\nitoa-git = { package = "itoa", git = "https://github.com/dtolnay/itoa", tag = "1.0.0" }\n',
    'src/main.rs': '',
    ...vendoredCopy('itoa', '[package]\nname = "itoa"\nversion = "1.0.18"\n', sha('a')),
    ...vendoredCopy('itoa-1.0.0', '[package]\nname = "itoa"\nversion = "1.0.0"\n', null),
  }
  const check = (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
    t.assert.equal(cargo.resolveCrate('itoa', 'src/main.rs'), 'vendor/itoa/src/lib.rs') // not the git 1.0.0, which "1" allows too
    t.assert.equal(cargo.resolveCrate('itoa_git', 'src/main.rs'), 'vendor/itoa-1.0.0/src/lib.rs') // no version: any, but a git one
  }
  withProject(files, check)
  withProject({
    ...files,
    'Cargo.lock': `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "itoa 1.0.0",\n "itoa 1.0.18",\n]\n\n[[package]]\nname = "itoa"\nversion = "1.0.0"\nsource = "${git}"\n\n[[package]]\nname = "itoa"\nversion = "1.0.18"\nsource = "${REGISTRY}"\nchecksum = "${sha('a')}"\n`,
  }, check)
})

test('createCargoContext turns a package\'s feature of a dependency\'s name on with `dep/feature`, written or implicit', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[features]\ndefault = ["full"]\nfull = ["serde/derive"]\nserde = ["dep:serde", "chrono?/serde", "extra"]\nextra = []\n[dependencies]\nserde = { version = "1", optional = true }\nchrono = { version = "0.4", optional = true }\n',
    'src/lib.rs': '',
    'vendor/serde/Cargo.toml': '[package]\nname = "serde"\nversion = "1.0.0"\n[features]\nderive = []\n', 'vendor/serde/src/lib.rs': '',
    'vendor/chrono/Cargo.toml': '[package]\nname = "chrono"\nversion = "0.4.0"\n[features]\nserde = []\n', 'vendor/chrono/src/lib.rs': '',
  }, (tmp) => {
    t.assert.deepEqual(enabledOf(createCargoContext(tmp, { entries: ['src/lib.rs'] })), { '.': ['default', 'extra', 'full', 'serde'], 'vendor/serde': ['derive'] })
  })
})

test('createCargoContext resolves a proc-macro entry for the host, where cargo builds it', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "derive"\nversion = "0.1.0"\nedition = "2021"\n[lib]\nproc-macro = true\n[features]\ndefault = ["printing"]\nprinting = ["quote/std"]\n[dependencies]\nquote = { version = "1", default-features = false }\n',
    'src/lib.rs': '',
    'vendor/quote/Cargo.toml': '[package]\nname = "quote"\nversion = "1.0.0"\n[features]\ndefault = ["std"]\nstd = []\n', 'vendor/quote/src/lib.rs': '',
  }, (tmp) => {
    const cargo = createCargoContext(tmp, { entries: ['src/lib.rs'] })
    t.assert.deepEqual(enabledOf(cargo, 'host'), { '.': ['default', 'printing'], 'vendor/quote': ['std'] })
    // cargo activates a proc-macro member it is asked to build in the target's context too
    t.assert.deepEqual(enabledOf(cargo, 'target'), { '.': ['default', 'printing'], 'vendor/quote': ['std'] })
    t.assert.deepEqual(sorted(cargo.featuresFor('src/lib.rs', HOST_UNIT)), ['default', 'printing'])
  })
})

test('createCargoContext matches versions by the semver crate\'s rules: a requirement takes no prerelease it doesn\'t name', (t) => {
  withProject({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nfoo = "1"\nbar = "=2.0.0-rc.1"\n',
    'src/main.rs': '',
    ...vendoredPackage('foo', '1.0.0'), ...vendoredPackage('foo', '1.1.0-beta.1'),
    ...vendoredPackage('bar', '2.0.0-rc.1'),
  }, (tmp) => {
    const { result, warnings } = captureWarningsSync(() => {
      const cargo = createCargoContext(tmp, { entries: ['src/main.rs'] })
      return [cargo.resolveCrate('foo', 'src/main.rs'), cargo.resolveCrate('bar', 'src/main.rs')]
    })
    t.assert.deepEqual(result, ['vendor/foo-1.0.0/src/lib.rs', 'vendor/bar-2.0.0-rc.1/src/lib.rs'])
    t.assert.deepEqual(warnings, [])
  })
})

test('createCargoContext reads the lockfile of the entries\' workspace, below the bundle root too', (t) => {
  withProject({
    'proj/Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'proj/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n',
    'proj/app/src/lib.rs': '',
    'proj/Cargo.lock': `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["serde"]\n\n[[package]]\nname = "serde"\nversion = "1.0.100"\nsource = "${REGISTRY}"\n`,
    ...vendoredPackage('serde', '1.0.100'), ...vendoredPackage('serde', '1.0.200'),
  }, (tmp) => {
    const { result, warnings } = captureWarningsSync(() => createCargoContext(tmp, { entries: ['proj/app/src/lib.rs'] }).resolveCrate('serde', 'proj/app/src/lib.rs'))
    t.assert.equal(result, 'vendor/serde-1.0.100/src/lib.rs')
    t.assert.deepEqual(warnings, [])
  })
})

test('buildRustBundle scans a proc-macro entry as the host build, with the features cargo builds it with', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "derive"\nversion = "0.1.0"\nedition = "2021"\n[lib]\nproc-macro = true\n[features]\ndefault = ["printing"]\nprinting = []\nextra = []\n',
    'src/lib.rs': '#[cfg(feature = "printing")]\nmod printing;\n#[cfg(feature = "extra")]\nmod extra;\n',
    'src/printing.rs': '', 'src/extra.rs': '',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })
    t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['src/lib.rs', 'src/printing.rs'])
  })
})

// --- tenth review: platform tables, build-script crates, proc-macro roots, out-of-root workspaces ---

// The crate-root edges of a bundle collected from `tmp`: file -> `use` spec -> target (a cfg-keyed
// map as [key, file] pairs), and the files carried.
const crateEdges = async (tmp, entries, opts = {}) => {
  const cargo = createCargoContext(tmp, { entries, ...opts })
  const { sources, tree } = await collectRustBundle(tmp, entries, { cargo, buildScripts: true })
  const edges = {}
  for (const [file, specs] of tree.resolutions) {
    for (const [spec, target] of specs) if (spec.startsWith('use ')) (edges[file] ??= {})[spec] = target instanceof Map ? [...target] : target
  }
  return { edges, files: [...sources.keys()].toSorted(), tree }
}

const platformTables = {
  'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[target.\'cfg(windows)\'.dependencies]\nfoo = "2"\n[target.\'cfg(unix)\'.dependencies]\nfoo = "1"\n[target.\'cfg(windows)\'.build-dependencies]\nbar = "2"\n[target.\'cfg(unix)\'.build-dependencies]\nbar = "1"\n',
  'src/main.rs': 'use foo::f;\nfn main() { f() }\n',
  'build.rs': 'use bar::b;\nfn main() { b() }\n',
}
const platformLock = `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "bar 1.0.0",\n "bar 2.0.0",\n "foo 1.0.0",\n "foo 2.0.0",\n]\n${[['bar', '1.0.0', 'c'], ['bar', '2.0.0', 'd'], ['foo', '1.0.0', 'a'], ['foo', '2.0.0', 'b']].map(([n, v, c]) => `\n[[package]]\nname = "${n}"\nversion = "${v}"\nsource = "${REGISTRY}"\nchecksum = "${sha(c)}"\n`).join('')}`

test('createCargoContext links only the dependency tables of the platforms the code is built for, and keeps each one that may be', async (t) => {
  const vendored = {
    ...vendoredCopy('foo', '[package]\nname = "foo"\nversion = "1.0.0"\n', sha('a')), ...vendoredCopy('foo-2.0.0', '[package]\nname = "foo"\nversion = "2.0.0"\n', sha('b')),
    ...vendoredCopy('bar', '[package]\nname = "bar"\nversion = "1.0.0"\n', sha('c')), ...vendoredCopy('bar-2.0.0', '[package]\nname = "bar"\nversion = "2.0.0"\n', sha('d')),
  }
  // cargo's resolver (the lockfile, the target and the host known): the unix tables on Linux,
  // whichever table comes first
  await Promise.all([platformTables['Cargo.toml'], platformTables['Cargo.toml'].replace(/(\[target.'cfg\(windows\)'.dependencies\]\nfoo = "2"\n)(\[target.'cfg\(unix\)'.dependencies\]\nfoo = "1"\n)/u, '$2$1')].map((toml) =>
    withProjectAsync({ ...platformTables, 'Cargo.toml': toml, 'Cargo.lock': platformLock, ...vendored }, async (tmp) => {
      const { edges, files } = await crateEdges(tmp, ['src/main.rs'], { target: LINUX, host: LINUX })
      t.assert.deepEqual(edges, { 'src/main.rs': { 'use foo': 'vendor/foo/src/lib.rs' }, 'build.rs': { 'use bar': 'vendor/bar/src/lib.rs' } })
      t.assert.deepEqual(files.filter((f) => f.startsWith('vendor/')), ['vendor/bar/src/lib.rs', 'vendor/foo/src/lib.rs'])
    })))
  await withProjectAsync({ ...platformTables, ...vendored }, async (tmp) => {
    // the replay, the same
    const known = await crateEdges(tmp, ['src/main.rs'], { target: LINUX, host: LINUX })
    t.assert.deepEqual(known.edges, { 'src/main.rs': { 'use foo': 'vendor/foo/src/lib.rs' }, 'build.rs': { 'use bar': 'vendor/bar/src/lib.rs' } })
    // no target: either table may apply, so either version is carried, keyed by its platform
    const any = await crateEdges(tmp, ['src/main.rs'])
    t.assert.deepEqual(any.edges, {
      'src/main.rs': { 'use foo': [['windows', 'vendor/foo-2.0.0/src/lib.rs'], ['unix', 'vendor/foo/src/lib.rs']] },
      'build.rs': { 'use bar': [['windows', 'vendor/bar-2.0.0/src/lib.rs'], ['unix', 'vendor/bar/src/lib.rs']] },
    })
    // the target known, the host not: the build script's tables still both maybe
    const cross = await crateEdges(tmp, ['src/main.rs'], { target: LINUX })
    t.assert.deepEqual(cross.edges['src/main.rs'], { 'use foo': 'vendor/foo/src/lib.rs' })
    t.assert.deepEqual(cross.edges['build.rs'], { 'use bar': [['windows', 'vendor/bar-2.0.0/src/lib.rs'], ['unix', 'vendor/bar/src/lib.rs']] })
  })
})

test('createCargoContext resolves a build script\'s modules, and a file it shares with the lib, from the [build-dependencies]', async (t) => {
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n[build-dependencies]\nfoo = "2"\n',
    'build.rs': 'mod probe;\n#[path = "shared.rs"]\nmod shared;\nfn main() { probe::run(); }\n',
    'probe.rs': 'use foo::v2;\npub fn run() { v2() }\n',
    'shared.rs': 'use foo as f;\n',
    'src/lib.rs': '#[path = "../shared.rs"]\npub mod shared;\npub fn lib_uses() { foo::v1() }\n',
    ...vendoredPackage('foo', '1.0.0'), ...vendoredPackage('foo', '2.0.0'),
  }
  await withProjectAsync(files, async (tmp) => {
    const { edges, files: carried } = await crateEdges(tmp, ['src/lib.rs'], { target: LINUX, host: LINUX })
    t.assert.equal(edges['probe.rs']['use foo'], 'vendor/foo-2.0.0/src/lib.rs')
    t.assert.equal(edges['src/lib.rs']['use foo'], 'vendor/foo-1.0.0/src/lib.rs')
    // compiled into both crates: both versions, the build script's keyed as its
    t.assert.deepEqual(edges['shared.rs']['use foo'], [['*', 'vendor/foo-1.0.0/src/lib.rs'], ['build-script *', 'vendor/foo-2.0.0/src/lib.rs']])
    t.assert.ok(carried.includes('vendor/foo-1.0.0/src/lib.rs') && carried.includes('vendor/foo-2.0.0/src/lib.rs'))
  })
})

test('createCargoContext resolves a proc-macro entry beside another in both contexts, as cargo activates it', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[workspace]\nmembers = ["app", "pm", "shared"]\nresolver = "2"\n',
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nshared = { path = "../shared" }\n',
    'app/src/lib.rs': 'pub use shared::f;\n',
    'pm/Cargo.toml': '[package]\nname = "pm"\nversion = "0.1.0"\nedition = "2021"\n[lib]\nproc-macro = true\n[dependencies]\nshared = { path = "../shared", features = ["h"] }\n',
    'pm/src/lib.rs': 'pub use shared::f;\n',
    'shared/Cargo.toml': '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2021"\n[features]\nh = []\n',
    'shared/src/lib.rs': '#[cfg(not(feature = "h"))]\nmod noth;\npub fn f() {}\n',
    'shared/src/noth.rs': 'compile_error!("cargo build -p app -p pm never compiles this");\n',
  }, async (tmp) => {
    const { files } = await crateEdges(tmp, ['app/src/lib.rs', 'pm/src/lib.rs'])
    t.assert.ok(!files.includes('shared/src/noth.rs'))
    const cargo = createCargoContext(tmp, { entries: ['app/src/lib.rs', 'pm/src/lib.rs'] })
    t.assert.deepEqual([sorted(cargo.featuresFor('shared/src/lib.rs')), sorted(cargo.featuresFor('shared/src/lib.rs', HOST_UNIT))], [['h'], ['h']])
  })
})

test('buildRustTree reports a declared dependency that isn\'t in the bundle, used in expressions only', async (t) => {
  await Promise.all(['fn main() { let _ = serde_json::to_string(&1); }\n', 'fn main() { let _ = serde_json::json!({}); }\n', 'use serde_json::to_string;\nfn main() {}\n'].map((main) =>
    withProjectAsync({
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nserde_json = "1"\n',
      'src/main.rs': main,
      ...vendoredPackage('other', '1.0.0'),
    }, async (tmp) => {
      const { tree } = await crateEdges(tmp, ['src/main.rs'])
      t.assert.deepEqual([...tree.unresolvedCrates], ['serde_json'], main)
    })))
})

test('createCargoContext reads the workspace a member bundled from its own directory inherits from, above the bundle root', async (t) => {
  await withProjectAsync({
    'ws/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n[workspace.package]\nversion = "0.3.0"\nedition = "2015"\n[workspace.dependencies]\ndep = { path = "crates/app/dep" }\n',
    'ws/crates/app/Cargo.toml': '[package]\nname = "app"\nversion.workspace = true\nedition.workspace = true\n[features]\ndefault = ["fast"]\nfast = []\n[dependencies]\ndep = { workspace = true }\n[dev-dependencies]\ndep = { workspace = true, features = ["extra"] }\n',
    'ws/crates/app/src/lib.rs': '#[cfg(feature = "fast")]\nmod fast;\npub use dep::x;\n',
    'ws/crates/app/src/fast.rs': '',
    'ws/crates/app/dep/Cargo.toml': '[package]\nname = "dep"\nversion = "0.1.0"\n[features]\nextra = []\n',
    'ws/crates/app/dep/src/lib.rs': '#[cfg(feature = "extra")]\nmod extra;\n#[cfg(not(feature = "extra"))]\nmod plain;\npub fn x() {}\n',
    'ws/crates/app/dep/src/extra.rs': '', 'ws/crates/app/dep/src/plain.rs': '',
  }, async (tmp) => {
    const root = join(tmp, 'ws', 'crates', 'app')
    const { files } = await crateEdges(root, ['src/lib.rs'])
    // the inherited edition and the workspace's dependency read; its resolver 2 keeps the
    // dev-dependency's feature out of the build, which resolver 1 of the member's edition wouldn't
    t.assert.deepEqual(files, ['dep/src/lib.rs', 'dep/src/plain.rs', 'src/fast.rs', 'src/lib.rs'])
    t.assert.equal(createCargoContext(root, { entries: ['src/lib.rs'] }).packageInfo('src/lib.rs').version, '0.3.0')
    // a [workspace] above whose `members` don't list the package is still its own (cargo refuses
    // the build: "current package believes it's in a workspace when it's not"), and what the
    // package inherits but the workspace lacks stops the bundle
    writeFileSync(join(tmp, 'ws', 'Cargo.toml'), '[workspace]\nmembers = ["other"]\n[workspace.package]\nversion = "0.3.0"\nedition = "2015"\n')
    t.assert.throws(() => createCargoContext(root, { entries: ['src/lib.rs'] }).packageInfo('src/lib.rs'), { name: 'LockfileError', message: /"dep" is not in \[workspace\.dependencies\]/u })
    // one that excludes it isn't: it is outside any workspace
    writeFileSync(join(tmp, 'ws', 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/app"]\n[workspace.package]\nversion = "0.3.0"\nedition = "2015"\n')
    t.assert.throws(() => createCargoContext(root, { entries: ['src/lib.rs'] }).packageInfo('src/lib.rs'), { name: 'LockfileError', message: /no workspace root is given/u })
  })
})

test('createCargoContext says why the features come from a replay, and a vendored copy the lockfile doesn\'t list needs no checksums', (t) => {
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'Cargo.lock': `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["foo"]\n\n[[package]]\nname = "foo"\nversion = "1.0.0"\nsource = "${REGISTRY}"\nchecksum = "${sha('a')}"\n`,
    'src/main.rs': '',
    ...vendoredCopy('foo', '[package]\nname = "foo"\nversion = "1.0.0"\n', sha('a')),
    ...vendoredPackage('junk', '0.1.0'), // no .cargo-checksum.json, and nothing locks it
  }
  withProject(files, (tmp) => {
    t.assert.deepEqual(createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX }).resolution(), { mode: 'cargo', why: null })
    t.assert.deepEqual(createCargoContext(tmp, { entries: ['src/main.rs'] }).resolution(), { mode: 'replay', why: 'no --cargo-target' })
    rmSync(join(tmp, 'vendor/foo/.cargo-checksum.json'))
    t.assert.deepEqual(createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX }).resolution(), { mode: 'replay', why: 'the vendored copy of foo 1.0.0 has no .cargo-checksum.json' })
    rmSync(join(tmp, 'vendor/foo'), { recursive: true })
    t.assert.deepEqual(createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX }).resolution(), { mode: 'replay', why: 'foo 1.0.0 is locked but not vendored' })
    rmSync(join(tmp, 'Cargo.lock'))
    t.assert.deepEqual(createCargoContext(tmp, { entries: ['src/main.rs'], target: LINUX }).resolution(), { mode: 'replay', why: 'no Cargo.lock' })
  })
})

test('createCargoContext applies a [patch] to the dependencies of its source only: a git URL\'s not to crates.io\'s', (t) => {
  const base = {
    'src/lib.rs': '',
    ...vendoredPackage('foo', '1.0.0'),
    'patched/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'patched/foo/src/lib.rs': '',
  }
  const manifest = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n'
  for (const [where, files] of [
    ['manifest', { 'Cargo.toml': `${manifest}[patch."https://github.com/example/foo"]\nfoo = { path = "patched/foo" }\n` }],
    ['config', { 'Cargo.toml': manifest, '.cargo/config.toml': '[patch."https://github.com/example/foo"]\nfoo = { path = "patched/foo" }\n' }],
    ['crates-io', { 'Cargo.toml': `${manifest}[patch.crates-io]\nfoo = { path = "patched/foo" }\n` }],
  ]) {
    withProject({ ...base, ...files }, (tmp) => {
      t.assert.equal(createCargoContext(tmp, { entries: ['src/lib.rs'] }).resolveCrate('foo', 'src/lib.rs'), where === 'crates-io' ? 'patched/foo/src/lib.rs' : 'vendor/foo-1.0.0/src/lib.rs', where)
    })
  }
})

test('buildRustBundle refuses a vendored file that isn\'t the one its .cargo-checksum.json lists, as cargo does', async (t) => {
  const lib = 'pub fn f() {}\n'
  const listed = createHash('sha256').update(lib).digest('hex')
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'src/main.rs': 'fn main() { foo::f() }\n',
    'vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n',
    'vendor/foo/.cargo-checksum.json': JSON.stringify({ files: { 'src/lib.rs': listed }, package: sha('a') }),
    'vendor/foo/src/lib.rs': lib,
  }
  await withProjectAsync(files, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] })
    t.assert.ok(bundle.sources.has('vendor/foo/src/lib.rs'))
    writeFileSync(join(tmp, 'vendor/foo/src/lib.rs'), 'mod injected;\npub fn f() {}\n')
    await t.assert.rejects(buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] }), { message: new RegExp(`^vendor/foo/src/lib\\.rs isn't the file vendor/foo/\\.cargo-checksum\\.json lists \\(sha256 [0-9a-f]{64}, listed ${listed}\\)`, 'u') })
  })
})

test('buildRustTree takes `r#false` for a custom cfg, not the literal `false`', async (t) => {
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': '#[cfg(r#false)]\nmod imp;\nmod other;\nuse crate::other::*;\npub fn f() { imp::g() }\n',
    'src/imp.rs': 'pub fn g() {}\n', 'src/other.rs': 'pub mod imp;\n', 'src/other/imp.rs': 'pub fn g() {}\n',
  }
  t.assert.equal(evalCfg('r#false', {}), null)
  t.assert.equal(evalCfg('false', {}), false)
  const imp = async (more) => withProjectAsync({ ...files, ...more }, async (tmp) => (await crateEdges(tmp, ['src/lib.rs'])).tree.resolutions.get('src/lib.rs').get('imp::g'))
  // presumed off, as any custom cfg: the glob's `imp`; set by the rustflags: the module
  t.assert.equal(await imp({}), 'src/other/imp.rs')
  t.assert.equal(await imp({ '.cargo/config.toml': '[build]\nrustflags = ["--cfg", "r#false"]\n' }), 'src/imp.rs')
})

test('createCargoContext takes a nested workspace\'s vendored crates from the directory its own cargo config names', async (t) => {
  await withProjectAsync({
    'sub/Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'sub/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'sub/app/src/lib.rs': 'pub use foo::f;\n',
    'sub/.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n',
    'sub/vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.1"\n', 'sub/vendor/foo/src/lib.rs': '',
    'vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'vendor/foo/src/lib.rs': '', // the outer project's
  }, async (tmp) => {
    const { files } = await crateEdges(tmp, ['sub/app/src/lib.rs'])
    t.assert.deepEqual(files, ['sub/app/src/lib.rs', 'sub/vendor/foo/src/lib.rs'])
  })
})

test('createCargoContext resolves an example with the dev-dependencies', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\ndep = { path = "dep" }\n[dev-dependencies]\ndep = { path = "dep", features = ["extra"] }\n',
    'src/lib.rs': '',
    'examples/demo.rs': 'fn main() { dep::f() }\n',
    'dep/Cargo.toml': '[package]\nname = "dep"\nversion = "0.1.0"\n[features]\nextra = []\n',
    'dep/src/lib.rs': '#[cfg(feature = "extra")]\nmod extra;\npub fn f() {}\n', 'dep/src/extra.rs': '',
  }, async (tmp) => {
    t.assert.ok((await crateEdges(tmp, ['examples/demo.rs'])).files.includes('dep/src/extra.rs'))
  })
})

test('createCargoContext resolves no dependency for a name no crate has, and so warns of none', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dev-dependencies]\nbar = "3"\n[target.\'cfg(windows)\'.dependencies]\nqux = "9"\n',
    'src/lib.rs': 'pub fn f() -> u8 { let _ = str::from_utf8(b""); undeclared::x(); u8::MAX }\n',
    ...vendoredPackage('bar', '1.0.0'), ...vendoredPackage('qux', '1.0.0'),
  }, async (tmp) => {
    // a dev-dependency and another platform's are no dependencies of this build; `u8::MAX`,
    // `str::from_utf8` and `undeclared::x` name no crate
    const { warnings } = await captureWarningsAsync(() => crateEdges(tmp, ['src/lib.rs'], { target: LINUX }))
    t.assert.deepEqual(besidesReplay(warnings), [])
  })
})

test('collectRustBundle warns once of a crate root it refuses, however often the tree asks for it', { skip: process.platform === 'win32' ? 'symlinks' : false }, async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'src/lib.rs': 'pub use foo::f;\nfn g() { foo::f() }\n',
    'secret.rs': 'pub fn f() {}\n',
    'vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n',
  }, async (tmp) => {
    mkdirSync(join(tmp, 'vendor/foo/src'))
    symlinkSync('../../../secret.rs', join(tmp, 'vendor/foo/src/lib.rs'))
    const { warnings } = await captureWarningsAsync(() => crateEdges(tmp, ['src/lib.rs']))
    t.assert.deepEqual(warnings.filter((w) => w.includes('Refusing file outside its package')), ['[loader.rust] Refusing file outside its package: vendor/foo/src/lib.rs (a link out of vendor/foo)'])
  })
})

// --- eleventh round: one directory cargo runs in, workspaces above, vendored manifests, what the build lacks ---

const VENDORED_SOURCES = '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n'

test('createCargoContext reads every cargo config setting from the configs cargo reads in the entries\' package directory', async (t) => {
  // A member's own config: cargo, run there, takes its [source], its [patch] and its rustflags --
  // all of them, never one without the others (`cargo build` in app/ compiles fork/src/lib.rs).
  const files = {
    'Cargo.toml': '[workspace]\nmembers = ["app"]\nresolver = "2"\n',
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'app/src/lib.rs': 'pub use foo::one;\nmod fast;\nmod slow;\nmod user;\n#[cfg(fast)] pub use fast::F;\n#[cfg(not(fast))] pub use slow::F;\n',
    'app/src/fast.rs': 'pub struct F;\n', 'app/src/slow.rs': 'pub struct F;\n', 'app/src/user.rs': 'fn f() { crate::F; }\n',
    'app/.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "../third"\n[patch.crates-io]\nfoo = { path = "../fork" }\n[build]\nrustflags = ["--cfg", "fast"]\n',
    'third/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'third/foo/src/lib.rs': 'pub fn one() {}\n',
    'fork/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'fork/src/lib.rs': 'pub fn one() {}\n',
  }
  await withProjectAsync(files, async (tmp) => {
    const { edges, tree } = await crateEdges(tmp, ['app/src/lib.rs'])
    t.assert.equal(edges['app/src/lib.rs']['use foo'], 'fork/src/lib.rs')
    t.assert.deepEqual([...tree.resolutions.get('app/src/user.rs').get('crate::F')], [['fast', 'app/src/fast.rs'], ['not(fast)', 'app/src/slow.rs']])
    const cargo = createCargoContext(tmp, { entries: ['app/src/lib.rs'] })
    t.assert.equal(cargo.vendorDir, 'third')
    t.assert.deepEqual(cargo.buildFilesFor('app/src/lib.rs').map((f) => f.path), ['app/Cargo.toml', 'Cargo.toml', 'app/.cargo/config.toml'])
  })
})

test('createCargoContext merges the [source] tables of the cargo configs key by key, the nearest first, as cargo does', async (t) => {
  // The bundle root's config replaces crates.io; the nested workspace's names the directory, its
  // own: `cargo build` in ws/ compiles ws/third/foo (1.0.0), not vendor/foo (1.5.0).
  await withProjectAsync({
    '.cargo/config.toml': VENDORED_SOURCES,
    'vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.5.0"\n', 'vendor/foo/src/lib.rs': '',
    'ws/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'ws/src/lib.rs': 'pub use foo::one;\n',
    'ws/.cargo/config.toml': '[source.vendored-sources]\ndirectory = "third"\n',
    'ws/third/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'ws/third/foo/src/lib.rs': '',
  }, async (tmp) => {
    t.assert.equal(createCargoContext(tmp, { entries: ['ws/src/lib.rs'] }).vendorDir, 'ws/third')
    t.assert.deepEqual((await crateEdges(tmp, ['ws/src/lib.rs'])).files, ['ws/src/lib.rs', 'ws/third/foo/src/lib.rs'])
  })
})

test('createCargoContext takes the workspace above the bundle root of a member only a member\'s path dependency makes, and its [patch]', async (t) => {
  // lib2 is a member as app's path dependency: `cargo build` in lib2/ takes the virtual
  // workspace's resolver 1, which unifies the dev-dependency's feature (foo/src/dev.rs).
  await withProjectAsync({
    'Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nlib2 = { path = "../lib2" }\n',
    'app/src/lib.rs': '',
    'lib2/Cargo.toml': '[package]\nname = "lib2"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = { path = "foo" }\n[dev-dependencies]\nfoo = { path = "foo", features = ["dev"] }\n',
    'lib2/src/lib.rs': 'pub use foo::f;\n',
    'lib2/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "0.1.0"\nedition = "2021"\n[features]\ndev = []\n',
    'lib2/foo/src/lib.rs': '#[cfg(feature = "dev")]\nmod dev;\n#[cfg(not(feature = "dev"))]\nmod nodev;\npub fn f() {}\n',
    'lib2/foo/src/dev.rs': '', 'lib2/foo/src/nodev.rs': '',
  }, async (tmp) => {
    t.assert.deepEqual((await crateEdges(join(tmp, 'lib2'), ['src/lib.rs'])).files, ['foo/src/dev.rs', 'foo/src/lib.rs', 'src/lib.rs'])
  })
  // The workspace root's [patch] applies when cargo builds the member from its own directory
  // (`cargo build` in app/ compiles app/fork/src/lib.rs), and its lockfile is cargo's, not one beside the member.
  await withProjectAsync({
    'Cargo.toml': '[workspace]\nmembers = ["app"]\nresolver = "2"\n[patch.crates-io]\nfoo = { path = "app/fork" }\n',
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'app/Cargo.lock': 'version = 4\n', // stale, from before the workspace: cargo never reads it
    'app/src/lib.rs': 'pub use foo::one;\n',
    'app/.cargo/config.toml': VENDORED_SOURCES,
    'app/vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'app/vendor/foo/src/lib.rs': 'pub fn one() {}\n',
    'app/fork/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'app/fork/src/lib.rs': 'pub fn one() {}\n',
  }, async (tmp) => {
    const root = join(tmp, 'app')
    t.assert.equal((await crateEdges(root, ['src/lib.rs'])).edges['src/lib.rs']['use foo'], 'fork/src/lib.rs')
    const cargo = createCargoContext(root, { entries: ['src/lib.rs'], target: LINUX })
    t.assert.deepEqual(cargo.resolution(), { mode: 'replay', why: 'the workspace root lies above the bundle root' })
    t.assert.deepEqual(cargo.buildFilesFor('src/lib.rs').map((f) => f.path), ['Cargo.toml', '.cargo/config.toml'])
  })
})

test('createCargoContext stops the build where a vendored Cargo.toml it resolves with isn\'t the one .cargo-checksum.json lists', async (t) => {
  const manifest = '[package]\nname = "foo"\nversion = "1.0.0"\n'
  const files = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\n',
    'src/main.rs': 'fn main() { foo::f() }\n',
    'vendor/foo/Cargo.toml': manifest,
    'vendor/foo/.cargo-checksum.json': JSON.stringify({ files: { 'Cargo.toml': createHash('sha256').update(manifest).digest('hex') }, package: sha('a') }),
    'vendor/foo/src/lib.rs': '#[cfg(feature = "x")]\nmod x;\npub fn f() {}\n', 'vendor/foo/src/x.rs': '',
  }
  await withProjectAsync(files, async (tmp) => {
    t.assert.ok(!(await buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] })).sources.has('vendor/foo/src/x.rs'))
    // edited after `cargo vendor` (cargo: "the listed checksum of … Cargo.toml has changed"): what
    // it says would turn `x` on, and the bundle stops before it does -- --cargo-manifests or not
    writeFileSync(join(tmp, 'vendor/foo/Cargo.toml'), `${manifest}[features]\ndefault = ["x"]\nx = []\n`)
    await t.assert.rejects(buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] }), { message: /^vendor\/foo\/Cargo\.toml isn't the file vendor\/foo\/\.cargo-checksum\.json lists/u })
  })
})

test('buildRustBundle reports every dependency the build links that the bundle lacks, whatever the code calls it', async (t) => {
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfoo = "1"\nmd-5 = "0.10"\nunused = "1"\n[dev-dependencies]\ndevonly = "1"\n[build-dependencies]\ncc = "1"\n[target.\'cfg(windows)\'.dependencies]\nwinonly = "1"\n',
    'src/lib.rs': 'pub use foo::one;\npub fn h() { let _ = md5::compute(b"x"); }\n',
    'build.rs': 'fn main() {}\n',
    'vendor/foo/Cargo.toml': '[package]\nname = "foo"\nversion = "1.0.0"\n', 'vendor/foo/src/lib.rs': 'pub fn one() {}\n',
  }, async (tmp) => {
    // md-5's lib is md5, which no manifest in the bundle says; `unused` is linked though nothing
    // names it. The dev-dependency isn't linked into the lib, the build-dependency only into the
    // build script (bundled with --cargo-manifests), the Windows one not into a Linux build.
    const lacking = async (opts) => (await captureWarningsAsync(() => buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], ...opts }))).warnings.find((w) => w.includes('not in the bundle'))
    t.assert.equal(await lacking({ cargoTarget: LINUX }), '[stasis] 2 crates referenced but not in the bundle: md-5 (a dependency of app 0.1.0), unused (a dependency of app 0.1.0)')
    t.assert.equal(await lacking({ cargoTarget: LINUX, cargoManifests: true }), '[stasis] 3 crates referenced but not in the bundle: cc (a dependency of app 0.1.0), md-5 (a dependency of app 0.1.0), unused (a dependency of app 0.1.0)')
    t.assert.equal(await lacking({}), '[stasis] 3 crates referenced but not in the bundle: md-5 (a dependency of app 0.1.0), unused (a dependency of app 0.1.0), winonly (a dependency of app 0.1.0)')
  })
})

test('createCargoContext({ cargo: true }) keeps what any build compiles: metadata\'s feature union is only maybe', { skip: hasCargo ? false : 'cargo not on PATH' }, async (t) => {
  // shared is a dependency with `t` and a build-dependency with `h`: cargo's target build compiles
  // lib.rs, t.rs and noth.rs, its host build lib.rs and h.rs; metadata reports `h` and `t` on.
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nshared = { path = "shared", features = ["t"] }\n[build-dependencies]\nshared = { path = "shared", features = ["h"] }\n',
    'build.rs': 'fn main() { shared::f(); }\n',
    'src/lib.rs': 'pub use shared::f;\n',
    'shared/Cargo.toml': '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2021"\n[features]\nt = []\nh = []\n',
    'shared/src/lib.rs': '#[cfg(feature = "t")]\nmod t;\n#[cfg(feature = "h")]\nmod h;\n#[cfg(not(feature = "h"))]\nmod noth;\n#[cfg(feature = "other")]\nmod other;\npub fn f() {}\n',
    'shared/src/t.rs': '', 'shared/src/h.rs': '', 'shared/src/noth.rs': '', 'shared/src/other.rs': '',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargo: true, cargoManifests: true })
    t.assert.deepEqual([...bundle.sources.keys()].filter((p) => p.startsWith('shared/src/')).toSorted(), ['shared/src/h.rs', 'shared/src/lib.rs', 'shared/src/noth.rs', 'shared/src/t.rs'])
  })
})

test('buildRustBundle does not presume off a cfg a build-dependency may print, or one the build script formats part of', async (t) => {
  const project = (extra) => ({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[build-dependencies]\nhelper = { path = "helper" }\n',
    'src/lib.rs': 'mod fast;\nmod slow;\nmod user;\n#[cfg(fast)] pub use fast::F;\n#[cfg(not(fast))] pub use slow::F;\n',
    'src/fast.rs': 'pub struct F;\n', 'src/slow.rs': 'pub struct F;\n', 'src/user.rs': 'fn f() { crate::F; }\n',
    'helper/Cargo.toml': '[package]\nname = "helper"\nversion = "0.1.0"\n',
    'helper/src/lib.rs': '/// Does nothing: no `cargo:rustc-cfg=` here, but in this comment.\npub fn noop() {}\n',
    'build.rs': 'fn main() { helper::noop(); }\n',
    ...extra,
  })
  const target = async (extra) => withProjectAsync(project(extra), async (tmp) => (await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'] })).imports.get('rust').get('src/user.rs').get('crate::F'))
  const either = new Map([['fast', 'src/fast.rs'], ['not(fast)', 'src/slow.rs']])
  // a build-dependency printing nothing leaves `fast` presumed off
  t.assert.equal(await target({}), 'src/slow.rs')
  // cfg_aliases' way: the helper prints the names its macro's input gives (`cfg_aliases! { fast: … }`)
  t.assert.deepEqual(await target({
    'helper/src/lib.rs': '#[macro_export]\nmacro_rules! alias {\n    ($name:ident) => { println!("cargo:rustc-cfg={}", stringify!($name)); };\n}\n',
    'build.rs': 'use helper::alias;\nfn main() { alias!(fast); }\n',
  }), either)
  // build-rs's way: the directive written apart from the name it is given
  t.assert.deepEqual(await target({
    'helper/src/lib.rs': 'pub fn rustc_cfg(key: &str) { emit("rustc-cfg", key) }\nfn emit(directive: &str, value: &str) { println!("cargo::{directive}={value}") }\n',
    'build.rs': 'fn main() { helper::rustc_cfg("fast"); }\n',
  }), either)
  // a helper printing one name it writes out sets that one only
  const fixed = (name) => ({ 'helper/src/lib.rs': `pub fn go() { println!("cargo:rustc-cfg=${name}"); }\n`, 'build.rs': 'fn main() { helper::go(); }\n' })
  t.assert.equal(await target(fixed('other')), 'src/slow.rs')
  t.assert.deepEqual(await target(fixed('fast')), either)
  // a build-dependency the bundle lacks may print one too
  t.assert.deepEqual(await target({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[build-dependencies]\nhelper = "1"\n' }), either)
  // a name the build script formats in part: `os_{}` may be `os_linux`, and so may `fast` be anything
  t.assert.deepEqual(await target({ 'build.rs': 'fn main() { let os = "linux"; println!("cargo::rustc-cfg=os_{}", os); }\n' }), either)
})

test('buildRustBundle keeps a module whose first variant the target rules out ahead of a glob of its name', async (t) => {
  // tokio's `cfg_has_atomic_u64! { #[path = "…native.rs"] mod imp; }` and its `cfg_not_…!` twin, beside a glob bringing an `imp` in
  const gates = 'macro_rules! cfg_has64 { ($($i:item)*) => { $( #[cfg(target_has_atomic = "64")] $i )* } }\nmacro_rules! cfg_not_has64 { ($($i:item)*) => { $( #[cfg(not(target_has_atomic = "64"))] $i )* } }\n'
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': `${gates}mod other;\nuse crate::other::*;\ncfg_has64! { #[path = "native.rs"] mod imp; }\ncfg_not_has64! { #[path = "as_mutex.rs"] mod imp; }\nfn f() { imp::X::real() }\n`,
    'src/other.rs': 'pub mod imp { pub struct X; }\n',
    'src/native.rs': 'pub struct X;\n',
    'src/as_mutex.rs': 'pub struct X;\n',
  }, async (tmp) => {
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: LINUX }) // no 64-bit atomics in this cfg set
    t.assert.equal(bundle.imports.get('rust').get('src/lib.rs').get('imp::X::real'), 'src/as_mutex.rs')
  })
})

test('buildRustBundle resolves a file the target rules out as it would where it is compiled', async (t) => {
  // tokio's atomic_u64_as_mutex.rs and its static_*.rs under a 64-bit target: their `super` is as_mutex's module
  const gates = 'macro_rules! cfg_has64 { ($($i:item)*) => { $( #[cfg(target_has_atomic = "64")] $i )* } }\nmacro_rules! cfg_not_has64 { ($($i:item)*) => { $( #[cfg(not(target_has_atomic = "64"))] $i )* } }\n'
  await withProjectAsync({
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': `${gates}cfg_has64! { #[path = "native.rs"] mod imp; }\ncfg_not_has64! { #[path = "as_mutex.rs"] mod imp; }\n`,
    'src/native.rs': 'pub(crate) use std::sync::atomic::AtomicU64;\n',
    'src/as_mutex.rs': 'mod static_macro;\npub(crate) struct AtomicU64;\n',
    'src/as_mutex/static_macro.rs': 'use super::AtomicU64;\n',
  }, async (tmp) => {
    const target = { ...LINUX, cfgs: new Set([...LINUX.cfgs, 'target_has_atomic="64"']) }
    const bundle = await buildRustBundle({ cwd: tmp, entries: ['src/lib.rs'], cargoTarget: target })
    t.assert.equal(bundle.imports.get('rust').get('src/as_mutex/static_macro.rs').get('super::AtomicU64'), 'src/as_mutex.rs')
  })
})
