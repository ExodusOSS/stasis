// Test harness: runs a webpack build with the StasisWebpack plugin against the cwd
// as the project root, then writes stasis state. Driven by tests/webpack.test.js
// via spawnSync, so each test gets a fresh State per process.
//
// Usage: node tests/webpack-run.helper.js <entry>
// STASIS_TEST_PLUGIN_OPTIONS (JSON) routes through the plugin's options.
// STASIS_TEST_PRELOAD=0 disables the preload State (simulates "no stasis loader").

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
const preloadOptions = { preload: true }
if (pluginOptions) {
  for (const k of KNOWN_OPTION_KEYS) {
    if (pluginOptions[k] !== undefined) preloadOptions[k] = pluginOptions[k]
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
