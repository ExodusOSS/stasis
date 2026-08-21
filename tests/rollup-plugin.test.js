// Direct (in-process) regression tests for StasisRollup's sibling-plugin interop and fail-closed
// behaviors -- scenarios that need a custom sibling plugin in the same build, which the spawned,
// env-driven suite in rollup.test.js can't express. Real rollup builds over caller-owned States
// (like plugins-rebuild-refusal.test.js), with absolute inputs so no chdir is needed.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { rollup } from 'rollup'

import { State } from '@exodus/stasis-core/state'
import { StasisRollup } from '@exodus/stasis-plugins/rollup'

const decode = (p) => JSON.parse(brotliDecompressSync(readFileSync(p)))

// Throwaway project dir: a package.json anchoring State's root, plus the given files.
const project = (t, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-rollup-direct-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const build = async (input, plugins, extra = {}) => {
  const bundle = await rollup({ input, plugins, ...extra, logLevel: 'silent', onwarn: () => {} })
  try {
    const { output } = await bundle.generate({ format: 'es' })
    return { output, cache: bundle.cache }
  } finally {
    await bundle.close()
  }
}

test('capture refuses a query-suffixed module id instead of silently under-attesting', async (t) => {
  const dir = project(t, {
    'entry.js': "import icon from './icon.svg'\nexport default icon\n",
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  })
  // A raw-loader-style sibling: resolves to '<abs>?url' and loads by stripping the query, reading
  // the DISK file -- the id can't round-trip, but its bytes feed the build, so skipping it would
  // leave a build input invisible to frozen verification.
  const querySibling = {
    name: 'query-assets',
    resolveId(source, importer) {
      return source.endsWith('.svg') && importer ? `${join(dir, 'icon.svg')}?url` : null
    },
    load(id) {
      if (!id.endsWith('.svg?url')) return null
      return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`
    },
  }
  const plugin = new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile: join(dir, 's.br'), resources: ['svg'] }))
  await t.assert.rejects(
    build(join(dir, 'entry.js'), [plugin, querySibling]),
    /StasisRollup: can't attest suffixed module id/,
  )
})

test('a warm rollup cache is stripped: capture still records edges (and warns)', async (t) => {
  const dir = project(t, {
    'entry.js': "import { h } from './dep.js'\nexport const v = h\n",
    'dep.js': 'export const h = 1\n',
  })
  const mk = (name) => new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile: join(dir, name) }))
  const fresh = await build(join(dir, 'entry.js'), [mk('a.br')])
  // Reusing a previous build's cache makes rollup skip resolveId/load for cached modules; the
  // plugin's options hook must strip it, or the warm capture records no edges at all.
  const warn = t.mock.method(console, 'warn', () => {})
  await build(join(dir, 'entry.js'), [mk('b.br')], { cache: fresh.cache })
  t.assert.equal(warn.mock.calls.length, 1)
  t.assert.match(warn.mock.calls[0].arguments[0], /StasisRollup: ignoring the `cache` option/)
  t.assert.deepEqual(decode(join(dir, 'b.br')).imports, decode(join(dir, 'a.br')).imports,
    'warm-cache capture must record the same edges as a fresh one')
  t.assert.deepEqual(decode(join(dir, 'b.br')).entries, ['entry.js'])
})

test("a sibling's bare this.resolve() probe neither widens capture entries nor aborts load", async (t) => {
  const dir = project(t, {
    'entry.js': "import { h } from './hello.js'\nexport const v = h\n",
    'hello.js': 'export const h = 1\n',
  })
  // rollup defaults isEntry to !importer for this.resolve, so the probe arrives entry-flagged;
  // entries must come from the graph, not that flag.
  const prober = { name: 'prober', async buildStart() { await this.resolve(join(dir, 'hello.js')) } }
  const bundleFile = join(dir, 's.br')
  const cap = await build(join(dir, 'entry.js'),
    [new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile })), prober])
  t.assert.deepEqual(decode(bundleFile).entries, ['entry.js'],
    'a probed import must not be attested as a runnable root')
  const load = await build(join(dir, 'entry.js'),
    [new StasisRollup(new State(dir, { lock: 'none', bundle: 'load', bundleFile })), prober])
  t.assert.equal(load.output[0].code, cap.output[0].code, 'probe-tolerant load round-trips byte-identically')
})

test('load mode defers a sibling resolve(spec, undefined, { isEntry: false }) instead of crashing', async (t) => {
  const dir = project(t, {
    'entry.js': "import { h } from './hello.js'\nexport const v = h\n",
    'hello.js': 'export const h = 1\n',
  })
  const bundleFile = join(dir, 's.br')
  await build(join(dir, 'entry.js'), [new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile }))])
  let probed = 'unset'
  const prober = {
    name: 'prober',
    async buildStart() { probed = await this.resolve('some-bare-specifier', undefined, { isEntry: false }) },
  }
  await build(join(dir, 'entry.js'),
    [new StasisRollup(new State(dir, { lock: 'none', bundle: 'load', bundleFile })), prober])
  t.assert.equal(probed, null, 'the probe defers (no TypeError, no phantom resolution)')
})

test('a resource entry is refused loudly (StasisEsbuild parity), not silently left out of entries', async (t) => {
  const dir = project(t, { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n' })
  const assetSibling = {
    name: 'assets',
    load(id) { return id.endsWith('.svg') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))}` : null },
  }
  const plugin = new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile: join(dir, 's.br'), resources: ['svg'] }))
  await t.assert.rejects(build(join(dir, 'icon.svg'), [plugin, assetSibling]), /a resource can't be an entry/)
})

test("an emitFile'd chunk (relative id + importer) round-trips capture -> load", async (t) => {
  const dir = project(t, {
    'entry.js': 'export const v = 1\n',
    'worker.js': 'export const w = 2\n',
  })
  const emitter = {
    name: 'emitter',
    buildStart() { this.emitFile({ type: 'chunk', id: './worker.js', importer: join(dir, 'entry.js') }) },
  }
  const bundleFile = join(dir, 's.br')
  const cap = await build(join(dir, 'entry.js'),
    [new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile })), emitter])
  t.assert.deepEqual(decode(bundleFile).entries.toSorted(), ['entry.js', 'worker.js'],
    'the emitted chunk is a genuine runnable root')
  const load = await build(join(dir, 'entry.js'),
    [new StasisRollup(new State(dir, { lock: 'none', bundle: 'load', bundleFile })), emitter])
  t.assert.deepEqual(load.output.map((o) => o.code), cap.output.map((o) => o.code),
    'the emitted chunk resolves against its importer at load, not cwd')
})

test('node_modules scope: nm files serve from the bundle while a workspace resource stays on disk', async (t) => {
  const dir = project(t, {
    'entry.js': "import icon from './icon.svg'\nimport { d } from 'dep'\nexport const v = icon + d\n",
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
    'node_modules/dep/index.js': 'export const d = 2\n',
  })
  const nodeResolveSibling = {
    name: 'nr',
    resolveId(s, i) { return s === 'dep' && i ? join(dir, 'node_modules/dep/index.js') : null },
  }
  const assetSibling = {
    name: 'assets',
    load(id) { return id.endsWith('.svg') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))}` : null },
  }
  const bundleFile = join(dir, 's.br')
  const mk = (bundle) => new StasisRollup(new State(dir, { scope: 'node_modules', lock: 'none', bundle, bundleFile, resources: ['svg'] }))
  const cap = await build(join(dir, 'entry.js'), [mk('add'), nodeResolveSibling, assetSibling])
  // nm-scope semantics serve workspace files from disk, so the attested svg edge must not trip
  // the load-mode resource refusal -- that gate is for resources the bundle would have to serve.
  const load = await build(join(dir, 'entry.js'), [mk('load'), nodeResolveSibling, assetSibling])
  t.assert.equal(load.output[0].code, cap.output[0].code,
    'nm-scope capture -> load round-trips with a workspace resource')
})

test('an import that resolves outside the project root is refused with a contextual error', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'stasis-rollup-outer-'))
  t.after(() => rmSync(outer, { recursive: true, force: true }))
  writeFileSync(join(outer, 'outside.js'), 'export const o = 1\n')
  const dir = join(outer, 'app')
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }))
  // Pin root discovery to the app dir (like the spawned fixtures do), so ../outside.js escapes it.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(dir, 'entry.js'), "import { o } from '../outside.js'\nexport const v = o\n")
  const plugin = new StasisRollup(new State(dir, { lock: 'none', bundle: 'add', bundleFile: join(dir, 's.br') }))
  await t.assert.rejects(
    build(join(dir, 'entry.js'), [plugin]),
    /resolves outside the project root and can't be attested: .*outside\.js/,
  )
})

test('the esbuild-style second constructor argument is refused, not silently ignored', (t) => {
  t.assert.throws(
    () => new StasisRollup({ lock: 'none', bundle: 'none' }, { transform: () => {} }),
    /StasisRollup takes a single options argument/,
  )
})
