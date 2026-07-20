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

// Build a resolver, varying the bits a caller tweaks (the legacy fields it honours,
// the target `platform` and native-suffix preference, and any extra `exports`
// conditions). `platform: null` (the default, the `--mainFields` case) disables
// platform-suffix probing; for a real platform, web alone excludes `.native`.
const mk = ({ mainFields = ['react-native', 'browser', 'main'], extras = [], platform = null, preferNative = platform !== null && platform !== 'web', metro = false, keepEntryOnFalse } = {}) =>
  createFieldResolver({
    conditions: resolveConditions('module', extras),
    mainFields,
    platform,
    preferNative,
    metro,
    ...(keepEntryOnFalse === undefined ? {} : { metroKeepEntryOnBrowserFalse: keepEntryOnFalse }),
  })

test('a relative import resolves with extension probing', (t) => {
  t.assert.equal(rel(mk()(entry, './Button')), 'src/Button.js')
})

test('platform suffixes: name.<platform>.ext beats name.native.ext beats name.ext', (t) => {
  t.assert.equal(rel(mk({ platform: 'ios' })(entry, './Button')), 'src/Button.ios.js')
  t.assert.equal(rel(mk({ platform: 'android' })(entry, './Button')), 'src/Button.android.js')
})

test('web excludes the .native variant (preferNative is false for web)', (t) => {
  // Button.native.js exists, but web must not pick it -- it falls through to the base.
  t.assert.equal(rel(mk({ platform: 'web', extras: ['browser'] })(entry, './Button')), 'src/Button.js')
})

test('a native platform with no platform-specific file falls back to .native', (t) => {
  // No Button.windows.js exists; windows is a native platform, so .native wins over base.
  t.assert.equal(rel(mk({ platform: 'windows' })(entry, './Button')), 'src/Button.native.js')
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

test('a bare browser-map key does not hijack a same-basename package entry (--mainFields)', (t) => {
  // streampkg: main "./stream.js", browser { "stream": "./vendor/sb.js" }. The bare
  // "stream" key remaps the `stream` MODULE used inside the package, not the entry, so
  // the entry stays stream.js (esbuild + browser-resolve agree; verified end-to-end).
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'streampkg')), 'node_modules/streampkg/stream.js')
})

test('--metro: a bare browser-map key DOES redirect the resolved package entry', (t) => {
  // Real Metro's getPackageEntryPoint matches the bare "stream" key against the entry and
  // redirects it -- so under `metro`, streampkg resolves to vendor/sb.js (verified against
  // the real metro-resolver). This is the intended divergence from esbuild/--mainFields above.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'streampkg')), 'node_modules/streampkg/vendor/sb.js')
})

test('a browser-map false on the package entry disables it (empty module) (--mainFields)', (t) => {
  // entryfalse: main "./fe.js", browser { "./fe.js": false } -- a relative key matching
  // the entry disables it to an empty module, matching esbuild.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'entryfalse')), '<empty>')
})

test('--metro: a browser-map false on the package entry keeps main (Metro ignores it)', (t) => {
  // Metro's getPackageEntryPoint ignores a non-string (false) entry replacement and keeps
  // `main`, so under `metro` entryfalse resolves to fe.js -- NOT an empty module (verified
  // against the real metro-resolver). Gated by METRO_KEEP_ENTRY_ON_BROWSER_FALSE.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'entryfalse')), 'node_modules/entryfalse/fe.js')
})

test('--metro: a bare browser-map false also keeps main', (t) => {
  // barefalse (main "./buf.js", browser { "buf": false }): under metro the bare "buf" key DOES
  // match the entry (Metro's variant list), but `false` keeps main -- so buf.js. NOTE: this
  // outcome is identical whether or not the bare variant matched (no match would also leave
  // buf.js), so it does NOT discriminate the bare-key matching itself -- the streampkg test
  // above covers that. What it pins is Metro parity for the combined case (verified against
  // the real metro-resolver), and the toggle-off test below pins the branch actually taken.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'barefalse')), 'node_modules/barefalse/buf.js')
})

test('--metro: with the keep-on-false toggle off, a false entry match fails closed to empty', (t) => {
  // metroKeepEntryOnBrowserFalse: false (the METRO_KEEP_ENTRY_ON_BROWSER_FALSE=false state):
  // any `false` match on the entry -- under Metro's MATCHING rules, bare keys included --
  // yields an empty module. Deliberately stricter than both tools for bare keys (Metro keeps
  // main; esbuild wouldn't match the entry): it's a fail-closed escape hatch, not esbuild parity.
  const off = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true, keepEntryOnFalse: false })
  t.assert.equal(rel(off(entry, 'entryfalse')), '<empty>')
  t.assert.equal(rel(off(entry, 'barefalse')), '<empty>')
  // A plain string redirect is unaffected by the toggle.
  t.assert.equal(rel(off(entry, 'streampkg')), 'node_modules/streampkg/vendor/sb.js')
})

// --- Metro entry-variant fidelity (each expectation verified against the real metro-resolver) ---

test('--metro: entry redirect follows Metro variant ORDER on competing keys', (t) => {
  const metro = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })
  // dualkey: main "./stream.js", browser { "stream.js": "./a.js", "./stream": "./b.js" }.
  // Metro probes ./-prefixed variants of the main spelling before bare ones: ./stream wins -> b.js.
  t.assert.equal(rel(metro(entry, 'dualkey')), 'node_modules/dualkey/b.js')
  // strfalse: main "./x.js", browser { "x.js": "./A.js", "./x": false }. Metro hits ./x (false)
  // first and keeps main -- the later string key must NOT redirect.
  t.assert.equal(rel(metro(entry, 'strfalse')), 'node_modules/strfalse/x.js')
})

test('--metro: entry redirect matches Metro variant SET (no stripped .json probe, honors double-extension)', (t) => {
  const metro = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })
  // jsonkey: browser { "stream.json": "./x.js" } for main "./stream.js" -- Metro never generates
  // a stripped+.json variant, so the entry must stay stream.js (no over-match).
  t.assert.equal(rel(metro(entry, 'jsonkey')), 'node_modules/jsonkey/stream.js')
  // dblext: browser { "./stream.js.js": "./x.js" } -- Metro generates main+'.js', so it redirects.
  t.assert.equal(rel(metro(entry, 'dblext')), 'node_modules/dblext/x.js')
})

test('--metro: the redirect map applies to platform-suffixed file candidates (Metro resolveSourceFileForExt)', (t) => {
  // sfxfalse: main "./index" with only index.ios.js on disk and browser { "./index.ios.js": false }.
  // Metro redirect-checks each suffixed candidate; the false short-circuits to an empty module.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'sfxfalse')), '<empty>')
})

test('--metro: an object-valued react-native field participates in entry redirection under the real preset', (t) => {
  // rnbare: main "./crypto.js", react-native { "crypto": "./crypto-rn.js" } -- exercised with the
  // shipped --metro mainFields preset (react-native,browser,main), not just browser,main.
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(entry, 'rnbare')), 'node_modules/rnbare/crypto-rn.js')
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
