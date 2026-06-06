import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'
import { createConnection } from 'node:net'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stasis.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-effects')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// Async-aware: the existing cli.test.js withTmp drops `await` and trips on
// async test bodies (the `finally` wipes the dir before the body resolves).
const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mock-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const portInUse = (port) => new Promise((resolve) => {
  const s = createConnection({ host: '127.0.0.1', port }, () => { s.end(); resolve(true) })
  s.on('error', () => resolve(false))
})

// Pick ports unlikely to collide with anything the host or parallel tests bind.
const PORT_NEUTRALIZED = 54323
const PORT_REPLAYED = 54324

test('run --mock blocks fs writes, child_process, and HTTP servers while still capturing the import graph', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Sentinel lives *outside* the project's allowed-write tree so we exercise
  // the permission system's path scoping -- writes inside cwd would otherwise
  // be allowed (the lockfile/bundle write paths sit there).
  const sentinel = join(dirname(tmp), `mock-test-sentinel-${process.pid}.txt`)
  rmSync(sentinel, { force: true })

  const r = run(
    ['run', '--lock=none', '--full', '--bundle=add', `--bundle-file=${bundlePath}`, '--mock', 'src/entry.js'],
    {
      cwd: tmp,
      env: { ...cleanEnv, STASIS_MOCK_SENTINEL: sentinel, STASIS_MOCK_PORT: String(PORT_NEUTRALIZED) },
    }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /mock: true/)
  t.assert.match(r.stdout, /write blocked ERR_ACCESS_DENIED/)
  t.assert.match(r.stdout, /spawn blocked ERR_ACCESS_DENIED/)
  t.assert.match(r.stdout, /listening\? false/)
  t.assert.doesNotMatch(r.stdout, /NOT BLOCKED/)
  t.assert.match(r.stdout, /hello, world/)

  t.assert.ok(!existsSync(sentinel), 'fs write outside cwd must be blocked')
  t.assert.equal(await portInUse(PORT_NEUTRALIZED), false, 'http.createServer().listen() must be a no-op')

  // Bundle was built despite blocked side effects -- the import graph is captured.
  t.assert.ok(existsSync(bundlePath), 'bundle should be written by stasis (allowed path)')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/hello.js'])
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
}))

test('run --mock with --bundle=load is rejected (mock is for capture, not replay)', (t) => {
  const r = run(['run', '--lock=frozen', '--full', '--bundle=load', '--bundle-file=/tmp/x.br', '--mock', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--mock is for capturing imports/)
})

test('a bundle built under --mock runs normally (with real side effects) when loaded back', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // This time we let the bundled code actually run; the sentinel sits inside
  // cwd so a non-mock replay can write to it normally.
  const sentinel = join(tmp, 'replay-wrote.txt')

  const save = run(
    ['run', '--lock=none', '--full', '--bundle=add', `--bundle-file=${bundlePath}`, '--mock', 'src/entry.js'],
    {
      cwd: tmp,
      env: { ...cleanEnv, STASIS_MOCK_SENTINEL: sentinel, STASIS_MOCK_PORT: String(PORT_REPLAYED) },
    }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Wipe the source tree so the load path must serve the (mock-built) bundle.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=none', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    {
      cwd: tmp,
      env: { ...cleanEnv, STASIS_MOCK_SENTINEL: sentinel, STASIS_MOCK_PORT: String(PORT_REPLAYED) },
    }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.match(load.stdout, /hello, world/)
  t.assert.match(load.stdout, /write NOT BLOCKED/, 'the replayed bundle is the same source -- side effects happen')
  t.assert.ok(existsSync(sentinel), 'replay wrote the sentinel')
}))
