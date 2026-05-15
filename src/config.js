import assert from 'node:assert/strict'

const {
  EXODUS_STASIS_SCOPE: envScope,
  EXODUS_STASIS_MODE: envMode,
  EXODUS_STASIS_BUNDLE: envBundle,
  EXODUS_STASIS_BUNDLE_FILE: envBundleFile,
  EXODUS_STASIS_DEBUG: envDebug,
} = process.env

export class Config {
  #scope = envScope || 'full'
  #mode = envMode || 'update'
  #bundle = envBundle || 'none'
  #bundleFile = envBundleFile || undefined
  #debug = Boolean(envDebug && envDebug !== '0')

  loadConfig(json) {
    const {
      scope = this.#scope,
      mode = this.#mode,
      bundle = this.#bundle,
      debug = this.#debug,
      ...rest
    } = JSON.parse(json)
    assert.ok(['node_modules', 'full'].includes(scope))
    assert.ok(['update', 'frozen'].includes(mode))
    assert.ok(['none', 'ignore', 'save', 'load'].includes(bundle))
    assert.ok([false, true].includes(debug))
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#mode = mode
    this.#bundle = bundle
    this.#debug = debug

    if (this.#bundle === 'load' && this.#mode !== 'frozen') {
      throw new RangeError('bundle=load requires mode=frozen')
    }

    try {
      if (envScope) assert.equal(this.#scope, envScope)
      if (envMode) assert.equal(this.#mode, envMode)
      if (envBundle) assert.equal(this.#bundle, envBundle)
      if (envBundleFile) assert.equal(this.#bundleFile, envBundleFile)
      if (envDebug) assert.equal(this.#debug, Boolean(envDebug && envDebug !== '0'))
    } catch (cause) {
      throw new Error('Flags/env can not override stasis.config.json', { cause })
    }
  }

  get bundleFile() {
    return this.#bundleFile
  }

  get debug() {
    return this.#debug
  }

  get values() {
    return { scope: this.#scope }
  }

  get bundle() {
    return this.#bundle !== 'none' && this.#bundle !== 'ignore'
  }

  get ignoreBundle() {
    return this.#bundle === 'ignore'
  }

  get writeBundle() {
    return this.#bundle === 'save'
  }

  get loadBundle() {
    return this.#bundle === 'load'
  }

  get full() {
    return this.#scope === 'full'
  }

  get frozen() {
    return this.#mode === 'frozen'
  }

  get scope() {
    return this.#scope
  }

  get json() {
    const data = { scope: this.#scope, mode: this.#mode, bundle: this.#bundle }
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
