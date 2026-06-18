// Smoke coverage for StasisWebpack against webpack 5 (aliased as `webpack5`
// in this workspace -- npm:webpack@^5.x). Mirrors the key capture-mode cases
// from tests/webpack.test.js to confirm the cross-version field-unwrap in
// stasis-core/src/webpack.js (`data.createData ?? data`) lets a single plugin
// codebase work against both webpack 4 and webpack 5 NMF shapes.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
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

const run = (entry, { cwd, env = {} }) => {
  const r = spawnSync(process.execPath, [helper, entry], { encoding: 'utf-8', cwd, env: { ...cleanEnv, ...env } })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-webpack5-'))
  try { return fn(t, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

test('webpack5 lock=add records the entry and its imports', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'full' })
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('webpack5 bundle=add writes a bundle whose sources match disk', withTmp((t, tmp) => {
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

// Bundle=load on webpack 5 exercises the plugin's #applyLoadMode path -- the
// inputFileSystem Proxy + `data.request` mutation in beforeResolve. The webpack 5
// resolver pipeline split resolveData / createData, but the request-mutation
// contract is still honored (beforeResolve runs BEFORE the resolver reads request,
// confirmed against NormalModuleFactory.js:1054). This test pins both the proxy
// interception and the mutation contract by replaying a captured bundle in a
// clean dir and demanding byte-identical webpack output.
test('webpack5 bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp((t, tmp) => {
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

  // Phase 2: a clean dir with only the bundle + a minimal package.json. No sources
  // on disk, so a working load mode is the ONLY path to a successful build.
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

  // webpack 4 and webpack 5 emit different runtime preambles, so we can't compare
  // capture-vs-replay across versions; but within webpack 5 the two outputs must
  // match -- proving the bundle-served bytes are the same as the disk-fed bytes.
  t.assert.equal(replayOutput, captureOutput)
}))

test('webpack5 bundle=load fails closed when an in-scope file is missing from the bundle', withTmp((t, tmp) => {
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
  t.assert.match(r.stderr, /hello\.js/)
}))

test('webpack5 lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // frozen mode must not rewrite the lockfile
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

// The webpack 4 stale-issuer regression (tests/webpack.test.js) is a webpack-4-only
// bug -- webpack 5's NMF redesigned the resolveData flow so contextInfo.issuer is
// fresh in afterResolve. Still worth confirming the SAME synthetic topology
// captures cleanly under webpack 5: same lockfile shape, no Conflict, edges
// attributed to the actual importers.
test('webpack5 captures the file:-dep + nested-bs58 topology with correct edge attribution', withTmp((t, tmp) => {
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

  const r = run('node_modules/example/index.js', { cwd: tmp, env: withOpts({ lock: 'add', bundle: 'none', scope: 'full' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const edges = lock.imports?.['*'] ?? {}
  t.assert.equal(edges['example/index.js']?.['bs58'], 'example/node_modules/bs58/index.js')
  t.assert.equal(edges['example/index.js']?.['base58check'], 'node_modules/base58check/index.js')
  t.assert.equal(edges['node_modules/base58check/index.js']?.['bs58'], 'node_modules/bs58/index.js')
}))
