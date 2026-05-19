import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-nested-pkg')

test('addFile on a file under a nested sub-bucket package.json uses the package root', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url, { format: 'module' })

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

test('addFile walks past an empty workspace package.json to find the project package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'empty', 'foo.cjs')).toString()
  state.addFile(url, { format: 'commonjs' })

  const module = state.modules.get('.')
  t.assert.ok(module)
  t.assert.equal(module.name, 'stasis-state-nested-pkg-fixture')
  t.assert.equal(module.version, '0.0.0')
  t.assert.ok(module.files['empty/foo.cjs'])
})

test('addFile rejects a workspace package.json missing version but with non-type keys', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'partial', 'file.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile infers .js format from the closest package.json type when format is omitted', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/lib/util.js'), 'module')
})

test('addFile infers module for a .js file directly under the project root (type=module)', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'root-file.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('root-file.js'), 'module')
})

test('addFile infers json for a .json file under a type=module package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'root-data.json')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('root-data.json'), 'json')
})

test('addFile infers commonjs for a .cjs file under a type=module package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'legacy.cjs')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/lib/legacy.cjs'), 'commonjs')
})

test('addFile rejects an explicit format=commonjs for a .mjs file', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'script.mjs')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'commonjs' }))
})

test('addFile leaves format untouched for an unmapped extension', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  state.addFile(url, { isBinary: true })
  t.assert.equal(state.formats.get('sub/asset.bin'), undefined)
})

test('addFile preserves a caller-provided format for an unmapped extension', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  state.addFile(url, { isBinary: true, format: 'wasm' })
  t.assert.equal(state.formats.get('sub/asset.bin'), 'wasm')
})

test('addFile defaults .js format to commonjs when the closest package.json omits type', (t) => {
  const state = new State(root)
  // node_modules/widget/package.json has no `type` field, so its .js files
  // default to commonjs even though the project root is type=module.
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/index.js'), 'commonjs')
})

test('addFile rejects an explicit format that disagrees with the inferred one', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'foo.cjs')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile infers json for .json files regardless of closest type', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'data.json')).toString()
  state.addFile(url, { isBinary: false })
  t.assert.equal(state.formats.get('sub/data.json'), 'json')
})

test('addFile infers module for .mjs regardless of closest type', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'script.mjs')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('sub/script.mjs'), 'module')
})

test('addFile rejects a package.json type other than module/commonjs', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'invalid-type', 'file.js')).toString()
  t.assert.throws(() => state.addFile(url))
})
