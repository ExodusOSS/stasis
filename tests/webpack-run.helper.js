// Test harness: runs a webpack build with the StasisWebpack plugin against the cwd
// as the project root, then writes stasis state. Driven by tests/webpack.test.js
// via spawnSync, so each test gets a fresh State per process.
//
// Important: by default this helper constructs a preload State first (mirroring the
// plugin's options onto it) so the plugin's resolvePluginState call lands in the
// "reuse preload" path (rules 3/5). This matches how the plugin runs under the real
// stasis loader, but it means env-driven and option-driven test cases here exercise
// the unified-lockfile + reuse code path, NOT a standalone-plugin one. To exercise
// the standalone / noop / hard-throw paths, set STASIS_TEST_PRELOAD=0 in the test's
// env so no preload is constructed.
//
// Usage: node tests/webpack-run.helper.js <entry>
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- routes through the plugin's options.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees; without it
//                                       the helper mirrors the plugin's options. Use
//                                       this to construct a preload at one bundleFile
//                                       and a plugin at another (rule 6 / sidecar).
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.

import { resolve, join } from 'node:path'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import webpack from 'webpack'

import { State } from '../src/state.js'

const entries = process.argv.slice(2)
if (entries.length !== 1) {
  console.error('Usage: webpack-run.helper.js <entry>')
  process.exit(2)
}

const pluginOptionsRaw = process.env.STASIS_TEST_PLUGIN_OPTIONS
const pluginOptions = pluginOptionsRaw ? JSON.parse(pluginOptionsRaw) : undefined

// See esbuild-run.helper.js for the rationale -- by default we construct a preload State
// so the plugin runs as it would under the stasis loader; STASIS_TEST_PRELOAD=0 opts the
// test out so standalone/noop paths can be exercised.
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

const { StasisWebpack } = await import('../src/webpack.js')

const dist = await mkdtemp(join(tmpdir(), 'stasis-webpack-test-'))
try {
  const compiler = webpack({
    mode: 'none',
    target: 'node',
    entry: resolve(process.cwd(), entries[0]),
    output: { path: dist, filename: 'bundle.js' },
    plugins: [new StasisWebpack(pluginOptions)],
  })

  const stats = await promisify(compiler.run.bind(compiler))()
  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: false, errors: true, errorDetails: true }))
    process.exit(1)
  }
} finally {
  await rm(dist, { recursive: true, force: true })
}

if (State.preload) State.preload.write()
