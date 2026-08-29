import assert from 'node:assert/strict'

import { resolvePluginState } from './plugins.js'
import { StasisWebpack } from './webpack.js'
import { validatePluginOptions } from '@exodus/stasis-core/config'
import { isLoaderInstalled } from '@exodus/stasis-core/hooks'
import { State } from '@exodus/stasis-core/state'

// Next.js integration: wraps a next.config so ONE shared StasisWebpack instance lands in every
// webpack compiler config Next builds. `next build` generates the client/server/edge-server
// configs by calling the config's `webpack(config, ctx)` hook once each, then runs the compilers
// as SEQUENTIAL webpack() calls in one process -- so the instance must be shared (a fresh plugin
// per hook call would mint one State per compiler, each writing a partial lockfile/bundle over
// the others'), and it must know more compilers are coming (the multiCompiler wiring hint defers
// the capture write to a single end-of-process flush; compiler #1's `done` fires before the later
// compilers ever apply). Wire it permanently, like StasisMetro's withStasis: without stasis env,
// options, or a preload the plugin resolves inert (resolvePluginState rule 0), so a plain
// `next build`/`next dev` is untouched.
//
// Capture is one-shot: `next dev` watch rebuilds are refused by StasisWebpack's watchRun tap.
// KNOWN LIMITATION: the RSC layers resolve `react-server` conditions and Next's vendored
// react -- the capture attests what THIS build's webpack resolvers actually resolved, so that is
// covered; only Turbopack builds (which never call the webpack hook) are not, and are refused
// below where detectable.

// True when this process/config-load looks headed for an ACTIVE stasis mode -- mirroring
// resolvePluginState's activation signals (rules 0/7) without constructing a State: explicit
// lock/bundle options (minus the both-'none' opt-out), an ambient preload or installed loader,
// or the EXODUS_STASIS_LOCK env `stasis run` always exports.
function stasisIntent(options) {
  if (options.lock === 'none' && options.bundle === 'none') return false
  if (options.lock !== undefined || options.bundle !== undefined) return true
  if (State.preload || isLoaderInstalled()) return true
  return process.env.EXODUS_STASIS_LOCK !== undefined
}

// Idiomatic Next-config wrapper: returns a new next config (pure -- `nextConfig` is not mutated)
// whose `webpack` hook chains the user's own hook and then registers stasis on the final config.
export function withStasis(nextConfig = {}, options = {}) {
  // Object configs only. A function config (`(phase, ctx) => config`) must be resolved by the
  // caller first -- wrapping it here would hide WHICH config object the hook was attached to.
  assert.ok(nextConfig !== null && typeof nextConfig === 'object' && !Array.isArray(nextConfig),
    'StasisNextJS: withStasis takes a next config OBJECT; a function config must be resolved first ' +
    '(e.g. `export default async (phase, ctx) => withStasis(await base(phase, ctx))`)')
  // Validate at wrap time (config definition), not first build, so a typo'd option fails loudly
  // wherever the config is loaded. resolvePluginState re-validates later; this is pure and cheap.
  validatePluginOptions('StasisNextJS', options)

  // Turbopack runs no webpack compilers, so the hook below would simply never fire: an active
  // capture would exit 0 with nothing attested (or, under a preload, write a lockfile silently
  // missing every webpack-compiled dependency). The Next CLI exports TURBOPACK before loading
  // this config, which is the only observable signal at wrap time -- best-effort, fail closed.
  if (process.env.TURBOPACK && stasisIntent(options)) {
    throw new Error(
      'StasisNextJS: Turbopack never runs the webpack hooks stasis captures through, so this ' +
      'build cannot be attested -- build with webpack (drop --turbopack; on Next 16+ pass ' +
      "--webpack) or opt stasis out for this run (lock='none' + bundle='none', or drop the stasis env)"
    )
  }

  const userWebpack = nextConfig.webpack
  // One resolution per process, shared by every compiler config this build generates. Deferred to
  // the first hook call so merely LOADING the config (next start, next lint, the build's parent
  // process under webpackBuildWorker) never constructs a State.
  let resolved
  return {
    ...nextConfig,
    webpack(config, ctx) {
      const chained = typeof userWebpack === 'function' ? userWebpack(config, ctx) : config
      // Next's own "did you forget to return" error only guards OUR return value; a user hook
      // that forgot to return would otherwise surface as a confusing crash on `.plugins` below.
      assert.ok(chained !== null && typeof chained === 'object',
        `StasisNextJS: the wrapped webpack() hook returned ${chained === null ? 'null' : typeof chained} -- return the config`)

      if (resolved === undefined) {
        const { state } = resolvePluginState('StasisNextJS', options, process.cwd())
        resolved = {
          state,
          plugin: state ? new StasisWebpack(state, { multiCompiler: true }) : null, // null -> inert
        }
      }
      const { state, plugin } = resolved
      if (!plugin) return chained

      // experimental.webpackBuildWorker runs each compiler in its OWN child process: this hook
      // then runs per worker, so each would resolve its own State and write only its compiler's
      // slice to the same lockfile/bundle path -- last write wins, silently under-attesting the
      // other two compilers. Next only auto-enables the worker when no custom webpack hook is
      // configured (this wrapper is one), so refusing covers exactly the explicit opt-in.
      // Verify/load modes stay allowed: they write nothing, and each worker verifies its own slice.
      if ((state.config.writeLockfile || state.config.writeBundle) && ctx?.config?.experimental?.webpackBuildWorker) {
        throw new Error(
          'StasisNextJS: experimental.webpackBuildWorker builds each compiler in a separate ' +
          "process, so their captures would overwrite one another's lockfile/bundle -- set " +
          'experimental: { webpackBuildWorker: false } for stasis builds'
        )
      }

      ;(chained.plugins ??= []).push(plugin)
      return chained
    },
  }
}
