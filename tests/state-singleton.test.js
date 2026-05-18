import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'singleton')

// Each test file runs in its own process under `node --test`, so the State registry is
// fresh per file. We exercise both shapes (multi-State allowed; preload uniqueness) in
// one test to avoid relying on test execution order within the file.

test('multiple State instances coexist; preload is unique', (t) => {
  const a = new State(root)
  const b = new State(root)
  t.assert.notEqual(a, b)
  // Two non-preload Stasis instances live -- legacy State.instance accessor refuses to guess
  t.assert.throws(() => State.instance, /Multiple Stasis instances/)
  // Neither was constructed as preload
  t.assert.equal(State.preload, undefined)
})

test('preload State is exposed via State.preload', (t) => {
  // The States from the previous test linger in liveStates -- node:test runs subtests
  // in the same process and the registry is monotonic. The preload short-circuit in
  // State.instance is what makes this test independent of the previous one.
  const p = new State(root, { preload: true })
  t.assert.equal(State.preload, p)
  // State.instance returns the preload even when more live States exist
  const _extra = new State(root)
  t.assert.equal(State.instance, p)
  t.assert.notEqual(State.instance, _extra)
  // Constructing a second preload is rejected
  t.assert.throws(() => new State(root, { preload: true }), /Only one preload Stasis instance/)
})

test('preload constructed first survives later non-preload additions', (t) => {
  // Same registry state as test 2 leaves us with: preload already set. State.instance
  // still resolves to it regardless of how many non-preloads we tack on afterwards.
  const beforeCount = 0 // we only care about relative growth
  const p = State.preload
  t.assert.ok(p)
  const _a = new State(root)
  const _b = new State(root)
  t.assert.equal(State.preload, p, 'preload identity is sticky across later additions')
  t.assert.equal(State.instance, p, 'State.instance keeps returning the preload')
  // sanity check that liveStates actually grew (we can't read it directly; assert via the
  // ambiguity branch: if we dropped the preload, State.instance would throw)
  void beforeCount
})
