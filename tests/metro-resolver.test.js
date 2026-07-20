import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { buildBundle } from '../stasis/src/cmd/bundle.js'
import { createMetroResolver } from '../stasis/src/metro-resolver.js'
import { createFieldResolver, resolveConditions } from '../stasis/src/resolve-fields.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fx = join(here, 'fixtures', 'resolve-fields')
const entry = join(fx, 'src', 'entry.js')
const redirIndex = join(fx, 'node_modules', 'redir', 'index.js')

// The adapter auto-discovers metro-resolver from the project being bundled (where stasis is
// RUN), not from stasis's own install -- so it's a workspace devDependency here purely for these
// tests, resolvable from the fixture via node_modules walk-up. Skip cleanly where it's absent.
const metroResolverAvailable = (() => {
  try {
    createRequire(join(fx, 'noop.js')).resolve('metro-resolver')
    return true
  } catch {
    return false
  }
})()
const ifMetro = { skip: metroResolverAvailable ? false : 'metro-resolver not installed' }

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-resolver-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const runCli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', ...opts })
  r.stdout = stripVTControlCharacters(r.stdout ?? '')
  r.stderr = stripVTControlCharacters(r.stderr ?? '')
  return r
}

// Resolve and reduce to a fixture-relative path (or marker) for assertions.
const rel = (r) => {
  if (r == null) return null
  if (r.empty) return '<empty>'
  if (r.builtin) return '<builtin>'
  return relative(fx, fileURLToPath(r.url)).split(/[\\/]/u).join('/')
}

// Built-in (hand-rolled) resolver, configured the way --metro drives it.
const mkField = ({ platform = 'ios', mainFields = ['react-native', 'browser', 'main'], extras = ['react-native'] } = {}) =>
  createFieldResolver({
    conditions: resolveConditions('commonjs', extras),
    mainFields,
    platform,
    preferNative: platform !== 'web',
  })

// The project's real metro-resolver, via the adapter under test.
const mkMetro = ({ platform = 'ios', mainFields = ['react-native', 'browser', 'main'], conditionNames = ['react-native'] } = {}) =>
  createMetroResolver({ projectDir: fx, platform, mainFields, conditionNames })

// (label, from, spec) resolved identically by both resolvers under --metro settings.
const PARITY_CASES = [
  ['relative import + platform suffix', entry, './Button'],
  ['directory main over exports', entry, './dirpkg'],
  ['package main points at a directory', entry, 'dirmain'],
  ['mainFields order (react-native wins)', entry, 'entryfields'],
  ['browser map redirects the package entry', entry, 'entryredir'],
  ['conflicting redirect: earlier mainField wins', entry, 'conflict'],
  ['browser object map redirects a subpath', redirIndex, './node-only.js'],
  ['browser false (relative) -> empty', redirIndex, './gone.js'],
  ['browser false (bare) -> empty', redirIndex, 'leftpad'],
  ['dotted bare specifier shimmed', redirIndex, 'socket.io'],
  ['exports wins over browser main, honoring conditions', entry, 'exportswins'],
]

test('adapter matches the built-in resolver on the shared Metro cases', ifMetro, (t) => {
  const field = mkField()
  const metro = mkMetro()
  for (const [label, from, spec] of PARITY_CASES) {
    t.assert.equal(rel(metro(from, spec)), rel(field(from, spec)), label)
  }
})

test('platform suffixes: metro-resolver picks name.<platform>.ext, native off web', ifMetro, (t) => {
  t.assert.equal(rel(mkMetro({ platform: 'ios' })(entry, './Button')), 'src/Button.ios.js')
  t.assert.equal(rel(mkMetro({ platform: 'android' })(entry, './Button')), 'src/Button.android.js')
  // windows has no windows-specific file -> falls back to .native (a native platform).
  t.assert.equal(rel(mkMetro({ platform: 'windows' })(entry, './Button')), 'src/Button.native.js')
  // web is not native -> Button.native.js must be skipped for the base.
  t.assert.equal(rel(mkMetro({ platform: 'web', conditionNames: [] })(entry, './Button')), 'src/Button.js')
})

test('unmapped Node builtins report as builtins; the browser map still shims/disables them', ifMetro, (t) => {
  const metro = mkMetro()
  t.assert.equal(rel(metro(entry, 'node:path')), '<builtin>')
  t.assert.equal(rel(metro(entry, 'fs')), '<builtin>')
  const shim = join(fx, 'node_modules', 'builtinshim', 'index.js')
  t.assert.equal(rel(mkMetro()(shim, 'crypto')), '<empty>') // browser { crypto: false }
  t.assert.equal(rel(mkMetro()(shim, 'fs')), 'node_modules/builtinshim/fs-shim.js') // -> package file
  t.assert.equal(rel(mkMetro()(shim, 'buffer')), 'node_modules/shimpkg/index.js') // -> other package
  t.assert.equal(rel(mkMetro()(shim, 'path')), '<builtin>') // not mapped -> builtin
})

test('unresolvable specifiers return null', ifMetro, (t) => {
  const metro = mkMetro()
  t.assert.equal(rel(metro(entry, './does-not-exist')), null)
  t.assert.equal(rel(metro(entry, 'no-such-package')), null)
})

// These are the cases where real Metro diverges from the built-in approximation. Asserting BOTH
// sides pins the divergence: if a metro-resolver upgrade changes it, this test flags it.
test('DIVERGENCE: a bare browser-map key redirects the resolved package entry (unlike the built-in)', ifMetro, (t) => {
  // streampkg: main "./stream.js", browser { "stream": "./vendor/sb.js" }. The built-in keeps
  // stream.js (matching esbuild); real Metro applies the bare "stream" redirect to the entry.
  t.assert.equal(rel(mkField({ mainFields: ['browser', 'main'] })(entry, 'streampkg')), 'node_modules/streampkg/stream.js')
  t.assert.equal(rel(mkMetro({ mainFields: ['browser', 'main'] })(entry, 'streampkg')), 'node_modules/streampkg/vendor/sb.js')
})

test('DIVERGENCE: a browser-map false on the package entry does NOT empty it in real Metro', ifMetro, (t) => {
  // entryfalse: main "./fe.js", browser { "./fe.js": false }. The built-in empties the entry;
  // Metro's getPackageEntryPoint ignores a non-string (false) replacement and keeps the main.
  t.assert.equal(rel(mkField({ mainFields: ['browser', 'main'] })(entry, 'entryfalse')), '<empty>')
  t.assert.equal(rel(mkMetro({ mainFields: ['browser', 'main'] })(entry, 'entryfalse')), 'node_modules/entryfalse/fe.js')
})

test('a missing metro-resolver throws with actionable guidance', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'stasis-no-metro-'))
  try {
    t.assert.throws(
      () => createMetroResolver({ projectDir: outside, platform: 'ios' }),
      /couldn't load 'metro-resolver'.*--metro-resolver/su,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('buildBundle --metro --metro-resolver matches the built-in resolver for this entry graph', ifMetro, async (t) => {
  const opts = { cwd: fx, entries: ['src/entry.js'], metro: true, platforms: ['ios', 'android'] }
  const builtin = await buildBundle(opts)
  const viaMetro = await buildBundle({ ...opts, metroResolver: true })
  // entry.js imports only cases both resolvers agree on, so the bundles are file-for-file equal.
  t.assert.deepEqual([...viaMetro.sources.keys()].toSorted(), [...builtin.sources.keys()].toSorted())
})

test('CLI: bundle --metro --metro-resolver writes a bundle + lockfile that round-trip', ifMetro, withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  const lock = join(tmp, 'metro.lock.json')
  const r = runCli(['bundle', '--metro', '--metro-resolver', '--platforms=ios,android', `--lockfile=${lock}`, `--output=${out}`, 'src/entry.js'], { cwd: fx })
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.ok(existsSync(out) && existsSync(lock))
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  t.assert.ok(bundle.sources.size > 0)
  // The companion lockfile mirrors the bundle: diff reports no differences (exit 0).
  t.assert.equal(runCli(['diff', '--stat', out, lock]).status, 0)
}))

test('CLI: --metro-resolver requires --metro', (t) => {
  t.assert.match(runCli(['bundle', '--metro-resolver', 'src/entry.js'], { cwd: fx }).stderr, /--metro-resolver is only valid with --metro/u)
})
