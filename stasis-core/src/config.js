import assert from 'node:assert/strict'

import { canonicalizePath } from './state-util.js'
import { extSetsEqual, isBrotliQuality, parseBrotliQuality, parseResourcesOption } from './util.js'

const VALID_SCOPE = new Set(['node_modules', 'full'])
const VALID_LOCK = new Set(['none', 'ignore', 'add', 'replace', 'frozen'])
const VALID_BUNDLE = new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen'])
const VALID_FS = new Set(['sync', 'async'])

// Defaults Config applies when neither env nor options specify a value. Exported so callers share
// one source of truth.
export const DEFAULT_LOCK = 'add'
export const DEFAULT_BUNDLE = 'none'
export const DEFAULT_SCOPE = 'full'

// Strict boolean env parsing: ''/'0'/'false' -> false, '1'/'true' -> true, anything else throws.
// A truthiness parse would read 'no'/'off' as *enabling* the toggle.
const envBool = (name, value) => {
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new RangeError(`${name} must be ''/'0'/'false' or '1'/'true' (got '${value}')`)
}

// EXODUS_STASIS_RESOURCES is a comma-separated extension list; split + trim + drop empties so ''
// and ' png , svg ' normalize predictably. Empty/unset means "no allowlist".
const envList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

const OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'resourcesBundleFile', 'debug', 'resources', 'childProcess', 'packageJSON']

// Plugins validate the same options without constructing a Config (which has side effects).
export function validatePluginOptions(label, options) {
  const rest = { ...options }
  for (const key of OPTION_KEYS) delete rest[key]
  assert.equal(Object.keys(rest).length, 0, `Unknown ${label} options: ${Object.keys(rest).join(', ')}`)
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, packageJSON } = options
  if (scope !== undefined) assert.ok(VALID_SCOPE.has(scope), `Invalid scope: ${scope}`)
  if (lock !== undefined) assert.ok(VALID_LOCK.has(lock), `Invalid lock: ${lock}`)
  if (bundle !== undefined) assert.ok(VALID_BUNDLE.has(bundle), `Invalid bundle: ${bundle}`)
  if (bundleFile !== undefined) assert.equal(typeof bundleFile, 'string', 'bundleFile must be a string')
  if (resourcesBundleFile !== undefined) assert.equal(typeof resourcesBundleFile, 'string', 'resourcesBundleFile must be a string')
  if (debug !== undefined) assert.equal(typeof debug, 'boolean', 'debug must be a boolean')
  if (childProcess !== undefined) assert.equal(typeof childProcess, 'boolean', 'childProcess must be a boolean')
  if (packageJSON !== undefined) assert.equal(typeof packageJSON, 'boolean', 'packageJSON must be a boolean')
  if (resources !== undefined) parseResourcesOption(label, resources)
}

// When a plugin runs against an existing State (preload path), the active Config is authoritative;
// any options the plugin was given must agree with it.
export function assertOptionsMatchConfig(config, options) {
  const { scope, lock, bundle, bundleFile, resourcesBundleFile, debug, childProcess, packageJSON } = options
  // `resources` is intentionally NOT cross-checked here: it's a Set (coordinated in
  // resolvePluginState) -- don't "fix" the omission with assert.equal(config.resources, ...).
  try {
    if (scope !== undefined) assert.equal(config.scope, scope)
    if (lock !== undefined) assert.equal(config.lock, lock)
    if (bundle !== undefined) assert.equal(config.bundleMode, bundle)
    if (bundleFile !== undefined) assert.equal(config.bundleFile, bundleFile)
    if (resourcesBundleFile !== undefined) assert.equal(config.resourcesBundleFile, resourcesBundleFile)
    if (debug !== undefined) assert.equal(config.debug, debug)
    if (childProcess !== undefined) assert.equal(config.childProcess, childProcess)
    if (packageJSON !== undefined) assert.equal(config.packageJSON, packageJSON)
  } catch (cause) {
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
  #packageJSON
  #shardSignalFlush
  #fs
  #brotliQuality

  // Env vars apply at construction; if both env and an option are set they must agree. Explicit
  // constructor options are likewise authoritative: a later `loadConfig` must agree with them
  // rather than silently overwriting (e.g. `--scope=full` vs the file's `"scope":"node_modules"`).
  constructor(options = {}) {
    const { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, packageJSON, fs, brotliQuality, ...rest } = options
    assert.equal(Object.keys(rest).length, 0, `Unknown Config options: ${Object.keys(rest).join(', ')}`)
    this.#explicit = { scope, lock, lockFile, bundle, bundleFile, resourcesBundleFile, debug, resources, childProcess, packageJSON, fs, brotliQuality }

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
      packageJSON: process.env.EXODUS_STASIS_PACKAGE_JSON || undefined,
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
      if (this.#env.packageJSON !== undefined && packageJSON !== undefined) {
        assert.equal(envBool('EXODUS_STASIS_PACKAGE_JSON', this.#env.packageJSON), packageJSON)
      }
      if (this.#env.fs !== undefined && fs !== undefined) assert.equal(this.#env.fs, fs)
      if (this.#env.brotliQuality !== undefined && brotliQuality !== undefined) {
        assert.equal(parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality), brotliQuality)
      }
      // Compare parsed sets, not raw strings: ['png','svg'] and 'svg,png' are the same allowlist.
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
    // Auto-include each bundled module's package.json (a build-time inclusion flag, like debug):
    // env wins over the option, default false. Not attested -- its EFFECT (the package.json files)
    // is what lands in the artifact, so the flag itself needn't be serialized.
    this.#packageJSON = this.#env.packageJSON !== undefined ? envBool('EXODUS_STASIS_PACKAGE_JSON', this.#env.packageJSON) : (packageJSON ?? false)
    // Env-only: shard-channel plumbing a parent sets for its descendants, not a user-facing knob.
    this.#shardSignalFlush = this.#env.shardSignalFlush !== undefined
      ? envBool('EXODUS_STASIS_SHARD_SIGNAL_FLUSH', this.#env.shardSignalFlush)
      : false
    // env wins over the option; undefined means "fs untouched".
    this.#fs = this.#env.fs || fs || undefined
    // env wins over the option; no `||` chaining -- 0 is a valid quality and falsy.
    this.#brotliQuality = this.#env.brotliQuality !== undefined
      ? parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality)
      : brotliQuality
    // env wins over the option; parseResourcesOption normalizes both to a Set (empty if neither set).
    this.#resources = parseResourcesOption(
      'resources',
      this.#env.resources !== undefined ? envList(this.#env.resources) : resources
    )

    this.#checkInvariants()
  }

  // Per-field validation + cross-field invariants; both the constructor and loadConfig call this.
  #checkInvariants() {
    assert.ok(VALID_SCOPE.has(this.#scope), `Invalid scope: ${this.#scope}`)
    assert.ok(VALID_LOCK.has(this.#lock), `Invalid lock: ${this.#lock}`)
    assert.ok(VALID_BUNDLE.has(this.#bundle), `Invalid bundle: ${this.#bundle}`)
    assert.equal(typeof this.#debug, 'boolean', 'debug must be a boolean')
    assert.equal(typeof this.#childProcess, 'boolean', 'childProcess must be a boolean')
    assert.equal(typeof this.#packageJSON, 'boolean', 'packageJSON must be a boolean')
    if (this.#brotliQuality !== undefined && !isBrotliQuality(this.#brotliQuality)) {
      throw new RangeError(`brotliQuality must be an integer 0..11 (got ${JSON.stringify(this.#brotliQuality)})`)
    }
    if (this.#fs !== undefined) {
      assert.ok(VALID_FS.has(this.#fs), `Invalid fs: ${this.#fs}`)
      // --fs patches the fs readers to capture into the bundle (add/replace) or serve from it
      // (load); other bundle modes have nothing to record into or read from.
      if (this.#bundle !== 'add' && this.#bundle !== 'replace' && this.#bundle !== 'load') {
        throw new RangeError(`fs requires bundle=(add|replace|load) (got bundle='${this.#bundle}')`)
      }
    }
    if (this.#bundleFile !== undefined) assert.equal(typeof this.#bundleFile, 'string', 'bundleFile must be a string')
    if (this.#lockFile !== undefined) {
      assert.equal(typeof this.#lockFile, 'string', 'lockFile must be a string')
      // lockFile is only meaningful with an active lock mode; none/ignore would silently ignore it.
      if (this.#lock === 'none' || this.#lock === 'ignore') {
        throw new RangeError(`lockFile requires an active lock mode (got lock='${this.#lock}')`)
      }
    }
    if (this.#resourcesBundleFile !== undefined) {
      assert.equal(typeof this.#resourcesBundleFile, 'string', 'resourcesBundleFile must be a string')
      // The split is only meaningful with an active bundle; none/ignore would leave it silently inert.
      if (this.#bundle === 'none' || this.#bundle === 'ignore') {
        throw new RangeError(`resourcesBundleFile requires an active bundle mode (got bundle='${this.#bundle}')`)
      }
    }

    // The three write targets (lockFile, bundleFile, resourcesBundleFile) must each name a distinct
    // file. Canonicalize (resolve() + realpathSync) so './x.br' vs 'x.br' and two symlinks to one
    // inode compare equal -- a raw string compare would let the second writer silently clobber the first.
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

    // bundle=load needs a trust root for source bytes: frozen pins each file's sha512 and we
    // cross-check on load; otherwise the bundle is itself authoritative (lock=none/ignore).
    if (this.#bundle === 'load' && this.#lock !== 'frozen' && this.#lock !== 'none' && this.#lock !== 'ignore') {
      throw new RangeError('bundle=load is incompatible with lock=(add|replace)')
    }

    // bundle=frozen places no constraint on lock: it reads each file from disk and verifies against
    // the bundle's recorded bytes/resolutions/formats, so the bundle is itself the trust root. It
    // composes with any lock mode and satisfies the "needs a lockfile or a bundle" rule below.
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
      packageJSON = this.#packageJSON,
      fs = this.#fs,
      brotliQuality = this.#brotliQuality,
      resources,
      ...rest
    } = JSON.parse(json)
    assert.equal(Object.keys(rest).length, 0)
    this.#scope = scope
    this.#lock = lock
    this.#bundle = bundle
    // Coerce '' -> undefined to match the constructor: otherwise #checkInvariants would
    // resolve('') -> cwd and claim it as a write target.
    this.#bundleFile = bundleFile || undefined
    this.#resourcesBundleFile = resourcesBundleFile || undefined
    this.#debug = debug
    this.#childProcess = childProcess
    this.#packageJSON = packageJSON
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
      if (this.#env.packageJSON !== undefined) assert.equal(this.#packageJSON, envBool('EXODUS_STASIS_PACKAGE_JSON', this.#env.packageJSON))
      if (this.#env.fs !== undefined) assert.equal(this.#fs, this.#env.fs)
      if (this.#env.brotliQuality !== undefined) {
        assert.equal(this.#brotliQuality, parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', this.#env.brotliQuality))
      }
      if (this.#env.resources !== undefined) {
        assert.ok(extSetsEqual(this.#resources, parseResourcesOption('env', envList(this.#env.resources))),
          'resources in stasis.config.json must match EXODUS_STASIS_RESOURCES')
      }
      // Explicit constructor options are equally authoritative: an explicit `--scope=full` shouldn't
      // be silently overridden by an on-disk `{"scope":"node_modules"}`.
      if (this.#explicit.scope !== undefined) assert.equal(this.#scope, this.#explicit.scope)
      if (this.#explicit.lock !== undefined) assert.equal(this.#lock, this.#explicit.lock)
      if (this.#explicit.bundle !== undefined) assert.equal(this.#bundle, this.#explicit.bundle)
      if (this.#explicit.bundleFile !== undefined) assert.equal(this.#bundleFile, this.#explicit.bundleFile)
      if (this.#explicit.resourcesBundleFile !== undefined) assert.equal(this.#resourcesBundleFile, this.#explicit.resourcesBundleFile)
      if (this.#explicit.debug !== undefined) assert.equal(this.#debug, this.#explicit.debug)
      if (this.#explicit.childProcess !== undefined) assert.equal(this.#childProcess, this.#explicit.childProcess)
      if (this.#explicit.packageJSON !== undefined) assert.equal(this.#packageJSON, this.#explicit.packageJSON)
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
  // `stasis.lock.json` at the project root; bundler plugins can't set it. Unset -> default discovery.
  get lockFile() {
    return this.#lockFile
  }

  // When set, State.write() emits resources to this file and code-only to bundleFile;
  // bundle=load reads both. Unset is the default unified-bundle behavior.
  get resourcesBundleFile() {
    return this.#resourcesBundleFile
  }

  // The parsed `resources` allowlist: a Set of lowercase extensions/filenames classifyExtension
  // treats as asset payloads. Drives both plugin classification and State's `--fs` capture.
  get resources() {
    return this.#resources
  }

  get debug() {
    return this.#debug
  }

  // Opt-in: enable cross-process capture forwarding. A forked child (e.g. a Metro transform worker)
  // writes a shard of what it captured into a root-owned dir the root merges before writing, so
  // files only a child loads get attested. Off by default. Not attested (not in `values`), like debug.
  get childProcess() {
    return this.#childProcess
  }

  // Opt-in: when bundling, auto-include every bundled module's package.json (even if the run/scan
  // never reached it). A build-time inclusion flag; its effect is the extra bundled files, so like
  // debug it is not attested (not in `values`).
  get packageJSON() {
    return this.#packageJSON
  }

  // Env-only: a capturing CHILD flushes its shard on SIGTERM, then re-delivers the signal. The
  // audience is Metro's transform workers, which jest-worker force-kills ~500ms after the END
  // message, otherwise silently dropping the shard. Not a user option, not attested.
  get shardSignalFlush() {
    return this.#shardSignalFlush
  }

  // The --fs hook mode: 'sync' patches the sync fs readers, 'async' additionally patches their
  // async counterparts, undefined leaves fs untouched. Not serialized -- a how-to-run flag.
  get fs() {
    return this.#fs
  }

  // Brotli quality (0..11) for bundle writes; undefined -> stasis's default (DEFAULT_BROTLI_QUALITY).
  // Not serialized -- a how-to-write flag; decompressed content is identical at any quality.
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

  // bundle=frozen: the bundle is a read-only attestation. It is loaded but never rewritten, and
  // every file/resolution from disk is checked against it. Distinct from load (serves bytes) and
  // add (loads-then-rewrites, tolerates new files).
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
    // resources persists like scope/lock/bundle, but only when non-empty so configs without an
    // allowlist serialize byte-identically as before.
    if (this.#resources.size > 0) data.resources = [...this.#resources].toSorted()
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
