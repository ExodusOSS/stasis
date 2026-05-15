import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stasis.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-mixed')

const {
  EXODUS_STASIS_MODE: _m,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mixed-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const expectedOut = 'hello from esm, esm\nhello from cjs, cjs\n'

test('run --update --full records an ESM entry that imports both ESM and CJS node_modules', (t) => {
  const lockPath = join(fixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--update', '--full', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, expectedOut)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.equal(after, before)

  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  t.assert.ok(parsed.modules['node_modules/fake-esm-pkg'])
  t.assert.ok(parsed.modules['node_modules/fake-cjs-pkg'])
})

test('run --frozen --full replays the mixed program from the committed lockfile', (t) => {
  const r = run(['run', '--frozen', '--full', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, expectedOut)
})

test('run --bundle=save records module and commonjs formats side by side', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: fixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, expectedOut)
  t.assert.ok(existsSync(bundlePath))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['node_modules/fake-esm-pkg/index.js'], 'module')
  t.assert.equal(decoded.formats['node_modules/fake-cjs-pkg/index.js'], 'commonjs')
}))

test('run --bundle=load executes the mixed program from a saved bundle', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--update', '--full', '--bundle=save', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: fixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--frozen', '--full', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: fixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, expectedOut)
}))
