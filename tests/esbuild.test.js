import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const assetsFixture = join(here, 'fixtures', 'esbuild-assets')

// Route png/svg through esbuild's native `file` loader (copies the asset, returns a URL).
const FILE_LOADER = JSON.stringify({ '.png': 'file', '.svg': 'file' })

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

test('lock=add records the entry and its imports', withTmp((t, tmp) => {
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

test('lock=add is idempotent against the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const after = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
  t.assert.equal(after, before)
}))

test('lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
}))

test('lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=add rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=frozen rejects a brand-new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

  const r = run(['src/fresh.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=add rejects a changed package.json version', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = '99.99.99'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('lock=replace rewrites the lockfile after a source change', withTmp((t, tmp) => {
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

test('lock=replace drops stale entries from the previous lockfile', withTmp((t, tmp) => {
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

test('lock=ignore tolerates the committed lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

test('bundle=add writes a bundle whose sources match disk', withTmp((t, tmp) => {
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
  t.assert.equal(decoded.formats['src/entry.js'], 'javascript:module')
}))

test('bundle=load rejects a tampered source in the bundle', withTmp((t, tmp) => {
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

test('bundle=load fails closed when an in-scope file is missing from the bundle (does NOT silently fall through to disk)', withTmp((t, tmp) => {
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-capture'),
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

  // Tamper: drop src/hello.js from sources. The import-map edge entry.js ->
  // ./hello.js is still attested, so onResolve picks the same URL -- but
  // onLoad's state.getFile call must error (no disk fallback) when the source
  // bytes aren't there. The sources stay on disk so silent disk fallback would
  // succeed; the fix is that it must not.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
  delete decoded.sources['.'].files['src/hello.js']
  writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

  const loadDir = join(tmp, 'load')
  cpSync(capDir, loadDir, { recursive: true })
  copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
  rmSync(join(loadDir, 'stasis.lock.json'))

  const r = run(['src/entry.js'], {
    cwd: loadDir,
    env: {
      EXODUS_STASIS_LOCK: 'none',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-load'),
    },
  })
  t.assert.notEqual(r.status, 0, 'load must fail when an in-scope file is missing from the bundle')
  t.assert.match(r.stderr, /hello\.js/)
}))

// Fail-closed on the genuinely-new branch: the externals defer must NOT become a disk
// fallback for an in-scope FILE. The test above drops only the SOURCE (keeping the edge),
// so getImport still succeeds and never reaches the new catch. Here we drop BOTH the edge
// AND the bytes for an in-scope relative import: getImport's resolveBundled fallback can't
// recover it (bytes gone) -> it throws ERR_MODULE_NOT_FOUND -> the new catch returns
// undefined -> esbuild re-resolves ./hello.js -> onLoad's getFile throws (not in bundle).
// The build MUST fail even though hello.js is present on disk in the load dir.
test('bundle=load still fails closed when an in-scope edge AND its bytes are dropped (defer is not a disk fallback)', withTmp((t, tmp) => {
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-capture'),
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

  // Drop both the import edge from src/entry.js and the bytes of src/hello.js -- the only
  // way to reach the defer branch for an in-scope file (with either intact, getImport
  // resolves it from the bundle instead of throwing).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
  for (const k of Object.keys(decoded.imports)) delete decoded.imports[k]['src/entry.js']
  delete decoded.sources['.'].files['src/hello.js']
  writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

  const loadDir = join(tmp, 'load')
  cpSync(capDir, loadDir, { recursive: true })  // full source tree stays on disk
  copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
  rmSync(join(loadDir, 'stasis.lock.json'))

  const r = run(['src/entry.js'], {
    cwd: loadDir,
    env: {
      EXODUS_STASIS_LOCK: 'none',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-load'),
    },
  })
  t.assert.notEqual(r.status, 0, 'defer must not silently read the in-scope file from disk')
  t.assert.match(r.stderr, /hello\.js/)
}))

test('bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp((t, tmp) => {
  // Phase 1 in a capture-side dir (full fixture: sources, lockfile, config).
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')
  const outA = join(tmp, 'out-capture')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: outA,
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
  const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

  // Phase 2 in a clean load-side dir holding nothing but the bundle file and the
  // bare-minimum package.json State needs to anchor its root discovery. NO sources,
  // no lockfile, no stasis.config.json, no pnpm-workspace.yaml -- just the bundle.
  // This is the deployment shape we want to support: ship the bundle, drop it on
  // a host, run the bundler again, get the same output.
  const loadDir = join(tmp, 'load')
  mkdirSync(loadDir)
  copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
  writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')
  // Sanity: confirm the load-side dir really doesn't have the source tree.
  t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')
  t.assert.ok(!existsSync(join(loadDir, 'src/entry.js')), 'load dir must not contain entry')
  t.assert.ok(!existsSync(join(loadDir, 'stasis.lock.json')), 'load dir must not contain a lockfile')

  const outB = join(tmp, 'out-load')
  // lock=none: in this clean-dir scenario the bundle is self-authoritative -- no
  // lockfile is required to verify content. getFile's hash check is gated on
  // useLockfile, which is false under lock=none, so the bundle's own bytes
  // round-trip without a sibling attestation.
  const replay = run(['src/entry.js'], {
    cwd: loadDir,
    env: {
      EXODUS_STASIS_LOCK: 'none',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      STASIS_TEST_ESBUILD_OUTDIR: outB,
    },
  })
  t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
  const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

  // Round-trip faithfulness: the bundler's emitted JS bytes must match. Load mode
  // returns the same absolute paths under namespace='file' as capture mode, so
  // esbuild's path-banner comments are written relative to cwd in both runs (which
  // resolve to the same `src/entry.js` / `src/hello.js`).
  t.assert.equal(replayOutput, captureOutput)
}))

// Regression: a Node.js built-in (`node:constants`, `path`, ...) imported by an
// in-scope file must NOT be looked up in the bundle's import map under bundle=load.
// Built-ins are never carried in the bundle and never recorded as import edges -- the
// capture side defers isBuiltin() specifiers before addImport sees them. So the
// load-mode onResolve hook has to return undefined for them and let esbuild externalize
// them (platform:'node'), exactly as in a build without this plugin. Pre-fix,
// state.getImport found no edge and threw ERR_MODULE_NOT_FOUND, which esbuild surfaced
// as `[plugin: stasis] Cannot find module 'node:constants' imported from <file>`
// (the same class of failure the webpack plugin hit with graceful-fs's require('constants')).
test('bundle=load defers Node built-ins to esbuild instead of looking them up in the bundle', withTmp((t, tmp) => {
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
  // A node:-prefixed builtin and a bare builtin alongside the normal relative import:
  // the relative edge IS attested and served from the bundle; the builtins must defer
  // to esbuild's own externalization.
  writeFileSync(join(capDir, 'src', 'entry.js'),
    "import { O_RDONLY } from 'node:constants'\n" +
    "import { sep } from 'path'\n" +
    "import { greet } from './hello.js'\n" +
    "console.log(greet('world'), O_RDONLY, sep)\n")
  const capBundle = join(capDir, 'snapshot.br')
  const outA = join(tmp, 'out-capture')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: outA,
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
  const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

  // Clean load dir: only the bundle + a minimal package.json. No sources on disk, so a
  // working load mode is the only path to a build -- and the builtins, which the bundle
  // never carried, must resolve through esbuild's own externalization.
  const loadDir = join(tmp, 'load')
  mkdirSync(loadDir)
  copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
  writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

  const outB = join(tmp, 'out-load')
  const replay = run(['src/entry.js'], {
    cwd: loadDir,
    env: {
      EXODUS_STASIS_LOCK: 'none',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      STASIS_TEST_ESBUILD_OUTDIR: outB,
    },
  })
  t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
  const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

  // Round-trip faithfulness AND builtin externalization: the load output equals the
  // capture output, and esbuild externalized the builtins rather than failing to resolve.
  t.assert.equal(replayOutput, captureOutput)
  t.assert.match(replayOutput, /from "node:constants"/)
  t.assert.match(replayOutput, /from "path"/)
}))

// Regression (generalizes the built-in case to ALL externals): a non-builtin module the
// user marks `external` (esbuild has no electron preset, so externals are declared in
// config) is never bundled and never recorded as an import edge. At bundle=load,
// state.getImport throws ERR_MODULE_NOT_FOUND; the load-mode onResolve hook must treat
// that miss as "external" and return undefined so esbuild externalizes it, instead of
// failing the build with `Cannot find module 'electron'`. The byte-level fail-closed
// gate (onLoad -> getFile) is unaffected -- see the missing-file test above.
test('bundle=load defers user externals (electron) to esbuild instead of looking them up in the bundle', withTmp((t, tmp) => {
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
  writeFileSync(join(capDir, 'src', 'entry.js'),
    "import { app } from 'electron'\n" +
    "import { greet } from './hello.js'\n" +
    "console.log(greet(typeof app))\n")
  const capBundle = join(capDir, 'snapshot.br')
  const outA = join(tmp, 'out-capture')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_EXTERNAL: '["electron"]',
      STASIS_TEST_ESBUILD_OUTDIR: outA,
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
  const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

  const loadDir = join(tmp, 'load')
  mkdirSync(loadDir)
  copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
  writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

  const outB = join(tmp, 'out-load')
  const replay = run(['src/entry.js'], {
    cwd: loadDir,
    env: {
      EXODUS_STASIS_LOCK: 'none',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      STASIS_TEST_ESBUILD_EXTERNAL: '["electron"]',
      STASIS_TEST_ESBUILD_OUTDIR: outB,
    },
  })
  t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
  const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

  t.assert.equal(replayOutput, captureOutput)
  t.assert.match(replayOutput, /from "electron"/)
}))

test('bundle=load: import attributes (with { type: "json" }) round-trip', withTmp((t, tmp) => {
  // The Node run loader stores edges under a conditions-with-attributes key when
  // an import carries `with { type: 'json' }` (state.#conditionsKey). The esbuild
  // plugin must forward those attributes both at capture (addImport) and at load
  // (getImport) for the round-trip to find the same key. Without the forwarding,
  // load-mode getImport would use the '*' wildcard and miss the attributed entry.
  const capDir = join(tmp, 'cap')
  cpSync(jsonFixture, capDir, { recursive: true })
  // Rewrite the entry to use the `with { type: 'json' }` syntax. The fixture's
  // src/entry.js currently imports the JSON without attributes; switching the
  // syntax produces a bundle whose imports map is keyed with the attribute.
  writeFileSync(
    join(capDir, 'src/entry.js'),
    `import data from './data.json' with { type: 'json' }\nconsole.log(\`hello, \${data.who}\`)\n`,
  )
  rmSync(join(capDir, 'stasis.lock.json'))
  const capBundle = join(capDir, 'snapshot.br')
  const outA = join(tmp, 'out-cap')

  const capture = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: outA,
    },
  })
  t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
  // Sanity: the captured bundle's imports map keys the edge under the
  // attribute-bearing conditions string. If this assertion fails, the capture
  // side dropped the attribute and the load-side fix below would be untestable.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
  const importsKeys = Object.keys(decoded.imports)
  t.assert.ok(
    importsKeys.some((k) => k.includes('"type":"json"')),
    `expected at least one imports key to carry the type=json attribute; got ${JSON.stringify(importsKeys)}`,
  )

  // Load mode: tear down sources, re-run with bundle=load. The plugin's
  // load-mode getImport must pass the same attributes to find the keyed edge.
  rmSync(join(capDir, 'src'), { recursive: true })
  const outB = join(tmp, 'out-load')
  const replay = run(['src/entry.js'], {
    cwd: capDir,
    env: {
      EXODUS_STASIS_LOCK: 'frozen',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'load',
      EXODUS_STASIS_BUNDLE_FILE: capBundle,
      STASIS_TEST_ESBUILD_OUTDIR: outB,
    },
  })
  t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
  t.assert.equal(
    readFileSync(join(outB, 'entry.js'), 'utf-8'),
    readFileSync(join(outA, 'entry.js'), 'utf-8'),
    'with-attributes import must round-trip byte-identically under bundle=load',
  )
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

test('lock=add records a .json import alongside the entry', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/data.json'].startsWith('sha512-'))
}))

test('lock=frozen succeeds with a committed .json import', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('lock=frozen rejects a changed .json import', withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'data.json'), '{ "who": "mars" }\n')

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
}))

test('bundle=add captures a .json import in the bundle', withTmp((t, tmp) => {
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

// ----- Plugin options coverage --------------------------------------------------------

const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

test('options.lock=add records the entry like the env path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('options.lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'frozen' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('options.bundle=add with bundleFile writes the bundle at the chosen path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath }),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('options conflict with env is reported', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Config options can not override stasis env/)
}))

test('unknown plugin option is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown StasisEsbuild options/)
}))

test('invalid plugin option value is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Invalid lock/)
}))

// ----- Plugin↔preload coordination paths ----------------------------------------------

const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

test('rule 1: plugin lockfile without preload is a hard throw', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run(['src/entry.js'], { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
}))

test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
    'noop plugin must not touch the lockfile')
}))

test('plugin standalone with bundle writes the bundle via onEnd', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'standalone.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath), 'plugin must write the bundle on done')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('failed build does not write the bundle (no clobber)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import './does-not-exist.js'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
  )
  const bundlePath = join(tmp, 'standalone.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.equal(existsSync(bundlePath), false, 'failed build must not write the bundle')
}))

test('unknown extension throws unless it is in the resources allowlist', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // The plugin must refuse rather than silently widen lockfile coverage to a file the
  // Node loader could never serve back.
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
  )
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test("resources allowlist attests opted-in extensions", withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
  )
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['css'] }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/styles.css'].startsWith('sha512-'),
    'allowlisted resource is hash-attested')
}))

test("resources rejects code extensions and malformed entries", withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  let r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /resources entry 'js' is a code extension/)

  r = run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['../etc/passwd'] }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /is not a valid extension/)
}))

test("esbuild plugin accepts import attributes (with { type: 'json' })", withTmp((t, tmp) => {
  cpSync(jsonFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import data from './data.json' with { type: 'json' }\nconsole.log(data)\n"
  )

  const r = run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
}))

test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const preloadBundle = join(tmp, 'preload.br')
  const sidecarBundle = join(tmp, 'sidecar.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(preloadBundle), 'preload bundle must be written by loader hooks')
  t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle must be written by plugin onEnd hook')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
}))

// ----- file-loader: binary assets copied to output (png/svg) --------------------------

test('file-loader png/svg assets throw without the resources allowlist', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_ESBUILD_LOADER: FILE_LOADER },
  })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test('file-loader png/svg assets are hash-attested and tagged with per-file resource format', withTmp((t, tmp) => {
  // Post-collapse: code and resources share one bundle, distinguished per file by
  // formats[file]: 'resource' (raw UTF-8, e.g. SVG) or 'resource:base64' (binary,
  // e.g. PNG). Both appear in the bundle's per-package files; the format tag is
  // what tells a reader "this is asset content, not code".
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(['src/entry.js'], {
    cwd: tmp,
    env: {
      STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
      ...withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  // Lockfile attests bytes (sha512 of raw bytes) for all three files.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
  t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')

  // Lockfile formats: code stays its loader format; resources get resource/resource:base64.
  t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
  t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')

  // Bundle: all three files live together; resources are tagged in formats.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.ok(decoded.sources['.'].files['src/entry.js'], 'JS entry is in the bundle')
  t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
  t.assert.ok(decoded.sources['.'].files['src/icon.svg'], 'svg is in the bundle (tagged as a resource)')
  t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
  t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
}))

test('file-loader frozen run passes against committed asset hashes and rejects a tampered asset', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })  // ships a committed lockfile with png/svg
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  let r = run(['src/entry.js'], {
    cwd: tmp,
    env: { STASIS_TEST_ESBUILD_LOADER: FILE_LOADER, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')

  // tamper the svg, frozen must reject
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')
  r = run(['src/entry.js'], {
    cwd: tmp,
    env: { STASIS_TEST_ESBUILD_LOADER: FILE_LOADER, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
  })
  t.assert.notEqual(r.status, 0, `expected frozen rejection; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /Build failed|ERR_ASSERTION|sha512-/)
}))
