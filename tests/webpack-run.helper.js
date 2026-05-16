// Test harness: runs a webpack build with the StasisWebpack plugin against the cwd
// as the project root, then writes stasis state. Driven by tests/webpack.test.js
// via spawnSync, so each test gets a fresh State singleton in its own process.
//
// Usage: node tests/webpack-run.helper.js <entry>
// Project root and stasis config come from process.cwd() and the EXODUS_STASIS_* env.

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

// Construct State BEFORE importing the plugin: the plugin module reads State.instance at top level.
const state = new State(process.cwd())
const { StasisWebpack } = await import('../src/webpack.js')

const dist = await mkdtemp(join(tmpdir(), 'stasis-webpack-test-'))
try {
  const compiler = webpack({
    mode: 'none',
    target: 'node',
    entry: resolve(process.cwd(), entries[0]),
    output: { path: dist, filename: 'bundle.js' },
    plugins: [new StasisWebpack()],
  })

  const stats = await promisify(compiler.run.bind(compiler))()
  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: false, errors: true, errorDetails: true }))
    process.exit(1)
  }
} finally {
  await rm(dist, { recursive: true, force: true })
}

state.write()
