// End-to-end coverage for StasisWebpack via the spawning helper.
//
// IMPORTANT: by default the helper constructs a preload State first (see
// webpack-run.helper.js) and mirrors the test's options onto it, so the plugin
// resolves into the "reuse preload" path (rules 3 / 5). The expectations below
// (lockfile written, bundle written, frozen mode rejects, etc.) are therefore
// the UNIFIED-state behavior the plugin produces under the stasis loader. Tests
// at the bottom of this file pass STASIS_TEST_PRELOAD=0 to exercise the
// standalone / noop / hard-throw paths instead.

import { test, describe } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'webpack-run.helper.js')
const fullFixture = join(here, 'fixtures', 'webpack-full')
const nmFixture = join(here, 'fixtures', 'webpack-nm')
const assetsFixture = join(here, 'fixtures', 'webpack-assets')

// Route png/svg through file-loader (copies the asset to output, returns a URL string).
const FILE_LOADER_RULES = JSON.stringify([{ test: '\\.(png|svg)$', use: 'file-loader' }])

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

// Async child-process runner. Blocking spawnSync would stall the node:test event
// loop, collapsing the describe-level `concurrency` below to wall-clock-sequential
// (the scheduler can't interleave tests if every spawn blocks the thread).
// spawn() + once('close') yields between tests, so the concurrent webpack builds
// actually overlap. Each test still gets its own subprocess -- and thus a fresh
// preload singleton -- so the isolation the spawn model provides is unchanged.
const run = async (entry, { cwd, env = {} }) => {
  const child = spawn(process.execPath, [helper, entry], {
    cwd,
    env: { ...cleanEnv, ...env },
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-webpack-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// node --test already runs test files in parallel (~= CPU count), and each test
// here spawns a webpack build subprocess. Running every test concurrently would
// oversubscribe CPU/RAM (files-in-parallel x tests-in-file); a small per-file cap
// gives most of the win while keeping the total concurrent-subprocess count bounded.
const CONCURRENCY = 4 // matches CI runner cores; higher barely helps here (see commit msg)

describe('StasisWebpack (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('lock=add records the entry and its imports', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.config, { scope: 'full' })
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
    t.assert.deepEqual(lock.modules, {})
  }))

  test('lock=frozen succeeds with the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
  }))

  test('lock=frozen rejects a changed source file', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'exports.greet = (n) => `bonjour, ${n}`\n')

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|ModuleBuildError|sha512-/)
  }))

  test('bundle=add writes a bundle whose sources match disk', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run('src/entry.js', {
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
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp(async (t, tmp) => {
    // Phase 1 in a capture-side dir (full fixture: sources, lockfile, config).
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'bundle.js'), 'utf-8')

    // Phase 2 in a clean load-side dir holding nothing but the bundle file and the
    // bare-minimum package.json State needs to anchor its root discovery. NO sources,
    // no lockfile, no stasis.config.json, no pnpm-workspace.yaml -- just the bundle.
    // This is the deployment shape we want to support: ship the bundle, drop it on
    // a host, run the bundler again, get the same output.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')
    t.assert.ok(!existsSync(join(loadDir, 'src/entry.js')), 'load dir must not contain entry')
    t.assert.ok(!existsSync(join(loadDir, 'stasis.lock.json')), 'load dir must not contain a lockfile')

    const outB = join(tmp, 'out-load')
    // lock=none: in this clean-dir scenario the bundle is self-authoritative -- no
    // lockfile is required to verify content. getFile's hash check is gated on
    // useLockfile, which is false under lock=none, so the bundle's own bytes
    // round-trip without a sibling attestation.
    const replay = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'bundle.js'), 'utf-8')

    // Round-trip faithfulness: webpack's emitted JS bytes must match between the
    // disk-fed capture run and the bundle-fed replay run.
    t.assert.equal(replayOutput, captureOutput)
  }))

  // Regression: a Node.js built-in (`constants`, `path`, ...) imported by an
  // in-scope file must NOT be looked up in the bundle's import map under bundle=load.
  // Built-ins are never carried in the bundle and never recorded as import edges --
  // the capture-side resolve hook and CJS resolution shim (stasis-core/hooks.js) both
  // short-circuit isBuiltin() specifiers to Node BEFORE addImport sees them. So the
  // load-mode beforeResolve hook has to skip them and let webpack externalize them as
  // it would without the plugin. Pre-fix, state.getImport found no edge and threw
  // ERR_MODULE_NOT_FOUND, which webpack surfaced as
  // `Module not found: Error: Cannot find module 'constants' imported from <file>`
  // (exactly the failure seen with graceful-fs/polyfills.js's `require('constants')`).
  test('bundle=load defers Node built-ins to webpack instead of looking them up in the bundle', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    // A bare builtin (`constants`, like graceful-fs) and another (`path`) alongside the
    // normal relative import: the relative edge IS attested and served from the bundle;
    // the builtins must instead defer to webpack's own externalization.
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "const constants = require('constants')\n" +
      "const path = require('path')\n" +
      "const { greet } = require('./hello')\n" +
      "console.log(greet('world'), constants.O_RDONLY, path.sep)\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'bundle.js'), 'utf-8')

    // Clean load dir: only the bundle + a minimal package.json. No sources on disk,
    // so a working load mode is the only path to a build -- and the builtins, which
    // the bundle never carried, must resolve through webpack's own externalization.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')

    const outB = join(tmp, 'out-load')
    const replay = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'bundle.js'), 'utf-8')

    // Round-trip faithfulness AND builtin externalization: the load output equals the
    // capture output, and webpack externalized the builtins (target:'node') rather
    // than failing to resolve them.
    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /require\("constants"\)/)
    t.assert.match(replayOutput, /require\("path"\)/)
  }))

  // Regression (generalizes the built-in case to ALL externals): a non-builtin module
  // the bundler externalizes -- `electron` under target:'electron-main', anything a
  // target's externals preset covers, a user `externals` entry -- is never bundled and
  // never recorded as an import edge (afterResolve only records resolutions with an
  // on-disk path). At bundle=load, state.getImport therefore has no edge and throws
  // ERR_MODULE_NOT_FOUND; the load-mode beforeResolve hook must treat that miss as
  // "external" and defer to webpack (which externalizes it) instead of failing the
  // build with `Cannot find module 'electron'`. The byte-level fail-closed gate
  // (inputFileSystem wrapper) is unaffected -- see the missing-file test below.
  test('bundle=load defers externals (electron under target:electron-main) to webpack', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    // `electron` is externalized by the electron-main target's externals preset, exactly
    // as a real Electron main-process build does; `./hello` is the in-bundle relative edge.
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "const { app } = require('electron')\n" +
      "const { greet } = require('./hello')\n" +
      "console.log(greet(typeof app))\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_TARGET: 'electron-main',
        STASIS_TEST_WEBPACK_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'bundle.js'), 'utf-8')

    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')

    const outB = join(tmp, 'out-load')
    const replay = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_TARGET: 'electron-main',
        STASIS_TEST_WEBPACK_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'bundle.js'), 'utf-8')

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /require\("electron"\)/)
  }))

  // Generality (the user's "likely other targets too"): the defer is keyed on "the bundle
  // has no edge", not on electron or any specific target preset. A bare module the user
  // marks external via webpack `externals` config (here under the default target:'node',
  // where it is NOT a builtin and NOT installed) must round-trip the same way. Proves the
  // fix covers ANY externalized specifier, not just preset/electron ones.
  test('bundle=load defers a user-configured webpack `externals` entry to webpack', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "const lib = require('fake-external-lib')\n" +
      "const { greet } = require('./hello')\n" +
      "console.log(greet(typeof lib))\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')
    // `commonjs fake-external-lib` -> webpack emits `require("fake-external-lib")` and never
    // resolves it to disk (it isn't installed), so it is externalized, not bundled.
    const EXTERNALS = JSON.stringify({ 'fake-external-lib': 'commonjs fake-external-lib' })

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_EXTERNALS: EXTERNALS,
        STASIS_TEST_WEBPACK_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'bundle.js'), 'utf-8')

    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')

    const outB = join(tmp, 'out-load')
    const replay = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_EXTERNALS: EXTERNALS,
        STASIS_TEST_WEBPACK_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'bundle.js'), 'utf-8')

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /require\("fake-external-lib"\)/)
  }))

  // Fail-closed on the genuinely-new branch: the externals defer must NOT become a disk
  // fallback for an in-scope FILE. The existing missing-file test below drops only the
  // SOURCE (keeping the edge), so getImport still succeeds and never reaches the new
  // catch. Here we drop BOTH the edge AND the bytes for an in-scope relative import:
  // getImport's resolveBundled fallback can't recover it (bytes gone) -> it throws
  // ERR_MODULE_NOT_FOUND -> the new catch defers to webpack's resolver -> which re-resolves
  // ./hello against the inputFileSystem wrapper -> getFile throws (not in bundle). The
  // build MUST fail even though hello.js is present on disk in the load dir.
  test('bundle=load still fails closed when an in-scope edge AND its bytes are dropped (defer is not a disk fallback)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-capture'),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Drop both the import edge from src/entry.js and the bytes of src/hello.js. This is
    // the only way to reach the defer branch for an in-scope file (with the edge or the
    // bytes intact, getImport resolves it from the bundle instead of throwing).
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    for (const k of Object.keys(decoded.imports)) delete decoded.imports[k]['src/entry.js']
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    // Load dir keeps the full source tree on disk, so the ONLY way to succeed would be a
    // silent disk read of hello.js -- which fail-closed must prevent.
    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-load'),
      },
    })
    t.assert.notEqual(r.status, 0, 'defer must not silently read the in-scope file from disk')
    t.assert.match(r.stderr, /hello/)
    t.assert.match(r.stderr, /resolve|not found|not attested/i)
  }))

  test('bundle=load fails closed when an in-scope file is missing from the bundle (does NOT silently fall through to disk)', withTmp(async (t, tmp) => {
    // Capture in dir A (full fixture).
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run('src/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-capture'),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Tamper with the bundle: drop src/hello.js from sources. The remaining bundle
    // still attests src/entry.js, but the dependency edge it requires is no longer
    // backed by attested bytes. The whole point of load mode's fail-closed
    // guarantee is that this MUST error -- a disk fallback would defeat the
    // attestation, because the sources are still present on disk (we never
    // delete them in this test).
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    // Re-set up a load-side dir that DOES still have the source tree -- so the
    // only way for load mode to succeed would be by silently reading hello.js
    // from disk. The fix is that it must not: the plugin should fail with a
    // bundle=load-specific error pointing at the missing file.
    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })  // copy sources back
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))  // copy tampered bundle
    // Drop the lockfile so its hashes don't reject the tampered bundle earlier
    // -- we want this test to exercise the inputFileSystem wrapper's fail-closed
    // gate, not the lockfile cross-check.
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-load'),
      },
    })
    t.assert.notEqual(r.status, 0, 'load must fail when an in-scope file is missing from the bundle')
    // The build must surface hello.js as the unresolved/missing file. Webpack's
    // resolver flattens individual stat errors into "Module not found" and tries
    // extension fallbacks, so our plugin's specific error doesn't appear verbatim
    // -- but every fallback hits the same in-scope-but-missing path, so the
    // resolver eventually reports hello.js as the unresolvable target.
    t.assert.match(r.stderr, /hello\.js/)
    t.assert.match(r.stderr, /resolve|not found/i)
  }))

  test('node_modules scope records package files', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.modules['node_modules/fake-cjs-pkg'])
    t.assert.ok(lock.modules['node_modules/fake-cjs-pkg'].files['index.js'].startsWith('sha512-'))
  }))

  test('bundle=load with any node_modules dependency: known architectural gap (TODO)', { skip: 'see comment' }, () => {
    // Scope of this limitation: ANY webpack bundle=load build whose module graph
    // crosses node_modules -- regardless of stasis scope (full OR node_modules).
    // The trivial full-scope round-trip works (`bundle=load runs from a clean dir`
    // above) only because its fixture has no nm dependencies; webpack's resolver
    // tolerates description-file lookup errors with a no-deps graph.
    //
    // For a graph with deps, two blockers stack:
    //
    // (1) Webpack 4's resolver loads `node_modules/<pkg>/package.json` for each
    //     dep -- via `fs.readFile` through enhanced-resolve's
    //     `DescriptionFilePlugin` -- to discover `main`/`exports`/`type`. The
    //     Node run loader's module hooks (stasis-core/src/hooks.js) capture
    //     modules Node IMPORTS, not arbitrary fs.readFile calls, so a bundle
    //     captured under `stasis run` does not carry those package.json files.
    //
    // (2) Webpack's resolver calls `inputFileSystem.stat` on intermediate
    //     directories (`/abs`, `/abs/node_modules`, `/abs/node_modules/<pkg>`)
    //     while walking. Our load-mode `inScope` flags any path under state.root
    //     as in-scope (full) or any nm path (nm-scope), and `state.getFile` only
    //     attests files -- directories throw "file not attested in bundle". This
    //     fires even when `node_modules` IS present on disk: the wrapper preempts
    //     the disk stat before falling through.
    //
    // Together these mean a nontrivial bundle=load deployment needs one of:
    //   (a) capturing the entire node_modules layout (every package.json + a
    //       synthetic directory entry per dir) at bundle time, OR
    //   (b) a narrower `inScope` gate that defers directory stats and
    //       package.json reads to the real FS (loosens the strict-bundle property,
    //       so the fail-closed gate would need to be re-anchored on file hashes
    //       elsewhere).
    //
    // Both are larger than this PR; tracked as a known limitation. Today's
    // verified surface is the no-deps full-scope round-trip + the capture path
    // (which works for any graph).
  })

  // ----- Plugin options coverage --------------------------------------------------------

  const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

  test('options.lock=add records the entry like the env path', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add' }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  }))

  test('options conflict with env is reported', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Config options can not override stasis env/)
  }))

  test('unknown plugin option is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Unknown StasisWebpack options/)
  }))

  test('invalid plugin option value is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Invalid lock/)
  }))

  // ----- Plugin↔preload coordination paths ----------------------------------------------

  const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

  test('rule 1: plugin lockfile without preload is a hard throw', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run('src/entry.js', { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
  }))

  // Regression: plugin construction lands in the "no ambient" branch when
  // either (a) the plugin's stasis-core copy differs from the loader's binary
  // (different module instance, isLoaderInstalled() returns false in the
  // plugin's copy), or (b) the loader's lazy initState hasn't fired yet when
  // the plugin is constructed. Both surface as `State.preload === undefined`.
  // In that branch, pre-fix, the default `lock='add'` triggered "requires a
  // stasis preload; pass lock='none' or lock='ignore'" even when the user
  // IS running under `stasis run`. The fix: when `EXODUS_STASIS_LOCK` is
  // set (which `stasis run`'s bin always sets, even at its default 'add')
  // the runtime IS providing lockfile coverage -- the plugin's standalone
  // State is a sidecar artifact and any lock mode is acceptable.
  test('no-ambient plugin under stasis run (env-var detected) accepts default lock=add', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const lockPath = join(tmp, 'sources.stasis.lock.json')
    const bundlePath = join(tmp, 'sources.stasis.code.br')

    // STASIS_TEST_PRELOAD=0 simulates the cross-instance scenario: the
    // plugin's copy of stasis-core sees no ambient State.preload because
    // the binary's stasis-core (separate copy in a real install) has the
    // active loader. EXODUS_STASIS_LOCK is the cross-instance signal.
    // The plugin no longer takes a `lockFile` option (the lockfile is always the shared
    // ambient one); a standalone cross-instance plugin that needs a separate lockfile
    // location gets it process-wide via EXODUS_STASIS_LOCK_FILE. The BUNDLE path is still a
    // plugin option (bundles legitimately split per-plugin; only the lockfile must unify).
    const r = await run('src/entry.js', {
      cwd: tmp,
      env: standalone({
        ...withOpts({ bundleFile: bundlePath }),
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_LOCK_FILE: lockPath,
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_SCOPE: 'full',
      }),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(lockPath), 'plugin writes its own lockfile at the env-configured path')
    t.assert.ok(existsSync(bundlePath), 'plugin writes its own bundle at the configured path')
    // The plugin's standalone State must NOT have written the default-path
    // lockfile -- that would race the binary's writer.
    t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')),
      'plugin must not write a phantom lockfile at the default path')
  }))

  test('rule 0: plugin with no options, no preload, not under stasis run does nothing', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    // No capture options and not under `stasis run` -> the plugin is inert (Rule 0). Wiring
    // StasisWebpack into a config is a no-op on a plain build; it neither throws nor writes.
    const r = await run('src/entry.js', { cwd: tmp, env: standalone(withOpts({})) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'inert plugin must not touch the lockfile')
  }))

  test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'noop plugin must not touch the lockfile')
  }))

  test('plugin standalone with bundle writes the bundle via done hook', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))
  }))

  test('failed build does not write the bundle (no clobber)', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "require('./does-not-exist')\nrequire('./hello').greet('world')\n"
    )
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.notEqual(r.status, 0)
    t.assert.equal(existsSync(bundlePath), false)
  }))

  test('unknown extension throws unless it is in the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'styles.css'), '/* fake css */\n')
    writeFileSync(join(tmp, 'src', 'entry.js'),
      "require('./hello').greet('world')\nrequire('./styles.css')\n")
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test('resources allowlist attests opted-in extensions', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'styles.css'), '/* fake css */\n')
    writeFileSync(join(tmp, 'src', 'entry.js'),
      "require('./hello').greet('world')\nrequire('./styles.css')\n")
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['css'] }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/styles.css'].startsWith('sha512-'),
      'allowlisted resource is hash-attested')
  }))

  test('resources entry that is a code extension is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /resources entry 'js' is a code extension/)
  }))

  // ----- file-loader: binary assets copied to output (png/svg) --------------------------

  test('file-loader png/svg assets throw without the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'), { force: true })

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES },
    })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test('file-loader png/svg assets are hash-attested and tagged with per-file resource format', withTmp(async (t, tmp) => {
    // Post-collapse: code and resources share one bundle, distinguished per file by
    // formats[file]: 'resource' (raw UTF-8, e.g. SVG) or 'resource:base64' (binary,
    // e.g. PNG). The asset's bytes still can't change without the lockfile noticing
    // (the security guarantee); the format tag is what disambiguates the encoding.
    cpSync(assetsFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'), { force: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: {
        STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES,
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    // Lockfile attests bytes (sha512 of raw bytes) for all three files.
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
    t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')
    t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
    t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')

    // Bundle: all three files live together; the format tag tells a reader which
    // payload encoding applies.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.ok(decoded.sources['.'].files['src/entry.js'], 'JS entry is in the bundle')
    t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
    t.assert.ok(decoded.sources['.'].files['src/icon.svg'], 'svg is in the bundle (tagged as a resource)')
    t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
    t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
  }))

  test('file-loader frozen run passes against the committed asset hashes', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })  // ships a committed lockfile with png/svg
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: { STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')
  }))

  test('file-loader frozen run rejects a tampered asset', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })
    // flip a byte in the committed svg
    writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: { STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
    })
    t.assert.notEqual(r.status, 0, `expected frozen rejection; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /ERR_ASSERTION|ModuleBuildError|sha512-/)
  }))

  // Regression: webpack 4's NormalModuleFactory reuses
  // data.resourceResolveData.context.issuer across factory invocations -- by the
  // time afterResolve fires for a given dependency, that field can hold the
  // issuer from an EARLIER resolution, even though rrd.path (the file webpack
  // actually bundles) is fresh. A plugin reading rrd.context.issuer for parent
  // attribution would mis-bucket the edge; pre-fix, stasis bucketed two distinct
  // (issuer, 'bs58') edges under the SAME stale parent and the noupsert in
  // state.addImport threw "Conflict for 'bs58'". The fix taps beforeResolve and
  // caches contextInfo.issuer per-dependency, then looks it up in afterResolve.
  // Topology: top bs58@3 + base58check at top (requires bs58 -> top), example
  // as a file: dep via symlink, middle bs58@6 inside example/node_modules.
  // example/index.js requires bs58 (-> middle) AND base58check; base58check's
  // own require('bs58') resolves to top. The third resolution is the one that
  // gets the stale-issuer treatment from webpack 4.
  test('regression: webpack 4 stale rrd.context.issuer does not collapse two distinct (issuer, bs58) edges', withTmp(async (t, tmp) => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0', private: true }))
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
    writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))

    // top-level bs58@3
    mkdirSync(join(tmp, 'node_modules', 'bs58'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'bs58', 'package.json'), JSON.stringify({ name: 'bs58', version: '3.1.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'node_modules', 'bs58', 'index.js'), 'module.exports = { v: 3 }\n')

    // top-level base58check (requires bs58 -> top)
    mkdirSync(join(tmp, 'node_modules', 'base58check'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'base58check', 'package.json'), JSON.stringify({ name: 'base58check', version: '2.0.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'node_modules', 'base58check', 'index.js'), "const bs58 = require('bs58')\nmodule.exports = { v: 2, bs58 }\n")

    // example: a file: dep at the project root, with its own node_modules/bs58@6 (middle)
    mkdirSync(join(tmp, 'example', 'node_modules', 'bs58'), { recursive: true })
    writeFileSync(join(tmp, 'example', 'package.json'), JSON.stringify({ name: 'example', version: '0.0.0' }))
    writeFileSync(join(tmp, 'example', 'index.js'), "require('bs58')\nrequire('base58check')\n")
    writeFileSync(join(tmp, 'example', 'node_modules', 'bs58', 'package.json'), JSON.stringify({ name: 'bs58', version: '6.0.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'example', 'node_modules', 'bs58', 'index.js'), 'module.exports = { v: 6 }\n')

    // node_modules/example -> ../example (the file: dep symlink that npm/yarn produces)
    symlinkSync(join('..', 'example'), join(tmp, 'node_modules', 'example'), 'dir')

    const r = await run('node_modules/example/index.js', {
      cwd: tmp,
      env: withOpts({ lock: 'add', bundle: 'none', scope: 'full' }),
    })
    t.assert.equal(r.status, 0, `pre-fix this throws Conflict for 'bs58'; got stderr:\n${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const edges = lock.imports?.['*'] ?? {}

    // example/index.js's two edges
    t.assert.equal(edges['example/index.js']?.['bs58'], 'example/node_modules/bs58/index.js', 'example bs58 -> middle')
    t.assert.equal(edges['example/index.js']?.['base58check'], 'node_modules/base58check/index.js', 'example base58check -> top')

    // base58check's bs58 edge must be attributed to base58check, not to the stale example/index.js
    t.assert.equal(edges['node_modules/base58check/index.js']?.['bs58'], 'node_modules/bs58/index.js',
      "base58check's bs58 must be attributed to base58check's own parent, not the stale example/index.js")
  }))

  test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const preloadBundle = join(tmp, 'preload.br')
    const sidecarBundle = join(tmp, 'sidecar.br')

    const r = await run('src/entry.js', {
      cwd: tmp,
      env: {
        STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(preloadBundle), 'preload bundle written by loader hooks')
    t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle written by plugin done hook')
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
  }))

  // ----- package.json "imports" subpaths rewritten by babel-plugin-module-resolver ---------
  //
  // Regression: webpack 4's enhanced-resolve has no imports-field support, so a
  // `require('#app/abc.js')` (a package.json "imports" subpath) only builds because a babel
  // loader -- babel-plugin-module-resolver -- rewrites the specifier IN SOURCE to an
  // importer-relative path (`../abc.js`) before webpack's parser sees it. Pre-fix, the plugin
  // keyed the import edge on webpack's post-loader `rawRequest` (`../abc.js`), so the portable
  // original `#app/abc.js` was lost and the load-mode `#`-resolution machinery in state.js was
  // dead. The fix monkey-patches module-resolver's rewrite chokepoint to recover the original
  // and records THAT as the key. These tests stand up a faithful fake of module-resolver (its
  // chokepoint moved from `lib/utils.js` `mapPathString` in v3 to `lib/mapPath.js` default in
  // v4/v5 -- both covered) plus a loader that routes the rewrite through it, exactly as
  // babel-loader would, so the plugin's patch observes the rewrite.

  // Faithful fake of babel-plugin-module-resolver: a CJS package whose rewrite chokepoint reads
  // the original specifier off the node, resolves a `#app/<x>` subpath to an importer-relative
  // path, and replaceWith()s it -- the exact contract StasisWebpack#patchModuleResolver wraps.
  // `shape` picks the version layout: 'v3' exposes `lib/utils.js` `mapPathString`; 'v4v5' exposes
  // `lib/mapPath.js` default (which reads `customResolvePath`). Mirrors the real published tarballs.
  // Stands in for module-resolver's alias resolution: an alias prefix configured by the project
  // ('#app/' is a package.json "imports" subpath; '~lib/' is a plain alias used by the gate test)
  // maps into <root>/src and is returned as a path relative to the importer's dir (posix,
  // './'-prefixed) -- the observable input->output the plugin's patch reads. NB: '#' is only an
  // alias-config convention here; module-resolver has no built-in '#'-awareness (it resolves via
  // the user's `alias`/`root` config), so the patch keys off the AUTHORED prefix, not the resolver.
  const RESOLVE_PATH_JS = `'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const path = require('path')
exports.default = function resolvePath(sourcePath, currentFile, opts) {
  if (typeof sourcePath !== 'string') return null
  // '#app/' and '#alt/' are two subpath aliases that BOTH map into <root>/src, so e.g.
  // '#app/abc.js' and '#alt/abc.js' resolve to the same file and rewrite to the same relative
  // request -- the collision the recorder must keep both originals for. '~lib/' is the non-'#'
  // alias used by the gate test.
  const prefix = ['#app/', '#alt/', '~lib/'].find((p) => sourcePath.startsWith(p))
  if (!prefix) return null
  const target = path.resolve(opts.root, 'src', sourcePath.slice(prefix.length))
  let rel = path.relative(path.dirname(currentFile), target)
  if (!rel.startsWith('.')) rel = './' + rel
  return rel.split(path.sep).join('/')
}
`
  // Mirrors the real chokepoint's body, including the leading isStringLiteral guard and the
  // pathResolved tagging that makes a re-visit a no-op (so the patch observes each rewrite once).
  const chokepointBody = (resolverExpr) => `function rewrite(nodePath, state) {
  if (!state.types.isStringLiteral(nodePath)) return
  if (nodePath.node.pathResolved) return
  const sourcePath = nodePath.node.value
  const currentFile = state.file.opts.filename
  const modulePath = ${resolverExpr}(sourcePath, currentFile, state.opts)
  if (modulePath) {
    nodePath.replaceWith(state.types.stringLiteral(modulePath))
    nodePath.node.pathResolved = true
  }
}`

  function writeFakeModuleResolver(pkgDir, shape) {
    const lib = join(pkgDir, 'lib')
    mkdirSync(join(lib, 'transformers'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'babel-plugin-module-resolver', version: shape === 'v3' ? '3.2.0' : '5.0.3', main: 'lib/index.js' }))
    writeFileSync(join(lib, 'index.js'),
      `'use strict'\nObject.defineProperty(exports, '__esModule', { value: true })\n` +
      `exports.resolvePath = require('./resolvePath').default\n` +
      `exports.default = function moduleResolver() { return { name: 'module-resolver', visitor: {} } }\n`)
    writeFileSync(join(lib, 'resolvePath.js'), RESOLVE_PATH_JS)
    if (shape === 'v3') {
      // v3 chokepoint: lib/utils.js named export mapPathString, reads normalizedOpts.resolvePath.
      writeFileSync(join(lib, 'utils.js'),
        `'use strict'\nObject.defineProperty(exports, '__esModule', { value: true })\n` +
        `${chokepointBody('state.normalizedOpts.resolvePath')}\nexports.mapPathString = rewrite\n`)
    } else {
      // v4/v5 chokepoint: lib/mapPath.js default export, reads normalizedOpts.customResolvePath.
      writeFileSync(join(lib, 'mapPath.js'),
        `'use strict'\nObject.defineProperty(exports, '__esModule', { value: true })\n` +
        `${chokepointBody('state.normalizedOpts.customResolvePath')}\nexports.default = rewrite\n`)
    }
  }

  // A loader that stands in for babel-loader: it rewrites every alias specifier ('#app/...' or
  // '~lib/...') in source to an importer-relative path by routing through module-resolver's OWN
  // chokepoint (the function the plugin patches), so the rewrite is observed. Mirrors the v3-vs-v4/v5
  // patch try-order. The fake `state.types.isStringLiteral` matches the real plugin's leading guard.
  const MODULE_RESOLVER_LOADER = `'use strict'
let chokepoint, resolveOpt
try { chokepoint = require('babel-plugin-module-resolver/lib/mapPath').default; resolveOpt = 'customResolvePath' }
catch { chokepoint = require('babel-plugin-module-resolver/lib/utils').mapPathString; resolveOpt = 'resolvePath' }
const resolvePath = require('babel-plugin-module-resolver/lib/resolvePath').default
module.exports = function (source) {
  const filename = this.resourcePath
  const root = this.rootContext
  return source.replace(/(['"])((?:#app|#alt|~lib)\\/[^'"]+)\\1/g, (m, q, spec) => {
    const np = { node: { value: spec }, replaceWith(n) { this.node = n } }
    const state = {
      file: { opts: { filename } },
      types: { stringLiteral: (value) => ({ value }), isStringLiteral: (n) => typeof n?.node?.value === 'string' },
      normalizedOpts: { [resolveOpt]: resolvePath },
      opts: { root },
    }
    chokepoint(np, state)
    return q + np.node.value + q
  })
}
`

  // Build the project + fake module-resolver + loader under `tmp`. The importer sits one dir deep
  // (src/nested/entry.js) so its rewritten relative request (`../abc.js`) is visibly DIFFERENT from
  // the original specifier(s) -- the whole point of the assertions. `specs` is what the entry imports
  // (string or array; default the '#app/abc.js' subpath). Returns the loader's path.
  function writeSubpathProject(tmp, shape, specs = '#app/abc.js') {
    const list = Array.isArray(specs) ? specs : [specs]
    writeFileSync(join(tmp, 'package.json'),
      JSON.stringify({ name: 'subpath-app', version: '0.0.0', private: true, imports: { '#app/*': './src/*', '#alt/*': './src/*' } }))
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
    writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
    mkdirSync(join(tmp, 'src', 'nested'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'abc.js'), 'module.exports = 42\n')
    const requires = list.map((s, i) => `const v${i} = require('${s}')`).join('\n')
    writeFileSync(join(tmp, 'src', 'nested', 'entry.js'),
      `${requires}\nconsole.log(${list.map((_, i) => `v${i}`).join(', ')})\n`)
    writeFakeModuleResolver(join(tmp, 'node_modules', 'babel-plugin-module-resolver'), shape)
    const loaderPath = join(tmp, 'module-resolver-loader.cjs')
    writeFileSync(loaderPath, MODULE_RESOLVER_LOADER)
    return loaderPath
  }

  for (const shape of ['v3', 'v4v5']) {
    test(`module-resolver (${shape}) rewrite of a '#'-subpath is captured under the ORIGINAL key`, withTmp(async (t, tmp) => {
      const loaderPath = writeSubpathProject(tmp, shape)
      const rules = JSON.stringify([{ test: '\\.js$', use: loaderPath }])

      const r = await run('src/nested/entry.js', {
        cwd: tmp,
        env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: rules },
      })
      t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

      const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
      const edges = lock.imports?.['*']?.['src/nested/entry.js'] ?? {}
      // The edge is keyed by the ORIGINAL subpath specifier, mapping to the resolved file...
      t.assert.equal(edges['#app/abc.js'], 'src/abc.js',
        `expected '#app/abc.js' edge; got ${JSON.stringify(edges)}`)
      // ...and NOT by the babel-rewritten importer-relative path (pre-fix this was the only key).
      t.assert.equal(edges['../abc.js'], undefined,
        'resolved relative path must not be recorded as the key')
    }))
  }

  // Real-package smoke test: exercise the ACTUAL babel-plugin-module-resolver (a top-level test
  // devDep), not the fake. A custom loader runs real @babel/core + the real plugin to rewrite
  // '#app/abc.js' in source; the plugin's monkey-patch must wrap the REAL chokepoint (v3
  // lib/utils.js `mapPathString`) and recover the original key. node_modules is symlinked to the
  // workspace so the loader's requires AND #patchModuleResolver's require.resolve (anchored on
  // state.root) find the SAME installed copy -> the patch wraps the chokepoint babel actually runs.
  // Pins the patch against the real package's export shape; the fakes above cover the v3/v4v5 shapes
  // and the edge cases (collapse, gate) the controllable fake makes cheap.
  test("REAL babel-plugin-module-resolver rewrite of a '#'-subpath is captured under the ORIGINAL key", withTmp(async (t, tmp) => {
    const workspaceNodeModules = join(here, '..', 'node_modules')
    writeFileSync(join(tmp, 'package.json'),
      JSON.stringify({ name: 'subpath-app-real', version: '0.0.0', private: true, imports: { '#app/*': './src/*' } }))
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
    writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
    mkdirSync(join(tmp, 'src', 'nested'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'abc.js'), 'module.exports = 42\n')
    writeFileSync(join(tmp, 'src', 'nested', 'entry.js'),
      "const abc = require('#app/abc.js')\nconsole.log(abc)\n")
    symlinkSync(workspaceNodeModules, join(tmp, 'node_modules'), 'dir')
    const loaderPath = join(tmp, 'babel-real-loader.cjs')
    writeFileSync(loaderPath, `'use strict'
const babel = require('@babel/core')
const mrPath = require.resolve('babel-plugin-module-resolver')
module.exports = function (source) {
  const out = babel.transformSync(source, {
    babelrc: false, configFile: false, filename: this.resourcePath,
    plugins: [[mrPath, { cwd: this.rootContext, alias: { '^#app/(.+)': './src/\\\\1' } }]],
  })
  return out.code
}
`)
    const rules = JSON.stringify([{ test: '\\.js$', use: loaderPath }])

    const r = await run('src/nested/entry.js', {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: rules },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const edges = lock.imports?.['*']?.['src/nested/entry.js'] ?? {}
    t.assert.equal(edges['#app/abc.js'], 'src/abc.js',
      `expected '#app/abc.js' edge from the real plugin; got ${JSON.stringify(edges)}`)
    t.assert.equal(edges['../abc.js'], undefined, 'resolved relative path must not be recorded as the key')
  }))

  // Gate: the recovery is scoped to package.json "imports" subpaths ('#'-prefixed). A NON-'#'
  // module-resolver alias ('~lib/abc.js') is rewritten by the same chokepoint, but the plugin must
  // leave its edge keyed on webpack's resolved rawRequest -- recovering it would over-capture an
  // alias that isn't a portable subpath import. Guards `before.startsWith('#')` in #patchModuleResolver.
  test("module-resolver rewrite of a NON-'#' alias keeps webpack's resolved key", withTmp(async (t, tmp) => {
    const loaderPath = writeSubpathProject(tmp, 'v3', '~lib/abc.js')
    const rules = JSON.stringify([{ test: '\\.js$', use: loaderPath }])

    const r = await run('src/nested/entry.js', {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: rules },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const edges = lock.imports?.['*']?.['src/nested/entry.js'] ?? {}
    // The non-'#' alias resolves to the same file, but the edge stays keyed by the rewritten
    // relative path (rawRequest) -- the '#'-gate must not recover a plain alias.
    t.assert.equal(edges['../abc.js'], 'src/abc.js',
      `expected the resolved relative key; got ${JSON.stringify(edges)}`)
    t.assert.equal(edges['~lib/abc.js'], undefined, 'a non-# alias must not be recovered as the key')
  }))

  // Collision: two distinct subpath aliases ('#app/abc.js' and '#alt/abc.js') that resolve to the
  // SAME file from one importer both rewrite to the identical relative request ('../abc.js'), so the
  // recorder keys them under one slot. Both originals must survive (recorded as separate edges) --
  // a single-value recorder would drop one, and at clean-dir load the dropped subpath would miss.
  test("two '#'-subpaths collapsing to one relative request both keep their original keys", withTmp(async (t, tmp) => {
    const loaderPath = writeSubpathProject(tmp, 'v3', ['#app/abc.js', '#alt/abc.js'])
    const rules = JSON.stringify([{ test: '\\.js$', use: loaderPath }])

    const r = await run('src/nested/entry.js', {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: rules },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const edges = lock.imports?.['*']?.['src/nested/entry.js'] ?? {}
    t.assert.equal(edges['#app/abc.js'], 'src/abc.js', `expected '#app/abc.js' edge; got ${JSON.stringify(edges)}`)
    t.assert.equal(edges['#alt/abc.js'], 'src/abc.js', `expected '#alt/abc.js' edge (not dropped); got ${JSON.stringify(edges)}`)
    t.assert.equal(edges['../abc.js'], undefined, 'resolved relative path must not be recorded as the key')
  }))

  // End-to-end: the recovered '#'-key makes a clean-dir bundle=load build resolve the subpath itself.
  // At load the source is served from the bundle with the ORIGINAL '#app/abc.js' intact (capture
  // records pre-loader source); with no rewriting loader present (the realistic clean-dir case, where
  // module-resolver can't re-resolve the subpath), beforeResolve looks the edge up by '#app/abc.js'
  // and redirects it -- which only works because the fix recorded that key. Pre-fix the bundle held
  // only a '../abc.js' edge, so this lookup would miss and the build would fail.
  test("bundle=load resolves a '#'-subpath via the recovered key in a clean dir", withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    mkdirSync(capDir)
    const loaderPath = writeSubpathProject(capDir, 'v3')
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run('src/nested/entry.js', {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_WEBPACK_RULES: JSON.stringify([{ test: '\\.js$', use: loaderPath }]),
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-capture'),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Clean load dir: only the bundle + a minimal package.json. No src, no module-resolver, no loader
    // -- so webpack sees the bundle-served `require('#app/abc.js')` verbatim and must rely on the
    // recorded edge to resolve it.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')

    const replay = await run('src/nested/entry.js', {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'out-load'),
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    // status 0 already proves the subpath resolved (webpack 4 can't resolve '#app/...' natively, so a
    // miss would fail the build). Additionally assert the RIGHT target's bytes round-tripped: the
    // bundle-served src/abc.js payload must be inlined into the load output -- not merely that some
    // file was emitted. (Full byte-equality with capture would be brittle: mode:'none' embeds the
    // request string in module comments, which legitimately differs -- '#app/abc.js' vs '../abc.js'.)
    const replayOutput = readFileSync(join(tmp, 'out-load', 'bundle.js'), 'utf-8')
    t.assert.match(replayOutput, /module\.exports = 42/, 'src/abc.js bytes must be served from the bundle into the output')
  }))
})
