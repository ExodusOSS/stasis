import assert from 'node:assert/strict'

const VALID_SCOPE = new Set(['node_modules', 'full'])
const VALID_LOCK = new Set(['none', 'ignore', 'add', 'replace', 'frozen'])
const VALID_BUNDLE = new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen'])

// The defaults Config applies when neither env nor options specify a value.
// Exported so callers (plugins.js error messages) can reference the same source of
// truth instead of hardcoding the literal -- a default drift then surfaces at one
// place, not silently in a user-facing message.
export const DEFAULT_LOCK = 'add'
export const DEFAULT_BUNDLE = 'none'
export const DEFAULT_SCOPE = 'full'

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
    // Re-throw with the underlying assertion message folded into the top-level
    // text -- a plugin author hitting this gets the offending field's name and
    // expected/actual values without having to inspect err.cause.
    throw new Error(`Plugin options conflict with active stasis state: ${cause.message}`, { cause })
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

    this.#scope = this.#env.scope || scope || DEFAULT_SCOPE
    this.#lock = this.#env.lock || lock || DEFAULT_LOCK
    this.#bundle = this.#env.bundle || bundle || DEFAULT_BUNDLE
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
    // WARNING: the lockfile attests source bytes, entries, module identity, and
    // (when it records them) resolutions and loader formats. Lockfiles predating
    // a given attestation cover only what they recorded (bytes at minimum).
    if (this.#bundle === 'load' && this.#lock !== 'frozen' && this.#lock !== 'none' && this.#lock !== 'ignore') {
      throw new RangeError('bundle=load is incompatible with lock=(add|replace)')
    }

    // bundle=frozen places no constraint on lock: unlike load it never *serves* the
    // bundle's bytes, it reads each file from disk and verifies it against the bundle's
    // own recorded bytes/resolutions/formats (the bundle is itself the trust root, so it
    // needs no sibling lockfile -- it "operates as a lockfile"). It composes with any lock
    // mode, and (being a real bundle) satisfies the "needs a lockfile or a bundle" rule
    // below -- which only rejects leaving both unset.
    if (this.#lock === 'none' && this.#bundle === 'none') {
      throw new RangeError('stasis needs a lockfile or a bundle: set lock or bundle')
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

  // bundle=frozen: the bundle is a read-only attestation, like a frozen lockfile.
  // It is loaded (its bytes/resolutions/entries/modules become the attested set) but
  // never rewritten, and every file/resolution observed from disk is checked against
  // it. Distinct from load (which serves bytes from the bundle instead of reading disk)
  // and from add (which loads-then-rewrites and tolerates new files).
  get frozenBundle() {
    return this.#bundle === 'frozen'
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
