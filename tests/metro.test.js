// End-to-end coverage for StasisMetro via the spawning helper.
//
// Metro isn't a dependency of this repo (and the plugin never imports it -- it only
// consumes the module graph Metro hands a serializer). So, like plugins.test.js and
// the State suites, these tests drive the plugin directly: the helper builds a
// faithful MOCK of Metro's ReadOnlyGraph (see metro-run.helper.js) and feeds it to
// the serializer hook exactly as Metro would.
//
// IMPORTANT: by default the helper constructs a preload State first and mirrors the
// test's options onto it, so the plugin resolves into the "reuse preload" path
// (rules 3 / 5) -- the unified-state behavior the plugin produces under the stasis
// loader. Tests at the bottom pass STASIS_TEST_PRELOAD=0 to exercise the standalone
// / noop / hard-throw paths instead.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'metro-run.helper.js')
const fullFixture = join(here, 'fixtures', 'metro-full')
const nmFixture = join(here, 'fixtures', 'metro-nm')
const assetsFixture = join(here, 'fixtures', 'metro-assets')

// Module-graph manifests consumed by the helper (project-relative paths + edges).
const FULL_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] },
    { path: 'src/hello.js', deps: [] },
  ],
}
const NM_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['fake-esm-pkg', 'node_modules/fake-esm-pkg/index.js'], ['./helper.js', 'src/helper.js']] },
    { path: 'src/helper.js', deps: [] },
    { path: 'node_modules/fake-esm-pkg/index.js', deps: [] },
  ],
}
const ASSETS_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./logo.png', 'src/logo.png'], ['./icon.svg', 'src/icon.svg']] },
    { path: 'src/logo.png', deps: [] },
    { path: 'src/icon.svg', deps: [] },
  ],
}

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (entry, { cwd, env = {}, graph = FULL_GRAPH }) => {
  const r = spawnSync(process.execPath, [helper, entry], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, STASIS_TEST_METRO_GRAPH: JSON.stringify(graph), ...env },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ----- Lockfile modes (full scope) ----------------------------------------------------

test('lock=add records the entry and its imports', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'full' })
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  t.assert.deepEqual(lock.modules, {})
  // The as-written specifier './hello.js' is recorded as the resolution edge.
  t.assert.equal(lock.imports['*']['src/entry.js']['./hello.js'], 'src/hello.js')
}))

test('lock=add is idempotent against the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
}))

test('lock=frozen succeeds with the committed lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
}))

test('lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('lock=frozen rejects a brand-new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

  const r = run('src/fresh.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' },
    graph: { modules: [{ path: 'src/fresh.js', deps: [] }] },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('lock=replace rewrites the lockfile after a source change', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  const oldHash = JSON.parse(before).sources['.'].files['src/hello.js']
  const newHash = after.sources['.'].files['src/hello.js']
  t.assert.notEqual(newHash, oldHash)
  t.assert.ok(newHash.startsWith('sha512-'))
  t.assert.deepEqual(after.entries, ['src/entry.js'])
}))

test('lock=ignore tolerates the committed lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run('src/entry.js', { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

// ----- Bundle modes -------------------------------------------------------------------

test('bundle=add writes a bundle whose sources match disk', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
}))

test('bundle=load on the serializer is rejected and points at the worker transformer', withTmp((t, tmp) => {
  // Load can't be served from the serializer (Metro transforms in workers before
  // serialization); it's handled per-worker by the companion transformer. The plugin
  // must fail loudly and point there, not silently no-op.
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_BUNDLE: 'load' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /served by the companion worker transformer/)
  t.assert.match(r.stderr, /metro-transformer/)
}))

// ----- node_modules scope -------------------------------------------------------------

test('node_modules scope records package files and skips src/', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.config, { scope: 'node_modules' })
  t.assert.equal(lock.entries, undefined)
  t.assert.equal(lock.sources, undefined)
  t.assert.ok(lock.modules['node_modules/fake-esm-pkg'])
  t.assert.ok(lock.modules['node_modules/fake-esm-pkg'].files['index.js'].startsWith('sha512-'))
}))

test('node_modules scope lock=frozen rejects a changed node_modules file', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'),
    'export const greet = (n) => `pwned, ${n}`\n'
  )

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('node_modules scope lock=frozen tolerates changes to non-tracked src/ files', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // src/ is outside node_modules scope, so changes here must not affect the check.
  writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'mars'\n")

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    graph: NM_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
}))

// ----- Plugin options coverage --------------------------------------------------------

const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

test('options.lock=add records the entry like the env path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add' }) })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.entries, ['src/entry.js'])
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('options.bundle=add with bundleFile writes the bundle at the chosen path', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath }),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath))
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('options conflict with env is reported', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
  })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Config options can not override stasis env/)
}))

test('unknown plugin option is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown StasisMetro options/)
}))

test('invalid plugin option value is rejected', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Invalid lock/)
}))

// ----- Plugin↔preload coordination paths ----------------------------------------------

const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

test('rule 1: plugin lockfile without preload is a hard throw', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
}))

test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
    'noop plugin must not touch the lockfile')
}))

test('plugin standalone with bundle writes the bundle via the serializer hook', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(bundlePath), 'plugin must write the bundle')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
}))

test('a capture error does not write the bundle (no clobber)', withTmp((t, tmp) => {
  // The serializer captures before it writes, so a throw mid-capture (here: an
  // un-allowlisted extension) must leave the bundle file untouched.
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  const bundlePath = join(tmp, 'standalone.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['./styles.css', 'src/styles.css']] },
        { path: 'src/hello.js', deps: [] },
        { path: 'src/styles.css', deps: [] },
      ],
    },
  })
  t.assert.notEqual(r.status, 0, `expected capture failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
  t.assert.equal(existsSync(bundlePath), false, 'failed capture must not write the bundle')
}))

test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const preloadBundle = join(tmp, 'preload.br')
  const sidecarBundle = join(tmp, 'sidecar.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: {
      STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // The preload bundle is written by the loader's exit hooks, which the helper
  // doesn't install; the plugin writes its own sidecar bundle on the hook.
  t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle must be written by the plugin')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
}))

// ----- resources allowlist (assets) ---------------------------------------------------

test('unknown extension throws unless it is in the resources allowlist', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['./styles.css', 'src/styles.css']] },
        { path: 'src/hello.js', deps: [] },
        { path: 'src/styles.css', deps: [] },
      ],
    },
  })
  t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /unsupported extension/)
}))

test('resources allowlist attests png/svg assets and tags per-file resource format', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  // Lockfile attests bytes for all three files; resources get resource/resource:base64.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
  t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')
  t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
  t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')
  // Resource imports carry no resolution edge (matches webpack/esbuild).
  t.assert.deepEqual(lock.imports, {})

  // Bundle: all three files live together; resources are tagged in formats.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
  t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
  t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
}))

test('resources frozen run passes against committed asset hashes and rejects a tampered asset', withTmp((t, tmp) => {
  cpSync(assetsFixture, tmp, { recursive: true }) // ships a committed lockfile with png/svg
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  let r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'frozen', resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')

  // tamper the svg, frozen must reject
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')
  r = run('src/entry.js', {
    cwd: tmp,
    env: withOpts({ lock: 'frozen', resources: ['png', 'svg'] }),
    graph: ASSETS_GRAPH,
  })
  t.assert.notEqual(r.status, 0, `expected frozen rejection; stderr=${r.stderr}`)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('resources rejects code extensions', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })

  const r = run('src/entry.js', { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /resources entry 'js' is a code extension/)
}))

// ----- Metro-specific: serializer wiring + virtual modules ----------------------------

test('wrapSerializer captures the graph and delegates to the base serializer for output', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_METRO_WRAP: '1' },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // Base serializer's output round-trips through the wrapper (proves delegation).
  t.assert.match(r.stdout, /stasis-wrapped 2 modules/)
  // ...and capture still happened.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
}))

test('virtual / unresolved graph entries are skipped (no disk-backed file, no edge)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  // The graph carries a synthetic module whose path doesn't exist on disk, plus an
  // unresolved edge (target null). Both must be silently skipped, leaving only the
  // real entry + hello.js captured.
  const r = run('src/entry.js', {
    cwd: tmp,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' },
    graph: {
      modules: [
        { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js'], ['virtual:polyfill', null]] },
        { path: 'src/hello.js', deps: [] },
        { path: 'virtual:does-not-exist.js', deps: [] },
      ],
    },
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.js', 'src/hello.js'])
  // Only the real, resolved code edge is attested.
  t.assert.deepEqual(lock.imports['*']['src/entry.js'], { './hello.js': 'src/hello.js' })
}))
