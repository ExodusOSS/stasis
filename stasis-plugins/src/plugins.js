// Plugin <-> preload coordination (resolvePluginState): decides which State a bundler
// plugin drives, given its options and the ambient preload. The per-file classification
// helpers (pathExt / parseResourcesOption / classifyExtension) live in util.js -- they're
// pure and shared with State's `--fs` capture, so both paths classify against one source
// of truth. Kept out of state.js because the coordination only consults State.preload +
// Config helpers, never State internals.

import assert from 'node:assert/strict'

import { DEFAULT_LOCK, assertOptionsMatchConfig, validatePluginOptions } from '@exodus/stasis-core/config'
import { ensureStateForLoader, isLoaderInstalled } from '@exodus/stasis-core/hooks'
import { State } from '@exodus/stasis-core/state'
import { extSetsEqual, parseResourcesOption } from '@exodus/stasis-core/util'

// Decides which State a bundler plugin (StasisWebpack / StasisEsbuild) should run against,
// given its constructor options and the ambient preload (or lack thereof). Returns either
// { state: null, isNoop: true } -- plugin should register no hooks and become inert -- or
// { state, isNoop: false } -- plugin should drive the returned State.
//
// The lockfile is always unified: a plugin never specifies its own lockfile position
// (validatePluginOptions rejects `lockFile`). When an ambient preload exists the plugin
// MUST share it -- it either reuses the preload State outright or runs as a sidecar that
// shares the preload's hashes/entries/modules + lockfile data. Only the BUNDLE may split
// off per-plugin (via bundleFile, a sidecar). A process that genuinely needs a non-default
// lockfile location sets it process-wide (Config / EXODUS_STASIS_LOCK_FILE), not per-plugin.
//
// Rules:
//  1. Plugin asking for any lockfile mode other than 'none' / 'ignore' requires a preload.
//     Without one it's a hard throw -- the lockfile would otherwise only cover the bundled
//     app and silently miss every dependency the bundler itself pulled in. EXCEPTION: a
//     plugin given NO capture options at all (neither lock nor bundle) and NOT running under
//     `stasis run` is inert -- it does nothing (Rule 0) rather than throwing, so wiring the
//     plugin into a config is safe on a plain build. Capture then activates only under
//     `stasis run` (which governs the mode via its env) or when explicit options ask for it.
//  2. With a preload, the plugin's lock mode must agree with the preload's.
//  3. Lockfile is unified: when plugin and preload align we reuse the preload State so a
//     single lockfile is written.
//  4. Bundle may split: with a preload that already has bundle on, the plugin cannot disable
//     bundle and the bundle mode must match. The plugin's bundleFile, however, may differ
//     -- in which case we construct a sidecar State sharing the preload's lockfile data.
//  5. Same bundleFile (or unspecified) reuses the preload State.
//  6. Different bundleFile creates a sidecar.
//  7. Plugin with lock='none' AND bundle='none' and no preload is a no-op (lets framework
//     plugins be env-controlled off without throwing on the lock=none/bundle=none invariant).
export function resolvePluginState(label, options, cwd) {
  validatePluginOptions(label, options)
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, childProcess, resources } = options
  // Same-instance fast path: the plugin's stasis-core IS the binary's, the
  // hooks are installed, but the lazy initState hasn't fired yet (plugin
  // ran AHEAD of the first user-file load -- webpack constructs plugins
  // during config-parse before user code executes). Force-init now so the
  // plugin lands in the ambient branch and inherits the loader's Config.
  // We deliberately do NOT do this when the loader is a SEPARATE module
  // instance (different stasis-core copy in the plugin's node_modules vs
  // the binary's): force-init there would create a phantom State.preload
  // with its own beforeExit/exit save handlers that race the real loader's
  // lockfile write. Cross-instance detection lives below via env vars.
  if (!State.preload && isLoaderInstalled()) ensureStateForLoader()
  const ambient = State.preload

  if (!ambient) {
    // Cross-instance "running under stasis run" detection: `stasis run`'s bin script exports
    // EXODUS_STASIS_LOCK on the spawned child for every run (unconditionally -- even at its own
    // `--lock` default of `none`, a non-writing mode), so the env var is a reliable process-wide
    // signal regardless of which stasis-core copy is hosting this code. When set, the runtime's
    // loader is providing full lockfile coverage for the process; the plugin's lockfile (at its
    // own path, typically a sidecar like `sources.stasis.lock.json`) is a sibling artifact
    // covering bundler-side resolutions.
    const underStasisRun = process.env.EXODUS_STASIS_LOCK !== undefined

    // Rule 0: no preload, not under `stasis run`, and no capture instruction (neither lock nor
    // bundle given) -- the plugin has nothing telling it to capture, so it does NOTHING instead
    // of defaulting to a writing lock and demanding a preload. This is what lets a bare
    // `withStasis(config)` / `new StasisWebpack()` / `new StasisEsbuild()` sit inertly in a
    // config on a plain (non-stasis) build. Capture is governed elsewhere: `stasis run` sets
    // EXODUS_STASIS_LOCK (so this branch is skipped and Config below adopts the env-driven
    // lock/scope/bundle), or the caller passes explicit lock/bundle options. Config's
    // DEFAULT_LOCK is untouched -- it still governs a run UNDER the loader, which never reaches
    // this branch.
    if (!underStasisRun && lock === undefined && bundle === undefined) {
      return { state: null, isNoop: true }
    }

    if (lock === 'none' && bundle === 'none') return { state: null, isNoop: true } // Rule 7
    // Rule 7 needs BOTH to be 'none'. A partial opt-out -- one field is 'none' but
    // the other was simply omitted -- would otherwise fall through to either a
    // misleading Rule 1 throw about the default lockfile mode, or to Config's
    // generic "stasis needs a lockfile or a bundle" RangeError. Catch the partial
    // case explicitly. Only fires when the OTHER field is undefined: an active
    // bundle mode like `bundle:'load'` / `'frozen'` / `'add'` paired with
    // `lock:'none'` is a legitimate "bundle as trust root" config that Config
    // accepts (see config.js's bundle=load / bundle=frozen rules). (Rule 0 already
    // returned for the neither-given case, so at least one of lock/bundle is set here.)
    if ((lock === 'none' && bundle === undefined) || (bundle === 'none' && lock === undefined)) {
      throw new Error(
        `${label}: to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none' ` +
        `(got lock=${lock === undefined ? `default '${DEFAULT_LOCK}'` : `'${lock}'`}, ` +
        `bundle=${bundle === undefined ? 'default' : `'${bundle}'`})`
      )
    }
    // A writing/verifying effective lock (add|replace|frozen) still needs a preload UNLESS we're
    // under stasis run, whose loader provides full lockfile coverage -- there the "lock=add needs
    // a preload" rationale doesn't apply and Config picks up the env-var defaults. Rule 0 already
    // returned for the neither-given case, but `lock` can still be undefined here when only a
    // writing `bundle` was passed (e.g. `{ bundle: 'add' }`, which defaults lock to add) -- so
    // the message distinguishes the defaulted mode from an explicit one.
    const effectiveLock = lock ?? DEFAULT_LOCK
    if (!underStasisRun && effectiveLock !== 'none' && effectiveLock !== 'ignore') {
      const phrasing = lock === undefined
        ? `the default lockfile mode ('${DEFAULT_LOCK}')`
        : `lockfile mode '${lock}'`
      throw new Error(
        `${label}: ${phrasing} requires a stasis preload; ` +
        `pass lock='none' or lock='ignore' to opt out, or run under the stasis loader`
      )
    }
    return { state: new State(cwd, options), isNoop: false }
  }

  // Preload is active. Since `lockFile` is not a plugin option, the lockfile is
  // necessarily the ambient's -- the plugin shares it (reuse or sidecar below).
  // Enforce coordination on the remaining fields before deciding which.
  const pc = ambient.config
  if (lock !== undefined && lock !== pc.lock) {
    throw new Error(`${label}: lock='${lock}' conflicts with active preload lock='${pc.lock}'`)
  }
  // scope/debug/childProcess must agree with the preload on every preload-coupled path -- reuse
  // adopts preload's config wholesale, and sidecar copies it field by field. Catch a
  // disagreement here rather than silently overriding the user's value.
  if (scope !== undefined && scope !== pc.scope) {
    throw new Error(`${label}: scope='${scope}' conflicts with active preload scope='${pc.scope}'`)
  }
  if (debug !== undefined && debug !== pc.debug) {
    throw new Error(`${label}: debug=${debug} conflicts with active preload debug=${pc.debug}`)
  }
  if (childProcess !== undefined && childProcess !== pc.childProcess) {
    throw new Error(`${label}: childProcess=${childProcess} conflicts with active preload childProcess=${pc.childProcess}`)
  }
  // resources is process-wide (a Config field), so a plugin's allowlist must agree with
  // the preload's -- reuse adopts it wholesale, a sidecar inherits it. Compare the parsed
  // sets (order/dupes/case don't matter), failing on a real disagreement rather than
  // letting one plugin silently widen the attested asset set.
  if (resources !== undefined) {
    const parsed = parseResourcesOption(label, resources)
    if (!extSetsEqual(parsed, pc.resources)) {
      throw new Error(
        `${label}: resources=[${[...parsed].join(', ')}] conflicts with active preload resources=[${[...pc.resources].join(', ')}]`
      )
    }
  }

  // A plugin instance is attaching to the preload now (its constructor called us). Mark it so the
  // preload's bundle `reason` map can tell apart files run merely fs-READS during the build (the
  // plugin's modules, e.g. webpack+babel reading app source through --fs) from genuine run
  // dependencies recorded before any plugin existed. See State#bundleReason.
  ambient.markPluginAttached()

  if (pc.bundle) {
    // Preload has bundle on -- plugin can't disable, must match mode.
    if (bundle === 'none' || bundle === 'ignore') {
      throw new Error(
        `${label}: bundle='${bundle}' conflicts with active preload bundle='${pc.bundleMode}'`
      )
    }
    if (bundle !== undefined && bundle !== pc.bundleMode) {
      throw new Error(
        `${label}: bundle='${bundle}' conflicts with active preload bundle='${pc.bundleMode}'`
      )
    }
    if (bundleFile === undefined || bundleFile === pc.bundleFile) {
      // Rule 5: same bundleFile (or unspecified) reuses the preload.
      assertOptionsMatchConfig(pc, options)
      return { state: ambient, isNoop: false }
    }
    // Rule 6: different path -- sidecar inherits preload's modes, overrides bundleFile
    // (and resourcesBundleFile if the plugin provided one for a split layout).
    const sidecar = new State(cwd, {
      parent: ambient,
      scope: pc.scope,
      lock: pc.lock,
      bundle: pc.bundleMode,
      bundleFile,
      resourcesBundleFile,
      debug: pc.debug,
      childProcess: pc.childProcess,
      resources: [...pc.resources],
      // carried over: sidecars skip stasis.config.json discovery, which may have set it
      brotliQuality: pc.brotliQuality,
    })
    return { state: sidecar, isNoop: false }
  }

  // Preload exists but has no bundle.
  if (bundle === undefined || bundle === 'none' || bundle === 'ignore') {
    // Plugin doesn't want a bundle either: just reuse preload for lockfile coverage.
    // bundle='ignore' here legitimately disagrees with preload's bundleMode ('none'),
    // both mean "no bundle written by the plugin", so skip the bundle field in the
    // cross-check rather than letting assertOptionsMatchConfig flag the difference.
    // Defense-in-depth: the strip is only safe when the preload's bundleMode is
    // actually in the no-bundle equivalence class. If a future bundleMode reads as
    // `!pc.bundle` but means something else, the strip would silently mask a real
    // disagreement -- the assert pins the contract to today's two values.
    assert.ok(pc.bundleMode === 'none' || pc.bundleMode === 'ignore',
      `unexpected preload bundleMode='${pc.bundleMode}' in the no-bundle branch`)
    const { bundle: _b, ...rest } = options
    assertOptionsMatchConfig(pc, rest)
    return { state: ambient, isNoop: false }
  }
  // Plugin wants its own bundle alongside preload's lockfile -- sidecar.
  if (!bundleFile) {
    throw new Error(
      `${label}: bundle='${bundle}' alongside a preload without bundle requires an explicit bundleFile`
    )
  }
  const sidecar = new State(cwd, {
    parent: ambient,
    scope: pc.scope,
    lock: pc.lock,
    bundle,
    bundleFile,
    resourcesBundleFile,
    debug: pc.debug,
    childProcess: pc.childProcess,
    resources: [...pc.resources],
    brotliQuality: pc.brotliQuality, // carried over, like the Rule 6 sidecar above
  })
  return { state: sidecar, isNoop: false }
}
