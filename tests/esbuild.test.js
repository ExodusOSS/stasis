import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'esbuild-run.helper.js')
const fullFixture = join(here, 'fixtures', 'esbuild-full')
const nmFixture = join(here, 'fixtures', 'esbuild-nm')
const jsonFixture = join(here, 'fixtures', 'esbuild-json')

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (entries, { cwd, env = {} }) => {
  const r = spawnSync(process.execPath, [helper, ...entries], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, ...env },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-esbuild-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('lock=add --full records the entry and its imports', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'full' })
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  t.assert.deepEqual(lock.modules, {})
}))

test('lock=add --full is idempotent against the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const after = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
  t.assert.equal(after, before)
}))

test('lock=frozen --full succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
}))

test('lock=frozen --full rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=add --full rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=frozen --full rejects a brand-new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

  const r = run(['src/fresh.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=add --full rejects a changed package.json version', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = '99.99.99'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=replace --full rewrites the lockfile after a source change', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  const oldHash = JSON.parse(before).sources['.'].files['src/hello.js']
  const newHash = after.sources['.'].files['src/hello.js']
  t.assert.notEqual(newHash, oldHash)
  t.assert.ok(newHash.startsWith('sha512-'))
  t.assert.deepEqual(after.entries, ['src/entry.js'])
}))

test('lock=replace --full drops stale entries from the previous lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.sources['.'].files['src/stale.js'] = 'sha512-deadbeef'
  lock.entries.push('src/stale.js')
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(after.sources['.'].files['src/stale.js'], undefined)
  t.assert.ok(!after.entries.includes('src/stale.js'))
}))

test('lock=ignore --full tolerates the committed lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

test('bundle=add --full writes a bundle whose sources match disk', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(['src/entry.js'], {
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

test('bundle=load --full rejects a tampered source in the bundle', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // tamper: swap hello.js source for an attacker payload
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  // re-running with bundle=add (which pre-loads the bundle) must catch the disk/bundle disagreement
  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'frozen',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('bundle=replace rewrites a bundle that had stale orphan entries', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // forge a stale orphan into the existing bundle
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/orphan.js'] = 'export const x = 0\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'replace',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'replace',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(after.sources['.'].files['src/orphan.js'], undefined)
}))

test('node_modules scope records package files and skips src/', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' },
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

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('node_modules scope lock=frozen tolerates changes to non-tracked src/ files', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // src/ is outside node_modules scope, so changes here must not affect the lockfile check
  writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'mars'\n")

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
}))

test('lock=add --full records a .json import alongside the entry', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/data.json'].startsWith('sha512-'))
}))

test('lock=frozen --full succeeds with a committed .json import', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('lock=frozen --full rejects a changed .json import', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'data.json'), '{ "who": "mars" }\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('bundle=add --full captures a .json import in the bundle', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/data.json'], readFileSync(join(tmp, 'src/data.json'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('config scope conflict with env is reported', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // committed config is scope=full; setting node_modules via env must conflict
  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json/)
}))
