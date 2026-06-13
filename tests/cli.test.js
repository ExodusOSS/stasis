import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stasis.js')
const runFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run')
const nmFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm')
const nmCjsFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm-cjs')
const jsonAttrFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-json-attr')

// strip any inherited stasis env vars so the CLI's env-conflict guard doesn't trip
const {
  EXODUS_STASIS_LOCK: _l,
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
  const r = run(['run', '--lock=add'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to run/)
})

test('run with no flags defaults --lock=none and hits the bundle-required constraint', (t) => {
  const r = run(['run', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--lock=none requires --bundle/)
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
  t.assert.match(r.stderr, /--bundle=load requires --lock=\(frozen\|none\|ignore\)/)
})

test('run rejects --bundle=load with --lock=replace', (t) => {
  const r = run(['run', '--lock=replace', '--bundle=load', '--bundle-file=/tmp/x.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle=load requires --lock=\(frozen\|none\|ignore\)/)
})

test('run rejects --lock=none without a bundle', (t) => {
  const r = run(['run', '--lock=none', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--lock=none requires --bundle/)
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
  decoded.formats['src/orphan.js'] = 'module'
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
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
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
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
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

test('run --bundle=load accepts a v0 legacy bundle (flat sources, no entries/modules)', withTmp((t, tmp) => {
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
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
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

test('parseCode rejects a bundle with an import edge escaping the project root', withTmp((t, tmp) => {
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

test('parseCode rejects a v1 full-scope bundle with empty entries', withTmp((t, tmp) => {
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
