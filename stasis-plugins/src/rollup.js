import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route rollup's reads through the capture hook.
import { realReadFile } from '@exodus/stasis-core/state-util'
import { classifyExtension } from '@exodus/stasis-core/util'

// Rollup chains resolveId/load hooks first-non-null-wins, so put this plugin FIRST in `plugins`:
// listed later, a sibling resolver (node-resolve, commonjs) answers before stasis sees the edge --
// capture would under-record specifiers and load mode would fall back to sibling disk resolution
// (file BYTES still fail closed at the load hook, which serves every in-scope path it reaches).
export class StasisRollup {
  #seen = new Set()
  #state
  #resources

  // Build starts observed by this instance (watch rebuilds and separate rollup() calls sharing one
  // plugin object both re-fire buildStart); the second is refused there.
  #captureBuildCount = 0

  name = 'stasis'

  constructor(options = {}, unsupported = undefined) {
    // StasisEsbuild's second { loaders, transform } bag has no rollup analogue (transforms run as
    // ordinary rollup plugins after this one) -- refuse it so a port doesn't silently drop it.
    assert.equal(unsupported, undefined,
      'StasisRollup takes a single options argument -- there is no esbuild-style { loaders, transform } bag (run transforms as rollup plugins after this one)')
    // A caller that owns a State (e.g. tests) can pass it directly; a foreign-copy State fails
    // closed via the instanceof miss.
    const state = options instanceof State
      ? options
      : resolvePluginState('StasisRollup', options, process.cwd()).state
    this.#state = state
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
    if (!state) return // noop plugin: no hooks assigned, rollup sees only `name`

    // Hooks are per-instance functions, not prototype methods: rollup invokes them with `this`
    // bound to its PluginContext (whose resolve/getModuleInfo the hooks need), so instance state
    // has to arrive via the closure instead.
    const plugin = this
    this.resolveId = async function (source, importer, opts) {
      return plugin.#resolveId(this, source, importer, opts)
    }
    this.load = async function (id) {
      return plugin.#load(this, id)
    }

    // A warm `cache:` from a previous build makes rollup reuse cached module code and dependency
    // resolutions WITHOUT calling resolveId/load, so a capture would silently drop those modules'
    // edges and bytes from the attestation, and a load-mode build would consume cached code no
    // hook re-verified. Strip it (rollup still builds a fresh cache for this run) -- StasisMetro's
    // withStasis drops Metro's cacheStores for the same hazard. `cache: true/false` carries no
    // prior modules, so only an object is a hazard.
    this.options = (inputOptions) => {
      if (typeof inputOptions.cache !== 'object' || inputOptions.cache === null) return null
      console.warn(
        '[stasis] StasisRollup: ignoring the `cache` option for this build -- cached modules ' +
        'bypass the stasis hooks, so their imports and bytes would go unattested at capture and ' +
        'unverified at load'
      )
      return { ...inputOptions, cache: undefined }
    }

    if (!state.config.loadBundle) {
      // Watch/rebuild capture is unsupported: dedupe is keyed by PATH not content, so a rebuild with
      // changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Watch rebuilds
      // (and a second rollup() call reusing this instance) re-fire buildStart, so an instance counter
      // catches the second and errors.
      this.buildStart = () => {
        plugin.#captureBuildCount += 1
        if (plugin.#captureBuildCount === 1) return
        throw new Error(
          'StasisRollup: watch/rebuild is not supported for capture -- run a one-shot build (rebuilds would silently attest stale content)'
        )
      }

      // Capture epilogue: flag entries from the completed graph, then persist. resolveId's
      // opts.isEntry is never trusted for attestation -- rollup defaults it to !importer, so a
      // sibling's bare `this.resolve(id)` probe looks exactly like an entry and would widen the
      // attested set of runnable roots. The graph's ModuleInfo.isEntry is authoritative (real
      // `input` entries and emitFile'd chunks -- both genuinely run as roots; probes never join
      // the graph).
      this.buildEnd = function (error) {
        return plugin.#buildEnd(this, error)
      }
    }
  }

  // Rollup asset plugins (url/image/...) read their file from disk themselves inside their own
  // load hook -- there is no seam to hand them attested bytes (load hooks don't chain), so a
  // resource under bundle=load can't be served faithfully and must fail loudly, not fall back to
  // unattested disk bytes.
  #refuseResourceLoad(path) {
    throw new Error(
      `StasisRollup: bundle=load can't serve resource '${path}' -- rollup asset plugins read ` +
      'from disk directly, so attested replay is not possible; keep sources on disk and use a ' +
      'capture/verify mode instead'
    )
  }

  // Accept only the `type` import attribute; other attributes aren't persistable to the lockfile
  // yet. Checked only where an edge is recorded (addImport) or queried (getImport), so an
  // attributed EXTERNAL passes through untouched -- exactly as under StasisEsbuild, whose
  // equivalent assert sits in onLoad, which externals never reach.
  #assertPersistableAttributes(attrs) {
    for (const k of Object.keys(attrs)) {
      assert.equal(k, 'type', `unsupported import attribute: ${k}`)
    }
  }

  // Throws when `id` is a '?'/'#'-suffixed variant of an on-disk path (rollup's plugin-param
  // convention, e.g. './icon.svg?url'): the underlying bytes feed the build, but the suffixed key
  // can't be persisted or replayed, so skipping it would silently leave a build input unattested
  // (a frozen run would be blind to tampering). The esbuild plugin refuses its `suffix` analogue
  // the same way. A fully virtual id (nothing on disk under the stripped path either) is a
  // sibling plugin's own module and stays skippable, like \0-prefixed ids.
  #refuseSuffixedOnDisk(id) {
    const stripped = id.split(/[?#]/u, 1)[0]
    if (stripped !== id && existsSync(stripped)) {
      throw new Error(
        `StasisRollup: can't attest suffixed module id '${id}' (the on-disk file '${stripped}' ` +
        "with a '?'/'#' suffix) -- stasis can't persist suffixes; disable the plugin minting it " +
        'or import the file directly'
      )
    }
  }

  // True when `id` is an on-disk file; false defers a virtual id to its owning plugin. The
  // dangerous middle case -- a suffixed variant of a real file -- refuses instead (see above).
  #existsOrRefuseSuffixed(id) {
    if (existsSync(id)) return true
    this.#refuseSuffixedOnDisk(id)
    return false
  }

  #classifyOrThrow(id) {
    const kind = classifyExtension(id, this.#resources)
    if (kind === 'unknown') {
      throw new Error(
        `StasisRollup: unsupported extension for '${id}' -- add its extension or filename to the plugin's resources option or stop importing it`
      )
    }
    return kind
  }

  #inRoot(path) {
    try {
      this.#state.relative(path)
      return true
    } catch {
      return false
    }
  }

  async #resolveId(ctx, source, importer, opts) {
    // Built-ins are never bundled or recorded as edges; hand them back to rollup (null) so the
    // user's external config applies. SECURITY: never consult getImport for a builtin name, so a
    // tampered bundle can't redirect `fs` to an arbitrary file.
    if (isBuiltin(source)) return null
    const { isEntry, attributes: attrs = {} } = opts

    // Load mode: resolution comes from the bundle's import map, not rollup's resolver -- the file
    // may not be on disk. Return the original absolute path so output bytes match a capture build.
    if (this.#state.config.loadBundle) {
      if (isEntry) {
        // Entry-flagged resolutions cover real `input` entries, emitFile'd chunks, and -- because
        // rollup defaults isEntry to !importer -- bare sibling probes. Anchor like rollup's own
        // resolver: against the importer when one exists (emitFile passes it), else cwd (like the
        // run loader). No assertEntry here: a probe is indistinguishable from an entry at this
        // point, so the load hook asserts from the graph's authoritative isEntry instead -- and a
        // probe that never loads is never asserted.
        if (source.startsWith('file:')) return { id: fileURLToPath(source) }
        const base = importer && isAbsolute(importer) && !importer.startsWith('\0')
          ? dirname(importer)
          : process.cwd()
        return { id: resolvePath(base, source) }
      }
      // A missing, virtual, or out-of-root importer was never the bundle's responsibility -- defer to rollup.
      if (!importer || importer.startsWith('\0') || !isAbsolute(importer)) return null
      if (!this.#inRoot(importer)) return null
      const parentURL = pathToFileURL(importer).toString()
      this.#assertPersistableAttributes(attrs)
      // Forward import attributes (`with { type: 'json' }`) so plugin-capture round-trips to
      // plugin-load, both keyed under `* (with: ...)`.
      let url, format
      try {
        ;({ url, format } = this.#state.getImport(parentURL, source, { importAttributes: attrs }))
      } catch (err) {
        // No attested edge -- at a successful capture that's an EXTERNAL (never recorded as an
        // edge), so hand it back to rollup. File BYTES still fail closed at the load hook.
        // A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
        if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
        throw err
      }
      const path = fileURLToPath(url)
      // Refuse a resource only when load mode would actually serve it: an out-of-scope workspace
      // resource under node_modules scope comes from disk via the user's asset plugin, exactly
      // like a capture build (the load hook defers it with the same scope gate).
      if (Bundle.isResourceFormat(format) && (this.#state.config.full || this.#state.inNodeModules(url))) {
        this.#refuseResourceLoad(path)
      }
      // KNOWN GAP: sibling resolution metadata (moduleSideEffects, syntheticNamedExports, meta)
      // isn't persisted in the bundle, so load mode can't replay it -- tree-shaking of a module a
      // sibling marked side-effect-free at capture may differ from the capture build's output.
      return { id: path }
    }

    // Capture: run the remaining resolveId hooks plus rollup's default algorithm (skipSelf guards
    // re-entry), record the observed edge, and pass the resolution through unchanged.
    const resolution = await ctx.resolve(source, importer, { ...opts, skipSelf: true })
    if (!resolution || resolution.external) return resolution
    const { id } = resolution
    // Skip virtual modules (\0-prefixed or otherwise not an on-disk file); a suffixed variant of
    // an on-disk file refuses inside the check rather than slipping through unattested.
    if (id.startsWith('\0') || !isAbsolute(id) || !this.#existsOrRefuseSuffixed(id)) return resolution
    this.#classifyOrThrow(id)

    // Record the edge for BOTH code and resource targets, but never for entries (matching the
    // loader) and never for an out-of-root importer (not the project's graph; load mode defers
    // those parents the same way). Entries are flagged from the graph in buildEnd instead of
    // trusting opts.isEntry -- see the constructor comment.
    if (!isEntry && importer && isAbsolute(importer) && !importer.startsWith('\0') && this.#inRoot(importer)) {
      this.#assertPersistableAttributes(attrs)
      if (!this.#inRoot(id)) {
        throw new Error(
          `StasisRollup: '${source}' imported from ${importer} resolves outside the project root and can't be attested: ${id}`
        )
      }
      this.#state.addImport(pathToFileURL(importer).toString(), source, pathToFileURL(id).toString(), { importAttributes: attrs })
    }
    return resolution
  }

  async #load(ctx, id) {
    // Load mode: serve bytes the bundle attested. getFile verifies the hash and throws on a file
    // the bundle doesn't carry -- a missing in-scope file is a hard error, not a disk fallback.
    // In scope = full (everything under state.root) or node_modules-only per scope; ids other
    // plugins resolved land here too, so the gate can't rely on our own resolveId alone.
    if (this.#state.config.loadBundle) {
      if (id.startsWith('\0') || !isAbsolute(id)) return null
      if (!this.#inRoot(id)) return null // out of the project root -- not ours
      const url = pathToFileURL(id).toString()
      // Entries are asserted here from the graph's authoritative isEntry (known before load runs):
      // a sibling's bare resolve() probe carries isEntry too but never loads, so only genuine
      // roots reach this gate.
      if (this.#state.config.full && ctx.getModuleInfo(id)?.isEntry) this.#state.assertEntry(url)
      if (!this.#state.config.full && !this.#state.inNodeModules(url)) return null
      const { source, format } = this.#state.getFile(url)
      if (Bundle.isResourceFormat(format)) this.#refuseResourceLoad(id)
      // Code is stored as UTF-8 text, exactly what rollup's parser expects.
      return source
    }

    // Capture. Skip virtual modules and classify the rest exactly like the resolve hook (a sibling
    // resolver may have minted ids our resolveId never saw). One read doubles as the existence
    // check: ENOENT defers -- unless the id is a suffixed variant of an on-disk file, which
    // refuses -- and any other read error is real.
    if (id.startsWith('\0') || !isAbsolute(id)) return null
    let source
    try {
      source = await realReadFile(id)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      this.#refuseSuffixedOnDisk(id)
      return null
    }
    const kind = this.#classifyOrThrow(id)
    if (!this.#inRoot(id)) {
      throw new Error(`StasisRollup: module is outside the project root and can't be attested: ${id}`)
    }
    const url = pathToFileURL(id).toString()

    if (kind === 'resource') {
      // Mark as a resource (State picks 'resource' vs 'resource:base64' from bytes). Return null:
      // loading it into the graph is the user's asset plugin's job.
      if (!this.#seen.has(id)) {
        this.#seen.add(id)
        this.#state.addFile(url, { source, resource: true, reason: 'rollup' })
      }
      return null
    }

    // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
    assert.ok(isUtf8(source), `StasisRollup: code-classified file has non-UTF-8 bytes: ${id}`)

    if (!this.#seen.has(id)) {
      this.#seen.add(id)
      this.#state.addFile(url, { source, reason: 'rollup' })
    }

    // Return the attested bytes so the build consumes exactly what was recorded (transform hooks
    // still run after, symmetrically with load mode).
    return source.toString('utf8')
  }

  // Capture epilogue (see the constructor comment): flag real entries from the completed graph,
  // then write standalone/sidecar States -- only on a clean build (a partial one would overwrite
  // the user's good file). buildEnd, not closeBundle: the capture is complete once the graph is,
  // and closeBundle only fires when the caller remembers bundle.close().
  async #buildEnd(ctx, error) {
    if (error) return
    const entryIds = [...ctx.getModuleIds()].filter((id) => {
      if (!this.#seen.has(id)) return false // virtual/external/unattested ids never joined the capture
      const info = ctx.getModuleInfo(id)
      return Boolean(info?.isEntry) && !info.isExternal
    })
    // Re-record each entry with the flag set: addFile re-verifies the bytes against disk, and a
    // RESOURCE entry fails loudly here ('a resource can't be an entry'), matching StasisEsbuild,
    // instead of silently writing an artifact whose entries list omits the build's real entry.
    const sources = await Promise.all(entryIds.map((id) => realReadFile(id)))
    for (const [i, id] of entryIds.entries()) {
      const resource = classifyExtension(id, this.#resources) === 'resource'
      this.#state.addFile(pathToFileURL(id).toString(), { source: sources[i], isEntry: true, resource, reason: 'rollup' })
    }
    // The preload writes itself (hooks.js); standalone/sidecar States are written here.
    if (this.#state !== State.preload) this.#state.write()
  }
}
