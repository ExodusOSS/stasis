// Verifies resolvePluginState's behavior when preload is active but has no bundle.
// Kept separate from state-sidecar.test.js because that file constructs its preload
// with bundle='add' and we can only have one preload per process.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { State, resolvePluginState } from '../src/state.js'

const dir = mkdtempSync(join(tmpdir(), 'stasis-nb-preload-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')

const parent = new State(dir, { preload: true, lock: 'add' })  // no bundle
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

test('preload without bundle: plugin bundle=undefined reuses preload', (t) => {
  const r = resolvePluginState('Test', {}, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.equal(r.state, parent)
})

test("preload without bundle: plugin bundle='none' reuses preload", (t) => {
  const r = resolvePluginState('Test', { bundle: 'none' }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.equal(r.state, parent)
})

test("preload without bundle: plugin bundle='ignore' reuses preload (regression: was rejected)", (t) => {
  // Pre-fix: assertOptionsMatchConfig would compare preload.bundleMode='none' against
  // plugin.bundle='ignore' and throw "Plugin options conflict with active stasis state".
  // Post-fix: the bundle field is excluded from the cross-check on this reuse path.
  const r = resolvePluginState('Test', { bundle: 'ignore' }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.equal(r.state, parent)
})

test('preload without bundle: plugin bundle=add + bundleFile constructs a sidecar', (t) => {
  const r = resolvePluginState('Test', { bundle: 'add', bundleFile: join(dir, 'sidecar.br') }, dir)
  t.assert.equal(r.isNoop, false)
  t.assert.notEqual(r.state, parent)
  t.assert.equal(r.state.parent, parent)
})

test('preload without bundle: plugin bundle=add without bundleFile throws', (t) => {
  t.assert.throws(
    () => resolvePluginState('Test', { bundle: 'add' }, dir),
    /requires an explicit bundleFile/
  )
})
