import Module, { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, resolve as resolvePath } from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State } from './state.js'
import { installFsHooks } from './fs.js'

// Snapshot off the namespace so `--fs` (which patches fs.readFileSync and then
// syncBuiltinESMExports()s for user code) can't redirect the read the CJS-source
// capture below relies on. Same rationale as state.js / state-util.js.
const { readFileSync } = fs

// Warning: only covers code imports, not file reads

// Formats Node's module loader recognizes (and either executes, like `module`/
// `commonjs`/typescript variants, or imports as data, like `json`). The runtime
// loader treats this as the trust boundary -- a file served from the bundle whose
// attested format is outside this allowlist is refused at load time (and earlier
// at resolve, where applicable) with a contextual message. Adding a tag here
// means "Node can handle it"; everything else (resource/asset content,
// source-language bundles, an unknown string from a tampered or newer bundle)
// fails closed.
const NODEJS_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])

// Per-kind messages for the few categories we recognize; everything else gets a
// generic "unrecognized format" message. Kept separate from NODEJS_FORMATS so
// the allowlist stays the single trust gate and the message is just UX.
const NON_NODE_SOURCE_LANGUAGES = new Set(['solidity', 'php', 'bash', 'rust'])
const RESOURCE_FORMATS = new Set(['resource', 'resource:base64'])

function refuseNonNodeFormat(format, url) {
  if (NON_NODE_SOURCE_LANGUAGES.has(format)) {
    throw new Error(
      `[stasis] cannot execute a '${format}' bundle: ${format} bundles are ` +
      `produced for external analysis, not for 'stasis run --bundle=load' (${url})`
    )
  }
  if (RESOURCE_FORMATS.has(format)) {
    throw new Error(
      `[stasis] cannot import a resource file ('${format}'): asset content is not ` +
      `executable JavaScript. Read it with fs (or your bundler's asset loader) instead (${url})`
    )
  }
  if (format === 'directory') {
    throw new Error(
      `[stasis] cannot import a directory listing ('directory'): a captured ` +
      `fs.readdirSync result is not executable JavaScript. Read it with fs.readdirSync instead (${url})`
    )
  }
  // Unknown format string: usually a tampered or forward-incompatible bundle.
  throw new Error(
    `[stasis] cannot execute '${url}': attested format '${format}' is not a Node loader ` +
    `format. The bundle may be tampered, produced by a newer stasis, or built for a ` +
    `non-Node consumer.`
  )
}

let state
let saved = false
// Set when stasis's own capture/verification rejects something (see the hooks around
// addFile/addImport below). Distinct from "the run exited non-zero": a clean capture is
// allowed to exit non-zero for its own reasons and still be persisted.
let aborted = false
// >0 while Node's default loader (nextLoad) is reading a module's source -- which for
// CommonJS goes through the public fs.readFileSync the --fs hook patches. The module is
// already captured as code via addFile, so the --fs capture hook skips reads taken
// while this is set: it records the program's OWN fs reads, not Node's module loading.
let loadingModule = 0
// True until the first non-builtin load hook fires. Replaces the legacy
// `!state` heuristic for entry detection, which broke once initState could
// be triggered eagerly by plugins.js via ensureStateForLoader (state set
// before the entry's load).
let entryUnseen = true

// Child-process handling, WITHOUT intercepting child_process or adding a flag.
// EXODUS_STASIS_PID records the ROOT stasis process's pid -- the first stasis process in the
// tree (the one the CLI launches, or a direct `node --import`). It is unset there, so the
// root claims the slot with its own pid and is allowed to write. A process that ends up
// running this loader as a child -- child_process.fork() inherits our `--import` via
// process.execArgv automatically; a manual `spawn(node, ['--import', <loader>, ...])` does so
// explicitly -- inherits EXODUS_STASIS_PID through the environment but runs under a different
// pid. On that mismatch we suppress the bundle/lockfile write for ANY child, fork or not --
// the root owns the artifact, and a second writer to the same path would race it. We
// additionally relax the entry-point check for a FORKED child specifically (mismatch AND an
// IPC channel, which fork() always creates and a non-fork child lacks): its main module is a
// fork target, not a declared CLI entry, whereas a `node --import` child names its own entry.
// getFile() still fails closed on anything unattested. (A `stasis run` nested inside an
// already-running stasis process inherits the pid and is thus treated as a child too -- it
// won't write; run stasis at a single level.) Resolved once, before any user code runs.
const OWN_PID = String(process.pid)
if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// Resolve once at module-load: stasis-core's own package root. Passed to State
// as `preloadRoot` so state.write()'s backfill statically captures stasis-core's
// internal edges -- the (state.js -> config.js)-shape relative imports that
// were loaded by Node BEFORE install() registered our hooks and that the live
// resolve hook therefore never observed.
//
// `findPackageJSON` is wrapped because bundlers that ship this file as part
// of a captured bundle don't always have it mocked / wired up -- e.g. a
// metro-built bundle replaces node:module with its own shim where the API
// is absent. Returning undefined on failure makes the State constructor's
// `if (preloadRoot !== undefined)` skip cleanly; the backfill that consumes
// preloadRoot is a best-effort feature and falls through gracefully when
// it's unset.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
})()

function installSaveHandlers() {
  // Persist the lockfile/bundle on exit UNLESS a stasis verification rejected something.
  // We deliberately do NOT gate on the exit code: a clean capture that exits non-zero for
  // its own reasons -- a server running its own SIGINT shutdown and exiting 130, or any
  // script that returns non-zero -- must still persist what it captured. The hazard we
  // guard is narrower: addFile records a file's hash (which lock=add/replace then
  // serializes) *before* a later check -- the frozen bundle's byte/format/resolution
  // check, or a lock=add conflict against an existing lockfile -- can reject it. Writing
  // that would bake the rejected drift into the lockfile/bundle, so a subsequent
  // lock=frozen run would accept it. So we skip the write only when `aborted` is set, which
  // the hooks set whenever addFile/addImport throws -- catching a stasis rejection even if
  // user code swallows it (try/catch around a dynamic import) and exits 0.
  //
  // An abort that does NOT originate in addFile/addImport -- an uncaught module-not-found
  // (thrown by Node's resolver), or a user error after a partial-but-clean capture -- does
  // not taint, so the files captured so far ARE still written. That is intentional and
  // safe: those recorded hashes are accurate (nothing drifted is baked in), and a later
  // lock=frozen run fails closed on anything missing. Unhandled signals (SIGINT/SIGTERM
  // with no handler) bypass exit hooks entirely; servers own that behavior, we don't touch it.
  const save = () => {
    // Any child process (pid mismatch) must never persist -- fork OR a non-fork child that
    // inherited our loader: the root owns the lockfile/bundle, and a second writer to the
    // same path would race it.
    if (saved || aborted || isChildProcess) return
    saved = true
    state.write()
  }

  process.on('beforeExit', save)
  process.on('exit', save)
}

// Resolve the preload root the way the lazy hook inits do: full-scope load serves the
// entry from the bundle (it may not be on disk) so it anchors at cwd; every other mode
// reads the entry from disk, so it anchors at the entry's (process.argv[1]) package dir.
function resolvePreloadRoot() {
  const fullLoad = process.env.EXODUS_STASIS_BUNDLE === 'load' && process.env.EXODUS_STASIS_SCOPE !== 'node_modules'
  if (fullLoad) return process.cwd()
  const entry = process.argv[1]
  if (!entry) return process.cwd()
  try {
    return dirname(findPackageJSON(pathToFileURL(resolvePath(entry)).toString()))
  } catch {
    return process.cwd()
  }
}

// Synchronous, lenient State init -- the fallback used if a load/resolve hook fires
// before an eager initStateAsync() ran (e.g. a host that calls install() directly).
function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })
  installSaveHandlers()
}

// Eager, ASYNC State init for the runtime loader: reads the bundle with strict async
// decompression (rejects trailing garbage). loader.js awaits this BEFORE install()
// registers the synchronous module hooks, so by the time any module loads the State is
// already built and the synchronous hooks just serve from it. Idempotent.
export async function initStateAsync(root = resolvePreloadRoot()) {
  if (state) return
  state = await State.create(root, { preload: true, preloadRoot: PRELOAD_ROOT })
  installSaveHandlers()
}

function load(url, context, nextLoad) {
  assert.equal(typeof url, 'string')

  if (url.startsWith('node:')) {
    const result = nextLoad(url, context)
    assert.equal(result.format, 'builtin')
    return result
  }

  if (state && state.config.loadBundle) {
    // node_modules scope only bundles node_modules deps; everything else -- app/workspace
    // sources, including a workspace package symlinked into node_modules (its real path is
    // not under node_modules, so inNodeModules() is false) -- is read from disk via Node's
    // default loader. Gate on the canonical classification, not a raw '/node_modules/'
    // substring: otherwise such a symlink URL would be routed to state.getFile and crash,
    // since the file is a source deliberately omitted from the node_modules-scope bundle.
    if (!state.config.full && !state.inNodeModules(url)) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // context.format may be null when the resolve chain didn't set it (e.g. node_modules
    // scope, where non-nm parents go through nextResolve and Node's default doesn't
    // populate format for the load hook). Only cross-check when the chain provided one.
    // The `formats` map this value comes from is attested against the lockfile at State
    // construction (#mergeBundleMetadata) when a lockfile is loaded -- so a tampered
    // bundle can't flip module<->commonjs (or a .js file to module-typescript, which
    // would make Node strip type-argument-shaped syntax like `f<string>('x')`) for a
    // hash-valid file. Without a lockfile the bundle is self-authoritative for formats
    // just as it is for bytes (see getFile's hash carve-out).
    if (context.format != null) assert.equal(format, context.format)
    // Trust gate: the loader will only serve a file whose attested format Node
    // can actually execute. Resource assets (`resource`, `resource:base64`),
    // source-language bundles (solidity/php/bash/rust), and any unknown string
    // a tampered or forward-incompatible bundle might smuggle through all fail
    // closed here with a contextual message -- never as an opaque assertion.
    // *-typescript formats are in the allowlist: Node's own translators strip
    // the types after this hook returns.
    if (!NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    return { source, format, shortCircuit: true }
  }

  // nextLoad runs Node's default loader, which reads a CJS module's source through
  // the public fs.readFileSync the --fs hook patches. Mark the window so that hook
  // doesn't re-capture the module as a filesystem read (it's recorded as code below).
  loadingModule++
  let result
  try {
    result = nextLoad(url, context)
  } finally {
    loadingModule--
  }
  let { source } = result
  const { format } = result
  assert.notEqual(format, 'builtin')

  // Node's CJS loader may return source=null and read from disk itself; capture it for the bundle
  if (source == null && format === 'commonjs') source = readFileSync(fileURLToPath(url))

  // Entry detection: the FIRST non-builtin load through this hook is the
  // entry. `entryUnseen` (set true on every state init) flips to false after
  // the first load fires here. The pre-existing heuristic was `!state` --
  // tight while initState was lazy, but a plugin-driven `ensureStateForLoader`
  // path now eager-inits from cwd before the first load, so `!state` would
  // miss the entry. The flag lives module-local rather than on State because
  // it's strictly a hook-firing-order signal.
  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    initState(dirname(pkg))
  }

  assert.equal(saved, false)
  // A throw from addFile -- a frozen byte/format mismatch, an unattested file, a lock=add
  // conflict against an existing lockfile, ... -- means stasis rejected this capture. Flag
  // it so save() persists nothing, even if user code swallows the rejection (a try/catch
  // around a dynamic import) and the process then exits cleanly.
  try {
    state.addFile(url, { source, format, isEntry })
  } catch (err) {
    aborted = true
    throw err
  }

  return result
}

function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier)) {
    const res = nextResolve(specifier)
    assert.equal(res.url, specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    return res
  }

  if (context.importAttributes !== undefined) {
    const expectedAttrs = Object.create(null) // Saving is not supported yet, so we ensure expected ones
    if (extname(specifier) === '.json' && context.importAttributes?.type) expectedAttrs.type = 'json'
    assert.deepStrictEqual(context.importAttributes, expectedAttrs)
  }

  const { parentURL, conditions, importAttributes } = context

  // In full-scope load mode, the entry point is served from the bundle without touching
  // disk, so state must be initialised before nextResolve runs. node_modules scope reads
  // non-nm sources (including the entry) from disk, so state is initialised later in load().
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') {
    initState(process.cwd())
  }

  if (state && state.config.loadBundle) {
    // node_modules scope defers resolution of non-nm parents to Node. Relative imports
    // between non-nm sources then resolve to local files, and bare specifiers resolve via
    // the on-disk node_modules layout -- but the load() hook still serves the resulting
    // node_modules target from the bundle, so package contents need not be on disk. A
    // workspace source linked into node_modules is a non-nm parent (its canonical path is
    // outside node_modules), so it too is deferred -- hence inNodeModules() rather than a
    // raw '/node_modules/' substring on parentURL.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) {
      return nextResolve(specifier)
    }
    // Bare specifier with a parent is the regular ESM import: look up the recorded
    // import map. Otherwise we have either a pre-resolved file URL (CLI entries and
    // ESM-to-CJS translator require() targets both arrive that way) or a bare entry
    // specifier we anchor to cwd -- either way, skip nextResolve so the entry file
    // doesn't need to exist on disk.
    if (parentURL && !specifier.startsWith('file:')) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes })
      // Refuse a non-executable target at resolve time too. Catches the same
      // tampered/asset cases load() catches, just earlier and with the parent
      // module's URL in the stack trace for easier diagnosis. The load gate
      // remains the load-bearing one (a sibling resolver could deliver a target
      // that bypasses this branch); we throw here as a friendlier failure point.
      if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    const url = specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    // A forked child's main module is whatever the parent passed to fork(), not a declared
    // CLI entry, so it need not be in the bundle's entries list -- getFile() below still
    // rejects anything the bundle doesn't attest. The root run stays strict.
    if (!parentURL && state.config.full && !forkedChild) state.assertEntry(url)
    const format = state.getFormat(url)
    if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  // Only non-entry resolutions are import edges; an entry (no parentURL) is recorded via
  // addFile in load(), not addImport. Under lazy init this was implicit -- state was still
  // null during the entry's resolve -- but eager initStateAsync() sets state before the
  // entry resolves, so skip the no-parent case explicitly. As in load(): a rejected
  // resolution (frozen redirect mismatch, conflict, ...) must keep the captured state from
  // being written, swallowed or not.
  if (state && parentURL) {
    try {
      state.addImport(parentURL, specifier, url, { conditions, format, importAttributes })
    } catch (err) {
      aborted = true
      throw err
    }
  }
  return res
}

let installed = false

// True iff install() has run. Exported so plugins.js can detect "we're
// running under the stasis loader" even before the lazy initState fires --
// a bundler plugin constructed during webpack's config-parse can run
// AHEAD of the first user-file load hook, leaving State.preload null.
// resolvePluginState reads this to force-init State from cwd in that
// window so the plugin inherits the loader's config rather than erroring
// on the default lock mode.
export function isLoaderInstalled() {
  return installed
}

// Force-initialize state from process.cwd() if it hasn't been initialized
// yet. Used by plugins.js's resolvePluginState to ensure State.preload is
// available when the plugin constructor runs ahead of the load hook. A
// subsequent first-load through the load hook detects "state already set"
// and skips its own lazy initState, but still marks isEntry correctly via
// the entryUnseen flag.
export function ensureStateForLoader() {
  if (state) return
  initState(process.cwd())
}

// Register Node's module hooks. Kept separate from the --import entry points
// (loader.js here; the @exodus/stasis package's loader and --mock loader) so a
// host can evaluate this lib -- snapshotting node:fs/path/etc. for stasis's own
// use -- and compose extra setup (e.g. the tooling package's --mock side-effect
// denials) via static import order BEFORE the hooks are registered, with no
// env-var coordination. Idempotent.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // `--fs` (EXODUS_STASIS_FS = 'sync' | 'async'): additionally monkey-patch the fs
  // readers -- readFileSync/readdirSync + lstatSync/statSync, and under 'async' their
  // async (callback + fs.promises) counterparts -- to capture them into the bundle
  // (bundle=add|replace) or serve them from it (bundle=load). Installed here -- after
  // the lib's own fs snapshots (state.js / state-util.js / above) are taken and after
  // registerHooks -- so the patch never redirects stasis's own reads, and only when
  // the user opted in. `state` is read lazily (per call) since it's created when the
  // entry loads. A capture-side conflict (a file read twice with diverging bytes)
  // taints the run the same way an addFile/addImport rejection does, so nothing
  // inconsistent is written.
  const fsMode = process.env.EXODUS_STASIS_FS
  if (fsMode) {
    installFsHooks({
      // 'async' adds the async readers; any other truthy value (incl. the legacy '1')
      // is sync-only.
      async: fsMode === 'async',
      getState: () => state,
      // True while Node's default loader is reading a module's source: the --fs hook
      // skips those so it captures the program's explicit reads, not module loading.
      isLoadingModule: () => loadingModule > 0,
      // A genuine capture conflict (a file read twice mid-run with diverging bytes)
      // taints the run like an addFile/addImport rejection -- nothing is written.
      // Warn on the first taint so the discard isn't silent (the user's reads still
      // succeed, so the run otherwise exits 0 with no bundle/lockfile and no clue).
      markAborted: (err) => {
        if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
        aborted = true
      },
    })
  }
}

// registerHooks intercepts the ESM loader and Node's native CommonJS loader, but
// NOT the require() the ESM->CJS translator (node:internal/modules/esm/translators)
// builds when it evaluates a CJS module: that require resolves through
// Module._resolveFilename against disk before any hook runs. So a CJS module we
// serve from the bundle (`import chalk from 'chalk'`, chalk being CommonJS) has
// its nested require()s resolved on disk -- and once node_modules is pruned or
// shipped-without, `require('escape-string-regexp')` throws MODULE_NOT_FOUND
// before our hooks can serve it, i.e. the bundle isn't self-contained for a CJS
// dependency graph. Shim _resolveFilename in load mode to resolve such a target
// from the bundle's recorded import map and return its (possibly non-existent on
// disk) path; the load() hook then serves the bytes. For an edge the bundle
// doesn't record, or outside load mode, fall back to Node's native resolution.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      const parentURL = pathToFileURL(parent.filename).toString()
      // Same scope gate the resolve hook applies (see above): node_modules scope
      // only serves dependency parents from the bundle; workspace/app code is left
      // to Node's native resolution (read from disk). Without this the shim would
      // silently take over CJS resolution for app files too.
      if (state.config.full || state.inNodeModules(parentURL)) {
        const resolved = state.resolveBundled(parentURL, request)
        if (resolved !== undefined) return resolved
      }
    }
    const resolved = original.call(this, request, parent, ...rest)
    // Capture: require.resolve() (and, on some Node versions, CJS require()s)
    // resolve through native Module._resolveFilename WITHOUT firing the resolve
    // hook, so addImport never sees them. Observe the resolution here; write()'s
    // backfill records the ones the hook missed (deduped, in-bundle targets only).
    if (state && !loadMode && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      state.observeResolution(pathToFileURL(parent.filename).toString(), request, pathToFileURL(resolved).toString())
    }
    return resolved
  }
}
