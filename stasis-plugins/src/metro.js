import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
import { realReadFileSync, realReaddirSync } from '@exodus/stasis-core/state-util'
import { RN_CORE_INCLUDE_DIRS, RN_CORE_INCLUDE_FILES, classifyExtension, classifyNativeCapture, isExcludedNativeDir, isNativeArtifact, isNativeManifest, isPodspec, splitNodeModulesPath } from '@exodus/stasis-core/util'

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

// Well-known files a React Native / Metro build REQUIRES that the serializer's module
// graph never reliably carries -- attested automatically at capture when they resolve
// from the project, and skipped when they don't (not every Metro project ships them):
//   - metro-runtime/src/modules/asyncRequire.js: Metro's default
//     `transformer.asyncRequireModulePath`. The transform injects it to implement
//     dynamic import(), so it ships in bundles without necessarily appearing as a
//     module of the graph handed to the serializer.
//   - @react-native-community/cli/setup_env.sh: sourced by the React Native CLI's
//     native build phases (Xcode / Gradle) around the JS bundle step -- build-shaping
//     toolchain that is never part of the JS module graph at all.
// A `resource: true` entry bypasses the `resources` allowlist: this is a stasis-vetted
// list of SPECIFIC files, not a user-widened extension class. Code entries ride the
// normal loader-format inference. Extend the list here, not via an option -- an option
// would make the attested set configuration-dependent, which is exactly what
// auto-include exists to avoid.
const AUTO_INCLUDES = [
  { specifier: 'metro-runtime/src/modules/asyncRequire.js', resource: false },
  { specifier: '@react-native-community/cli/setup_env.sh', resource: true },
]

// Directory subtrees NEVER walked when attesting a native dependency's build-input surface
// (matched by exact basename, at any depth):
//   - node_modules: nested installed deps are separate packages; autolinking reports each as
//     its own top-level `react-native config` entry, so they're attested from there, not here.
//   - .git / .github: VCS + CI metadata, never a native build input.
//   - example / examples: a library's own demo app is a CONSUMER of the library, not part of
//     its podspec/gradle source set -- and often ships its own ios/android projects + Pods,
//     the single biggest source of accidental over-capture.
//   - build / .gradle / .cxx / Pods: regenerated build output (Gradle, the NDK, CocoaPods),
//     not source -- re-derived by the native build, so attesting it is churn, not provenance.
const NATIVE_WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'example', 'examples', 'build', '.gradle', '.cxx', 'Pods',
])

// Run React Native's OWN autolinking resolver -- `react-native config` -- to discover the
// project's native dependencies (the exact source of truth CocoaPods' `use_native_modules!`
// and Gradle's settings plugin consume). Returns the parsed config, or null when the RN CLI
// isn't installed (not a React Native app -- nothing native to attest, same skip-when-absent
// stance as AUTO_INCLUDES). THROWS when the CLI is present but fails or emits unparseable
// output: a capture that can't determine the native dependency set must fail loudly rather
// than silently under-attest (a later frozen run would otherwise reject files this run
// should have captured). Run out-of-process on purpose -- it isolates the resolver's own fs
// reads (which this capture doesn't attest) and matches how the native build invokes it.
function loadReactNativeConfig(projectDir) {
  let cliPath
  try {
    cliPath = require.resolve('react-native/cli.js', { paths: [projectDir] })
  } catch {
    return null // not a React Native project -- nothing native to attest
  }
  // De-instrument the child: strip stasis's env AND any inherited Node loader so the resolver
  // runs as a vanilla Node process. Otherwise it would inherit this capture's loader/shard
  // channel and either join our capture nondeterministically or abort on a config it can't
  // satisfy (no lock/bundle mode of its own) -- neither is what "just resolve the graph" wants.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXODUS_STASIS_')) delete env[key]
  }
  delete env.NODE_OPTIONS
  const res = spawnSync(process.execPath, [cliPath, 'config'], {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, // a large monorepo's config JSON can be many MB
    env,
  })
  if (res.error) {
    throw new Error(`StasisMetro: failed to run 'react-native config': ${res.error.message}`, { cause: res.error })
  }
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim()
    throw new Error(
      `StasisMetro: 'react-native config' exited ${res.status}${res.signal ? ` on signal ${res.signal}` : ''}` +
      `${detail ? `: ${detail}` : ''}`
    )
  }
  try {
    return JSON.parse(res.stdout)
  } catch (cause) {
    throw new Error("StasisMetro: couldn't parse 'react-native config' output as JSON", { cause })
  }
}

// A `react-native config` dependency entry is a NATIVE dependency when autolinking resolved a
// non-null platform config for at least one platform. A JS-only dependency has every platform
// null (`{ ios: null, android: null }`): its used JS is already in Metro's graph, so it has no
// separate native surface to attest.
function isNativeDependency(dep) {
  const platforms = dep?.platforms
  if (!platforms || typeof platforms !== 'object') return false
  return Object.values(platforms).some((p) => p != null)
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
//   (wired as Metro's top-level `transformerPath`): unlike capture, load only ever
//   READS the immutable bundle and every worker reads the same bytes, so there is no
//   cross-worker state to merge. Under bundle=load this serializer is therefore a
//   transparent PASS-THROUGH (captures nothing, writes nothing, delegates to the
//   base serializer), mirroring the transformer, which passes through in every
//   non-load mode. Wire BOTH halves permanently; the mode picks the active one.
//   That matters because metro.config.js is itself attested at capture, so a load
//   run must execute it unedited. Capture modes (lock/bundle add|replace|frozen,
//   and lock=none/ignore) all capture here.
//
// USAGE (metro.config.js) -- prefer withStasis; wire the load half permanently alongside it:
//   const { withStasis } = require('@exodus/stasis/metro')
//   module.exports = withStasis({
//     ...require('./metro.config.base'),
//     transformerPath: require.resolve('@exodus/stasis/metro-transformer'),  // the load half
//   }, { /* scope, lock, ... */ })
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
// AUTO-INCLUDED FILES: capture also attests the fixed AUTO_INCLUDES list (see it above
//   the class) -- files a React Native build requires that the serializer's graph never
//   reliably carries (Metro's asyncRequire module, the RN CLI's setup_env.sh). Each is
//   attested when it resolves from the project and skipped when it doesn't, through the
//   same addFile path as graph modules, so frozen verification covers them fail-closed.
//   NOTE: a lockfile captured before this list existed doesn't attest these files, so a
//   frozen run against it fails once they're present -- recapture (lock=replace) once.
//
// NATIVE MODULES: a React Native app's native dependencies (react-native-screens, ...) are
//   consumed by CocoaPods/Xcode and Gradle, NOT by Metro -- their podspecs, Gradle projects,
//   and ObjC/Swift/Java/Kotlin/C++ sources never appear in the JS module graph, so nothing
//   above attests them. Capture closes this by asking React Native's OWN autolinking resolver,
//   `react-native config`, which native dependencies the build links (the same query
//   `use_native_modules!` / the Gradle settings plugin run), then attesting each one's native
//   SOURCE surface (see #captureNativeModules). This runs automatically whenever the RN CLI
//   resolves from the project -- no option, so the attested set can't drift by config -- and is
//   skipped otherwise (a non-RN Metro build has nothing native to attest). Without it, `stasis
//   prune` -- which keeps only lockfile-listed files -- would DELETE every native dependency's
//   ios/android sources and break the native build. Prebuilt/installed binary artifacts (e.g.
//   react-native-skia's `libs/` of .a/.xcframework) are NOT captured -- generated output, not
//   source, and often non-deterministic across installs (isNativeArtifact). React Native CORE
//   isn't a `dependencies` entry (config reports only `reactNativePath`), so its own scattered
//   podspecs -- third-party-podspecs/*, Libraries/*/*.podspec -- plus the Ruby helpers those
//   podspecs `require` (hermes-utils.rb) and the package.json they parse, are captured separately
//   (podspec-LOAD surface). Beyond that, a vetted fixed set of core dirs/files the native build
//   compiles or reads is captured IN FULL -- RN_CORE_INCLUDE_DIRS (ReactCommon/yoga,
//   sdks/hermes-engine, scripts) + RN_CORE_INCLUDE_FILES (sdks/.hermesversion) -- while core's
//   remaining native source and its prebuilt binaries (sdks/hermesc) stay out. A
//   native module that autolinking never reports but the app IMPORTS and wires up manually in the
//   Podfile (e.g. a podspec under lib/ios) is also captured: any reached node_modules package
//   that ships native code (a podspec / ios/ / android/) has its native surface attested.
//
// KNOWN LIMITATIONS (Metro-specific coverage gaps -- documented, not silently ignored):
//   - Capture is ONE-SHOT ONLY, enforced: a dev server (`metro start`) re-invokes the serializer
//     per rebuild, and the SECOND invocation throws (see #run) -- capture's path-keyed dedupe
//     would otherwise keep attesting a file's first-build bytes after an edit changed them.
//     Metro gives the serializer no watch signal on the first build, so the first rebuild is the
//     earliest refusal point. Load mode is unaffected and runs fine under a dev server --
//     the serializer passes through and the worker transformer only reads immutable
//     attested bytes.
//   - Child-process capture is best-effort within that one shot. A writing plugin opts the
//     build's workers into the loader's SIGTERM shard flush (EXODUS_STASIS_SHARD_SIGNAL_FLUSH,
//     set in the constructor), so a worker force-killed by jest-worker's forceExit -- SIGTERM
//     500ms after END, routine for a transform worker whose event loop doesn't drain --
//     contributes its shard best-effort: the flush must complete inside forceExit's follow-up
//     500ms SIGTERM->SIGKILL window. A worker killed any OTHER way still loses its shard
//     SILENTLY at capture time -- SIGKILL (jest-worker's memory-limit killChild, a
//     killSignal:'SIGKILL' override), a non-SIGTERM signal (group SIGINT/SIGHUP, another
//     killSignal override; the flush handler is SIGTERM-only), or a nested orchestration's
//     Metro MAIN process (itself a capturing child, it snapshots its config before this
//     constructor sets the flag, so only its descendants are covered). A later frozen run
//     catches every such gap (fail-closed), but nothing warns during capture. And it relies
//     on the loader's exit/signal-time writes, which standalone (no stasis loader) Metro
//     never reaches -- it mints no shard dir and produces no toolchain-complete lockfile.
//     Use a one-shot `metro build` under `stasis run --child-process` to capture, then
//     verify with `--lock=frozen`.
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
//   - Native module capture attests each native dependency's own package tree, minus the
//     NATIVE_WALK_SKIP_DIRS subtrees. Two bounded gaps: (a) a podspec whose `source_files`
//     glob reaches OUTSIDE the package (into a sibling under node_modules) isn't followed --
//     we don't execute the podspec's Ruby, only walk the package that declares it; and (b) the
//     APP's own native project (the top-level `ios/`/`android/` dirs, plus `Podfile`/
//     `build.gradle`) is the user's versioned source, not a dependency, so it's out of scope
//     here (attest it with the app's own VCS). Both fail CLOSED under a later frozen run: it
//     verifies exactly what was captured and never silently accepts an unattested substitute.
//   - `react-native config` runs on EVERY capture-mode serialization (add/replace AND frozen),
//     since frozen re-derives the native set to verify it. Load mode passes through and never
//     invokes it, so the dev-server path is unaffected.
export class StasisMetro {
  #seen = new Set()
  #state
  #resources

  // Base dir AUTO_INCLUDES resolution starts from: the directory Metro runs in -- the
  // same cwd resolvePluginState anchors the State at, and an in-or-under-root path by
  // State's own root detection (which walks UP from it), so Node's node_modules walk-up
  // from here also covers hoisted workspace layouts. Snapshotted at construction so a
  // later chdir can't skew what a capture attests.
  #projectDir = process.cwd()

  // Whether this instance already served one capture (#run). The serializer fires once per
  // one-shot `metro build`; a dev server re-invokes it per rebuild, which capture refuses --
  // see the guard in #run.
  #ran = false

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisMetro', options, process.cwd())
    this.#state = state // null when the plugin should be inert (Rule 0 or Rule 7)
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
      // Opt this build's children into the loader's SIGTERM shard flush: jest-worker's
      // forceExit would otherwise silently drop a non-draining worker's shard (mechanics in
      // the KNOWN LIMITATIONS bullet above; the handler lives in hooks.js). The flag rides
      // process.env, so EVERY capturing child forked after config time inherits it --
      // Metro's transform workers are the intended audience, but a codegen fork the build
      // spawns rides along; the loader's own gates (child + shard forwarding) bound what it
      // can do there to a flush-then-redeliver on SIGTERM. The plugin can't act inside the
      // workers (only the loader runs there), so an env opt-in is the seam; scoped HERE,
      // not globally, because changing a child's default-kill disposition is otherwise the
      // user's domain. Two deliberate softenings:
      //   - keyed on the PRELOAD where one exists: the shard channel is minted by, and the
      //     children's capture mode follows, the preload's config -- a Rule-6 sidecar's own
      //     bundle mode says nothing about either, and setting the flag under a frozen
      //     preload would claim an opt-in that can never engage;
      //   - `||=`, not `=`: an explicit ambient opt-out ('0'/'false', envBool's disable
      //     values) is the user's call and is honored; only unset/empty is claimed.
      const channel = State.preload ?? state
      if (channel.config.writeLockfile || channel.config.writeBundle) {
        process.env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH ||= '1'
      }
    }
    // resources is a Config field now (validated + coordinated against any preload in
    // resolvePluginState); cache the resolved Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  // Build a Metro `serializer.customSerializer`: captures the graph AND `preModules`
  // (Metro's prepended polyfills/runtime -- real shipped files that the experimental hook
  // never sees), writes state, then produces output. With a `baseSerializer` we delegate to
  // it; with none we reproduce Metro's default output. This is the stable, full-coverage
  // surface (withStasis wires it for you). When the plugin is inert (see the guard below) it
  // returns the base unchanged and captures nothing.
  customSerializer(baseSerializer = undefined) {
    if (baseSerializer !== undefined && typeof baseSerializer !== 'function') {
      throw new TypeError('StasisMetro.customSerializer(base?): base must be a function or omitted')
    }
    // Inert (Rule 0 / Rule 7 in resolvePluginState -> #state === null): be TRANSPARENT and hand
    // the base serializer straight back (undefined when the caller had none) instead of wrapping
    // it. The wrapper below falls back to metroDefaultSerializer() when there is no base, which
    // loads Metro internals, OVERRIDES Metro's own serializer selection, and throws outright on
    // Metro versions where that internal path doesn't resolve -- none of which a do-nothing
    // plugin may do. Returning the base leaves the caller's serializer (or, via withStasis,
    // Metro's own default path) untouched, so wiring an inert plugin into a config is a genuine
    // no-op. The other plugins get this for free (their apply/onStart early-returns on a null
    // state); Metro's serializer seam has to opt out explicitly here.
    if (!this.#state) return baseSerializer
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
    // bundle=load: pass through -- load is served by the companion worker transformer, and
    // metro.config.js is itself attested at capture, so the same wiring must run unedited
    // in load mode (see the class note). Checked BEFORE the one-shot guard: load captures
    // nothing and legitimately re-serializes per rebuild under a dev server.
    if (this.#state.config.loadBundle) return
    // Watch/dev-server capture is EXPLICITLY UNSUPPORTED -- refuse the second serialization
    // loudly before it captures anything. Capture's dedupe is keyed by PATH, not content
    // (#seen below, plus State.write's compare-and-skip caches), so on a rebuild where a
    // file's bytes changed the plugin would skip re-capture: the emitted bundle would use the
    // new bytes while the stasis bundle/lockfile silently kept attesting the OLD ones. The
    // serializer fires exactly once per one-shot `metro build`; only a dev server
    // (`metro start`) re-invokes it, and Metro hands the serializer no watch-mode signal on
    // the FIRST build, so the first rebuild is the earliest point capture can refuse. (Load
    // mode has no such hazard and legitimately runs under a dev server -- it passed through
    // above, and the companion worker transformer only READS immutable attested bytes.)
    if (this.#ran) {
      throw new Error(
        'StasisMetro: watch/dev-server rebuilds are not supported for capture -- use a one-shot `metro build`'
      )
    }
    this.#ran = true
    this.#capture(graph, preModules)

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them here. The
    // serializer only runs once Metro has successfully built + transformed the whole graph
    // (a failed build throws before serialization), so this is the clean-build equivalent of
    // webpack's `stats.hasErrors()` / esbuild's `result.errors.length` gate -- and it runs at
    // most once per instance (the rebuild guard above), so this write is the one-shot build's
    // single flush.
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
    // AFTER the graph so #seen already holds every graph module: an auto-include that
    // did land in the graph this build (asyncRequire does when the app uses dynamic
    // import()) is deduped instead of re-recorded.
    this.#captureAutoIncludes()
    // AFTER the graph + auto-includes for the same dedupe reason: a native dependency's
    // JS that the app imports is already captured, so the native pass only adds the native
    // build-input surface (podspec/gradle/native sources) that no module graph carries.
    this.#captureNativeModules()
  }

  // Attest the AUTO_INCLUDES list (see its note above). Skips, per entry: a specifier
  // that doesn't resolve from the project (the file genuinely doesn't exist there --
  // nothing to attest), a file already captured as a graph module this build, and a
  // resolution landing outside the project root (unattestable -- lockfile/bundle keys
  // are root-relative; same out-of-scope stance as the load transformer's inScope).
  // Everything that IS attested goes through the exact addFile path graph modules use,
  // so frozen runs verify these files fail-closed like any other capture.
  #captureAutoIncludes() {
    for (const { specifier, resource } of AUTO_INCLUDES) {
      let modPath
      try {
        modPath = require.resolve(specifier, { paths: [this.#projectDir] })
      } catch {
        continue // not installed in this project -- nothing to attest
      }
      if (this.#seen.has(modPath)) continue
      try {
        this.#state.relative(modPath)
      } catch {
        continue // outside the project root -- unattestable
      }
      this.#seen.add(modPath)
      // Real reader for the same reason as #captureModules: this is plugin bookkeeping,
      // not a program fs read -- it must not be re-recorded by a --fs patched reader.
      const source = realReadFileSync(modPath)
      if (!resource) {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(pathToFileURL(modPath).toString(), { source, resource, reason: 'StasisMetro' })
    }
  }

  // Attest the NATIVE build-input surface of every autolinked native dependency (see the
  // NATIVE MODULES note above the class). Discovery is React Native's own `react-native
  // config`; each native dependency's package root is then walked (NATIVE_WALK_SKIP_DIRS
  // pruned) and its native sources are attested: build-input source (Java/Kotlin/Gradle, C/C++/
  // ObjC/Swift sources + headers, Ruby/CMake, podspec/Podfile, template/xml -- classifyNativeCapture)
  // as CODE under a source-language tag, the remaining assets (images, fonts, ...) as resources, plus each
  // package.json (kept in FULL by prune, so `codegenConfig` and native entry fields survive).
  // Node-runnable JS/TS is deliberately skipped: the code a build actually uses is already in
  // Metro's graph, and a library's UNused JS is neither a native input nor reachable, so
  // attesting it would violate stasis's only-what's-used thesis (and prune rightly trims it).
  // Skipped when the RN CLI isn't installed; per-dependency, a root outside the project is
  // skipped (unattestable -- keys are root-relative). Everything attested rides the same addFile
  // path as graph modules, so frozen runs verify it fail-closed.
  #captureNativeModules() {
    const config = loadReactNativeConfig(this.#projectDir)
    if (!config) return
    const roots = new Set()
    // Autolinked native deps: linked into the app regardless of whether their JS is imported.
    for (const dep of Object.values(config.dependencies ?? {})) {
      if (isNativeDependency(dep) && typeof dep.root === 'string' && isAbsolute(dep.root)) roots.add(dep.root)
    }
    // Native modules the app IMPORTS but autolinking never reports -- manually integrated via the
    // Podfile (e.g. @exodus/react-native-payments, whose podspec sits under lib/ios). Their JS is
    // in the graph; their podspec + native source are real build inputs config omits entirely.
    for (const root of this.#reachedNativePackageRoots()) roots.add(root)
    for (const root of roots) {
      try {
        this.#state.relative(root) // asserts the package lives inside the project root
      } catch {
        continue // outside the project root -- unattestable
      }
      this.#captureNativeTree(root, true)
    }
    // React Native CORE is NOT a `dependencies` entry -- `react-native config` reports only
    // `reactNativePath` and leaves build tools to find react-native's own podspecs there. Those
    // podspecs (third-party-podspecs/*, Libraries/*/*.podspec, ...) live in scattered subdirs
    // the config never enumerates, so the Podfile's references to them would go unattested.
    // Capture them here (podspecs only -- not core's full native source/scripts).
    const rnPath = config.reactNativePath
    if (typeof rnPath === 'string' && isAbsolute(rnPath)) {
      try {
        this.#state.relative(rnPath)
        this.#captureManifestTree(rnPath) // podspec-load surface across all of core
        // Plus specific core dirs/files the native build compiles/reads (Yoga, hermes-engine,
        // the CocoaPods scripts, .hermesversion) -- captured in full, not just their manifests.
        for (const sub of RN_CORE_INCLUDE_DIRS) this.#captureNativeTree(join(rnPath, sub))
        for (const file of RN_CORE_INCLUDE_FILES) this.#captureNativeFile(join(rnPath, file))
      } catch { /* react-native resolved outside the project root -- unattestable */ }
    }
  }

  // Attest a single vetted file (RN_CORE_INCLUDE_FILES) as a resource; skipped when absent in this
  // react-native version. Real reader (plugin bookkeeping, not a program fs read).
  #captureNativeFile(full) {
    if (this.#seen.has(full)) return
    let source
    try {
      source = realReadFileSync(full)
    } catch {
      return // not present in this react-native version
    }
    this.#seen.add(full)
    this.#state.addFile(pathToFileURL(full).toString(), { source, resource: true, reason: 'StasisMetro' })
  }

  // node_modules package roots the graph reached this build that ALSO ship native code (a podspec
  // anywhere, or an ios/android dir) -- the manually-integrated native modules `react-native
  // config` doesn't list. Derived from #seen (populated by the graph + auto-include passes that
  // run before this one). react-native CORE is excluded (handled podspecs-only via reactNativePath;
  // whole-package capturing its huge native source is out of scope).
  #reachedNativePackageRoots() {
    const pkgRoots = new Set()
    for (const abs of this.#seen) {
      const nm = splitNodeModulesPath(abs)
      if (!nm || nm.name === 'react-native') continue
      pkgRoots.add(nm.dir)
    }
    return [...pkgRoots].filter((root) => this.#looksNative(root))
  }

  // A package ships native code if it has an ios/ or android/ dir, or any podspec anywhere.
  #looksNative(root) {
    if (existsSync(join(root, 'ios')) || existsSync(join(root, 'android'))) return true
    return this.#hasPodspec(root)
  }

  // True if any *.podspec exists under `dir` (early-exit), pruning the same subtrees the capture
  // walks skip. Uses the genuine reader -- plugin bookkeeping, not a program fs read.
  #hasPodspec(dir) {
    let entries
    try {
      entries = realReaddirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      if (ent.isFile()) {
        if (isPodspec(ent.name)) return true
      } else if (ent.isDirectory() && !NATIVE_WALK_SKIP_DIRS.has(ent.name) && !isNativeArtifact(ent.name)) {
        if (this.#hasPodspec(join(dir, ent.name))) return true
      }
    }
    return false
  }

  // Recursively attest react-native core's podspec-LOAD surface under `dir` (see
  // #captureNativeModules): the podspecs `react-native config` never lists, the Ruby helpers they
  // `require` (hermes-engine.podspec -> hermes-utils.rb), and the package.json they parse -- but
  // NOT core's full native source. Prunes the same build-output/binary subtrees as
  // #captureNativeTree. package.json (format 'json'), podspecs (format 'podspec'), and the Ruby
  // helpers they require (.rb, format 'ruby') all ride the code path through the same addFile
  // path as any other capture.
  #captureManifestTree(dir) {
    let entries
    try {
      entries = realReaddirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!NATIVE_WALK_SKIP_DIRS.has(ent.name) && !isNativeArtifact(ent.name)) this.#captureManifestTree(full)
        continue
      }
      if (!ent.isFile() || !isNativeManifest(ent.name)) continue
      if (this.#seen.has(full)) continue
      this.#seen.add(full)
      const source = realReadFileSync(full)
      assert.ok(isUtf8(source), `StasisMetro: native manifest has non-UTF-8 bytes: ${full}`)
      // isNativeManifest only admits code: package.json + JSON podspecs ('json'), Ruby podspecs
      // ('podspec'), .rb helpers ('ruby') -- all ride the code path via classifyNativeCapture.
      const { format } = classifyNativeCapture(ent.name)
      this.#state.addFile(pathToFileURL(full).toString(), { source, format, reason: 'StasisMetro' })
    }
  }

  // Recursively attest the native build-input files under `dir`. Uses the genuine readers
  // (state-util.js) for the same reason as #captureModules: the walk is plugin bookkeeping,
  // not a program fs read, so a --fs patched readdir/readFile must not re-record it into the
  // preload/main state. Symlinks are not followed (cycle/escape hazard).
  #captureNativeTree(dir, atRoot = false) {
    let entries
    try {
      entries = realReaddirSync(dir, { withFileTypes: true })
    } catch {
      return // dir missing / not a directory (e.g. a root that no longer exists) -- nothing to walk
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip build-output subtrees, Apple binary bundles (*.framework/*.xcframework), and a
        // toplevel platform dir we're not capturing (windows/ off Windows).
        const skipDir = NATIVE_WALK_SKIP_DIRS.has(ent.name) || isNativeArtifact(ent.name) || (atRoot && isExcludedNativeDir(ent.name))
        if (!skipDir) this.#captureNativeTree(full)
        continue
      }
      if (!ent.isFile()) continue // sockets/FIFOs/etc. -- no attestable bytes
      // Prebuilt/installed binary artifacts (react-native-skia's `libs/` of .a/.so/.xcframework,
      // etc.) are build output, not source, and non-deterministic -- never captured.
      if (isNativeArtifact(ent.name)) continue
      if (this.#seen.has(full)) continue // already captured as a graph module or auto-include
      const { action, format } = classifyNativeCapture(ent.name)
      // Node-runnable JS/TS is captured via Metro's module graph, not here (reachable JS is in
      // the graph; unused JS is neither a native input nor reachable). package.json + native
      // SOURCE ride the code path (format set); everything else is an asset resource.
      if (action === 'skip') continue
      this.#seen.add(full)
      const source = realReadFileSync(full)
      const asResource = action === 'resource'
      if (!asResource) {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${full}`)
      }
      this.#state.addFile(pathToFileURL(full).toString(), { source, format, resource: asResource, reason: 'StasisMetro' })
    }
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
