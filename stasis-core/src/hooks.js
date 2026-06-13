import { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State } from './state.js'

// Warning: only covers code imports, not file reads

// Formats produced by the non-JS source bundlers (Solidity/PHP/Bash/Rust).
// These bundles are inspection artifacts, not runnable by Node's module loader.
const NON_EXECUTABLE_FORMATS = new Set(['solidity', 'php', 'bash', 'rust'])

let state
let saved = false
// Set when stasis's own capture/verification rejects something (see the hooks around
// addFile/addImport below). Distinct from "the run exited non-zero": a clean capture is
// allowed to exit non-zero for its own reasons and still be persisted.
let aborted = false

function initState(root) {
  state = new State(root, { preload: true })

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
    if (saved || aborted) return
    saved = true
    state.write()
  }

  process.on('beforeExit', save)
  process.on('exit', save)
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
    // Non-JS bundles (`stasis bundle` of .sol/.php/.sh/.bash/.rs) tag files with
    // their source language. They're artifacts for external analysis, not
    // executable by Node — surface that clearly instead of an opaque
    // format assertion if one is ever loaded via `--bundle=load`.
    if (NON_EXECUTABLE_FORMATS.has(format)) {
      throw new Error(`[stasis] cannot execute a '${format}' bundle: ${format} bundles are produced for external analysis, not for 'stasis run --bundle=load' (${url})`)
    }
    // *-typescript formats are produced by `stasis bundle` for .ts/.cts/.mts
    // sources; Node's own translators strip the types after this hook returns.
    assert.ok(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'].includes(format))
    return { source, format, shortCircuit: true }
  }

  const result = nextLoad(url, context)
  let { source } = result
  const { format } = result
  assert.notEqual(format, 'builtin')

  // Node's CJS loader may return source=null and read from disk itself; capture it for the bundle
  if (source == null && format === 'commonjs') source = readFileSync(fileURLToPath(url))

  const isEntry = !state
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
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    const url = specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    if (!parentURL && state.config.full) state.assertEntry(url)
    return { url, format: state.getFormat(url), importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  // As in load(): a rejected resolution (frozen redirect mismatch, conflict, ...) must keep
  // the captured state from being written, swallowed or not.
  if (state) {
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
}
