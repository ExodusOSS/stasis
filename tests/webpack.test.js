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
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
