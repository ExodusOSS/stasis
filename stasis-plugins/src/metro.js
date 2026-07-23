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
import { RN_CORE_INCLUDE_DIRS, RN_CORE_INCLUDE_FILES, classifyExtension, classifyFormat, classifyNativeCapture, isExcludedNativeDir, isNativeArtifact, isNativeManifest, isPodspec, splitNodeModulesPath } from '@exodus/stasis-core/util'

const require = createRequire(import.meta.url)

// Metro's `graph.entryPoints` is a Set now, an Array before ~0.71; normalize to a Set.
function entrySet(graph) {
  const ep = graph?.entryPoints
  if (ep instanceof Set) return ep
  if (Array.isArray(ep)) return new Set(ep)
  return new Set()
}

// Files a React Native build requires that Metro's module graph never carries; attested when
// they resolve from the project. Each is tagged by the shared classifier (see #captureAutoIncludes),
// so an auto-include is recorded under the SAME format any other capture path would give it.
const AUTO_INCLUDES = [
  'metro-runtime/src/modules/asyncRequire.js',
  '@react-native-community/cli/setup_env.sh',
]

// Subtrees skipped (by basename, any depth) when walking a native dep's build-input surface:
// nested packages (attested separately), VCS/CI metadata, demo apps, and regenerated build output.
const NATIVE_WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'example', 'examples', 'build', '.gradle', '.cxx', 'Pods',
])

// Run `react-native config` (RN's autolinking resolver) for native deps. Null when the RN CLI
// isn't installed; THROWS when present but failing -- silently under-attesting breaks frozen runs.
function loadReactNativeConfig(projectDir) {
  let cliPath
  try {
    cliPath = require.resolve('react-native/cli.js', { paths: [projectDir] })
  } catch {
    return null
  }
  // Run the child as vanilla Node: strip stasis's env and any inherited loader, else it joins
  // this capture nondeterministically or aborts on a config it can't satisfy.
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

// Native when at least one platform config is non-null; an all-null dep is JS-only (already in the graph).
function isNativeDependency(dep) {
  const platforms = dep?.platforms
  if (!platforms || typeof platforms !== 'object') return false
  return Object.values(platforms).some((p) => p != null)
}

// Metro has no public default-serializer export; reproduce its default output via internal
// baseJSBundle + bundleToString. Path moved: metro/src/* through ~0.82, metro/private/* from
// 0.81.4 on (the only option from 0.83), so the two-tier require below spans the range.
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
  // Metro ships CJS; require exposes the fn as the namespace or under `.default`.
  baseJSBundle = baseJSBundle.default ?? baseJSBundle
  bundleToString = bundleToString.default ?? bundleToString
  metroDefault = (entryPoint, preModules, graph, options) =>
    bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code
  return metroDefault
}

// Stasis capture plugin for Metro (React Native). Hooks Metro's serializer, which runs ONCE in
// the MAIN process with the full module graph -- a per-worker transformer's process-local State
// could never be merged. This is the CAPTURE half; the LOAD half is the companion
// ./metro-transformer.js. Wire both permanently (withStasis + transformerPath); the mode picks
// the active one, and under bundle=load this serializer is a transparent pass-through.
// Capture is one-shot (dev-server rebuilds refused, see #run) and REQUIRES --child-process so the
// worker-side toolchain (babel, RN preset) is attested (enforced in the constructor). withStasis
// wires the stable customSerializer -- the only surface that receives preModules; serializerHook
// is a lower-coverage fallback that never sees them.
export class StasisMetro {
  #seen = new Set()
  #state
  #resources

  // Base dir for resolution; snapshotted at construction so a later chdir can't skew capture.
  #projectDir = process.cwd()

  // Whether this instance already captured; the dev-server rebuild guard in #run trips on the second.
  #ran = false

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisMetro', options, process.cwd())
    this.#state = state // null when the plugin should be inert (Rule 0 or Rule 7)
    // A capture-that-writes REQUIRES --child-process: the worker toolchain (babel, RN preset) is
    // observed only in workers. Gate on writeLockfile||writeBundle so it's demanded only when
    // forwarding does something (frozen/load verify per-process and need no channel).
    if (state && (state.config.writeLockfile || state.config.writeBundle)) {
      assert.ok(
        state.config.childProcess,
        'StasisMetro: child-process capture must be enabled -- Metro transforms in worker processes, ' +
        'and without it the toolchain they load (babel.config.js, @babel/core, the RN preset + plugins) ' +
        'is never attested. Enable it: `stasis run --child-process ...`, EXODUS_STASIS_CHILD_PROCESS=1, ' +
        'or "childProcess": true in stasis.config.json.'
      )
      // Opt this build's children into the loader's SIGTERM shard flush (handler in hooks.js) so
      // jest-worker forceExit doesn't silently drop a non-draining worker's shard. Key on the
      // PRELOAD's mode where one exists (the shard channel follows it, not a Rule-6 sidecar), and
      // use `||=` not `=` so an explicit ambient opt-out ('0'/'false') is honored.
      const channel = State.preload ?? state
      if (channel.config.writeLockfile || channel.config.writeBundle) {
        process.env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH ||= '1'
      }
    }
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  // Build a Metro `serializer.customSerializer`: captures the graph + preModules (which the
  // experimental hook never sees), then delegates to base or reproduces Metro's default output.
  customSerializer(baseSerializer = undefined) {
    if (baseSerializer !== undefined && typeof baseSerializer !== 'function') {
      throw new TypeError('StasisMetro.customSerializer(base?): base must be a function or omitted')
    }
    // Inert (#state === null): hand the base straight back -- the wrapper below would otherwise
    // fall back to metroDefaultSerializer(), loading Metro internals a do-nothing plugin mustn't touch.
    if (!this.#state) return baseSerializer
    return (entryPoint, preModules, graph, options) => {
      this.#run(graph, preModules)
      const serialize = baseSerializer ?? metroDefaultSerializer()
      return serialize(entryPoint, preModules, graph, options)
    }
  }

  // `serializer.experimentalSerializerHook`: observation-only, and LOWER COVERAGE -- Metro never
  // passes preModules here, so the prepended polyfills/runtime go unattested. Prefer customSerializer.
  serializerHook = (graph, _delta) => {
    this.#run(graph)
  }

  #run(graph, preModules) {
    if (!this.#state) return
    // bundle=load: pass through (load is served by the worker transformer). Checked BEFORE the
    // one-shot guard -- load captures nothing and legitimately re-serializes under a dev server.
    if (this.#state.config.loadBundle) return
    // Watch/dev-server capture is unsupported: dedupe is keyed by PATH not content, so a rebuild
    // with changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Refuse
    // the second serialization loudly (the first rebuild is the earliest refusal point Metro allows).
    if (this.#ran) {
      throw new Error(
        'StasisMetro: watch/dev-server rebuilds are not supported for capture -- use a one-shot `metro build`'
      )
    }
    this.#ran = true
    this.#capture(graph, preModules)

    // The preload writes itself (hooks.js); standalone/sidecar States are written here. Reaching
    // serialization means a clean build (a failed build throws first), so no error gate is needed.
    if (this.#state !== State.preload) this.#state.write()
  }

  #capture(graph, preModules) {
    const entries = entrySet(graph)
    // preModules first (Metro's prepended polyfills/runtime; synthetic ones like __prelude__ are
    // skipped by the existsSync guard below), then the app graph.
    if (preModules) this.#captureModules(preModules, entries)
    this.#captureModules(graph.dependencies.values(), entries)
    // AFTER the graph so #seen already holds graph modules -- an auto-include that landed in the
    // graph (asyncRequire, when the app uses dynamic import()) is deduped, not re-recorded.
    this.#captureAutoIncludes()
    // AFTER the graph + auto-includes (same dedupe reason): the native pass only adds the native
    // build-input surface (podspec/gradle/sources) that no module graph carries.
    this.#captureNativeModules()
  }

  // Attest the AUTO_INCLUDES list. Per entry, skip: unresolvable, already-seen, or resolving
  // outside the project root (keys are root-relative). Attested entries ride the normal addFile path.
  #captureAutoIncludes() {
    for (const specifier of AUTO_INCLUDES) {
      let modPath
      try {
        modPath = require.resolve(specifier, { paths: [this.#projectDir] })
      } catch {
        continue
      }
      if (this.#seen.has(modPath)) continue
      try {
        this.#state.relative(modPath)
      } catch {
        continue
      }
      this.#seen.add(modPath)
      // Real reader: plugin bookkeeping, not a program fs read -- must not be re-recorded by --fs.
      const source = realReadFileSync(modPath)
      // Tag from the ONE shared classifier, so an auto-include agrees with every OTHER capture
      // path that meets the same file (the native walk via classifyNativeCapture, --fs via
      // addFsFile): a concrete name/shebang code format (setup_env.sh -> 'shell'), null for a
      // JS-family file (let addFile infer commonjs/module), or a raw resource when unrecognized.
      // The auto-include list is stasis-vetted, so an unrecognized entry still bypasses the
      // `resources` allowlist. Recording setup_env.sh under its real 'shell' format -- not a
      // forced 'resource' -- is what stops a native-walk (or --fs) 'shell' record for the same
      // bytes from tripping the format noupsert with a 'resource' vs 'shell' conflict.
      const format = classifyFormat(modPath, { content: source })
      const resource = format === undefined
      if (!resource) {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(pathToFileURL(modPath).toString(), { source, format: format ?? undefined, resource, reason: 'metro' })
    }
  }

  // Attest each autolinked native dependency's build-input surface. Discovery is `react-native
  // config`; each dep root is walked (NATIVE_WALK_SKIP_DIRS pruned) and its native sources are
  // attested as code, other assets as resources, plus each package.json. Node-runnable JS/TS is
  // skipped (already in Metro's graph). Skipped when the RN CLI is absent or a root is outside root.
  #captureNativeModules() {
    const config = loadReactNativeConfig(this.#projectDir)
    if (!config) return
    const roots = new Set()
    // Autolinked native deps: linked into the app regardless of whether their JS is imported.
    for (const dep of Object.values(config.dependencies ?? {})) {
      if (isNativeDependency(dep) && typeof dep.root === 'string' && isAbsolute(dep.root)) roots.add(dep.root)
    }
    // Native modules the app imports but autolinking never reports (manually integrated via Podfile).
    for (const root of this.#reachedNativePackageRoots()) roots.add(root)
    for (const root of roots) {
      try {
        this.#state.relative(root) // asserts the package lives inside the project root
      } catch {
        continue
      }
      this.#captureNativeTree(root, true)
    }
    // RN CORE isn't a `dependencies` entry (config reports only reactNativePath), so its scattered
    // podspecs would go unattested. Capture them here (podspecs only, not core's full native source).
    const rnPath = config.reactNativePath
    if (typeof rnPath === 'string' && isAbsolute(rnPath)) {
      try {
        this.#state.relative(rnPath)
        this.#captureManifestTree(rnPath) // podspec-load surface across all of core
        // Plus specific core dirs/files (Yoga, hermes-engine, CocoaPods scripts) captured in full.
        for (const sub of RN_CORE_INCLUDE_DIRS) this.#captureNativeTree(join(rnPath, sub))
        for (const file of RN_CORE_INCLUDE_FILES) this.#captureNativeFile(join(rnPath, file))
      } catch { /* react-native resolved outside the project root -- unattestable */ }
    }
  }

  // Attest a single vetted file (RN_CORE_INCLUDE_FILES) as a resource; skipped when absent.
  #captureNativeFile(full) {
    if (this.#seen.has(full)) return
    let source
    try {
      source = realReadFileSync(full)
    } catch {
      return
    }
    this.#seen.add(full)
    this.#state.addFile(pathToFileURL(full).toString(), { source, resource: true, reason: 'metro' })
  }

  // node_modules roots the graph reached that also ship native code (podspec or ios/android dir):
  // the manually-integrated native modules `react-native config` omits. Derived from #seen; RN core
  // is excluded (handled podspecs-only above).
  #reachedNativePackageRoots() {
    const pkgRoots = new Set()
    for (const abs of this.#seen) {
      const nm = splitNodeModulesPath(abs)
      if (!nm || nm.name === 'react-native') continue
      pkgRoots.add(nm.dir)
    }
    return [...pkgRoots].filter((root) => this.#looksNative(root))
  }

  #looksNative(root) {
    if (existsSync(join(root, 'ios')) || existsSync(join(root, 'android'))) return true
    return this.#hasPodspec(root)
  }

  // True if any *.podspec exists under `dir`, pruning the same subtrees the capture walk skips.
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

  // Recursively attest RN core's podspec-load surface under `dir`: podspecs, the Ruby helpers they
  // require, and package.json -- NOT core's full native source. Prunes the same subtrees as #captureNativeTree.
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
      // isNativeManifest admits only code (package.json/JSON podspecs, Ruby podspecs, .rb helpers).
      const { format } = classifyNativeCapture(ent.name)
      this.#state.addFile(pathToFileURL(full).toString(), { source, format, reason: 'metro' })
    }
  }

  // Recursively attest native build-input files under `dir`. Genuine readers (plugin bookkeeping,
  // not re-recorded by --fs); symlinks not followed (cycle/escape hazard).
  #captureNativeTree(dir, atRoot = false) {
    let entries
    try {
      entries = realReaddirSync(dir, { withFileTypes: true })
    } catch {
      return // dir missing / not a directory -- nothing to walk
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip build-output subtrees, Apple binary bundles, and an off-platform toplevel dir.
        const skipDir = NATIVE_WALK_SKIP_DIRS.has(ent.name) || isNativeArtifact(ent.name) || (atRoot && isExcludedNativeDir(ent.name))
        if (!skipDir) this.#captureNativeTree(full)
        continue
      }
      if (!ent.isFile()) continue // sockets/FIFOs/etc. -- no attestable bytes
      // Prebuilt binary artifacts are build output, non-deterministic -- never captured.
      if (isNativeArtifact(ent.name)) continue
      if (this.#seen.has(full)) continue // already captured as a graph module or auto-include
      const { action, format } = classifyNativeCapture(ent.name)
      // Node-runnable JS/TS is captured via Metro's graph, not here (action==='skip').
      if (action === 'skip') continue
      this.#seen.add(full)
      const source = realReadFileSync(full)
      const asResource = action === 'resource'
      if (!asResource) {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${full}`)
      }
      this.#state.addFile(pathToFileURL(full).toString(), { source, format, resource: asResource, reason: 'metro' })
    }
  }

  #captureModules(modules, entries) {
    for (const module of modules) {
      // module.path is the absolute path (both graph modules and preModules carry it).
      const modPath = module?.path
      // Skip synthetic/virtual modules (require.context's ?ctx=, __prelude__): no on-disk bytes to hash.
      if (typeof modPath !== 'string' || !isAbsolute(modPath) || !existsSync(modPath)) continue

      const kind = classifyExtension(modPath, this.#resources)
      if (kind === 'unknown') {
        throw new Error(
          `StasisMetro: unsupported extension for '${modPath}' -- ` +
          `add its extension or filename to the plugin's resources option or stop importing it`
        )
      }
      const url = pathToFileURL(modPath).toString()

      // Outgoing edges: as-written specifier is `dep.data.name`, target `dep.absolutePath`.
      // Only code targets get an edge (resource imports are captured as files, no edge).
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

      // Read from disk, not module.getSource() -- addFile re-reads disk and asserts byte-equality.
      // Real reader (state-util.js): a --fs-patched readFileSync would re-record the graph into the preload.
      const source = realReadFileSync(modPath)
      // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
      if (kind === 'code') {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(url, { source, isEntry: entries.has(modPath), resource: kind === 'resource', reason: 'metro' })
    }
  }
}

// Idiomatic Metro-config wrapper: returns a new config with `serializer.customSerializer` wired
// so stasis captures the graph + preModules while your existing serializer (or Metro's default)
// still produces the bundle. Pure -- returns a new object, doesn't mutate `config`.
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
