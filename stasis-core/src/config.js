import assert from 'node:assert/strict'

import { canonicalizePath } from './state-util.js'
import { extSetsEqual, parseResourcesOption } from './util.js'

const VALID_SCOPE = new Set(['node_modules', 'full'])
const VALID_LOCK = new Set(['none', 'ignore', 'add', 'replace', 'frozen'])
const VALID_BUNDLE = new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen'])
const VALID_FS = new Set(['sync', 'async'])

// The defaults Config applies when neither env nor options specify a value.
// Exported so callers (plugins.js error messages) can reference the same source of
// truth instead of hardcoding the literal -- a default drift then surfaces at one
// place, not silently in a user-facing message.
export const DEFAULT_LOCK = 'add'
export const DEFAULT_BUNDLE = 'none'
export const DEFAULT_SCOPE = 'full'

const envBool = (value) => Boolean(value && value !== '0')

// EXODUS_STASIS_RESOURCES is a comma-separated extension list; split + trim + drop
// empties so '' and ' png , svg ' normalize predictably (parseResourcesOption then
// validates each entry). An empty/unset env var means "no allowlist".
const envList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

const OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'resourcesBundleFile', 'debug', 'resources', 'childProcess']

// Plugins accept the same options as Config but want to validate without constructing one,
// since constructing State has side effects. Mirror Config's per-field validation.
export function validatePluginOptions(label, options) {
  const rest = { ...options }
  for (const key of OPTION_KEYS) delete rest[key]
  assert.equal(Object.keys(rest).length, 0, `Unknown ${label} options: ${Object.keys(rest).join(', ')}`)
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess } = options
  if (scope !== undefined) assert.ok(VALID_SCOPE.has(scope), `Invalid scope: ${scope}`)
  if (lock !== undefined) assert.ok(VALID_LOCK.has(lock), `Invalid lock: ${lock}`)
  if (bundle !== undefined) assert.ok(VALID_BUNDLE.has(bundle), `Invalid bundle: ${bundle}`)
  if (bundleFile !== undefined) assert.equal(typeof bundleFile, 'string', 'bundleFile must be a string')
  if (resourcesBundleFile !== undefined) assert.equal(typeof resourcesBundleFile, 'string', 'resourcesBundleFile must be a string')
  if (debug !== undefined) assert.equal(typeof debug, 'boolean', 'debug must be a boolean')
  if (childProcess !== undefined) assert.equal(typeof childProcess, 'boolean', 'childProcess must be a boolean')
  // parseResourcesOption is the validator: it throws on a non-array, non-string entries,
  // malformed extensions, or a code extension (those are always tracked, never resources).
  if (resources !== undefined) parseResourcesOption(label, resources)
}

// When a plugin runs against a State that already exists (preload path), the active Config
// is authoritative. Any options the plugin was given must agree with it.
export function assertOptionsMatchConfig(config, options) {
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, childProcess } = options
  // `resources` is intentionally NOT cross-checked here: it's a Set (needs set-equality,
  // which assert.equal can't express) and is coordinated explicitly in resolvePluginState
  // before this runs -- don't "fix" the omission with assert.equal(config.resources, ...).
  try {
    if (scope !== undefined) assert.equal(config.scope, scope)
    if (lock !== undefined) assert.equal(config.lock, lock)
    if (bundle !== undefined) assert.equal(config.bundleMode, bundle)
    if (bundleFile !== undefined) assert.equal(config.bundleFile, bundleFile)
    if (resourcesBundleFile !== undefined) assert.equal(config.resourcesBundleFile, resourcesBundleFile)
    if (debug !== undefined) assert.equal(config.debug, debug)
    if (childProcess !== undefined) assert.equal(config.childProcess, childProcess)
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
  #lockFile
  #bundle
  #bundleFile
  #resourcesBundleFile
  #resources
  #debug
  #childProcess
  #fs

  // Options match the CLI flags (scope/lock/lockFile/bundle/bundleFile/resourcesBundleFile/debug/
  // resources/childProcess/fs).
  // Env vars take effect at construction time; if both env and an option are set they must
  // agree. Likewise, any explicit constructor option is treated as authoritative: a later
  // `loadConfig` call (which reads stasis.config.json) must agree with it -- the alternative
  // (silently overwriting `--scope=full` with the file's `"scope":"node_modules"`)
  // was a footgun the CLI couldn't detect, since the flag was happily accepted
  // and then quietly ignored.
  constructor(options = {}) {
    const { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, fs, ...rest } = options
    assert.equal(Object.keys(rest).length, 0, `Unknown Config options: ${Object.keys(rest).join(', ')}`)
    this.#explicit = { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, fs }

    this.#env = {
      scope: process.env.EXODUS_STASIS_SCOPE || undefined,
      lock: process.env.EXODUS_STASIS_LOCK || undefined,
      lockFile: process.env.EXODUS_STASIS_LOCK_FILE || undefined,
      bundle: process.env.EXODUS_STASIS_BUNDLE || undefined,
      bundleFile: process.env.EXODUS_STASIS_BUNDLE_FILE || undefined,
      resourcesBundleFile: process.env.EXODUS_STASIS_RESOURCES_BUNDLE_FILE || undefined,
      debug: process.env.EXODUS_STASIS_DEBUG || undefined,
      resources: process.env.EXODUS_STASIS_RESOURCES || undefined,
      childProcess: process.env.EXODUS_STASIS_CHILD_PROCESS || undefined,
      fs: process.env.EXODUS_STASIS_FS || undefined,
    }

    try {
      if (this.#env.scope !== undefined && scope !== undefined) assert.equal(this.#env.scope, scope)
      if (this.#env.lock !== undefined && lock !== undefined) assert.equal(this.#env.lock, lock)
      if (this.#env.lockFile !== undefined && lockFile !== undefined) {
        assert.equal(this.#env.lockFile, lockFile)
      }
      if (this.#env.bundle !== undefined && bundle !== undefined) assert.equal(this.#env.bundle, bundle)
      if (this.#env.bundleFile !== undefined && bundleFile !== undefined) {
        assert.equal(this.#env.bundleFile, bundleFile)
      }
      if (this.#env.resourcesBundleFile !== undefined && resourcesBundleFile !== undefined) {
        assert.equal(this.#env.resourcesBundleFile, resourcesBundleFile)
      }
      if (this.#env.debug !== undefined && debug !== undefined) {
        assert.equal(envBool(this.#env.debug), debug)
      }
      if (this.#env.childProcess !== undefined && childProcess !== undefined) {
        assert.equal(envBool(this.#env.childProcess), childProcess)
      }
      if (this.#env.fs !== undefined && fs !== undefined) assert.equal(this.#env.fs, fs)
      // Compare parsed sets, not the raw strings: ['png','svg'] and 'svg,png' are the
      // same allowlist. An empty/unset env var is "no env opinion" (handled by `||
      // undefined` above), so this only fires on two genuinely different non-empty lists.
      if (this.#env.resources !== undefined && resources !== undefined) {
        assert.ok(
          extSetsEqual(parseResourcesOption('env', envList(this.#env.resources)), parseResourcesOption('options', resources)),
          'resources option does not match EXODUS_STASIS_RESOURCES'
        )
      }
    } catch (cause) {
      throw new Error('Config options can not override stasis env', { cause })
    }

    this.#scope = this.#env.scope || scope || DEFAULT_SCOPE
    this.#lock = this.#env.lock || lock || DEFAULT_LOCK
    this.#lockFile = this.#env.lockFile || lockFile || undefined
    this.#bundle = this.#env.bundle || bundle || DEFAULT_BUNDLE
    this.#bundleFile = this.#env.bundleFile || bundleFile || undefined
    this.#resourcesBundleFile = this.#env.resourcesBundleFile || resourcesBundleFile || undefined
    this.#debug = this.#env.debug !== undefined ? envBool(this.#env.debug) : (debug ?? false)
    this.#childProcess = this.#env.childProcess !== undefined ? envBool(this.#env.childProcess) : (childProcess ?? false)
    // env wins over the option, like scope/lock/bundle; undefined means "fs untouched" (off).
    this.#fs = this.#env.fs || fs || undefined
    // env wins over the option (it's the process-wide signal); parseResourcesOption
    // normalizes both to a Set of lowercase extensions/filenames, or empty when neither set.
    this.#resources = parseResourcesOption(
      'resources',
      this.#env.resources !== undefined ? envList(this.#env.resources) : resources
    )

    this.#checkInvariants()
  }

  // Per-field validation + cross-field invariants. Constructor (options path) and
  // loadConfig (disk path) both call this so the rules live in one place.
  #checkInvariants() {
    assert.ok(VALID_SCOPE.has(this.#scope), `Invalid scope: ${this.#scope}`)
    assert.ok(VALID_LOCK.has(this.#lock), `Invalid lock: ${this.#lock}`)
    assert.ok(VALID_BUNDLE.has(this.#bundle), `Invalid bundle: ${this.#bundle}`)
    assert.equal(typeof this.#debug, 'boolean', 'debug must be a boolean')
    assert.equal(typeof this.#childProcess, 'boolean', 'childProcess must be a boolean')
    if (this.#fs !== undefined) {
      assert.ok(VALID_FS.has(this.#fs), `Invalid fs: ${this.#fs}`)
      // --fs patches the fs readers to capture into the bundle (add/replace) or serve them
      // from it (load); with any other bundle mode it has nothing to record into or read from.
      // Mirrors the CLI's "--fs requires --bundle=(add|replace|load)" guard.
      if (this.#bundle !== 'add' && this.#bundle !== 'replace' && this.#bundle !== 'load') {
        throw new RangeError(`fs requires bundle=(add|replace|load) (got bundle='${this.#bundle}')`)
      }
    }
    if (this.#bundleFile !== undefined) assert.equal(typeof this.#bundleFile, 'string', 'bundleFile must be a string')
    if (this.#lockFile !== undefined) {
      assert.equal(typeof this.#lockFile, 'string', 'lockFile must be a string')
      // lockFile is only meaningful when there IS a lockfile. Lock modes that opt out
      // (none / ignore) would silently ignore the path -- catch the misconfig explicitly.
      if (this.#lock === 'none' || this.#lock === 'ignore') {
        throw new RangeError(`lockFile requires an active lock mode (got lock='${this.#lock}')`)
      }
    }
    if (this.#resourcesBundleFile !== undefined) {
      assert.equal(typeof this.#resourcesBundleFile, 'string', 'resourcesBundleFile must be a string')
      // The split is only meaningful when there IS a bundle to split. With bundle=none / ignore the
      // option would be silently inert -- catch the misconfiguration explicitly instead.
      if (this.#bundle === 'none' || this.#bundle === 'ignore') {
        throw new RangeError(`resourcesBundleFile requires an active bundle mode (got bundle='${this.#bundle}')`)
      }
    }

    // Cross-path collision checks: the three write targets (lockFile, bundleFile,
    // resourcesBundleFile) must each name a distinct on-disk file. Canonicalize via
    // resolve() + realpathSync so './x.br' vs 'x.br', and two symlinks to the same
    // inode, both compare equal -- a raw string compare would let `./out/x.br` and
    // `out/x.br` slip past and the second writer would silently clobber the first.
    const claimed = new Map()
    for (const [label, value] of [
      ['lockFile', this.#lockFile],
      ['bundleFile', this.#bundleFile],
      ['resourcesBundleFile', this.#resourcesBundleFile],
    ]) {
      if (value === undefined) continue
      const canonical = canonicalizePath(value)
      if (claimed.has(canonical)) {
        throw new RangeError(`${label} '${value}' targets the same file as ${claimed.get(canonical)}; each must be a distinct path`)
      }
      claimed.set(canonical, label)
    }

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
      childProcess = this.#childProcess,
      fs = this.#fs,
      resources,
      ...rest
    } = JSON.parse(json)
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#lock = lock
    this.#bundle = bundle
    this.#debug = debug
    this.#childProcess = childProcess
    this.#fs = fs
    if (resources !== undefined) this.#resources = parseResourcesOption('stasis.config.json', resources)
    this.#checkInvariants()

    try {
      if (this.#env.scope !== undefined) assert.equal(this.#scope, this.#env.scope)
      if (this.#env.lock !== undefined) assert.equal(this.#lock, this.#env.lock)
      if (this.#env.bundle !== undefined) assert.equal(this.#bundle, this.#env.bundle)
      if (this.#env.debug !== undefined) assert.equal(this.#debug, envBool(this.#env.debug))
      if (this.#env.childProcess !== undefined) assert.equal(this.#childProcess, envBool(this.#env.childProcess))
      if (this.#env.fs !== undefined) assert.equal(this.#fs, this.#env.fs)
      if (this.#env.resources !== undefined) {
        assert.ok(extSetsEqual(this.#resources, parseResourcesOption('env', envList(this.#env.resources))),
          'resources in stasis.config.json must match EXODUS_STASIS_RESOURCES')
      }
      // Explicit constructor options are equally authoritative: an explicit
      // `--scope=full` shouldn't be silently overridden by an on-disk
      // `{"scope":"node_modules"}`. The asserts mirror the env block above.
      if (this.#explicit.scope !== undefined) assert.equal(this.#scope, this.#explicit.scope)
      if (this.#explicit.lock !== undefined) assert.equal(this.#lock, this.#explicit.lock)
      if (this.#explicit.bundle !== undefined) assert.equal(this.#bundle, this.#explicit.bundle)
      if (this.#explicit.debug !== undefined) assert.equal(this.#debug, this.#explicit.debug)
      if (this.#explicit.childProcess !== undefined) assert.equal(this.#childProcess, this.#explicit.childProcess)
      if (this.#explicit.fs !== undefined) assert.equal(this.#fs, this.#explicit.fs)
      if (this.#explicit.resources !== undefined) {
        assert.ok(extSetsEqual(this.#resources, parseResourcesOption('options', this.#explicit.resources)),
          'resources in stasis.config.json must match the resources option')
      }
    } catch (cause) {
      throw new Error('Flags/env can not override stasis.config.json', { cause })
    }
  }

  get bundleFile() {
    return this.#bundleFile
  }

  // When set, State reads/writes the lockfile at this exact path instead of
  // discovering `stasis.lock.json` at the project root. Set via the CLI,
  // `EXODUS_STASIS_LOCK_FILE`, or direct State construction; bundler plugins
  // can't set it (they always share the ambient lockfile). Unset -> default
  // discovery applies.
  get lockFile() {
    return this.#lockFile
  }

  // When set, State.write() emits resources to this file and code-only to bundleFile;
  // bundle=load reads both. Unset is the default unified-bundle behavior.
  get resourcesBundleFile() {
    return this.#resourcesBundleFile
  }

  // The parsed `resources` allowlist: a Set of lowercase extensions or extensionless
  // filenames that classifyExtension treats as asset payloads. Drives both the plugins'
  // per-import classification and State's `--fs` capture, so the two share one list.
  // Empty Set when no allowlist was configured (option or EXODUS_STASIS_RESOURCES).
  get resources() {
    return this.#resources
  }

  get debug() {
    return this.#debug
  }

  // Opt-in (CLI --child-process / EXODUS_STASIS_CHILD_PROCESS / "childProcess": true in
  // stasis.config.json): enable cross-process capture forwarding. A forked child (e.g. a
  // Metro transform worker) writes a shard of what it captured into a root-owned dir, and
  // the root merges it before writing -- so files only a child loads (a worker's babel
  // toolchain) are attested. Off by default: the shard dir is a process-coordination channel,
  // so it's only created when explicitly enabled. Not attested (not in `values`), like debug.
  get childProcess() {
    return this.#childProcess
  }

  // The --fs hook mode: 'sync' patches the sync fs readers, 'async' additionally patches
  // their async (callback + fs.promises) counterparts, undefined leaves fs untouched. Set via
  // --fs / EXODUS_STASIS_FS / "fs" in stasis.config.json; the runtime loader (hooks.js) reads
  // this on State init to decide whether (and how) to install the fs hooks. Not serialized --
  // a how-to-run flag like debug/childProcess, not an attested property of the bundle.
  get fs() {
    return this.#fs
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
    // resources persists like scope/lock/bundle (a project-level declaration), but only
    // when non-empty so configs without an allowlist serialize byte-identically as before.
    if (this.#resources.size > 0) data.resources = [...this.#resources].toSorted()
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
