// Test harness: runs an esbuild build with the StasisEsbuild plugin against the cwd as
// the project root, then writes stasis state. Driven by tests/esbuild.test.js via
// spawnSync, so each test gets a fresh State singleton in its own process.
//
// Usage: node tests/esbuild-run.helper.js <entry> [<entry>...]
// If STASIS_TEST_PLUGIN_OPTIONS is set in env (JSON-encoded), pass them to the plugin
// constructor and let it construct State. Otherwise pre-construct State via env vars.

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

const _preState = pluginOptions === undefined ? new State(process.cwd()) : undefined

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

State.instance.write()
