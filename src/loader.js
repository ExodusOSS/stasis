import { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State } from './state.js'

// Warning: only covers code imports, not file reads

// Formats produced by the non-JS source bundlers (Solidity/Bash/Rust). These
// bundles are inspection artifacts, not runnable by Node's module loader.
const NON_EXECUTABLE_FORMATS = new Set(['solidity', 'bash', 'rust'])

let state
let saved = false

function initState(root) {
  state = new State(root, { preload: true })

  const save = () => {
    if (saved) return
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
    // node_modules scope only bundles node_modules sources; non-tracked files are read
    // from disk through Node's default loader (state.getFile is never called for them).
    if (!state.config.full && !url.includes('/node_modules/')) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // context.format may be null when the resolve chain didn't set it (e.g. node_modules
    // scope, where non-nm parents go through nextResolve and Node's default doesn't
    // populate format for the load hook). Only cross-check when the chain provided one.
    // TODO: format here is sourced from the bundle's `formats` map, which the lockfile
    // does not currently cover; a tampered bundle can flip module<->commonjs for a
    // hash-valid file. Derive format from extension + module.type (recorded in the
    // lockfile) and reject the bundle's claim when it disagrees.
    if (context.format != null) assert.equal(format, context.format)
    // Non-JS bundles (`stasis bundle` of .sol/.sh/.bash/.rs) tag files with
    // their source language. They're artifacts for external analysis, not
    // executable by Node — surface that clearly instead of an opaque
    // format assertion if one is ever loaded via `--bundle=load`.
    if (NON_EXECUTABLE_FORMATS.has(format)) {
      throw new Error(`[stasis] cannot execute a '${format}' bundle: ${format} bundles are produced for external analysis, not for 'stasis run --bundle=load' (${url})`)
    }
    assert.ok(['module', 'commonjs', 'json'].includes(format))
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
  state.addFile(url, { source, format, isEntry })

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
    // node_modules target from the bundle, so package contents need not be on disk.
    if (!state.config.full && !parentURL?.includes('/node_modules/')) {
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
  if (state) state.addImport(parentURL, specifier, url, { conditions, format, importAttributes })
  return res
}

// --mock: install network/timer/fetch denials *before* registerHooks. Doing it
// here -- after stasis's own state.js / loader.js / etc. have captured their
// destructured `import { writeFileSync } from 'node:fs'` bindings from the
// real fs, but before any user code is loaded through the hooks -- lets the
// mock call module.syncBuiltinESMExports() to refresh the node:fs ESM wrapper
// without affecting bindings that have already been linked. Stasis keeps its
// real fs; user-code ESM imports of node:fs (and the network/timer builtins)
// get the post-sync mocked wrapper. Loading mock.js *inside* loader.js (rather
// than via a second --import) also avoids the "first non-node file goes through
// the hook and becomes the bundle entry" trap.
if (process.env.EXODUS_STASIS_MOCK === '1') {
  await import('./mock.js')
}

registerHooks({ load, resolve })
