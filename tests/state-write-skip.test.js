import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

// write() is called once per process for `stasis run` (beforeExit/exit), but the
// webpack/esbuild plugins call it on every `compiler.hooks.done` event -- i.e. on
// every rebuild in watch mode. Without compare-and-skip, every rebuild re-brotlis
// (quality 11, multi-MB inputs, super-linear in size) and rewrites every output.
// These tests pin that a second write() with no state change is a true no-op:
// no brotli, no file touch.

const withTmp = (label, fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), `stasis-skip-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  return fn(t, dir)
}

const filePerturbation = (path) => statSync(path).mtimeMs

test('write() with no state change since the last call does not touch the lockfile', withTmp('lock', (t, dir) => {
  const lockPath = join(dir, 'plug.lock.json')
  const st = new State(dir, { lock: 'add', lockFile: lockPath, bundle: 'none' })
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  st.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  st.write()
  const mtime1 = filePerturbation(lockPath)

  // No new addFile / addImport -- the lockfile content shouldn't change. The second
  // write() must skip the writeFileSync entirely (mtime unchanged).
  st.write()
  const mtime2 = filePerturbation(lockPath)
  t.assert.equal(mtime2, mtime1, 'second write() must not re-touch the lockfile')
}))

test('write() rewrites the lockfile when state mutates between calls', withTmp('lock-rewrite', (t, dir) => {
  const lockPath = join(dir, 'plug.lock.json')
  const st = new State(dir, { lock: 'add', lockFile: lockPath, bundle: 'none' })
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')
  st.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  st.write()
  const first = readFileSync(lockPath, 'utf-8')

  st.addFile(pathToFileURL(join(dir, 'b.js')).toString(), { format: 'module' })
  st.write()
  const second = readFileSync(lockPath, 'utf-8')

  t.assert.notEqual(first, second, 'mutation must produce a new lockfile')
  t.assert.ok(second.includes('b.js'))
}))

test('write() with no state change does not touch the bundle file', withTmp('bundle', (t, dir) => {
  const bundlePath = join(dir, 'code.br')
  const st = new State(dir, { lock: 'add', bundle: 'add', bundleFile: bundlePath })
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  st.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  st.write()
  const mtime1 = filePerturbation(bundlePath)

  st.write()
  const mtime2 = filePerturbation(bundlePath)
  t.assert.equal(mtime2, mtime1, 'second write() must not re-brotli + rewrite the bundle')
}))

test('write() with split layout: both halves are independently skipped when unchanged', withTmp('split', (t, dir) => {
  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')
  const st = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0xAA]))
  st.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  st.addFile(pathToFileURL(join(dir, 'logo.png')).toString(), { resource: true })
  st.write()
  const codeMtime1 = filePerturbation(codePath)
  const resMtime1 = filePerturbation(resPath)

  st.write()
  t.assert.equal(filePerturbation(codePath), codeMtime1, 'code half must not be re-brotlied')
  t.assert.equal(filePerturbation(resPath), resMtime1, 'resources half must not be re-brotlied')
}))

test('write() with split layout: rewrites only the half that changed', withTmp('split-partial', (t, dir) => {
  const codePath = join(dir, 'code.br')
  const resPath = join(dir, 'res.br')
  const st = new State(dir, { lock: 'add', bundle: 'add', bundleFile: codePath, resourcesBundleFile: resPath })
  writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0xAA]))
  st.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { format: 'module', isEntry: true })
  st.addFile(pathToFileURL(join(dir, 'logo.png')).toString(), { resource: true })
  st.write()
  const codeFirst = readFileSync(codePath)
  const resFirst = readFileSync(resPath)

  // Add only a code file; resources half is unchanged.
  st.addFile(pathToFileURL(join(dir, 'b.js')).toString(), { format: 'module' })
  st.write()
  const codeSecond = readFileSync(codePath)
  const resSecond = readFileSync(resPath)

  t.assert.ok(!codeFirst.equals(codeSecond), 'code half must change when a code file is added')
  t.assert.ok(resFirst.equals(resSecond), 'resources half must stay byte-identical when no resource changed')
}))
