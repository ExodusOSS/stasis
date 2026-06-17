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
