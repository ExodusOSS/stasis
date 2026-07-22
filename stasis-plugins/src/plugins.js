// Plugin <-> preload coordination (resolvePluginState): decides which State a bundler plugin
// drives, given its options and the ambient preload.

import assert from 'node:assert/strict'

import { DEFAULT_LOCK, assertOptionsMatchConfig, validatePluginOptions } from '@exodus/stasis-core/config'
import { ensureStateForLoader, isLoaderInstalled } from '@exodus/stasis-core/hooks'
import { State } from '@exodus/stasis-core/state'
import { extSetsEqual, parseResourcesOption } from '@exodus/stasis-core/util'

// Decides which State a bundler plugin runs against, given its options and the ambient preload.
// Returns { state: null, isNoop: true } (inert -- register no hooks) or { state, isNoop: false }.
// The lockfile is always unified (plugins can't set lockFile); only the BUNDLE may split per-plugin
// (bundleFile -> sidecar). Rules, referenced by number in the code below:
//  0. No preload, not under `stasis run`, no lock/bundle option -> inert (safe on a plain build).
//  1. A writing/verifying lock mode without a preload throws (it would miss the bundler's own deps).
//  2. With a preload, the plugin's lock mode must agree with it.
//  3. When plugin and preload align, reuse the preload State (single lockfile).
//  4. Preload with bundle on: plugin can't disable it and the mode must match; bundleFile may differ.
//  5. Same bundleFile (or unspecified) reuses the preload State.
//  6. Different bundleFile creates a sidecar sharing the preload's lockfile data.
//  7. lock='none' AND bundle='none' with no preload is a no-op (env-controlled-off framework plugins).
export function resolvePluginState(label, options, cwd) {
  validatePluginOptions(label, options)
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, childProcess, packageJSON, resources } = options
  // Same-instance fast path: loader installed but lazy initState hasn't fired (webpack builds plugins
  // before user code). Force-init so the plugin lands in the ambient branch. NOT for a separate
  // stasis-core copy -- that would mint a phantom State.preload racing the real loader's write.
  if (!State.preload && isLoaderInstalled()) ensureStateForLoader()
  const ambient = State.preload

  if (!ambient) {
    // "Under stasis run" detection: the bin script always exports EXODUS_STASIS_LOCK, so it's a
    // process-wide signal regardless of which stasis-core copy hosts this code.
    const underStasisRun = process.env.EXODUS_STASIS_LOCK !== undefined

    // Rule 0: no preload, not under `stasis run`, no lock/bundle option -> do nothing, so a bare
    // plugin sits inertly in a plain build. Capture is governed elsewhere (env or explicit options).
    if (!underStasisRun && lock === undefined && bundle === undefined) {
      return { state: null, isNoop: true }
    }

    if (lock === 'none' && bundle === 'none') return { state: null, isNoop: true } // Rule 7
    // A partial opt-out (one field 'none', the other omitted) would otherwise hit a misleading
    // Rule 1 throw or Config's generic error; catch it explicitly. An active bundle mode paired
    // with lock='none' is a legitimate "bundle as trust root" config, so only fire when the other is undefined.
    if ((lock === 'none' && bundle === undefined) || (bundle === 'none' && lock === undefined)) {
      throw new Error(
        `${label}: to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none' ` +
        `(got lock=${lock === undefined ? `default '${DEFAULT_LOCK}'` : `'${lock}'`}, ` +
        `bundle=${bundle === undefined ? 'default' : `'${bundle}'`})`
      )
    }
    // A writing/verifying lock (add|replace|frozen) still needs a preload unless under stasis run
    // (whose loader gives full coverage). `lock` may be undefined here if only a writing `bundle`
    // was passed, so the throw below distinguishes a defaulted mode from an explicit one.
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

  // Preload active: the lockfile is necessarily the ambient's. Enforce field coordination, then reuse or sidecar.
  const pc = ambient.config
  if (lock !== undefined && lock !== pc.lock) {
    throw new Error(`${label}: lock='${lock}' conflicts with active preload lock='${pc.lock}'`)
  }
  // scope/debug/childProcess must agree with the preload (reuse adopts it, sidecar copies it).
  if (scope !== undefined && scope !== pc.scope) {
    throw new Error(`${label}: scope='${scope}' conflicts with active preload scope='${pc.scope}'`)
  }
  if (debug !== undefined && debug !== pc.debug) {
    throw new Error(`${label}: debug=${debug} conflicts with active preload debug=${pc.debug}`)
  }
  if (childProcess !== undefined && childProcess !== pc.childProcess) {
    throw new Error(`${label}: childProcess=${childProcess} conflicts with active preload childProcess=${pc.childProcess}`)
  }
  if (packageJSON !== undefined && packageJSON !== pc.packageJSON) {
    throw new Error(`${label}: packageJSON=${packageJSON} conflicts with active preload packageJSON=${pc.packageJSON}`)
  }
  // resources is process-wide, so a plugin's allowlist must agree with the preload's -- compare
  // parsed sets (order/dupes/case-insensitive) to prevent one plugin silently widening the asset set.
  if (resources !== undefined) {
    const parsed = parseResourcesOption(label, resources)
    if (!extSetsEqual(parsed, pc.resources)) {
      throw new Error(
        `${label}: resources=[${[...parsed].join(', ')}] conflicts with active preload resources=[${[...pc.resources].join(', ')}]`
      )
    }
  }

  // Mark the plugin attached so the preload's bundle `reason` map can distinguish files merely
  // fs-READ during the build from genuine run dependencies recorded before any plugin existed.
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
    // Rule 6: different path -- sidecar inherits preload's modes, overrides bundleFile.
    const sidecar = new State(cwd, {
      parent: ambient,
      scope: pc.scope,
      lock: pc.lock,
      bundle: pc.bundleMode,
      bundleFile,
      resourcesBundleFile,
      debug: pc.debug,
      childProcess: pc.childProcess,
      packageJSON: pc.packageJSON,
      resources: [...pc.resources],
      // carried over: sidecars skip stasis.config.json discovery
      brotliQuality: pc.brotliQuality,
    })
    return { state: sidecar, isNoop: false }
  }

  // Preload exists but has no bundle.
  if (bundle === undefined || bundle === 'none' || bundle === 'ignore') {
    // Plugin wants no bundle either: reuse preload for lockfile coverage. bundle='ignore' vs the
    // preload's 'none' both mean "no plugin bundle", so strip the bundle field from the cross-check;
    // the assert pins that strip to today's no-bundle values so a future mode can't silently mask a disagreement.
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
    packageJSON: pc.packageJSON,
    resources: [...pc.resources],
    brotliQuality: pc.brotliQuality, // carried over, like the Rule 6 sidecar above
  })
  return { state: sidecar, isNoop: false }
}
