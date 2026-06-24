import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

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

// CJS `require(require.resolve('./foo.js'))` (e.g. webpack's loader-runner doing
// `require(loader.path)`) hands the resolve hook the already-resolved ABSOLUTE
// path as the specifier. Recorded verbatim it bakes a machine-specific absolute
// path into the lockfile/bundle as a resolution KEY; it is renormalized to a path
// relative to the IMPORTING FILE, in both the record (addImport) and the lookup
// (getImport).
test('addImport renormalizes an absolute-path specifier relative to the importing file', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString() // src/bar.js
  const childURL = pathToFileURL(fileAbs).toString()   // src/foo.js
  // fileAbs is the absolute on-disk path of src/foo.js -- exactly what a CJS
  // require(require.resolve(...)) passes as the specifier.
  state.addImport(parentURL, fileAbs, childURL, { conditions: ['require', 'node'] })

  const recorded = state.imports.get('require, node').get('src/bar.js')
  t.assert.ok(recorded.has('./foo.js'), 'absolute specifier stored as a parent-relative key')
  t.assert.ok(!recorded.has(fileAbs), 'the machine-specific absolute path is not a key')
  t.assert.ok(![...recorded.keys()].some((k) => k.startsWith('/')), 'no absolute key recorded')

  // Looked up with the SAME absolute specifier Node passes at load time:
  // getImport renormalizes identically, so the lookup hits the parent-relative key.
  const got = state.getImport(parentURL, fileAbs, { conditions: ['require', 'node'] })
  t.assert.equal(got.url, childURL)
})

test('absolute-path specifier is renormalized in both the lockfile and the bundle', (t) => {
  const lockImports = JSON.parse(state.lockData).imports['require, node']['src/bar.js']
  const bundleImports = JSON.parse(state.sourceData).imports['require, node']['src/bar.js']
  t.assert.deepEqual(Object.keys(lockImports), ['./foo.js'], 'lockfile key is parent-relative')
  t.assert.deepEqual(Object.keys(bundleImports), ['./foo.js'], 'bundle key is parent-relative')
})

test('bare and relative specifiers are left untouched', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()
  state.addImport(parentURL, 'left-pad', childURL, { conditions: ['bare-test'] })
  state.addImport(parentURL, './rel.js', childURL, { conditions: ['bare-test'] })

  const recorded = state.imports.get('bare-test').get('src/bar.js')
  t.assert.ok(recorded.has('left-pad'), 'bare specifier preserved verbatim')
  t.assert.ok(recorded.has('./rel.js'), 'relative specifier preserved verbatim')
})

test('an absolute specifier outside the root is left as-is (no in-root relative form)', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString()
  const childURL = pathToFileURL(fileAbs).toString()
  // A path that escapes the project root can't be renormalized; record it unchanged.
  state.addImport(parentURL, '/etc/passwd', childURL, { conditions: ['outside-test'] })

  const recorded = state.imports.get('outside-test').get('src/bar.js')
  t.assert.ok(recorded.has('/etc/passwd'), 'out-of-root absolute specifier preserved verbatim')
})

// The real reported shape: loader-runner (under node_modules/.../lib) requires
// several sibling loaders by absolute path. Each renormalizes to a DISTINCT
// parent-relative key, which may contain '../' (going up from the importing
// file) -- that's expected and fine as long as the target stayed inside the root.
test('in-root absolute specifiers renormalize to distinct ../-prefixed keys (loader-runner shape)', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString() // src/bar.js -> dir src/
  for (const p of ['node_modules/a-loader/index.js', 'node_modules/b-loader/index.js']) {
    state.addImport(parentURL, join(root, p), pathToFileURL(join(root, p)).toString(), { conditions: ['loaders'] })
  }
  const keys = [...state.imports.get('loaders').get('src/bar.js').keys()]
  t.assert.deepEqual(keys, ['../node_modules/a-loader/index.js', '../node_modules/b-loader/index.js'])
  t.assert.ok(!keys.some((k) => k.startsWith('/')), 'no absolute key recorded')
})

// Keying against the importing file (not the project root) is what keeps the new
// key collision-free: a bare/root-relative specifier never starts with '.', a
// parent-relative one always does. So a literal 'lib/dep.js' and an absolute path
// that points elsewhere coexist as distinct keys -- no noupsert conflict (a
// root-relative scheme would have collapsed both onto 'lib/dep.js' and thrown).
test('a literal specifier and a renormalized absolute specifier do not collide', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString() // src/bar.js
  const intoNm = pathToFileURL(join(root, 'node_modules', 'pkg', 'lib', 'dep.js')).toString()
  const intoSrc = pathToFileURL(join(root, 'lib', 'dep.js')).toString()
  state.addImport(parentURL, 'lib/dep.js', intoNm, { conditions: ['collide'] })
  t.assert.doesNotThrow(() =>
    state.addImport(parentURL, join(root, 'lib', 'dep.js'), intoSrc, { conditions: ['collide'] }))
  const keys = [...state.imports.get('collide').get('src/bar.js').keys()].toSorted()
  t.assert.deepEqual(keys, ['../lib/dep.js', 'lib/dep.js'])
})

// The intended unification: requiring a file by its absolute path produces the
// SAME key as importing it relatively, so the two record as one edge (same value,
// noupsert agrees) rather than two.
test('an absolute specifier unifies with the relative import of the same file', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString() // src/bar.js
  const childURL = pathToFileURL(fileAbs).toString()   // src/foo.js
  state.addImport(parentURL, './foo.js', childURL, { conditions: ['unify'] })
  t.assert.doesNotThrow(() =>
    state.addImport(parentURL, fileAbs, childURL, { conditions: ['unify'] }))
  t.assert.deepEqual([...state.imports.get('unify').get('src/bar.js').keys()], ['./foo.js'])
})

// Statically-built bundles record edges under the '*' conditions key; a runtime
// lookup under precise conditions must renormalize the absolute specifier the
// same way and fall back to '*'.
test('getImport wildcard fallback resolves an absolute specifier recorded under *', (t) => {
  const parentURL = pathToFileURL(fileAbs2).toString() // src/bar.js
  const childURL = pathToFileURL(fileAbs).toString()   // src/foo.js
  state.addImport(parentURL, fileAbs, childURL, { conditions: '*' }) // recorded under '*' as './foo.js'
  const got = state.getImport(parentURL, fileAbs, { conditions: ['node'] }) // 'node' misses -> '*' fallback
  t.assert.equal(got.url, childURL)
})

// End-to-end through the security-critical path: an absolute-specifier edge
// captured into a bundle must, on a frozen reload, attest on a re-presented match
// and fail closed on a redirect -- the resolution check (#assertAttestedResolution)
// keys on the renormalized specifier on both sides.
test('a frozen bundle attests an absolute-specifier edge: match passes, redirect fails closed', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-abs-frozen-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }))
  mkdirSync(join(tmp, 'node_modules', 'fakepkg'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'fakepkg', 'package.json'), JSON.stringify({ name: 'fakepkg', version: '1.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'fakepkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(tmp, 'runner.cjs'), 'module.exports = 1\n')

  const parentURL = pathToFileURL(join(tmp, 'runner.cjs')).toString()
  const childAbs = join(tmp, 'node_modules', 'fakepkg', 'index.js')
  const childURL = pathToFileURL(childAbs).toString()

  // Capture: require(absolute path) recorded as a parent-relative edge, serialized to a bundle.
  const cap = new State(tmp, { scope: 'full', bundle: 'add' })
  cap.addFile(parentURL, { format: 'commonjs', isEntry: true })
  cap.addFile(childURL, { format: 'commonjs' })
  cap.addImport(parentURL, childAbs, childURL, { conditions: ['require', 'node'] })
  writeFileSync(join(tmp, 'stasis.code.br'), brotliCompressSync(cap.sourceData))

  // Frozen reload: the same absolute specifier attests and resolves...
  const frozen = new State(tmp, { scope: 'full', bundle: 'frozen' })
  t.assert.doesNotThrow(() =>
    frozen.addImport(parentURL, childAbs, childURL, { conditions: ['require', 'node'] }))
  t.assert.equal(frozen.getImport(parentURL, childAbs, { conditions: ['require', 'node'] }).url, childURL)

  // ...but redirecting that same specifier to a different file is rejected.
  t.assert.throws(() =>
    frozen.addImport(parentURL, childAbs, parentURL, { conditions: ['require', 'node'] }))
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

test('mergeShard carries child-only resource + directory captures, not just code', (t) => {
  // A forked child under `--fs --child-process` captures resource reads and readdir listings too.
  // mergeShard must route each by its recorded format -- a resource via addFile({resource:true})
  // and a directory via addFsDir -- not blindly through the code path (which rejects both and,
  // best-effort, would silently drop them).
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mergeshard-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3, 255])) // binary -> resource:base64
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a.txt'), 'hi')

    const child = new State(dir, { scope: 'full', lock: 'add', resources: ['bin'], childProcess: true })
    child.addFile(pathToFileURL(join(dir, 'asset.bin')).toString(), { resource: true })
    child.addFsDir(pathToFileURL(join(dir, 'sub')).toString(), ['a.txt'])

    const rootState = new State(dir, { scope: 'full', lock: 'add', resources: ['bin'] })
    rootState.mergeShard(child.shardSnapshot()) // re-reads bytes/listing from disk

    const lock = JSON.parse(rootState.lockData)
    t.assert.equal(lock.formats['asset.bin'], 'resource:base64', 'child-only resource attested, not dropped')
    t.assert.equal(lock.formats['sub'], 'directory', 'child-only directory listing attested, not dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeShard does NOT impose commonjs on a child fs-read .js (no recorded format)', (t) => {
  // A forked child that only fs-READ a `.js` (e.g. Babel reading a worker's source to transform
  // it) records the bytes but NO format -- module-vs-commonjs is the loader's call, so addFsFile
  // defers. mergeShard must replay that as a no-format file, NOT re-default it to commonjs: a
  // baked-in commonjs would collide with the `module` the loader records if the file is later
  // imported, failing a frozen run. The package.json has no `type`, so `.js` is genuinely ambiguous.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mergeshard-fmt-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' })) // no "type"
    const src = 'export const x = 1\n' // ESM source, only ever fs-read here
    writeFileSync(join(dir, 'worker.js'), src)

    const child = new State(dir, { scope: 'full', lock: 'add', childProcess: true })
    child.addFsFile(pathToFileURL(join(dir, 'worker.js')).toString(), Buffer.from(src))
    const snapshot = child.shardSnapshot()
    // Precondition: addFsFile recorded the file with no format (inferFormat:false for .js).
    t.assert.equal(JSON.parse(snapshot).formats?.['worker.js'], undefined,
      'precondition: child records the fs-read .js with no format')

    const rootState = new State(dir, { scope: 'full', lock: 'add' })
    rootState.mergeShard(snapshot)

    const lock = JSON.parse(rootState.lockData)
    t.assert.equal(lock.formats?.['worker.js'], undefined,
      'merged code file keeps NO format (deferred to the loader), not a commonjs default')
    t.assert.ok([...rootState.hashes.keys()].some((k) => k.endsWith('worker.js')),
      'the file bytes/hash are still attested, just without a format')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeShard carries a child-recorded module format (imported .js in a no-type package)', (t) => {
  // The flip side: when the child DID load the file as ESM (recording `module` for a no-`type`
  // package `.js`), mergeShard must CARRY that format -- otherwise the root re-defaults to commonjs
  // and a frozen run rejects the flip. This is the case the format carry was originally written for.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mergeshard-mod-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' })) // no "type"
    const src = 'export const x = 1\n'
    writeFileSync(join(dir, 'esm.js'), src)

    const child = new State(dir, { scope: 'full', lock: 'add', childProcess: true })
    child.addFile(pathToFileURL(join(dir, 'esm.js')).toString(), { source: Buffer.from(src), format: 'module' })
    const snapshot = child.shardSnapshot()
    t.assert.equal(JSON.parse(snapshot).formats['esm.js'], 'module', 'precondition: child recorded module')

    const rootState = new State(dir, { scope: 'full', lock: 'add' })
    rootState.mergeShard(snapshot)

    t.assert.equal(JSON.parse(rootState.lockData).formats['esm.js'], 'module',
      'child-recorded module format carried, not re-defaulted to commonjs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shardSnapshot forwards only this-session observations, not the seeded lockfile baseline', (t) => {
  // A forked child seeds the existing lockfile at construction; its shard must carry only what IT
  // observed (child-only files), NOT re-ship the whole baseline -- which would bloat every worker's
  // shard (toward MAX_SHARD_BYTES) and make the root re-read the entire lockfile from disk per
  // worker at merge.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-shard-scope-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    writeFileSync(join(dir, 'baseline.js'), 'export const a = 1\n')
    writeFileSync(join(dir, 'childonly.js'), 'export const b = 2\n')

    // Prior capture: write a lockfile that already attests baseline.js.
    const seed = new State(dir, { scope: 'full', lock: 'add' })
    seed.addFile(pathToFileURL(join(dir, 'baseline.js')).toString(), { source: Buffer.from('export const a = 1\n'), format: 'module' })
    writeFileSync(join(dir, 'stasis.lock.json'), seed.lockData)

    // A child that SEEDS that lockfile (baseline.js) at construction, then observes only childonly.js.
    const child = new State(dir, { scope: 'full', lock: 'add', childProcess: true })
    child.addFile(pathToFileURL(join(dir, 'childonly.js')).toString(), { source: Buffer.from('export const b = 2\n'), format: 'module' })
    const shard = JSON.parse(child.shardSnapshot())

    t.assert.deepEqual(Object.keys(shard.sources?.['.']?.files ?? {}), ['childonly.js'],
      'shard carries only the observed child-only file, not the seeded baseline.js')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeShard carries a child format even when the root already recorded the file format-less', (t) => {
  // The merge-skip (root already has the hash) must NOT drop a concrete format the child recorded.
  // Here the root fs-READ shared.js (so it has the hash but addFsFile records NO format for a .js),
  // and the child IMPORTED it as `module`. Dropping the format would leave the lockfile format-less
  // and make a later frozen run -- loading it as a module -- reject the unattested format.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-shard-fmtskip-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    const src = 'export const x = 1\n'
    writeFileSync(join(dir, 'shared.js'), src)

    const rootState = new State(dir, { scope: 'full', lock: 'add' })
    rootState.addFsFile(pathToFileURL(join(dir, 'shared.js')).toString(), Buffer.from(src)) // fs-read: hash, no format
    t.assert.equal(JSON.parse(rootState.lockData).formats?.['shared.js'], undefined, 'precondition: root has the file with no format')

    const child = new State(dir, { scope: 'full', lock: 'add', childProcess: true })
    child.addFile(pathToFileURL(join(dir, 'shared.js')).toString(), { source: Buffer.from(src), format: 'module' }) // imported as module
    rootState.mergeShard(child.shardSnapshot())

    t.assert.equal(JSON.parse(rootState.lockData).formats?.['shared.js'], 'module',
      'child-recorded module format carried through the hash-skip, not dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shardSnapshot forwards imports/formats for observed files only, not a bundle-seeded baseline', (t) => {
  // this.imports/this.formats are session-only for a lock=add run, but a bundle load seeds them
  // wholesale (this.formats = bundle.formats; this.imports = bundle.imports). shardSnapshot must
  // still forward ONLY what this process observed -- else every worker re-ships the whole app graph
  // (and a big enough graph pushes the shard past MAX_SHARD_BYTES and is silently dropped at merge).
  const dir = mkdtempSync(join(tmpdir(), 'stasis-shard-bundleseed-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    const src = 'export const x = 1\n'
    writeFileSync(join(dir, 'observed.js'), src)

    const child = new State(dir, { scope: 'full', lock: 'add', childProcess: true })
    // Simulate a bundle seed: a baseline format + edge for files this process never observed.
    child.formats.set('baseline.js', 'module')
    child.imports.set('*', new Map([['baseline.js', new Map([['./dep.js', 'dep.js']])]]))
    // Now actually observe one file and one edge from it.
    const observedUrl = pathToFileURL(join(dir, 'observed.js')).toString()
    child.addFile(observedUrl, { source: Buffer.from(src), format: 'module' })
    child.addImport(observedUrl, './self.js', observedUrl)

    const shard = JSON.parse(child.shardSnapshot())
    t.assert.equal(shard.formats?.['baseline.js'], undefined, 'bundle-seeded format (unobserved) NOT forwarded')
    t.assert.equal(shard.formats?.['observed.js'], 'module', 'observed format forwarded')
    t.assert.equal(shard.imports?.['*']?.['baseline.js'], undefined, 'bundle-seeded edge (unobserved parent) NOT forwarded')
    t.assert.ok(shard.imports?.['*']?.['observed.js'], 'observed edge (observed parent) forwarded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('addFile throws on a format flip in lock=add (attested format changed, bytes unchanged)', (t) => {
  // lock=add must not silently absorb a format flip: same bytes (hash matches) but a different loader
  // format (e.g. a package.json `type` change). A frozen run rejects it; lock=add now does too,
  // pointing at --lock=replace to re-attest, instead of recording a half-update / surprising frozen.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-format-flip-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    const src = 'const x = 1\n'
    writeFileSync(join(dir, 'mod.js'), src)

    // Prior capture attests mod.js as commonjs.
    const seed = new State(dir, { scope: 'full', lock: 'add' })
    seed.addFile(pathToFileURL(join(dir, 'mod.js')).toString(), { source: Buffer.from(src), format: 'commonjs' })
    writeFileSync(join(dir, 'stasis.lock.json'), seed.lockData)

    // lock=add re-run observing the SAME bytes but a FLIPPED format must throw.
    const rerun = new State(dir, { scope: 'full', lock: 'add' })
    t.assert.throws(
      () => rerun.addFile(pathToFileURL(join(dir, 'mod.js')).toString(), { source: Buffer.from(src), format: 'module' }),
      /format flip for mod\.js/,
    )

    // Same bytes + SAME format is fine (no flip).
    const ok = new State(dir, { scope: 'full', lock: 'add' })
    ok.addFile(pathToFileURL(join(dir, 'mod.js')).toString(), { source: Buffer.from(src), format: 'commonjs' })
    t.assert.equal(JSON.parse(ok.lockData).formats?.['mod.js'], 'commonjs', 'matching format re-attested without error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('addFile still verifies a caller-provided source against disk (integrity check preserved)', (t) => {
  // The double-read was removed only for the disk-sourced path (where it was tautological). A
  // CALLER-PROVIDED source must still be checked against the file on disk and reject a mismatch.
  const dir = mkdtempSync(join(tmpdir(), 'stasis-srccheck-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
    const url = pathToFileURL(join(dir, 'a.js')).toString()

    const s = new State(dir, { scope: 'full', lock: 'add' })
    // Provided source that DIFFERS from disk -> still throws (loader serving bytes != the file).
    t.assert.throws(() => s.addFile(url, { source: Buffer.from('export const a = 999\n'), format: 'module' }))

    // No source -> reads disk itself, no spurious throw, records the file.
    const s2 = new State(dir, { scope: 'full', lock: 'add' })
    s2.addFile(url, { format: 'module' })
    t.assert.ok(JSON.parse(s2.lockData).sources?.['.']?.files?.['a.js'], 'disk-read addFile records the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
