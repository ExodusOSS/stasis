import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { addCommand } from '@exodus/stasis-core/add'
import { findPackageMetadata } from '@exodus/stasis-core/bundle-util'

// A package defined in the local workspace (outside node_modules) may omit `version` -- private/
// unpublished packages commonly do. Its bucket carries `name` alone, and every artifact round-trip
// (lockfile, bundle, absorb-on-reload) must preserve that instead of crashing or fabricating one.

const withTmp = (label, fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), `stasis-noversion-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }))
  mkdirSync(join(dir, 'pkg'))
  writeFileSync(join(dir, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg-noversion', private: true }))
  writeFileSync(join(dir, 'pkg', 'index.js'), 'export const b = 2\n')
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  return fn(t, dir)
}

const capture = (dir) => {
  const st = new State(dir, { lock: 'add', bundle: 'add' })
  st.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { isEntry: true })
  st.addFile(pathToFileURL(join(dir, 'pkg', 'index.js')).toString())
  st.write()
  return st
}

test('write round-trips a version-less workspace bucket through the lockfile', withTmp('lock', (t, dir) => {
  capture(dir)

  const raw = JSON.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf-8'))
  t.assert.equal(raw.sources?.pkg?.name, 'pkg-noversion')
  t.assert.ok(!('version' in raw.sources.pkg), 'omitted version must not be serialized')
  t.assert.ok(raw.sources.pkg.files['index.js'])

  const lockfile = Lockfile.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf-8'))
  const m = lockfile.modules.get('pkg')
  t.assert.equal(m.name, 'pkg-noversion')
  t.assert.equal(m.version, undefined)
}))

test('write round-trips a version-less workspace bucket through the bundle', withTmp('bundle', (t, dir) => {
  capture(dir)

  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(join(dir, 'stasis.code.br'))).toString('utf-8'))
  const m = bundle.modules.get('pkg')
  t.assert.equal(m.name, 'pkg-noversion')
  t.assert.equal(m.version, undefined)
  t.assert.equal(bundle.sources.get('pkg/index.js'), 'export const b = 2\n')
}))

test('a frozen reload absorbs and re-verifies the version-less bucket', withTmp('frozen', (t, dir) => {
  capture(dir)

  const st = new State(dir, { lock: 'frozen', bundle: 'load' })
  const seeded = st.modules.get('pkg')
  t.assert.equal(seeded.name, 'pkg-noversion')
  t.assert.equal(seeded.version, undefined)
  // Re-observing the file cross-checks the disk-derived identity against the absorbed one.
  st.addFile(pathToFileURL(join(dir, 'pkg', 'index.js')).toString())
  t.assert.equal(st.modules.get('pkg').files['index.js'], st.hashes.get('pkg/index.js'))
}))

test('a no-lockfile bundle absorb seeds the version-less bucket identity', withTmp('absorb', (t, dir) => {
  capture(dir)
  rmSync(join(dir, 'stasis.lock.json'))

  // lock=replace absorbs the bundle without a loaded lockfile (#mergeBundleMetadata's absorb branch).
  const st = new State(dir, { lock: 'replace', bundle: 'add' })
  const seeded = st.modules.get('pkg')
  t.assert.equal(seeded.name, 'pkg-noversion')
  t.assert.equal(seeded.version, undefined)
  st.addFile(pathToFileURL(join(dir, 'pkg', 'index.js')).toString())
  t.assert.equal(st.modules.get('pkg').name, 'pkg-noversion')
}))

test('a version drift against the absorbed version-less bucket still fails closed', withTmp('drift', (t, dir) => {
  capture(dir)
  rmSync(join(dir, 'stasis.lock.json'))
  // The package gains a version on disk after the bundle recorded none: identity drift, refuse.
  writeFileSync(join(dir, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg-noversion', version: '1.0.0' }))

  const st = new State(dir, { lock: 'replace', bundle: 'add' })
  t.assert.throws(() => st.addFile(pathToFileURL(join(dir, 'pkg', 'index.js')).toString()))
}))

test('findPackageMetadata claims a version-less workspace bucket but stays strict in node_modules', withTmp('meta', (t, dir) => {
  t.assert.deepEqual(findPackageMetadata(dir, 'pkg/index.js'),
    { pkgDir: 'pkg', name: 'pkg-noversion', version: undefined })

  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep' }))
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  // A version-less node_modules manifest never claims the bucket; the walk continues to the root.
  t.assert.deepEqual(findPackageMetadata(dir, 'node_modules/dep/index.js'),
    { pkgDir: '.', name: 'fx', version: '0.0.0' })
}))

test('stasis add buckets a version-less workspace package under its own dir', withTmp('add-cmd', (t, dir) => {
  writeFileSync(join(dir, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  addCommand({ cwd: dir, entries: ['pkg/index.js'], logLabel: 'test' })

  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(join(dir, 'stasis.code.br'))).toString('utf-8'))
  const m = bundle.modules.get('pkg')
  t.assert.equal(m.name, 'pkg-noversion')
  t.assert.equal(m.version, undefined)
  t.assert.ok(m.files['index.js'])
  t.assert.ok(!bundle.modules.has('.'), 'must not fall through to the workspace root bucket')
}))
