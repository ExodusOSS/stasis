// End-to-end coverage for the StasisMetroResolver (the RESOLUTION half of load mode).
//
// Metro isn't a dependency, and the resolver never imports it -- it implements the
// `resolver.resolveRequest(context, moduleName, platform)` contract Metro's module
// resolution calls, with `context.resolveRequest` carrying the default-resolver
// delegate. So these tests spawn the resolver helper (cwd = a fixture project root)
// with a recording delegate and assert which requests are served from the bundle's
// recorded edges and which defer -- against real artifacts: bundles captured via the
// StasisMetro serializer helper (the runtime-capture shape) and a real
// `stasis bundle --metro --platforms=...` artifact (the per-platform edge shape).

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const captureHelper = join(here, 'metro-run.helper.js')
const resolverHelper = join(here, 'metro-resolver-run.helper.js')
const fullFixture = join(here, 'fixtures', 'metro-full')
const nmFixture = join(here, 'fixtures', 'metro-nm')
const fieldsFixture = join(here, 'fixtures', 'resolve-fields')

const FULL_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] },
    { path: 'src/hello.js', deps: [] },
  ],
}

// Strip ALL inherited stasis env by prefix so a developer's exported EXODUS_STASIS_*
// can't leak into the spawned children and skew results (same as the sibling suites).
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('EXODUS_STASIS_') && !k.startsWith('STASIS_TEST_'))
)

// Capture a bundle via the StasisMetro serializer path (writes lockfile + bundle). The
// serializer asserts child-process capture on a writing run, so enable it; the resolver
// side below is unaffected (load mode captures nothing).
const capture = (entry, { cwd, graph, env }) => {
  const r = spawnSync(process.execPath, [captureHelper, entry], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, EXODUS_STASIS_CHILD_PROCESS: '1', STASIS_TEST_METRO_GRAPH: JSON.stringify(graph), ...env },
  })
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// Drive the resolver over a list of {origin, moduleName, platform} requests; returns
// the helper's parsed JSON output alongside the raw spawn result.
const resolveAll = (requests, { cwd, env = {} }) => {
  const r = spawnSync(process.execPath, [resolverHelper, JSON.stringify(requests)], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, ...env },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const runCli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// mkdtemp can hand back a symlinked path (macOS /var -> /private/var) while the spawned
// helper resolves everything against its real cwd -- compare against the real path.
const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-resolver-'))
  try {
    return fn(t, realpathSync(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const LOAD_ENV = (bundle) => ({
  EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
  EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full',
})

test('load mode serves recorded edges -- even with the target gone from disk -- and defers unrecorded ones', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // Remove the target: Metro's own probing could never find it, but the recorded edge
  // answers regardless of disk -- resolution comes from the bundle, not from probing.
  rmSync(join(tmp, 'src', 'hello.js'))

  const r = resolveAll([
    { origin: 'src/entry.js', moduleName: './hello.js', platform: 'ios' },
    { origin: 'src/entry.js', moduleName: 'left-pad', platform: 'ios' }, // never recorded
  ], { cwd: tmp, env: LOAD_ENV(bundle) })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [hit, miss] = JSON.parse(r.stdout)
  t.assert.deepEqual(hit, { served: { type: 'sourceFile', filePath: join(tmp, 'src', 'hello.js') } })
  // The miss deferred to the delegate with the arguments untouched.
  t.assert.deepEqual(miss.deferred, { origin: join(tmp, 'src', 'entry.js'), moduleName: 'left-pad', platform: 'ios' })
  t.assert.deepEqual(miss.result, { type: 'sourceFile', filePath: '<fallback>' })
}))

test('an out-of-root origin defers untouched', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  const r = resolveAll([
    { origin: '../elsewhere/entry.js', moduleName: './hello.js' },
  ], { cwd: tmp, env: LOAD_ENV(bundle) })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.equal(out.deferred.moduleName, './hello.js')
}))

test('node_modules scope serves dependency origins and defers workspace origins', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // Give the dependency an internal edge so the serving side of the scope gate is
  // observable: index.js -> ./util.js lives entirely inside node_modules.
  writeFileSync(join(tmp, 'node_modules', 'fake-esm-pkg', 'util.js'), 'export const u = 1\n')
  const bundle = join(tmp, 'snapshot.br')
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['fake-esm-pkg', 'node_modules/fake-esm-pkg/index.js'], ['./helper.js', 'src/helper.js']] },
        { path: 'src/helper.js', deps: [] },
        { path: 'node_modules/fake-esm-pkg/index.js', deps: [['./util.js', 'node_modules/fake-esm-pkg/util.js']] },
        { path: 'node_modules/fake-esm-pkg/util.js', deps: [] },
      ],
    },
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  const r = resolveAll([
    { origin: 'node_modules/fake-esm-pkg/index.js', moduleName: './util.js' },
    // Workspace origins resolve through Metro against disk in node_modules scope --
    // mirrors the loader's resolve-hook gate -- even for an edge the graph had.
    { origin: 'src/entry.js', moduleName: 'fake-esm-pkg' },
  ], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
      EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules',
    },
  })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [dep, workspace] = JSON.parse(r.stdout)
  t.assert.deepEqual(dep, { served: { type: 'sourceFile', filePath: join(tmp, 'node_modules', 'fake-esm-pkg', 'util.js') } })
  t.assert.equal(workspace.deferred.moduleName, 'fake-esm-pkg')
}))

test('resolver is a transparent pass-through when not in load mode', withTmp((t, tmp) => {
  // Committed fixture has scope=full config + a lockfile but bundle=none -> not load
  // mode, so every request must defer to the delegate untouched (safe permanent wiring).
  cpSync(fullFixture, tmp, { recursive: true })
  const r = resolveAll([
    { origin: 'src/entry.js', moduleName: './hello.js' },
  ], { cwd: tmp, env: {} })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.deepEqual(out.deferred, { origin: join(tmp, 'src', 'entry.js'), moduleName: './hello.js', platform: null })
}))

test('a --metro multi-platform artifact serves per-platform edges by the platform Metro passes', withTmp((t, tmp) => {
  cpSync(fieldsFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'metro.br')
  const b = runCli(['bundle', '--metro', '--platforms=ios,android', `--output=${bundle}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(b.status, 0, `bundle stderr: ${b.stderr}`)

  const env = {
    EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
    EXODUS_STASIS_LOCK: 'none', EXODUS_STASIS_SCOPE: 'full',
  }
  const r = resolveAll([
    { origin: 'src/entry.js', moduleName: './Button', platform: 'ios' },
    { origin: 'src/entry.js', moduleName: './Button', platform: 'android' },
    { origin: 'src/entry.js', moduleName: './Button', platform: 'web' }, // not in the map
    { origin: 'src/entry.js', moduleName: './Button' }, // platform null (no context)
    { origin: 'src/entry.js', moduleName: 'exportswins', platform: 'ios' }, // flat edge
    // A browser/react-native `false` redirect: the reserved empty-module edge is
    // translated to Metro's native empty resolution, never a disk path.
    { origin: 'node_modules/redir/index.js', moduleName: './gone.js', platform: 'ios' },
  ], { cwd: tmp, env })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [ios, android, web, noPlatform, flat, empty] = JSON.parse(r.stdout)
  t.assert.deepEqual(ios, { served: { type: 'sourceFile', filePath: join(tmp, 'src', 'Button.ios.js') } })
  t.assert.deepEqual(android, { served: { type: 'sourceFile', filePath: join(tmp, 'src', 'Button.android.js') } })
  // A platform the map doesn't carry, and no platform at all, defer -- never guess.
  t.assert.equal(web.deferred.platform, 'web')
  t.assert.equal(noPlatform.deferred.platform, null)
  t.assert.deepEqual(flat, { served: { type: 'sourceFile', filePath: join(tmp, 'node_modules', 'exportswins', 'rn.js') } })
  t.assert.deepEqual(empty, { served: { type: 'empty' } })
}))

test('createResolveRequest(base) defers misses to the base, not context.resolveRequest', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // The helper wires the recording delegate as `base` and poisons context.resolveRequest;
  // a hit must not call either, a miss must reach the base (poison would throw).
  const r = resolveAll([
    { origin: 'src/entry.js', moduleName: './hello.js' },
    { origin: 'src/entry.js', moduleName: 'left-pad' },
  ], { cwd: tmp, env: { ...LOAD_ENV(bundle), STASIS_TEST_COMPOSE_BASE: '1' } })
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [hit, miss] = JSON.parse(r.stdout)
  t.assert.deepEqual(hit, { served: { type: 'sourceFile', filePath: join(tmp, 'src', 'hello.js') } })
  t.assert.equal(miss.deferred.moduleName, 'left-pad')
}))

test('a deferral with no delegate at all fails with the contract error, not a bare crash', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const r = resolveAll([
    { origin: 'src/entry.js', moduleName: './hello.js' },
  ], { cwd: tmp, env: { STASIS_TEST_NO_FALLBACK: '1' } }) // non-load mode -> always defers
  t.assert.equal(r.status, 0, `resolver stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.match(out.error, /context\.resolveRequest is not a function/)
}))
