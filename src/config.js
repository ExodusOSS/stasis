import assert from 'node:assert/strict'

export class Config {
  #scope = 'node_modules'
  #mode = 'update'
  #bundle = 'none'

  loadConfig(json) {
    const {
      scope = this.#scope,
      mode = this.#mode,
      bundle = this.#bundle,
      ...rest
    } = JSON.parse(json)
    assert.ok(['node_modules', 'full'].includes(scope))
    assert.ok(['update', 'frozen'].includes(mode))
    assert.ok(['none', 'save', 'load'].includes(this.#bundle))
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#mode = mode
    this.#bundle = bundle

    if (this.#bundle === 'load' && this.#mode !== 'frozen') {
      throw new RangeError('bundle=load requires mode=frozen')
    }
  }

  get values() {
    return { scope: this.#scope }
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

  get json() {
    const data = { scope: this.#scope, mode: this.#mode, bundle: this.#bundle }
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
