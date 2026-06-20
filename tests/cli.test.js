import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const runFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run')
const nmFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm')
const nmCjsFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm-cjs')
const jsonAttrFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-json-attr')
const forkFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-fork')

// strip any inherited stasis env vars so the CLI's env-conflict guard doesn't trip
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
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
  const r = run(['run', '--lock=add'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to run/)
})

test('run with no flags defaults --lock=none and hits the bundle-required constraint', (t) => {
  const r = run(['run', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /needs a lockfile or a bundle/)
})

test('run rejects an invalid --lock value', (t) => {
  const r = run(['run', '--lock=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --lock value/)
})

test('run rejects an invalid --bundle value', (t) => {
  const r = run(['run', '--lock=add', '--bundle=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --bundle value/)
})

test('run rejects --bundle-file without a non-none --bundle', (t) => {
  const r = run(['run', '--lock=add', '--bundle-file=/tmp/nope.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle-file requires --bundle/)
})

test('run rejects --bundle=load with --lock=add', (t) => {
  const r = run(['run', '--lock=add', '--bundle=load', '--bundle-file=/tmp/x.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle=load is incompatible with --lock=\(add\|replace\)/)
})

test('run rejects --bundle=load with --lock=replace', (t) => {
  const r = run(['run', '--lock=replace', '--bundle=load', '--bundle-file=/tmp/x.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle=load is incompatible with --lock=\(add\|replace\)/)
})

test('run rejects --lock=none without a bundle', (t) => {
  const r = run(['run', '--lock=none', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /stasis needs a lockfile or a bundle: set --lock or --bundle/)
})

test('run --lock=add executes the entry and rewrites the lockfile idempotently', (t) => {
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: runFixture })
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

test('run --lock=frozen executes the entry using the committed lockfile', (t) => {
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
})

test('run --lock=add rejects a changed source file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // change a tracked file: hashes must no longer match the committed lockfile
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=frozen rejects a brand new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")
  const r = run(['run', '--lock=frozen', 'src/fresh.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=add rejects a changed package.json version', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = '99.99.99'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=frozen --bundle=load detects a tampered source in the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // tamper with the bundle: swap hello.js source for an attacker-controlled payload
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  // remove on-disk sources so bundle=load is the only source of code
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'tampered payload must not be executed')
}))

test('run --lock=replace --bundle=add rejects when disk disagrees with the pre-loaded bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // seed the bundle with the original sources
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // change disk: even though the lockfile is being replaced, --bundle=add pre-loads
  // the bundle's sources and addFile must noupsert the on-disk bytes against them
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=replace', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=add --bundle=replace still enforces the lockfile when rebuilding the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // change disk: lockfile is preserved (lock=add). bundle is being rebuilt (bundle=replace).
  // The lockfile's hash for hello.js no longer matches disk -- addFile must reject this.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=add', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=replace rewrites the lockfile from scratch when a source file changed', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['run', '--lock=replace', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'bonjour, world\n')
  t.assert.match(r.stderr, /lock: 'replace'/)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.notEqual(after, before, 'lockfile must be rewritten with new hashes')
  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  // hash for hello.js must reflect the new bytes, not the stale committed value
  const beforeHash = JSON.parse(before).sources['.'].files['src/hello.js']
  const afterHash = parsed.sources['.'].files['src/hello.js']
  t.assert.notEqual(afterHash, beforeHash)
  t.assert.ok(afterHash.startsWith('sha512-'))
}))

test('run --lock=replace ignores stale entries from the previous lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  // forge a stale entry into the committed lockfile; replace mode must drop it
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.sources['.'].files['src/stale.js'] = 'sha512-deadbeef'
  lock.entries.push('src/stale.js')
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=replace', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(after.sources['.'].files['src/stale.js'], undefined, 'stale file must be dropped')
  t.assert.ok(!after.entries.includes('src/stale.js'), 'stale entry must be dropped')
}))

test('run --bundle=add rejects a changed source file when bundle exists', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // create the bundle with the original content
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // now change a source file -- re-running --bundle=add must refuse to overwrite
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(
    ['run', '--lock=replace', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
}))

test('run --bundle=replace rewrites the bundle from scratch when a source file changed', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const beforeBundle = readFileSync(bundlePath)
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'bonjour, world\n')
  t.assert.match(r.stderr, /bundle: 'replace'/)

  const afterBundle = readFileSync(bundlePath)
  t.assert.notEqual(afterBundle.toString('base64'), beforeBundle.toString('base64'))
  const decoded = JSON.parse(brotliDecompressSync(afterBundle))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], 'export const greet = (n) => `bonjour, ${n}`\n')
}))

test('run --bundle=replace ignores stale sources in the existing bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // forge a stale entry by re-saving a tampered bundle
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/orphan.js'] = 'export const x = 0\n'
  decoded.formats['src/orphan.js'] = 'javascript:module'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(after.sources['.'].files['src/orphan.js'], undefined, 'orphan source must be dropped')
}))

test('run --lock=frozen fails when scope conflicts with the committed lockfile', (t) => {
  // lockfile in the fixture was generated with scope=full; running with --dependencies
  // sets EXODUS_STASIS_SCOPE=node_modules, which can't override stasis.config.json
  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json/)
})

test('run --debug emits the debug warning on stderr', (t) => {
  const r = run(['run', '--lock=add', '--debug', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /stasis debug mode active/)
})

test('run --bundle=add --bundle-file writes the bundle at the chosen path/filename', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundleFile:/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].name, 'stasis-cli-run')
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'javascript:module')
  t.assert.equal(decoded.formats['src/hello.js'], 'javascript:module')
}))

test('run --bundle=load --bundle-file round-trips through a save', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lock: 'frozen'/)
  t.assert.match(load.stderr, /bundle: 'load'/)
}))

test('run --bundle=load fails when --bundle-file does not exist', withTmp((t, tmp) => {
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.notEqual(r.status, 0)
}))

test('run --lock=frozen --bundle=add writes the bundle without rewriting the lockfile', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(
    ['run', '--lock=frozen', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
  t.assert.match(r.stderr, /bundle: 'add'/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=frozen must not rewrite the lockfile')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'javascript:module')
  t.assert.equal(decoded.formats['src/hello.js'], 'javascript:module')
}))

test('run --lock=frozen --bundle=add round-trips through --bundle=load', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=frozen', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

// --- bundle=frozen: the bundle as a read-only attestation that operates like a
// lockfile. It needs no sibling lockfile (lock=none here): each file is read from
// disk and verified against the bundle's own recorded bytes/resolutions/formats,
// the bundle is never rewritten, and any drift fails closed. seedFrozenBundle
// builds a bundle into tmp and removes the committed lockfile so lock=none holds.
const seedFrozenBundle = (t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // bundle=frozen is self-sufficient; lock=none
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  return bundlePath
}

test('run --lock=none --bundle=frozen runs the entry, verifying disk against the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundle: 'frozen'/)
}))

test('run --bundle=frozen does not rewrite the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  const before = readFileSync(bundlePath)
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.deepEqual(readFileSync(bundlePath), before, 'bundle=frozen must not rewrite the bundle')
}))

test('run --bundle=frozen rejects a source file changed on disk', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // change a tracked file: its bytes no longer match the frozen bundle
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /bonjour/, 'the changed code must not run')
}))

test('run --bundle=frozen rejects a brand new file the bundle never recorded', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/fresh.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /not attested by the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /fresh/, 'an unattested entry must not run')
}))

test('run --bundle=frozen rejects an on-disk format flip (tampered package.json type)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // entry.js is attested as `javascript:module` in the bundle's formats. Flipping
  // the workspace package.json `type` makes Node treat the same hash-valid bytes as
  // commonjs -- `type` is not itself hash-attested, so only the format
  // cross-check against the frozen bundle can catch this.
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.type = 'commonjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed format for .* mismatches the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no code may run when a format is rejected')
}))

test('run --bundle=frozen rejects a tampered bundle whose recorded bytes diverge from disk', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // Tamper the bundle (not disk): swap hello.js's recorded source. The on-disk
  // file still holds the original bytes, so the noupsert against the bundle-seeded
  // sources must reject the divergence -- the frozen bundle is not trusted blindly.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'tampered bundle bytes must not run')
}))

test('run --bundle=frozen fails with a clear error when the bundle file is missing', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // stasis.config.json is still present, so discovery runs and the existence check fires early
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No bundle, but attempting to run in frozen bundle mode/)
}))

test('run --lock=frozen --bundle=frozen verifies against both, without rewriting either', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build the bundle while keeping the committed lockfile (lock=add round-trips it).
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
  const bundleBefore = readFileSync(bundlePath)

  const r = run(
    ['run', '--lock=frozen', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
  t.assert.match(r.stderr, /bundle: 'frozen'/)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'lock=frozen must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --lock=replace --bundle=frozen writes the lockfile but leaves the frozen bundle untouched', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundleBefore = readFileSync(bundlePath)

  // A writing lock mode composes with a frozen bundle: lock=replace builds a fresh
  // lockfile from the run while bundle=frozen verifies disk against the bundle and
  // never rewrites it.
  const r = run(
    ['run', '--lock=replace', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'lock=replace must write a lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --lock=add --bundle=frozen bootstraps a lockfile from the verified run, without a pre-existing one', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp) // removes the committed lockfile
  const bundleBefore = readFileSync(bundlePath)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'precondition: no lockfile on disk')

  // A self-attesting frozen bundle needs no sibling lockfile, so lock=add can write a
  // fresh one from the run (verified against the bundle) instead of demanding one exist.
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'lock=add must bootstrap a lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --bundle=frozen fails closed with no stasis files at all (no silent skip)', withTmp((t, tmp) => {
  // Regression: the bundle-existence check must fire even when the project has no
  // stasis.config.json/lock/etc. In node_modules scope the workspace entry is outside
  // the attested zone, so a missing bundle here once let it run unverified.
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  rmSync(join(tmp, 'stasis.config.json'))
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No bundle, but attempting to run in frozen bundle mode/)
  t.assert.equal(r.stdout, '', 'nothing may run when the frozen bundle is absent')
}))

// node_modules-scope frozen bundle: only node_modules sources are attested; the
// workspace is deliberately outside the attested zone (same carve-out as lock=frozen).
const seedFrozenNmBundle = (t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // self-attesting; lock=none
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')
  return bundlePath
}

test('run --dependencies --bundle=frozen verifies node_modules against the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /scope: 'node_modules'/)
  t.assert.match(r.stderr, /bundle: 'frozen'/)
}))

test('run --dependencies --bundle=frozen rejects a tampered node_modules file (attested zone)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  writeFileSync(join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'), 'export const greet = (w) => `pwned, ${w}`\n')
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'a tampered dependency must not run')
}))

test('run --dependencies --bundle=frozen tolerates a changed workspace file (unattested zone)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  // In node_modules scope the workspace is not attested by the bundle, so editing a
  // workspace file is allowed -- only node_modules drift is frozen. Mirrors lock=frozen.
  writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'frozen'\n")
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, frozen\n', 'the edited workspace file runs; only node_modules is frozen')
}))

test('run --lock=add --bundle=frozen does not persist a lockfile when a tamper is detected', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp) // removes the committed lockfile, seeds the bundle
  // Tamper a tracked file. The frozen run must reject it (fail-closed execution) AND must
  // not write a lockfile baking in the tampered hash -- otherwise a later lock=frozen run
  // would trust the poisoned lockfile and execute the very drift this run refused. The
  // write is suppressed because addFile's frozen check throws (not because the exit code
  // is non-zero), so the suppression is on the verification, not the exit status.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'an aborted frozen run must not persist a (poisoned) lockfile')
}))

test('run --lock=replace --bundle=frozen does not persist a lockfile when a tamper is detected', withTmp((t, tmp) => {
  // lock=replace always rewrites and needs no pre-existing lockfile, so it hits the
  // poisoning path independently of the lock=add bootstrap above.
  const bundlePath = seedFrozenBundle(t, tmp)
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=replace', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'lock=replace must not write a poisoned lockfile on a detected tamper')
}))

test('run --lock=add --bundle=frozen persists nothing when a frozen rejection is swallowed and the run exits clean', withTmp((t, tmp) => {
  // The suppression is keyed on the verification, not the exit code: even if user code
  // catches the frozen rejection and the process exits 0, the captured (tampered) state
  // must not be written -- otherwise a swallowed mismatch poisons a later lock=frozen run.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // Entry dynamically imports hello.js and swallows any failure; build the bundle from it.
  writeFileSync(join(tmp, 'src', 'entry.js'), "try { await import('./hello.js') } catch {}\nconsole.log('survived')\n")
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // Tamper hello.js: the dynamic import's frozen byte-check throws, the entry swallows it, exit 0.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`) // the import error was swallowed
  t.assert.match(r.stdout, /survived/)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'a swallowed frozen rejection must not persist a poisoned lockfile')
}))

test('run --lock=add --bundle=add still writes the capture when the program exits non-zero', withTmp((t, tmp) => {
  // A clean capture that exits non-zero for its own reasons (a server's SIGINT shutdown, a
  // CLI reporting failures) must still persist what it captured -- the write is gated on
  // stasis's own verification, not the program's exit code.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'snapshot.br')
  writeFileSync(join(tmp, 'src', 'entry.js'), "import { greet } from './hello.js'\nconsole.log(greet('world'))\nprocess.exit(3)\n")
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 3, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(bundlePath), 'a non-zero exit must not block the bundle write')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'a non-zero exit must not block the lockfile write')
}))

test('run --lock=add persists the clean capture when the run aborts for a non-verification reason', withTmp((t, tmp) => {
  // Boundary of the verification-based gate: an abort that does NOT originate in a stasis
  // check (here an uncaught module-not-found, thrown by Node's resolver before addImport)
  // does not taint, so the cleanly captured files are still written. This is the deliberate
  // trade-off of gating on the verification rather than the exit code; a partial lockfile
  // here is harmless (its recorded hashes are accurate, and a later lock=frozen run fails
  // closed on anything missing). Pinned so exit-code gating can't be silently reinstated.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(join(tmp, 'src', 'entry.js'), "import { greet } from './hello.js'\nconsole.log(greet('world'))\nawait import('./does-not-exist.js')\n")
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0) // the missing import aborts the run
  t.assert.equal(r.stdout, 'hello, world\n')
  const lockPath = join(tmp, 'stasis.lock.json')
  t.assert.ok(existsSync(lockPath), 'a non-verification abort still persists the clean capture')
  const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.ok(parsed.sources['.'].files['src/hello.js'], 'cleanly-captured files are recorded')
}))

// Ctrl-C on a long-running server: a server installs its own SIGINT handler and exits
// (cleanly or non-zero) on shutdown -- that abort is the program's choice, not a
// lockfile/frozen verification failure, so the captured bundle/lockfile must still be
// persisted. Driven as a real subprocess that we signal once it's up. We drive the run-time
// loader directly (`node --import @exodus/stasis-core/loader` -- exactly what `stasis run`
// spawns) rather than through the CLI, so the signalled process IS the one that writes:
// `close` fires only after its own SIGINT handler exited and the loader's save() ran, with
// no parent/child process-group race.
const captureSigintServer = async (t, exitCode) => {
  const loader = fileURLToPath(import.meta.resolve('@exodus/stasis-core/loader'))
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-sigint-'))
  try {
    cpSync(runFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'snapshot.br')
    // A "server": imports a dep (captured at startup), installs its own SIGINT handler that
    // exits with the given code, signals readiness, then stays alive on a timer.
    writeFileSync(join(tmp, 'src', 'entry.js'),
      "import { greet } from './hello.js'\n" +
      `process.on('SIGINT', () => process.exit(${exitCode}))\n` +
      "void greet('world')\n" +
      "console.error('SERVER_READY')\n" +
      "setInterval(() => {}, 1e6)\n"
    )
    const env = {
      ...cleanEnv,
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      EXODUS_STASIS_SCOPE: 'full',
    }
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, 'src/entry.js'], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      let signalled = false
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server never became ready; stderr: ${err}`)) }, 20000)
      child.stderr.on('data', (d) => {
        err += d
        if (!signalled && err.includes('SERVER_READY')) { signalled = true; child.kill('SIGINT') } // Ctrl-C
      })
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', (c) => { clearTimeout(timer); resolve(c) })
    })
    t.assert.equal(code, exitCode, "the server's own SIGINT handler controls the exit code")
    t.assert.ok(existsSync(bundlePath), 'a SIGINT-ed server must still persist its captured bundle')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.ok(decoded.sources['.'].files['src/hello.js'], 'the dep imported before shutdown is captured')
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'the lockfile is persisted too')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('run: a server SIGINT-ed to exit 0 still persists its captured bundle', (t) => captureSigintServer(t, 0))
test('run: a server SIGINT-ed to exit non-zero still persists its captured bundle', (t) => captureSigintServer(t, 130))

test('run --lock=ignore --bundle=frozen ignores the lockfile and verifies against the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true }) // keeps the committed stasis.lock.json
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(
    ['run', '--lock=ignore', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'ignore'/)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'lock=ignore must not rewrite the lockfile')
}))

test('run --bundle=frozen rejects an observed resolution the bundle never recorded', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // Strip the bundle's recorded resolutions. The resolver still observes entry->hello.js
  // from disk, but it is no longer attested -> fatal in full scope (the unknown-edge branch,
  // distinct from a redirect that mismatches a recorded edge).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports = {}
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /is not attested by the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may run when an edge is unattested')
}))

test('run --lock=frozen fails closed with no stasis files at all (no silent skip)', withTmp((t, tmp) => {
  // Mirror of the bundle=frozen regression: the lock=frozen existence check now lives
  // after the discovery loop, so it fires even with no stasis files on disk. In
  // node_modules scope the workspace entry is outside the attested zone, so a missing
  // lockfile here once let it run unverified.
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  rmSync(join(tmp, 'stasis.config.json'))
  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No lockfile, but attempting to run in frozen mode/)
  t.assert.equal(r.stdout, '', 'nothing may run when the lockfile is absent')
}))

test('run --bundle=add creates intermediate directories for --bundle-file', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'nested', 'deeper', 'out.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(bundlePath))
}))

test('run --bundle=load serves the entry from the bundle when its source is absent on disk', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove every source file -- bundle=load must run entirely from the bundle.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=load serves the entry from the bundle when only the entry is missing', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Keep the imported hello.js on disk, but make the entry missing.
  rmSync(join(tmp, 'src', 'entry.js'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --lock=frozen --bundle=load works in node_modules scope with non-tracked sources', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: nmFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: nmFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /scope: 'node_modules'/)
  t.assert.match(load.stderr, /bundle: 'load'/)
}))

// Regression: in node_modules scope, the resolve hook delegates non-nm parents to Node's
// default resolver, so the load hook receives `context.format` set by Node rather than by
// our own shortCircuit. This exercises that path with a CJS dep, which is the case most
// at risk of a format mismatch (commonjs vs module) between our recorded value and Node's.
test('run --lock=frozen --bundle=load roundtrips a CJS node_modules dep under node_modules scope', withTmp((t, tmp) => {
  cpSync(nmCjsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

// Pins format='json' through bundle=load: a `with { type: 'json' }` import resolves to
// format='json', which the load hook used to reject (only module/commonjs were allowed).
test('run --lock=frozen --bundle=load roundtrips a JSON import with type:json attribute', withTmp((t, tmp) => {
  cpSync(jsonAttrFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'world\n')

  // Remove the json so the bundle is the only source.
  rmSync(join(tmp, 'src/data.json'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'world\n')
}))

test('run --lock=frozen --bundle=load reads non-node_modules sources from disk in node_modules scope', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Modify the on-disk helper. The bundle still has the original. Load must pick up the
  // on-disk version because non-node_modules sources are served from disk in nm scope.
  writeFileSync(join(tmp, 'src/helper.js'), `export const who = 'from disk'\n`)

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, from disk\n')
}))

test('run --lock=frozen --bundle=load fails in node_modules scope when a non-tracked source is missing on disk', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove the non-tracked helper. The bundle has it, but in nm scope we read non-nm files
  // from disk -- so load must fail rather than silently serving the bundled copy.
  rmSync(join(tmp, 'src/helper.js'))

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_MODULE_NOT_FOUND/)
}))

test('run --lock=none --bundle=add writes the bundle without touching the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  rmSync(lockPath)

  const r = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'none'/)
  t.assert.ok(existsSync(bundlePath), 'bundle should be written')
  t.assert.ok(!existsSync(lockPath), 'lockfile must not be created')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
}))

test('run --lock=none --bundle=load runs from a bundle with no lockfile on disk', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  rmSync(join(tmp, 'stasis.lock.json'))

  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove all sources so the bundle is the only thing left.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lock: 'none'/)
}))

test('run --lock=none rejects an existing lockfile (footgun guard)', (t) => {
  // lock=none is the implicit default; the rejection forces the user to make an
  // explicit choice (add/replace/frozen/ignore) when a lockfile is present.
  const r = run(['run', '--lock=none', '--bundle=add', '--bundle-file=/tmp/nope.br', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.lock\.json/)
})

test('run with no flags rejects an existing lockfile (default lock=none footgun guard)', (t) => {
  const r = run(['run', '--bundle=add', '--bundle-file=/tmp/nope.br', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.lock\.json/)
})

test('run --lock=ignore tolerates an existing lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(
    ['run', '--lock=ignore', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'ignore'/)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

test('run --lock=ignore --bundle=load serves from bundle without lockfile interaction', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=none rejects an existing bundle file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  // Seed a bundle in the project root (default bundle path)
  const save = run(['run', '--lock=add', '--bundle=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(bundlePath))

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.code\.br/)
}))

test('run --bundle=ignore tolerates an existing bundle file and does not touch it', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  const save = run(['run', '--lock=add', '--bundle=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundleBefore = readFileSync(bundlePath)

  const r = run(['run', '--lock=frozen', '--bundle=ignore', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=ignore must not touch the bundle')
}))

test('run --lock=frozen --bundle=load rejects a bundle with mismatching scope', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  // create a bundle in full scope
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // forge a mismatching scope in the bundle metadata
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.config.scope = 'node_modules'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|at assert \(file:/)
}))

test('run --lock=add --bundle=add rejects a bundle with mismatching scope (not only frozen)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.config.scope = 'node_modules'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|at assert \(file:/)
}))

test('run --bundle=load rejects a v0 bundle whose path-inferred module name disagrees with the lockfile', withTmp((t, tmp) => {
  // The v0 bundle's name comes from the path (`node_modules/fake-esm-pkg` →
  // `fake-esm-pkg`); cross-check against the lockfile must fail if the
  // lockfile attests a different name for that dir (e.g. an aliased install).
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Tamper the lockfile: same dir, different declared name.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.modules['node_modules/fake-esm-pkg'].name = 'aliased-name'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  // Downgrade the bundle to v0 flat shape so the loader hits the path-inference path.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  const flatSources = {}
  for (const dir of Object.keys(decoded.modules)) {
    for (const [rel, src] of Object.entries(decoded.modules[dir].files)) {
      flatSources[`${dir}/${rel}`] = src
    }
  }
  const v0 = { version: 0, config: decoded.config, formats: decoded.formats, imports: decoded.imports, sources: flatSources }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(v0)))

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_ASSERTION/)
}))

test('run refuses a v0 legacy bundle (parse still accepts it for offline tools)', withTmp((t, tmp) => {
  // stasis run requires a v1 bundle: v0 carries no per-file `formats` (so resources
  // can't be distinguished from code and the loader can't pick module/commonjs) and
  // no import map (so resolutions go unchecked). Offline tooling (extract / diff /
  // audit / sbom) still parses v0 -- it has the metadata those commands need -- but
  // the runtime path refuses it with a message pointing at the upgrade path.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build a fresh v1 bundle, then downgrade it to the v0 legacy shape on disk
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  const flatSources = {}
  for (const dir of Object.keys(decoded.sources)) {
    for (const [rel, src] of Object.entries(decoded.sources[dir].files)) {
      flatSources[dir === '.' ? rel : `${dir}/${rel}`] = src
    }
  }
  const v0 = { version: 0, config: decoded.config, formats: decoded.formats, imports: decoded.imports, sources: flatSources }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(v0)))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0, `expected refusal; stdout=${load.stdout} stderr=${load.stderr}`)
  t.assert.match(load.stderr, /stasis run requires a v1 bundle/)
  // bundle=replace is the documented upgrade path -- starts fresh, writes v1.
  const upgrade = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(upgrade.status, 0, `upgrade stderr: ${upgrade.stderr}`)
  t.assert.equal(JSON.parse(brotliDecompressSync(readFileSync(bundlePath))).version, 1)
}))

test('run --bundle=load rejects a bundle whose entries disagree with the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.entries = ['src/hello.js'] // disagrees with lockfile entry "src/entry.js"
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|entries mismatch/)
}))

test('run --bundle=load rejects a bundle whose module name disagrees with the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].name = 'someone-else'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --bundle=load rejects an entry not listed in the bundle entries', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'stasis.lock.json'))

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/hello.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_ASSERTION|Unknown entry/)
}))

test('run --lock=add records resolutions in the lockfile imports map', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.imports, 'lockfile must record imports')
  const buckets = Object.values(lock.imports)
  t.assert.equal(buckets.length, 1)
  t.assert.deepEqual(buckets[0], { 'src/entry.js': { './hello.js': 'src/hello.js' } })
}))

test('run --lock=add records loader formats in the lockfile formats map', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.formats, { 'src/entry.js': 'javascript:module', 'src/hello.js': 'javascript:module' })
}))

test('run --lock=frozen rejects an on-disk format flip (tampered package.json type)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // entry.js is attested as `javascript:module`. Flipping the workspace package.json's
  // `type` makes Node resolve the same hash-valid .js bytes as commonjs --
  // package.json `type` is not itself hash-attested, so only the format
  // cross-check can catch this. The same bytes would run under a different
  // module system (this `.js` would lose ESM semantics).
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.type = 'commonjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed format for .* mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may execute when a format is rejected')
}))

test('run --lock=frozen --bundle=load rejects a bundle that flips a hash-valid file format', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Flip hello.js's format javascript:module -> javascript:commonjs in the bundle.
  // Bytes still match the lockfile hash; only the loader format the file runs under changes.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.formats['src/hello.js'], 'javascript:module')
  decoded.formats['src/hello.js'] = 'javascript:commonjs'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle format for src\/hello\.js mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered-format file must not execute')
}))

test('run --lock=frozen --bundle=load rejects a bundle that flips a .js file to module-typescript', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // The scariest flip: javascript:module -> typescript:module makes Node strip
  // type-shaped syntax from the SAME bytes (`f<string>('x')` becomes a call,
  // not two comparisons), changing how the file parses -- not just which
  // module system runs it. Must be rejected, like any other format mismatch.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'typescript:module'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle format for src\/hello\.js mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered-format file must not execute')
}))

test('run --lock=frozen --dependencies does not enforce a workspace file format (unattested zone)', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // In node_modules scope the workspace is deliberately unattested (its bytes
  // aren't frozen-checked either), so the format check must be gated out for
  // workspace files. Make the lockfile disagree with disk on the workspace
  // entry's format; disk still loads it correctly, and the run must succeed --
  // a regression that over-enforced the workspace zone would fail here.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(lock.formats['src/entry.js'], 'javascript:module')
  lock.formats['src/entry.js'] = 'javascript:commonjs'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
}))

test('run --lock=frozen warns but proceeds when a legacy lockfile lacks formats', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // A lockfile with imports but no formats (predating format attestation):
  // the formats check is skipped, with a warning, and the run still works.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.formats
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lockfile does not attest formats/)
}))

test('run --lock=frozen --bundle=load rejects a bundle resolution redirected to another attested file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Redirect './hello.js' to the entry itself: every served byte still matches
  // a lockfile hash, only the resolution differs -- the hash checks alone
  // would let this through.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  let redirected = false
  for (const byParent of Object.values(decoded.imports)) {
    if (byParent['src/entry.js']?.['./hello.js']) {
      byParent['src/entry.js']['./hello.js'] = 'src/entry.js'
      redirected = true
    }
  }
  t.assert.ok(redirected, 'bundle must contain the edge to tamper with')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered resolution must not execute')
}))

test('run --lock=frozen --bundle=load rejects a bundle resolution not attested by the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Inject an edge for a (parent, specifier) the lockfile has never seen.
  // Even an edge the run never follows must be attested.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports['attacker-conditions'] = { 'src/entry.js': { './shadow.js': 'src/hello.js' } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /not attested by the lockfile/)
}))

test('run --lock=frozen --bundle=load rejects a redirected resolution under a foreign conditions key', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Same (parent, specifier) the lockfile attests, but redirected AND moved to
  // a conditions key the lockfile doesn't have: the cross-key fallback must
  // still compare the final resolution, so relabeling the bucket is no escape.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports['attacker-conditions'] = { 'src/entry.js': { './hello.js': 'src/entry.js' } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /mismatches the lockfile/)
}))

test('run --lock=frozen --bundle=load accepts a static bundle (wildcard conditions) against a runtime lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'static.br')

  // `stasis bundle` keys edges under '*'; the committed lockfile records the
  // precise runtime condition set. The final resolutions agree, so the pair
  // must validate -- it's the resolved file that's attested, not the key.
  const b = run(['bundle', `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(b.status, 0, `bundle stderr: ${b.stderr}`)

  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --lock=frozen --bundle=load rejects a wildcard resolution over a condition-divergent attestation', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Lockfile attests two different targets for the same (parent, specifier)
  // under different condition sets (dual-package style). A wildcard edge
  // over-claims there: either target would be served under conditions where
  // the other is the attested resolution, so the cross-key fallback must
  // refuse to pick one.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.imports['other, conditions'] = { 'src/entry.js': { './hello.js': 'src/entry.js' } }
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports = { '*': { 'src/entry.js': { './hello.js': 'src/hello.js' } } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /attested inconsistently/)
}))

test('run --lock=frozen --dependencies rejects a node_modules resolution redirected to a workspace file', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // node_modules scope pins dependency bytes, but package.json (which drives
  // resolution) is not hash-attested: point fake-esm-pkg's legacy `main` at a
  // workspace file. The lockfile-attested edge for 'fake-esm-pkg' must win.
  const pkgPath = join(tmp, 'node_modules', 'fake-esm-pkg', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.main = '../../src/helper.js'
  writeFileSync(pkgPath, JSON.stringify(pkg) + '\n')

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* mismatches the lockfile/)
}))

test('run --lock=frozen --dependencies tolerates new workspace imports of pinned dependencies', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // The workspace is unattested in node_modules scope: a refactor may route
  // the same pinned dependency through a new workspace file. New (unattested)
  // edges from workspace parents must be tolerated; the attested
  // './helper.js' edge still has to resolve to the recorded file.
  writeFileSync(join(tmp, 'src', 'extra.js'), "export { greet } from 'fake-esm-pkg'\n")
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import { greet } from './extra.js'\nimport { who } from './helper.js'\n\nconsole.log(greet(who))\n"
  )

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
}))

test('run --lock=frozen (full scope) rejects an observed edge the lockfile does not attest', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // Drop the entry -> hello.js edge from the lockfile's imports but keep every
  // file hash intact. entry.js loads (its bytes still match), then resolving
  // './hello.js' produces an edge the lockfile no longer attests. In full
  // scope unknown edges are fatal (the attested file set is closed), so this
  // must abort -- distinct from a byte-hash failure.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.imports = {}
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* is not attested by the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may execute when an edge is unattested')
}))

test('run --lock=frozen warns but proceeds when a legacy lockfile lacks imports (disk run)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.imports
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lockfile does not attest resolutions/)
}))

test('run --lock=frozen --bundle=load tolerates a legacy lockfile without imports, with a warning', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Strip `imports` to simulate a lockfile that predates resolution attestation.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.imports
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lockfile does not attest resolutions/)
}))

test('Bundle.parse rejects a bundle with an import edge escaping the project root', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  for (const byParent of Object.values(decoded.imports)) {
    if (byParent['src/entry.js']) byParent['src/entry.js']['./hello.js'] = '../outside.js'
  }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
}))

test('Bundle.parse rejects a v1 full-scope bundle with empty entries', withTmp((t, tmp) => {
  // A tampered bundle with entries=[] would otherwise let assertEntry skip (it
  // short-circuits on empty for v0+no-lockfile compat). Reject at parse time.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'stasis.lock.json'))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.entries = []
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /at least one entry|ERR_ASSERTION/)
}))

// ── runtime loader executable-format allowlist ─────────────────────────────────
// stasis run will only ever serve files whose attested format Node's loader can
// actually execute. Resource assets, source-language bundles, and any unknown
// format string a tampered/forward-incompatible bundle might smuggle in are
// refused at load time with a contextual message instead of a bare assertion.

test('run --bundle=load refuses to serve a resource-tagged file as code', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Tamper hello.js's format to a resource tag. Bytes still match the lockfile
  // hash; the loader must refuse to execute it as JavaScript.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'resource'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    // lock=ignore: skip the lockfile-format cross-check so the run reaches the
    // loader gate cleanly (the lockfile cross-check would otherwise win first).
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot import a resource file/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'resource-tagged file must not execute')
}))

test('run --bundle=load refuses to serve a solidity-tagged file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'solidity'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot execute a 'solidity' bundle/)
}))

test('run --bundle=load refuses a bundle that drops a lockfile-attested resource tag (inverse cross-check)', withTmp((t, tmp) => {
  // The forward direction (bundle declares format X, lockfile attests Y) is the
  // classic format-flip and is well covered. The INVERSE -- lockfile attests a
  // file as a resource, bundle just doesn't tag it -- would otherwise route the
  // base64 payload through State.sources (the code path). #mergeBundleMetadata's
  // resource-direction inverse loop catches it as a clean schema-level mismatch.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build a fresh v1 lockfile + bundle pair.
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Lockfile: rewrite hello.js's format to 'resource:base64' (its hash is bytes-
  // over-raw which we don't touch -- the cross-check fires before any hash work).
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.formats['src/hello.js'] = 'resource:base64'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')
  // Bundle: drop hello.js's format entry entirely (the forward loop iterates
  // bundle.formats, so without an entry there's nothing to cross-check via that
  // path; only the inverse loop can catch this).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  delete decoded.formats['src/hello.js']
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle file src\/hello\.js must declare format='resource:base64'/)
}))

test('run --bundle=load refuses every NON_NODE_SOURCE_LANGUAGE tag (php parallel)', withTmp((t, tmp) => {
  // The runtime loader's NON_NODE_SOURCE_LANGUAGES set covers solidity / php / bash
  // / rust as one category, all routed to the same "produced for external analysis"
  // refusal. The solidity case above exercises one tag; this test exercises a sibling
  // (php) to catch a regression that drops a tag from the set.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'php'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot execute a 'php' bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'php-tagged file must not execute')
}))

// --- child processes under stasis (no child_process interception, no flag) ----------
//
// EXODUS_STASIS_PID records the root's pid. A child that runs the loader -- fork() inherits
// it via process.execArgv automatically; a `spawn(node, ['--import', loader, ...])` does so
// explicitly -- also inherits EXODUS_STASIS_PID but runs under a different pid. On that
// mismatch the loader suppresses the child's bundle/lockfile write (ANY child, fork or not),
// and additionally relaxes the entry check for a FORKED child (mismatch + an IPC channel,
// which only fork creates). The fixture's entry.js forks src/worker.js when RUN_WORKER is
// set and spawns it (with --import) when SPAWN_WORKER is set, so the capture step (no child)
// and the enforced step share one entry. worker.js prints the modes it sees.

const seedFork = (t, tmp) => {
  cpSync(forkFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `seed stderr: ${save.stderr}`)
  return bundlePath
}

test('run capture: a forked child does not write the lockfile/bundle (no race)', withTmp((t, tmp) => {
  // Capture once without forking to get the baseline artifacts...
  const bundlePath = seedFork(t, tmp)
  const lockBaseline = readFileSync(join(tmp, 'stasis.lock.json'))
  const bundleBaseline = readFileSync(bundlePath)
  // ...then capture again WITH the fork happening. The child re-runs the loader (lock=add,
  // bundle=add inherited) but must persist nothing -- so the artifacts are byte-identical.
  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER hello, child/, 'the forked child ran')
  t.assert.deepEqual(readFileSync(join(tmp, 'stasis.lock.json')), lockBaseline, 'child must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBaseline, 'child must not rewrite the bundle')
}))

test('run --bundle=load: a forked child is served from the bundle (entry need not be declared)', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  // Remove every source: the bundle is the only place the entry, worker, and hello can come
  // from. worker.js is an attested file but NOT a declared entry -- allowed for a fork target.
  rmSync(join(tmp, 'src'), { recursive: true })
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /^WORKER hello, child lock=frozen bundle=load$/m)
  t.assert.match(r.stdout, /PARENT child-exit=0/)
}))

test('run --bundle=load: the ROOT entry stays strict (a non-declared entry is rejected)', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  // Running worker.js directly as the root entry: it is attested but not a declared entry,
  // and the root (pid match, no fork) must still enforce the entries list.
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/worker.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown entry point/)
}))

test('run --lock=frozen: a forked child fails closed on a tampered import', withTmp((t, tmp) => {
  seedFork(t, tmp)
  // hello.js is imported by the forked worker; tampering it must be caught (the child runs
  // the same enforcement) and the tampered code must not run.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=frozen', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
}))

test('run capture: a non-fork child that inherits the loader is also blocked from writing', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  const lockBaseline = readFileSync(join(tmp, 'stasis.lock.json'))
  const bundleBaseline = readFileSync(bundlePath)
  // entry.js spawns `node --import <loader> worker.js` (a NON-fork child: no IPC channel). It
  // still inherits EXODUS_STASIS_PID, so the pid mismatch must suppress its write too -- the
  // safeguard covers any child, not just fork(). Artifacts stay byte-identical to the baseline.
  const loader = fileURLToPath(import.meta.resolve('@exodus/stasis-core/loader'))
  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, SPAWN_WORKER: '1', STASIS_LOADER: loader } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER hello, child/, 'the spawned child ran')
  t.assert.deepEqual(readFileSync(join(tmp, 'stasis.lock.json')), lockBaseline, 'a non-fork child must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBaseline, 'a non-fork child must not rewrite the bundle')
}))
