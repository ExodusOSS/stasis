import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-load-proto')
// Sanity: the fixture's lockfile contains a literal `"__proto__"` JSON key under
// `modules['node_modules/widget'].files`. JSON.parse turns that into an own data
// property (it does NOT invoke the prototype setter), so a vulnerable loader that
// later does `module.files[name] = hash` with `name === '__proto__'` would only be
// dangerous if `module.files` were a plain `{}` -- which is exactly what the
// null-prototype normalization in state.js guards against.

const state = new State(root)

test('Object.prototype is not poisoned by a forged __proto__ key in lockfile.files', (t) => {
  // A vulnerable loader would have assigned `module.files['__proto__'] = 'sha512-evil'`
  // on a plain `{}`, making `({}).polluted` (or any inherited lookup) observable. We
  // assert nothing leaked onto Object.prototype.
  t.assert.equal(({}).polluted, undefined)
  t.assert.equal(Object.prototype.__proto__, null)
})

test('module.files is null-prototype after load, with __proto__ stored as own data property', (t) => {
  const widget = state.modules.get('node_modules/widget')
  t.assert.ok(widget, 'widget module entry must be present')
  t.assert.equal(Object.getPrototypeOf(widget.files), null, 'module.files must be a null-prototype object')
  t.assert.ok(Object.hasOwn(widget.files, '__proto__'), '__proto__ is preserved as own data property')
  t.assert.equal(widget.files.__proto__, 'sha512-evil', 'own value, not the prototype')
  t.assert.ok(Object.hasOwn(widget.files, 'index.js'), 'sibling entries still load')
})

test('the forged __proto__ entry is indexed in state.hashes under the joined path', (t) => {
  t.assert.equal(state.hashes.get('node_modules/widget/__proto__'), 'sha512-evil')
})
