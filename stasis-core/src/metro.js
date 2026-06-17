import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { classifyExtension, parseResourcesOption, resolvePluginState } from './plugins.js'
import { State } from './state.js'

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
//   withStasis wires the STABLE `serializer.customSerializer`, which is the only Metro
//   surface that receives `preModules` (the polyfills/runtime Metro prepends to every
//   bundle -- real shipped files). It wraps an existing customSerializer if you have one,
//   otherwise reproduces Metro's default output. For manual wiring use
//   `new StasisMetro(opts).customSerializer(base?)`. `serializerHook` (the experimental
//   hook) is a lower-coverage fallback -- see its note.
//
// KNOWN LIMITATIONS (Metro-specific coverage gaps -- documented, not silently ignored):
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
    const { resources, ...rest } = options
    this.#resources = parseResourcesOption('StasisMetro', resources)
    const { state } = resolvePluginState('StasisMetro', rest, process.cwd())
    this.#state = state // null when the plugin should be inert (Rule 7)
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
          `add its extension to the plugin's resources option or stop importing it`
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
      // (webpack and esbuild likewise read the file themselves.)
      const source = readFileSync(modPath)
      // Code-classified files must be UTF-8. A code extension carrying non-UTF-8 bytes is
      // malformed input; refuse it rather than silently encoding it as a resource. Resource-
      // classified files pass through as-is -- State derives 'resource' vs 'resource:base64'.
      if (kind === 'code') {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(url, { source, isEntry: entries.has(modPath), resource: kind === 'resource' })
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
