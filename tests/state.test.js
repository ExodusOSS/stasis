import { test } from 'node:test'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { State } from '../src/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state')
const fileAbs = join(root, 'src', 'foo.js')
const fileAbs2 = join(root, 'src', 'bar.js')

const state = new State(root)

test('root resolved to provided directory', (t) => {
  t.assert.equal(state.root, root)
})

test('config loaded from stasis.config.json', (t) => {
  t.assert.equal(state.config.scope, 'full')
  t.assert.equal(state.config.full, true)
  t.assert.equal(state.config.writeBundle, true)
  t.assert.equal(state.config.bundle, true)
})

test('static instance getter exposes constructed state', (t) => {
  t.assert.equal(State.instance, state)
})

test('default collections are initialised', (t) => {
  t.assert.ok(state.hashes instanceof Map)
  t.assert.ok(state.entries instanceof Set)
  t.assert.ok(state.sources instanceof Map)
  t.assert.ok(state.resources instanceof Map)
  t.assert.ok(state.formats instanceof Map)
  t.assert.ok(state.modules instanceof Map)
  t.assert.ok(state.imports instanceof Map)
})

test('absolute roundtrips a file URL to an absolute path', (t) => {
  const url = pathToFileURL(fileAbs).toString()
  t.assert.equal(state.absolute(url), fileAbs)
})

test('relative resolves under root', (t) => {
  t.assert.equal(state.relative(fileAbs), `src${sep}foo.js`)
})

test('relative rejects paths outside root', (t) => {
  t.assert.throws(() => state.relative('/etc/passwd'))
})

test('addFile records the file, hash, source and module info', (t) => {
  const url = pathToFileURL(fileAbs).toString()
  state.addFile(url, { format: 'module', isEntry: true })

  const rel = 'src/foo.js'
  t.assert.ok(state.hashes.has(rel))
  t.assert.match(state.hashes.get(rel), /^sha512-/)
  t.assert.ok(state.entries.has(rel))
  t.assert.equal(state.formats.get(rel), 'module')
  t.assert.equal(state.sources.get(rel), 'export const a = 1\n')

  // dir is dirname('package.json') === '.'
  const module = state.modules.get('.')
  t.assert.ok(module)
  t.assert.equal(module.name, 'stasis-test-root')
  t.assert.equal(module.version, '1.0.0')
  t.assert.equal(module.files['src/foo.js'], state.hashes.get(rel))
})

test('addFile is idempotent for identical content', (t) => {
  const url = pathToFileURL(fileAbs).toString()
  t.assert.doesNotThrow(() => state.addFile(url, { format: 'module', isEntry: true }))
})

test('getFile returns recorded source and format', (t) => {
  const url = pathToFileURL(fileAbs).toString()
  const { source, format } = state.getFile(url)
  t.assert.equal(source, 'export const a = 1\n')
  t.assert.equal(format, 'module')
})

test('addImport / getImport roundtrip', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()

  state.addFile(parentURL, { format: 'module' })
  state.addImport(parentURL, './foo.js', childURL, { format: 'module' })

  const got = state.getImport(parentURL, './foo.js')
  t.assert.equal(got.url, childURL)
  t.assert.equal(got.format, 'module')
})

test('addImport with conditions array stores under joined key', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()
  state.addImport(parentURL, 'foo-cond', childURL, { conditions: ['node', 'import'] })

  t.assert.ok(state.imports.has('node, import'))
  const got = state.getImport(parentURL, 'foo-cond', { conditions: ['node', 'import'] })
  t.assert.equal(got.url, childURL)
})

test('getImport throws for unknown specifier', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  t.assert.throws(() => state.getImport(parentURL, './does-not-exist.js'))
})

test('addImport keys by importAttributes: same specifier with vs without {type:json} are distinct', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const jsonURL = pathToFileURL(join(root, 'src', 'data.json')).toString()
  const jsURL = pathToFileURL(join(root, 'src', 'noattr.js')).toString()

  state.addImport(parentURL, './ambiguous', jsonURL, { importAttributes: { type: 'json' } })
  state.addImport(parentURL, './ambiguous', jsURL)

  t.assert.equal(state.getImport(parentURL, './ambiguous', { importAttributes: { type: 'json' } }).url, jsonURL)
  t.assert.equal(state.getImport(parentURL, './ambiguous').url, jsURL)
})

test('addImport rejects condition strings containing "(" or ")"', (t) => {
  // The conditions-level key suffixes attributes as ` (with: {...})`, so a condition
  // that itself contained parens could collide with the suffix in pathological cases.
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()
  t.assert.throws(
    () => state.addImport(parentURL, './x', childURL, { conditions: ['weird(cond)'] }),
    /conditions must not contain/
  )
})

test('addImport: attribute keys are unambiguous across delimiter-containing values', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  // The naive `${k}=${v}` join would collide on these two attribute objects:
  //   {type: 'a,b'}       -> "type=a,b"
  //   {type: 'a', b: ''}  -> "type=a,b="
  // The JSON-based encoding keeps them distinct.
  state.addImport(parentURL, './edge', pathToFileURL(fileAbs).toString(), { importAttributes: { type: 'a,b' } })
  state.addImport(parentURL, './edge', pathToFileURL(fileAbs2).toString(), { importAttributes: { type: 'a', b: '' } })

  const a = state.getImport(parentURL, './edge', { importAttributes: { type: 'a,b' } })
  const b = state.getImport(parentURL, './edge', { importAttributes: { type: 'a', b: '' } })
  t.assert.equal(a.url, pathToFileURL(fileAbs).toString())
  t.assert.equal(b.url, pathToFileURL(fileAbs2).toString())
  t.assert.notEqual(a.url, b.url)
})

test('addImport: empty {} importAttributes is equivalent to undefined', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()

  // The earlier "addImport / getImport roundtrip" test already added (parent, './foo.js',
  // child) with no importAttributes. Reading back with {} must find that same entry --
  // not a separate `*\0` keyed conditions bucket.
  const gotWithEmpty = state.getImport(parentURL, './foo.js', { importAttributes: {} })
  t.assert.equal(gotWithEmpty.url, childURL)

  // Re-adding with {} must noupsert (collide-and-pass) against the no-attributes entry,
  // not create a second conditions bucket under a different key.
  state.addImport(parentURL, './foo.js', childURL, { importAttributes: {} })

  // The empty-attrs encoding bug would have produced a `* (with: {})` bucket. Verify it didn't.
  t.assert.ok(!state.imports.has('* (with: {})'), 'empty {} must not create a separate conditions bucket')
})

test('lockData is well-formed JSON with the expected shape', (t) => {
  const text = state.lockData
  t.assert.equal(text.at(-1), '\n')
  const parsed = JSON.parse(text)
  t.assert.equal(parsed.version, 0)
  t.assert.deepEqual(parsed.config, { scope: 'full' })
  t.assert.ok(Array.isArray(parsed.entries))
  t.assert.ok(parsed.entries.includes('src/foo.js'))
  t.assert.ok(parsed.sources)
  t.assert.ok(parsed.modules)
  t.assert.ok(Object.hasOwn(parsed.sources, '.'))
  t.assert.equal(parsed.sources['.'].name, 'stasis-test-root')
})

test('sourceData is brotli-compressed JSON in the new format', (t) => {
  const buf = state.sourceData
  t.assert.ok(Buffer.isBuffer(buf))
  const parsed = JSON.parse(brotliDecompressSync(buf))
  t.assert.equal(parsed.version, 0)
  t.assert.deepEqual(parsed.config, { scope: 'full' })
  t.assert.ok(Array.isArray(parsed.entries))
  t.assert.ok(parsed.entries.includes('src/foo.js'))
  t.assert.equal(parsed.sources['.'].name, 'stasis-test-root')
  t.assert.equal(parsed.sources['.'].files['src/foo.js'], 'export const a = 1\n')
  t.assert.deepEqual(parsed.modules, {})
  t.assert.equal(parsed.formats['src/foo.js'], 'module')
})
