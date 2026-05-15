import { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { State } from './state.js'

// Warning: only covers code imports, not file reads

let state
let saved = false

function initState(root) {
  state = new State(root)

  const save = () => {
    if (!saved) state.write()
  }

  process.on('nextTick', save)
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
    const { source, format } = state.getFile(url)
    assert.equal(format, context.format)
    assert.ok(format === 'module' || format === 'commonjs')
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

  const { parentURL, conditions } = context

  // In load mode, the entry point must be served from the bundle without touching disk.
  // Initialise state up front (using cwd, since findPackageJSON needs the entry file to exist).
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load') {
    initState(process.cwd())
  }

  if (state && state.config.loadBundle) {
    // A file URL specifier means the URL is already resolved: Node does this for CLI
    // entry paths, and the ESM-to-CJS translator passes resolved require() targets
    // through the resolve hook the same way.
    if (specifier.startsWith('file:')) {
      const url = specifier
      const format = state.formats.get(state.relative(state.absolute(url)))
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    if (parentURL) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions })
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    // Bare entry specifier without a parent: anchor to cwd so nextResolve doesn't
    // need the file on disk.
    const url = pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    const format = state.formats.get(state.relative(state.absolute(url)))
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  if (state) state.addImport(parentURL, specifier, url, { conditions, format })
  return res
}

registerHooks({ load, resolve })
