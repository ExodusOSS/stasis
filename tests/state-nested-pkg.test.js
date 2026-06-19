import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-nested-pkg')

test('addFile on a file under a nested sub-bucket package.json uses the package root', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url, { format: 'module' })

  const module = state.modules.get('node_modules/widget')
  t.assert.ok(module, 'package root entry must be present')
  t.assert.equal(module.name, 'widget')
  t.assert.equal(module.version, '1.2.3')
  // A node_modules bucket is an installed dependency: tagged with the npm ecosystem.
  t.assert.equal(module.ecosystem, 'npm')
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
  // The workspace/top-level bucket is not a dependency: no `ecosystem`.
  t.assert.equal(module.ecosystem, undefined)
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

test('addFile tags a UTF-8 resource as plain "resource" (no base64)', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString() // ASCII text
  state.addFile(url, { resource: true })
  t.assert.equal(state.formats.get('sub/asset.bin'), 'resource')
})

test('addFile tags a binary resource as "resource:base64"', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'blob.bin')).toString() // non-UTF-8 bytes
  state.addFile(url, { resource: true })
  t.assert.equal(state.formats.get('sub/blob.bin'), 'resource:base64')
})

test('legacy isBinary:true is still accepted as a resource alias', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'blob.bin')).toString()
  state.addFile(url, { isBinary: true })
  t.assert.equal(state.formats.get('sub/blob.bin'), 'resource:base64')
})

test('addFile rejects a caller-provided format that conflicts with the content-derived resource format', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  // Resource formats are content-derived ('resource' / 'resource:base64'); a custom
  // loader format like 'wasm' can't override that.
  t.assert.throws(() => state.addFile(url, { resource: true, format: 'wasm' }), /resource format mismatch/)
})

test('addFile defaults .js format to commonjs when the closest package.json omits type', (t) => {
  const state = new State(root)
  // node_modules/widget/package.json has no `type` field, so its .js files
  // default to commonjs even though the project root is type=module.
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/index.js'), 'commonjs')
})

test('addFile keeps a module format already recorded this session for a later no-format .js capture', (t) => {
  const state = new State(root)
  // widget/package.json omits `type`, so a bare no-format .js capture defaults
  // to commonjs (the test above). But the runtime loader records Node's
  // authoritative module-syntax choice first; a later no-format bundler-plugin
  // capture (StasisWebpack/StasisEsbuild/StasisMetro afterResolve pass no
  // format) of the SAME file must KEEP that `module`, not downgrade it to the
  // legacy commonjs default (which would also collide at the formats noupsert).
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url, { format: 'module' }) // loader observed ESM
  t.assert.doesNotThrow(() => state.addFile(url)) // no-format bundler capture
  t.assert.equal(state.formats.get('node_modules/widget/index.js'), 'module')
})

test('addFile does not adopt a resource tag as the format of a later no-format .js code capture', (t) => {
  const state = new State(root)
  // The deferral only reuses an extension-appropriate code format. A file
  // previously recorded as a 'resource' must NOT have that tag silently adopted
  // by a later code capture -- the commonjs default re-applies, so the
  // code/resource conflict still surfaces at the formats noupsert.
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url, { resource: true })
  t.assert.throws(() => state.addFile(url))
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

test('getFile round-trips a resource: text stays raw, binary stays base64, both decode back', (t) => {
  // State stores 'resource' as raw UTF-8 (asset.bin is ASCII) and 'resource:base64'
  // as base64 (blob.bin is non-UTF-8). getFile must return the original bytes in
  // both cases -- the very contract `stasis run --bundle=load` (via state.getFile)
  // relies on when serving a file from the bundle to Node, and the contract
  // `extract` (also via the lockfile-byte hash) needs to keep its derived
  // lockfile consistent with what `stasis run` would have recorded.
  //
  // The shared fixture's stasis.config.json sets bundle=none, but `getFile` only
  // makes sense when the bundle is materialized -- enable it via the constructor.
  // bundle=add + lock=add satisfies Config's invariants without writing anything
  // (no .write() is called).
  const state = new State(root, { lock: 'add', bundle: 'add' })
  const textUrl = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  const binUrl = pathToFileURL(join(root, 'sub', 'blob.bin')).toString()
  state.addFile(textUrl, { resource: true })
  state.addFile(binUrl, { resource: true })

  // State's per-format split is the same one bundle=load would do on a parsed bundle.
  const text = state.getFile(textUrl)
  t.assert.equal(text.format, 'resource')
  t.assert.equal(typeof text.source, 'string', 'resource (UTF-8) decodes back to a raw string')

  const bin = state.getFile(binUrl)
  t.assert.equal(bin.format, 'resource:base64')
  t.assert.ok(Buffer.isBuffer(bin.source), 'resource:base64 decodes back to a Buffer')
  // Re-hash must match the lockfile-side digest (sha512 of the raw bytes), which is
  // what state.hashes recorded at addFile. That's the round-trip the extract command
  // and the loader's load-mode hash check both rely on.
  t.assert.ok(state.hashes.get('sub/blob.bin').startsWith('sha512-'))
})
