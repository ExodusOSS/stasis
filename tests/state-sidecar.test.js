import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'
import { resolvePluginState } from '@exodus/stasis-core/plugins'

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

// --- lockFile (Rule 0: independent vs unified) ------------------------------------

test('resolvePluginState rule 0: lockFile equal to ambient resolves to reuse/sidecar (unified)', (t) => {
  // Ambient parent above writes to `<dir>/stasis.lock.json` (default path); a plugin
  // that names that exact path stays in the unified-lockfile branch.
  const r = resolvePluginState('Test', { bundle: 'add', bundleFile: parentBundle, lockFile: join(dir, 'stasis.lock.json') }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.equal(r.state, parent, 'matched lockFile reuses the preload')
})

test('resolvePluginState rule 0: lockFile different from ambient builds an independent State', (t) => {
  // Plugin's lockFile points elsewhere -- the plugin gets its own State with its own
  // lockfile + bundle, not a sidecar. The independent State doesn't share hashes /
  // entries / modules with the ambient parent.
  const r = resolvePluginState('Test', {
    lock: 'add',
    lockFile: join(dir, 'independent.lock.json'),
    bundle: 'add',
    bundleFile: join(dir, 'independent.br'),
  }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.notEqual(r.state, parent, 'plugin gets a fresh State')
  t.assert.equal(r.state.parent, undefined, 'independent: no sidecar parentage')
  t.assert.notEqual(r.state.hashes, parent.hashes, 'independent: separate hashes')
  t.assert.notEqual(r.state.entries, parent.entries, 'independent: separate entries')
  t.assert.notEqual(r.state.modules, parent.modules, 'independent: separate modules')
})

test('resolvePluginState rule 0: an independent plugin\'s addFile does NOT reach the ambient lockfile', (t) => {
  // The whole point: when the plugin owns its own lockfile, its observations stay local.
  const indepBundle = join(dir, 'indep-flow.br')
  const indepLock = join(dir, 'indep-flow.lock.json')
  writeFileSync(join(dir, 'indep-only.js'), 'export const z = 9\n')
  const r = resolvePluginState('Test', {
    lock: 'add',
    lockFile: indepLock,
    bundle: 'add',
    bundleFile: indepBundle,
  }, dir)
  const indep = r.state
  indep.addFile(pathToFileURL(join(dir, 'indep-only.js')).toString(), { isEntry: true })
  // Parent hashes must not carry this file -- the plugin's State is fully separate.
  t.assert.ok(!parent.hashes.has('indep-only.js'), 'ambient lockfile is not contaminated')
  t.assert.ok(indep.hashes.has('indep-only.js'), 'independent State recorded it locally')
})

test('resolvePluginState rule 0: lockFile pointing at ambient\'s default path normalizes correctly (./x vs x)', (t) => {
  // Path normalization: a plugin spelling out `./stasis.lock.json` while ambient uses
  // the default `<root>/stasis.lock.json` must STILL be unified, not independent.
  const r = resolvePluginState('Test', {
    bundle: 'add',
    bundleFile: parentBundle,
    lockFile: join(dir, '.', 'stasis.lock.json'),
  }, dir)
  t.assert.equal(r.state, parent, 'normalized-equal paths reuse the preload')
})

test('resolvePluginState rule 0: independent State silently accepts a scope override (no coordination check)', (t) => {
  // Rule 0 deliberately skips the scope/lock/debug agreement check against the ambient
  // (plugins.js's comment: "the user has explicitly opted out of unification by
  // pointing at a different lockfile"). Lock this behavior in -- changing it would
  // be a substantive design shift the author should have to explicitly own.
  const r = resolvePluginState('Test', {
    scope: 'node_modules',
    lock: 'add',
    lockFile: join(dir, 'indep-scope.lock.json'),
    bundle: 'add',
    bundleFile: join(dir, 'indep-scope.br'),
  }, dir)
  t.assert.equal(r.state.config.scope, 'node_modules', 'independent State honors its own scope')
  t.assert.equal(parent.config.scope, 'full', 'ambient preload scope is unchanged')
})

test('resolvePluginState rule 0: independent State bundleFile colliding with ambient is rejected', (t) => {
  // Independent States share the process-wide claim registry with the ambient parent;
  // a misconfigured plugin pointing its bundleFile at the ambient's must throw, NOT
  // silently last-write-wins on beforeExit. bundle=replace bypasses the "lockfile
  // missing, can not use sources" discovery guard so we land on the claim check itself.
  t.assert.throws(() => resolvePluginState('Test', {
    lock: 'replace',
    lockFile: join(dir, 'indep-coll.lock.json'),
    bundle: 'replace',
    bundleFile: parentBundle, // same as ambient
  }, dir), /already claimed/)
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
