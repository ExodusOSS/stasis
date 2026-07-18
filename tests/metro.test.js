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
