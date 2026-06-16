import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

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
  // The workspace/top-level bucket is the project's own code, not a dependency,
  // so it carries no `ecosystem`.
  t.assert.equal(module.ecosystem, undefined)
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

test('sourceData is JSON text in v1 format', (t) => {
  const text = state.sourceData
  t.assert.equal(typeof text, 'string')
  const parsed = JSON.parse(text)
  t.assert.equal(parsed.version, 1)
  t.assert.deepEqual(parsed.config, { scope: 'full' })
  t.assert.ok(Array.isArray(parsed.entries))
  t.assert.ok(parsed.entries.includes('src/foo.js'))
  t.assert.equal(parsed.sources['.'].name, 'stasis-test-root')
  t.assert.equal(parsed.sources['.'].files['src/foo.js'], 'export const a = 1\n')
  t.assert.deepEqual(parsed.modules, {})
  t.assert.equal(parsed.formats['src/foo.js'], 'module')
})

// A workspace dependency that pnpm links into node_modules (a symlink whose real
// target is a sibling package's source, outside any node_modules) must be
// classified as a source, not a dependency -- recorded under its real path.
function workspaceLinkTree(t, config) {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-wsp-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }))
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify(config))
  // a real npm dependency
  mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), 'export const d = 1\n')
  // a workspace package (source) linked into node_modules
  mkdirSync(join(tmp, 'packages', 'lib'), { recursive: true })
  writeFileSync(join(tmp, 'packages', 'lib', 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }))
  writeFileSync(join(tmp, 'packages', 'lib', 'index.js'), 'export const x = 1\n')
  symlinkSync(join('..', 'packages', 'lib'), join(tmp, 'node_modules', 'lib'), 'dir')
  return tmp
}

test('a node_modules symlink to a workspace source is classified as a source, not a dependency', (t) => {
  const tmp = workspaceLinkTree(t, { scope: 'full' })
  const st = new State(tmp)
  st.addFile(pathToFileURL(join(tmp, 'node_modules', 'lib', 'index.js')).toString(), { format: 'module' })

  // recorded under the real workspace path, not the node_modules symlink path
  t.assert.ok(st.modules.has('packages/lib'), 'recorded as a source under its real path')
  t.assert.ok(!st.modules.has('node_modules/lib'), 'not bucketed under the node_modules symlink')
  t.assert.ok(![...st.modules.keys()].some((d) => d.includes('node_modules')), 'no node_modules dependency recorded')
  const mod = st.modules.get('packages/lib')
  t.assert.equal(mod.name, 'lib')
  t.assert.ok(mod.files['index.js'])
})

test('node_modules-scope bundle excludes a workspace source symlinked into node_modules', (t) => {
  const tmp = workspaceLinkTree(t, { scope: 'node_modules', bundle: 'add' })
  const st = new State(tmp)
  st.addFile(pathToFileURL(join(tmp, 'node_modules', 'dep', 'index.js')).toString(), { format: 'module' })
  st.addFile(pathToFileURL(join(tmp, 'node_modules', 'lib', 'index.js')).toString(), { format: 'module' })

  const parsed = JSON.parse(st.sourceData)
  t.assert.ok(parsed.modules['node_modules/dep'], 'the real dependency is bundled')
  t.assert.ok(!parsed.modules['node_modules/lib'], 'symlink path is not bundled as a dependency')
  t.assert.ok(!parsed.modules['packages/lib'], 'the workspace source is not bundled in node_modules scope')
  t.assert.equal(parsed.sources, undefined, 'node_modules scope writes no sources')
})

test('inNodeModules classifies a real dependency in, a symlinked workspace source out', (t) => {
  const tmp = workspaceLinkTree(t, { scope: 'node_modules', bundle: 'add' })
  const st = new State(tmp)
  const dep = pathToFileURL(join(tmp, 'node_modules', 'dep', 'index.js')).toString()
  const wsp = pathToFileURL(join(tmp, 'node_modules', 'lib', 'index.js')).toString()
  // the loader hooks gate on this: a real dep is served from the bundle, while a
  // workspace source linked into node_modules is read from disk / resolved by Node.
  t.assert.equal(st.inNodeModules(dep), true)
  t.assert.equal(st.inNodeModules(wsp), false)
})

test('getImport reads an edge recorded under a symlinked workspace parent (canonical round-trip)', (t) => {
  const tmp = workspaceLinkTree(t, { scope: 'full', bundle: 'add' })
  writeFileSync(join(tmp, 'packages', 'lib', 'util.js'), 'export const u = 1\n')
  const st = new State(tmp)
  const parentSym = pathToFileURL(join(tmp, 'node_modules', 'lib', 'index.js')).toString()
  const childSym = pathToFileURL(join(tmp, 'node_modules', 'lib', 'util.js')).toString()
  st.addFile(parentSym, { format: 'module' })
  st.addFile(childSym, { format: 'module' })
  st.addImport(parentSym, './util.js', childSym, { format: 'module' })

  // looked up through the SAME node_modules symlink parent: addImport and getImport
  // both canonicalize, so the edge resolves to the real workspace-source path.
  const got = st.getImport(parentSym, './util.js')
  t.assert.equal(got.url, pathToFileURL(join(tmp, 'packages', 'lib', 'util.js')).toString())
})
