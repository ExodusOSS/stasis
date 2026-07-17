// Watch/rebuild CAPTURE is explicitly unsupported across the bundler plugins: capture dedupes
// files by PATH, not content (each plugin's instance-level `#seen` Set, plus State.write's
// compare-and-skip caches), so a watch/dev-server rebuild where a file's bytes changed would
// skip re-capture -- the emitted output would use the new bytes while the stasis
// bundle/lockfile silently kept attesting the OLD ones. Rather than track content changes
// across rebuilds, each plugin refuses the rebuild loudly at its first signal:
//   - webpack throws from its watchRun tap, before the FIRST watch build (covered alongside
//     the write-timing cases in webpack-defer-write.test.js);
//   - esbuild fails the SECOND build start from onStart -- rebuilds re-fire onStart against
//     the same setup registrations, and an instance-level counter also catches one plugin
//     instance reused across two esbuild.build() calls (same staleness hazard);
//   - metro throws on the serializer's SECOND invocation -- a one-shot `metro build`
//     serializes once, only a dev server (`metro start`) re-invokes it per rebuild.
// Load mode is deliberately untouched: it serves immutable attested bytes back into the
// build, so rebuilds have no drift hazard there.
//
// No real bundlers here (they aren't dependencies of this repo): the esbuild plugin's setup()
// is driven with stub build hooks and the metro plugin's customSerializer is fed a minimal
// Metro-shaped graph -- the same stub approach as webpack-defer-write.test.js /
// metro-fs.test.js.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { State } from '@exodus/stasis-core/state'
import { StasisEsbuild } from '@exodus/stasis-plugins/esbuild'
import { StasisMetro } from '@exodus/stasis-plugins/metro'

// Run `mk` chdir'd into a throwaway project dir (resolvePluginState anchors standalone plugin
// States at process.cwd(), like webpack-defer-write.test.js's withPlugin), restore cwd, and
// clean the dir up after the test. lock='none' + bundle='add' is the valid preload-less
// capture config the plugins are constructed with below.
const inProjectDir = (t, mk) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-rebuild-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  const cwd = process.cwd()
  process.chdir(dir)
  let made
  try {
    made = mk(dir)
  } finally {
    process.chdir(cwd)
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return made
}

// Drive StasisEsbuild.setup() with stub build hooks, collecting the registered callbacks by
// kind -- what esbuild's plugin runner does once per build/context creation. A rebuild does NOT
// re-run setup(); it re-fires the collected onStart/onEnd callbacks, which the tests below do
// by hand.
const setupStub = (plugin) => {
  const cbs = { onStart: [], onEnd: [], onResolve: [], onLoad: [] }
  plugin.setup({
    onStart: (fn) => cbs.onStart.push(fn),
    onEnd: (fn) => cbs.onEnd.push(fn),
    onResolve: (_filter, fn) => cbs.onResolve.push(fn),
    onLoad: (_filter, fn) => cbs.onLoad.push(fn),
    resolve: async () => ({ errors: [], warnings: [] }),
  })
  return cbs
}

const fireStarts = (cbs) => cbs.onStart.map((fn) => fn()).find((r) => r !== undefined)

test('esbuild: the second build start is refused in capture mode (watch/rebuild)', (t) => {
  const plugin = inProjectDir(t, (dir) =>
    new StasisEsbuild({ lock: 'none', bundle: 'add', bundleFile: join(dir, 'sources.br') }))
  const cbs = setupStub(plugin)
  t.assert.equal(cbs.onStart.length, 1, 'capture registers the rebuild guard')

  t.assert.equal(fireStarts(cbs), undefined, 'the first build start proceeds')
  // esbuild fails a build when a plugin's onStart returns errors -- the refusal fires before
  // the rebuild can (not) re-capture anything, and onEnd's clean-build gate then skips write().
  const refused = fireStarts(cbs)
  t.assert.equal(refused.errors.length, 1)
  t.assert.match(refused.errors[0].text,
    /StasisEsbuild: watch\/rebuild is not supported for capture -- run a one-shot build/)
})

test('esbuild: a fresh setup() on the same instance still refuses (instance reuse across builds)', (t) => {
  // Two esbuild.build() calls sharing ONE plugin instance each run setup() afresh, so a
  // per-setup counter would reset and miss the hazard; the counter must live on the instance.
  const plugin = inProjectDir(t, (dir) =>
    new StasisEsbuild({ lock: 'none', bundle: 'add', bundleFile: join(dir, 'sources.br') }))
  t.assert.equal(fireStarts(setupStub(plugin)), undefined, 'first build() proceeds')
  const refused = fireStarts(setupStub(plugin))
  t.assert.match(refused.errors[0].text, /StasisEsbuild: watch\/rebuild is not supported for capture/)
})

test('esbuild: load mode registers no rebuild guard', (t) => {
  // Load serves immutable attested bytes (getFile re-verifies hashes on every read), so
  // rebuilds have no drift hazard and must stay permitted -- no onStart is registered at all.
  const plugin = inProjectDir(t, (dir) => {
    const bundleFile = join(dir, 'sources.br')
    // Mint an (empty) bundle to load: a capture State's write() emits it.
    new State(dir, { lock: 'none', bundle: 'add', bundleFile }).write()
    // The plugin accepts a caller-owned State directly (the `stasis build` path).
    return new StasisEsbuild(new State(dir, { lock: 'none', bundle: 'load', bundleFile }))
  })
  const cbs = setupStub(plugin)
  t.assert.equal(cbs.onStart.length, 0, 'load mode must not refuse rebuilds')
  t.assert.ok(cbs.onResolve.length > 0, 'sanity: the plugin did register its load-mode hooks')
})

test('metro: the second serialization is refused in capture mode (dev-server rebuild)', (t) => {
  let baseCalls = 0
  const serialize = inProjectDir(t, (dir) => {
    // childProcess mirrors `stasis run --child-process`, which StasisMetro requires for any
    // capture-that-writes (Metro transforms in worker processes; see the constructor assert).
    const plugin = new StasisMetro({
      lock: 'none', bundle: 'add', bundleFile: join(dir, 'sources.br'), childProcess: true,
    })
    return plugin.customSerializer(() => { baseCalls += 1; return '// bundle output' })
  })
  // The minimal Metro ReadOnlyGraph shape the plugin reads: `dependencies` (Map<absPath,
  // Module>) and `entryPoints` (Set<absPath>) -- both empty here, capture itself is not the
  // point. preModules: none (like the experimental-hook path).
  const graph = { dependencies: new Map(), entryPoints: new Set() }

  t.assert.equal(serialize('/app/entry.js', [], graph, {}), '// bundle output',
    'the one-shot build serializes through the base serializer')
  t.assert.throws(
    () => serialize('/app/entry.js', [], graph, {}),
    /StasisMetro: watch\/dev-server rebuilds are not supported for capture -- use a one-shot `metro build`/,
    'a dev-server re-invocation must throw'
  )
  t.assert.equal(baseCalls, 1, 'the refusal fires before the base serializer produces output')
})
