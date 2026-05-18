import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-nested-pkg')

test('addFile on a file under a nested sub-bucket package.json uses the package root', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url, { format: 'module' })

  // Bucketed under the package root, not the nested `lib/` marker dir.
  const module = state.modules.get('node_modules/widget')
  t.assert.ok(module, 'package root entry must be present')
  t.assert.equal(module.name, 'widget')
  t.assert.equal(module.version, '1.2.3')
  t.assert.ok(!state.modules.has('node_modules/widget/lib'), 'must not bucket under the nested marker dir')
  t.assert.ok(module.files['lib/util.js'])
})

test('addFile rejects a nested package.json that disagrees on name/version', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'conflict', 'lib', 'inner.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile walks past a workspace type-only marker to find the project package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'foo.cjs')).toString()
  state.addFile(url, { format: 'commonjs' })

  const module = state.modules.get('.')
  t.assert.ok(module, 'project root entry must be present')
  t.assert.equal(module.name, 'stasis-state-nested-pkg-fixture')
  t.assert.equal(module.version, '0.0.0')
  t.assert.ok(!state.modules.has('sub'), 'must not bucket under the marker dir')
  t.assert.ok(module.files['sub/foo.cjs'])
})

test('addFile rejects a workspace package.json missing version but with non-type keys', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'partial', 'file.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})
