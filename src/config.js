import assert from 'node:assert/strict'

const {
  EXODUS_STASIS_SCOPE: envScope,
  EXODUS_STASIS_LOCK: envLock,
  EXODUS_STASIS_BUNDLE: envBundle,
  EXODUS_STASIS_BUNDLE_FILE: envBundleFile,
  EXODUS_STASIS_DEBUG: envDebug,
} = process.env

export class Config {
  #scope = envScope || 'full'
  #lock = envLock || 'add'
  #bundle = envBundle || 'none'
  #bundleFile = envBundleFile || undefined
  #debug = Boolean(envDebug && envDebug !== '0')

  loadConfig(json) {
    const {
      scope = this.#scope,
      lock = this.#lock,
      bundle = this.#bundle,
      debug = this.#debug,
      ...rest
    } = JSON.parse(json)
    assert.ok(['node_modules', 'full'].includes(scope))
    assert.ok(['none', 'ignore', 'add', 'replace', 'frozen'].includes(lock))
    assert.ok(['none', 'ignore', 'add', 'replace', 'load'].includes(bundle))
    assert.ok([false, true].includes(debug))
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#lock = lock
    this.#bundle = bundle
    this.#debug = debug

    if (this.#bundle === 'load' && this.#lock !== 'frozen' && this.#lock !== 'none' && this.#lock !== 'ignore') {
      throw new RangeError('bundle=load requires lock=(frozen|none|ignore)')
    }

    if (this.#lock === 'none' && this.#bundle === 'none') {
      throw new RangeError('lock=none requires bundle=(add|replace|load|ignore)')
    }

    try {
      if (envScope) assert.equal(this.#scope, envScope)
      if (envLock) assert.equal(this.#lock, envLock)
      if (envBundle) assert.equal(this.#bundle, envBundle)
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
    return this.#bundle === 'add' || this.#bundle === 'replace'
  }

  get replaceBundle() {
    return this.#bundle === 'replace'
  }

  get loadBundle() {
    return this.#bundle === 'load'
  }

  get full() {
    return this.#scope === 'full'
  }

  get frozen() {
    return this.#lock === 'frozen'
  }

  get useLockfile() {
    return this.#lock !== 'none' && this.#lock !== 'ignore'
  }

  get ignoreLockfile() {
    return this.#lock === 'ignore'
  }

  get writeLockfile() {
    return this.#lock === 'add' || this.#lock === 'replace'
  }

  get replaceLockfile() {
    return this.#lock === 'replace'
  }

  get scope() {
    return this.#scope
  }

  get lock() {
    return this.#lock
  }

  get json() {
    const data = { scope: this.#scope, lock: this.#lock, bundle: this.#bundle }
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
