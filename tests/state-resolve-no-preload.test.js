// resolvePluginState behavior when no preload is active in the process.
// Kept in its own file so the preload registry stays empty for both tests --
// once a preload is constructed in a process it can't be cleared.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePluginState } from '../src/state.js'

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-no-preload-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
  return dir
}

test('rule 1: lockfile mode without preload is a hard throw', (t) => {
  const dir = fixture()
  try {
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'add' }, dir),
      /lockfile mode 'add' requires a stasis preload/
    )
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'frozen' }, dir),
      /lockfile mode 'frozen' requires a stasis preload/
    )
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'replace' }, dir),
      /lockfile mode 'replace' requires a stasis preload/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rule 7: lock=none + bundle=none returns noop', (t) => {
  const dir = fixture()
  try {
    const r = resolvePluginState('Test', { lock: 'none', bundle: 'none' }, dir)
    t.assert.equal(r.isNoop, true)
    t.assert.equal(r.state, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
