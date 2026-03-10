import { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname } from 'node:path'
import assert from 'node:assert/strict'

import { State } from './state.js'

// Warning: only covers code imports, not file reads

let state
let saved = false

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
    assert.ok(format === 'module') // TODO: cjs
    return { source, format, shortCircuit: true }
  }

  const result = nextLoad(url, context)
  assert.notEqual(result.format, 'builtin')

  const isEntry = !state
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    const root = dirname(pkg)
    state = new State(root)

    const save = () => {
      if (!saved) state.write()
    }

    process.on('nextTick', save)
    process.on('beforeExit', save)
    process.on('exit', save)
  }


  assert.equal(saved, false)
  state.addFile(url, result.source, result.format, isEntry)

  return result
}

function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier)) {
    const res = nextResolve(specifier)
    assert.equal(res.url, specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    return res
  }

  assert.equal(Object.keys(context.importAttributes).length, 0) // unsupported yet
  const { parentURL, conditions } = context

  if (state && state.config.loadBundle) {
    const { url, format } = state.getImport(parentURL, specifier, { conditions })
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
