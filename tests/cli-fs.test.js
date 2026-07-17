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
  EXODUS_STASIS_RESOURCES_BUNDLE_FILE: _rbf,
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

test('run --fs --resources-bundle-file splits resources into a separate bundle (and load round-trips)', withTmp((t, tmp) => {
  const codePath = join(tmp, 'code.br')
  const resPath = join(tmp, 'resources.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${codePath}`, `--resources-bundle-file=${resPath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED_STDOUT)
  t.assert.ok(existsSync(codePath) && existsSync(resPath), 'both bundle halves written')

  const code = decode(codePath)
  const res = decode(resPath)
  // Code half: the entry + the .json (code-by-extension). Resources half: the txt/bin/dir captures.
  t.assert.deepEqual(Object.keys(code.sources['.'].files).toSorted(), ['src/assets/data.json', 'src/entry.js'])
  t.assert.deepEqual(Object.keys(res.sources['.'].files).toSorted(), ['src/assets', 'src/assets/blob.bin', 'src/assets/message.txt'])
  // Formats are partitioned to their own half.
  t.assert.equal(code.formats['src/assets/data.json'], 'json')
  t.assert.equal(code.formats['src/assets/message.txt'], undefined, 'resource formats absent from the code half')
  t.assert.equal(res.formats['src/assets/message.txt'], 'resource')
  t.assert.equal(res.formats['src/assets/blob.bin'], 'resource:base64')
  t.assert.equal(res.formats['src/assets'], 'directory')
  t.assert.equal((res.entries ?? []).length, 0, 'resources half carries no entries')

  // bundle=load reassembles BOTH halves and serves them with the sources gone from disk.
  rmSync(join(tmp, 'src'), { recursive: true })
  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${codePath}`, `--resources-bundle-file=${resPath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED_STDOUT)
}))

test('run --fs splits resources when bundleFile + resourcesBundleFile come only from stasis.config.json', withTmp((t, tmp) => {
  // Symmetric with the flag-based split above, but both bundle paths are set ONLY in
  // stasis.config.json (no --bundle-file / --resources-bundle-file flags) -- exercising the
  // config.json read path for resourcesBundleFile end-to-end through a load round-trip.
  const codePath = join(tmp, 'code.br')
  const resPath = join(tmp, 'resources.br')
  const configPath = join(tmp, 'stasis.config.json')
  const writeConfig = (lock, bundle) =>
    writeFileSync(configPath, JSON.stringify(
      { scope: 'full', resources: ['bin', 'txt'], lock, bundle, bundleFile: 'code.br', resourcesBundleFile: 'resources.br' }))

  writeConfig('add', 'add')
  const save = run(['run', '--lock=add', '--bundle=add', '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED_STDOUT)
  t.assert.ok(existsSync(codePath) && existsSync(resPath), 'both halves written to the config-specified paths')

  const code = decode(codePath)
  const res = decode(resPath)
  t.assert.deepEqual(Object.keys(code.sources['.'].files).toSorted(), ['src/assets/data.json', 'src/entry.js'])
  t.assert.deepEqual(Object.keys(res.sources['.'].files).toSorted(), ['src/assets', 'src/assets/blob.bin', 'src/assets/message.txt'])
  t.assert.equal(res.formats['src/assets'], 'directory')

  writeConfig('frozen', 'load')
  rmSync(join(tmp, 'src'), { recursive: true })
  const load = run(['run', '--lock=frozen', '--bundle=load', '--fs=sync', 'src/entry.js'], { cwd: tmp })
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
  // The project-root listing is keyed at '.' (the workspace bucket root) -- the same
  // key the lockfile hash absorb derives on load, so the listing serves again.
  t.assert.equal(decode(bundlePath).formats['.'], 'directory')
}))

test('run --fs=async round-trips a readdir of the project root through bundle=load', withTmp((t, tmp) => {
  // Regression (the reported case): the project-root listing was captured under the
  // key '' -- present in the lockfile, but on load the hash absorb re-keys it as
  // join('.', '') === '.', so the 'directory' entry under '' failed its integrity
  // lookup and the load run crashed serving the readdir. Both sides now key at '.'.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { readdir } from 'node:fs/promises'",
    'const names = await readdir(process.cwd())',
    'console.log(`root:${names.includes("package.json")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'root:true\n')
  t.assert.equal(decode(bundlePath).formats['.'], 'directory')
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.equal(lock.formats['.'], 'directory')
  t.assert.match(lock.sources['.'].files[''], /^sha512-/) // hashed at rel '' inside the '.' bucket

  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'root:true\n')
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

// ----- existence / realpath PROBES served from the bundle (bundle=load) ---------------
// Build tools check a file's existence (and canonical path) on a channel that never reads
// its bytes -- @babel/core guards config loading with fs.existsSync(babel.config.js) and
// realpath-canonicalizes the path BEFORE it require()s the file. The byte readers alone
// don't cover that: without serving existsSync/accessSync/realpathSync too, a
// bundled-but-absent file reads as missing on disk and the tool silently skips it (an empty
// babel.config.js "works" only because its existence passes the probe -- its bytes then come
// from the bundle). These two tests pin the probes to the bundle's record.

test('run --fs=async --bundle=load serves existsSync/accessSync/realpathSync for a recorded file absent from disk', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'src', 'cfg.json'), '{ "k": "v" }\n')
  // The entry reads cfg.json (so it is captured) AND probes it -- sync and async forms.
  // `missing:` proves an UNrecorded path still falls through to the real fs (not blanket-true).
  // realpath is reported by basename so a tmpdir symlink prefix (e.g. macOS /var -> /private)
  // can't make capture and load diverge.
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { existsSync, accessSync, realpathSync, readFileSync, constants } from 'node:fs'",
    "import { access as accessP, realpath as realpathP } from 'node:fs/promises'",
    "import { basename, join } from 'node:path'",
    "const p = join(import.meta.dirname, 'cfg.json')",
    "const out = []",
    "out.push(`data:${JSON.parse(readFileSync(p, 'utf8')).k}`)",
    "out.push(`exists:${existsSync(p)}`)",
    "out.push(`missing:${existsSync(join(import.meta.dirname, 'nope.json'))}`)",
    "try { accessSync(p, constants.R_OK); out.push('access:ok') } catch (e) { out.push(`access:${e.code}`) }",
    "out.push(`realpath:${basename(realpathSync(p))}`)",
    "try { await accessP(p); out.push('accessP:ok') } catch (e) { out.push(`accessP:${e.code}`) }",
    "out.push(`realpathP:${basename(await realpathP(p))}`)",
    "console.log(out.join('\\n'))",
    "",
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const EXPECTED = ['data:v', 'exists:true', 'missing:false', 'access:ok', 'realpath:cfg.json', 'accessP:ok', 'realpathP:cfg.json', ''].join('\n')

  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED)

  rmSync(join(tmp, 'src', 'cfg.json')) // gone; the probes must answer from the bundle
  t.assert.ok(!existsSync(join(tmp, 'src', 'cfg.json')), 'precondition: cfg.json is really gone from disk')

  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED, 'existence/access/realpath of the bundled-but-absent file match capture')
}))

test('run --fs=async --bundle=load existence-probes an imported code module absent from disk (the babel.config.js shape)', withTmp((t, tmp) => {
  // sib.js is captured as a CODE module (imported) -- exactly how babel.config.js lands in
  // the bundle. At load it is gone from disk: the import is served by the loader and the
  // existence/realpath probe by the --fs hooks. Without the latter, existsSync returns false
  // and realpathSync throws, i.e. a tool like @babel/core would conclude there is no config.
  writeFileSync(join(tmp, 'src', 'sib.js'), 'export const k = "v"\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { existsSync, realpathSync } from 'node:fs'",
    "import { basename, join } from 'node:path'",
    "import { k } from './sib.js'",
    "const p = join(import.meta.dirname, 'sib.js')",
    "let rp; try { rp = basename(realpathSync(p)) } catch (e) { rp = e.code }",
    "console.log([`k:${k}`, `exists:${existsSync(p)}`, `realpath:${rp}`].join('\\n'))",
    "",
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const EXPECTED = ['k:v', 'exists:true', 'realpath:sib.js', ''].join('\n')

  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, EXPECTED)

  rmSync(join(tmp, 'src', 'sib.js')) // gone; both the import and the probes serve from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED, 'a code module absent from disk is both imported and existence-probed from the bundle')
}))

test('run --fs=async --bundle=load serves accessSync READ-ONLY (F_OK/R_OK ok, W_OK/X_OK deny)', withTmp((t, tmp) => {
  // The bundle is read-only: an existence/read probe of a bundle-only file succeeds, but a
  // write/exec probe must NOT be granted from the bundle -- it defers to the real fs, which
  // reports the absent-on-disk file as ENOENT. Asserted on the LOAD run only (at capture the
  // file is on disk, so W_OK/X_OK there reflect real disk permissions, not the bundle).
  writeFileSync(join(tmp, 'src', 'cfg.json'), '{ "k": "v" }\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { accessSync, readFileSync, constants } from 'node:fs'",
    "import { join } from 'node:path'",
    "const p = join(import.meta.dirname, 'cfg.json')",
    "readFileSync(p) // ensure cfg.json is captured into the bundle",
    "const probe = (m) => { try { accessSync(p, m); return 'ok' } catch (e) { return e.code } }",
    // r/w/x: read serves, write/exec deny. o: an out-of-range mode must defer to the real fs
    // and surface its ERR_OUT_OF_RANGE (the read-class allowlist, not a W_OK|X_OK denylist).
    "console.log([`r:${probe(constants.R_OK)}`, `w:${probe(constants.W_OK)}`, `x:${probe(constants.X_OK)}`, `o:${probe(8)}`].join('\\n'))",
    "",
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`) // capture: file on disk, probes reflect disk

  rmSync(join(tmp, 'src', 'cfg.json')) // bundle-only now
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'r:ok\nw:ENOENT\nx:ENOENT\no:ERR_OUT_OF_RANGE\n',
    'bundle-served file is read-only: read OK, write/exec deny, out-of-range mode defers to real fs')
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

// --- fs settable via stasis.config.json ("fs": "sync" | "async") ------------------
// fs is a Config field like scope/lock/bundle, so the mode can live in stasis.config.json
// instead of the --fs CLI flag. The bundle mode still comes from the CLI here (the bundle
// file is a per-test tmp path); only `fs` moves into the config. The fixture's config sets
// resources=[bin,txt], which the per-kind format assertions below depend on, so preserve it.
const writeFsConfig = (tmp, extra) =>
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full', resources: ['bin', 'txt'], ...extra }))

test('"fs":"sync" in stasis.config.json captures fs reads without the --fs flag', withTmp((t, tmp) => {
  writeFsConfig(tmp, { fs: 'sync' })
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp }) // no --fs
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, EXPECTED_STDOUT)
  // Identical captures to the --fs=sync flag: the directory listing + per-kind formats + bytes.
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/assets'], 'directory')
  t.assert.equal(bundle.formats['src/assets/blob.bin'], 'resource:base64')
  t.assert.equal(bundle.sources['.'].files['src/assets/message.txt'], 'hello from txt\n')
}))

test('"fs":"async" in stasis.config.json routes async install without the --fs flag', withTmp((t, tmp) => {
  // 'async' is a superset of 'sync', so the entry's sync reads are still captured; this pins
  // that the config value is forwarded as the install mode (async: fs === 'async'), not just sync.
  writeFsConfig(tmp, { fs: 'async' })
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, EXPECTED_STDOUT)
  t.assert.equal(decode(bundlePath).formats['src/assets'], 'directory')
}))

test('"fs":"sync" in stasis.config.json serves bundle=load without the --fs flag', withTmp((t, tmp) => {
  writeFsConfig(tmp, { fs: 'sync' })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'src', 'assets'), { recursive: true }) // gone from disk: must be served from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, EXPECTED_STDOUT)
}))

test('"fs" in stasis.config.json requires an active bundle mode', withTmp((t, tmp) => {
  // No --bundle (defaults to none): Config rejects fs, which has nothing to capture into / serve from.
  writeFsConfig(tmp, { fs: 'sync' })
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /fs requires bundle=\(add\|replace\|load\)/)
}))

// ----- stat-ONLY paths are RECORDED (payload-free stat records) ------------------------
// lstatSync/statSync used to be serve-only: a path that was only stat'd -- never read,
// readdir'd, or imported -- was not in the bundle, so on load its stat fell through to
// the real fs and threw ENOENT once the path was gone from disk. Capture now records the
// observed KIND as a payload-free 'stat:file'/'stat:directory' formats entry (no bytes,
// no hash), which the load-side type-getter shim (and the existence probes) answer from.

test('run --fs records a stat-only path and serves its type getters on load', withTmp((t, tmp) => {
  // .dat is deliberately NOT in the resources allowlist: a READ of it would abort the
  // capture (undeclared extension), but a stat is extension-agnostic -- only the kind is
  // recorded, no bytes -- so it must capture cleanly.
  mkdirSync(join(tmp, 'src', 'zone', 'deep'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'zone', 'deep', 'probe.dat'), 'PAYLOAD')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync, statSync, existsSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const zone = join(import.meta.dirname, "zone")',
    'const file = join(zone, "deep", "probe.dat")',
    'console.log(`file:${lstatSync(file).isFile()}:${lstatSync(file).isDirectory()}`)',
    'console.log(`dir:${statSync(zone).isDirectory()}`)',
    'console.log(`exists:${existsSync(file)}`)', // the probe answers from the stat record on load
    // src/zone/deep is IMPLIED by the stat record at src/zone/deep/probe.dat -- never
    // stat'd at capture (env-gated so the recorded entry is identical), so at load this
    // exercises the implied-ancestor path for stat records specifically.
    'if (process.env.STASIS_TEST_IMPLIED) console.log(`implied:${statSync(join(zone, "deep")).isDirectory()}`)',
    'try { lstatSync(join(zone, "missing.dat")) } catch (e) { console.log(`miss:${e.code}`) }',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'file:true:false\ndir:true\nexists:true\nmiss:ENOENT\n')

  // The records are PAYLOAD-FREE: a formats tag only, no bytes in the bundle, no hash in
  // the lockfile's file lists.
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/zone/deep/probe.dat'], 'stat:file')
  t.assert.equal(bundle.formats['src/zone'], 'stat:directory')
  t.assert.equal(bundle.sources['.'].files['src/zone/deep/probe.dat'], undefined, 'no bytes recorded for a stat-only file')
  t.assert.equal(bundle.sources['.'].files['src/zone'], undefined)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.equal(lock.formats['src/zone/deep/probe.dat'], 'stat:file')
  t.assert.equal(lock.formats['src/zone'], 'stat:directory')
  t.assert.equal(lock.sources['.'].files['src/zone/deep/probe.dat'], undefined, 'no hash for a payload-free record')

  rmSync(join(tmp, 'src', 'zone'), { recursive: true }) // gone from disk; only the stat records answer
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_TEST_IMPLIED: '1' } })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'file:true:false\ndir:true\nexists:true\nimplied:true\nmiss:ENOENT\n')
}))

test('run --fs collapses a path that is both stat\'d and read into the content record (either order)', withTmp((t, tmp) => {
  // check-then-read (x) and read-then-check (y): the weak stat record must never conflict
  // with -- or survive next to -- the real content record for the same path.
  writeFileSync(join(tmp, 'src', 'x.txt'), 'X')
  writeFileSync(join(tmp, 'src', 'y.txt'), 'Y')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync, statSync, readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const x = join(import.meta.dirname, "x.txt")',
    'const y = join(import.meta.dirname, "y.txt")',
    'const okX = lstatSync(x).isFile()', // stat FIRST ...
    'const dataX = readFileSync(x, "utf8")', // ... then read
    'const dataY = readFileSync(y, "utf8")', // read FIRST ...
    'const okY = statSync(y).isFile()', // ... then stat
    'console.log(`x:${okX}:${dataX} y:${okY}:${dataY}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'x:true:X y:true:Y\n')
  t.assert.doesNotMatch(save.stderr, /capture aborted/, 'stat + read of one path must not conflict')

  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/x.txt'], 'resource', 'the content record wins over the stat record')
  t.assert.equal(bundle.formats['src/y.txt'], 'resource')
  t.assert.equal(bundle.sources['.'].files['src/x.txt'], 'X')

  rmSync(join(tmp, 'src', 'x.txt'))
  rmSync(join(tmp, 'src', 'y.txt'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'x:true:X y:true:Y\n')
}))

test('run --fs lock=add re-run upgrades a stat-only record to a content record (no format-flip abort)', withTmp((t, tmp) => {
  // Run A only stats x.txt -> lockfile+bundle attest 'stat:file'. Run B (lock=add,
  // bundle=add against the same artifacts; identical entry, env-gated) also READS it:
  // the weak stat baseline must upgrade to 'resource' instead of tripping the
  // format-flip guard or the merged-formats conflict.
  writeFileSync(join(tmp, 'src', 'x.txt'), 'X')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync, readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const x = join(import.meta.dirname, "x.txt")',
    'let out = `stat:${lstatSync(x).isFile()}`',
    'if (process.env.STASIS_TEST_READ) out += `:${readFileSync(x, "utf8")}`',
    'console.log(out)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const runA = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(runA.status, 0, `run A stderr: ${runA.stderr}`)
  t.assert.equal(decode(bundlePath).formats['src/x.txt'], 'stat:file')
  t.assert.equal(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).formats['src/x.txt'], 'stat:file')

  const runB = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_TEST_READ: '1' } })
  t.assert.equal(runB.status, 0, `run B stderr: ${runB.stderr}`)
  t.assert.equal(runB.stdout, 'stat:true:X\n')
  t.assert.doesNotMatch(runB.stderr, /format flip|capture aborted/, 'upgrading a stat-only baseline must not abort')
  const upgraded = decode(bundlePath)
  t.assert.equal(upgraded.formats['src/x.txt'], 'resource', 'the re-run upgraded the stat record to content')
  t.assert.equal(upgraded.sources['.'].files['src/x.txt'], 'X')
  t.assert.equal(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).formats['src/x.txt'], 'resource')

  rmSync(join(tmp, 'src', 'x.txt'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_TEST_READ: '1' } })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:true:X\n')
}))

test('run --fs=async records stat-only paths via callback lstat and fs.promises.stat', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'src', 'd'))
  writeFileSync(join(tmp, 'src', 'd', 'probe.dat'), 'P')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstat } from 'node:fs'",
    "import { stat as statP } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    'const dir = join(import.meta.dirname, "d")',
    'const file = join(dir, "probe.dat")',
    'const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))))',
    'console.log(`cb-lstat-dir:${(await p(lstat, dir)).isDirectory()}`)',
    'console.log(`p-stat-file:${(await statP(file)).isFile()}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/d'], 'stat:directory')
  t.assert.equal(bundle.formats['src/d/probe.dat'], 'stat:file')

  rmSync(join(tmp, 'src', 'd'), { recursive: true })
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=async', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'cb-lstat-dir:true\np-stat-file:true\n')
}))

test('run --fs does NOT attest a stat of a symlink that escapes the root, nor a symlink itself', withTmp((t, tmp) => {
  // Security stance mirrors the byte readers: a statSync THROUGH an in-tree symlink
  // pointing outside the root is answered from disk but never attested. An lstatSync of
  // an in-root symlink reports a symlink -- a kind the shim doesn't model -- and records
  // nothing either (capture stays untainted in both cases).
  const outside = mkdtempSync(join(tmpdir(), 'stasis-fs-stat-OUTSIDE-'))
  try {
    symlinkSync(outside, join(tmp, 'src', 'peek'))
    writeFileSync(join(tmp, 'src', 'real.txt'), 'R')
    symlinkSync(join(tmp, 'src', 'real.txt'), join(tmp, 'src', 'link.txt'))
    writeFileSync(join(tmp, 'src', 'entry.js'), [
      "import { statSync, lstatSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'const d = import.meta.dirname',
      'console.log(`peek:${statSync(join(d, "peek")).isDirectory()}`)', // follows the escaping link
      'console.log(`link:${lstatSync(join(d, "link.txt")).isSymbolicLink()}`)', // a symlink kind
      '',
    ].join('\n'))
    const bundlePath = join(tmp, 'snapshot.br')
    const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, 'peek:true\nlink:true\n') // the program still sees the real fs
    t.assert.doesNotMatch(r.stderr, /capture aborted/)
    const bundle = decode(bundlePath)
    t.assert.equal(bundle.formats['src/peek'], undefined, 'escaping-symlink stat must not be attested')
    t.assert.equal(bundle.formats['src/link.txt'], undefined, 'a symlink kind is not modelled, so not recorded')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('run --fs --child-process forwards a child-only stat record through the shard channel', (t) => {
  // The forked worker (and ONLY the worker -- the root never touches the path) lstats
  // statonly.dat, a file nothing reads. Its payload-free stat record can reach the root's
  // artifacts only via the child's shard: shardSnapshot forwards the formats entry, and
  // mergeShard replays it by re-deriving the kind from disk. Then a load run -- with the
  // probed file gone -- must serve the child's lstat from the bundle.
  const forkShardFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-fork-shard')
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-fs-shard-'))
  try {
    cpSync(forkShardFixture, tmp, { recursive: true })
    // The worker also statSync's THROUGH this in-root symlink: the record lands at the
    // LINK's path with the TARGET's kind (the pnpm node_modules/<pkg> shape), and the
    // root's replay must follow the link too -- with lstat it would see a symlink and
    // silently drop the record (the Copilot-reported regression).
    symlinkSync('statonly.dat', join(tmp, 'src', 'statlink.dat'))
    const bundlePath = join(tmp, 'snapshot.br')
    const env = { ...cleanEnv, STAT_PROBE: '1' }
    const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', '--child-process', 'src/entry.js'], { cwd: tmp, env })
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
    t.assert.match(save.stdout, /WORKER stat-only=true/, 'the forked child stat-probed the file')
    t.assert.match(save.stdout, /WORKER stat-link=true/, 'the forked child stat-probed through the symlink')

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.equal(lock.formats['src/statonly.dat'], 'stat:file', 'child-only stat record attested via the shard merge')
    t.assert.equal(lock.formats['src/statlink.dat'], 'stat:file', 'a stat-through-symlink record survives the shard replay')
    t.assert.equal(lock.sources['.'].files['src/statonly.dat'], undefined, 'payload-free: no hash entry')
    t.assert.equal(decode(bundlePath).formats['src/statonly.dat'], 'stat:file')
    t.assert.equal(decode(bundlePath).formats['src/statlink.dat'], 'stat:file')

    // Both gone (the link now points at nothing before it's removed too); only the
    // bundle's stat records can answer the child's probes.
    rmSync(join(tmp, 'src', 'statonly.dat'))
    rmSync(join(tmp, 'src', 'statlink.dat'))
    const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', '--child-process', 'src/entry.js'], { cwd: tmp, env })
    t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
    t.assert.match(load.stdout, /WORKER stat-only=true/, "the child's lstat of the absent file served from the bundle")
    t.assert.match(load.stdout, /WORKER stat-link=true/, "the child's stat of the absent symlink served from the bundle")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('run --fs: a module stat\'d before it is ever imported upgrades to the real format (no conflict)', withTmp((t, tmp) => {
  // The stat lands first ('stat:file'); the dynamic import's resolve hook then attests
  // the REAL format via addImport -- for a target whose format arrives at RESOLVE time,
  // not through addFile. The real format must replace the weak stat record; a bare
  // noupsert used to abort the whole capture as a Conflict (the crash seen with
  // enhanced-resolve stat'ing stasis-core's own resolve-attested src/util.js).
  writeFileSync(join(tmp, 'src', 'dep.js'), 'export const k = "v"\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync } from 'node:fs'",
    'const dep = new URL("./dep.js", import.meta.url)',
    'console.log(`stat:${lstatSync(dep).isFile()}`)', // stat BEFORE dep.js is resolved/loaded
    'const { k } = await import("./dep.js")', // resolve hook now records format "module"
    'console.log(`k:${k}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'stat:true\nk:v\n')
  t.assert.doesNotMatch(save.stderr, /capture aborted|Conflict/, 'the real format must upgrade the stat record, not conflict')
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/dep.js'], 'module', 'the import upgraded the stat record to the real format')
  t.assert.equal(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).formats['src/dep.js'], 'module')

  rmSync(join(tmp, 'src', 'dep.js')) // gone; both the stat and the import serve from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:true\nk:v\n')
}))

test('run --fs: a stat\'d, never-loaded file still resolves at bundle=load (require.resolve + import.meta.resolve)', withTmp((t, tmp) => {
  // A resolve-only edge: require.resolve records the resolution natively at capture
  // (no format -- the file is never loaded), and the program ALSO lstat's the target,
  // leaving a payload-free 'stat:file' record as its only formats entry. At load the
  // resolution must still serve: the stat record is NOT a loader format, so getImport/
  // getFormat must mask it -- returning 'stat:file' made the resolve hook's
  // executable-format gate refuse the edge (regression: require.resolve crashed with
  // "cannot import ... payload-free stat record"). import.meta.resolve is env-gated to
  // the LOAD run only: at capture it would fire the resolve hook and attest the REAL
  // format, upgrading the stat record away and hiding the very case under test.
  writeFileSync(join(tmp, 'src', 'dep.cjs'), 'module.exports = 1\n')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync } from 'node:fs'",
    "import { createRequire } from 'node:module'",
    'const require = createRequire(import.meta.url)',
    'console.log(`stat:${lstatSync(new URL("./dep.cjs", import.meta.url)).isFile()}`)',
    'console.log(`resolved:${require.resolve("./dep.cjs").endsWith("dep.cjs")}`)',
    'if (process.env.STASIS_TEST_META_RESOLVE) console.log(`meta:${import.meta.resolve("./dep.cjs").endsWith("dep.cjs")}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'stat:true\nresolved:true\n')
  // The stat record and the resolve-only edge coexist: kind attested, no bytes.
  const bundle = decode(bundlePath)
  t.assert.equal(bundle.formats['src/dep.cjs'], 'stat:file')
  t.assert.equal(bundle.sources['.'].files['src/dep.cjs'], undefined, 'resolve-only edge: no bytes recorded')

  rmSync(join(tmp, 'src', 'dep.cjs')) // gone; the stat AND both resolutions must serve from the bundle
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_TEST_META_RESOLVE: '1' } })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'stat:true\nresolved:true\nmeta:true\n')
}))

test('run --fs only captures the single-argument lstatSync/statSync (options pass through)', withTmp((t, tmp) => {
  // Same scope rule as readdirSync: an options form (bigint, throwIfNoEntry) is out of
  // scope -- passed through untouched and NOT recorded.
  writeFileSync(join(tmp, 'src', 'opt.dat'), 'O')
  writeFileSync(join(tmp, 'src', 'entry.js'), [
    "import { lstatSync, statSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const p = join(import.meta.dirname, "opt.dat")',
    'console.log(`big:${typeof lstatSync(p, { bigint: true }).size}`)',
    'console.log(`quiet:${statSync(join(import.meta.dirname, "nope.dat"), { throwIfNoEntry: false })}`)',
    '',
  ].join('\n'))
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, '--fs=sync', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'big:bigint\nquiet:undefined\n')
  t.assert.equal(decode(bundlePath).formats['src/opt.dat'], undefined, 'an options-form stat must not be captured')
}))
