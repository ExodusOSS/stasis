import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { State, resolvePluginState } from '@exodus/stasis-core/state'

// Shared preload for all tests in this file. The preload registry is process-wide and
// can't be reset, so we build a single parent up front and exercise sidecar/resolver
// behavior against it. Each test uses its own bundleFile path to avoid interference.

const dir = mkdtempSync(join(tmpdir(), 'stasis-sidecar-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')

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
  // hashes already populated by the previous test via shared maps; that's fine for write
  parent.write()  // owns the lockfile
  sidecar.write()  // owns its bundle only

  t.assert.ok(existsSync(parentBundle), 'parent bundle written')
  t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle written')
  t.assert.ok(existsSync(join(dir, 'stasis.lock.json')), 'lockfile written by parent')

  const pb = JSON.parse(brotliDecompressSync(readFileSync(parentBundle)))
  t.assert.equal(pb.sources['.'].files['a.js'], 'export const a = 1\n')
  // sidecar's t3 sources are empty (this test didn't add any) but the file still exists
  const sb = JSON.parse(brotliDecompressSync(readFileSync(sidecarBundle)))
  t.assert.deepEqual(sb.sources, {}, 'sidecar without addFile writes an empty sources bucket')
})

test('sidecar rejects same bundleFile as parent', (t) => {
  t.assert.throws(
    () => new State(dir, { parent, lock: 'add', bundle: 'add', bundleFile: parentBundle }),
    /sidecar bundleFile must differ from parent bundleFile/
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
