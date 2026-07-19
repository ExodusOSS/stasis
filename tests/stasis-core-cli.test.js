import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

// The zero-dependency `stasis-core` CLI exposes `run`, `prune`, and `add` (which packs
// explicitly listed files into the project's bundles -- no scanner/loaders). Deep
// bundling, extract/audit, and --mock stay in the @exodus/stasis tooling package. These tests
// pin that surface; the run-time behaviour itself is the same loader covered by tests/cli.test.js.
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')
const runFixture = join(here, 'fixtures', 'cli-run')
const forkFixture = join(here, 'fixtures', 'cli-run-fork')
const pruneFixture = join(here, 'fixtures', 'prune')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-core-cli-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('no command prints usage limited to run + prune + add', (t) => {
  const r = run([])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
  t.assert.match(r.stderr, /stasis-core run/)
  t.assert.match(r.stderr, /stasis-core prune/)
  // The core CLI's only bundling is the zero-dep add packer (no scanner/loaders).
  t.assert.match(r.stderr, /stasis-core add/)
  // extract/audit and deep (dependency-resolving) bundling are tooling commands that
  // stay on the full `stasis` CLI and must not appear here.
  t.assert.doesNotMatch(r.stderr, /stasis-core (?:extract|audit)/)
})

test('--version prints the package version', (t) => {
  const r = run(['--version'])
  t.assert.equal(r.status, 0)
  t.assert.match(r.stdout, /^v\d+\.\d+\.\d+/u)
})

test('run with no path prints "Nothing to run"', (t) => {
  const r = run(['run', '--lock=add'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to run/)
})

test('run rejects an invalid --lock value', (t) => {
  const r = run(['run', '--lock=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --lock value/)
})

test('run executes an entry under a frozen lockfile via the core loader', (t) => {
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /\[stasis-core\] Running stasis with config:/)
})

test('run --lock=none --bundle=frozen verifies a built bundle via the core loader', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // frozen bundle needs no sibling lockfile
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const r = run(['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundle: 'frozen'/)
}))

test('run does not support --mock (tooling-only flag)', (t) => {
  const r = run(['run', '--lock=none', '--bundle=add', '--bundle-file=/tmp/x.br', '--mock', 'a.js'])
  t.assert.notEqual(r.status, 0)
  // never proceeds to announce a run config for an unsupported flag
  t.assert.doesNotMatch(r.stderr, /Running stasis with config/)
})

test('run: a forked child is enforced from the bundle but does not write (via the core loader)', withTmp((t, tmp) => {
  cpSync(forkFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Capture without forking to seed the lockfile + bundle.
  const seed = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(seed.status, 0, `seed stderr: ${seed.stderr}`)
  const lockBaseline = readFileSync(join(tmp, 'stasis.lock.json'))

  // Run from the bundle with the fork happening; the child (worker.js, not a declared entry)
  // is served from the bundle, and the frozen lockfile must be left untouched by the child.
  rmSync(join(tmp, 'src'), { recursive: true })
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /^WORKER hello, child lock=frozen bundle=load$/m)
  t.assert.deepEqual(readFileSync(join(tmp, 'stasis.lock.json')), lockBaseline, 'child must not rewrite the lockfile')
}))

test('run reports 128+signo when the child dies from a signal', withTmp((t, tmp) => {
  // A signal-killed child (SIGSEGV, SIGKILL, OOM-kill) closes with code=null; the launcher
  // must not turn that into an implicit exit 0. 137 = 128 + SIGKILL(9), the shell convention.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'sigkill-fixture', version: '0.0.0', private: true, type: 'module' }))
  writeFileSync(join(tmp, 'entry.js'), "process.kill(process.pid, 'SIGKILL')\n")
  const r = run(['run', '--lock=ignore', 'entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 137, `stderr: ${r.stderr}`)
}))

test('prune validates and removes against the lockfile', withTmp((t, tmp) => {
  cpSync(pruneFixture, tmp, { recursive: true })
  const r = run(['prune', tmp])
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /validated 3 file\(s\), removed 4 file\(s\)/)
}))
