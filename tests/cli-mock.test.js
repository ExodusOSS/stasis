import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

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

// Async-aware: the cli.test.js withTmp drops `await` and would wipe the dir
// before an async body resolves.
const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mock-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('run --mock denies fs/child_process/network side-effects (fail closed) while capturing the import graph', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Sentinel lives *outside* the project's allowed-write tree: writes inside cwd
  // are intentionally permitted (that's where the bundle/lockfile go).
  const sentinel = join(dirname(tmp), `mock-test-sentinel-${process.pid}.txt`)
  rmSync(sentinel, { force: true })

  const r = run(
    ['run', '--lock=none', '--full', '--bundle=add', `--bundle-file=${bundlePath}`, '--mock', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_MOCK_SENTINEL: sentinel } }
  )
  // status 0 also proves the unhandledRejection trap swallowed the fire-and-forget
  // `void fetch(beacon)` denial -- otherwise the run would crash before exit.
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /mock: true/)

  // Permission layer (fs write + child_process).
  t.assert.match(r.stdout, /write blocked ERR_ACCESS_DENIED/)
  t.assert.match(r.stdout, /spawn blocked ERR_ACCESS_DENIED/)
  // JS-mock layer (network builtins + fetch/WebSocket), all fail closed.
  t.assert.match(r.stdout, /http blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /net blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /ws blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /fetch blocked .*stasis --mock/)
  t.assert.doesNotMatch(r.stdout, /NOT BLOCKED/)
  t.assert.match(r.stdout, /hello, world/)

  t.assert.ok(!existsSync(sentinel), 'fs write outside cwd must be blocked')

  // The import graph is captured despite every side effect being denied.
  t.assert.ok(existsSync(bundlePath), 'bundle should be written by stasis (allowed path)')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/hello.js'])
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
  // The runtime loader keys imports by a conditions string, not "*"; assert the
  // entry->hello edge was captured regardless of which conditions key holds it.
  const captured = Object.values(decoded.imports)
    .some((m) => m['src/entry.js']?.['./hello.js'] === 'src/hello.js')
  t.assert.ok(captured, 'import edge src/entry.js -> ./hello.js must be captured')
}))

test('run --mock with --bundle=load is rejected (mock is for capture, not replay)', (t) => {
  const r = run(['run', '--lock=frozen', '--full', '--bundle=load', '--bundle-file=/tmp/x.br', '--mock', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--mock is for capturing imports/)
})
