import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'singleton')

test('only a single State instance can be constructed', (t) => {
  const s = new State(root)
  t.assert.equal(State.instance, s)
  t.assert.throws(() => new State(root), /single Stasis instance/)
})
