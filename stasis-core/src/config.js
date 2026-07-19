import assert from 'node:assert/strict'

import { canonicalizePath } from './state-util.js'
import { extSetsEqual, isBrotliQuality, parseBrotliQuality, parseResourcesOption } from './util.js'

const VALID_SCOPE = new Set(['node_modules', 'full'])
const VALID_LOCK = new Set(['none', 'ignore', 'add', 'replace', 'frozen'])
const VALID_BUNDLE = new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen'])
const VALID_FS = new Set(['sync', 'async'])

// Defaults Config applies when neither env nor options specify a value. Exported so
// callers (plugins.js error messages) share one source of truth -- drift surfaces here,
// not silently in a user-facing message.
export const DEFAULT_LOCK = 'add'
export const DEFAULT_BUNDLE = 'none'
export const DEFAULT_SCOPE = 'full'

// Strict boolean env parsing: ''/'0'/'false' -> false, '1'/'true' -> true. Anything else
// throws -- a truthiness parse would read 'no'/'off' as *enabling* the toggle; a
// misconfigured env var should fail loudly, not silently flip a feature on.
const envBool = (name, value) => {
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new RangeError(`${name} must be ''/'0'/'false' or '1'/'true' (got '${value}')`)
}

// EXODUS_STASIS_RESOURCES is a comma-separated extension list; split + trim + drop
// empties so '' and ' png , svg ' normalize predictably (parseResourcesOption validates
// each entry). Empty/unset means "no allowlist".
const envList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

const OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'resourcesBundleFile', 'debug', 'resources', 'childProcess']

// Plugins accept the same options as Config but validate without constructing one
// (constructing State has side effects). Mirrors Config's per-field validation.
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
  // parseResourcesOption is the validator: throws on a non-array, non-string entries,
  // malformed extensions, or a code extension (always tracked, never resources).
  if (resources !== undefined) parseResourcesOption(label, resources)
}

// When a plugin runs against a State that already exists (preload path), the active Config
// is authoritative. Any options the plugin was given must agree with it.
export function assertOptionsMatchConfig(config, options) {
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, childProcess } = options
  // `resources` is intentionally NOT cross-checked here: it's a Set (needs set-equality,
  // which assert.equal can't express) and is coordinated in resolvePluginState before this
  // runs -- don't "fix" the omission with assert.equal(config.resources, ...).
  try {
    if (scope !== undefined) assert.equal(config.scope, scope)
    if (lock !== undefined) assert.equal(config.lock, lock)
    if (bundle !== undefined) assert.equal(config.bundleMode, bundle)
    if (bundleFile !== undefined) assert.equal(config.bundleFile, bundleFile)
    if (resourcesBundleFile !== undefined) assert.equal(config.resourcesBundleFile, resourcesBundleFile)
    if (debug !== undefined) assert.equal(config.debug, debug)
    if (childProcess !== undefined) assert.equal(config.childProcess, childProcess)
  } catch (cause) {
    // Fold the underlying assertion message into the top-level text so a plugin author
    // sees the offending field and expected/actual values without inspecting err.cause.
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
  #shardSignalFlush
  #fs
  #brotliQuality

  // Options match the CLI flags (scope/lock/lockFile/bundle/bundleFile/resourcesBundleFile/debug/
  // resources/childProcess/fs/brotliQuality).
  // Env vars apply at construction; if both env and an option are set they must agree.
  // Explicit constructor options are likewise authoritative: a later `loadConfig`
  // (stasis.config.json) must agree with them rather than silently overwriting
  // `--scope=full` with the file's `"scope":"node_modules"` -- a footgun the CLI couldn't
  // detect, since the flag was accepted and then quietly ignored.
  constructor(options = {}) {
    const { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, fs, brotliQuality, ...rest } = options
    assert.equal(Object.keys(rest).length, 0, `Unknown Config options: ${Object.keys(rest).join(', ')}`)
    this.#explicit = { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, fs, brotliQuality }

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
      shardSignalFlush: process.env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH || undefined,
      fs: process.env.EXODUS_STASIS_FS || undefined,
      brotliQuality: process.env.EXODUS_STASIS_BROTLI_QUALITY || undefined,
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
        assert.equal(envBool('EXODUS_STASIS_DEBUG', this.#env.debug), debug)
      }
      if (this.#env.childProcess !== undefined && childProcess !== undefined) {
        assert.equal(envBool('EXODUS_STASIS_CHILD_PROCESS', this.#env.childProcess), childProcess)
      }
      if (this.#env.fs !== undefined && fs !== undefined) assert.equal(this.#env.fs, fs)
      if (this.#env.brotliQuality !== undefined && brotliQuality !== undefined) {
        assert.equal(parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality), brotliQuality)
      }
      // Compare parsed sets, not raw strings: ['png','svg'] and 'svg,png' are the same
      // allowlist. Empty/unset env is "no env opinion" (via `|| undefined` above), so this
      // only fires on two genuinely different non-empty lists.
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
    this.#debug = this.#env.debug !== undefined ? envBool('EXODUS_STASIS_DEBUG', this.#env.debug) : (debug ?? false)
    this.#childProcess = this.#env.childProcess !== undefined ? envBool('EXODUS_STASIS_CHILD_PROCESS', this.#env.childProcess) : (childProcess ?? false)
    // Env-only (no option, no stasis.config.json key): shard-channel plumbing a parent
    // sets for its descendants, not a user-facing knob -- see the getter.
    this.#shardSignalFlush = this.#env.shardSignalFlush !== undefined
      ? envBool('EXODUS_STASIS_SHARD_SIGNAL_FLUSH', this.#env.shardSignalFlush)
      : false
    // env wins over the option, like scope/lock/bundle; undefined means "fs untouched" (off).
    this.#fs = this.#env.fs || fs || undefined
    // env wins over the option; no `||` chaining -- 0 is a valid quality and falsy.
    this.#brotliQuality = this.#env.brotliQuality !== undefined
      ? parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality)
      : brotliQuality
    // env wins over the option (process-wide signal); parseResourcesOption normalizes both
    // to a Set of lowercase extensions/filenames, or empty when neither is set.
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
    // A write-side knob; like bundleFile, inert-but-harmless under read-only modes
    // (the same stasis.config.json serves capture and load runs).
    if (this.#brotliQuality !== undefined && !isBrotliQuality(this.#brotliQuality)) {
      throw new RangeError(`brotliQuality must be an integer 0..11 (got ${JSON.stringify(this.#brotliQuality)})`)
    }
    if (this.#fs !== undefined) {
      assert.ok(VALID_FS.has(this.#fs), `Invalid fs: ${this.#fs}`)
      // --fs patches the fs readers to capture into the bundle (add/replace) or serve from
      // it (load); other bundle modes have nothing to record into or read from. Mirrors the
      // CLI's "--fs requires --bundle=(add|replace|load)" guard.
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
    // resourcesBundleFile) must each name a distinct on-disk file. Canonicalize (resolve() +
    // realpathSync) so './x.br' vs 'x.br' and two symlinks to one inode compare equal -- a
    // raw string compare would let the second writer silently clobber the first.
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

    // bundle=load needs a trust root for source bytes: frozen pins each file's sha512 in the
    // lockfile and we cross-check on load; otherwise the bundle is itself authoritative
    // (lock=none with no lockfile, or lock=ignore bypassing one).
    // WARNING: the lockfile attests source bytes, entries, module identity, and (when
    // recorded) resolutions and loader formats. Older lockfiles cover only what they
    // recorded (bytes at minimum).
    if (this.#bundle === 'load' && this.#lock !== 'frozen' && this.#lock !== 'none' && this.#lock !== 'ignore') {
      throw new RangeError('bundle=load is incompatible with lock=(add|replace)')
    }

    // bundle=frozen places no constraint on lock: unlike load it never *serves* the bundle's
    // bytes -- it reads each file from disk and verifies against the bundle's recorded
    // bytes/resolutions/formats, so the bundle is itself the trust root ("operates as a
    // lockfile"). It composes with any lock mode and, being a real bundle, satisfies the
    // "needs a lockfile or a bundle" rule below (which only rejects leaving both unset).
    if (this.#lock === 'none' && this.#bundle === 'none') {
      throw new RangeError('stasis needs a lockfile or a bundle: set lock or bundle')
    }
  }

  loadConfig(json) {
    const {
      scope = this.#scope,
      lock = this.#lock,
      bundle = this.#bundle,
      bundleFile = this.#bundleFile,
      resourcesBundleFile = this.#resourcesBundleFile,
      debug = this.#debug,
      childProcess = this.#childProcess,
      fs = this.#fs,
      brotliQuality = this.#brotliQuality,
      resources,
      ...rest
    } = JSON.parse(json)
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#lock = lock
    this.#bundle = bundle
    // Coerce '' -> undefined to match the constructor: an empty-string path is "unset"
    // downstream (State consumes bundleFile truthily), but #checkInvariants would otherwise
    // resolve('') -> cwd and claim it as a write target.
    this.#bundleFile = bundleFile || undefined
    this.#resourcesBundleFile = resourcesBundleFile || undefined
    this.#debug = debug
    this.#childProcess = childProcess
    this.#fs = fs
    this.#brotliQuality = brotliQuality
    if (resources !== undefined) this.#resources = parseResourcesOption('stasis.config.json', resources)
    this.#checkInvariants()

    try {
      if (this.#env.scope !== undefined) assert.equal(this.#scope, this.#env.scope)
      if (this.#env.lock !== undefined) assert.equal(this.#lock, this.#env.lock)
      if (this.#env.bundle !== undefined) assert.equal(this.#bundle, this.#env.bundle)
      if (this.#env.bundleFile !== undefined) assert.equal(this.#bundleFile, this.#env.bundleFile)
      if (this.#env.resourcesBundleFile !== undefined) assert.equal(this.#resourcesBundleFile, this.#env.resourcesBundleFile)
      if (this.#env.debug !== undefined) assert.equal(this.#debug, envBool('EXODUS_STASIS_DEBUG', this.#env.debug))
      if (this.#env.childProcess !== undefined) assert.equal(this.#childProcess, envBool('EXODUS_STASIS_CHILD_PROCESS', this.#env.childProcess))
      if (this.#env.fs !== undefined) assert.equal(this.#fs, this.#env.fs)
      if (this.#env.brotliQuality !== undefined) {
        assert.equal(this.#brotliQuality, parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality))
      }
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
      if (this.#explicit.bundleFile !== undefined) assert.equal(this.#bundleFile, this.#explicit.bundleFile)
      if (this.#explicit.resourcesBundleFile !== undefined) assert.equal(this.#resourcesBundleFile, this.#explicit.resourcesBundleFile)
      if (this.#explicit.debug !== undefined) assert.equal(this.#debug, this.#explicit.debug)
      if (this.#explicit.childProcess !== undefined) assert.equal(this.#childProcess, this.#explicit.childProcess)
      if (this.#explicit.fs !== undefined) assert.equal(this.#fs, this.#explicit.fs)
      if (this.#explicit.brotliQuality !== undefined) assert.equal(this.#brotliQuality, this.#explicit.brotliQuality)
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

  // When set, State reads/writes the lockfile at this exact path instead of discovering
  // `stasis.lock.json` at the project root. Set via the CLI, `EXODUS_STASIS_LOCK_FILE`, or
  // direct State construction; bundler plugins can't set it (they share the ambient
  // lockfile). Unset -> default discovery.
  get lockFile() {
    return this.#lockFile
  }

  // When set, State.write() emits resources to this file and code-only to bundleFile;
  // bundle=load reads both. Unset is the default unified-bundle behavior.
  get resourcesBundleFile() {
    return this.#resourcesBundleFile
  }

  // The parsed `resources` allowlist: a Set of lowercase extensions or extensionless
  // filenames classifyExtension treats as asset payloads. Drives both the plugins'
  // per-import classification and State's `--fs` capture (one shared list). Empty Set when
  // no allowlist was configured.
  get resources() {
    return this.#resources
  }

  get debug() {
    return this.#debug
  }

  // Opt-in (CLI --child-process / EXODUS_STASIS_CHILD_PROCESS / "childProcess": true):
  // enable cross-process capture forwarding. A forked child (e.g. a Metro transform worker)
  // writes a shard of what it captured into a root-owned dir that the root merges before
  // writing -- so files only a child loads (a worker's babel toolchain) get attested. Off by
  // default so the shard-dir coordination channel is only created when enabled. Not attested
  // (not in `values`), like debug.
  get childProcess() {
    return this.#childProcess
  }

  // Opt-in (EXODUS_STASIS_SHARD_SIGNAL_FLUSH, env-only): a capturing CHILD flushes its shard
  // on SIGTERM, then re-delivers the signal (hooks.js). Set on process.env by StasisMetro's
  // capture wiring, so every capturing child forked after config time inherits it -- the
  // audience is Metro's transform workers, which jest-worker force-kills if their event loop
  // doesn't drain within 500ms of the END message, silently dropping the shard. Deliberately
  // NOT a global default (a signal listener changes a child's default-kill disposition, the
  // user's domain) and NOT a user option: channel plumbing like EXODUS_STASIS_SHARD_DIR/_KEY,
  // but parsed strictly through envBool so '0'/'false' disable. Not attested, like childProcess.
  get shardSignalFlush() {
    return this.#shardSignalFlush
  }

  // The --fs hook mode: 'sync' patches the sync fs readers, 'async' additionally patches
  // their async (callback + fs.promises) counterparts, undefined leaves fs untouched. Set via
  // --fs / EXODUS_STASIS_FS / "fs"; the runtime loader (hooks.js) reads it on State init to
  // decide whether and how to install the fs hooks. Not serialized -- a how-to-run flag like
  // debug/childProcess, not an attested property of the bundle.
  get fs() {
    return this.#fs
  }

  // Brotli quality (integer 0..11) for bundle writes; undefined -> stasis's default
  // (DEFAULT_BROTLI_QUALITY = 9, applied by brotliOptions). State.write() forwards this to
  // brotliOptions(). Not serialized -- a how-to-write flag like debug/fs; decompressed
  // content is identical at any quality.
  get brotliQuality() {
    return this.#brotliQuality
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

  // bundle=frozen: the bundle is a read-only attestation, like a frozen lockfile. It is
  // loaded (its bytes/resolutions/entries/modules become the attested set) but never
  // rewritten, and every file/resolution from disk is checked against it. Distinct from load
  // (serves bytes from the bundle instead of reading disk) and add (loads-then-rewrites,
  // tolerates new files).
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
