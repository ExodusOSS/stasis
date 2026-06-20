// End-to-end `stasis run --fs`: monkey-patched fs.readFileSync / fs.readdirSync are
// captured into the bundle (bundle=add) and served from it (bundle=load). The
// cli-run-fs fixture's entry reads a text file (resource), a .json (code), a binary
// blob (resource:base64), and lists a directory (directory) -- one of each format.
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis-core', 'bin', 'stasis-core.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-fs')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_FS: _fs,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-fs-cli-'))
  try {
    cpSync(fixture, dir, { recursive: true })
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const decode = (bundlePath) => JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))

const EXPECTED_STDOUT = [
  'message:hello from txt',
  'data:v',
  'blob:12:AAH//hBQTkdibG9i',
  'dir:blob.bin,data.json,message.txt',
  '',
].join('\n')

test('run --fs --bundle=add captures readFileSync/readdirSync with per-kind formats', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, EXPECTED_STDOUT)

  const bundle = decode(bundlePath)
  // "generic by extension" with a resource fallback, plus the directory tag.
  t.assert.equal(bundle.formats['src/assets/message.txt'], 'resource')
  t.assert.equal(bundle.formats['src/assets/data.json'], 'json')
  t.assert.equal(bundle.formats['src/assets/blob.bin'], 'resource:base64')
  t.assert.equal(bundle.formats['src/assets'], 'directory')

  // The directory payload is the SORTED listing, JSON-serialized.
  t.assert.equal(bundle.sources['.'].files['src/assets'], '["blob.bin","data.json","message.txt"]')
  // The binary asset is stored base64; the text asset raw.
  t.assert.equal(bundle.sources['.'].files['src/assets/blob.bin'], 'AAH//hBQTkdibG9i')
  t.assert.equal(bundle.sources['.'].files['src/assets/message.txt'], 'hello from txt\n')
}))

test('run --fs --lock=add attests fs captures by integrity in the lockfile', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  // Same format tags as the bundle, and an sha512 integrity over each captured
  // payload -- including the directory listing's JSON text.
  t.assert.equal(lock.formats['src/assets'], 'directory')
  t.assert.equal(lock.formats['src/assets/blob.bin'], 'resource:base64')
  t.assert.match(lock.sources['.'].files['src/assets'], /^sha512-/)
  t.assert.match(lock.sources['.'].files['src/assets/message.txt'], /^sha512-/)
}))

test('run --fs --bundle=load serves the reads from the bundle with the files gone from disk', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove the assets entirely: the program must still run, served from the bundle.
  rmSync(join(tmp, 'src', 'assets'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED_STDOUT)
}))

test('run --bundle=load WITHOUT --fs does not serve fs reads (falls back to disk)', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'src', 'assets'), { recursive: true })

  // No --fs on load: the patch isn't installed, so the (deleted) asset read hits
  // the real fs and fails -- proving the bundle only serves fs reads under --fs.
  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ENOENT/)
}))

test('run --fs only patches the single-argument readdirSync', withTmp((t, tmp) => {
  // withFileTypes is out of scope: the call passes through and is NOT captured, so
  // the bundle carries no 'directory' entry for it.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readdirSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const ents = readdirSync(join(import.meta.dirname, 'assets'), { withFileTypes: true })",
    'console.log(`count:${ents.length}`)',
    '',
  ].join('\n'))

  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'count:3\n')
  t.assert.equal(decode(bundlePath).formats['src/assets'], undefined, 'withFileTypes readdir must not be captured')
}))

test('run --fs honors readFileSync encoding (string + object form) identically on capture and serve', withTmp((t, tmp) => {
  // The encoding argument is applied by the same decode() on both paths, so a
  // bundle=load run must reproduce capture EXACTLY across encoding forms: an
  // object-form encoding, a non-utf8 string encoding, a raw Buffer (no encoding),
  // and the invalid 'buffer' encoding -- which must throw ERR_UNKNOWN_ENCODING like
  // real fs, not silently return the Buffer.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const assets = join(import.meta.dirname, 'assets')",
    "const txt = join(assets, 'message.txt')",
    "const bin = join(assets, 'blob.bin')",
    "console.log(`obj:${readFileSync(txt, { encoding: 'utf8' }).trim()}`)", // object form
    "console.log(`hex:${readFileSync(bin, 'hex')}`)", // non-utf8 string encoding
    'const buf = readFileSync(bin)', // no encoding -> Buffer
    'console.log(`buf:${Buffer.isBuffer(buf)}:${buf.length}`)',
    "let code = 'none'",
    "try { readFileSync(txt, 'buffer') } catch (e) { code = e.code }", // invalid -> throws
    'console.log(`buffer-throws:${code}`)',
    '',
  ].join('\n'))

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /buffer-throws:ERR_UNKNOWN_ENCODING/) // 'buffer' is not a valid readFileSync encoding

  rmSync(join(tmp, 'src', 'assets'), { recursive: true })

  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  // Served-from-bundle output is identical to capture across every encoding form.
  t.assert.equal(load.stdout, save.stdout)
}))

test('run --fs on a CommonJS program: a required module stays code, explicit reads are captured', withTmp((t, tmp) => {
  // CJS module sources ARE read through the public fs.readFileSync the --fs hook
  // patches; the loader records them as code, and the hook must NOT also capture
  // them as filesystem reads (the isLoadingModule guard). The program's OWN reads
  // (at eval time) are captured. No "type" -> .js is CommonJS.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'stasis-cli-run-fs', version: '0.0.0', private: true }))
  writeFileSync(join(tmp, 'src', 'dep.cjs'), 'module.exports = (n) => `hi ${n}`\n')
  writeFileSync(join(tmp, 'src', 'data.txt'), 'DATA\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "const { readFileSync, readdirSync } = require('node:fs')",
    "const { join } = require('node:path')",
    "const greet = require('./dep.cjs')",
    "const data = readFileSync(join(__dirname, 'data.txt'), 'utf8').trim()",
    'const names = readdirSync(__dirname).sort().join(",")',
    'console.log(`${greet("x")}:${data}:${names}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundle = decode(bundlePath)
  // the required CJS module is recorded as CODE (commonjs), not an fs resource
  t.assert.equal(bundle.formats['src/dep.cjs'], 'commonjs')
  // the explicit reads ARE captured: data.txt as a resource, the dir listing as directory
  t.assert.equal(bundle.formats['src/data.txt'], 'resource')
  t.assert.equal(bundle.sources['.'].files['src/data.txt'], 'DATA\n')
  t.assert.equal(bundle.formats['src'], 'directory')

  rmSync(join(tmp, 'src', 'data.txt')) // explicitly-read asset gone; served from the bundle on load
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, save.stdout)
}))

test('run --fs requires an active bundle mode', (t) => {
  const r = run(['run', '--lock=add', '--fs=sync', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--fs requires --bundle=\(add\|replace\|load\)/)
})

test('run --fs requires the mode argument (sync or async)', (t) => {
  // bare --fs (no value) is rejected -- the mode argument is required
  const bare = run(['run', '--lock=add', '--bundle=add', '--fs', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(bare.status, 1)
  // an unknown mode is rejected with a clear message
  const bogus = run(['run', '--lock=add', '--bundle=add', '--fs=nope', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(bogus.status, 1)
  t.assert.match(bogus.stderr, /--fs must be 'sync' or 'async'/)
})

test('run --fs taints the run (writes nothing) on a read of an undeclared extension', withTmp((t, tmp) => {
  // .dat is neither code nor in the fixture's resources allowlist (["bin","txt"]), so
  // addFsFile throws and the --fs hook aborts the capture: the program still runs, but no
  // bundle/lockfile is written and the user is warned -- no silent attestation widening.
  writeFileSync(join(tmp, 'src', 'thing.dat'), 'PAYLOAD')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    'console.log(`dat:${readFileSync(new URL("./thing.dat", import.meta.url), "utf8")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`) // the program's own read still succeeds
  t.assert.equal(r.stdout, 'dat:PAYLOAD\n')
  t.assert.match(r.stderr, /--fs: capture aborted/)
  t.assert.match(r.stderr, /neither code nor a declared resource/)
  t.assert.ok(!existsSync(bundlePath), 'an undeclared read writes no bundle')
}))

test('run --fs --resources declares an extra extension so its read is captured', withTmp((t, tmp) => {
  // Drop the fixture's config resources so the --resources flag (-> EXODUS_STASIS_RESOURCES)
  // is the sole allowlist; declaring 'dat' lets the otherwise-undeclared read be captured.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'src', 'thing.dat'), 'PAYLOAD')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    'console.log(`dat:${readFileSync(new URL("./thing.dat", import.meta.url), "utf8")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', '--resources=dat', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'dat:PAYLOAD\n')
  t.assert.ok(existsSync(bundlePath), 'declared extension -> bundle written')
  t.assert.equal(decode(bundlePath).formats['src/thing.dat'], 'resource')
}))

test('stasis-core run --fs captures and serves the same way', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const core = (args) => {
    const r = spawnSync(process.execPath, [coreCli, ...args], { cwd: tmp, encoding: 'utf-8', env: cleanEnv })
    r.stdout = stripVTControlCharacters(r.stdout)
    r.stderr = stripVTControlCharacters(r.stderr)
    return r
  }
  const save = core(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'])
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED_STDOUT)
  t.assert.equal(decode(bundlePath).formats['src/assets'], 'directory')

  rmSync(join(tmp, 'src', 'assets'), { recursive: true })
  const load = core(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'])
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED_STDOUT)
}))

test('run --fs captures a readdirSync of a bucket root without discarding the run', withTmp((t, tmp) => {
  // Regression: readdirSync(<project root>) used to throw inside #locateModule and
  // -- swallowed by the capture hook -- silently discard the ENTIRE bundle/lockfile.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readdirSync } from 'node:fs'",
    'console.log(`root:${readdirSync(process.cwd()).includes("package.json")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'root:true\n')
  t.assert.ok(existsSync(bundlePath), 'bundle must be written (not silently discarded)')
  // The project-root listing is keyed at '' (the workspace bucket root).
  t.assert.equal(decode(bundlePath).formats[''], 'directory')
}))

test('run --fs handles a type-less .js that is both imported and readFileSync-read', withTmp((t, tmp) => {
  // Regression: the loader records 'module' (syntax detection) for a type-less .js,
  // while the fs read used to impose the legacy 'commonjs' default -> noupsert
  // conflict -> whole capture silently discarded. Now the fs read records no format.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'stasis-cli-run-fs', version: '0.0.0', private: true }))
  writeFileSync(join(tmp, 'src', 'lib.js'), 'export const greeting = "hi"\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { greeting } from './lib.js'",
    "import { readFileSync } from 'node:fs'",
    'const src = readFileSync(new URL("./lib.js", import.meta.url), "utf8")',
    'console.log(`${greeting}:${src.length}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hi:29\n')
  t.assert.ok(existsSync(bundlePath), 'bundle must be written (no format conflict)')
  // The module loader's format wins; lib.js is served from the bundle on load.
  t.assert.equal(decode(bundlePath).formats['src/lib.js'], 'module')
}))

test('run --fs does NOT attest a directory symlink that escapes the project root', withTmp((t, tmp) => {
  // Security: a symlinked dir pointing outside the root is read (the program works)
  // but its listing must NOT be baked into the closed, signed bundle.
  const outside = mkdtempSync(join(tmpdir(), 'stasis-fs-OUTSIDE-'))
  writeFileSync(join(outside, 'secret.env'), 'TOKEN=1')
  try {
    symlinkSync(outside, join(tmp, 'src', 'peek'))
    writeFileSync(join(tmp, 'src', 'entry.js'), [
      "import { readdirSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'console.log(`peek:${readdirSync(join(import.meta.dirname, "peek")).join(",")}`)',
      '',
    ].join('\n'))
    const bundlePath = join(tmp, 'snapshot.br')
    const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, 'peek:secret.env\n') // the program still reads it from disk
    const bundle = decode(bundlePath)
    t.assert.equal(bundle.formats['src/peek'], undefined, 'escaping symlink listing must not be attested')
    t.assert.equal(bundle.sources['.'].files['src/peek'], undefined)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('run --fs warns (not silently) when a capture is aborted by a mid-run byte conflict', withTmp((t, tmp) => {
  // A file read twice with diverging bytes is a real inconsistency -> the run is
  // tainted and nothing is written, but the user is told why (no silent exit-0).
  writeFileSync(join(tmp, 'src', 'data.txt'), 'A')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const p = join(import.meta.dirname, "data.txt")',
    'readFileSync(p); writeFileSync(p, "B"); readFileSync(p)',
    'console.log("done")',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0) // the program itself ran fine
  t.assert.equal(r.stdout, 'done\n')
  t.assert.match(r.stderr, /--fs: capture aborted/)
  t.assert.ok(!existsSync(bundlePath), 'a tainted capture writes no bundle')
}))

test('run --fs serves lstatSync().isFile()/isDirectory() from the bundle, passes through otherwise', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'src', 'data'))
  writeFileSync(join(tmp, 'src', 'data', 'a.txt'), 'A')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync, readFileSync, readdirSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "data")',
    'readdirSync(dir); readFileSync(join(dir, "a.txt"))', // record dir + file
    'console.log(`file:${lstatSync(join(dir, "a.txt")).isFile()}`)',
    'console.log(`dir:${lstatSync(dir).isDirectory()}`)',
    // A bundle-served Stats must not be an (accidentally rejecting) thenable: when
    // the file is absent from disk, `await` probing `.then` must NOT trigger a real
    // lstatSync ENOENT. This await must resolve to the Stats itself.
    'const awaited = await lstatSync(join(dir, "a.txt"))',
    'console.log(`awaited:${awaited.isFile()}`)',
    'try { lstatSync(join(dir, "missing")) } catch (e) { console.log(`miss:${e.code}`) }',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone from disk; served from bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  // isFile/isDirectory answered from the bundle (incl. through an await, proving the
  // Stats is not a rejecting thenable); the unrecorded path passes through to a real
  // lstatSync, which throws ENOENT (the file isn't on disk or in the bundle).
  t.assert.equal(load.stdout, 'file:true\ndir:true\nawaited:true\nmiss:ENOENT\n')
}))

test('run --fs serves statSync() and benign synthetic Stats fields for removed recorded paths', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'src', 'data'))
  writeFileSync(join(tmp, 'src', 'data', 'a.txt'), 'A')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { statSync, readFileSync, readdirSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "data")',
    'const file = join(dir, "a.txt")',
    'readdirSync(dir); readFileSync(file)', // record dir + file
    'const s = statSync(file)',
    'console.log(`file:${s.isFile()}:${s.isDirectory()}`)',
    'console.log(`dir:${statSync(dir).isDirectory()}`)',
    // Fields a wrapper like graceful-fs reads off the Stats (it touches uid/gid in
    // statFixSync): once the file is gone these must be benign synthetic values, not
    // a re-thrown ENOENT from forwarding to the absent file.
    'console.log(`fields:${s.uid}:${s.gid}:${s.size}:${s.mtime.getTime()}`)',
    // mode carries file-vs-dir type bits, so code that classifies via (mode & S_IFMT)
    // rather than is*() still works on the synthetic Stats.
    'const S_IFMT = 0o170000',
    'console.log(`mode:${(s.mode & S_IFMT) === 0o100000}:${(statSync(dir).mode & S_IFMT) === 0o040000}`)',
    'const awaited = await statSync(file)', // a served Stats must not be a rejecting thenable
    'console.log(`awaited:${awaited.isFile()}`)',
    'try { statSync(join(dir, "missing")) } catch (e) { console.log(`miss:${e.code}`) }',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone from disk; served from bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  // isFile/isDirectory + mode type-bits from the bundle; uid/gid/size/mtime are benign
  // synthetic defaults (0 / epoch) rather than ENOENT; unrecorded path still passes through.
  t.assert.equal(load.stdout, 'file:true:false\ndir:true\nfields:0:0:0:0\nmode:true:true\nawaited:true\nmiss:ENOENT\n')
}))

test('run --fs: real graceful-fs statSync/lstatSync survive bundle=load', withTmp((t, tmp) => {
  // graceful-fs wraps statSync/lstatSync and reads stats.uid/gid off the result
  // (polyfills.js statFixSync); under bundle=load the file is gone, so the shim must
  // serve benign synthetic fields rather than forwarding ENOENT. Locate the installed
  // graceful-fs (pnpm nests it under .pnpm/graceful-fs@<ver>) and copy it INTO the
  // project so its real path stays in-root (an external symlink would be refused).
  const pnpmDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.pnpm')
  const hit = existsSync(pnpmDir) && readdirSync(pnpmDir).find((d) => d.startsWith('graceful-fs@'))
  const gfsSrc = hit && join(pnpmDir, hit, 'node_modules', 'graceful-fs')
  if (!gfsSrc || !existsSync(join(gfsSrc, 'package.json'))) return t.skip('graceful-fs not installed')

  mkdirSync(join(tmp, 'node_modules', 'graceful-fs'), { recursive: true })
  cpSync(gfsSrc, join(tmp, 'node_modules', 'graceful-fs'), { recursive: true })
  mkdirSync(join(tmp, 'src', 'data'))
  writeFileSync(join(tmp, 'src', 'data', 'a.txt'), 'A')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import gfs from 'graceful-fs'",
    "import { readFileSync, readdirSync } from 'node:fs'", // record via node fs (single-arg)
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "data")',
    'const file = join(dir, "a.txt")',
    'readdirSync(dir); readFileSync(file)',
    'console.log(`stat:${gfs.statSync(file).isFile()}`)',
    'console.log(`lstat:${gfs.lstatSync(file).isFile()}`)',
    'console.log(`statdir:${gfs.statSync(dir).isDirectory()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone; graceful-fs must still stat it
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:true\nlstat:true\nstatdir:true\n')
}))

test('run --fs: statSync/lstatSync report implied ancestor directories of bundled files', withTmp((t, tmp) => {
  // A recorded node_modules/dep/index.js proves node_modules and node_modules/dep
  // exist as directories, even though neither was readdir'd. statSync/lstatSync must
  // report them as directories at bundle=load -- regression: they used to ENOENT once
  // node_modules was removed, breaking the very common "does node_modules exist?" probe.
  mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), "module.exports = 'DEP'\n")
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import dep from 'dep'", // records node_modules/dep/index.js into the bundle
    "import { statSync, lstatSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const nm = join(process.cwd(), "node_modules")',
    'console.log(`dep:${dep}`)',
    'console.log(`stat-nm:${statSync(nm).isDirectory()}`)',
    'console.log(`stat-dep:${statSync(join(nm, "dep")).isDirectory()}`)',
    'console.log(`lstat-nm:${lstatSync(nm).isDirectory()}`)',
    // a path NOT implied by any recorded file still passes through (ENOENT once gone)
    'try { statSync(join(process.cwd(), "nope")) } catch (e) { console.log(`miss:${e.code}`) }',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'node_modules'), { recursive: true }) // gone; the dirs are known only via the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'dep:DEP\nstat-nm:true\nstat-dep:true\nlstat-nm:true\nmiss:ENOENT\n')
}))

test('run --fs=async captures and serves async (callback + fs/promises) reads', withTmp((t, tmp) => {
  // The async readers share the sync logic; bundle=load must serve callback readFile,
  // fs/promises readFile/readdir/stat the same way -- with the files gone from disk.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFile as readFileCb } from 'node:fs'",
    "import { readFile as readFileP, readdir as readdirP, stat as statP } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    'const assets = join(import.meta.dirname, "assets")',
    'const msg = join(assets, "message.txt")',
    'const cb = await new Promise((res, rej) => readFileCb(msg, "utf8", (e, d) => (e ? rej(e) : res(d))))',
    'console.log(`cb:${cb.trim()}`)',
    'console.log(`p:${(await readFileP(msg, "utf8")).trim()}`)',
    'console.log(`dir:${(await readdirP(assets)).sort().join(",")}`)',
    'console.log(`stat:${(await statP(msg)).isFile()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'assets'), { recursive: true }) // gone; served from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'cb:hello from txt\np:hello from txt\ndir:blob.bin,data.json,message.txt\nstat:true\n')
}))

test('run --fs=sync does not patch the async readers (only --fs=async does)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    'console.log((await readFile(join(import.meta.dirname, "assets", "message.txt"), "utf8")).trim())',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  // Captured under --fs=sync: the async read is NOT recorded into the bundle.
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'assets'), { recursive: true })
  // Under --fs=sync the async read hits the real (now-missing) file -- proving the
  // async readers are served only under --fs=async.
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ENOENT/)
}))

test('run --fs=async serves callback stat/lstat and routes a bad encoding to the callback', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'src', 'data'))
  writeFileSync(join(tmp, 'src', 'data', 'a.txt'), 'A')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { stat, lstat, readFile, readFileSync, readdirSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "data")',
    'const file = join(dir, "a.txt")',
    'readdirSync(dir); readFileSync(file)', // record dir + file
    'const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))))',
    'console.log(`cb-stat:${(await p(stat, file)).isFile()}`)',
    'console.log(`cb-lstat-dir:${(await p(lstat, dir)).isDirectory()}`)',
    // an invalid encoding must reach the callback as an error, NOT crash the process
    'let code = "none"',
    'try { await p(readFile, file, "buffer") } catch (e) { code = e.code }',
    'console.log(`bad-enc:${code}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /bad-enc:ERR_UNKNOWN_ENCODING/) // delivered to cb; process survived

  rmSync(join(tmp, 'src', 'data'), { recursive: true })
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'cb-stat:true\ncb-lstat-dir:true\nbad-enc:ERR_UNKNOWN_ENCODING\n')
}))

test('run --fs=async serves readdir(path, null, cb) -- the graceful-fs null-options form', withTmp((t, tmp) => {
  // graceful-fs normalises readdir(path, cb) to readdir(path, null, cb); the patch must
  // treat that explicit-null options as the single-arg form and serve it, not pass it
  // through. (Regression: the null form fell through, so async readdir returned the
  // on-disk listing -- the failure enhanced-resolve's async file system hit.)
  mkdirSync(join(tmp, 'src', 'd'))
  writeFileSync(join(tmp, 'src', 'd', 'x.txt'), 'x')
  writeFileSync(join(tmp, 'src', 'd', 'y.txt'), 'y')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readdir } from 'node:fs'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "d")',
    'const names = await new Promise((res, rej) => readdir(dir, null, (e, v) => (e ? rej(e) : res(v))))',
    'console.log(names.slice().sort().join(","))',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'src', 'd'), { recursive: true })
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'x.txt,y.txt\n')
}))

test('run --fs=async: real graceful-fs async readFile/stat/readdir survive bundle=load', withTmp((t, tmp) => {
  // The user's exact case: enhanced-resolve uses graceful-fs's async readers; readdir
  // goes through the null-options form. Locate the installed graceful-fs and copy it in.
  const pnpmDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.pnpm')
  const hit = existsSync(pnpmDir) && readdirSync(pnpmDir).find((d) => d.startsWith('graceful-fs@'))
  const gfsSrc = hit && join(pnpmDir, hit, 'node_modules', 'graceful-fs')
  if (!gfsSrc || !existsSync(join(gfsSrc, 'package.json'))) return t.skip('graceful-fs not installed')

  mkdirSync(join(tmp, 'node_modules', 'graceful-fs'), { recursive: true })
  cpSync(gfsSrc, join(tmp, 'node_modules', 'graceful-fs'), { recursive: true })
  mkdirSync(join(tmp, 'src', 'data'))
  writeFileSync(join(tmp, 'src', 'data', 'a.json'), '{"k":1}')
  writeFileSync(join(tmp, 'src', 'data', 'b.txt'), 'b')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import gfs from 'graceful-fs'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "data")',
    'const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))))',
    'console.log(`readFile:${JSON.parse(await p(gfs.readFile, join(dir, "a.json"))).k}`)',
    'console.log(`stat:${(await p(gfs.stat, join(dir, "a.json"))).isFile()}`)',
    'console.log(`readdir:${(await p(gfs.readdir, dir)).slice().sort().join(",")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone; graceful-fs's async reads must serve from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'readFile:1\nstat:true\nreaddir:a.json,b.txt\n')
}))

// ----- source-map sidecars (`*.map`) are skipped under --fs --------------------------
// A program (e.g. @babel/core's normalizeFile) reads a transformed file's sibling
// `.js.map` to chain an INPUT source map regardless of any "sourcemaps off" setting.
// Those maps don't affect emitted output, so --fs treats every in-root `*.map` as
// non-existent (ENOENT) in BOTH capture and load -- never recorded, never aborting a
// capture -- unless `map` is added to the resources allowlist.

test('run --fs treats a *.map read as NON-EXISTENT in capture (skipped, never recorded, capture not aborted)', withTmp((t, tmp) => {
  // The sibling map EXISTS on disk; stasis still hands the reader ENOENT (proving the
  // capture returns "non-existent" rather than reading + recording it), the capture is
  // not tainted, and nothing about the map lands in the bundle.
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3,"sources":["mod.ts"]}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const p = join(import.meta.dirname, "mod.js.map")',
    'let out',
    'try { out = `bytes:${readFileSync(p, "utf8").trim()}` } catch (e) { out = `code:${e.code}` }',
    'console.log(out)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'code:ENOENT\n', 'a *.map read returns ENOENT even though the file is on disk')
  t.assert.doesNotMatch(r.stderr, /capture aborted/, 'a *.map read must not taint the capture')
  t.assert.ok(existsSync(bundlePath), 'bundle written')
  t.assert.ok(existsSync(join(tmp, 'src', 'mod.js.map')), 'precondition: the map is on disk (so the ENOENT is synthetic)')
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/mod.js.map'], undefined, 'the source map is not recorded')
  t.assert.equal(bundle.sources['.'].files['src/mod.js.map'], undefined)
}))

test('run --fs --bundle=load serves a *.map as non-existent (hermetic: ENOENT even when present on disk)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'let out',
    'try { out = `bytes:${readFileSync(join(import.meta.dirname, "mod.js.map"), "utf8").trim()}` } catch (e) { out = `code:${e.code}` }',
    'console.log(out)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'code:ENOENT\n')

  // The map is left on disk; load must STILL report it absent (a hermetic skip, no disk
  // fallback) so replay matches capture byte-for-byte.
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'code:ENOENT\n', 'load returns ENOENT for the skipped map despite it being on disk')
}))

test('run --fs=async treats a *.map read as non-existent too', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    'let out',
    'try { out = `bytes:${(await readFile(join(import.meta.dirname, "mod.js.map"), "utf8")).trim()}` } catch (e) { out = `code:${e.code}` }',
    'console.log(out)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'code:ENOENT\n')
  t.assert.equal(decode(bundlePath).formats['src/mod.js.map'], undefined)
}))

test('run --fs --resources=map opts source maps back in (captured + served as a resource)', withTmp((t, tmp) => {
  // Adding `map` to the allowlist disables the skip: the *.map is read for real and
  // captured as a resource, exactly like any other declared asset, then served on load.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'console.log(`map:${readFileSync(join(import.meta.dirname, "mod.js.map"), "utf8").trim()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', '--resources=map', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'map:{"version":3}\n', 'with map allowlisted the bytes are read, not ENOENT')
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/mod.js.map'], 'resource', 'allowlisted map captured as a resource')
  t.assert.equal(bundle.sources['.'].files['src/mod.js.map'], '{"version":3}\n')

  rmSync(join(tmp, 'src', 'mod.js.map')) // gone from disk; must be served from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', '--resources=map', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'map:{"version":3}\n')
}))

test('run --fs reports a *.map as ENOENT via statSync/lstatSync (capture and load)', withTmp((t, tmp) => {
  // The stat path must agree with the read path: a skipped *.map is absent to
  // statSync/lstatSync too, in both modes (the map is on disk, so the ENOENT is synthetic).
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { statSync, lstatSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const p = join(import.meta.dirname, "mod.js.map")',
    'const probe = (fn) => { try { fn(p); return "ok" } catch (e) { return e.code } }',
    'console.log(`stat:${probe(statSync)} lstat:${probe(lstatSync)}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'stat:ENOENT lstat:ENOENT\n', 'stat/lstat of a *.map are ENOENT even though it is on disk')

  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:ENOENT lstat:ENOENT\n')
}))

test('run --fs captures a sibling read while skipping the *.map in the same run (skip is surgical)', withTmp((t, tmp) => {
  // The fixture allowlists `txt`; the .txt read is captured as a resource while the
  // sibling .js.map is skipped -- proving the skip doesn't taint or suppress the rest of
  // the capture (a non-map read in the same run still lands in the bundle).
  writeFileSync(join(tmp, 'src', 'note.txt'), 'NOTE\n')
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const d = import.meta.dirname',
    'const txt = readFileSync(join(d, "note.txt"), "utf8").trim()',
    'let map',
    'try { map = readFileSync(join(d, "mod.js.map"), "utf8") } catch (e) { map = e.code }',
    'console.log(`txt:${txt} map:${map}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'txt:NOTE map:ENOENT\n')
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/note.txt'], 'resource', 'the real read is still captured')
  t.assert.equal(bundle.sources['.'].files['src/note.txt'], 'NOTE\n')
  t.assert.equal(bundle.formats['src/mod.js.map'], undefined, 'the map is skipped')
}))

test('run --fs --bundle=load serves a *.map recorded under --resources=map even when load omits the flag', withTmp((t, tmp) => {
  // A map deliberately captured (`map` in resources) is recorded as a resource and must
  // serve on load by bundle membership -- like every other resource -- WITHOUT the load
  // run repeating --resources=map. Regression guard: the skip must not shadow a recorded map.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'console.log(`map:${readFileSync(join(import.meta.dirname, "mod.js.map"), "utf8").trim()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', '--resources=map', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(decode(bundlePath).formats['src/mod.js.map'], 'resource')

  rmSync(join(tmp, 'src', 'mod.js.map')) // gone from disk; only the bundle can serve it
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp }) // NOTE: no --resources=map
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'map:{"version":3}\n', 'a recorded map serves on load by membership, without repeating --resources=map')
}))

test('run --fs=async --resources=map captures + serves a *.map (async opt-in, membership wins on load)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'src', 'mod.js.map'), '{"version":3}\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    'console.log(`map:${(await readFile(join(import.meta.dirname, "mod.js.map"), "utf8")).trim()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', '--resources=map', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'map:{"version":3}\n')
  t.assert.equal(decode(bundlePath).formats['src/mod.js.map'], 'resource')

  rmSync(join(tmp, 'src', 'mod.js.map'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp }) // no --resources=map
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'map:{"version":3}\n')
}))
