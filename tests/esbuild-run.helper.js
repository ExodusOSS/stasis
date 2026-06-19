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

import { State } from '@exodus/stasis-core/state'

const entries = process.argv.slice(2)
if (entries.length === 0) {
  console.error('Usage: esbuild-run.helper.js <entry> [...]')
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

const { StasisEsbuild } = await import('../stasis/src/esbuild.js')

// STASIS_TEST_ESBUILD_LOADER (JSON) -- optional esbuild `loader` map, e.g.
// { ".png": "file", ".svg": "file" } so the build mirrors a real asset-copying config.
const loaderRaw = process.env.STASIS_TEST_ESBUILD_LOADER
const loader = loaderRaw ? JSON.parse(loaderRaw) : undefined

// STASIS_TEST_ESBUILD_OUTDIR -- when set, esbuild writes its build output to this
// directory (instead of a throwaway tmpdir). Used by round-trip tests that need to
// compare capture-mode output against load-mode output byte-for-byte.
const outdirEnv = process.env.STASIS_TEST_ESBUILD_OUTDIR
const dist = outdirEnv ?? await mkdtemp(join(tmpdir(), 'stasis-esbuild-test-'))
const writeOutput = Boolean(outdirEnv)
// STASIS_TEST_ESBUILD_EXTERNAL (JSON array) -- optional esbuild `external` list,
// e.g. ["electron"] so the build externalizes a non-builtin module the way a real
// app config would (esbuild has no electron preset; externals are user-declared).
const externalRaw = process.env.STASIS_TEST_ESBUILD_EXTERNAL
const external = externalRaw ? JSON.parse(externalRaw) : undefined
try {
  await esbuild.build({
    entryPoints: entries.map((e) => resolve(process.cwd(), e)),
    bundle: true,
    outdir: dist,
    platform: 'node',
    format: 'esm',
    write: writeOutput,
    logLevel: 'silent',
    ...(loader ? { loader } : {}),
    ...(external ? { external } : {}),
    plugins: [new StasisEsbuild(pluginOptions)],
  })
} finally {
  if (!writeOutput) await rm(dist, { recursive: true, force: true })
}

if (State.preload) State.preload.write()
