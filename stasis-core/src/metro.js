import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolvePluginState } from './plugins.js'
import { State } from './state.js'
import { realReadFileSync } from './state-util.js'
import { classifyExtension } from './util.js'

const require = createRequire(import.meta.url)

// `graph.entryPoints` is a `Set<string>` of absolute entry paths in current Metro (it was
// an `Array<string>` before ~0.71; it has never been a Map). Normalize to a Set so
// `isEntry` is a single `.has`. The one-shot `metro build` passes the graph but no separate
// entry arg, and `customSerializer`'s separate `entryPoint` string names only the PRIMARY
// entry, so `graph.entryPoints` is the authoritative full set (matters for multi-entry
// builds). An absent/odd shape yields an empty set -- nothing marked an entry rather than
// throwing, matching how the other plugins treat an entry they can't positively identify.
function entrySet(graph) {
  const ep = graph?.entryPoints
  if (ep instanceof Set) return ep
  if (Array.isArray(ep)) return new Set(ep)
  return new Set()
}

// Metro has no public "default serializer" export, but its default bundle CODE is exactly
// `bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code` (Metro's own
// Server.js else-branch when no customSerializer is set). bundleToString returns
// `{ code, metadata }` -- we return the `code` string; a plain string is a valid
// customSerializer return and Metro regenerates the source map itself, the same way its
// else-branch does. These internal module paths are the ecosystem-standard entry (Expo,
// metro-serializer-*): `metro/src/*` resolves through ~0.82, `metro/private/*` exists from
// 0.81.4 on (and is the ONLY option from 0.83), so the two-tier require below spans the
// range. Loaded lazily and ONLY when withStasis()/customSerializer() must produce output
// with no user-supplied base, so a normal capture build never touches Metro internals --
// and the `metro` spec is built indirectly so it isn't treated as a hard dependency of stasis.
let metroDefault
function metroDefaultSerializer() {
  if (metroDefault) return metroDefault
  const M = 'metro'
  let baseJSBundle, bundleToString
  try {
    baseJSBundle = require(`${M}/src/DeltaBundler/Serializers/baseJSBundle`)
    bundleToString = require(`${M}/src/lib/bundleToString`)
  } catch {
    try {
      baseJSBundle = require(`${M}/private/DeltaBundler/Serializers/baseJSBundle`)
      bundleToString = require(`${M}/private/lib/bundleToString`)
    } catch (cause) {
      throw new Error(
        "StasisMetro: couldn't load Metro's default serializer (tried metro/src and " +
        'metro/private). Pass your existing customSerializer to withStasis()/customSerializer() instead.',
        { cause }
      )
    }
  }
  // Interop: Metro ships CJS; `require` of its Flow-compiled modules exposes the function
  // either as the namespace itself or under `.default`.
  baseJSBundle = baseJSBundle.default ?? baseJSBundle
  bundleToString = bundleToString.default ?? bundleToString
  // Return the `.code` string (bundleToString yields { code, metadata }); a string is a
  // valid customSerializer return and Metro regenerates the source map itself.
  metroDefault = (entryPoint, preModules, graph, options) =>
    bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code
  return metroDefault
}

// Stasis plugin for the Metro bundler (React Native).
//
// WHY THIS HOOKS THE SERIALIZER, NOT A TRANSFORMER:
//   Metro transforms each file in a pool of WORKER processes. A stasis State is
//   process-local (its observed sources/imports/formats live in in-memory Maps
//   flushed by State.write on the main process), so a transformer-side capture
//   would scatter observations across workers that never reach the writer.
//   Metro's serializer runs once, in the MAIN process, AFTER the whole graph is
//   built, with the complete module graph in hand -- the one place a single State
//   can see every module and resolution edge (mirrors webpack's afterResolve and
//   esbuild's onResolve/onLoad, which likewise run in the bundler's main process).
//
// THIS PLUGIN IS THE CAPTURE HALF -- LOAD LIVES IN A SEPARATE TRANSFORMER:
//   The other plugins serve bundle bytes back into the build because their bundler
//   reads + transforms files in the same process the bundle lives in (webpack's
//   inputFileSystem wrapper, esbuild's onLoad). Metro reads + transforms in workers,
//   before serialization, so the serializer can't inject bytes into the transform.
//   Load is instead handled per-worker by the companion `./metro-transformer.js`
//   (wired as Metro's `transformer.transformerPath`): unlike capture, load only ever
//   READS the immutable bundle and every worker reads the same bytes, so there is no
//   cross-worker state to merge. This serializer therefore REJECTS bundle=load.
//   Capture modes (lock/bundle add|replace|frozen, and lock=none/ignore) all work.
//
// USAGE (metro.config.js) -- prefer withStasis:
//   const { withStasis } = require('@exodus/stasis/metro')
//   module.exports = withStasis(require('./metro.config.base'), { /* scope, lock, ... */ })
//
//   Then CAPTURE with child-process forwarding ON -- Metro transforms in worker processes, so
//   `--child-process` is REQUIRED on a capture run to attest the toolchain those workers load
//   (babel.config.js, @babel/core, the RN preset + plugins). The plugin throws at config time if
//   you forget it on a writing run:  `stasis run --lock=add --child-process -- <metro build cmd>`.
//   A later `--lock=frozen` verify needs NO flag (verification is per-process, independent of the
//   shard channel). withStasis wires the STABLE `serializer.customSerializer`, which is the only
//   Metro surface that receives `preModules` (the polyfills/runtime Metro prepends to every
//   bundle -- real shipped files). It wraps an existing customSerializer if you have one,
//   otherwise reproduces Metro's default output. For manual wiring use
//   `new StasisMetro(opts).customSerializer(base?)`. `serializerHook` (the experimental
//   hook) is a lower-coverage fallback -- see its note.
//
// KNOWN LIMITATIONS (Metro-specific coverage gaps -- documented, not silently ignored):
//   - Child-process capture is best-effort and one-shot-build only. A worker KILLED by signal
//     before its exit hook (jest-worker forceExit / pool overflow) loses its shard SILENTLY at
//     capture time -- a later frozen run still catches the gap (fail-closed), but nothing warns
//     during capture. And it relies on the loader's exit-time write: a dev server (`metro start`,
//     pool kept warm, killed by signal) never gets there, and standalone (no stasis loader) Metro
//     mints no shard dir -- neither produces a toolchain-complete lockfile. Use a one-shot
//     `metro build` under `stasis run --child-process` to capture, then verify with `--lock=frozen`.
//   - Scaled asset variants: `import x from './logo.png'` is ONE module in the graph, keyed
//     by the base path; Metro discovers `logo@2x.png` / `@3x` via its AssetData (parallel
//     scales/files arrays), NOT as separate graph modules, so only the base file is attested
//     here. Assets pulled in by the native build via `react-native.config.js` (e.g. fonts
//     through `react-native-asset`) aren't in Metro's JS graph at all and aren't covered.
//   - Platform-specific lockfiles: edges are recorded under the as-written specifier
//     ('./Foo') resolved to the platform variant Metro picked ('Foo.ios.js'), all under the
//     '*' conditions key. A lockfile captured for one platform won't match a frozen run for
//     another -- capture/verify per platform. It fails CLOSED (rejects, never silently
//     accepts a mismatched resolution).
export class StasisMetro {
  #seen = new Set()
  #state
  #resources

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisMetro', options, process.cwd())
    this.#state = state // null when the plugin should be inert (Rule 7)
    // A CAPTURE-THAT-WRITES requires child-process forwarding: Metro transforms every file in a
    // pool of worker processes (see the class note), and the toolchain those workers load --
    // babel.config.js, @babel/core, the React Native preset + its plugins -- is observed only
    // there. Without --child-process those workers can't report back, so that toolchain goes
    // unattested and a later frozen/load run rejects it. Fail loudly at config time rather than
    // silently emit an incomplete lockfile. Gate on the SAME predicate as the shard channel itself
    // (writeLockfile || writeBundle, i.e. lock/bundle add|replace) so the flag is demanded exactly
    // when forwarding does something: a frozen/ignore/none run verifies per-process and needs no
    // channel (the CLI frozen tests pass without the flag), and load mode reads the bundle via the
    // companion transformer -- none of those should be forced to pass --child-process.
    if (state && (state.config.writeLockfile || state.config.writeBundle)) {
      assert.ok(
        state.config.childProcess,
        'StasisMetro: child-process capture must be enabled -- Metro transforms in worker processes, ' +
        'and without it the toolchain they load (babel.config.js, @babel/core, the RN preset + plugins) ' +
        'is never attested. Enable it: `stasis run --child-process ...`, EXODUS_STASIS_CHILD_PROCESS=1, ' +
        'or "childProcess": true in stasis.config.json.'
      )
    }
    // resources is a Config field now (validated + coordinated against any preload in
    // resolvePluginState); cache the resolved Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  // Build a Metro `serializer.customSerializer`: captures the graph AND `preModules`
  // (Metro's prepended polyfills/runtime -- real shipped files that the experimental hook
  // never sees), writes state, then produces output. With a `baseSerializer` we delegate to
  // it; with none we reproduce Metro's default output. This is the stable, full-coverage
  // surface (withStasis wires it for you).
  customSerializer(baseSerializer = undefined) {
    if (baseSerializer !== undefined && typeof baseSerializer !== 'function') {
      throw new TypeError('StasisMetro.customSerializer(base?): base must be a function or omitted')
    }
    return (entryPoint, preModules, graph, options) => {
      this.#run(graph, preModules)
      const serialize = baseSerializer ?? metroDefaultSerializer()
      return serialize(entryPoint, preModules, graph, options)
    }
  }

  // Wire into `serializer.experimentalSerializerHook`. Observation-only: Metro ignores the
  // return value, so stasis never produces output -- convenient when you can't touch
  // `customSerializer`. LOWER COVERAGE: the hook's signature is `(graph, delta)`; Metro never
  // passes `preModules` to it, so the prepended polyfills/runtime go UNATTESTED. Prefer
  // withStasis/customSerializer. Bound so it can be passed by reference.
  serializerHook = (graph, _delta) => {
    this.#run(graph)
  }

  #run(graph, preModules) {
    if (!this.#state) return
    if (this.#state.config.loadBundle) {
      throw new Error(
        'StasisMetro: bundle=load is served by the companion worker transformer ' +
        "(transformer.transformerPath = '@exodus/stasis/metro-transformer'), not this serializer " +
        'plugin -- Metro transforms in workers before serialization. Remove this plugin from your ' +
        'serializer config in load mode, or use bundle=add/replace/frozen here to capture.'
      )
    }
    this.#capture(graph, preModules)

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them here. The
    // serializer only runs once Metro has successfully built + transformed the whole graph
    // (a failed build throws before serialization), so this is the clean-build equivalent of
    // webpack's `stats.hasErrors()` / esbuild's `result.errors.length` gate. In watch / dev
    // mode it fires on every rebuild; State.write's per-artifact compare-and-skip makes the
    // unchanged-graph case a cheap no-op.
    if (this.#state !== State.preload) this.#state.write()
  }

  #capture(graph, preModules) {
    const entries = entrySet(graph)
    // preModules first (Metro's prepended polyfills/runtime + InitializeCore -- real on-disk
    // files that ship in every bundle; only the customSerializer path receives them, and the
    // synthetic ones like __prelude__ are skipped by the existsSync guard below). Then the
    // app module graph.
    if (preModules) this.#captureModules(preModules, entries)
    this.#captureModules(graph.dependencies.values(), entries)
  }

  #captureModules(modules, entries) {
    for (const module of modules) {
      // Metro keys `graph.dependencies` by the module's absolute path; `module.path` is that
      // same path and is what preModules carry too, so we read it off the module either way.
      const modPath = module?.path
      // Skip synthetic / virtual modules (Metro injects some with non-disk paths, e.g.
      // require.context's `?ctx=` modules and __prelude__): a path that isn't an existing
      // absolute file has no bytes to hash. Mirrors webpack's `isAbsolute && existsSync`
      // guard and esbuild's `namespace === 'file'` gate.
      if (typeof modPath !== 'string' || !isAbsolute(modPath) || !existsSync(modPath)) continue

      const kind = classifyExtension(modPath, this.#resources)
      if (kind === 'unknown') {
        throw new Error(
          `StasisMetro: unsupported extension for '${modPath}' -- ` +
          `add its extension or filename to the plugin's resources option or stop importing it`
        )
      }
      const url = pathToFileURL(modPath).toString()

      // Record this module's outgoing resolution edges. Metro keys a module's `dependencies`
      // by an opaque hash; the as-written specifier is `dep.data.name` (e.g. './hello' or
      // 'react-native') and the resolved target is `dep.absolutePath`. We only attest edges
      // whose TARGET is code: resource imports (an asset pulled in for its bytes) are captured
      // as files below but carry no import edge, matching webpack/esbuild (`kind === 'code'`).
      // Edges to virtual/unresolved targets are skipped like the modules above.
      for (const dep of module.dependencies?.values?.() ?? []) {
        const target = dep?.absolutePath
        const specifier = dep?.data?.name
        if (typeof target !== 'string' || !isAbsolute(target) || !existsSync(target)) continue
        if (typeof specifier !== 'string') continue
        if (classifyExtension(target, this.#resources) !== 'code') continue
        this.#state.addImport(url, specifier, pathToFileURL(target).toString())
      }

      if (this.#seen.has(modPath)) continue
      this.#seen.add(modPath)

      // Read the bytes from disk rather than `module.getSource()` -- addFile re-reads disk
      // and asserts byte-equality against what we pass, and disk is the thing stasis attests.
      // Use the REAL reader (state-util.js), like webpack/esbuild: this capture read is the
      // plugin's own bookkeeping, NOT a program fs read. `import { readFileSync } from
      // 'node:fs'` (the named binding above, before this fix) is rebound to the patched
      // reader by `stasis run --fs`'s syncBuiltinESMExports(), so reading through it would
      // re-record the whole Metro module graph into the preload/main bundle -- it belongs to
      // THIS plugin's sidecar instead.
      const source = realReadFileSync(modPath)
      // Code-classified files must be UTF-8. A code extension carrying non-UTF-8 bytes is
      // malformed input; refuse it rather than silently encoding it as a resource. Resource-
      // classified files pass through as-is -- State derives 'resource' vs 'resource:base64'.
      if (kind === 'code') {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(url, { source, isEntry: entries.has(modPath), resource: kind === 'resource', reason: 'StasisMetro' })
    }
  }
}

// Idiomatic Metro-config wrapper (cf. withNativeWind / withSentryConfig): returns a new
// config with `serializer.customSerializer` wired so stasis captures the graph + preModules
// and your existing customSerializer (or Metro's default) still produces the bundle. This is
// the recommended surface -- it uses the stable customSerializer (so preModules are covered)
// rather than the experimental hook. Pure (returns a new object; doesn't mutate `config`).
export function withStasis(config = {}, options = {}) {
  const stasis = new StasisMetro(options)
  const existing = config.serializer?.customSerializer ?? undefined
  return {
    ...config,
    serializer: {
      ...config.serializer,
      customSerializer: stasis.customSerializer(existing),
    },
  }
}
