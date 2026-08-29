// Test harness: drives the Next.js withStasis wrapper the way `next build` does, then writes
// stasis state. Driven by tests/nextjs.test.js via spawn (one child per test), so each test gets
// a fresh State per process.
//
// Next is not a dependency of this repo, and -- like webpack/esbuild/metro -- the wrapper never
// imports it; it only wires a plugin into the webpack configs Next's build generates. So instead
// of running a real `next build`, this helper reproduces Next's driving contract faithfully:
// generate ALL compiler configs first by calling the wrapped `config.webpack(base, ctx)` once per
// compiler with a Next-shaped ctx ({ buildId, dev, isServer, nextRuntime, config, dir,
// defaultLoaders, webpack, totalPages }), then run the compilers SEQUENTIALLY as separate
// webpack() calls in this one process (build/webpack-build/impl runs server -> edge -> client).
// webpack 5 (the only webpack Next ships) does the real builds.
//
// Like the webpack helper, a preload State is constructed first by default (mirroring the
// plugin's options) so resolvePluginState lands in the reuse path; STASIS_TEST_PRELOAD=0
// exercises the standalone paths, where the deferred exit-flush write is the one under test.
//
// Usage: node tests/nextjs-run.helper.js <server-entry> <client-entry>
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- the second withStasis argument.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees.
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.
// STASIS_TEST_NEXT_USER_WEBPACK=1    -- wire a user webpack fn into the wrapped config; it tags
//                                       each config with a marker plugin, and the helper prints
//                                       USER_WEBPACK_CALLS / MARKER_PRESENT / STASIS_PLUGINS so
//                                       tests can pin chaining + plugin placement.
// STASIS_TEST_NEXT_USER_RETURNS_NOTHING=1 -- the user webpack fn forgets to return the config.
// STASIS_TEST_NEXT_WORKER=1          -- ctx.config carries experimental.webpackBuildWorker: true.
// STASIS_TEST_NEXT_FAIL=<name>       -- give that compiler a missing entry so its build errors
//                                       (the poisoned-deferred-write case).
// STASIS_TEST_NEXT_PURITY=1          -- print PURITY_* lines proving the input config object was
//                                       not mutated by withStasis.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import webpack from 'webpack5'

import { State } from '@exodus/stasis-core/state'

const entries = process.argv.slice(2)
if (entries.length !== 2) {
  console.error('Usage: nextjs-run.helper.js <server-entry> <client-entry>')
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

const { withStasis } = await import('../stasis/src/nextjs.js')

// The user's own next.config webpack hook: tags the config so tests can confirm the wrapper
// chained it (and chained it FIRST -- stasis lands after the marker).
class MarkerPlugin {
  apply() {}
}
let userWebpackCalls = 0
const userWebpack = (config, _ctx) => {
  userWebpackCalls += 1
  config.plugins.push(new MarkerPlugin())
  if (process.env.STASIS_TEST_NEXT_USER_RETURNS_NOTHING) return undefined
  return config
}

const inputConfig = {
  reactStrictMode: true,
  ...(process.env.STASIS_TEST_NEXT_USER_WEBPACK || process.env.STASIS_TEST_NEXT_USER_RETURNS_NOTHING
    ? { webpack: userWebpack }
    : {}),
}
const inputWebpackBefore = inputConfig.webpack
const config = withStasis(inputConfig, pluginOptions)

if (process.env.STASIS_TEST_NEXT_PURITY) {
  console.log(`PURITY_NEW_OBJECT=${config !== inputConfig}`)
  console.log(`PURITY_INPUT_WEBPACK_UNTOUCHED=${inputConfig.webpack === inputWebpackBefore}`)
  console.log(`PURITY_CARRIES_FIELDS=${config.reactStrictMode === true}`)
}

// The resolved-config object Next passes back into the hook as ctx.config.
const resolvedNextConfig = {
  ...config,
  experimental: process.env.STASIS_TEST_NEXT_WORKER ? { webpackBuildWorker: true } : {},
}

const dist = await mkdtemp(join(tmpdir(), 'stasis-nextjs-test-'))
const failCompiler = process.env.STASIS_TEST_NEXT_FAIL

// Compiler descriptors in Next's build order (server first, client last); each generates its
// config through the wrapped hook exactly once, like getBaseWebpackConfig does.
const compilers = [
  { name: 'server', entry: entries[0], target: 'node', nextRuntime: 'nodejs', isServer: true },
  { name: 'client', entry: entries[1], target: 'web', nextRuntime: undefined, isServer: false },
]

try {
  const configs = compilers.map((c) => {
    const base = {
      mode: 'none',
      target: c.target,
      entry: failCompiler === c.name
        ? resolve(process.cwd(), 'src/definitely-missing-entry.js')
        : resolve(process.cwd(), c.entry),
      output: { path: join(dist, c.name), filename: 'bundle.js' },
      plugins: [],
    }
    const ctx = {
      buildId: 'stasis-test',
      dev: false,
      isServer: c.isServer,
      nextRuntime: c.nextRuntime,
      dir: process.cwd(),
      config: resolvedNextConfig,
      defaultLoaders: { babel: {} },
      totalPages: 1,
      webpack,
    }
    const out = typeof config.webpack === 'function' ? config.webpack(base, ctx) : base
    if (process.env.STASIS_TEST_NEXT_USER_WEBPACK) {
      console.log(`MARKER_PRESENT_${c.name}=${out.plugins.some((p) => p instanceof MarkerPlugin)}`)
      console.log(`STASIS_PLUGINS_${c.name}=${out.plugins.filter((p) => p.constructor.name === 'StasisWebpack').length}`)
      // Stasis must see the FINAL config: it lands after the user's marker plugin.
      console.log(`STASIS_AFTER_MARKER_${c.name}=${out.plugins.findIndex((p) => p.constructor.name === 'StasisWebpack') > out.plugins.findIndex((p) => p instanceof MarkerPlugin)}`)
    }
    console.log(`PLUGINS_${c.name}=${out.plugins.length}`)
    return out
  })

  // The wrapper must hand every compiler config the SAME plugin instance -- a fresh instance per
  // config would mint one State per compiler, each writing a partial artifact over the others'.
  const stasisInstances = new Set(
    configs.flatMap((c) => c.plugins.filter((p) => p.constructor.name === 'StasisWebpack'))
  )
  console.log(`STASIS_INSTANCES=${stasisInstances.size}`)

  // Sequential runs, like Next's runCompiler: one webpack() call per config.
  for (const [i, c] of configs.entries()) {
    const compiler = webpack(c)
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: Next builds its compilers one after another
    const stats = await promisify(compiler.run.bind(compiler))()
    // eslint-disable-next-line no-await-in-loop -- see above
    await promisify(compiler.close.bind(compiler))()
    console.log(`BUILD_${compilers[i].name}=${stats.hasErrors() ? 'failed' : 'ok'}`)
    // Next aborts the remaining compilers when one fails.
    if (stats.hasErrors()) {
      console.error(stats.toString({ colors: false, errors: true }))
      process.exitCode = 1
      break
    }
  }
} finally {
  await rm(dist, { recursive: true, force: true })
}

if (State.preload) State.preload.write()
