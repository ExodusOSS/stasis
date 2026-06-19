// Webpack 5 variant of webpack-run.helper.js -- mirrors all knobs but imports
// the aliased `webpack5` package (npm:webpack@^5.x). Used by tests/webpack5.test.js
// to confirm StasisWebpack also works against webpack 5's NMF API shape.
//
// Usage: node tests/webpack5-run.helper.js <entry>
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- routes through the plugin's options.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees.
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.

import { resolve, join, dirname } from 'node:path'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import webpack from 'webpack5'

import { State } from '@exodus/stasis-core/state'

const workspaceNodeModules = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules')

const entries = process.argv.slice(2)
if (entries.length !== 1) {
  console.error('Usage: webpack5-run.helper.js <entry>')
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

const { StasisWebpack } = await import('../stasis/src/webpack.js')

const rulesRaw = process.env.STASIS_TEST_WEBPACK_RULES
const module_ = rulesRaw
  ? { rules: JSON.parse(rulesRaw).map((r) => (typeof r.test === 'string' ? { ...r, test: new RegExp(r.test) } : r)) }
  : undefined

const outdirEnv = process.env.STASIS_TEST_WEBPACK_OUTDIR
const dist = outdirEnv ?? await mkdtemp(join(tmpdir(), 'stasis-webpack5-test-'))
// STASIS_TEST_WEBPACK_TARGET -- override webpack's `target` (default 'node'), e.g.
// 'electron-main' to exercise a target whose externals preset externalizes 'electron'.
const target = process.env.STASIS_TEST_WEBPACK_TARGET || 'node'
try {
  const compiler = webpack({
    mode: 'none',
    target,
    entry: resolve(process.cwd(), entries[0]),
    output: { path: dist, filename: 'bundle.js' },
    ...(module_ ? { module: module_, resolveLoader: { modules: [workspaceNodeModules, 'node_modules'] } } : {}),
    plugins: [new StasisWebpack(pluginOptions)],
  })

  const stats = await promisify(compiler.run.bind(compiler))()
  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: false, errors: true, errorDetails: true }))
    process.exit(1)
  }
} finally {
  if (!outdirEnv) await rm(dist, { recursive: true, force: true })
}

if (State.preload) State.preload.write()
