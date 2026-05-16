// Test harness: runs a webpack build with the StasisWebpack plugin against the cwd
// as the project root, then writes stasis state. Driven by tests/webpack.test.js
// via spawnSync, so each test gets a fresh State singleton in its own process.
//
// Usage: node tests/webpack-run.helper.js <entry>
// If STASIS_TEST_PLUGIN_OPTIONS is set in env (JSON-encoded), pass them to the plugin
// constructor and let it construct State. Otherwise pre-construct State via env vars.

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

// Without explicit plugin options, pre-construct State so env vars drive Config.
// With plugin options, defer to the plugin so its options drive Config.
const _preState = pluginOptions === undefined ? new State(process.cwd()) : undefined

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

State.instance.write()
