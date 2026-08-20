import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { isAbsolute, resolve as resolvePath } from 'node:path'
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
  #entries = new Set()
  #state
  #resources

  // Build starts observed by this instance (watch rebuilds and separate rollup() calls sharing one
  // plugin object both re-fire buildStart); the second is refused there.
  #captureBuildCount = 0

  name = 'stasis'

  constructor(options = {}) {
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
    // bound to its PluginContext (whose .resolve the capture path needs), so instance state has to
    // arrive via the closure instead.
    const plugin = this
    this.resolveId = async function (source, importer, opts) {
      return plugin.#resolveId(this, source, importer, opts)
    }
    this.load = async (id) => plugin.#load(id)

    // Watch/rebuild capture is unsupported: dedupe is keyed by PATH not content, so a rebuild with
    // changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Watch rebuilds
    // (and a second rollup() call reusing this instance) re-fire buildStart, so an instance counter
    // catches the second and errors.
    if (!state.config.loadBundle) {
      this.buildStart = () => {
        plugin.#captureBuildCount += 1
        if (plugin.#captureBuildCount === 1) return
        throw new Error(
          'StasisRollup: watch/rebuild is not supported for capture -- run a one-shot build (rebuilds would silently attest stale content)'
        )
      }
    }

    // The preload writes itself (hooks.js); standalone/sidecar States are written when the module
    // graph completes -- only on a clean build (a partial one would overwrite the user's good file).
    // buildEnd, not closeBundle: the capture is complete once the graph is, and closeBundle only
    // fires when the caller remembers bundle.close().
    if (state !== State.preload) {
      this.buildEnd = (error) => {
        if (error) return
        state.write()
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

  async #resolveId(ctx, source, importer, opts) {
    // Built-ins are never bundled or recorded as edges; hand them back to rollup (null) so the
    // user's external config applies. SECURITY: never consult getImport for a builtin name, so a
    // tampered bundle can't redirect `fs` to an arbitrary file.
    if (isBuiltin(source)) return null
    const isEntry = opts?.isEntry ?? !importer
    const attrs = opts?.attributes ?? {}
    // Accept only the `type` import attribute; other attributes aren't persistable to the lockfile yet.
    for (const k of Object.keys(attrs)) {
      assert.equal(k, 'type', `unsupported import attribute: ${k}`)
    }

    // Load mode: resolution comes from the bundle's import map, not rollup's resolver -- the file
    // may not be on disk. Return the original absolute path so output bytes match a capture build.
    if (this.#state.config.loadBundle) {
      let url
      if (isEntry) {
        // Bare/relative entries are anchored to cwd (like the run loader), so the file needn't be on disk.
        url = source.startsWith('file:')
          ? source
          : pathToFileURL(resolvePath(process.cwd(), source)).toString()
        if (this.#state.config.full) this.#state.assertEntry(url)
      } else {
        // A virtual or out-of-root importer was never the bundle's responsibility -- defer to rollup.
        if (importer.startsWith('\0') || !isAbsolute(importer)) return null
        try { this.#state.relative(importer) } catch { return null }
        const parentURL = pathToFileURL(importer).toString()
        // Forward import attributes (`with { type: 'json' }`) so plugin-capture round-trips to
        // plugin-load, both keyed under `* (with: ...)`.
        try {
          ;({ url } = this.#state.getImport(parentURL, source, { importAttributes: attrs }))
        } catch (err) {
          // No attested edge -- at a successful capture that's an EXTERNAL (never recorded as an
          // edge), so hand it back to rollup. File BYTES still fail closed at the load hook.
          // A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
          if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
          throw err
        }
      }
      const path = fileURLToPath(url)
      if (Bundle.isResourceFormat(this.#state.getFormat(url))) this.#refuseResourceLoad(path)
      return { id: path }
    }

    // Capture: run the remaining resolveId hooks plus rollup's default algorithm (skipSelf guards
    // re-entry), record the observed edge, and pass the resolution through unchanged.
    const resolution = await ctx.resolve(source, importer, { ...opts, skipSelf: true })
    if (!resolution || resolution.external) return resolution
    const { id } = resolution
    // Skip virtual modules (\0-prefixed or otherwise not an on-disk file): no bytes to attest.
    if (id.startsWith('\0') || !isAbsolute(id) || !existsSync(id)) return resolution

    const kind = classifyExtension(id, this.#resources)
    if (kind === 'unknown') {
      throw new Error(
        `StasisRollup: unsupported extension for '${id}' -- add its extension or filename to the plugin's resources option or stop importing it`
      )
    }
    if (isEntry) {
      // Remember entries so the load hook can flag addFile(isEntry) -- rollup's load hook has no
      // entry context of its own.
      this.#entries.add(id)
    } else if (importer && isAbsolute(importer) && !importer.startsWith('\0')) {
      // Record the edge for BOTH code and resource targets (never entries): load mode resolves
      // every specifier through this map, so a resource with no edge would miss at bundle=load and
      // fall through to rollup's disk resolver -- serving the asset UNATTESTED.
      this.#state.addImport(pathToFileURL(importer).toString(), source, pathToFileURL(id).toString(), { importAttributes: attrs })
    }
    return resolution
  }

  async #load(id) {
    // Load mode: serve bytes the bundle attested. getFile verifies the hash and throws on a file
    // the bundle doesn't carry -- a missing in-scope file is a hard error, not a disk fallback.
    // In scope = full (everything under state.root) or node_modules-only per scope; ids other
    // plugins resolved land here too, so the gate can't rely on our own resolveId alone.
    if (this.#state.config.loadBundle) {
      if (id.startsWith('\0') || !isAbsolute(id)) return null
      try { this.#state.relative(id) } catch { return null } // out of the project root -- not ours
      const url = pathToFileURL(id).toString()
      if (!this.#state.config.full && !this.#state.inNodeModules(url)) return null
      const { source, format } = this.#state.getFile(url)
      if (Bundle.isResourceFormat(format)) this.#refuseResourceLoad(id)
      // Code is stored as UTF-8 text, exactly what rollup's parser expects.
      return source
    }

    // Capture. Skip virtual modules; classify the rest exactly like the resolve hook (a sibling
    // resolver may have minted ids our resolveId never saw).
    if (id.startsWith('\0') || !isAbsolute(id) || !existsSync(id)) return null
    const kind = classifyExtension(id, this.#resources)
    if (kind === 'unknown') {
      throw new Error(
        `StasisRollup: unsupported extension for '${id}' -- add its extension or filename to the plugin's resources option or stop importing it`
      )
    }

    const source = await realReadFile(id)
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
      this.#state.addFile(url, { source, isEntry: this.#entries.has(id), reason: 'rollup' })
    }

    // Return the attested bytes so the build consumes exactly what was recorded (transform hooks
    // still run after, symmetrically with load mode).
    return source.toString('utf8')
  }
}
