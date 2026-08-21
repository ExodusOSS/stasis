// Test harness: runs a rollup build with the StasisRollup plugin against the cwd as
// the project root, then writes stasis state. Driven by tests/rollup.test.js via
// spawn (one child per test), so each test gets a fresh State per process.
//
// Important: by default this helper constructs a preload State first (mirroring the
// plugin's options onto it) so the plugin's resolvePluginState call lands in the
// "reuse preload" path (rules 3/5). This matches how the plugin runs under the real
// stasis loader, but it means env-driven and option-driven test cases here exercise
// the unified-lockfile + reuse code path, NOT a standalone-plugin one. To exercise
// the standalone / noop / hard-throw paths, set STASIS_TEST_PRELOAD=0 in the test's
// env so no preload is constructed.
//
// Rollup core resolves only relative/absolute specifiers and parses only JS, so the
// build includes minimal stand-ins for the sibling plugins a real config would have
// (node-resolve, @rollup/plugin-json, an asset loader) -- wired AFTER StasisRollup,
// the ordering the plugin requires. They also exercise the sibling-plugin chain:
// capture resolutions flow through ctx.resolve into the shim, and asset loads read
// the disk themselves exactly like @rollup/plugin-url would.
//
// Usage: node tests/rollup-run.helper.js <entry> [<entry>...]
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- routes through the plugin's options.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees; without it
//                                       the helper mirrors the plugin's options. Use
//                                       this to construct a preload at one bundleFile
//                                       and a plugin at another (rule 6 / sidecar).
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.

import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { rollup } from 'rollup'

import { State } from '@exodus/stasis-core/state'

const entries = process.argv.slice(2)
if (entries.length === 0) {
  console.error('Usage: rollup-run.helper.js <entry> [...]')
  process.exit(2)
}

const pluginOptionsRaw = process.env.STASIS_TEST_PLUGIN_OPTIONS
const pluginOptions = pluginOptionsRaw ? JSON.parse(pluginOptionsRaw) : undefined

const KNOWN_OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'debug', 'resources']
const preloadOptionsRaw = process.env.STASIS_TEST_PRELOAD_OPTIONS
const preloadOverrides = preloadOptionsRaw ? JSON.parse(preloadOptionsRaw) : undefined
const preloadOptions = { preload: true }
const sourceForPreload = preloadOverrides ?? pluginOptions
if (sourceForPreload) {
  for (const k of KNOWN_OPTION_KEYS) {
    if (sourceForPreload[k] !== undefined) preloadOptions[k] = sourceForPreload[k]
  }
}
const preloadDisabled = process.env.STASIS_TEST_PRELOAD === '0'
const _preload = preloadDisabled ? undefined : new State(process.cwd(), preloadOptions)

const { StasisRollup } = await import('../stasis/src/rollup.js')

// Bare-specifier resolver stand-in (rollup core has none): main-field lookup under the
// project's node_modules, enough for the nm fixture. Runs after StasisRollup, so at
// capture it answers through the plugin's ctx.resolve and at bundle=load it is only
// reached for edges the bundle does not attest.
const nodeResolveShim = {
  name: 'test-node-resolve',
  resolveId(source, importer) {
    if (!importer || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null
    if (source.startsWith('node:')) return null
    const dir = join(process.cwd(), 'node_modules', source)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return null
    const target = join(dir, JSON.parse(readFileSync(pkgPath, 'utf8')).main ?? 'index.js')
    return existsSync(target) ? target : null
  },
}

// @rollup/plugin-json stand-in: same mechanics (a transform, so it consumes whatever
// the load chain produced -- attested bytes under bundle=load included).
const jsonShim = {
  name: 'test-json',
  transform(code, id) {
    if (extname(id) !== '.json') return null
    return { code: `export default ${code.trim()}`, map: null }
  },
}

// STASIS_TEST_ROLLUP_ASSETS=1 -- add an @rollup/plugin-url-style asset loader for
// png/svg/css: reads the file from DISK itself (the behavior that makes attested replay
// impossible under bundle=load) and exports a deterministic content-derived string.
const assetShim = {
  name: 'test-assets',
  load(id) {
    const ext = extname(id)
    if (ext !== '.png' && ext !== '.svg' && ext !== '.css') return null
    const bytes = readFileSync(id)
    return `export default ${JSON.stringify(`asset:${basename(id)}:${bytes.length}`)}`
  },
}

// STASIS_TEST_ROLLUP_EXTERNAL (JSON array) -- rollup `external` list, e.g. ["electron"],
// so the build externalizes a non-builtin module the way a real app config would.
const externalRaw = process.env.STASIS_TEST_ROLLUP_EXTERNAL
const external = externalRaw ? JSON.parse(externalRaw) : undefined

const plugins = [new StasisRollup(pluginOptions), nodeResolveShim, jsonShim]
if (process.env.STASIS_TEST_ROLLUP_ASSETS === '1') plugins.push(assetShim)

const bundle = await rollup({
  input: entries.map((e) => resolve(process.cwd(), e)),
  plugins,
  ...(external ? { external } : {}),
  logLevel: 'silent',
  onwarn: () => {},
})
try {
  // STASIS_TEST_ROLLUP_OUTDIR -- when set, rollup writes its build output to this
  // directory. Used by round-trip tests that need to compare capture-mode output
  // against load-mode output byte-for-byte; otherwise generate in-memory only.
  const outdir = process.env.STASIS_TEST_ROLLUP_OUTDIR
  if (outdir) await bundle.write({ dir: outdir, format: 'es' })
  else await bundle.generate({ format: 'es' })
} finally {
  await bundle.close()
}

if (State.preload) State.preload.write()
