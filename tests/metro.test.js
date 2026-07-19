// End-to-end coverage for StasisMetro via the spawning helper.
//
// Metro isn't a dependency of this repo (and the plugin never imports it -- it only
// consumes the module graph Metro hands a serializer). So, like plugins.test.js and
// the State suites, these tests drive the plugin directly: the helper builds a
// faithful MOCK of Metro's ReadOnlyGraph (see metro-run.helper.js) and feeds it to
// the serializer hook exactly as Metro would.
//
// IMPORTANT: by default the helper constructs a preload State first and mirrors the
// test's options onto it, so the plugin resolves into the "reuse preload" path
// (rules 3 / 5) -- the unified-state behavior the plugin produces under the stasis
// loader. Tests at the bottom pass STASIS_TEST_PRELOAD=0 to exercise the standalone
// / noop / hard-throw paths instead.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

// In-process import for the withStasis transparency unit test below. Safe here: constructing an
// inert plugin (no options, no loader, no preload) mints no State, so it can't disturb the
// preload-singleton invariant the spawned tests rely on.
import { withStasis } from '../stasis-plugins/src/metro.js'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'metro-run.helper.js')
const fullFixture = join(here, 'fixtures', 'metro-full')
const nmFixture = join(here, 'fixtures', 'metro-nm')
const assetsFixture = join(here, 'fixtures', 'metro-assets')

// Module-graph manifests consumed by the helper (project-relative paths + edges).
const FULL_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] },
    { path: 'src/hello.js', deps: [] },
  ],
}
const NM_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['fake-esm-pkg', 'node_modules/fake-esm-pkg/index.js'], ['./helper.js', 'src/helper.js']] },
    { path: 'src/helper.js', deps: [] },
    { path: 'node_modules/fake-esm-pkg/index.js', deps: [] },
  ],
}
const ASSETS_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./logo.png', 'src/logo.png'], ['./icon.svg', 'src/icon.svg']] },
    { path: 'src/logo.png', deps: [] },
    { path: 'src/icon.svg', deps: [] },
  ],
}

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_CHILD_PROCESS: _cp,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  ...cleanEnv
} = process.env

// StasisMetro now asserts child-process capture is enabled (Metro transforms in workers), so
// every run sets it by default; a test below overrides it to '' to prove the assert fires.
const run = (entry, { cwd, env = {}, graph = FULL_GRAPH }) => {
  const r = spawnSync(process.execPath, [helper, entry], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, EXODUS_STASIS_CHILD_PROCESS: '1', STASIS_TEST_METRO_GRAPH: JSON.stringify(graph), ...env },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ----- Lockfile modes (full scope) ----------------------------------------------------

test('lock=add records the entry and its imports', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'full' })
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  t.assert.deepEqual(lock.modules, {})
  // The as-written specifier './hello.js' is recorded as the resolution edge.
  t.assert.equal(lock.imports['*']['src/entry.js']['./hello.js'], 'src/hello.js')
}))

test('lock=add is idempotent against the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
}))

test('lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('lock=frozen rejects a brand-new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

  const r = run('src/fresh.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' },
    graph: { modules: [{ path: 'src/fresh.js', deps: [] }] },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('lock=replace rewrites the lockfile after a source change', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  const oldHash = JSON.parse(before).sources['.'].files['src/hello.js']
  const newHash = after.sources['.'].files['src/hello.js']
  t.assert.notEqual(newHash, oldHash)
  t.assert.ok(newHash.startsWith('sha512-'))
  t.assert.deepEqual(after.entries, ['src/entry.js'])
}))

test('lock=ignore tolerates the committed lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

// ----- Bundle modes -------------------------------------------------------------------

test('bundle=add writes a bundle whose sources match disk', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
}))

test('bundle=load: the serializer is a transparent pass-through (load lives in the worker transformer)', withTmp((t, tmp) => {
  // Load is served by the companion worker transformer, so the serializer must pass
  // through, not throw -- metro.config.js is itself attested at capture, so a load run
  // executes the same config, plugin included.
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  // Capture real artifacts for the load run to absorb.
  const cap = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
  const bundleBefore = readFileSync(bundlePath)

  // Tamper a source AFTER capture: a serializer that still captured would trip frozen's hash assert.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = () => `tampered`\n')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      STASIS_TEST_METRO_MODE: 'customSerializer', STASIS_TEST_METRO_SERIALIZE_TWICE: '1',
    },
  })
  t.assert.equal(r.status, 0, `load-mode serialization must pass through; stderr: ${r.stderr}`)
  // Both invocations delegated to the base serializer (dev-server rebuild shape).
  t.assert.equal(r.stdout.match(/stasis base: 2 modules/gu)?.length, 2, `stdout: ${r.stdout}`)
  // Nothing captured, nothing written.
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'load must not touch the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'load must not touch the bundle')
}))

test('capture refuses a second serialization (watch/dev-server rebuild)', withTmp((t, tmp) => {
  // Capture's path-keyed dedupe would silently keep attesting first-build bytes on a
  // rebuild, so the second invocation must throw. (Load mode is exempt; see above.)
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      STASIS_TEST_METRO_MODE: 'customSerializer', STASIS_TEST_METRO_SERIALIZE_TWICE: '1',
    },
  })
  t.assert.notEqual(r.status, 0, 'second capture serialization must fail')
  t.assert.match(r.stderr, /watch\/dev-server rebuilds are not supported for capture/)
}))

// ----- node_modules scope -------------------------------------------------------------

test('node_modules scope records package files and skips src/', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'node_modules' })
  t.assert.equal(lock.entries, undefined)
  t.assert.equal(lock.sources, undefined)
  t.assert.ok(lock.modules['node_modules/fake-esm-pkg'])
  t.assert.ok(lock.modules['node_modules/fake-esm-pkg'].files['index.js'].startsWith('sha512-'))
}))

test('node_modules scope lock=frozen rejects a changed node_modules file', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'),
    'export const greet = (n) => `pwned, ${n}`\n'
  )

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('node_modules scope lock=frozen tolerates changes to non-tracked src/ files', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // src/ is outside node_modules scope, so changes here must not affect the check.
  writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'mars'\n")

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
}))

// ----- Plugin options coverage --------------------------------------------------------

const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

test('options.lock=add records the entry like the env path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('options.bundle=add with bundleFile writes the bundle at the chosen path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath }),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('options conflict with env is reported', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Config options can not override stasis env/)
}))

test('unknown plugin option is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown StasisMetro options/)
}))

test('invalid plugin option value is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Invalid lock/)
}))

test('capture without child-process is refused (Metro transforms in workers)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // The helper enables child-process by default; clear it to prove the plugin fails closed rather
  // than silently emit a lockfile missing the toolchain Metro's worker processes load.
  const r = run('src/entry.js', { cwd: tmp, env: { ...withOpts({ lock: 'add' }), EXODUS_STASIS_CHILD_PROCESS: '' } })
  t.assert.notEqual(r.status, 0, 'capture without child-process must fail')
  t.assert.match(r.stderr, /child-process capture must be enabled/)
}))

test('frozen verify is EXEMPT from the child-process assert (no shards minted in a verify run)', withTmp((t, tmp) => {
  // The StasisMetro assert fires only on a capture-that-writes (lock/bundle add|replace); a frozen
  // verify is per-process and channel-independent, so it must succeed even with child-process OFF.
  // The helper forces EXODUS_STASIS_CHILD_PROCESS=1 by default; clear it to prove the exemption.
  cpSync(fullFixture, tmp, { recursive: true })
  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_CHILD_PROCESS: '' } })
  t.assert.equal(r.status, 0, `frozen verify must not require --child-process; stderr: ${r.stderr}`)
}))

test('a CAPTURING plugin opts the build children into the SIGTERM shard flush (env flag set)', withTmp((t, tmp) => {
  // Metro ends transform workers by signal when they don't drain in time (jest-worker's
  // forceExit), which would silently drop their shards; the plugin therefore sets
  // EXODUS_STASIS_SHARD_SIGNAL_FLUSH on process.env at construction so the workers Metro
  // forks later inherit it and the loader flushes their shard on SIGTERM (hooks.js). The
  // forked-worker behavior itself is pinned in cli.test.js (cli-run-fork-resolve).
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const r = run('src/entry.js', { cwd: tmp, env: { ...withOpts({ lock: 'add' }), STASIS_TEST_REPORT_SIGNAL_FLUSH: '1' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /^SIGNAL_FLUSH=1$/m, 'capturing run must set the flush opt-in for its children')
}))

test('a NON-writing plugin does not opt children into the SIGTERM shard flush', withTmp((t, tmp) => {
  // Same gate as the child-process assert (writeLockfile || writeBundle): a frozen verify
  // mints no shard channel, so its children have nothing to flush -- the flag must stay
  // unset, keeping the loader's signal disposition untouched outside capturing Metro builds.
  cpSync(fullFixture, tmp, { recursive: true })
  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_REPORT_SIGNAL_FLUSH: '1' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /^SIGNAL_FLUSH=$/m, 'a non-writing run must not set the flush opt-in')
}))

test('a Rule-6 sidecar inherits childProcess from the preload (env-less programmatic option)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // Empty env => no env opinion, so childProcess is driven purely by the explicit preload option.
  // The plugin asks for its OWN bundle path (different from the preload's) => Rule-6 sidecar. The
  // sidecar must copy childProcess from the preload; before that fix it defaulted false and the
  // StasisMetro assert threw despite the user enabling it. (Capture mode: lock=add writes.)
  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_CHILD_PROCESS: '',
      STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', scope: 'full', bundle: 'add', bundleFile: join(tmp, 'preload.br'), childProcess: true }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', scope: 'full', bundle: 'add', bundleFile: join(tmp, 'sidecar.br') }),
    },
  })
  t.assert.equal(r.status, 0, `sidecar must inherit childProcess and not trip the assert; stderr: ${r.stderr}`)
}))

test('a Rule-6 sidecar (preload WITHOUT a bundle) inherits childProcess from the preload', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // The OTHER sidecar branch: the PRELOAD writes a lockfile but NO bundle, while the plugin asks
  // for its OWN bundle => the "bundle alongside a preload without bundle" sidecar. It must copy
  // childProcess from the preload too (the bundled-preload branch already did); before the fix this
  // branch omitted it, so on this env-less programmatic path the sidecar defaulted childProcess=false
  // and the StasisMetro assert threw despite the user enabling it.
  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_CHILD_PROCESS: '',
      STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', scope: 'full', bundle: 'none', childProcess: true }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', scope: 'full', bundle: 'add', bundleFile: join(tmp, 'sidecar.br') }),
    },
  })
  t.assert.equal(r.status, 0, `branch-2 sidecar must inherit childProcess and not trip the assert; stderr: ${r.stderr}`)
}))

// ----- Plugin↔preload coordination paths ----------------------------------------------

const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

test('rule 1: plugin lockfile without preload is a hard throw', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
}))

test('rule 0: plugin with no options, no preload, not under stasis run does nothing', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  // No capture options and not under `stasis run` -> the plugin is inert (Rule 0). Wiring
  // withStasis() into a config is a no-op on a plain build; it neither throws nor writes.
  const r = run('src/entry.js', { cwd: tmp, env: standalone(withOpts({})) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
    'inert plugin must not touch the lockfile')
}))

test('rule 0: inert withStasis is transparent -- it installs no serializer wrapper', (t) => {
  // The spawned e2e above runs the default `hook` mode and always has a base serializer, so it
  // can't catch a wrapper that falls back to metroDefaultSerializer(). Exercise the actual
  // withStasis()/customSerializer seam directly: an inert plugin (no options, no stasis run, no
  // preload) must hand the serializer back untouched -- NOT wrap it with one that would load
  // Metro internals and override Metro's own default when no base serializer exists.
  const saved = process.env.EXODUS_STASIS_LOCK
  delete process.env.EXODUS_STASIS_LOCK
  try {
    const base = () => '// base'
    const wrapped = withStasis({ serializer: { customSerializer: base } })
    t.assert.equal(wrapped.serializer.customSerializer, base,
      'an existing customSerializer is returned unchanged, not wrapped')

    const bare = withStasis({})
    t.assert.equal(bare.serializer?.customSerializer, undefined,
      'no wrapper is installed when the config had no customSerializer (Metro keeps its default)')
  } finally {
    if (saved === undefined) delete process.env.EXODUS_STASIS_LOCK
    else process.env.EXODUS_STASIS_LOCK = saved
  }
})

test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
    'noop plugin must not touch the lockfile')
}))

test('plugin standalone with bundle writes the bundle via the serializer hook', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath), 'plugin must write the bundle')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('a capture error does not write the bundle (no clobber)', withTmp((t, tmp) => {
  // The serializer captures before it writes, so a throw mid-capture (here: an
  // un-allowlisted extension) must leave the bundle file untouched.
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['./styles.css', 'src/styles.css']] },
        { path: 'src/hello.js', deps: [] },
        { path: 'src/styles.css', deps: [] },
      ],
    },
  })
  t.assert.notEqual(r.status, 0, `expected capture failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
  t.assert.equal(existsSync(bundlePath), false, 'failed capture must not write the bundle')
}))

test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const preloadBundle = join(tmp, 'preload.br')
  const sidecarBundle = join(tmp, 'sidecar.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // The preload bundle is written by the loader's exit hooks, which the helper
  // doesn't install; the plugin writes its own sidecar bundle on the hook.
  t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle must be written by the plugin')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
}))

// ----- resources allowlist (assets) ---------------------------------------------------

test('unknown extension throws unless it is in the resources allowlist', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['./styles.css', 'src/styles.css']] },
        { path: 'src/hello.js', deps: [] },
        { path: 'src/styles.css', deps: [] },
      ],
    },
  })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test('resources allowlist attests png/svg assets and tags per-file resource format', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  // Lockfile attests bytes for all three files; resources get resource/resource:base64.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
  t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')
  t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
  t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')
  // Resource imports carry no resolution edge (matches webpack/esbuild).
  t.assert.deepEqual(lock.imports, {})

  // Bundle: all three files live together; resources are tagged in formats.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
  t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
  t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
}))

test('resources frozen run passes against committed asset hashes and rejects a tampered asset', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true }) // ships a committed lockfile with png/svg
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  let r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'frozen', resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')

  // tamper the svg, frozen must reject
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')
  r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'frozen', resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.notEqual(r.status, 0, `expected frozen rejection; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('resources rejects code extensions', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /resources entry 'js' is a code extension/)
}))

// ----- Auto-included files (asyncRequire.js, setup_env.sh) -----------------------------

// Models the two well-known packages whose files StasisMetro auto-includes. Every OTHER
// test in this suite runs without them, which doubles as coverage for the both-absent
// case: an unresolvable auto-include is skipped silently (e.g. the first test's
// `lock.modules` deepEqual {}).
const ASYNC_REQUIRE = 'node_modules/metro-runtime/src/modules/asyncRequire.js'
const SETUP_ENV = 'node_modules/@react-native-community/cli/setup_env.sh'
const writeAutoIncludePackages = (tmp, { asyncRequire = true, setupEnv = true } = {}) => {
  if (asyncRequire) {
    const dir = join(tmp, 'node_modules', 'metro-runtime')
    mkdirSync(join(dir, 'src', 'modules'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'metro-runtime', version: '0.80.0' }))
    writeFileSync(join(tmp, ASYNC_REQUIRE), 'module.exports = function asyncRequire() {}\n')
  }
  if (setupEnv) {
    const dir = join(tmp, 'node_modules', '@react-native-community', 'cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '13.6.0' }))
    writeFileSync(join(tmp, SETUP_ENV), '#!/bin/bash\nexport NODE_BINARY=node\n')
  }
}

test('auto-includes: asyncRequire.js and setup_env.sh are attested at capture when present', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeAutoIncludePackages(tmp)
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.modules['node_modules/metro-runtime'].files['src/modules/asyncRequire.js'].startsWith('sha512-'))
  t.assert.ok(lock.modules['node_modules/@react-native-community/cli'].files['setup_env.sh'].startsWith('sha512-'))
  // asyncRequire is code (commonjs -- metro-runtime declares no `type`); setup_env.sh is
  // attested as a raw-UTF-8 resource WITHOUT 'sh' in the resources allowlist -- the
  // auto-include list is stasis-vetted, so it bypasses classifyExtension.
  t.assert.equal(lock.formats[ASYNC_REQUIRE], 'commonjs')
  t.assert.equal(lock.formats[SETUP_ENV], 'resource')
  // The app graph is still captured alongside.
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))

  // The bundle carries both payloads, formats tagged the same way.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.modules['node_modules/metro-runtime'].files['src/modules/asyncRequire.js'],
    readFileSync(join(tmp, ASYNC_REQUIRE), 'utf-8'))
  t.assert.equal(decoded.modules['node_modules/@react-native-community/cli'].files['setup_env.sh'],
    readFileSync(join(tmp, SETUP_ENV), 'utf-8'))
  t.assert.equal(decoded.formats[ASYNC_REQUIRE], 'commonjs')
  t.assert.equal(decoded.formats[SETUP_ENV], 'resource')
}))

test('auto-includes: entries are independent -- a missing one is skipped, the present one attested', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeAutoIncludePackages(tmp, { asyncRequire: false })

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.modules['node_modules/@react-native-community/cli'].files['setup_env.sh'].startsWith('sha512-'))
  t.assert.equal(lock.modules['node_modules/metro-runtime'], undefined, 'unresolvable auto-include is skipped')
}))

test('auto-includes: frozen verifies them and rejects a tampered setup_env.sh', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeAutoIncludePackages(tmp)

  let r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `capture stderr: ${r.stderr}`)

  r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `frozen must pass on captured auto-includes; stderr: ${r.stderr}`)

  // Auto-includes go through the same addFile path as graph modules, so tampering one
  // after capture must fail a frozen run closed -- the very reason to attest them.
  writeFileSync(join(tmp, SETUP_ENV), '#!/bin/bash\nexport NODE_BINARY=tampered\n')
  r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0, 'tampered setup_env.sh must be rejected')
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('auto-includes: an auto-include that is also a graph module is captured once, without conflict', withTmp((t, tmp) => {
  // With dynamic import() in the app, Metro puts asyncRequire in the graph itself; the
  // auto-include pass must dedupe against the graph capture rather than re-record it.
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeAutoIncludePackages(tmp)

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] },
        { path: 'src/hello.js', deps: [] },
        { path: ASYNC_REQUIRE, deps: [] },
      ],
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.modules['node_modules/metro-runtime'].files['src/modules/asyncRequire.js'].startsWith('sha512-'))
}))

// ----- Native modules (react-native config autolinking) -------------------------------

// A faithful stand-in for the `react-native` CLI: the plugin resolves `react-native/cli.js`
// from the project and spawns `node cli.js config`, so this mock is invoked EXACTLY as the
// real one is. It emits the real `react-native config` JSON shape (absolute root/podspecPath/
// sourceDir paths), parameterized by env so a test picks the native/JS deps -- and can force a
// failure/garbage output to exercise the fail-closed path. Real RN isn't a dependency of this
// repo, mirroring how the suite mocks Metro's graph rather than running Metro.
const RN_CLI_JS = `
const path = require('node:path')
const proj = process.cwd()
const nm = (n) => path.join(proj, 'node_modules', n)
if (process.env.__FAKE_RN_FAIL === 'exit') { process.stderr.write('boom from react-native config\\n'); process.exit(3) }
if (process.env.__FAKE_RN_FAIL === 'garbage') { process.stdout.write('not json at all'); process.exit(0) }
const dependencies = {}
for (const n of JSON.parse(process.env.__FAKE_NATIVE_DEPS || '[]')) {
  dependencies[n] = { root: nm(n), name: n, platforms: {
    ios: { podspecPath: path.join(nm(n), n + '.podspec') },
    android: { sourceDir: path.join(nm(n), 'android') },
  } }
}
for (const n of JSON.parse(process.env.__FAKE_JS_DEPS || '[]')) {
  dependencies[n] = { root: nm(n), name: n, platforms: { ios: null, android: null } }
}
// Real config reports react-native core only as reactNativePath -- NOT as a dependency.
if (process.argv[2] === 'config') { process.stdout.write(JSON.stringify({ root: proj, reactNativePath: nm('react-native'), dependencies })); process.exit(0) }
process.exit(1)
`
const writeReactNativeCli = (tmp) => {
  const dir = join(tmp, 'node_modules', 'react-native')
  mkdirSync(join(dir, 'third-party-podspecs'), { recursive: true })
  mkdirSync(join(dir, 'Libraries', 'FBLazyVector'), { recursive: true })
  mkdirSync(join(dir, 'sdks', 'hermes-engine'), { recursive: true })
  mkdirSync(join(dir, 'sdks', 'hermesc', 'linux64-bin'), { recursive: true })
  mkdirSync(join(dir, 'ReactCommon', 'yoga', 'yoga'), { recursive: true })
  mkdirSync(join(dir, 'ReactCommon', 'yoga', 'cmake'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'React'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'react-native', version: '0.76.0' }))
  writeFileSync(join(dir, 'cli.js'), RN_CLI_JS)
  // react-native core's own podspecs, in the scattered subdirs config never enumerates:
  writeFileSync(join(dir, 'third-party-podspecs', 'DoubleConversion.podspec'), "Pod::Spec.new { |s| s.name = 'DoubleConversion' }\n")
  writeFileSync(join(dir, 'Libraries', 'FBLazyVector', 'FBLazyVector.podspec'), "Pod::Spec.new { |s| s.name = 'FBLazyVector' }\n")
  // A podspec that `require_relative`s a sibling Ruby helper -- both must be captured:
  writeFileSync(join(dir, 'sdks', 'hermes-engine', 'hermes-engine.podspec'), 'require_relative "./hermes-utils.rb"\nPod::Spec.new { |s| s.name = "hermes-engine" }\n')
  writeFileSync(join(dir, 'sdks', 'hermes-engine', 'hermes-utils.rb'), 'def hermes_tag; "x"; end\n')
  // Vetted core native dirs/files captured IN FULL (RN_CORE_INCLUDE_DIRS/FILES): Yoga C++ +
  // cmake, the CocoaPods scripts (.rb/.sh), and the Hermes version marker under sdks/.
  writeFileSync(join(dir, 'ReactCommon', 'yoga', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.13)\n')
  writeFileSync(join(dir, 'ReactCommon', 'yoga', 'yoga', 'Yoga.cpp'), '// yoga\n')
  writeFileSync(join(dir, 'ReactCommon', 'yoga', 'cmake', 'yoga.cmake'), '# yoga cmake\n')
  writeFileSync(join(dir, 'scripts', 'react_native_pods.rb'), 'def use_react_native!; end\n')
  writeFileSync(join(dir, 'scripts', 'react-native-xcode.sh'), '#!/bin/bash\nnode cli.js bundle\n')
  writeFileSync(join(dir, 'scripts', 'build.js'), 'module.exports = 0\n') // code -> skipped even here
  writeFileSync(join(dir, 'sdks', '.hermesversion'), 'hermes-2024-01-01-RNv0.76\n')
  // Core files that must NOT be captured: index.js is code, React/RCTBridge.m is native source
  // OUTSIDE the vetted include dirs, hermesc is a prebuilt binary under sdks/ (not an include dir).
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(dir, 'React', 'RCTBridge.m'), '@implementation RCTBridge @end\n')
  writeFileSync(join(dir, 'sdks', 'hermesc', 'linux64-bin', 'hermesc'), 'ELF\0\xff') // prebuilt, no ext
}

// A native dependency package: native sources across ios/ + android/ (build-input source --
// podspec/gradle/Java/Kotlin/ObjC++/template/xml -- attested as CODE under a source tag; other
// assets like ObjC .m/.h as resources), a package.json carrying codegenConfig (attested + kept
// in full by prune), some UNused JS (should be skipped -- not a native input, not reachable),
// and two subtrees that must be pruned from the walk: the library's own example app and Gradle
// build output.
const writeNativeDep = (tmp, name) => {
  const root = join(tmp, 'node_modules', name)
  mkdirSync(join(root, 'ios'), { recursive: true })
  mkdirSync(join(root, 'android', 'src', 'main', 'java', 'com'), { recursive: true })
  mkdirSync(join(root, 'android', 'src', 'main', 'kotlin', 'com'), { recursive: true })
  mkdirSync(join(root, 'android', 'build'), { recursive: true })
  mkdirSync(join(root, 'android', 'src', 'main', 'jniLibs', 'arm64-v8a'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'ios', 'RNThing.xcodeproj'), { recursive: true })
  mkdirSync(join(root, 'fastlane'), { recursive: true })
  mkdirSync(join(root, 'example', 'ios'), { recursive: true })
  // A skia-style prebuilt/installed `libs/`: an Apple binary bundle (dir) + a static lib.
  mkdirSync(join(root, 'libs', 'apple', 'Skia.xcframework', 'ios-arm64'), { recursive: true })
  mkdirSync(join(root, 'libs', 'android', 'arm64-v8a'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name, version: '1.2.3', codegenConfig: { name: 'RNThingSpec', type: 'modules', jsSrcsDir: 'src' },
  }))
  writeFileSync(join(root, `${name}.podspec`), `Pod::Spec.new do |s|\n  s.name = "${name}"\nend\n`)
  writeFileSync(join(root, 'Extra.podspec.json'), JSON.stringify({ name: 'Extra', version: '1.0.0' })) // JSON podspec -> json
  writeFileSync(join(root, 'ios', 'RNThing.h'), '#import <React/RCTBridgeModule.h>\n')
  writeFileSync(join(root, 'ios', 'RNThing.m'), '#import "RNThing.h"\n@implementation RNThing\n@end\n')
  writeFileSync(join(root, 'ios', 'RNThing.mm'), '#import "RNThing.h"\n@implementation RNThing\n@end\n')
  writeFileSync(join(root, 'ios', 'RNThing.swift'), 'import Foundation\nclass RNThing {}\n')
  writeFileSync(join(root, 'ios', 'util.c'), 'int rn_util(void) { return 0; }\n')
  writeFileSync(join(root, 'ios', 'util.cpp'), 'int rn_util() { return 0; }\n')
  writeFileSync(join(root, 'ios', 'util.cc'), 'int rn_util_cc() { return 0; }\n')
  writeFileSync(join(root, 'ios', 'util.cxx'), 'int rn_util_cxx() { return 0; }\n')
  writeFileSync(join(root, 'ios', 'legacy.c++'), 'int rn_legacy() { return 0; }\n')
  writeFileSync(join(root, 'ios', 'util.hpp'), 'int rn_util();\n')
  writeFileSync(join(root, 'ios', 'util.hh'), 'int rn_util_hh();\n')
  writeFileSync(join(root, 'ios', 'util.hxx'), 'int rn_util_hxx();\n')
  writeFileSync(join(root, 'ios', 'legacy.h++'), 'int rn_legacy();\n')
  writeFileSync(join(root, 'ios', 'Podfile'), "pod 'RNThing', :path => '.'\n")
  writeFileSync(join(root, 'ios', 'Podfile.lock'), 'PODS:\n  - RNThing (3.1.0)\n')
  writeFileSync(join(root, 'ios', 'RNThing-Info.plist'), '<?xml version="1.0"?>\n<plist><dict/></plist>\n')
  writeFileSync(join(root, 'ios', 'PrivacyInfo.xcprivacy'), '<?xml version="1.0"?>\n<plist><dict/></plist>\n')
  writeFileSync(join(root, 'ios', 'RNThing.xcscheme'), '<?xml version="1.0"?>\n<Scheme/>\n')
  writeFileSync(join(root, 'ios', 'Main.storyboard'), '<?xml version="1.0"?>\n<document/>\n')
  writeFileSync(join(root, 'ios', 'RNThing.entitlements'), '<?xml version="1.0"?>\n<plist><dict/></plist>\n')
  writeFileSync(join(root, 'ios', 'RNThing.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n{ archiveVersion = 1; }\n')
  writeFileSync(join(root, 'gradlew'), '#!/usr/bin/env sh\nexec gradle "$@"\n') // the Gradle wrapper (shell)
  writeFileSync(join(root, '.env'), 'API_URL=https://example.com\n') // dotenv -> env
  writeFileSync(join(root, 'fastlane', 'Appfile'), "app_identifier('com.example.rnthing')\n")
  writeFileSync(join(root, 'fastlane', 'Fastfile'), 'lane :test do\nend\n')
  writeFileSync(join(root, 'android', 'build.gradle'), 'apply plugin: "com.android.library"\n')
  writeFileSync(join(root, 'android', 'settings.gradle.kts'), 'rootProject.name = "rnthing"\n')
  writeFileSync(join(root, 'android', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.13)\n')
  writeFileSync(join(root, 'android', 'src', 'main', 'AndroidManifest.xml'), '<manifest/>\n')
  writeFileSync(join(root, 'android', 'src', 'main', 'java', 'com', 'Thing.java'), 'package com;\nclass Thing {}\n')
  writeFileSync(join(root, 'android', 'src', 'main', 'kotlin', 'com', 'Thing.kt'), 'package com\nclass Thing\n')
  writeFileSync(join(root, 'android', 'BuildConfig.java.template'), 'package {{applicationId}};\n')
  writeFileSync(join(root, 'src', 'index.js'), 'export default {}\n')                 // unused JS -> skipped
  writeFileSync(join(root, 'android', 'build', 'generated.o'), 'BUILDOUTPUT')         // build output -> excluded
  writeFileSync(join(root, 'example', 'ios', 'Example.m'), '// example app source\n') // example app -> excluded
  // Prebuilt/installed binary artifacts -- generated output, never captured:
  writeFileSync(join(root, 'android', 'src', 'main', 'jniLibs', 'arm64-v8a', 'librnthing.so'), 'ELF\0\xff')
  writeFileSync(join(root, 'libs', 'android', 'arm64-v8a', 'libskia.a'), '!<arch>\0\xff')
  writeFileSync(join(root, 'libs', 'apple', 'Skia.xcframework', 'Info.plist'), '<plist/>\n') // text, but inside a skipped bundle dir
  writeFileSync(join(root, 'libs', 'apple', 'Skia.xcframework', 'ios-arm64', 'Skia.a'), '!<arch>\0\xff')
  // Non-build-input NOISE -- docs / editor-lint-CI config / logs / source maps / Xcode-project
  // metadata / off-platform -- excluded from the native globbing (no native build requires them):
  writeFileSync(join(root, 'README.md'), '# doc\n')
  writeFileSync(join(root, 'LICENSE'), 'MIT\n')
  writeFileSync(join(root, '.prettierrc'), '{}\n')
  writeFileSync(join(root, '.gitattributes'), '* text=auto\n')
  writeFileSync(join(root, '.flowconfig'), '[ignore]\n')
  writeFileSync(join(root, '.eslintignore'), 'lib/\n')
  writeFileSync(join(root, '.releaserc'), '{}\n')
  writeFileSync(join(root, '.clang-format'), 'BasedOnStyle: Google\n')
  writeFileSync(join(root, '.buckconfig'), '[buildfile]\n')
  writeFileSync(join(root, '.watchmanconfig'), '{}\n')
  writeFileSync(join(root, 'debug.log'), 'log line\n')
  writeFileSync(join(root, 'ios', 'RNThing.js.map'), '{"version":3}\n')
  writeFileSync(join(root, 'install.bat'), '@echo off\n')       // Windows batch -> excluded off Windows
  mkdirSync(join(root, 'ios', 'RNThing.xcodeproj', 'project.xcworkspace'), { recursive: true }) // Xcode project bundle
  writeFileSync(join(root, 'ios', 'RNThing.xcodeproj', 'project.pbxproj'), '// pbxproj\n')
  writeFileSync(join(root, 'ios', 'RNThing.xcodeproj', 'project.xcworkspace', 'contents.xcworkspacedata'), '<Workspace/>\n')
  mkdirSync(join(root, 'windows'), { recursive: true })         // react-native-windows project -> off Windows
  writeFileSync(join(root, 'windows', 'RNThing.cpp'), '// windows-only\n')
  // (Info.plist / PrivacyInfo.xcprivacy are written above as real build inputs -- kept, tagged xml.)
  return root
}

const NATIVE_INPUTS = [
  'react-native-native-lib.podspec', 'Extra.podspec.json',
  'ios/RNThing.h', 'ios/RNThing.m', 'ios/RNThing.mm', 'ios/RNThing.swift',
  'ios/util.c', 'ios/util.cpp', 'ios/util.cc', 'ios/util.cxx', 'ios/legacy.c++',
  'ios/util.hpp', 'ios/util.hh', 'ios/util.hxx', 'ios/legacy.h++',
  'ios/Podfile', 'ios/Podfile.lock',
  'ios/RNThing-Info.plist', 'ios/PrivacyInfo.xcprivacy', 'ios/RNThing.xcscheme', 'gradlew',
  'ios/Main.storyboard', 'ios/RNThing.entitlements', 'ios/RNThing.xcodeproj/project.pbxproj',
  '.env', 'fastlane/Appfile', 'fastlane/Fastfile',
  'android/build.gradle', 'android/settings.gradle.kts', 'android/CMakeLists.txt',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/java/com/Thing.java',
  'android/src/main/kotlin/com/Thing.kt',
  'android/BuildConfig.java.template',
  'package.json',
]

test('native modules: config discovers native deps; native sources attested, unused JS + example/build excluded', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeReactNativeCli(tmp)
  writeNativeDep(tmp, 'react-native-native-lib')
  // A JS-only autolinked dependency: `react-native config` reports it with null platforms, so
  // it has no native surface to attest (its used JS, if any, rides Metro's graph).
  mkdirSync(join(tmp, 'node_modules', 'js-only-lib'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'js-only-lib', 'package.json'), JSON.stringify({ name: 'js-only-lib', version: '1.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'js-only-lib', 'ios-not-really.m'), '// never walked -- dep is JS-only\n')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      __FAKE_NATIVE_DEPS: JSON.stringify(['react-native-native-lib']),
      __FAKE_JS_DEPS: JSON.stringify(['js-only-lib']),
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const mod = lock.modules['node_modules/react-native-native-lib']
  t.assert.ok(mod, 'native dependency module bucket recorded')
  for (const f of NATIVE_INPUTS) {
    t.assert.ok(mod.files[f]?.startsWith('sha512-'), `expected native input ${f} to be attested`)
  }
  t.assert.equal(mod.files['src/index.js'], undefined, 'unused JS in a native dep is not attested')
  t.assert.equal(mod.files['example/ios/Example.m'], undefined, 'the example app subtree is excluded')
  t.assert.equal(mod.files['android/build/generated.o'], undefined, 'build output is excluded')
  // Prebuilt/installed binary artifacts are never captured (react-native-skia's `libs/` case):
  // static libs, jniLibs .so, and everything inside an Apple *.xcframework bundle (incl. its
  // text Info.plist) -- generated output, not source.
  t.assert.equal(mod.files['libs/android/arm64-v8a/libskia.a'], undefined, 'a prebuilt .a is excluded')
  t.assert.equal(mod.files['android/src/main/jniLibs/arm64-v8a/librnthing.so'], undefined, 'a jniLibs .so is excluded')
  t.assert.equal(mod.files['libs/apple/Skia.xcframework/ios-arm64/Skia.a'], undefined, 'a lib inside an xcframework is excluded')
  t.assert.equal(mod.files['libs/apple/Skia.xcframework/Info.plist'], undefined, 'the whole *.xcframework bundle dir is skipped, not descended into')
  // Non-build-input noise is excluded from the native globbing: docs, editor/lint/CI config, logs,
  // source maps, Xcode project bundles, and off-platform (windows/, .bat off Windows).
  for (const f of ['README.md', 'LICENSE', '.prettierrc', '.gitattributes', '.flowconfig', '.eslintignore',
    '.releaserc', '.clang-format', '.buckconfig', '.watchmanconfig', 'debug.log', 'ios/RNThing.js.map',
    'install.bat', 'ios/RNThing.xcodeproj/project.pbxproj',
    'ios/RNThing.xcodeproj/project.xcworkspace/contents.xcworkspacedata', 'windows/RNThing.cpp']) {
    t.assert.equal(mod.files[f], undefined, `expected ${f} to be excluded from native capture`)
  }
  // (Info.plist + Apple's privacy manifest are kept, tagged 'xml' -- asserted below with the
  // other Apple-XML build inputs.)
  // Native build-input source is attested as CODE under a per-language source tag; package.json
  // rides the code path as json.
  const nlfmt = (rel) => lock.formats[`node_modules/react-native-native-lib/${rel}`]
  t.assert.equal(nlfmt('react-native-native-lib.podspec'), 'podspec')
  t.assert.equal(nlfmt('Extra.podspec.json'), 'json') // JSON podspec rides the code path as json
  t.assert.equal(nlfmt('android/build.gradle'), 'gradle')
  t.assert.equal(nlfmt('android/settings.gradle.kts'), 'kotlin') // Kotlin build script
  t.assert.equal(nlfmt('android/CMakeLists.txt'), 'cmake') // matched by basename
  t.assert.equal(nlfmt('android/src/main/java/com/Thing.java'), 'java')
  t.assert.equal(nlfmt('android/src/main/kotlin/com/Thing.kt'), 'kotlin')
  t.assert.equal(nlfmt('ios/RNThing.mm'), 'objcpp')
  t.assert.equal(nlfmt('ios/RNThing.m'), 'objc')
  t.assert.equal(nlfmt('ios/RNThing.swift'), 'swift')
  t.assert.equal(nlfmt('ios/RNThing.h'), 'c-header')
  t.assert.equal(nlfmt('ios/util.c'), 'c')
  t.assert.equal(nlfmt('ios/util.cpp'), 'cpp')
  t.assert.equal(nlfmt('ios/util.cc'), 'cpp')
  t.assert.equal(nlfmt('ios/util.cxx'), 'cpp')
  t.assert.equal(nlfmt('ios/legacy.c++'), 'cpp') // .c++ alt spelling
  t.assert.equal(nlfmt('ios/util.hpp'), 'cpp-header')
  t.assert.equal(nlfmt('ios/util.hh'), 'cpp-header')
  t.assert.equal(nlfmt('ios/util.hxx'), 'cpp-header')
  t.assert.equal(nlfmt('ios/legacy.h++'), 'cpp-header') // .h++ alt spelling
  t.assert.equal(nlfmt('ios/Podfile'), 'podfile') // matched by basename (no extension)
  t.assert.equal(nlfmt('ios/Podfile.lock'), 'podfile-lock') // basename, not the generic .lock ext
  t.assert.equal(nlfmt('gradlew'), 'shell') // the Gradle wrapper, matched by basename
  t.assert.equal(nlfmt('ios/RNThing-Info.plist'), 'xml')
  t.assert.equal(nlfmt('ios/PrivacyInfo.xcprivacy'), 'xml')
  t.assert.equal(nlfmt('ios/RNThing.xcscheme'), 'xml')
  t.assert.equal(nlfmt('ios/Main.storyboard'), 'xml')
  t.assert.equal(nlfmt('ios/RNThing.entitlements'), 'xml')
  t.assert.equal(nlfmt('ios/RNThing.xcodeproj/project.pbxproj'), 'xml') // old-style plist, tagged xml
  t.assert.equal(nlfmt('.env'), 'env')
  t.assert.equal(nlfmt('fastlane/Appfile'), 'fastlane') // matched by basename
  t.assert.equal(nlfmt('fastlane/Fastfile'), 'fastlane') // matched by basename
  t.assert.equal(nlfmt('android/src/main/AndroidManifest.xml'), 'xml')
  t.assert.equal(nlfmt('android/BuildConfig.java.template'), 'template')
  t.assert.equal(nlfmt('package.json'), 'json')
  // The JS-only dep contributes no native surface at all -- not even walked.
  t.assert.equal(lock.modules['node_modules/js-only-lib'], undefined, 'a JS-only autolinked dep has no native surface')
  // codegenConfig survives in the attested package.json bundle payload (prune keeps it in full).
  const pkg = JSON.parse(readFileSync(join(tmp, 'node_modules', 'react-native-native-lib', 'package.json'), 'utf-8'))
  t.assert.ok(pkg.codegenConfig, 'the attested package.json carries codegenConfig for the native build')
  // React Native CORE's own podspecs (via reactNativePath, not `dependencies`) are captured from
  // their scattered subdirs; its non-podspec files (index.js code, prebuilt hermesc) are not.
  const core = lock.modules['node_modules/react-native']
  t.assert.ok(core.files['third-party-podspecs/DoubleConversion.podspec']?.startsWith('sha512-'), 'core third-party podspec captured')
  t.assert.ok(core.files['Libraries/FBLazyVector/FBLazyVector.podspec']?.startsWith('sha512-'), 'core Libraries podspec captured')
  t.assert.equal(lock.formats['node_modules/react-native/third-party-podspecs/DoubleConversion.podspec'], 'podspec')
  // A podspec's required Ruby helper + the package.json podspecs parse are captured too.
  t.assert.ok(core.files['sdks/hermes-engine/hermes-engine.podspec']?.startsWith('sha512-'), 'core hermes podspec captured')
  t.assert.ok(core.files['sdks/hermes-engine/hermes-utils.rb']?.startsWith('sha512-'), 'the Ruby helper a podspec requires is captured')
  t.assert.equal(lock.formats['node_modules/react-native/sdks/hermes-engine/hermes-utils.rb'], 'ruby') // a .rb helper is code
  t.assert.ok(core.files['package.json']?.startsWith('sha512-'), 'core package.json (parsed by podspecs) captured')
  t.assert.equal(lock.formats['node_modules/react-native/package.json'], 'json')
  // Vetted core dirs/files are captured IN FULL: Yoga sources + cmake, the CocoaPods scripts,
  // and the Hermes version marker.
  for (const f of ['ReactCommon/yoga/CMakeLists.txt', 'ReactCommon/yoga/yoga/Yoga.cpp', 'ReactCommon/yoga/cmake/yoga.cmake', 'scripts/react_native_pods.rb', 'scripts/react-native-xcode.sh', 'sdks/.hermesversion']) {
    t.assert.ok(core.files[f]?.startsWith('sha512-'), `expected core include ${f} to be captured`)
  }
  // C++ source, the CocoaPods Ruby script, and CMake files are code; the shell script stays a resource.
  t.assert.equal(lock.formats['node_modules/react-native/ReactCommon/yoga/yoga/Yoga.cpp'], 'cpp')
  t.assert.equal(lock.formats['node_modules/react-native/scripts/react_native_pods.rb'], 'ruby')
  t.assert.equal(lock.formats['node_modules/react-native/ReactCommon/yoga/CMakeLists.txt'], 'cmake') // matched by basename
  t.assert.equal(lock.formats['node_modules/react-native/ReactCommon/yoga/cmake/yoga.cmake'], 'cmake')
  t.assert.equal(lock.formats['node_modules/react-native/scripts/react-native-xcode.sh'], 'resource') // a .sh script stays a resource
  // ...but NOT core's JS, native source outside the include dirs, or prebuilt binaries.
  t.assert.equal(core.files['index.js'], undefined, 'core JS is not captured')
  t.assert.equal(core.files['scripts/build.js'], undefined, 'a code file inside an include dir is still skipped')
  t.assert.equal(core.files['React/RCTBridge.m'], undefined, 'core native source outside the include dirs is not captured')
  t.assert.equal(core.files['sdks/hermesc/linux64-bin/hermesc'], undefined, 'core prebuilt hermesc binary is not captured')
}))

test('native modules: frozen verifies the native surface and rejects a tampered native source', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeReactNativeCli(tmp)
  writeNativeDep(tmp, 'react-native-native-lib')
  const base = { EXODUS_STASIS_SCOPE: 'full', __FAKE_NATIVE_DEPS: JSON.stringify(['react-native-native-lib']) }

  let r = run('src/entry.js', { cwd: tmp, env: { ...base, EXODUS_STASIS_LOCK: 'add' } })
  t.assert.equal(r.status, 0, `capture stderr: ${r.stderr}`)
  r = run('src/entry.js', { cwd: tmp, env: { ...base, EXODUS_STASIS_LOCK: 'frozen' } })
  t.assert.equal(r.status, 0, `frozen must pass on captured native sources; stderr: ${r.stderr}`)

  // Native sources go through the same addFile path as graph modules, so tampering one after
  // capture must fail a frozen run closed -- the very reason to attest them (prune safety).
  writeFileSync(join(tmp, 'node_modules', 'react-native-native-lib', 'ios', 'RNThing.m'), '// tampered\n')
  r = run('src/entry.js', { cwd: tmp, env: { ...base, EXODUS_STASIS_LOCK: 'frozen' } })
  t.assert.notEqual(r.status, 0, 'tampered native source must be rejected')
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('native modules: a failing react-native config aborts capture (fail-closed, no silent under-attest)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeReactNativeCli(tmp)

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', __FAKE_RN_FAIL: 'exit' },
  })
  t.assert.notEqual(r.status, 0, 'capture must abort when react-native config fails rather than under-attest')
  t.assert.match(r.stderr, /react-native config/)
  // A garbage (unparseable) config output must abort too.
  const r2 = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', __FAKE_RN_FAIL: 'garbage' },
  })
  t.assert.notEqual(r2.status, 0, 'unparseable config output must abort capture')
  t.assert.match(r2.stderr, /parse 'react-native config'/)
}))

test('native modules: a reached but NON-autolinked native module (podspec under lib/ios) is captured', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeReactNativeCli(tmp)
  // Manually-integrated native module (à la @exodus/react-native-payments): imported JS, a podspec
  // + native source under a non-standard lib/ios dir, and NOT reported by autolinking.
  const dep = join(tmp, 'node_modules', '@exodus', 'react-native-payments')
  mkdirSync(join(dep, 'lib', 'ios'), { recursive: true })
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: '@exodus/react-native-payments', version: '1.0.0' }))
  writeFileSync(join(dep, 'lib', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(dep, 'lib', 'ios', 'ReactNativePayments.podspec'), "Pod::Spec.new { |s| s.name = 'ReactNativePayments' }\n")
  writeFileSync(join(dep, 'lib', 'ios', 'ReactNativePayments.m'), '@implementation ReactNativePayments @end\n')

  // config reports NO native deps (autolinking misses it) -- only reactNativePath; the module is
  // reached purely through the JS graph edge below.
  const graph = {
    modules: [
      { path: 'src/entry.js', deps: [['@exodus/react-native-payments', 'node_modules/@exodus/react-native-payments/lib/index.js']] },
      { path: 'node_modules/@exodus/react-native-payments/lib/index.js', deps: [] },
    ],
  }
  const r = run('src/entry.js', { cwd: tmp, graph, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const mod = lock.modules['node_modules/@exodus/react-native-payments']
  t.assert.ok(mod, 'the reached, non-autolinked native module is captured')
  t.assert.ok(mod.files['lib/ios/ReactNativePayments.podspec']?.startsWith('sha512-'), 'its podspec (under lib/ios) is captured')
  t.assert.ok(mod.files['lib/ios/ReactNativePayments.m']?.startsWith('sha512-'), 'its native source (under lib/ios) is captured')
  t.assert.equal(lock.formats['node_modules/@exodus/react-native-payments/lib/ios/ReactNativePayments.podspec'], 'podspec')
  t.assert.equal(lock.formats['node_modules/@exodus/react-native-payments/lib/ios/ReactNativePayments.m'], 'objc') // ObjC is code
}))

test('native modules: no react-native CLI installed -> native capture is skipped, capture still succeeds', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // Deliberately do NOT install a react-native CLI: a non-RN Metro build has nothing native.
  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.modules, {}, 'no native modules attested when the RN CLI is absent')
}))

test('native modules: a native dep whose JS is imported is captured once; its native surface is still added', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeReactNativeCli(tmp)
  writeNativeDep(tmp, 'react-native-native-lib')

  const graph = {
    modules: [
      { path: 'src/entry.js', deps: [['react-native-native-lib', 'node_modules/react-native-native-lib/src/index.js']] },
      { path: 'node_modules/react-native-native-lib/src/index.js', deps: [] },
    ],
  }
  const r = run('src/entry.js', {
    cwd: tmp,
    graph,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', __FAKE_NATIVE_DEPS: JSON.stringify(['react-native-native-lib']) },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const files = lock.modules['node_modules/react-native-native-lib'].files
  // The imported JS is attested via the graph as CODE (not skipped, not double-recorded).
  t.assert.ok(files['src/index.js']?.startsWith('sha512-'), 'imported dep JS attested via the graph')
  t.assert.equal(lock.formats['node_modules/react-native-native-lib/src/index.js'], 'commonjs')
  // The native pass still adds the native build-input surface alongside it.
  t.assert.ok(files['react-native-native-lib.podspec']?.startsWith('sha512-'), 'podspec attested by the native pass')
  t.assert.ok(files['ios/RNThing.m']?.startsWith('sha512-'), 'native source attested by the native pass')
}))

// ----- Metro-specific: serializer wiring, preModules, virtual modules -----------------

const POLYFILL_GRAPH = {
  modules: FULL_GRAPH.modules,
  // Models Metro's prepended runtime/polyfills -- a real on-disk file the customSerializer
  // receives as `preModules` (created by the tests via writeFileSync).
  preModules: [{ path: 'runtime/polyfill.js', deps: [] }],
}
const writePolyfill = (tmp) => {
  mkdirSync(join(tmp, 'runtime'))
  writeFileSync(join(tmp, 'runtime', 'polyfill.js'), 'globalThis.__polyfilled = true\n')
}

test('customSerializer captures the graph and delegates to the base serializer for output', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_METRO_MODE: 'customSerializer' },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // Base serializer's output round-trips through the wrapper (proves delegation).
  t.assert.match(r.stdout, /stasis base: 2 modules/)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('customSerializer captures preModules (polyfills/runtime), not just the app graph', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writePolyfill(tmp)

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_METRO_MODE: 'customSerializer' },
    graph: POLYFILL_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /1 preModules/, 'the preModule was forwarded to the base serializer')
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['runtime/polyfill.js'].startsWith('sha512-'), 'preModule is hash-attested')
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'), 'app graph still attested')
}))

test('serializerHook does not see preModules (documented lower coverage)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writePolyfill(tmp)

  // Metro never passes preModules to experimentalSerializerHook, so the helper's hook path
  // doesn't forward them and the polyfill stays unattested -- the tradeoff that makes
  // withStasis/customSerializer the recommended surface.
  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_METRO_MODE: 'hook' },
    graph: POLYFILL_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.equal(lock.sources['.'].files['runtime/polyfill.js'], undefined, 'hook path leaves preModules unattested')
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'), 'app graph still attested')
}))

test('withStasis wires customSerializer, wraps the existing one, and captures graph + preModules', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writePolyfill(tmp)

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_METRO_MODE: 'withStasis' },
    graph: POLYFILL_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // The existing base customSerializer still produced the bundle output (delegation).
  t.assert.match(r.stdout, /stasis base: 2 modules, 1 preModules/)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['runtime/polyfill.js'].startsWith('sha512-'), 'preModule attested via withStasis')
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('virtual / unresolved graph entries are skipped (no disk-backed file, no edge)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  // The graph carries a synthetic module whose path doesn't exist on disk, plus an
  // unresolved edge (target null). Both must be silently skipped, leaving only the
  // real entry + hello.js captured.
  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['virtual:polyfill', null]] },
        { path: 'src/hello.js', deps: [] },
        { path: 'virtual:does-not-exist.js', deps: [] },
      ],
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.js', 'src/hello.js'])
  // Only the real, resolved code edge is attested.
  t.assert.deepEqual(lock.imports['*']['src/entry.js'], { './hello.js': 'src/hello.js' })
}))

test('real-Metro contract smoke test (ReadOnlyGraph / customSerializer / transformer)', { skip: 'metro is not a dependency; see comment' }, () => {
  // Every metro test above drives a hand-built MOCK of Metro's graph + transformer, because
  // Metro is intentionally NOT a dependency (matching stasis-core's zero-dep stance). The
  // mock is hardened (dependencies keyed by a synthetic opaque key, not the specifier; shapes
  // documented against real Metro versions) and the plugin reads only `.values()` +
  // `dep.data.name`, but nothing here exercises Metro's ACTUAL ReadOnlyGraph, customSerializer
  // signature, preModules arg, or transformer(config, projectRoot, filename, data, options)
  // contract -- so a future Metro that changes any of those would not be caught by CI.
  //
  // To pin the contract against reality (fast-follow): add `metro` as a devDependency and,
  // gated on it resolving, run a real `metro build` over a fixture with BOTH halves wired
  // permanently (`withStasis(config)` + top-level `transformerPath`) -- once to capture, then
  // again with EXODUS_STASIS_BUNDLE=load on the same config -- asserting the lockfile/bundle
  // round-trips. The mock is the verified surface today.
})
