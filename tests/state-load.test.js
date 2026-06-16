import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '@exodus/stasis-core/state'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-load')
const state = new State(root)

test('frozen mode is honored when loaded from config', (t) => {
  t.assert.equal(state.config.frozen, true)
  t.assert.equal(state.config.scope, 'node_modules')
  t.assert.equal(state.config.full, false)
})

test('lockfile modules are loaded into state.modules', (t) => {
  t.assert.ok(state.modules.has('node_modules/widget'))
  const m = state.modules.get('node_modules/widget')
  t.assert.equal(m.name, 'widget')
  t.assert.equal(m.version, '1.2.3')
})

test('file hashes from the lockfile are indexed', (t) => {
  t.assert.equal(state.hashes.get('node_modules/widget/index.js'), 'sha512-abc')
})

test('non-full scope skips entries / sources', (t) => {
  t.assert.equal(state.entries.size, 0)
  t.assert.equal(state.sources.size, 0)
})
