// Bundler-plugin glue: per-file classification (CODE_EXTENSIONS / pathExt /
// parseResourcesOption / classifyExtension) and the plugin <-> preload
// coordination (resolvePluginState). Kept out of state.js because none of it
// touches State internals -- the classification is pure, and the coordination
// only consults State.preload + Config helpers.

import assert from 'node:assert/strict'
import { join } from 'node:path'

import { DEFAULT_LOCK, assertOptionsMatchConfig, validatePluginOptions } from './config.js'
import { State } from './state.js'
import { canonicalizePath } from './state-util.js'

const FILE_LOCK = 'stasis.lock.json'

// File extensions whose bytes are JS-shaped code -- the lockfile + Node loader
// can attest their formats (module/commonjs/json/...) and bundle=load can
// round-trip them as Node modules. Plugins treat everything outside this set as
// either a resource (if the user opted the extension into their `resources`
// option) or an error (if not). Code and resources share one bundle file
// post-collapse, distinguished per file by `formats[file]`.
export const CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'mts', 'cts'])

// Lowercased, dot-less extension of a path, or '' if none.
export function pathExt(filePath) {
  const m = /\.([^./\\]+)$/.exec(filePath)
  return m ? m[1].toLowerCase() : ''
}

// Validates + normalizes a plugin's `resources` option into a Set of lowercase
// dot-less extensions. Plugins call this once at construction so the per-file
// classification path stays cheap. Throws on bad input (wrong type, non-string
// entries, an extension that's already in the code set) so misconfigurations
// surface immediately rather than as silent capture drift.
export function parseResourcesOption(label, resources) {
  if (resources === undefined) return new Set()
  if (!Array.isArray(resources)) {
    throw new TypeError(`${label}: resources must be an array of extension strings`)
  }
  const out = new Set()
  for (const entry of resources) {
    if (typeof entry !== 'string') {
      throw new TypeError(`${label}: resources entry must be a string, got ${typeof entry}`)
    }
    const clean = entry.toLowerCase().replace(/^\./, '')
    if (!/^[a-z0-9]+$/.test(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is not a valid extension`)
    }
    if (CODE_EXTENSIONS.has(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is a code extension; remove it (code extensions are always tracked)`)
    }
    out.add(clean)
  }
  return out
}

// Classifies a file by extension against the code set + the user's parsed
// resources allowlist. Returns 'code' (track with its loader format),
// 'resource' (track with a 'resource'/'resource:base64' format -- State picks
// the encoding from content), or 'unknown' (caller must throw). The 'unknown'
// path is what forces the user to be explicit about every non-JS asset their
// bundler consumes -- no silent attestation widening.
export function classifyExtension(filePath, resources) {
  const ext = pathExt(filePath)
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (resources.has(ext)) return 'resource'
  return 'unknown'
}

// Decides which State a bundler plugin (StasisWebpack / StasisEsbuild) should run against,
// given its constructor options and the ambient preload (or lack thereof). Returns either
// { state: null, isNoop: true } -- plugin should register no hooks and become inert -- or
// { state, isNoop: false } -- plugin should drive the returned State.
//
// Rules:
//  0. Plugin's `lockFile` (resolved to an absolute path) differs from the ambient
//     preload's effective lockfile path: construct an INDEPENDENT State with its own
//     lockfile + bundle. No sidecar parentage, no shared hashes/entries/modules, no
//     coordination check with the preload. This is the "bundler state truly separate
//     from runtime state" opt-out. When `lockFile` is unset (or points at the same
//     path as the ambient's), the unified-lockfile rules 1-7 apply.
//  1. Plugin asking for any lockfile mode other than 'none' / 'ignore' requires a preload.
//     Without one it's a hard throw -- the lockfile would otherwise only cover the bundled
//     app and silently miss every dependency the bundler itself pulled in.
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
  const { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug } = options
  const ambient = State.preload

  if (!ambient) {
    if (lock === 'none' && bundle === 'none') return { state: null, isNoop: true } // Rule 7
    // Rule 7 needs BOTH to be 'none'. A partial opt-out -- one field is 'none' but
    // the other was simply omitted -- would otherwise fall through to either a
    // misleading Rule 1 throw about the default lockfile mode, or to Config's
    // generic "stasis needs a lockfile or a bundle" RangeError. Catch the partial
    // case explicitly. Only fires when the OTHER field is undefined: an active
    // bundle mode like `bundle:'load'` / `'frozen'` / `'add'` paired with
    // `lock:'none'` is a legitimate "bundle as trust root" config that Config
    // accepts (see config.js's bundle=load / bundle=frozen rules).
    if ((lock === 'none' && bundle === undefined) || (bundle === 'none' && lock === undefined)) {
      throw new Error(
        `${label}: to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none' ` +
        `(got lock=${lock === undefined ? `default '${DEFAULT_LOCK}'` : `'${lock}'`}, ` +
        `bundle=${bundle === undefined ? 'default' : `'${bundle}'`})`
      )
    }
    const effectiveLock = lock ?? DEFAULT_LOCK
    if (effectiveLock !== 'none' && effectiveLock !== 'ignore') {
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

  // Preload is active. Decide first whether the plugin asked for an INDEPENDENT lockfile:
  // a `lockFile` whose absolute path differs from the ambient's effective lockfile path
  // (its explicit `config.lockFile`, or `<ambient.root>/stasis.lock.json` by default).
  // When they differ, the plugin runs against a fresh State -- not a sidecar -- so its
  // observations land in its own lockfile rather than merging into the ambient's. When
  // they match (including the unset case, which defaults to the ambient's path), the
  // existing reuse/sidecar logic applies and a single lockfile stays unified.
  const pc = ambient.config
  const ambientLockPath = canonicalizePath(pc.lockFile || join(ambient.root, FILE_LOCK))
  const requestedLockPath = lockFile !== undefined ? canonicalizePath(lockFile) : ambientLockPath
  if (requestedLockPath !== ambientLockPath) {
    // Independent State: plugin owns its own lockfile + bundle, no parentage. We do NOT
    // assert agreement with the ambient on scope/lock/bundle/debug -- the user has
    // explicitly opted out of unification by pointing at a different lockfile, and one
    // legitimate motivation is to run the bundler under different scope/lock semantics
    // than the host process's Node loader. The plugin's options drive everything; the
    // standard State invariants (a lockfile or a bundle must be configured, frozen needs
    // attestation, etc.) still apply at construction time.
    return { state: new State(cwd, options), isNoop: false }
  }

  // Same lockfile as the ambient: enforce coordination as before.
  if (lock !== undefined && lock !== pc.lock) {
    throw new Error(`${label}: lock='${lock}' conflicts with active preload lock='${pc.lock}'`)
  }
  // scope/debug must agree with the preload on every preload-coupled path -- reuse
  // adopts preload's config wholesale, and sidecar copies it field by field. Catch a
  // disagreement here rather than silently overriding the user's value.
  if (scope !== undefined && scope !== pc.scope) {
    throw new Error(`${label}: scope='${scope}' conflicts with active preload scope='${pc.scope}'`)
  }
  if (debug !== undefined && debug !== pc.debug) {
    throw new Error(`${label}: debug=${debug} conflicts with active preload debug=${pc.debug}`)
  }

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
      // Rule 5: same path reuses the preload. Strip lockFile before cross-checking:
      // the explicit-path comparison above already proved the requested lockfile path
      // matches the ambient's. A literal lockFile-string equality through
      // assertOptionsMatchConfig would spuriously fail when the user spelled out the
      // ambient's default path (`<root>/stasis.lock.json`) while `pc.lockFile` is unset.
      const { lockFile: _lf, ...rest } = options
      assertOptionsMatchConfig(pc, rest)
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
    // Same lockFile-strip as Rule 5 -- the resolve()-compare upstream already proved
    // the requested lockfile path matches the ambient's, so a literal mismatch here
    // would be spurious.
    const { bundle: _b, lockFile: _lf, ...rest } = options
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
  })
  return { state: sidecar, isNoop: false }
}
