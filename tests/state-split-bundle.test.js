import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'
import { Bundle } from '@exodus/stasis-core/bundle'

// Split-bundle layout: when `resourcesBundleFile` is configured, write() emits
// code-only to bundleFile and resources-only to resourcesBundleFile, and load
// reads both. Each on-disk file is a self-contained v1 Bundle.

const withTmp = (label, fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), `stasis-split-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  return fn(t, dir)
}

const parseBr = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf-8'))

test('write splits code into bundleFile and resources into resourcesBundleFile', withTmp('write', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]))
  writeFileSync(join(dir, 'note.txt'), 'hello\n')

  const codePath = join(dir, 'out', 'code.br')
  const resPath = join(dir, 'out', 'res.br')
  const st = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  st.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  st.addFile(pathToFileURL(join(dir, 'logo.png')).toString(), { resource: true })
  st.addFile(pathToFileURL(join(dir, 'note.txt')).toString(), { resource: true })
  st.write()

  t.assert.ok(existsSync(codePath), 'code bundle file emitted')
  t.assert.ok(existsSync(resPath), 'resources bundle file emitted')

  const code = parseBr(codePath)
  const res = parseBr(resPath)

  t.assert.equal(code.version, Bundle.VERSION)
  t.assert.equal(res.version, Bundle.VERSION)

  const codeFiles = [...code.sources.keys()].toSorted()
  const resFiles = [...res.sources.keys()].toSorted()
  t.assert.deepEqual(codeFiles, ['entry.js'], 'code bundle carries only code files')
  t.assert.deepEqual(resFiles, ['logo.png', 'note.txt'], 'resources bundle carries only resource files')

  t.assert.equal(code.formats.get('entry.js'), 'module')
  t.assert.equal(code.formats.get('logo.png'), undefined, 'resource formats absent from code bundle')
  t.assert.equal(res.formats.get('logo.png'), 'resource:base64')
  t.assert.equal(res.formats.get('note.txt'), 'resource')

  t.assert.ok(code.entries.has('entry.js'), 'entries live in the code bundle')
  t.assert.equal(res.entries.size, 0, 'resources bundle has no entries')
  t.assert.equal(res.imports.size, 0, 'resources bundle has no imports')
}))

test('load reads both halves and reconstructs the unified state', withTmp('load', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]))

  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')

  // Capture phase.
  const cap = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  cap.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  cap.addFile(pathToFileURL(join(dir, 'logo.png')).toString(), { resource: true })
  cap.write()

  // Load phase: fresh State (lock=frozen against the just-written lockfile, bundle=load against both halves).
  const load = new State(dir, { lock: 'frozen', bundle: 'load', bundleFile: codePath, resourcesBundleFile: resPath })
  t.assert.ok(load.sources.has('entry.js'), 'code file restored from code bundle')
  t.assert.ok(load.resources.has('logo.png'), 'resource file restored from resources bundle')
  t.assert.equal(load.formats.get('entry.js'), 'module')
  t.assert.equal(load.formats.get('logo.png'), 'resource:base64')
}))

test('load round-trip: re-serializing a loaded State reproduces both bundles', withTmp('rt', (t, dir) => {
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')
  writeFileSync(join(dir, 'icon.svg'), '<svg></svg>')

  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')

  const cap = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  cap.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  cap.addFile(pathToFileURL(join(dir, 'b.js')).toString(), { format: 'module' })
  cap.addFile(pathToFileURL(join(dir, 'icon.svg')).toString(), { resource: true })
  cap.write()

  const codeText = brotliDecompressSync(readFileSync(codePath)).toString('utf-8')
  const resText = brotliDecompressSync(readFileSync(resPath)).toString('utf-8')

  // Reload + re-serialize: the JSON text must round-trip exactly (deterministic ordering).
  const reloaded = new State(dir, { lock: 'frozen', bundle: 'frozen', bundleFile: codePath, resourcesBundleFile: resPath })
  t.assert.equal(reloaded.codeBundle.serialize(), codeText)
  t.assert.equal(reloaded.resourcesBundle.serialize(), resText)
}))

test('resources bundle containing entries is rejected on load', withTmp('forge-entries', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0xAA]))

  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')

  const cap = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  cap.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  cap.addFile(pathToFileURL(join(dir, 'logo.png')).toString(), { resource: true })
  cap.write()

  // Forge: rewrite the resources file with a `sources` map carrying a code file
  // (and entries / imports the resources half is not allowed to declare).
  const forged = JSON.parse(brotliDecompressSync(readFileSync(resPath)).toString('utf-8'))
  forged.sources = forged.sources || {}
  forged.sources['.'] = { name: 'fx', version: '0.0.0', files: { 'evil.js': 'console.log("pwn")' } }
  forged.entries = ['evil.js']
  forged.formats['evil.js'] = 'module'
  writeFileSync(resPath, brotliCompressSync(JSON.stringify(forged)))

  t.assert.throws(() => new State(dir, { lock: 'frozen', bundle: 'load', bundleFile: codePath, resourcesBundleFile: resPath }),
    /resources bundle .* must have empty entries|non-resource format/)
}))

test('loading without resourcesBundleFile (no on-disk file) is fine for add mode', withTmp('absent', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')

  // First run: no resources tracked. write() should still emit both halves (resources file is empty bundle).
  const st = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  st.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  st.write()
  t.assert.ok(existsSync(codePath))
  t.assert.ok(existsSync(resPath), 'resources file emitted even when no resources are tracked')

  const res = parseBr(resPath)
  t.assert.equal(res.sources.size, 0)
  t.assert.equal(res.formats.size, 0)
}))
