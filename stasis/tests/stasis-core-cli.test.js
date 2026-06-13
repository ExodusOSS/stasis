import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

// The zero-dependency `stasis-core` CLI exposes only `run` and `prune` (no
// bundle/extract/audit, and crucially no --mock, which lives in the @exodus/stasis
// tooling package). These tests pin that surface; the run-time behaviour itself is
// the same loader covered by tests/cli.test.js.
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', '..', 'stasis-core', 'bin', 'stasis-core.js')
const runFixture = join(here, 'fixtures', 'cli-run')
const pruneFixture = join(here, 'fixtures', 'prune')

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

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-core-cli-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('no command prints usage limited to run + prune', (t) => {
  const r = run([])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
  t.assert.match(r.stderr, /stasis-core run/)
  t.assert.match(r.stderr, /stasis-core prune/)
  // bundle/extract/audit are tooling commands and must not appear here
  t.assert.doesNotMatch(r.stderr, /stasis-core (?:bundle|extract|audit)/)
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

test('run does not support --mock (tooling-only flag)', (t) => {
  const r = run(['run', '--lock=none', '--bundle=add', '--bundle-file=/tmp/x.br', '--mock', 'a.js'])
  t.assert.notEqual(r.status, 0)
  // never proceeds to announce a run config for an unsupported flag
  t.assert.doesNotMatch(r.stderr, /Running stasis with config/)
})

test('prune validates and removes against the lockfile', withTmp((t, tmp) => {
  cpSync(pruneFixture, tmp, { recursive: true })
  const r = run(['prune', tmp])
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /validated 3 file\(s\), removed 4 file\(s\)/)
}))
