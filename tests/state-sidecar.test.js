import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'
// resolvePluginState is internal plugin<->preload coordination, not a public export;
// import the source directly (same pattern as fs.js in the fs tests).
import { resolvePluginState } from '../stasis-plugins/src/plugins.js'

// Shared preload for all tests in this file. The preload registry is process-wide and
// can't be reset, so we build a single parent up front and exercise sidecar/resolver
// behavior against it. Each test uses its own bundleFile path to avoid interference.

const dir = mkdtempSync(join(tmpdir(), 'stasis-sidecar-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')
writeFileSync(join(dir, 'c.js'), 'export const c = 3\n')

const parentBundle = join(dir, 'parent.br')
const parent = new State(dir, {
  preload: true,
  lock: 'add',
  bundle: 'add',
  bundleFile: parentBundle,
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

test('sidecar shares hashes/entries/modules with parent; sources are independent', (t) => {
  const sidecar = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'add',
    bundleFile: join(dir, 't1.br'),
  })
  t.assert.equal(sidecar.hashes, parent.hashes)
  t.assert.equal(sidecar.entries, parent.entries)
  t.assert.equal(sidecar.modules, parent.modules)
  t.assert.notEqual(sidecar.sources, parent.sources)
  t.assert.notEqual(sidecar.imports, parent.imports)
  t.assert.equal(sidecar.parent, parent)
})

test('a child (sidecar) State must exactly match its parent version', (t) => {
  // A sidecar shares the parent's maps by reference and reads its private fields, so a
  // version skew between two @exodus/stasis-core copies in one process is rejected up
  // front -- the version assert is the first thing the parent branch does, so a fake
  // parent carrying a mismatched `version` trips it before any other field is touched.
  const fakeParent = { version: '0.0.0-mismatch' }
  t.assert.throws(
    () => new State(dir, { parent: fakeParent, lock: 'add', bundle: 'add', bundleFile: join(dir, 'ver-mismatch.br') }),
    /must exactly match parent version/
  )
  // A same-version parent is accepted regardless of WHICH stasis-core copy it came from
  // (the cross-copy bundled scenario) -- the same-copy case is exercised by every sidecar
  // test in this file, and the cross-copy case by tests/state-singleton-multi-copy.test.js.
})

test('sidecar addFile flows hashes/entries through shared maps, sources stay local', (t) => {
  const sidecar = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'add',
    bundleFile: join(dir, 't2.br'),
  })
  parent.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { isEntry: true })
  sidecar.addFile(pathToFileURL(join(dir, 'b.js')).toString(), { isEntry: true })

  t.assert.ok(parent.hashes.has('a.js'))
  t.assert.ok(parent.hashes.has('b.js'), 'sidecar addFile must populate the shared hashes map')
  t.assert.ok(parent.entries.has('a.js'))
  t.assert.ok(parent.entries.has('b.js'))

  t.assert.ok(parent.sources.has('a.js'))
  t.assert.equal(parent.sources.has('b.js'), false, "sidecar source mustn't leak into parent")
  t.assert.ok(sidecar.sources.has('b.js'))
  t.assert.equal(sidecar.sources.has('a.js'), false, "parent source mustn't leak into sidecar")
})

test('sidecar write() emits the bundle but not the lockfile', (t) => {
  const sidecarBundle = join(dir, 't3.br')
  const sidecar = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'add',
    bundleFile: sidecarBundle,
  })
  parent.write()  // owns the lockfile
  sidecar.write()  // owns its bundle only

  t.assert.ok(existsSync(parentBundle), 'parent bundle written')
  t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle written')
  t.assert.ok(existsSync(join(dir, 'stasis.lock.json')), 'lockfile written by parent')

  const pb = JSON.parse(brotliDecompressSync(readFileSync(parentBundle)))
  t.assert.equal(pb.sources['.'].files['a.js'], 'export const a = 1\n')
  const sb = JSON.parse(brotliDecompressSync(readFileSync(sidecarBundle)))
  t.assert.deepEqual(sb.sources, {}, 'sidecar without addFile writes an empty sources bucket')
})

test('sidecar rejects same bundleFile as parent', (t) => {
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: parentBundle }),
    /already claimed/
  )
})

test('sidecar rejects same bundleFile as an earlier sibling sidecar', (t) => {
  // Two sidecars of the same parent must not silently target the same on-disk
  // file -- both write()s would fire, last-write-wins, and the loser's metadata
  // would silently disappear.
  const shared = join(dir, 'sib.br')
  // eslint-disable-next-line no-new
  new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: shared })
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: shared }),
    /already claimed/
  )
})

test('sidecar resourcesBundleFile collides with an earlier sidecar', (t) => {
  // Sidecars in split-bundle mode claim resourcesBundleFile alongside bundleFile via
  // the process-wide registry. A second sidecar (or any other live State) targeting
  // the same resources path is a last-write-wins bug, same as bundleFile.
  const sharedRes = join(dir, 'shared-res.br')
  // eslint-disable-next-line no-new
  new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, 's1.br'), resourcesBundleFile: sharedRes })
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, 's2.br'), resourcesBundleFile: sharedRes }),
    /already claimed/
  )
})

test('sidecar bundleFile collides with an earlier sibling resourcesBundleFile (cross-kind)', (t) => {
  // The claim registry is single-namespace: bundleFile and resourcesBundleFile share
  // the same key space. A sibling that names another sidecar's resources path as ITS
  // bundleFile (or vice versa) must collide too.
  const shared = join(dir, 'cross-kind.br')
  // eslint-disable-next-line no-new
  new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, 'cx1.br'), resourcesBundleFile: shared })
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: shared }),
    /already claimed/
  )
})

test('sidecar bundleFile equality is path-normalized (./x vs x)', (t) => {
  // './foo.br' and 'foo.br' resolve to the same absolute path; the claim
  // registry must treat them as the same file.
  // eslint-disable-next-line no-new
  new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, 'norm.br') })
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, '.', 'norm.br') }),
    /already claimed/
  )
})

test('sidecar addImport / addFile formats flow to the parent-owned lockfile', (t) => {
  // Sidecar's imports / formats maps are sidecar-local (so its bundle output
  // reflects only what the sidecar saw). The unified lockfile must still cover
  // them -- otherwise a `lock=frozen` re-run would treat the bundler-plugin's
  // edges as unattested. parent.lockData unions sidecars' imports / formats.
  const lockFile = join(dir, 'unified.lock.json')
  const side = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'add',
    bundleFile: join(dir, 'flow-test.br'),
  })
  // Sidecar records an edge ('./c.js' from a.js -> c.js) the parent never
  // observed directly. Parent's lockfile should include it after this call.
  // (Uses c.js -- a fresh file -- so the format the sidecar attests doesn't
  // collide with what an earlier test recorded for b.js.)
  parent.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { isEntry: true })
  side.addFile(pathToFileURL(join(dir, 'c.js')).toString())
  side.addImport(pathToFileURL(join(dir, 'a.js')).toString(), './c.js', pathToFileURL(join(dir, 'c.js')).toString())

  writeFileSync(lockFile, parent.lockData)
  const lock = JSON.parse(readFileSync(lockFile, 'utf-8'))
  // The edge sidecar.addImport recorded must be in the parent's lockfile.
  t.assert.equal(lock.imports?.['*']?.['a.js']?.['./c.js'], 'c.js',
    'sidecar.addImport must reach parent.lockData')
  // The format sidecar.addFile recorded must be in the parent's lockfile.
  // c.js has no package.json `type` override in the fixture, so addFile infers
  // commonjs (the legacy default when the nearest package.json is type-less).
  t.assert.equal(lock.formats?.['c.js'], 'commonjs',
    'sidecar.addFile format must reach parent.lockData')
})

test('sidecar no-format addFile defers to the module format the parent already recorded', (t) => {
  // A bundler sidecar's afterResolve passes no format. For a type-less .js the
  // legacy default is commonjs -- but the runtime loader records Node's
  // authoritative `module` into the PARENT (sidecars share the parent's
  // lockfile, and the loader records there). The sidecar capture must keep
  // `module`, not re-default to commonjs and then collide when the parent merges
  // sidecar formats into the unified lockfile (#mergedFormats). Built against a
  // fresh, isolated parent so the assertion on the merged lockfile is unaffected
  // by state the shared module-level preload accumulates across tests.
  const isoDir = mkdtempSync(join(tmpdir(), 'stasis-sidecar-iso-'))
  t.after(() => rmSync(isoDir, { recursive: true, force: true }))
  writeFileSync(join(isoDir, 'package.json'), JSON.stringify({ name: 'iso', version: '0.0.0' }))
  writeFileSync(join(isoDir, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(isoDir, 'app.js'), 'export const app = 1\n')

  const isoParent = new State(isoDir, { lock: 'add', bundle: 'add', bundleFile: join(isoDir, 'iso-parent.br') })
  const url = pathToFileURL(join(isoDir, 'app.js')).toString()
  isoParent.addFile(url, { format: 'module' }) // loader observed ESM, recorded on the parent

  const side = new State(isoDir, { parent: isoParent, lock: 'add', bundle: 'add', bundleFile: join(isoDir, 'iso-side.br') })
  t.assert.doesNotThrow(() => side.addFile(url)) // sidecar no-format (webpack-style) capture
  t.assert.equal(side.formats.get('app.js'), 'module', 'sidecar keeps the parent-attested module format')
  // The unified lockfile unions parent + sidecar formats; with the fix both say
  // module, so the merge is conflict-free and attests module.
  t.assert.doesNotThrow(() => isoParent.lockData)
  t.assert.equal(JSON.parse(isoParent.lockData).formats?.['app.js'], 'module')
})

test('sidecar in read-only mode (load / frozen) does NOT claim a bundleFile slot', (t) => {
  // A frozen / load sidecar reads a file the writer produced; it must be legal
  // to point at the same path the writer claimed. Otherwise round-trip patterns
  // (write a bundle, re-open it under frozen mode) would be impossible.
  const path = join(dir, 'rt-claim.br')
  const writer = new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: path })
  writer.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { isEntry: true })
  writer.write()
  t.assert.doesNotThrow(
    () => new State(dir, { parent, lock: 'add', bundle: 'frozen', bundleFile: path })
  )
})

test('sidecar requires bundleFile', (t) => {
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add' }),
    /sidecar State requires bundleFile/
  )
})

test('resolvePluginState rule 5: same bundleFile reuses the preload', (t) => {
  const r = resolvePluginState('Test', { bundle: 'add', bundleFile: parentBundle }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.equal(r.state, parent)
})

test('resolvePluginState rule 6: different bundleFile constructs a sidecar', (t) => {
  const r = resolvePluginState('Test', { bundle: 'add', bundleFile: join(dir, 't6.br') }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.notEqual(r.state, parent)
  t.assert.equal(r.state.parent, parent)
})

test('resolvePluginState rule 2: lock mismatch with preload is rejected', (t) => {
  t.assert.throws(
    () => resolvePluginState('Test', { lock: 'frozen' }, dir),
    /lock='frozen' conflicts with active preload lock='add'/
  )
})

test('resolvePluginState rule 4: cannot disable bundle when preload has it', (t) => {
  t.assert.throws(
    () => resolvePluginState('Test', { bundle: 'none' }, dir),
    /bundle='none' conflicts with active preload bundle='add'/
  )
})

test('resolvePluginState scope mismatch with preload is rejected', (t) => {
  t.assert.throws(
    () => resolvePluginState('Test', { scope: 'node_modules' }, dir),
    /scope='node_modules' conflicts with active preload scope='full'/
  )
})

// --- lockFile is rejected: a plugin shares the ambient lockfile (no independent State) ----

test('resolvePluginState rejects a plugin lockFile option (the ambient lockfile must be shared)', (t) => {
  // Previously a divergent `lockFile` spun up an INDEPENDENT State with its own lockfile
  // (the old "Rule 0" opt-out, which did NOT share hashes/entries/modules with the
  // ambient). That escape hatch is gone: `lockFile` is no longer a plugin option, so when
  // an ambient parent exists the plugin can only reuse it or run as a sidecar -- the
  // lockfile is always shared. A non-default lockfile location is now a process-wide
  // concern (EXODUS_STASIS_LOCK_FILE), not a per-plugin one.
  t.assert.throws(
    () => resolvePluginState('Test', { bundle: 'add', bundleFile: join(dir, 'independent.br'), lockFile: join(dir, 'independent.lock.json') }, dir),
    /Unknown Test options: lockFile/
  )
  // Even a lockFile naming the ambient's own default path is rejected: the option simply
  // doesn't exist for plugins anymore (there is no "matches the ambient, so allow it").
  t.assert.throws(
    () => resolvePluginState('Test', { bundle: 'add', bundleFile: parentBundle, lockFile: join(dir, 'stasis.lock.json') }, dir),
    /Unknown Test options: lockFile/
  )
})

test('resolvePluginState with no lockFile still shares the ambient: same bundleFile reuses, different sidecars', (t) => {
  // The positive side of the invariant: without a lockFile the plugin always shares the
  // ambient. Same/unspecified bundleFile reuses the preload; a different bundleFile makes
  // a sidecar that shares the parent's hashes/entries/modules (the unified lockfile).
  const reuse = resolvePluginState('Test', { bundle: 'add', bundleFile: parentBundle }, dir)
  t.assert.equal(reuse.state, parent, 'same bundleFile reuses the shared preload')

  const sidecar = resolvePluginState('Test', { bundle: 'add', bundleFile: join(dir, 'share-side.br') }, dir).state
  t.assert.notEqual(sidecar, parent, 'different bundleFile splits off a sidecar')
  t.assert.equal(sidecar.parent, parent, 'sidecar is parented to the ambient (shared lockfile)')
  t.assert.equal(sidecar.hashes, parent.hashes, 'sidecar shares the parent hashes')
  t.assert.equal(sidecar.entries, parent.entries, 'sidecar shares the parent entries')
  t.assert.equal(sidecar.modules, parent.modules, 'sidecar shares the parent modules')
})

// Forge a v0-shaped bundle (legacy flat layout, version: 0). The sidecar's load /
// add / frozen paths must refuse it the same way the main path does -- v0 has no
// per-file formats and no import map, so silently trusting it would widen the
// attestation surface.
const v0Path = join(dir, 'v0.br')
writeFileSync(v0Path, brotliCompressSync(JSON.stringify({
  version: 0,
  config: { scope: 'full' },
  sources: { '.': { name: 'fx', version: '0.0.0', files: { 'a.js': 'export const a = 1\n' } } },
  formats: {},
  imports: {},
})))

test('sidecar refuses a v0 bundle (bundle=add)', (t) => {
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: v0Path }),
    /stasis sidecar requires a v1 bundle/
  )
})

test('sidecar refuses a v0 bundle (bundle=load)', (t) => {
  // bundle=load requires lock=frozen/none/ignore (Config invariant), so pair with frozen.
  t.assert.throws(
    () => new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: v0Path }),
    /stasis sidecar requires a v1 bundle/
  )
})

test('sidecar bundle=frozen without a bundle file on disk fails closed', (t) => {
  // A frozen sidecar must have loaded its attestation -- otherwise every
  // addFile/addImport gate is a silent no-op. The post-construction invariant
  // mirrors the main path's frozenBundle check.
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'frozen', bundleFile: join(dir, 'missing.br') }),
    /No bundle, but attempting to run in frozen bundle mode/
  )
})

test('sidecar bundle=frozen with a v1 bundle wires up the frozen-attestation snapshot', (t) => {
  // Round-trip: write a sidecar bundle via the add path, then re-open it under
  // frozen mode. The post-construction frozenBundle invariant must pass, which
  // implies the inner gate at line 102 includes frozenBundle.
  const bundlePath = join(dir, 'frozen-rt.br')
  const writer = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'add',
    bundleFile: bundlePath,
  })
  writer.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { isEntry: true })
  writer.write()
  t.assert.ok(existsSync(bundlePath))

  const frozen = new State(dir, {
    parent,
    lock: 'add',
    bundle: 'frozen',
    bundleFile: bundlePath,
  })
  // The snapshot the frozenBundle invariant asserts on is private; we observe it
  // indirectly by confirming that addFile of an unattested file is rejected, and
  // that addFile of the attested file passes the membership check.
  // The frozen-bundle membership check fires from state.js's
  // `assert.ok(attested?.has(file), ...)` with this exact message wording.
  t.assert.throws(
    () => frozen.addFile(pathToFileURL(join(dir, 'b.js')).toString(), { isEntry: true }),
    /File not attested by the frozen bundle: b\.js/
  )
})

test('sidecar bundle=add preserves a loaded multi-consumer `reason` on reload', (t) => {
  // Regression: a bundler plugin (StasisMetro/StasisWebpack/...) that writes its OWN bundleFile
  // runs as a write-mode SIDECAR. The sidecar constructor's inlined bundle-absorb is a twin of
  // the main path's #absorbCodeBundle -- and, like it once did, it used to ignore the loaded
  // `reason`, so a bundle=add re-run rebuilt the map from this run's observations alone and
  // dropped every other consumer's attribution. The sidecar path must seed `reason` too.
  //
  // Files unique to this test (the module-level `parent` accumulates hashes/entries across
  // tests). Round 1 builds the multi-consumer bundle bytes via a writer sidecar on a THROWAWAY
  // path (its write-path claim is process-wide and never released, so the reload sidecar below
  // must claim a different path) and writes them to loadPath by hand.
  for (const [f, body] of [['r1.js', 'export const r1 = 1\n'], ['r2.js', 'export const r2 = 2\n'], ['r3.js', 'export const r3 = 3\n']]) {
    writeFileSync(join(dir, f), body)
  }
  const url = (f) => pathToFileURL(join(dir, f)).toString()
  const loadPath = join(dir, 'reason-rt-load.br')

  const gen = new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: join(dir, 'reason-rt-gen.br') })
  gen.addFile(url('r1.js'), { isEntry: true })                       // run (default)
  gen.addFile(url('r2.js'), { reason: 'StasisMetro' })               // a plugin bundles it
  t.assert.deepEqual(JSON.parse(gen.sourceData).reason, { StasisMetro: ['r2.js'], run: ['r1.js'] })
  writeFileSync(loadPath, brotliCompressSync(gen.sourceData))

  // Reload under bundle=add through a fresh write-mode sidecar and re-observe the plugin's files
  // (only ever 'StasisMetro' this run) plus a new one -- exactly what a plugin re-run does.
  const reload = new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: loadPath })
  reload.addFile(url('r2.js'), { reason: 'StasisMetro' })            // re-bundled by the plugin
  reload.addFile(url('r3.js'), { reason: 'StasisMetro' })            // newly bundled this run

  // The loaded 'run' attribution survives even though this run never recorded 'run'; the new
  // 'StasisMetro' file is unioned onto the loaded one. Nothing is destroyed.
  t.assert.deepEqual(JSON.parse(reload.sourceData).reason,
    { StasisMetro: ['r2.js', 'r3.js'], run: ['r1.js'] })
})
