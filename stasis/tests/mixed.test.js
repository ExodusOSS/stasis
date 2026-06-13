import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stasis.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-mixed')

const {
  EXODUS_STASIS_LOCK: _l,
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

test('run --lock=add records an ESM entry that imports both ESM and CJS node_modules', (t) => {
  const lockPath = join(fixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, expectedOut)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.equal(after, before)

  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  t.assert.ok(parsed.modules['node_modules/fake-esm-pkg'])
  t.assert.ok(parsed.modules['node_modules/fake-cjs-pkg'])
})

test('run --lock=frozen replays the mixed program from the committed lockfile', (t) => {
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, expectedOut)
})

test('run --lock=frozen rejects a dependency resolution redirected on disk to another attested file', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  // Point fake-esm-pkg's legacy `main` at the other (also attested) package.
  // Every byte that loads still hash-matches the lockfile -- package.json is
  // not hash-attested -- so only the resolution cross-check can catch this.
  const pkgPath = join(tmp, 'node_modules', 'fake-esm-pkg', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.main = '../fake-cjs-pkg/index.js'
  writeFileSync(pkgPath, JSON.stringify(pkg) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* mismatches the lockfile/)
  // The check aborts at resolve time, before load, so no module code runs.
  t.assert.doesNotMatch(r.stdout, /hello from/, 'no module code may execute when a resolution is rejected')
}))

test('run --bundle=frozen rejects a dependency resolution redirected on disk to another attested file', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // frozen bundle is self-attesting; lock=none
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, expectedOut)

  // Point fake-esm-pkg's legacy `main` at the other (also attested) package. Every byte
  // that loads still matches the bundle -- package.json is not byte-attested -- so only
  // the bundle's recorded resolution edge can catch the redirect (the byte/format checks
  // can't see a specifier pointed at a *different* attested file).
  const pkgPath = join(tmp, 'node_modules', 'fake-esm-pkg', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.main = '../fake-cjs-pkg/index.js'
  writeFileSync(pkgPath, JSON.stringify(pkg) + '\n')

  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* mismatches the frozen bundle/)
  // The check aborts at resolve time, before load, so no module code runs.
  t.assert.doesNotMatch(r.stdout, /hello from/, 'no module code may execute when a resolution is rejected')
}))

test('run --lock=add --bundle=frozen persists nothing when a swallowed resolution redirect would poison the lockfile', withTmp((t, tmp) => {
  // Guards the addImport-side taint: the redirect is rejected at resolve time (addImport),
  // but if user code swallows it and exits 0, the captured state must still not be written
  // -- otherwise the recorded edge poisons a later lock=frozen run. Mirrors the swallowed-
  // *bytes* test but tampers the *resolution*.
  cpSync(fixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // Entry dynamically imports fake-esm-pkg and swallows any failure; build the bundle from it.
  writeFileSync(join(tmp, 'src', 'entry.js'), "try { await import('fake-esm-pkg') } catch {}\nconsole.log('survived')\n")
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // Redirect fake-esm-pkg's main to the other (also attested) package: the observed
  // resolution now mismatches the bundle's recorded edge.
  const pkgPath = join(tmp, 'node_modules', 'fake-esm-pkg', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.main = '../fake-cjs-pkg/index.js'
  writeFileSync(pkgPath, JSON.stringify(pkg) + '\n')

  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`) // the rejection was swallowed
  t.assert.match(r.stdout, /survived/)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'a swallowed resolution-redirect rejection must not persist a poisoned lockfile')
}))

test('run --bundle=add records module and commonjs formats side by side', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
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
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: fixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: fixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, expectedOut)
}))
