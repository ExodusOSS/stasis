// Test harness: runs an esbuild build with the StasisEsbuild plugin against the cwd as
// the project root, then writes stasis state. Driven by tests/esbuild.test.js via
// spawnSync, so each test gets a fresh State per process.
//
// Important: by default this helper constructs a preload State first (mirroring the
// plugin's options onto it) so the plugin's resolvePluginState call lands in the
// "reuse preload" path (rules 3/5). This matches how the plugin runs under the real
// stasis loader, but it means env-driven and option-driven test cases here exercise
// the unified-lockfile + reuse code path, NOT a standalone-plugin one. To exercise
// the standalone / noop / hard-throw paths, set STASIS_TEST_PRELOAD=0 in the test's
// env so no preload is constructed.
//
// Usage: node tests/esbuild-run.helper.js <entry> [<entry>...]
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- routes through the plugin's options.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees; without it
//                                       the helper mirrors the plugin's options. Use
//                                       this to construct a preload at one bundleFile
//                                       and a plugin at another (rule 6 / sidecar).
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.

import { resolve, join } from 'node:path'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as esbuild from 'esbuild'

import { State } from '../src/state.js'

const entries = process.argv.slice(2)
if (entries.length === 0) {
  console.error('Usage: esbuild-run.helper.js <entry> [...]')
  process.exit(2)
}

const pluginOptionsRaw = process.env.STASIS_TEST_PLUGIN_OPTIONS
const pluginOptions = pluginOptionsRaw ? JSON.parse(pluginOptionsRaw) : undefined

// By default the helper constructs a preload State so the plugin runs as it would under
// the stasis loader. Plugin options (when present) are mirrored onto the preload so the
// plugin's reuse path passes the assertOptionsMatchConfig check.
// STASIS_TEST_PRELOAD=0 opts the test out of preload to exercise standalone/noop paths.
const KNOWN_OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'debug']
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

const { StasisEsbuild } = await import('../src/esbuild.js')

const dist = await mkdtemp(join(tmpdir(), 'stasis-esbuild-test-'))
try {
  await esbuild.build({
    entryPoints: entries.map((e) => resolve(process.cwd(), e)),
    bundle: true,
    outdir: dist,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [new StasisEsbuild(pluginOptions)],
  })
} finally {
  await rm(dist, { recursive: true, force: true })
}

// Write whichever live State owns its respective output. With a preload that's the
// preload (lockfile + same-path bundle); a sidecar plugin would have written its bundle
// already through its own write() during exit hooks. For these tests there is no exit
// hook installed, so we explicitly write the preload here.
if (State.preload) State.preload.write()
