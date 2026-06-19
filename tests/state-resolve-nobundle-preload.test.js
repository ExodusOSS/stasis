// Verifies resolvePluginState's behavior when preload is active but has no bundle.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { State } from '@exodus/stasis-core/state'
import { resolvePluginState } from '@exodus/stasis-core/plugins'

const dir = mkdtempSync(join(tmpdir(), 'stasis-nb-preload-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')

const parent = new State(dir, { preload: true, lock: 'add', resources: ['png'] })  // no bundle
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

test("preload without bundle: plugin bundle='ignore' reuses preload", (t) => {
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

test('preload resources: a plugin declaring the same allowlist reuses the preload', (t) => {
  const r = resolvePluginState('Test', { resources: ['png'] }, dir)
  t.assert.equal(r.state, parent)
})

test('preload resources: a plugin declaring a DIFFERENT allowlist throws (no silent widening)', (t) => {
  t.assert.throws(
    () => resolvePluginState('Test', { resources: ['svg'] }, dir),
    /resources=\[svg\] conflicts with active preload resources=\[png\]/
  )
})

test('preload resources: a sidecar inherits the preload allowlist', (t) => {
  const r = resolvePluginState('Test', { bundle: 'add', bundleFile: join(dir, 'sidecar-res.br') }, dir)
  t.assert.notEqual(r.state, parent)
  t.assert.deepEqual([...r.state.config.resources], ['png'])
})
