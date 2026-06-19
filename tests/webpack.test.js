// End-to-end coverage for StasisWebpack via the spawning helper.
//
// IMPORTANT: by default the helper constructs a preload State first (see
// webpack-run.helper.js) and mirrors the test's options onto it, so the plugin
// resolves into the "reuse preload" path (rules 3 / 5). The expectations below
// (lockfile written, bundle written, frozen mode rejects, etc.) are therefore
// the UNIFIED-state behavior the plugin produces under the stasis loader. Tests
// at the bottom of this file pass STASIS_TEST_PRELOAD=0 to exercise the
// standalone / noop / hard-throw paths instead.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
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

const run = (entry, { cwd, env = {} }) => {
  const r = spawnSync(process.execPath, [helper, entry], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, ...env },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-webpack-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('lock=add records the entry and its imports', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'full' })
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  t.assert.deepEqual(lock.modules, {})
}))

test('lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'exports.greet = (n) => `bonjour, ${n}`\n')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|ModuleBuildError|sha512-/)
}))

test('bundle=add writes a bundle whose sources match disk', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
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

test('bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp((t, tmp) => {
  // Phase 1 in a capture-side dir (full fixture: sources, lockfile, config).
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')
  const outA = join(tmp, 'out-capture')

  const capture = run('src/entry.js', {
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
  const replay = run('src/entry.js', {
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
test('bundle=load defers Node built-ins to webpack instead of looking them up in the bundle', withTmp((t, tmp) => {
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

  const capture = run('src/entry.js', {
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
  const replay = run('src/entry.js', {
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
test('bundle=load defers externals (electron under target:electron-main) to webpack', withTmp((t, tmp) => {
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

  const capture = run('src/entry.js', {
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
  const replay = run('src/entry.js', {
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
test('bundle=load defers a user-configured webpack `externals` entry to webpack', withTmp((t, tmp) => {
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

  const capture = run('src/entry.js', {
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
  const replay = run('src/entry.js', {
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
test('bundle=load still fails closed when an in-scope edge AND its bytes are dropped (defer is not a disk fallback)', withTmp((t, tmp) => {
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')

  const capture = run('src/entry.js', {
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

  const r = run('src/entry.js', {
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

test('bundle=load fails closed when an in-scope file is missing from the bundle (does NOT silently fall through to disk)', withTmp((t, tmp) => {
  // Capture in dir A (full fixture).
  const capDir = join(tmp, 'cap')
  cpSync(fullFixture, capDir, { recursive: true })
  const capBundle = join(capDir, 'snapshot.br')

  const capture = run('src/entry.js', {
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

  const r = run('src/entry.js', {
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

test('node_modules scope records package files', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' } })
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

test('options.lock=add records the entry like the env path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('options conflict with env is reported', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Config options can not override stasis env/)
}))

test('unknown plugin option is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown StasisWebpack options/)
}))

test('invalid plugin option value is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Invalid lock/)
}))

// ----- Plugin↔preload coordination paths ----------------------------------------------

const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

test('rule 1: plugin lockfile without preload is a hard throw', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
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
test('no-ambient plugin under stasis run (env-var detected) accepts default lock=add', withTmp((t, tmp) => {
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
  const r = run('src/entry.js', {
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

test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
    'noop plugin must not touch the lockfile')
}))

test('plugin standalone with bundle writes the bundle via done hook', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))
}))

test('failed build does not write the bundle (no clobber)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "require('./does-not-exist')\nrequire('./hello').greet('world')\n"
  )
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.notEqual(r.status, 0)
  t.assert.equal(existsSync(bundlePath), false)
}))

test('unknown extension throws unless it is in the resources allowlist', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'styles.css'), '/* fake css */\n')
  writeFileSync(join(tmp, 'src', 'entry.js'),
    "require('./hello').greet('world')\nrequire('./styles.css')\n")
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test('resources allowlist attests opted-in extensions', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'styles.css'), '/* fake css */\n')
  writeFileSync(join(tmp, 'src', 'entry.js'),
    "require('./hello').greet('world')\nrequire('./styles.css')\n")
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['css'] }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/styles.css'].startsWith('sha512-'),
    'allowlisted resource is hash-attested')
}))

test('resources entry that is a code extension is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /resources entry 'js' is a code extension/)
}))

// ----- file-loader: binary assets copied to output (png/svg) --------------------------

test('file-loader png/svg assets throw without the resources allowlist', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES },
  })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test('file-loader png/svg assets are hash-attested and tagged with per-file resource format', withTmp((t, tmp) => {
  // Post-collapse: code and resources share one bundle, distinguished per file by
  // formats[file]: 'resource' (raw UTF-8, e.g. SVG) or 'resource:base64' (binary,
  // e.g. PNG). The asset's bytes still can't change without the lockfile noticing
  // (the security guarantee); the format tag is what disambiguates the encoding.
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
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

test('file-loader frozen run passes against the committed asset hashes', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })  // ships a committed lockfile with png/svg
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { STASIS_TEST_WEBPACK_RULES: FILE_LOADER_RULES, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')
}))

test('file-loader frozen run rejects a tampered asset', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })
  // flip a byte in the committed svg
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')

  const r = run('src/entry.js', {
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
test('regression: webpack 4 stale rrd.context.issuer does not collapse two distinct (issuer, bs58) edges', withTmp((t, tmp) => {
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

  const r = run('node_modules/example/index.js', {
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

test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const preloadBundle = join(tmp, 'preload.br')
  const sidecarBundle = join(tmp, 'sidecar.br')

  const r = run('src/entry.js', {
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
