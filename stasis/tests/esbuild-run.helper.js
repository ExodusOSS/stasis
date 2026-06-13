// Test harness: runs an esbuild build with the StasisEsbuild plugin against the cwd as
// the project root, then writes stasis state. Driven by tests/esbuild.test.js via
// spawnSync, so each test gets a fresh State singleton in its own process.
//
// Usage: node tests/esbuild-run.helper.js <entry> [<entry>...]
// Project root and stasis config come from process.cwd() and the EXODUS_STASIS_* env.

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

// Construct State BEFORE importing the plugin: the plugin module reads State.instance at top level.
const state = new State(process.cwd())
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
    plugins: [new StasisEsbuild()],
  })
} finally {
  await rm(dist, { recursive: true, force: true })
}

state.write()
