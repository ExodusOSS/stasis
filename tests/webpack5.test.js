// Smoke coverage for StasisWebpack against webpack 5 (aliased as `webpack5`
// in this workspace -- npm:webpack@^5.x). Mirrors the key capture-mode cases
// from tests/webpack.test.js to confirm the cross-version field-unwrap in
// stasis-core/src/webpack.js (`data.createData ?? data`) lets a single plugin
// codebase work against both webpack 4 and webpack 5 NMF shapes.

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
const helper = join(here, 'webpack5-run.helper.js')
const fullFixture = join(here, 'fixtures', 'webpack-full')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

// Async child-process runner. Blocking spawnSync would stall the node:test event
// loop, collapsing the describe-level `concurrency` below to wall-clock-sequential.
// spawn() + once('close') yields between tests, so the concurrent webpack builds
// actually overlap. Each test still gets its own subprocess -- and thus a fresh
// preload singleton -- so the isolation the spawn model provides is unchanged.
const run = async (entry, { cwd, env = {} }) => {
  const child = spawn(process.execPath, [helper, entry], { cwd, env: { ...cleanEnv, ...env } })
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
  const dir = mkdtempSync(join(tmpdir(), 'stasis-webpack5-'))
  try { return await fn(t, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

// node --test already runs test files in parallel (~= CPU count), and each test
// here spawns a build subprocess. Running every test at once would oversubscribe
// CPU/RAM (files-in-parallel x tests-in-file); a small per-file cap keeps the
// total concurrent-subprocess count bounded while capturing most of the speedup.
const CONCURRENCY = 4 // matches CI runner cores; higher barely helps here (see commit msg)

describe('StasisWebpack5 (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('webpack5 lock=add records the entry and its imports', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.config, { scope: 'full' })
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  }))

  test('webpack5 bundle=add writes a bundle whose sources match disk', withTmp(async (t, tmp) => {
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

  // Bundle=load on webpack 5 exercises the plugin's #applyLoadMode path -- the
  // inputFileSystem Proxy + `data.request` mutation in beforeResolve. The webpack 5
  // resolver pipeline split resolveData / createData, but the request-mutation
  // contract is still honored (beforeResolve runs BEFORE the resolver reads request,
  // confirmed against NormalModuleFactory.js:1054). This test pins both the proxy
  // interception and the mutation contract by replaying a captured bundle in a
  // clean dir and demanding byte-identical webpack output.
  test('webpack5 bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp(async (t, tmp) => {
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

    // Phase 2: a clean dir with only the bundle + a minimal package.json. No sources
    // on disk, so a working load mode is the ONLY path to a successful build.
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

    // webpack 4 and webpack 5 emit different runtime preambles, so we can't compare
    // capture-vs-replay across versions; but within webpack 5 the two outputs must
    // match -- proving the bundle-served bytes are the same as the disk-fed bytes.
    t.assert.equal(replayOutput, captureOutput)
  }))

  // Commit-2 coverage (family serving). When the plugin runs as a SIDECAR -- its
  // bundleFile differs from the ambient preload's, so resolvePluginState Rule 6
  // gives it its own bundle parented to the preload -- the load-mode inputFileSystem
  // wrapper must serve an in-scope file the sidecar's OWN bundle lacks from the
  // PARENT (preload) bundle. That mirrors the real split (webpack app graph in the
  // sidecar; build-time/extra closure in the parent) WITHOUT crossing node_modules,
  // so the known package.json/DescriptionFilePlugin gap (see webpack.test.js's
  // skipped TODO) does not apply: here src/hello.js lives ONLY in the parent bundle
  // while the sidecar keeps the src/entry.js -> ./hello EDGE, so beforeResolve still
  // redirects to it and the byte read must fall through to the parent.
  //
  // Without the family lookup the sidecar's getFile throws "not attested" on
  // hello.js and the build fails; this test is the regression guard for that.
  test('webpack5 sidecar bundle=load serves an in-scope file the sidecar lacks from the parent bundle', withTmp(async (t, tmp) => {
    // Phase 1: an ordinary full-scope capture -> one complete bundle (entry + hello).
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'parent.br')
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

    // Derive the SIDECAR bundle = the parent minus src/hello.js's bytes, KEEPING the
    // entry->hello edge. The sidecar alone therefore cannot serve hello.js; only the
    // parent can. (Same direct-bundle-surgery technique as webpack.test.js's
    // fail-closed test.)
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    t.assert.ok(decoded.sources['.'].files['src/hello.js'], 'precondition: parent carries hello.js bytes')
    t.assert.ok(decoded.imports['*']?.['src/entry.js']?.['./hello'], 'precondition: entry->hello edge present')
    delete decoded.sources['.'].files['src/hello.js']
    const sidecarBundle = join(tmp, 'sidecar.br')
    writeFileSync(sidecarBundle, brotliCompressSync(JSON.stringify(decoded)))

    // Phase 2: a clean load dir (NO src/ on disk, so a disk read can't mask the
    // result) holding both bundles. The preload loads the parent bundle; the plugin,
    // given a different bundleFile, becomes a sidecar parented to the preload.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'parent.br'))
    copyFileSync(sidecarBundle, join(loadDir, 'sidecar.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true }')
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')

    const outB = join(tmp, 'out-load')
    const replay = await run('src/entry.js', {
      cwd: loadDir,
      env: {
        STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({
          scope: 'full', lock: 'none', bundle: 'load', bundleFile: join(loadDir, 'parent.br'),
        }),
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({
          scope: 'full', lock: 'none', bundle: 'load', bundleFile: join(loadDir, 'sidecar.br'),
        }),
        STASIS_TEST_WEBPACK_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'bundle.js'), 'utf-8')
    // hello.js was served from the parent bundle; the emitted output still matches
    // the single-bundle capture byte-for-byte.
    t.assert.equal(replayOutput, captureOutput)
  }))

  // Regression (webpack 5 + node:-prefixed builtins): same fix as the webpack 4 case
  // in tests/webpack.test.js, but webpack 5 additionally understands the `node:` scheme,
  // so this pins both the bare form (`constants`) and the prefixed form (`node:os`). The
  // load-mode beforeResolve hook must skip isBuiltin() specifiers -- they're never in the
  // bundle's import map (capture defers them to Node before addImport) -- and let webpack
  // externalize them. Pre-fix, state.getImport threw ERR_MODULE_NOT_FOUND ->
  // `Module not found: Error: Cannot find module 'constants' imported from <file>`.
  test('webpack5 bundle=load defers bare and node:-prefixed builtins to webpack', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "const constants = require('constants')\n" +
      "const os = require('node:os')\n" +
      "const { greet } = require('./hello')\n" +
      "console.log(greet('world'), constants.O_RDONLY, os.EOL)\n")
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

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /require\("constants"\)/)
    t.assert.match(replayOutput, /require\("node:os"\)/)
  }))

  // Regression (webpack 5, non-builtin external): `electron` under target:'electron-main'
  // is externalized by the target's preset and never recorded as an import edge, so at
  // bundle=load state.getImport throws ERR_MODULE_NOT_FOUND. The load-mode beforeResolve
  // hook must treat that miss as "external" and defer to webpack rather than failing with
  // `Cannot find module 'electron'`.
  test('webpack5 bundle=load defers externals (electron under target:electron-main) to webpack', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
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

  test('webpack5 bundle=load fails closed when an in-scope file is missing from the bundle', withTmp(async (t, tmp) => {
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

    // Drop src/hello.js from the bundle's sources map. The on-disk file still
    // exists in the load dir -- only a working fail-closed gate (inputFileSystem
    // Proxy throwing on getFile miss) prevents a silent disk fallback.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

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
    t.assert.notEqual(r.status, 0, 'load must fail when an in-scope file is missing from the bundle')
    t.assert.match(r.stderr, /hello\.js/)
  }))

  test('webpack5 lock=frozen succeeds with the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    // frozen mode must not rewrite the lockfile
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
  }))

  // The webpack 4 stale-issuer regression (tests/webpack.test.js) is a webpack-4-only
  // bug -- webpack 5's NMF redesigned the resolveData flow so contextInfo.issuer is
  // fresh in afterResolve. Still worth confirming the SAME synthetic topology
  // captures cleanly under webpack 5: same lockfile shape, no Conflict, edges
  // attributed to the actual importers.
  test('webpack5 captures the file:-dep + nested-bs58 topology with correct edge attribution', withTmp(async (t, tmp) => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0', private: true }))
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
    writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))

    mkdirSync(join(tmp, 'node_modules', 'bs58'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'bs58', 'package.json'), JSON.stringify({ name: 'bs58', version: '3.1.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'node_modules', 'bs58', 'index.js'), 'module.exports = { v: 3 }\n')

    mkdirSync(join(tmp, 'node_modules', 'base58check'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'base58check', 'package.json'), JSON.stringify({ name: 'base58check', version: '2.0.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'node_modules', 'base58check', 'index.js'), "const bs58 = require('bs58')\nmodule.exports = { v: 2, bs58 }\n")

    mkdirSync(join(tmp, 'example', 'node_modules', 'bs58'), { recursive: true })
    writeFileSync(join(tmp, 'example', 'package.json'), JSON.stringify({ name: 'example', version: '0.0.0' }))
    writeFileSync(join(tmp, 'example', 'index.js'), "require('bs58')\nrequire('base58check')\n")
    writeFileSync(join(tmp, 'example', 'node_modules', 'bs58', 'package.json'), JSON.stringify({ name: 'bs58', version: '6.0.0', main: 'index.js' }))
    writeFileSync(join(tmp, 'example', 'node_modules', 'bs58', 'index.js'), 'module.exports = { v: 6 }\n')

    symlinkSync(join('..', 'example'), join(tmp, 'node_modules', 'example'), 'dir')

    const r = await run('node_modules/example/index.js', { cwd: tmp, env: withOpts({ lock: 'add', bundle: 'none', scope: 'full' }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const edges = lock.imports?.['*'] ?? {}
    t.assert.equal(edges['example/index.js']?.['bs58'], 'example/node_modules/bs58/index.js')
    t.assert.equal(edges['example/index.js']?.['base58check'], 'node_modules/base58check/index.js')
    t.assert.equal(edges['node_modules/base58check/index.js']?.['bs58'], 'node_modules/bs58/index.js')
  }))

  // Commit-1 coverage (directory stats). webpack's resolver stat()s a directory while
  // resolving it to an index file. Here the ENTRY is a directory ('src' -> src/index.js);
  // entries bypass the beforeResolve redirect (no issuer), so the async resolver walks and
  // actually stat()s src/ through the wrapped inputFileSystem. In load mode that stat must
  // be answered with a directory Stats from the bundle's existence record (getFsStat);
  // without it the wrapper falls through to getFile -- which throws on a directory -- and
  // webpack reports `src doesn't exist`. This mirrors the real trigger (the loader resolver
  // walking in-scope node_modules dirs) without crossing node_modules, so the known
  // package.json/DescriptionFilePlugin gap (see webpack.test.js's skipped TODO) doesn't apply.
  test('webpack5 bundle=load resolves a directory entry by stat-ing the in-bundle directory', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    mkdirSync(join(capDir, 'src'), { recursive: true })
    writeFileSync(join(capDir, 'package.json'), '{ "name": "stasis-dir-entry", "version": "0.0.0", "private": true }')
    writeFileSync(join(capDir, 'stasis.config.json'), '{ "scope": "full" }')
    writeFileSync(join(capDir, 'src', 'index.js'), "const { greet } = require('./hello')\nconsole.log(greet('world'))\n")
    writeFileSync(join(capDir, 'src', 'hello.js'), 'exports.greet = (name) => `hello, ${name}`\n')
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')
    // Entry is the DIRECTORY 'src'; webpack resolves it to src/index.js.
    const capture = await run('src', {
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

    // Clean load dir: only the bundle (no src/ on disk), so resolving the directory
    // entry depends entirely on the bundle answering the stat of src/ as a directory.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-dir-entry", "version": "0.0.0", "private": true }')
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')

    const outB = join(tmp, 'out-load')
    const replay = await run('src', {
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
    // The directory entry resolved through the bundle; output matches the disk-fed capture.
    t.assert.equal(readFileSync(join(outB, 'bundle.js'), 'utf-8'), captureOutput)
  }))
})
