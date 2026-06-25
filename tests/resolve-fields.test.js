import { test } from 'node:test'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFieldResolver, resolveConditions } from '../stasis/src/resolve-fields.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = join(here, 'fixtures', 'resolve-fields')
const entry = join(fx, 'src', 'entry.js')
const redirIndex = join(fx, 'node_modules', 'redir', 'index.js')

// Resolve and reduce to a fixture-relative path (or a marker) for assertions.
const rel = (r) => {
  if (r == null) return null
  if (r.empty) return '<empty>'
  if (r.builtin) return '<builtin>'
  return relative(fx, fileURLToPath(r.url)).split(/[\\/]/u).join('/')
}

// Build a resolver, varying the bits a caller tweaks (the legacy fields it honours
// and any extra `exports` conditions).
const mk = ({ mainFields = ['react-native', 'browser', 'main'], extras = [] } = {}) =>
  createFieldResolver({
    conditions: resolveConditions('module', extras),
    mainFields,
  })

test('a relative import resolves with extension probing', (t) => {
  t.assert.equal(rel(mk()(entry, './Button')), 'src/Button.js')
})

test('a relative directory import honours package.json main even when exports is present', (t) => {
  // dirpkg has "main":"./real.js", "exports":"./exp.js", and a stray index.js. A
  // relative/absolute directory import ignores exports (Node consults it only for bare
  // package names), so main wins -- not index, and not the exports target.
  t.assert.equal(rel(mk()(entry, './dirpkg')), 'src/dirpkg/real.js')
})

test('a package whose main points at a directory resolves that directory index (LOAD_AS_DIRECTORY)', (t) => {
  // dirmain: { "main": "./inner/" }. Node resolves main as a file then as a directory
  // (its index), so this must land on inner/index.js, not fail.
  t.assert.equal(rel(mk()(entry, 'dirmain')), 'node_modules/dirmain/inner/index.js')
})

test('mainFields select the package entry in order (react-native > browser > main)', (t) => {
  t.assert.equal(rel(mk()(entry, 'entryfields')), 'node_modules/entryfields/rn.js')
  t.assert.equal(
    rel(mk({ mainFields: ['browser', 'main'], extras: ['browser'] })(entry, 'entryfields')),
    'node_modules/entryfields/browser.js',
  )
  t.assert.equal(rel(mk({ mainFields: ['main'] })(entry, 'entryfields')), 'node_modules/entryfields/main.js')
})

test('a browser map redirects the package entry, matching the extensionless variant', (t) => {
  // entryredir: main "./lib/index.js", browser { "./lib/index": "./browser.js" } -- the
  // entry is matched with its extension stripped and redirected to the browser entry.
  t.assert.equal(rel(mk()(entry, 'entryredir')), 'node_modules/entryredir/browser.js')
})

test('an entry browser-map redirect matches a key written without a leading ./', (t) => {
  // noslash: { "main": "server.js", "browser": { "server.js": "./client.js" } } -- main
  // and the key both omit `./`; the redirect must still fire (esbuild + browser-resolve
  // both redirect regardless of which side carries the `./`).
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'noslash')), 'node_modules/noslash/client.js')
})

test('a bare browser-map key does not hijack a same-basename package entry', (t) => {
  // streampkg: main "./stream.js", browser { "stream": "./vendor/sb.js" }. The bare
  // "stream" key remaps the `stream` MODULE used inside the package, not the entry, so
  // the entry stays stream.js (esbuild + browser-resolve agree; verified end-to-end).
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'streampkg')), 'node_modules/streampkg/stream.js')
})

test('a browser-map false on the package entry disables it (empty module)', (t) => {
  // entryfalse: main "./fe.js", browser { "./fe.js": false } -- a relative key matching
  // the entry disables it to an empty module, matching esbuild.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'entryfalse')), '<empty>')
})

test('a bare browser-map false does not empty a same-basename package entry', (t) => {
  // barefalse: main "./buf.js", browser { "buf": false } -- the bare "buf" key disables
  // the `buf` module, not the entry; esbuild keeps buf.js.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'barefalse')), 'node_modules/barefalse/buf.js')
})

test('on a conflicting redirect key, the earlier mainField wins (react-native over browser)', (t) => {
  // conflict maps "./main.js" in BOTH its react-native and browser objects; with
  // mainFields [react-native, browser, main] the react-native target must win.
  t.assert.equal(rel(mk()(entry, 'conflict')), 'node_modules/conflict/rn.js')
})

test('browser object map redirects a relative subpath to another file', (t) => {
  // redir/package.json: "browser": { "./node-only.js": "./browser-only.js" }
  t.assert.equal(rel(mk()(redirIndex, './node-only.js')), 'node_modules/redir/browser-only.js')
})

test('browser object map false redirect resolves to an empty module', (t) => {
  // "./gone.js": false (relative) and "leftpad": false (bare)
  t.assert.equal(rel(mk()(redirIndex, './gone.js')), '<empty>')
  t.assert.equal(rel(mk()(redirIndex, 'leftpad')), '<empty>')
})

test('a browser map redirect target resolves against the package root, not the importer dir', (t) => {
  // redir/lib/inner.js requires ../node-only.js; the map's ./browser-only.js target is
  // package-root-relative, so it must land at redir/browser-only.js (not redir/lib/...).
  const inner = join(fx, 'node_modules', 'redir', 'lib', 'inner.js')
  t.assert.equal(rel(mk()(inner, '../node-only.js')), 'node_modules/redir/browser-only.js')
})

test('a dotted bare specifier in the browser map is matched as bare, not as a relative path', (t) => {
  // "socket.io": "./shim.js" and "lodash.merge": false -- the dots are part of the bare
  // module name, never read as path segments.
  t.assert.equal(rel(mk()(redirIndex, 'socket.io')), 'node_modules/redir/shim.js')
  t.assert.equal(rel(mk()(redirIndex, 'lodash.merge')), '<empty>')
})

test('exports wins over a legacy browser main field, honoring conditions', (t) => {
  // exportswins has both "browser":"./should-be-ignored.js" and an exports map
  // gating react-native/default. exports must win; the browser main field is ignored.
  t.assert.equal(rel(mk({ extras: ['react-native'] })(entry, 'exportswins')), 'node_modules/exportswins/rn.js')
  t.assert.equal(rel(mk()(entry, 'exportswins')), 'node_modules/exportswins/def.js')
})

test('builtins are reported as builtins', (t) => {
  t.assert.equal(rel(mk()(entry, 'node:path')), '<builtin>')
  t.assert.equal(rel(mk()(entry, 'fs')), '<builtin>')
})

test('the browser map can disable or shim a Node builtin (it wins over the builtin check)', (t) => {
  // builtinshim browser map: { "crypto": false, "fs": "./fs-shim.js", "buffer": "shimpkg" }.
  // Replacing Node-only modules is the browser field's whole purpose, so the map must be
  // consulted before falling back to treating the specifier as a builtin.
  const from = join(fx, 'node_modules', 'builtinshim', 'index.js')
  t.assert.equal(rel(mk()(from, 'crypto')), '<empty>') // false -> empty module
  t.assert.equal(rel(mk()(from, 'fs')), 'node_modules/builtinshim/fs-shim.js') // string -> package-root file
  t.assert.equal(rel(mk()(from, 'buffer')), 'node_modules/shimpkg/index.js') // string -> another package
  t.assert.equal(rel(mk()(from, 'path')), '<builtin>') // not mapped -> still a builtin
})

test('an unresolvable specifier returns null', (t) => {
  t.assert.equal(rel(mk()(entry, './does-not-exist')), null)
  t.assert.equal(rel(mk()(entry, 'no-such-package')), null)
})

test('locatePackage matches the node_modules segment exactly, not a *-node_modules suffix', (t) => {
  // An importer inside `my-node_modules/` must still find deps in its own
  // `my-node_modules/node_modules/` -- the walk skips a directory only when its last
  // segment IS `node_modules`, not when it merely ends with that string.
  const importer = join(fx, 'odd', 'my-node_modules', 'app.js')
  t.assert.equal(rel(mk()(importer, 'dep')), 'odd/my-node_modules/node_modules/dep/index.js')
})
