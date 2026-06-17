import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { classifyExtension, parseResourcesOption, resolvePluginState } from './plugins.js'
import { State } from './state.js'

// Metro's module graph keys entries differently across versions: a `Set<string>`
// of entry paths historically, a `Map<path, ...>` in newer releases, and the
// CLI's one-shot `build` only hands us the graph (no separate entry-point arg).
// Normalize all three into a Set of absolute entry paths so `isEntry` is a single
// `.has` regardless of the Metro version in play. An absent/unexpected shape
// yields an empty set -- nothing is marked an entry rather than throwing, matching
// how the other plugins treat an entry they can't positively identify.
function entrySet(graph) {
  const ep = graph?.entryPoints
  if (ep instanceof Set) return ep
  if (ep instanceof Map) return new Set(ep.keys())
  if (Array.isArray(ep)) return new Set(ep)
  return new Set()
}

// Stasis plugin for the Metro bundler (React Native).
//
// WHY THIS HOOKS THE SERIALIZER, NOT A TRANSFORMER:
//   Metro transforms each file in a pool of WORKER processes. A stasis State is
//   process-local (its observed sources/imports/formats live in in-memory Maps
//   flushed by State.write on the main process), so a transformer-side capture
//   would scatter observations across workers that never reach the writer.
//   Metro's serializer -- and the observation-only `experimentalSerializerHook`
//   -- instead run once, in the MAIN process, AFTER the whole graph is built,
//   with the complete module graph in hand. That is the one place a single
//   State can see every module and every resolution edge, so it is where stasis
//   captures (mirrors webpack's normalModuleFactory.afterResolve and esbuild's
//   onResolve/onLoad, which likewise run in the bundler's main process).
//
// CAPTURE ONLY -- bundle=load IS NOT SUPPORTED:
//   The other plugins can serve bundle bytes back into the build because their
//   bundler reads + transforms files in the same process the bundle lives in
//   (webpack's inputFileSystem wrapper, esbuild's onLoad). Metro reads and
//   transforms in workers, before serialization; by the time the serializer sees
//   a module its on-disk bytes have already been transformed elsewhere. There is
//   no main-process seam to inject bundle bytes into, so load mode can't be
//   honored faithfully and is rejected loudly rather than silently ignored.
//   Capture modes (lock/bundle add|replace|frozen, and lock=none/ignore) all work:
//   they only observe the built graph and the files on disk.
//
// USAGE (metro.config.js):
//   const { StasisMetro } = require('@exodus/stasis/metro')
//   const stasis = new StasisMetro(/* { scope, lock, bundle, resources, ... } */)
//   module.exports = {
//     serializer: {
//       // Preferred: observation-only hook, stasis never touches the output bytes.
//       experimentalSerializerHook: stasis.serializerHook,
//       // OR, if you already run a customSerializer (or want the stable API),
//       // wrap it so stasis captures and your serializer still produces output:
//       // customSerializer: stasis.wrapSerializer(myCustomSerializer),
//     },
//   }
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

  // Wire into `serializer.experimentalSerializerHook`. Metro calls this with the
  // full graph (and a delta) on every (re)build purely to observe -- it ignores
  // the return value and keeps producing output itself, so stasis never has to
  // reproduce Metro's bundle bytes. Bound so it can be passed by reference.
  serializerHook = (graph, _delta) => {
    this.#run(graph)
  }

  // Wire into `serializer.customSerializer` when you already have one (or prefer
  // the stable API over the experimental hook). Captures off the same graph, then
  // delegates to your serializer for the actual bundle output. The base serializer
  // is required: Metro has no stable "default serializer" export to fall back to,
  // and silently emitting wrong output would be worse than asking for it.
  wrapSerializer(baseSerializer) {
    assert.equal(
      typeof baseSerializer, 'function',
      'StasisMetro.wrapSerializer(base) requires the base customSerializer to wrap'
    )
    return (entryPoint, preModules, graph, options) => {
      this.#run(graph)
      return baseSerializer(entryPoint, preModules, graph, options)
    }
  }

  #run(graph) {
    if (!this.#state) return
    if (this.#state.config.loadBundle) {
      throw new Error(
        'StasisMetro: bundle=load is not supported -- Metro transforms files in worker ' +
        'processes before serialization, so the plugin can only observe the built graph, ' +
        'not serve bundle bytes back into the build. Use bundle=add/replace/frozen to capture.'
      )
    }
    this.#capture(graph)

    // The stasis preload owns its own write via beforeExit/exit hooks (stasis-core/hooks.js).
    // Standalone and sidecar States have no such hook, so the plugin writes them here. The
    // serializer only runs once Metro has successfully built + transformed the whole graph
    // (a failed build throws before serialization), so this is the clean-build equivalent of
    // webpack's `stats.hasErrors()` / esbuild's `result.errors.length` gate. In watch / dev
    // mode the hook fires on every rebuild; State.write's per-artifact compare-and-skip makes
    // the unchanged-graph case a cheap no-op.
    if (this.#state !== State.preload) this.#state.write()
  }

  #capture(graph) {
    const entries = entrySet(graph)
    for (const [modPath, module] of graph.dependencies) {
      // Skip synthetic / virtual modules (Metro injects some with non-disk paths):
      // a path that isn't an existing absolute file has no bytes to hash. Mirrors
      // webpack's `path.isAbsolute(filePath) && existsSync(filePath)` guard and
      // esbuild's `namespace === 'file'` gate -- those resolutions aren't real
      // source files, so they bypass capture entirely.
      if (typeof modPath !== 'string' || !isAbsolute(modPath) || !existsSync(modPath)) continue

      const kind = classifyExtension(modPath, this.#resources)
      if (kind === 'unknown') {
        throw new Error(
          `StasisMetro: unsupported extension for '${modPath}' -- ` +
          `add its extension to the plugin's resources option or stop importing it`
        )
      }
      const url = pathToFileURL(modPath).toString()

      // Record this module's outgoing resolution edges. Metro keys a module's
      // `dependencies` by an internal key; the as-written specifier is `dep.data.name`
      // (e.g. './hello' or 'react-native') and the resolved target is
      // `dep.absolutePath`. We only attest edges whose TARGET is code: resource
      // imports (an asset pulled in for its bytes) are captured as files below but
      // carry no import edge, matching webpack/esbuild (`kind === 'code'` gate).
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

      // Read the bytes from disk rather than `module.getSource()` -- addFile re-reads
      // disk and asserts byte-equality against what we pass, and disk is the thing
      // stasis attests. (webpack and esbuild likewise read the file themselves.)
      const source = readFileSync(modPath)
      // Code-classified files must be UTF-8. A code extension carrying non-UTF-8 bytes
      // is malformed input; refuse it rather than silently encoding it as a resource.
      // Resource-classified files pass through as-is -- State derives 'resource' vs
      // 'resource:base64' from the content.
      if (kind === 'code') {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      this.#state.addFile(url, { source, isEntry: entries.has(modPath), resource: kind === 'resource' })
    }
  }
}
