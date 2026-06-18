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
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
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
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
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
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove the assets entirely: the program must still run, served from the bundle.
  rmSync(join(tmp, 'src', 'assets'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED_STDOUT)
}))

test('run --bundle=load WITHOUT --fs does not serve fs reads (falls back to disk)', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
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
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'],
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
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /buffer-throws:ERR_UNKNOWN_ENCODING/) // 'buffer' is not a valid readFileSync encoding

  rmSync(join(tmp, 'src', 'assets'), { recursive: true })

  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundle = decode(bundlePath)
  // the required CJS module is recorded as CODE (commonjs), not an fs resource
  t.assert.equal(bundle.formats['src/dep.cjs'], 'commonjs')
  // the explicit reads ARE captured: data.txt as a resource, the dir listing as directory
  t.assert.equal(bundle.formats['src/data.txt'], 'resource')
  t.assert.equal(bundle.sources['.'].files['src/data.txt'], 'DATA\n')
  t.assert.equal(bundle.formats['src'], 'directory')

  rmSync(join(tmp, 'src', 'data.txt')) // explicitly-read asset gone; served from the bundle on load
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, save.stdout)
}))

test('run --fs requires an active bundle mode', (t) => {
  const r = run(['run', '--lock=add', '--fs', 'src/entry.js'], { cwd: fixture })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--fs requires --bundle=\(add\|replace\|load\)/)
})

test('stasis-core run --fs captures and serves the same way', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const core = (args) => {
    const r = spawnSync(process.execPath, [coreCli, ...args], { cwd: tmp, encoding: 'utf-8', env: cleanEnv })
    r.stdout = stripVTControlCharacters(r.stdout)
    r.stderr = stripVTControlCharacters(r.stderr)
    return r
  }
  const save = core(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'])
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED_STDOUT)
  t.assert.equal(decode(bundlePath).formats['src/assets'], 'directory')

  rmSync(join(tmp, 'src', 'assets'), { recursive: true })
  const load = core(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'])
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
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
    const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone from disk; served from bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone from disk; served from bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
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
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'data'), { recursive: true }) // gone; graceful-fs must still stat it
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:true\nlstat:true\nstatdir:true\n')
}))
