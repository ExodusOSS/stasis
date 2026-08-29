// End-to-end coverage for the Next.js withStasis wrapper via the spawning helper, which
// reproduces Next's driving contract: every compiler config generated through the wrapped
// `webpack(config, ctx)` hook first, then SEQUENTIAL webpack 5 builds in one process (see
// tests/nextjs-run.helper.js). Standalone-path tests (STASIS_TEST_PRELOAD=0 +
// EXODUS_STASIS_LOCK env = "under stasis run") are the ones that exercise the wrapper's core
// promise -- ONE shared plugin instance whose capture write coalesces at process exit;
// preload-path tests pin the reuse behavior under the real loader.

import { test, describe } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'nextjs-run.helper.js')
const fixture = join(here, 'fixtures', 'nextjs-plugin')

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  TURBOPACK: _t,
  ...cleanEnv
} = process.env

// Async child-process runner (see webpack.test.js for why not spawnSync).
const run = async ({ cwd, env = {} }) => {
  const child = spawn(process.execPath, [helper, 'src/server-entry.js', 'src/client-entry.js'], {
    cwd,
    env: { ...cleanEnv, ...env },
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-nextjs-'))
  try {
    cpSync(fixture, dir, { recursive: true })
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CONCURRENCY = 4 // matches the other spawning suites; each test runs two webpack builds

describe('withStasis for Next.js (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('standalone capture merges both sequential compilers into ONE lockfile', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_PRELOAD: '0' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    // One shared plugin instance across the compiler configs -- the wrapper's core invariant.
    t.assert.match(r.stdout, /STASIS_INSTANCES=1/)
    t.assert.match(r.stdout, /BUILD_server=ok/)
    t.assert.match(r.stdout, /BUILD_client=ok/)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    // Both compilers' entries and their DISJOINT reaches land in the one artifact: the
    // server-only and client-only modules can only both be present if the captures merged.
    t.assert.deepEqual(lock.entries, ['src/client-entry.js', 'src/server-entry.js'])
    const files = Object.keys(lock.sources['.'].files).toSorted()
    t.assert.deepEqual(files, [
      'lib/client-only.js',
      'lib/server-only.js',
      'lib/shared.js',
      'src/client-entry.js',
      'src/server-entry.js',
    ])
    t.assert.ok(lock.imports['*']['src/server-entry.js']['../lib/server-only.js'])
    t.assert.ok(lock.imports['*']['src/client-entry.js']['../lib/client-only.js'])
  }))

  test('standalone bundle=add captures both compilers into one bundle file', withTmp(async (t, tmp) => {
    const bundlePath = join(tmp, 'snapshot.br')
    const r = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
        STASIS_TEST_PRELOAD: '0',
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath), 'bundle written by the exit flush')
    const { brotliDecompressSync } = await import('node:zlib')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['lib/server-only.js'], readFileSync(join(tmp, 'lib/server-only.js'), 'utf-8'))
    t.assert.equal(decoded.sources['.'].files['lib/client-only.js'], readFileSync(join(tmp, 'lib/client-only.js'), 'utf-8'))
  }))

  test('a failed later compiler poisons the deferred write: NO partial lockfile lands', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_FAIL: 'client',
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stdout, /BUILD_server=ok/)
    t.assert.match(r.stdout, /BUILD_client=failed/)
    // The server compiler succeeded and captured, but the SESSION failed: a write now would
    // replace a good lockfile with one missing the client compiler's whole graph.
    t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'no partial artifact on a failed build')
  }))

  test('capture under a preload reuses it (single unified lockfile, no plugin-owned write)', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const files = Object.keys(lock.sources['.'].files)
    t.assert.ok(files.includes('lib/server-only.js') && files.includes('lib/client-only.js'),
      'preload State carries both compilers\' captures')
  }))

  test('lock=frozen verifies against the captured lockfile; a tampered source fails it', withTmp(async (t, tmp) => {
    const capture = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_PRELOAD: '0' },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    const frozen = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_PRELOAD: '0' },
    })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)

    writeFileSync(join(tmp, 'lib', 'shared.js'), 'exports.shared = () => "tampered"\n')
    const tampered = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_PRELOAD: '0' },
    })
    t.assert.notEqual(tampered.status, 0)
    t.assert.match(tampered.stderr, /ERR_ASSERTION|sha512-|ModuleBuildError/)
  }))

  test('chains the user webpack hook: marker kept, stasis lands after it, once per config', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_USER_WEBPACK: '1',
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    for (const compiler of ['server', 'client']) {
      t.assert.match(r.stdout, new RegExp(`MARKER_PRESENT_${compiler}=true`))
      t.assert.match(r.stdout, new RegExp(`STASIS_PLUGINS_${compiler}=1`))
      t.assert.match(r.stdout, new RegExp(`STASIS_AFTER_MARKER_${compiler}=true`))
    }
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'capture still ran through the chained config')
  }))

  test('a user webpack hook that forgets to return the config fails loudly', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_USER_RETURNS_NOTHING: '1',
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /StasisNextJS: the wrapped webpack\(\) hook returned undefined/)
  }))

  test('inert without env/options/preload: no plugin pushed, plain build untouched', withTmp(async (t, tmp) => {
    const r = await run({ cwd: tmp, env: { STASIS_TEST_PRELOAD: '0' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stdout, /PLUGINS_server=0/)
    t.assert.match(r.stdout, /PLUGINS_client=0/)
    t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))
  }))

  test('withStasis returns a NEW config object and does not mutate the input', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_PURITY: '1',
        STASIS_TEST_NEXT_USER_WEBPACK: '1',
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stdout, /PURITY_NEW_OBJECT=true/)
    t.assert.match(r.stdout, /PURITY_INPUT_WEBPACK_UNTOUCHED=true/)
    t.assert.match(r.stdout, /PURITY_CARRIES_FIELDS=true/)
  }))

  test('experimental.webpackBuildWorker + a writing mode is refused', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_WORKER: '1',
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /webpackBuildWorker builds each compiler in a separate\s+process/)
    t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))
  }))

  test('experimental.webpackBuildWorker with a verify-only mode stays allowed', withTmp(async (t, tmp) => {
    // Capture first (no worker), then a frozen verify with the worker flag on: verification
    // writes nothing, so per-worker States can't clobber anything -- it must pass.
    const capture = await run({
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_PRELOAD: '0' },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const frozen = await run({
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'frozen',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_NEXT_WORKER: '1',
      },
    })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)
  }))

  test('TURBOPACK env + active stasis intent refuses at wrap time', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        TURBOPACK: '1',
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        STASIS_TEST_PRELOAD: '0',
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Turbopack never runs the webpack hooks/)
  }))

  test('TURBOPACK env with stasis opted out passes through untouched', withTmp(async (t, tmp) => {
    const r = await run({
      cwd: tmp,
      env: {
        TURBOPACK: '1',
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'none', bundle: 'none' }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stdout, /PLUGINS_server=0/)
  }))

  test('explicit options without env: lock=none + bundle=add writes the bundle as trust root', withTmp(async (t, tmp) => {
    const bundlePath = join(tmp, 'app.code.br')
    const r = await run({
      cwd: tmp,
      env: {
        STASIS_TEST_PRELOAD: '0',
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'none', bundle: 'add', bundleFile: bundlePath }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))
    t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'lock=none writes no lockfile')
  }))
})

test('withStasis rejects a function config with guidance', async (t) => {
  const { withStasis } = await import('../stasis/src/nextjs.js')
  t.assert.throws(
    () => withStasis(() => ({})),
    /takes a next config OBJECT; a function config must be resolved first/
  )
})

test('withStasis rejects unknown stasis options at wrap time', async (t) => {
  const { withStasis } = await import('../stasis/src/nextjs.js')
  t.assert.throws(() => withStasis({}, { lokc: 'add' }), /Unknown StasisNextJS options: lokc/)
})
