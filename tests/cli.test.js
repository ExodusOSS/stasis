import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stasis.js')
const runFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run')

// strip any inherited stasis env vars so the CLI's env-conflict guard doesn't trip
const {
  EXODUS_STASIS_MODE: _m,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

// util.inspect colorises strings when stderr supports colours (e.g. pnpm/npm running
// scripts in a TTY, or FORCE_COLOR set), so strip ANSI before matching.
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-bundle-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('no command prints usage and exits 1', (t) => {
  const r = run([])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
  t.assert.match(r.stderr, /stasis run/)
})

test('unknown command prints usage and exits 1', (t) => {
  const r = run(['nope'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
})

test('run with no path prints "Nothing to run"', (t) => {
  const r = run(['run', '--update'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to run/)
})

test('run rejects --update together with --frozen', (t) => {
  const r = run(['run', '--update', '--frozen', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--update conflicts with --frozen/)
})

test('run requires --update or --frozen', (t) => {
  const r = run(['run', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--frozen or --update is required/)
})

test('run rejects an invalid --bundle value', (t) => {
  const r = run(['run', '--update', '--bundle=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --bundle value/)
})

test('run rejects --bundle-file without a non-none --bundle', (t) => {
  const r = run(['run', '--update', '--bundle-file=/tmp/nope.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle-file requires --bundle/)
})

test('run --update --full executes the entry and rewrites the lockfile idempotently', (t) => {
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--update', '--full', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /\[stasis\] Running stasis with config:/)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.equal(after, before)

  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.config, { scope: 'full' })
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  t.assert.ok(parsed.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(parsed.sources['.'].files['src/hello.js'].startsWith('sha512-'))
})

test('run --frozen --full executes the entry using the committed lockfile', (t) => {
  const r = run(['run', '--frozen', '--full', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /mode: 'frozen'/)
})

test('run --frozen fails when scope conflicts with the committed lockfile', (t) => {
  // lockfile in the fixture was generated with scope=full; running without --full
  // sets EXODUS_STASIS_SCOPE=node_modules, which can't override stasis.config.json
  const r = run(['run', '--frozen', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json/)
})

test('run --debug emits the debug warning on stderr', (t) => {
  const r = run(['run', '--update', '--full', '--debug', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /stasis debug mode active/)
})

test('run --bundle=save --bundle-file writes the bundle at the chosen path/filename', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundleFile:/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 0)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.equal(decoded.sources['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
}))

test('run --bundle=load --bundle-file round-trips through a save', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /mode: 'frozen'/)
  t.assert.match(load.stderr, /bundle: 'load'/)
}))

test('run --bundle=load fails when --bundle-file does not exist', withTmp((t, tmp) => {
  const r = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.notEqual(r.status, 0)
}))

test('run --frozen --bundle=save writes the bundle without rewriting the lockfile', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(
    ['run', '--frozen', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /mode: 'frozen'/)
  t.assert.match(r.stderr, /bundle: 'save'/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'frozen mode must not rewrite the lockfile')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 0)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.equal(decoded.sources['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
}))

test('run --frozen --bundle=save round-trips through --bundle=load', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--frozen', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=save creates intermediate directories for --bundle-file', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'nested', 'deeper', 'out.br')
  const save = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(bundlePath))
}))

test('run --bundle=load serves the entry from the bundle when its source is absent on disk', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove every source file -- bundle=load must run entirely from the bundle.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=load serves the entry from the bundle when only the entry is missing', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Keep the imported hello.js on disk, but make the entry missing.
  rmSync(join(tmp, 'src', 'entry.js'))

  const load = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))
