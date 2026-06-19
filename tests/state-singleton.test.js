import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '@exodus/stasis-core/state'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'singleton')

// Each test file runs in its own process under `node --test`, so the process-wide preload
// slot starts empty per file and is monotonic within the process (subtests share it).

test('multiple non-preload State instances coexist; no preload is set', (t) => {
  const a = new State(root)
  const b = new State(root)
  t.assert.notEqual(a, b)
  t.assert.equal(State.preload, undefined)
})

test('preload State is exposed via State.preload and is unique', (t) => {
  const p = new State(root, { preload: true })
  t.assert.equal(State.preload, p)
  // Extra non-preload States don't displace the preload.
  const _extra = new State(root)
  t.assert.equal(State.preload, p)
  // A second preload is rejected.
  t.assert.throws(() => new State(root, { preload: true }), /Only one preload Stasis instance/)
})

test('preload identity is sticky across later non-preload additions', (t) => {
  const p = State.preload
  t.assert.ok(p)
  const _a = new State(root)
  const _b = new State(root)
  t.assert.equal(State.preload, p, 'preload identity is sticky across later additions')
})
