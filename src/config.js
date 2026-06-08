import assert from 'node:assert/strict'

const VALID_SCOPE = new Set(['node_modules', 'full'])
const VALID_LOCK = new Set(['none', 'ignore', 'add', 'replace', 'frozen'])
const VALID_BUNDLE = new Set(['none', 'ignore', 'add', 'replace', 'load'])

const envDebugBool = (value) => Boolean(value && value !== '0')

const OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'debug']

// Plugins accept the same options as Config but want to validate without constructing one,
// since constructing State has side effects. Mirror Config's per-field validation.
export function validatePluginOptions(label, options) {
  const rest = { ...options }
  for (const key of OPTION_KEYS) delete rest[key]
  assert.equal(Object.keys(rest).length, 0, `Unknown ${label} options: ${Object.keys(rest).join(', ')}`)
  const { scope, lock, bundle, bundleFile, debug } = options
  if (scope !== undefined) assert.ok(VALID_SCOPE.has(scope), `Invalid scope: ${scope}`)
  if (lock !== undefined) assert.ok(VALID_LOCK.has(lock), `Invalid lock: ${lock}`)
  if (bundle !== undefined) assert.ok(VALID_BUNDLE.has(bundle), `Invalid bundle: ${bundle}`)
  if (bundleFile !== undefined) assert.equal(typeof bundleFile, 'string', 'bundleFile must be a string')
  if (debug !== undefined) assert.equal(typeof debug, 'boolean', 'debug must be a boolean')
}

// When a plugin runs against a State that already exists (preload path), the active Config
// is authoritative. Any options the plugin was given must agree with it.
export function assertOptionsMatchConfig(config, options) {
  const { scope, lock, bundle, bundleFile, debug } = options
  try {
    if (scope !== undefined) assert.equal(config.scope, scope)
    if (lock !== undefined) assert.equal(config.lock, lock)
    if (bundle !== undefined) assert.equal(config.bundleMode, bundle)
    if (bundleFile !== undefined) assert.equal(config.bundleFile, bundleFile)
    if (debug !== undefined) assert.equal(config.debug, debug)
  } catch (cause) {
    throw new Error('Plugin options conflict with active stasis state', { cause })
  }
}

export class Config {
  #env
  #explicit
  #scope
  #lock
  #bundle
  #bundleFile
  #debug

  // Options match the CLI flags (lock/bundle/bundleFile/scope/debug). Env vars take effect at
  // construction time; if both env and an option are set they must agree. Likewise,
  // any explicit constructor option is treated as authoritative: a later `loadConfig`
  // call (which reads stasis.config.json) must agree with it -- the alternative
  // (silently overwriting `--scope=full` with the file's `"scope":"node_modules"`)
  // was a footgun the CLI couldn't detect, since the flag was happily accepted
  // and then quietly ignored.
  constructor(options = {}) {
    const { scope, lock, bundle, bundleFile, debug, ...rest } = options
    assert.equal(Object.keys(rest).length, 0, `Unknown Config options: ${Object.keys(rest).join(', ')}`)
    this.#explicit = { scope, lock, bundle, bundleFile, debug }

    this.#env = {
      scope: process.env.EXODUS_STASIS_SCOPE || undefined,
      lock: process.env.EXODUS_STASIS_LOCK || undefined,
      bundle: process.env.EXODUS_STASIS_BUNDLE || undefined,
      bundleFile: process.env.EXODUS_STASIS_BUNDLE_FILE || undefined,
      debug: process.env.EXODUS_STASIS_DEBUG || undefined,
    }

    try {
      if (this.#env.scope !== undefined && scope !== undefined) assert.equal(this.#env.scope, scope)
      if (this.#env.lock !== undefined && lock !== undefined) assert.equal(this.#env.lock, lock)
      if (this.#env.bundle !== undefined && bundle !== undefined) assert.equal(this.#env.bundle, bundle)
      if (this.#env.bundleFile !== undefined && bundleFile !== undefined) {
        assert.equal(this.#env.bundleFile, bundleFile)
      }
      if (this.#env.debug !== undefined && debug !== undefined) {
        assert.equal(envDebugBool(this.#env.debug), debug)
      }
    } catch (cause) {
      throw new Error('Config options can not override stasis env', { cause })
    }

    this.#scope = this.#env.scope || scope || 'full'
    this.#lock = this.#env.lock || lock || 'add'
    this.#bundle = this.#env.bundle || bundle || 'none'
    this.#bundleFile = this.#env.bundleFile || bundleFile || undefined
    this.#debug = this.#env.debug !== undefined ? envDebugBool(this.#env.debug) : (debug ?? false)

    this.#checkInvariants()
  }

  // Per-field validation + cross-field invariants. Constructor (options path) and
  // loadConfig (disk path) both call this so the rules live in one place.
  #checkInvariants() {
    assert.ok(VALID_SCOPE.has(this.#scope), `Invalid scope: ${this.#scope}`)
    assert.ok(VALID_LOCK.has(this.#lock), `Invalid lock: ${this.#lock}`)
    assert.ok(VALID_BUNDLE.has(this.#bundle), `Invalid bundle: ${this.#bundle}`)
    assert.equal(typeof this.#debug, 'boolean', 'debug must be a boolean')
    if (this.#bundleFile !== undefined) assert.equal(typeof this.#bundleFile, 'string', 'bundleFile must be a string')

    // bundle=load needs a trust root for source bytes: frozen pins each file's sha512 in
    // the lockfile and we cross-check it on load; otherwise the bundle is itself
    // authoritative -- lock=none with no lockfile on disk, or lock=ignore with a lockfile
    // deliberately bypassed.
    // WARNING: lockfile attests only to source BYTES, not bundle metadata.
    if (this.#bundle === 'load' && this.#lock !== 'frozen' && this.#lock !== 'none' && this.#lock !== 'ignore') {
      throw new RangeError('bundle=load requires lock=(frozen|none|ignore)')
    }

    if (this.#lock === 'none' && this.#bundle === 'none') {
      throw new RangeError('lock=none requires bundle=(add|replace|load|ignore)')
    }
  }

  loadConfig(json) {
    const {
      scope = this.#scope,
      lock = this.#lock,
      bundle = this.#bundle,
      debug = this.#debug,
      ...rest
    } = JSON.parse(json)
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#lock = lock
    this.#bundle = bundle
    this.#debug = debug
    this.#checkInvariants()

    try {
      if (this.#env.scope !== undefined) assert.equal(this.#scope, this.#env.scope)
      if (this.#env.lock !== undefined) assert.equal(this.#lock, this.#env.lock)
      if (this.#env.bundle !== undefined) assert.equal(this.#bundle, this.#env.bundle)
      if (this.#env.debug !== undefined) assert.equal(this.#debug, envDebugBool(this.#env.debug))
      // Explicit constructor options are equally authoritative: an explicit
      // `--scope=full` shouldn't be silently overridden by an on-disk
      // `{"scope":"node_modules"}`. The asserts mirror the env block above.
      if (this.#explicit.scope !== undefined) assert.equal(this.#scope, this.#explicit.scope)
      if (this.#explicit.lock !== undefined) assert.equal(this.#lock, this.#explicit.lock)
      if (this.#explicit.bundle !== undefined) assert.equal(this.#bundle, this.#explicit.bundle)
      if (this.#explicit.debug !== undefined) assert.equal(this.#debug, this.#explicit.debug)
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

  get bundleMode() {
    return this.#bundle
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
