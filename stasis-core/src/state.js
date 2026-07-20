import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { join, resolve, relative, basename, dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Config } from './config.js'
import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { canonicalizePath, sha512integrity, readFileSyncMaybe, noupsert } from './state-util.js'
import { brotliOptions } from './brotli.js'
import { CODE_EXTENSIONS, classifyFormat, fileMapToObject, hasNodeModulesSegment, isStatFormat, moduleFileKey, objectToMaps, pathExt, reconcileFormat, sortPaths, splitNodeModulesPath } from './util.js'
import corePackage from './package.cjs'

// Destructure off the namespace (not `import { ... } from 'node:fs'`): captures the real
// fns at eval time, so writes survive --mock's syncBuiltinESMExports() remock of node:fs.
const { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } = fs

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'

function readPackageJSON(pkgAbsolute) {
  const buf = readFileSync(pkgAbsolute)
  assert.ok(isUtf8(buf))
  return JSON.parse(buf.toString())
}

// This copy's own version, via src/package.cjs (bundler-safe re-export of package.json).
const VERSION = corePackage.version

// Set `format` for `file` via the shared reconcileFormat rule (util.js): a weak 'stat:*'
// yields to a real format; two real formats or a stat kind flip are fatal.
function upsertFormat(map, file, format) {
  const currentFormat = map.get(file)
  map.set(file, currentFormat === undefined ? format : reconcileFormat(format, currentFormat, file))
}

// TODO: stricter format validation

// Process-wide registry of every live State, on globalThis so it's shared across duplicate
// stasis-core copies in one process (the `Symbol.for` key reaches the same Set across copies).
const STATES_KEY = Symbol.for('@exodus/stasis-core/states')
function liveStates() {
  return (globalThis[STATES_KEY] ??= new Set())
}

export class State {
  hashes = new Map()
  entries = new Set()
  sources = new Map()
  resources = new Map()
  formats = new Map()
  modules = new Map()
  imports = new Map()
  config
  root
  #parent

  // True iff this is THE preload (top-level) State.
  #isPreload = false

  // This State's claimed write-target paths (canonicalized -> label), for cross-State collision detection.
  #claims = new Map()

  // For a parent: WRITE-mode sidecar States -- lockfile CONTRIBUTORS. #mergedImports/
  // #mergedFormats union their imports/formats into the unified lockfile (hashes/entries/
  // modules are already shared by reference); also the set attestedBySidecar consults.
  #sidecars = new Set()

  // For a parent: LOAD-mode sidecar States -- read-only family, NOT lockfile contributors.
  // getFs*Family serves bundle bytes from them; kept out of #mergedImports/#mergedFormats so
  // they contribute no resolution edges or formats to the unified lockfile.
  #readSidecars = new Set()

  // Resolutions attested by the loaded lockfile (conditions -> parent -> specifier -> file), or
  // null. Separate from this.imports -- the lockfile may attest a superset of what a run observes.
  #lockImports = null

  // Loader formats attested by the loaded lockfile (file -> format), or null. Like #lockImports,
  // kept apart from this.formats.
  #lockFormats = null

  // True iff this State (or a sidecar's parent) loaded a lockfile at construction. Drives
  // #mergeBundleMetadata: with a lockfile, bundle metadata is cross-checked against it; without,
  // absorbed as source of truth.
  #lockfileLoaded = false

  // Project-relative keys THIS process recorded via addFile/addFsDir this run (not the seeded
  // baseline). shardSnapshot() forwards only these.
  #observed = new Set()
  // file -> consumers that recorded it, for the bundle's informational `reason` field. See
  // #recordReason / #bundleReason.
  #reasonFiles = new Map()
  // Supporting state for the bundle `reason` map's "run" entry (see #bundleReason).
  #runImported = new Set()
  #fsReadPostPlugin = new Set()
  #pluginAttached = false

  // Files/resolutions/formats attested by a frozen bundle (bundle=frozen), or null. Anchored
  // in the bundle's own bytes (no sibling lockfile needed); close the attested set so a
  // file/resolution/format the bundle never recorded is rejected. Separate from the live maps.
  #bundleSources = null
  #bundleResources = null
  #bundleImports = null
  #bundleFormats = null

  // Lazily-built set of directory paths IMPLIED by recorded files: `node_modules/dep/index.js`
  // proves `node_modules` and `node_modules/dep` are dirs. getFsStat consults it so
  // `statSync('node_modules').isDirectory()` succeeds at bundle=load.
  #impliedDirIndex = null

  // Capture-time native resolutions (parent URL -> specifier -> resolved URL) from the
  // Module._resolveFilename shim: require.resolve()/CJS require()s bypassing the resolve hook.
  #observedResolutions = new Map()

  // Node's require-condition set, captured the first time addImport sees a require()-context
  // edge. #backfillObservedResolutions keys native edges under it (not '*') so the lockfile is
  // stable across Node versions. null until observed -- then '*', which the wildcard fallbacks match.
  #requireConditions = null

  // Absolute path of a package whose sources Node loaded BEFORE our hooks (preload-cached);
  // set to stasis-core's own root. write()'s backfill statically parses files under it to
  // recover the internal edges the live resolve hook never observed. Sidecars inherit it.
  #preloadRoot = null

  // Per-artifact "last serialized" caches: write() skips brotli + writeFileSync when an
  // output's fresh text matches the cached one (watch-mode no-op fast path). null on first write().
  #lastLockData = null
  #lastUnifiedBundle = null
  #lastCodeBundle = null
  #lastResourcesBundle = null

  // Options: preload (boolean) -- the unique preload State, only one at a time; parent (State)
  // -- run as a sidecar sharing the parent's hashes/entries/modules but its own sources/formats/
  // imports/resources and bundle. All other keys forward to Config.
  constructor(root, options = {}) {
    // skipDiscovery: caller-populated in-memory State, NO filesystem discovery (for `stasis build`).
    // Read-only (load/ignore) modes only.
    const { preload: isPreload = false, parent: parentState, preloadRoot, skipDiscovery = false, ...configOptions } = options
    this.config = new Config(configOptions)
    if (isPreload) assert.ok(!State.preload, 'Only one preload Stasis instance is supported')
    assert.ok(!(isPreload && parentState), 'preload and parent are mutually exclusive')
    this.#isPreload = isPreload

    if (parentState) {
      // A sidecar shares the parent's maps by reference and inherits its attestation, so the
      // parent MUST be the exact same stasis-core VERSION (though not the same module copy --
      // it reads only the parent's PUBLIC surface across the class brand). A skew is unsound.
      assert.equal(parentState.version, VERSION,
        `child State version '${VERSION}' must exactly match parent version '${parentState.version}'`)
      // Sidecar mode: short-circuit disk discovery; lockfile data shared with the parent.
      this.#parent = parentState
      this.root = parentState.root
      this.hashes = parentState.hashes
      this.entries = parentState.entries
      this.modules = parentState.modules
      // Inherit via the parent's public sidecarInheritance() (works across copies): preloadRoot
      // for backfill, and the lockfile attestation maps so #mergeBundleMetadata cross-checks the
      // sidecar bundle -- else a tampered sidecar could redirect a resolution/flip a format on
      // hash-valid bytes, which the byte check alone misses.
      const inherited = parentState.sidecarInheritance()
      this.#preloadRoot = inherited.preloadRoot
      this.#lockImports = inherited.lockImports
      this.#lockFormats = inherited.lockFormats
      this.#lockfileLoaded = inherited.lockfileLoaded
      assert.ok(this.config.bundleFile, 'sidecar State requires bundleFile')
      // Claim write targets against the process-wide registry so two write-intent States can't
      // silently target the same file. Only writing States claim; read-only modes may share a
      // path with the writer. Config already rejects intra-State collisions, so this fires cross-State.
      if (this.config.writeBundle) {
        this.#claimWritePath(`sidecar bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
        if (this.config.resourcesBundleFile) {
          this.#claimWritePath(`sidecar resourcesBundleFile '${this.config.resourcesBundleFile}'`,
            this.config.resourcesBundleFile)
        }
      }
      // frozenBundle MUST go through this branch too -- it has its own attestation snapshot to build.
      if (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) {
        const sourcesPath = this.config.bundleFile
        const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
        if (sources && !this.config.replaceBundle) {
          const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
          // v0 bundle has no per-file formats or import map -- serving one via a sidecar widens trust.
          assert.equal(bundle.version, Bundle.VERSION,
            `stasis sidecar requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
            `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point.`)
          assert.equal(bundle.config.scope, this.config.scope)
          // Cross-check the sidecar bundle's metadata against the parent's lockfile (or absorb if
          // none). Shared hashes/entries/modules mean the no-lockfile writes propagate to the parent.
          this.#mergeBundleMetadata(bundle, { lockfileLoaded: this.#lockfileLoaded })
          for (const [file, content] of bundle.sources) {
            if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
            else this.sources.set(file, content)
          }
          this.formats = bundle.formats
          this.imports = bundle.imports
          // Carry `reason` forward like #absorbCodeBundle (this inlined sidecar absorb is its twin), else
          // a plugin writing its own bundleFile drops every other consumer's attribution on a bundle=add re-run.
          this.#seedReasonFromBundle(bundle)
          if (this.config.frozenBundle) {
            // Snapshot the attested set so addFile/addImport reject anything the bundle didn't carry.
            this.#bundleSources = new Set(this.sources.keys())
            this.#bundleResources = new Set(this.resources.keys())
            this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
            this.#bundleFormats = new Map(bundle.formats)
          }
        }

        if (this.config.resourcesBundleFile) {
          const resourcesPath = this.config.resourcesBundleFile
          const resourcesData = readFileSyncMaybe(dirname(resourcesPath), basename(resourcesPath))
          if (resourcesData && !this.config.replaceBundle) {
            this.#absorbResourcesBundle(resourcesData, { lockfileLoaded: this.#lockfileLoaded, resourcesPath })
          }
        }
      }
      // Frozen modes must have loaded their attestation, else the run fails open.
      if (this.config.frozenBundle) {
        assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')
      }
      // Register AFTER every fallible step so a throw leaves no dead reference. Write-mode
      // sidecars are lockfile CONTRIBUTORS -> #sidecars (feeds #mergedImports/#mergedFormats);
      // load-mode are CONSUMERS that must NOT contribute -> read-only #readSidecars; frozen
      // sidecars join neither (--fs neither captures nor serves in frozen-bundle mode).
      if (this.config.writeBundle) parentState.registerSidecar(this)
      else if (this.config.loadBundle) parentState.registerReadSidecar(this)
      liveStates().add(this)
      return
    }

    // skipDiscovery: anchor at root, read nothing, caller fills the maps. Read-only modes only.
    if (skipDiscovery) {
      assert.ok(!this.config.frozen && !this.config.frozenBundle && !this.config.writeBundle && !this.config.writeLockfile,
        'skipDiscovery is read-only: incompatible with frozen and write (add/replace) lock/bundle modes')
      this.root = resolve(root)
      if (preloadRoot !== undefined) {
        assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
        this.#preloadRoot = preloadRoot
      }
      liveStates().add(this)
      return
    }

    // liveStates() registration happens after construction succeeds (below), so a throw leaves no half-built State.
    const potentialRoots = []
    let cursor = root
    while (cursor) {
      if (existsSync(join(cursor, 'package.json'))) {
        potentialRoots.push(cursor)
      } else if (
        existsSync(join(cursor, FILE_CONFIG)) ||
        existsSync(join(cursor, FILE_LOCK)) ||
        existsSync(join(cursor, FILE_CODE))) {
        throw new Error('Unexpected stasis config without package.json')
      }

      if (cursor === process.env.PROJECT_CWD) break // e.g. yarn sets this
      if (existsSync(join(cursor, '.git'))) break // don't go higher than the repo root
      if (existsSync(join(cursor, 'pnpm-workspace.yaml'))) break // pnpm workspace root
      const parent = dirname(cursor)
      if (!parent || parent === cursor) break
      cursor = parent
    }

    // default root is top-level package.json, to opt-in to per-dir create stasis.config.json
    this.root = potentialRoots.at(-1)
    // No package.json up the tree = no root: fail closed here, else relative-path calls below throw cryptically.
    assert.ok(this.root, `stasis: no package.json found at or above ${resolve(root)}; run stasis from within a project`)

    let loaded = false
    let lockfileLoaded = false
    // With `config.lockFile` set, the lockfile is at that explicit path. Suppress the per-rootDir
    // read for root-detection (so a stale project-root lockfile can't shadow it); substitute below.
    const explicitLockPath = this.config.lockFile
    // A construction-time `bundleFile` (flag/env) is rootDir-INDEPENDENT, so it must NOT be a
    // root-detection signal: letting it pick the innermost dir would diverge load's root from the
    // capture root and make every capture-root-relative bundle key unreachable. Root comes from
    // rootDir-DEPENDENT signals; the explicit bundle loads at the committed (else outermost) root.
    // A config-only bundleFile is NOT suppressed (its dir already carries the config signal).
    const explicitBundlePath = this.config.bundleFile
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, FILE_CONFIG, 'utf-8')
      const lockProbe = explicitLockPath ? null : readFileSyncMaybe(rootDir, FILE_LOCK, 'utf-8')
      // Bundle at the construction-time bundleFile, else default <rootDir>/stasis.code.br
      // (re-read below if loadConfig applies a config `bundleFile`).
      let sourcesPath = this.config.bundleFile || join(rootDir, FILE_CODE)
      let sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
      // Root-SELECTION signal: only the DEFAULT <rootDir>/stasis.code.br counts; an explicit
      // bundleFile is suppressed here (see explicitBundlePath) but still loaded via `sources`.
      const bundleProbe = explicitBundlePath ? null : sources
      if (config !== null || lockProbe !== null || bundleProbe !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = rootDir

        if (config) {
          this.config.loadConfig(config)
          // stasis.config.json may set `bundleFile` the probe couldn't see -- re-resolve against
          // the now-authoritative config and re-read so a config-only bundleFile is honored.
          const configuredPath = this.config.bundleFile || join(rootDir, FILE_CODE)
          if (configuredPath !== sourcesPath) {
            sourcesPath = configuredPath
            sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
          }
        }

        // Effective lockfile: explicit `config.lockFile`, else `<rootDir>/stasis.lock.json`.
        const lock = explicitLockPath
          ? readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
          : lockProbe
        const lockPath = explicitLockPath || join(rootDir, FILE_LOCK)

        lockfileLoaded = this.#absorbLockfile(lock, lockPath)
        this.#loadBundleArtifacts(sources, sourcesPath, lockfileLoaded)

        // Innermost matching rootDir is authoritative (per-dir opt-in) -- stop scanning. Without
        // this break an outer root re-detects a rootDir-independent bundleFile and trips `loaded`
        // (crashed bundle=load/frozen in nested-package monorepo layouts).
        break
      }
    }

    // Explicit lockfile but no discovery indicator anywhere: the loop never ran its lockfile
    // branch, so process it here against `this.root` (outermost) so the run still has attestation.
    if (!loaded && explicitLockPath) {
      const lock = readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
      lockfileLoaded = this.#absorbLockfile(lock, explicitLockPath)
    }

    // Explicit (flag/env) bundleFile/resourcesBundleFile suppressed as a root signal above:
    // load here against `this.root` (outermost) so capture-root-relative keys line up.
    // NB: capture and load must agree on where the upward walk stops (PROJECT_CWD/.git/
    // pnpm-workspace.yaml), else they commit different roots and fail "outside the project root".
    if (!loaded && (explicitBundlePath || this.config.resourcesBundleFile)) {
      const sources = explicitBundlePath
        ? readFileSyncMaybe(dirname(explicitBundlePath), basename(explicitBundlePath))
        : null
      this.#loadBundleArtifacts(sources, explicitBundlePath, lockfileLoaded)
    }

    // Frozen modes must have loaded their attestation. Asserting here (post-loop) closes a
    // fail-open: with no stasis files the loop never runs, and a frozen run with nothing to
    // verify against must fail closed.
    if (this.config.frozen) assert.ok(lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
    if (this.config.frozenBundle) assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')

    // Claim this State's write targets against the process-wide registry so no other live State
    // (any copy) silently targets the same file. Read-only modes don't claim; lockFile is claimed
    // only by writing top-level States (sidecars don't write it).
    if (this.config.writeBundle && this.config.bundleFile) {
      this.#claimWritePath(`bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
    }
    if (this.config.writeBundle && this.config.resourcesBundleFile) {
      this.#claimWritePath(`resourcesBundleFile '${this.config.resourcesBundleFile}'`, this.config.resourcesBundleFile)
    }
    if (this.config.writeLockfile && this.config.lockFile) {
      this.#claimWritePath(`lockFile '${this.config.lockFile}'`, this.config.lockFile)
    }

    // preloadRoot is opt-in -- only the runtime loader sets it (stasis-core's own root); plain
    // States leave it null and skip the internal-edges backfill.
    if (preloadRoot !== undefined) {
      assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
      this.#preloadRoot = preloadRoot
    }

    liveStates().add(this)
  }

  // Absorb a lockfile's attestation (module/hash maps, imports/formats).
  // Returns whether it was actually absorbed (the caller's `lockfileLoaded`).
  // Lockfile.parse requires both imports and formats, so an absorbed lockfile always attests them.
  #absorbLockfile(lock, lockPath) {
    if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
      throw new Error(`Unexpected ${lockPath} with config.lock = 'none'`)
    }
    if (!lock || !this.config.useLockfile || this.config.replaceLockfile) return false
    const lockfile = Lockfile.parse(lock)
    if (this.config.frozen) assert.equal(lockfile.config.scope, this.config.scope)

    const includeSources = lockfile.config.scope === 'full' && this.config.full
    for (const [dir, info] of lockfile.modules) {
      if (!hasNodeModulesSegment(dir) && !includeSources) continue
      this.modules.set(dir, info)
    }
    if (includeSources) this.entries = lockfile.entries

    for (const [dir, { files }] of this.modules) {
      for (const [name, hash] of Object.entries(files)) {
        noupsert(this.hashes, join(dir, name), hash)
      }
    }
    this.#lockImports = lockfile.imports
    this.#lockFormats = lockfile.formats
    this.#lockfileLoaded = true
    return true
  }

  // Gate and load the bundle artifacts for a committed root: the unified code[+resource] bundle
  // from `sourcesPath` plus the split `resourcesBundleFile`. `sources` may be null (no bundle,
  // or resources-only). The missing-lockfile guard tests `lockfileLoaded` (~ raw lockfile presence here).
  #loadBundleArtifacts(sources, sourcesPath, lockfileLoaded) {
    if (sources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle && !this.config.frozenBundle) {
      throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
    }
    // A frozen bundle is self-attesting (verifies disk against its own bytes), so it needs no
    // sibling lockfile and is exempt from this guard -- letting bundle=frozen compose with lock=add.
    if (sources && !lockfileLoaded && this.config.useLockfile && !this.config.replaceLockfile && !this.config.frozenBundle) {
      throw new Error('stasis.lock.json missing, can not use sources')
    }
    if (sources && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
      this.#absorbCodeBundle(sources, sourcesPath, lockfileLoaded)
    }
    // Split-bundle layout: resources live in a separate standalone Bundle (empty entries/imports,
    // resource formats only) unioned into the bundleFile state. Shape asserts catch leaked code.
    if (this.config.resourcesBundleFile) {
      const resourcesPath = this.config.resourcesBundleFile
      const resourcesData = readFileSyncMaybe(dirname(resourcesPath), basename(resourcesPath))
      if (resourcesData && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
        this.#absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath })
      }
    }
  }

  // Absorb a unified code+resource bundle's metadata and payloads into this State.
  #absorbCodeBundle(sources, sourcesPath, lockfileLoaded) {
    // Split the flat file view into this.sources (code) and this.resources (by format).
    const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
    // Bundle.parse accepts v0 for offline tooling, but the runtime path refuses it: v0 has no
    // per-file formats or import map, so serving one under `stasis run` widens the trust boundary.
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis (\`stasis bundle\`) or \`stasis run --bundle=replace\` ` +
      `against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // A full-scope bundle carrying code must declare an entry to be RUN: assertEntry short-circuits
    // on an empty set, so serving one here would let any bundled file run as the root. An add-only
    // bundle has no entries by design -- valid to parse (tooling), but refused here. Non-full scope
    // has no entries at all, so it's exempt.
    assert.ok(!this.config.full || bundle.entries.size > 0 || !bundle.hasCode,
      `${sourcesPath}: a full-scope bundle carrying code must declare an entry to run ` +
      `(an add-only attestation has none; run a bundle built by \`stasis bundle\`/\`stasis run\`)`)
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    for (const [file, content] of bundle.sources) {
      if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
      else this.sources.set(file, content)
    }
    this.formats = bundle.formats
    this.imports = bundle.imports
    // Carry the loaded bundle's `reason` attribution forward so bundle=add round-trips it
    // (see #seedReasonFromBundle) rather than dropping every consumer but this run's 'run'.
    this.#seedReasonFromBundle(bundle)
    if (this.config.frozenBundle) {
      // Snapshot the attested sets before addFile/addImport mutate the live maps. imports is
      // deep-cloned (this.imports shares bundle.imports's nested Maps); code/resource sets separate.
      this.#bundleSources = new Set(this.sources.keys())
      this.#bundleResources = new Set(this.resources.keys())
      this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
      this.#bundleFormats = new Map(bundle.formats)
    }
  }

  // Cross-check bundle metadata (entries/modules) against the loaded lockfile, or absorb it as
  // source of truth when none. v0 buckets infer `name` from path but carry no version, so we skip
  // entries we can't cross-check. An aliased dep's inferred name disagrees with the lockfile and
  // (correctly) fails the strict equality below -- v0 can't attest identity, don't silently mismatch.
  #mergeBundleMetadata(bundle, { lockfileLoaded }) {
    if (lockfileLoaded) {
      if (bundle.entries.size > 0) {
        assert.deepStrictEqual(
          [...bundle.entries].toSorted(),
          [...this.entries].toSorted(),
          'bundle/lockfile entries mismatch'
        )
      }
      for (const [dir, info] of bundle.modules) {
        if (!info.name) continue // workspace bucket or fallback: no inferable name
        assert.ok(this.modules.has(dir), `bundle module ${dir} missing in lockfile`)
        const lockModule = this.modules.get(dir)
        assert.equal(info.name, lockModule.name)
        if (info.version) assert.equal(info.version, lockModule.version)
        for (const rel of Object.keys(info.files)) {
          assert.ok(Object.hasOwn(lockModule.files, rel), `bundle file ${dir}/${rel} missing in lockfile`)
        }
      }
      // Every edge the bundle could serve must match the lockfile's attested target: hashes alone
      // don't stop a redirect to a different hash-valid file. Unknown edges fatal (superset OK);
      // null #lockImports (no lockfile loaded) skips.
      if (this.#lockImports !== null) {
        for (const [conditions, byParent] of bundle.imports) {
          for (const [parent, specifiers] of byParent) {
            for (const [specifier, file] of specifiers) {
              this.#assertAttestedResolution(this.#lockImports, conditions, parent, specifier, file, { what: 'bundle', source: 'lockfile' })
            }
          }
        }
      }
      // The loader picks module<->commonjs from this map, so a tampered bundle can change how
      // hash-valid bytes parse without touching a hash. Every bundle format must match the
      // lockfile's; an unattested format is fatal (a forged entry).
      if (this.#lockFormats !== null) {
        for (const [file, format] of bundle.formats) {
          this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'bundle', source: 'lockfile' })
        }
        // Inverse: a file the lockfile tags as a resource, the bundle MUST also tag -- else a
        // tampered bundle omitting the tag routes the base64 payload through this.sources (code)
        // to the loader. Not extended to code formats (that would over-assert; the loader allowlist covers it).
        for (const [dir, { files }] of bundle.modules) {
          for (const rel of Object.keys(files)) {
            const file = moduleFileKey(dir, rel)
            const lockFormat = this.#lockFormats.get(file)
            if (!Bundle.isResourceFormat(lockFormat)) continue
            assert.equal(bundle.formats.get(file), lockFormat,
              `bundle file ${file} must declare format='${lockFormat}' to match the lockfile`)
          }
        }
      }
    } else {
      // Mutate in place, don't reassign -- this.entries may be shared by reference with a
      // sidecar's parent, and reassigning would fork the shared set.
      for (const e of bundle.entries) this.entries.add(e)
      for (const [dir, info] of bundle.modules) {
        if (!info.name || !info.version) continue // partial metadata
        if (this.modules.has(dir)) {
          // A dir added twice (unified bundle populates from code + resource entries) must agree on name/version.
          const existing = this.modules.get(dir)
          assert.equal(info.name, existing.name, `bundle ${dir} name mismatch`)
          assert.equal(info.version, existing.version, `bundle ${dir} version mismatch`)
        } else {
          this.modules.set(dir, info.ecosystem === undefined
            ? { name: info.name, version: info.version, files: Object.create(null) }
            : { name: info.name, version: info.version, ecosystem: info.ecosystem, files: Object.create(null) })
        }
      }
    }
  }

  // Load the resources side of a split-bundle layout: a standalone Bundle holding ONLY
  // resource-format files, unioned into the bundleFile state. Shape asserts catch leaked code/metadata.
  #absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath }) {
    const bundle = Bundle.parse(brotliDecompressSync(resourcesData).toString('utf-8'))
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 resources bundle; ${resourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // Resources file MUST NOT declare imports or entries (those belong to the code bundle) --
    // a populated map means mixed halves or tampering, widening trust on the code side.
    assert.equal(bundle.imports.size, 0, `resources bundle ${resourcesPath} must have empty imports`)
    assert.equal(bundle.entries.size, 0, `resources bundle ${resourcesPath} must have empty entries`)
    for (const [file, format] of bundle.formats) {
      assert.ok(Bundle.isResourceFormat(format),
        `resources bundle ${resourcesPath} declares non-resource format='${format}' for ${file}`)
    }
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    for (const [file, content] of bundle.sources) {
      this.resources.set(file, content)
    }
    // Union formats: file sets must be disjoint (code formats in bundleFile, resource formats here).
    for (const [file, format] of bundle.formats) {
      const existing = this.formats.get(file)
      assert.ok(existing === undefined || existing === format,
        `format conflict for ${file}: bundleFile declares '${existing}', resourcesBundleFile declares '${format}'`)
      this.formats.set(file, format)
    }
    // Carry this half's `reason` attribution forward too (the resources bundle's reason is
    // restricted to resource files by #bundleReason's inBundle filter, so it stays disjoint
    // from the code half's -- see #seedReasonFromBundle).
    this.#seedReasonFromBundle(bundle)
    if (this.config.frozenBundle) {
      // Extend the frozen snapshot; init lazily since bundleFile may not have populated these
      // (resources-only deployments are legal, so #bundleSources may stay null).
      if (this.#bundleResources === null) this.#bundleResources = new Set()
      if (this.#bundleFormats === null) this.#bundleFormats = new Map()
      if (this.#bundleImports === null) this.#bundleImports = objectToMaps(fileMapToObject(this.imports))
      if (this.#bundleSources === null) this.#bundleSources = new Set(this.sources.keys())
      for (const f of bundle.sources.keys()) this.#bundleResources.add(f)
      for (const [f, fmt] of bundle.formats) this.#bundleFormats.set(f, fmt)
    }
  }

  // Verify one resolution edge against an attestation map. Match the conditions key exactly
  // first; on a miss, accept only if every condition set for that (parent, specifier) agrees on
  // the same target (lets static '*' edges and runtime condition-set edges cross-validate).
  // Unknown edges fatal unless the caller opts out (addImport's node_modules carve-out).
  #assertAttestedResolution(attestation, conditions, parent, specifier, file, { what, source = 'lockfile', tolerateUnknown = false }) {
    const edge = `'${specifier}' from ${parent} (${conditions})`
    let attested = attestation.get(conditions)?.get(parent)?.get(specifier)
    if (attested === undefined) {
      const targets = new Set()
      for (const [, parents] of attestation) {
        const target = parents.get(parent)?.get(specifier)
        if (target !== undefined) targets.add(target)
      }
      if (targets.size === 0 && tolerateUnknown) return
      assert.ok(targets.size > 0, `${what} resolution ${edge} is not attested by the ${source}`)
      assert.ok(targets.size === 1, `${what} resolution ${edge} is attested inconsistently across condition sets in the ${source}`)
      ;[attested] = targets
    }
    // A per-platform edge is a Map<platform, target> -- compare structurally (assert.equal is
    // reference equality). A flat string stays ===; Map-vs-string is a mismatch.
    const matches = file instanceof Map && attested instanceof Map
      ? file.size === attested.size && [...file].every(([platform, target]) => attested.get(platform) === target)
      : file === attested
    assert.ok(matches, `${what} resolution ${edge} mismatches the ${source}`)
  }

  // Verify one file's loader format against an attestation map. Callers only invoke this for
  // files that must be attested, so an unattested file means a forged/extra entry -- fatal.
  #assertAttestedFormat(attestation, file, format, { what, source = 'lockfile' }) {
    const attested = attestation.get(file)
    assert.ok(attested !== undefined, `${what} format for ${file} is not attested by the ${source}`)
    assert.equal(format, attested, `${what} format for ${file} mismatches the ${source}`)
  }

  assertEntry(url) {
    // Skipped when no entries info is available (lock=none/ignore with no bundle, or a fresh
    // build). A RUNNABLE full-scope code bundle always declares an entry -- #absorbCodeBundle
    // refuses one that doesn't (an add-only attestation) -- so an empty set here means there is
    // simply no entry attestation to check against, not a bundle bypassing it.
    if (this.entries.size === 0) return
    const file = this.#canonicalFile(url)
    assert.ok(this.entries.has(file), `Unknown entry point: ${file}`)
  }

  // The one preload (top-level) State, or undefined; scans the process-wide registry.
  static get preload() {
    for (const state of liveStates()) if (state.isPreload) return state
    return undefined
  }

  // True iff this is THE preload State. Public so State.preload works across copies.
  get isPreload() {
    return this.#isPreload
  }

  // Label under which this State claims `canonical` as a write target, or undefined (public for
  // #claimWritePath's cross-copy collision scan).
  claimedWritePathLabel(canonical) {
    return this.#claims.get(canonical)
  }

  // Claim a write target, refusing a path another live State (ANY copy) already claims.
  // Canonicalize so `./x`/`x`/symlinks compare equal. Only fires cross-State (Config catches intra-State).
  #claimWritePath(label, value) {
    if (!value) return
    const canonical = canonicalizePath(value)
    for (const other of liveStates()) {
      const owner = other.claimedWritePathLabel(canonical)
      assert.ok(owner === undefined, `${label} '${value}' is already claimed by ${owner} of another live State`)
    }
    this.#claims.set(canonical, label)
  }

  // This State's stasis-core version. Public so a sidecar can verify it matches its parent's across copies.
  get version() {
    return VERSION
  }

  // The slice of parent state a sidecar inherits. PUBLIC (not private-field reads) so a
  // version-matched sidecar from a different copy can read it across the class brand.
  sidecarInheritance() {
    return {
      preloadRoot: this.#preloadRoot,
      lockImports: this.#lockImports,
      lockFormats: this.#lockFormats,
      lockfileLoaded: this.#lockfileLoaded,
    }
  }

  // Register a WRITE-mode sidecar so this parent's lockData unions its imports/formats.
  // Public (cross-copy, like sidecarInheritance).
  registerSidecar(sidecar) {
    this.#sidecars.add(sidecar)
  }

  // Register a LOAD-mode sidecar (read-only): getFs*Family serves bundle bytes from it, but it
  // never enters #mergedImports/#mergedFormats (contributes nothing to the lockfile). Public, cross-copy.
  registerReadSidecar(sidecar) {
    this.#readSidecars.add(sidecar)
  }

  absolute(url) {
    const absolute = fileURLToPath(url)
    assert.equal(pathToFileURL(absolute).toString(), url)
    assert.equal(absolute, resolve(absolute))
    return absolute
  }

  relative(absolute) {
    assert.ok(absolute)
    const file = relative(this.root, absolute)
    assert.ok(!file.startsWith('..'))
    // The project root is keyed '.', never '' -- recording/looking up under '' would desync
    // write from read (written under '' yet hashed under '.') and fail getFile's integrity check.
    return file === '' ? '.' : file
  }

  // A file under node_modules whose REAL path is outside node_modules is a linked-in workspace
  // source (pnpm): canonicalize to the real path so it's recorded as a source, not a dependency.
  // Everything else passes through (plain sources, real deps, node_modules->node_modules links).
  #canonical(url) {
    const absolute = this.absolute(url)
    const file = relative(this.root, absolute)
    if (file.startsWith('..') || !splitNodeModulesPath(file)) return { url, absolute }
    let real
    try {
      real = realpathSync(absolute)
    } catch {
      return { url, absolute }
    }
    if (real === absolute) return { url, absolute } // not a symlink
    const realFile = relative(this.root, real)
    // Outside the root, or still inside a node_modules (a real dep): leave the path unchanged.
    if (realFile.startsWith('..') || splitNodeModulesPath(realFile)) return { url, absolute }
    return { url: pathToFileURL(real).toString(), absolute: real }
  }

  // The canonical project-relative path a URL is recorded/looked up under.
  #canonicalFile(url) {
    return this.relative(this.#canonical(url).absolute)
  }

  // True when `url` resolves (through any workspace symlink) to a file under node_modules -- a
  // bundled dependency. Gated on this rather than a raw `/node_modules/` substring so a symlinked
  // workspace source is read from disk. Tolerant: an uncanonicalizable URL is not-a-dependency.
  inNodeModules(url) {
    let file
    try {
      file = this.#canonicalFile(url)
    } catch {
      return false
    }
    return splitNodeModulesPath(file) !== null
  }

  // Nearest package.json at or above a directory (for addFsDir). Replaces findPackageJSON,
  // unreliable for a directory URL (see #locateModule). Bounded by the project root.
  #nearestPackageJsonFor(dirAbsolute) {
    let dir = dirAbsolute
    while (true) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) return candidate
      if (dir === this.root) break // checked the root's package.json; never escape root
      const parent = dirname(dir)
      if (parent === dir) break // filesystem root
      dir = parent
    }
    // Unreachable: state.root is resolved to a dir that has package.json.
    assert.fail(`no package.json at or above directory ${this.relative(dirAbsolute)}`)
  }

  // Canonicalize `url` and resolve the owning package bucket, registering the module
  // (name/version, `npm` ecosystem under node_modules) on first sight. Shared by addFile and
  // addFsDir. Returns the canonical absolute path, project-relative `file`, bucket `dir`/`module`,
  // and nearest package `type`.
  //
  // `directory: true` (addFsDir): Node's findPackageJSON is unreliable for a directory URL (returns
  // the parent's, undefined, or a node_modules dir path that reads as EISDIR), so we walk up ourselves.
  #locateModule(url, { directory = false } = {}) {
    // Canonicalize first: a linked-in workspace source is recorded under its real path (a source).
    const canonical = this.#canonical(url)
    url = canonical.url
    const absolute = canonical.absolute
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const closestPkgAbsolute = directory ? this.#nearestPackageJsonFor(absolute) : findPackageJSON(url)
    const closestPkg = readPackageJSON(closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')

    // findPackageJSON may land on a `{"type":"module"}` sub-bucket marker lacking name/version.
    const nmRoot = splitNodeModulesPath(file)?.dir
    let pkgAbsolute, name, version
    if (nmRoot) {
      pkgAbsolute = resolve(this.root, nmRoot, 'package.json')
      const rootPkg = pkgAbsolute === closestPkgAbsolute ? closestPkg : readPackageJSON(pkgAbsolute)
      ;({ name, version } = rootPkg)
      assert.ok(name, `Missing name in ${this.relative(pkgAbsolute)}`)
      assert.ok(version, `Missing version in ${this.relative(pkgAbsolute)}`)
      if (closestPkgAbsolute !== pkgAbsolute) {
        const message = `Inconsistent data between ${this.relative(closestPkgAbsolute)} and ${this.relative(pkgAbsolute)}`
        if (closestPkg.name !== undefined && closestPkg.name !== name) {
          // Allow fake module-name subpaths: the real module owns the prefix (npm wouldn't publish this).
          assert.ok(closestPkg.name.startsWith(`${name}/`), message)
        }

        if (closestPkg.version !== undefined) assert.equal(closestPkg.version, version, message)
      }
    } else {
      pkgAbsolute = closestPkgAbsolute
      let json = closestPkg
      while (true) {
        if (json.name !== undefined && json.version !== undefined) {
          ;({ name, version } = json)
          break
        }
        assert.ok(Object.keys(json).every((k) => k === 'type'))
        const next = findPackageJSON('..', pathToFileURL(pkgAbsolute))
        assert.ok(
          next && !relative(this.root, next).startsWith('..'),
          `No package.json with name+version found for ${file}`
        )
        pkgAbsolute = next
        json = readPackageJSON(pkgAbsolute)
      }
    }
    const pkg = this.relative(pkgAbsolute)
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    assert.equal(basename(pkg), 'package.json')
    const dir = dirname(pkg)
    if (nmRoot) assert.equal(dir, nmRoot)
    if (!this.modules.has(dir)) {
      // Tag node_modules buckets `npm` so consumers can tell deps from workspace packages
      // without re-deriving from the path. Workspace/top-level buckets carry no ecosystem.
      this.modules.set(dir, nmRoot
        ? { name, version, ecosystem: 'npm', files: Object.create(null) }
        : { name, version, files: Object.create(null) })
    }
    const module = this.modules.get(dir)
    assert.equal(module.name, name)
    assert.equal(module.version, version)

    return { absolute, file, dir, module, closestType }
  }

  // `resource: true` (legacy alias `isBinary: true`) marks the file a resource; format is
  // derived from bytes ('resource' for UTF-8, 'resource:base64' for binary).
  // `inferFormat: false` records bytes without imposing a loader format (addFsFile uses it for
  // .js/.ts, deferring module-vs-commonjs to the loader so an fs-read doesn't force commonjs).
  addFile(url, { source, format, isEntry, isBinary, resource, inferFormat = true, reason = 'run', fsRead = false } = {}) {
    const asResource = resource === true || isBinary === true
    // A resource format must not arrive on the code path without resource:true -- that would tag
    // a code file as a resource. The reverse is rejected below via the content-derived check.
    if (!asResource && Bundle.isResourceFormat(format)) {
      throw new Error(`addFile: format '${format}' requires resource: true`)
    }
    // A 'stat:*' format is never legal for addFile (which records content): it would desync the
    // "stat records carry no payload" invariant. Use addFsStat.
    if (isStatFormat(format)) {
      throw new Error(`addFile: format '${format}' is a payload-free stat record; use addFsStat`)
    }
    // A resource can't be an entry: entries name code loaded by Node. A resource entry would
    // land in codeBundle.entries referring to a file absent from its sources -- broken later.
    if (asResource && isEntry) {
      throw new Error(`addFile: a resource can't be an entry (resource:true + isEntry:true)`)
    }
    // Canonicalize + bucket by the owning package (shared with addFsDir).
    const { absolute, file, dir, module, closestType } = this.#locateModule(url)

    // A payload-free stat record (path stat'd before read/import) is superseded by real content:
    // drop it so the noupsert below records the actual format instead of conflicting with 'stat:*'.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)

    // A code file can NEVER be a resource: the `resources` gate rejects code extensions, so a
    // resource:true call for a code extension means a capture bypassed it. Fail at the recording site.
    if (asResource && CODE_EXTENSIONS.has(extname(file).slice(1).toLowerCase())) {
      throw new Error(`addFile: a code file can't be recorded as a resource: ${file}`)
    }

    // Resources get no inferred loader format (chosen by content below); inferFormat:false skips inference.
    if (!asResource && inferFormat) {
      const extToFormat = {
        __proto__: null,
        '.json': 'json',
        '.mjs': 'module',
        '.cjs': 'commonjs',
        '.mts': 'module-typescript',
        '.cts': 'commonjs-typescript',
      }
      if (closestType !== undefined) {
        extToFormat['.js'] = closestType
        extToFormat['.ts'] = `${closestType}-typescript`
      }
      const inferredFormat = extToFormat[extname(file)]
      if (inferredFormat !== undefined) {
        if (format != null) assert.equal(format, inferredFormat)
        else format = inferredFormat
      } else if (format == null) {
        // No `type` in the nearest package.json: Node decides .js/.ts by syntax detection, so
        // with no format provided, defer to a format already recorded for this file this session
        // (loader's authoritative module/commonjs choice, or the parent's for a sidecar) rather
        // than re-defaulting to commonjs and mis-attesting. Only an extension-appropriate code
        // format is reused; a stale resource tag falls through so the conflict surfaces at noupsert.
        const variants = {
          __proto__: null,
          '.js': ['commonjs', 'module'],
          '.ts': ['commonjs-typescript', 'module-typescript'],
        }[extname(file)]
        const known = this.formats.get(file) ?? this.#parent?.formats.get(file)
        format = variants?.includes(known) ? known : variants?.[0]
      }
    }

    let sourceFromDisk = false
    if (typeof source === 'string') {
      assert.ok(source.isWellFormed())
    } else {
      if (source === undefined || source === null) { source = readFileSync(absolute); sourceFromDisk = true }
      assert.ok(Buffer.isBuffer(source))
      if (!asResource) assert.ok(isUtf8(source), `File is not UTF-8: ${file}`)
    }

    const buf = typeof source === 'string' ? Buffer.from(source) : source
    // Verify a CALLER-PROVIDED source against disk (catches bytes differing from the file). When
    // we read `source` ourselves the comparison is tautological, so skip it.
    if (!sourceFromDisk) assert.deepStrictEqual(readFileSync(absolute), buf)

    // Resource format is content-driven: UTF-8 stays 'resource', else 'resource:base64'.
    if (asResource) {
      const derived = isUtf8(buf) ? 'resource' : 'resource:base64'
      if (format != null) assert.equal(format, derived, `resource format mismatch for ${file}`)
      format = derived
    }

    if (isEntry) this.entries.add(file)
    const integrity = sha512integrity(source)
    noupsert(this.hashes, file, integrity)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it; skip when the channel is off
    if (this.config.bundle && reason !== null) {
      this.#recordReason(reason, file) // provenance for the bundle's `reason` field (null = not a consumer observation, e.g. backfill)
      // Track HOW 'run' saw this file so #bundleReason can drop files run merely fs-READ post-plugin.
      if (reason === 'run') {
        if (!fsRead) this.#runImported.add(file)
        else if (this.#pluginAttached) this.#fsReadPostPlugin.add(file)
      }
    }
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    const inAttestedZone = hasNodeModulesSegment(dir) || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel))
    }

    // Frozen bundle: bytes are checked by the noupsert below; here we close the set, rejecting a
    // file the bundle never recorded. Scope carve-out: node_modules scope doesn't attest workspace files.
    if (this.config.frozenBundle && inAttestedZone) {
      const attested = asResource ? this.#bundleResources : this.#bundleSources
      assert.ok(attested?.has(file), `File not attested by the frozen bundle: ${file}`)
    }

    // Frozen runs verify the on-disk format against the attestation: `type` is usually not
    // hash-attested, so flipping it recategorizes a hash-valid file (commonjs<->module) with no
    // hash mismatch. Gated to the attested zone; files with no derived format are skipped.
    if (this.config.frozen && this.#lockFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
    }

    // A lock=add capture must catch a format flip on already-attested bytes EARLY: the baseline
    // in #lockFormats (separate from this.formats) would otherwise surface only at write()'s
    // #mergedFormats as a bare `Conflict`. Detect it here with a clear error. Re-attest a genuine
    // change with --lock=replace.
    if (this.config.writeLockfile && this.#lockFormats !== null && format != null && inAttestedZone) {
      const attested = this.#lockFormats.get(file)
      // A 'stat:*' baseline is not a flip: real content this run UPGRADES the record (#mergedFormats).
      assert.ok(attested === undefined || attested === format || isStatFormat(attested),
        `format flip for ${file}: lockfile attests '${attested}', observed '${format}' (bytes unchanged) -- re-run with --lock=replace to re-attest`)
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)

    if (this.config.bundle) {
      if (asResource) {
        // 'resource' stores the raw UTF-8 string; 'resource:base64' stores base64.
        const content = format === 'resource:base64' ? buf.toString('base64') : buf.toString('utf8')
        noupsert(this.resources, file, content)
      } else {
        noupsert(this.sources, file, typeof source === 'string' ? source : source.toString())
      }
    }

    if (format) noupsert(this.formats, file, format)
  }

  // Record an `fs.readFileSync` capture (--fs). classifyFormat routes the bytes:
  //  - concrete code format -> recorded as code (addFile asserts UTF-8).
  //  - null (.js/.ts/.jsx/.tsx) -> code with NO format imposed (loader stays authoritative).
  //  - undefined (not code) -> a resource payload IFF allowlisted, else THROW (an undeclared
  //    file would widen the attested set).
  addFsFile(url, source) {
    assert.ok(Buffer.isBuffer(source), 'addFsFile requires a Buffer source')
    const path = fileURLToPath(url)
    const format = classifyFormat(path, { content: source })
    if (format === undefined) {
      if (this.config.resources.has(pathExt(path) || basename(path).toLowerCase())) {
        this.addFile(url, { source, resource: true, fsRead: true })
        return
      }
      throw new Error(
        `addFsFile: ${path} is neither code nor a declared resource; ` +
        `add its extension or filename to the resources allowlist or stop reading it`
      )
    }
    // format === null defers to the loader (impose nothing); a concrete format is recorded as-is.
    this.addFile(url, { source, format: format ?? undefined, inferFormat: false, fsRead: true })
  }

  // Record an `fs.readdirSync(path)` capture. The listing is SORTED for reproducibility,
  // JSON-serialized, and stored as a 'directory'-format payload (integrity in the lockfile).
  addFsDir(url, names) {
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'),
      'addFsDir requires an array of string names')
    const { file, dir, module } = this.#locateModule(url, { directory: true })
    // As in addFile: drop a payload-free stat record (dir stat'd before readdir) before recording 'directory'.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)
    const content = JSON.stringify(names.toSorted())
    const format = 'directory'
    const integrity = sha512integrity(content)
    noupsert(this.hashes, file, integrity)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it; skip when the channel is off
    // Directory captures come only from --fs (plugins never readdir), so no #fsReadPostPlugin tracking needed.
    if (this.config.bundle) this.#recordReason('run', file)
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    // Frozen attestation (mirrors addFile): in the attested zone the listing must already be recorded and match.
    const inAttestedZone = hasNodeModulesSegment(dir) || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel))
    }
    if (this.config.frozenBundle && inAttestedZone) {
      assert.ok(this.#bundleResources?.has(file), `Directory not attested by the frozen bundle: ${file}`)
    }
    if (this.config.frozen && this.#lockFormats !== null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)
    if (this.config.bundle) noupsert(this.resources, file, content)
    noupsert(this.formats, file, format)
  }

  // Record an `fs.lstatSync/statSync(path)` capture: a PAYLOAD-FREE stat record
  // (`formats[file] = 'stat:file'|'stat:directory'`, no bytes/hash/module-files entry) attesting
  // only that the path existed with that KIND, so getFsStat answers isFile()/isDirectory() at load.
  // Skipped when a content record already exists (that answers getFsStat; a weak stat must not sit
  // beside it). upsertFormat lets a real format win over a stat record; a kind flip stays fatal.
  addFsStat(url, kind) {
    assert.ok(kind === 'file' || kind === 'directory', `addFsStat: unsupported kind '${kind}'`)
    const file = this.#canonicalFile(url)
    if (this.hashes.has(file) || this.sources.has(file) || this.resources.has(file)) return
    upsertFormat(this.formats, file, `stat:${kind}`)
    // Forwarded to the root via shardSnapshot's #observed-filtered formats, like every other
    // capture; only a child's shardSnapshot reads it, and only when a stat record actually
    // landed (upsertFormat yields to an existing real format, and forwarding THAT would ship
    // an entry mergeShard's stat replay ignores).
    if (this.config.childProcess && isStatFormat(this.formats.get(file))) this.#observed.add(file)
  }

  // Serve an `fs.readFileSync` from the bundle (bundle=load): raw bytes as a Buffer, or undefined
  // when uncaptured (hook falls back to disk) or a captured directory. Served by presence, not format.
  getFsFile(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) === 'directory') return undefined
    if (!this.sources.has(file) && !this.resources.has(file)) return undefined
    const { source } = this.getFile(url)
    return Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  }

  // Serve an `fs.readdirSync(path)` from the bundle: the captured sorted listing, or undefined if uncaptured.
  getFsDir(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) !== 'directory') return undefined
    const { source } = this.getFile(url)
    const names = JSON.parse(source)
    assert.ok(Array.isArray(names), `corrupt directory listing for ${file}`)
    return names
  }

  // Every ancestor directory implied by recorded file/resource/directory keys (e.g.
  // `node_modules/dep/index.js` implies `node_modules/dep`, `node_modules`, '.'). Built once.
  #impliedDirs() {
    if (this.#impliedDirIndex) return this.#impliedDirIndex
    const dirs = new Set(['.'])
    const add = (key) => {
      let prefix = ''
      const parts = key.split('/')
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix === '' ? parts[i] : `${prefix}/${parts[i]}`
        dirs.add(prefix)
      }
    }
    for (const key of this.sources.keys()) add(key)
    for (const key of this.resources.keys()) add(key)
    // Stat records prove existence too: a 'stat:file' implies its ancestor dirs like a content
    // record; a 'stat:directory' implies its own ancestors (the dir itself answered by getFsStat).
    for (const [key, format] of this.formats) if (isStatFormat(format)) add(key)
    this.#impliedDirIndex = dirs
    return dirs
  }

  // Classify a captured path for the lstat/statSync .isFile()/.isDirectory() shim: 'directory'
  // (readdir/stat:directory/implied ancestor), 'file' (readFileSync/stat:file), or undefined
  // (uncaptured -> shim falls back to disk). Order matters: 'directory' first, content before stat
  // records, implied dirs last. NB: 'file' means "recorded", NOT "bytes serveable" (use hasFsFileContent).
  getFsStat(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    const format = this.formats.get(file)
    if (format === 'directory') return 'directory'
    if (this.sources.has(file) || this.resources.has(file)) return 'file'
    if (format === 'stat:file') return 'file'
    if (format === 'stat:directory') return 'directory'
    if (this.#impliedDirs().has(file)) return 'directory'
    return undefined
  }

  // True when the bundle carries actual BYTE content for `url` as a file (code or resource),
  // not a directory/stat-only record. Used where getFsStat's "file for stat-only records" is wrong.
  hasFsFileContent(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return false }
    if (this.formats.get(file) === 'directory') return false
    return this.sources.has(file) || this.resources.has(file)
  }

  // --fs <-> bundler-plugin coordination. A sidecar captures the bundler's module graph into its
  // OWN bundle, but the bundler also fs-reads every module -- which --fs would re-record into main,
  // defeating the split. So: CAPTURE skips a read a write-mode sidecar (#sidecars) already attests;
  // LOAD serves a graph file from a load-mode sidecar (#readSidecars). Different registries because
  // a sidecar is contributor XOR consumer. This State is excluded (its own files keep --fs dedup).
  attestedBySidecar(url) {
    // hasFsFileContent (not getFsStat): the skip targets BYTES a sidecar carries. getFsStat would
    // also match an implied dir or stat-only record -- over-skipping, leaving a real read unattested.
    for (const s of this.#sidecars) if (s.hasFsFileContent(url)) return true
    return false
  }

  // getFs* variants that also consult load-mode sidecars (#readSidecars; this State first), so a
  // file/dir a sidecar carries is served at load. Only #readSidecars (write-mode only captures).
  getFsFileFamily(url) {
    const own = this.getFsFile(url)
    if (own !== undefined) return own
    for (const s of this.#readSidecars) { const v = s.getFsFile(url); if (v !== undefined) return v }
    return undefined
  }

  getFsStatFamily(url) {
    const own = this.getFsStat(url)
    if (own !== undefined) return own
    for (const s of this.#readSidecars) { const v = s.getFsStat(url); if (v !== undefined) return v }
    return undefined
  }

  getFsDirFamily(url) {
    const own = this.getFsDir(url)
    if (own !== undefined) return own
    // Inert in practice (plugins never record directory listings); kept for symmetry with the file/stat families.
    for (const s of this.#readSidecars) { const v = s.getFsDir(url); if (v !== undefined) return v }
    return undefined
  }

  getFile(url) {
    // Wrap #canonicalFile so a URL escaping state.root gives a contextual error, not a bare assert.
    let file
    try { file = this.#canonicalFile(url) }
    catch (cause) { throw new Error(`stasis: file is outside the project root: ${url}`, { cause }) }
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    // Resources in this.resources, code in this.sources; decode per format. A missing entry throws
    // with the URL in context -- the single getFile call is the fail-closed gate.
    let source
    if (Bundle.isResourceFormat(format)) {
      source = this.resources.get(file)
      if (source === undefined) throw new Error(`stasis: file not attested in bundle: ${url}`)
      if (format === 'resource:base64') source = Buffer.from(source, 'base64')
    } else {
      source = this.sources.get(file)
      if (source === undefined) {
        // Stat-record case: the bundle knows the path but not its bytes -- "not attested" would misdiagnose it.
        if (isStatFormat(format)) {
          throw new Error(
            `stasis: only a payload-free stat record ('${format}') is attested for ${url} -- ` +
            `the capture stat'd this path but never read or imported it, so the bundle has no bytes to serve`
          )
        }
        throw new Error(`stasis: file not attested in bundle: ${url}`)
      }
    }
    // Without a lockfile the bundle is self-attesting -- verifying its hash against its own bytes is a tautology.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  // The recorded LOADER format for a file, or undefined. Masks 'stat:*' records (existence/kind,
  // not how bytes parse) so loader-format consumers see "no format" -- without it, a stat'd
  // require.resolve target was refused by the resolve hook's format gate. getFile does NOT mask.
  #loaderFormat(file) {
    const format = this.formats.get(file)
    return isStatFormat(format) ? undefined : format
  }

  getFormat(url) {
    return this.#loaderFormat(this.#canonicalFile(url))
  }

  // Different conditions / import attributes can yield different URLs/formats for the same parent+specifier
  #conditionsKey(conditions, importAttributes) {
    const cond = conditions === '*' ? '*' : conditions.join(', ')
    assert.ok(!cond.includes('(') && !cond.includes(')'), 'conditions must not contain "(" or ")"')
    const attrs = importAttributes ? Object.entries(importAttributes) : []
    if (attrs.length === 0) return cond
    const sorted = Object.fromEntries(attrs.toSorted(([a], [b]) => (a < b ? -1 : 1)))
    return `${cond} (with: ${JSON.stringify(sorted)})`
  }

  // An already-resolved ABSOLUTE require()/import() target arrives as the specifier (fs path or
  // file: URL). Recorded verbatim it becomes a machine-specific, non-portable lockfile key that
  // also varies by Node version. So, once confirmed inside the root, renormalize it relative to
  // the IMPORTING FILE's directory (the `require('./x')` shape) -- portable and collision-free
  // ('.'-prefixed). Bare/relative specifiers and out-of-root absolutes pass through. Must be
  // applied identically in addImport and getImport so keys written and queried agree.
  #canonicalSpecifier(parentURL, specifier) {
    if (typeof specifier !== 'string') return specifier
    const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
    if (!isAbsolute(path)) return specifier
    const fromRoot = relative(this.root, path)
    if (fromRoot === '' || fromRoot.startsWith('..')) return specifier // outside the project root
    const rel = relative(dirname(fileURLToPath(parentURL)), path)
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  addImport(parentURL, specifier, url, { conditions = '*', format, importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    // Capture Node's require-condition set on the first require()-context edge (carries 'require',
    // never 'import'). #backfillObservedResolutions reuses it to key native edges (see field doc).
    if (this.#requireConditions === null && Array.isArray(conditions) &&
        conditions.includes('require') && !conditions.includes('import')) {
      this.#requireConditions = conditions
    }
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)

    // Frozen runs verify disk resolutions against the lockfile: hashes can't see a redirect to a
    // different attested file. Unknown edges fatal in full scope; tolerated for workspace parents
    // in node_modules scope (the workspace is deliberately unattested there).
    const tolerateUnknown = !this.config.full && !hasNodeModulesSegment(parent)
    if (this.config.frozen && this.#lockImports !== null) {
      this.#assertAttestedResolution(this.#lockImports, key, parent, specifier, file, { what: 'observed', source: 'lockfile', tolerateUnknown })
    }
    // A frozen bundle attests resolutions the same way (anchored in the bundle, same carve-out).
    if (this.config.frozenBundle && this.#bundleImports !== null) {
      this.#assertAttestedResolution(this.#bundleImports, key, parent, specifier, file, { what: 'observed', source: 'frozen bundle', tolerateUnknown })
    }

    if (!this.imports.has(key)) this.imports.set(key, new Map())
    const imports = this.imports.get(key)
    if (!imports.has(parent)) imports.set(parent, new Map())
    const specifiers = imports.get(parent)
    noupsert(specifiers, specifier, file)
    // upsertFormat (not a bare noupsert): the resolve hook may attest a format for a target already
    // stat'd under --fs -- the real format replaces the weak 'stat:*' record instead of conflicting.
    if (format) upsertFormat(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'getImport requires a parent') // matches addImport; #canonicalSpecifier needs it
    const parent = this.#canonicalFile(parentURL)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    // Static bundles store edges under the wildcard '*' key (can't predict Node's condition set);
    // the runtime loader records precise conditions. Specific lookup wins; only static bundles take '*'.
    let file = this.imports.get(key)?.get(parent)?.get(specifier)
    if (file === undefined && key !== '*') {
      file = this.imports.get('*')?.get(parent)?.get(specifier)
    }
    if (file === undefined) {
      // The edge may be recorded under a DIFFERENT conditions bucket -- resolveBundled scans every bucket.
      if (this.config.loadBundle) {
        const abs = this.resolveBundled(parentURL, specifier)
        if (abs !== undefined) {
          const f = relative(this.root, abs)
          return { url: pathToFileURL(abs).toString(), format: this.#loaderFormat(f) }
        }
      }
      // Throw Node's ERR_MODULE_NOT_FOUND shape, not a bare assert: dynamic-import callers guard on
      // that code (`if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e`), which ERR_ASSERTION escapes.
      const err = new Error(`Cannot find module '${specifier}' imported from ${parent}`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    // A --metro artifact records a { platform: file } Map for a per-platform edge. Plain bundle=load
    // has no platform context to pick one, so it fails closed rather than feed a Map where a path is expected.
    if (typeof file !== 'string') {
      const err = new Error(`Resolution of '${specifier}' from ${parent} is platform-specific (a --metro multi-platform bundle); it can't be loaded by plain node, build a single-platform bundle to load`)
      err.code = 'ERR_STASIS_PLATFORM_SPECIFIC'
      throw err
    }
    const url = pathToFileURL(resolve(this.root, file)).toString()
    // #loaderFormat: may be undefined (some bundlers) and masks a stat record (a resolve-only target's, not a loader format).
    const format = this.#loaderFormat(file)
    return { url, format }
  }

  // Resolve a CommonJS require() target to a bundled file (absolute path for load() to serve), or
  // undefined to defer to Node. Node's CJS loader resolves require() through Module._resolveFilename,
  // which registerHooks doesn't intercept, so the hooks.js CJS shim consults this to keep a pruned
  // bundle self-contained. Returns the edge under ANY conditions bucket (native require gives none);
  // divergent targets across buckets are ambiguous -> defer. A miss means the target is an external.
  resolveBundled(parentURL, specifier) {
    let parent
    try { parent = this.#canonicalFile(parentURL) } catch { return undefined }
    const spec = this.#canonicalSpecifier(parentURL, specifier)
    const matches = new Set()
    for (const [, byParent] of this.imports) {
      const file = byParent.get(parent)?.get(spec)
      if (file !== undefined) matches.add(file)
    }
    if (matches.size !== 1) return undefined
    const [only] = matches
    // Per-platform { platform: file } Map (--metro) has no single path: defer to native, not resolve()'s TypeError.
    if (typeof only !== 'string') return undefined
    return resolve(this.root, only)
  }

  // Union of lockfile-attested resolutions and the live map, so a partial lock=add run extends
  // recorded resolutions without dropping edges. Conflicting targets are fatal (add semantics).
  #mergedImports() {
    const merged = new Map()
    const mergeIn = (imports) => {
      for (const [conditions, byParent] of imports) {
        if (!merged.has(conditions)) merged.set(conditions, new Map())
        const mergedParents = merged.get(conditions)
        for (const [parent, specifiers] of byParent) {
          if (!mergedParents.has(parent)) mergedParents.set(parent, new Map())
          const mergedSpecifiers = mergedParents.get(parent)
          for (const [specifier, file] of specifiers) {
            noupsert(mergedSpecifiers, specifier, file)
          }
        }
      }
    }
    if (this.#lockImports) mergeIn(this.#lockImports)
    mergeIn(this.imports)
    // Union write-mode sidecars' imports too, so the lockfile attests their graph edges for frozen verify.
    for (const sidecar of this.#sidecars) mergeIn(sidecar.imports)
    return merged
  }

  // Union of lockfile-attested and observed/bundle-served formats (+ sidecars'), append-only like
  // #mergedImports. Exception: a weak 'stat:*' record is UPGRADED by real content (upsertFormat);
  // two real formats or divergent stat kinds stay fatal.
  #mergedFormats() {
    const merged = new Map()
    if (this.#lockFormats) for (const [file, format] of this.#lockFormats) merged.set(file, format)
    for (const [file, format] of this.formats) upsertFormat(merged, file, format)
    for (const sidecar of this.#sidecars) {
      for (const [file, format] of sidecar.formats) upsertFormat(merged, file, format)
    }
    return merged
  }

  get lockData() {
    return new Lockfile({
      config: this.config.values,
      entries: this.entries,
      modules: this.modules,
      imports: this.#mergedImports(),
      formats: this.#mergedFormats(),
    }).serialize()
  }

  // Pair each module's recorded file list with content from perFile (sources or resources),
  // dropping modules with no content.
  #bundleModules(perFile) {
    const modules = new Map()
    for (const [dir, info] of this.modules) {
      const files = {}
      for (const rel of Object.keys(info.files)) {
        const file = moduleFileKey(dir, rel)
        const content = perFile.get(file)
        if (content !== undefined) files[rel] = content
      }
      if (Object.keys(files).length > 0) {
        modules.set(dir, info.ecosystem === undefined
          ? { name: info.name, version: info.version, files }
          : { name: info.name, version: info.version, ecosystem: info.ecosystem, files })
      }
    }
    return modules
  }

  // A bundler plugin has attached to this State. Files fs-READ after this point that a plugin also
  // bundles are the plugin's, not run's (see #bundleReason). Public, cross-copy.
  markPluginAttached() {
    this.#pluginAttached = true
  }

  // Record which consumer (`reason`) observed `file`, for the bundle's informational `reason` map.
  #recordReason(reason, file) {
    let set = this.#reasonFiles.get(reason)
    if (set === undefined) this.#reasonFiles.set(reason, set = new Set())
    set.add(file)
  }

  // Seed `reason` provenance from an absorbed on-disk bundle so a bundle=add re-run preserves other
  // consumers' attribution (else #bundleReason would rebuild from this run alone and drop it). Write-mode only.
  // Called from every absorb site -- #absorbCodeBundle/#absorbResourcesBundle AND the sidecar's inlined absorb.
  #seedReasonFromBundle(bundle) {
    if (!this.config.writeBundle || bundle.reason === undefined) return
    for (const [consumer, files] of Object.entries(bundle.reason)) {
      for (const file of files) this.#recordReason(consumer, file)
    }
  }

  // Build the bundle's informational `reason` map ({ consumer: [files] }), restricted to
  // `bundledFiles`. Returned only when >1 consumer contributed. Never attested; for humans/tooling.
  #bundleReason(bundledFiles) {
    const inBundle = bundledFiles instanceof Set ? bundledFiles : new Set(bundledFiles)
    // Files some PLUGIN bundles (any consumer other than 'run'). A file run merely fs-READ post-plugin
    // that a plugin also bundles is the plugin's module, so 'run' must not claim it.
    const pluginFiles = new Set()
    for (const [who, recorded] of this.#reasonFiles) {
      if (who === 'run') continue
      for (const file of recorded) pluginFiles.add(file)
    }
    const runOverclaims = (file) =>
      this.#fsReadPostPlugin.has(file) && !this.#runImported.has(file) && pluginFiles.has(file)

    const reason = {}
    let consumers = 0
    // Sort consumer keys and each file list: the emitted JSON must be byte-reproducible regardless
    // of record order, else #emitBundle's compare-and-skip sees spurious diffs.
    for (const who of [...this.#reasonFiles.keys()].toSorted()) {
      const files = []
      for (const file of this.#reasonFiles.get(who)) {
        if (!inBundle.has(file)) continue
        if (who === 'run' && runOverclaims(file)) continue
        files.push(file)
      }
      if (files.length > 0) { reason[who] = files.toSorted(sortPaths); consumers += 1 }
    }
    return consumers > 1 ? reason : undefined
  }

  // The formats map a bundle declares -- normally `this.formats`, but drops a 'stat:*' record the
  // run's unified attestation upgraded to a real format (else the bundle fails its lockfile
  // cross-check at load). Cheap common case: no write-mode sidecars -> live map returned as-is.
  #formatsForBundle() {
    if (this.#sidecars.size === 0) return this.formats
    const merged = this.#mergedFormats()
    let out = null // copy-on-write: clone only when an entry must be dropped
    for (const [file, format] of this.formats) {
      if (isStatFormat(format) && merged.get(file) !== format) {
        if (out === null) out = new Map(this.formats)
        out.delete(file)
      }
    }
    return out ?? this.formats
  }

  get sourceBundle() {
    // One bundle holds code + resources; merge the two maps (key sets are disjoint -- code XOR
    // resource) and let `formats` tag which. Assert disjointness so an overlap fails locally, not silently.
    const contents = new Map(this.sources)
    for (const [file, content] of this.resources) {
      assert.ok(!contents.has(file), `state invariant: file ${file} in both sources and resources`)
      contents.set(file, content)
    }
    return new Bundle({
      config: this.config.values,
      entries: this.entries,
      modules: this.#bundleModules(contents),
      formats: this.#formatsForBundle(),
      imports: this.imports,
      reason: this.#bundleReason(contents.keys()),
    })
  }

  get sourceData() {
    return this.sourceBundle.serialize()
  }

  // Split-bundle counterparts to sourceBundle/sourceData (write() with config.resourcesBundleFile).
  // Metadata is partitioned: code half owns entries/imports + code formats, resources half owns
  // resource formats + bytes. Both declare per-dir module identity so each file verifies alone.
  get codeBundle() {
    // Restricting #bundleModules to this.sources yields the code-only view (addFile routes resources
    // out). Stat records ride the code half (not resource formats -> rejected by the resources half's shape check).
    const codeFormats = new Map()
    for (const [file, format] of this.#formatsForBundle()) {
      if (!Bundle.isResourceFormat(format)) codeFormats.set(file, format)
    }
    return new Bundle({
      config: this.config.values,
      entries: this.entries,
      modules: this.#bundleModules(this.sources),
      formats: codeFormats,
      imports: this.imports,
      reason: this.#bundleReason(this.sources.keys()),
    })
  }

  get resourcesBundle() {
    const resourceFormats = new Map()
    for (const [file, format] of this.formats) {
      if (Bundle.isResourceFormat(format)) resourceFormats.set(file, format)
    }
    return new Bundle({
      config: this.config.values,
      // Resources bundle carries no entries/imports (Bundle.parse waives the entries requirement when no code).
      entries: new Set(),
      modules: this.#bundleModules(this.resources),
      formats: resourceFormats,
      imports: new Map(),
      reason: this.#bundleReason(this.resources.keys()),
    })
  }

  // Record a capture-time native resolution (Module._resolveFilename shim), stored verbatim;
  // #backfillObservedResolutions decides at write() which to add. Last-write-wins per (parent, specifier).
  observeResolution(parentURL, specifier, resolvedURL) {
    let byParent = this.#observedResolutions.get(parentURL)
    if (byParent === undefined) this.#observedResolutions.set(parentURL, (byParent = new Map()))
    byParent.set(specifier, resolvedURL)
  }

  // Backfill resolution edges the live resolve hook never observed -- require.resolve()/native CJS
  // require()s that bypass it. Records under-recorded require()s (module cache hid them) and
  // resolve-only edges whose target isn't bundled (require.resolve of a never-loaded module: the
  // resolution must be attested, but its bytes are NOT seeded from the parent -- that would widen
  // trust to everything that merely resolves). Guards: skip out-of-scope targets; dedup across all
  // condition buckets. Keyed under #requireConditions so a native-resolve Node yields the same
  // lockfile on every version ('*' only when the set was never observed; wildcard fallbacks match it).
  #backfillObservedResolutions() {
    if (this.#observedResolutions.size === 0) return
    for (const [parentURL, specs] of this.#observedResolutions) {
      let parent
      try { parent = this.#canonicalFile(parentURL) } catch { continue }
      for (const [specifier, resolvedURL] of specs) {
        let file
        try { file = this.#canonicalFile(resolvedURL) } catch { continue }
        const bundled = this.sources.has(file) || this.resources.has(file)
        if (!bundled && !this.config.full && !this.inNodeModules(resolvedURL)) continue
        const spec = this.#canonicalSpecifier(parentURL, specifier)
        let recorded = false
        for (const [, byParent] of this.imports) {
          if (byParent.get(parent)?.get(spec) !== undefined) { recorded = true; break }
        }
        if (!recorded) this.addImport(parentURL, specifier, resolvedURL, { conditions: this.#requireConditions ?? '*' })
      }
    }
  }

  write() {
    // Backfill observed native resolutions BEFORE the stasis-core BFS: a resolve-only edge to a
    // stasis-core submodule is added only here, and the BFS must see it to seed the file's bytes
    // (else it ships a dangling edge a later lock=frozen replay rejects).
    this.#backfillObservedResolutions()
    this.#backfillBeforeWrite()
    // Sidecars never write the lockfile (parent owns it); they only emit their bundle. Per-artifact
    // compare-and-skip below skips brotli + writeFileSync when serialized text is unchanged (watch-mode).

    if (this.config.writeLockfile && !this.#parent) {
      const lockText = this.lockData
      if (lockText !== this.#lastLockData) {
        const lockPath = this.config.lockFile || join(this.root, FILE_LOCK)
        mkdirSync(dirname(lockPath), { recursive: true })
        writeFileSync(lockPath, lockText)
        this.#lastLockData = lockText
      }
    }
    if (this.config.writeBundle) {
      const sourcesPath = this.config.bundleFile || join(this.root, FILE_CODE)
      if (this.config.resourcesBundleFile) {
        // Split-bundle layout: code-only to bundleFile, resources-only to resourcesBundleFile.
        // hasContent (sources/resources size) gates each half so an empty half is dropped under replace.
        this.#lastCodeBundle = this.#emitBundle(
          sourcesPath, this.sources.size > 0, this.#lastCodeBundle, () => this.codeBundle.serialize())
        this.#lastResourcesBundle = this.#emitBundle(
          this.config.resourcesBundleFile, this.resources.size > 0, this.#lastResourcesBundle,
          () => this.resourcesBundle.serialize())
      } else {
        this.#lastUnifiedBundle = this.#emitBundle(
          sourcesPath, this.sources.size > 0 || this.resources.size > 0, this.#lastUnifiedBundle,
          () => this.sourceData)
      }
    }
  }

  // Lockfile-shaped snapshot of everything THIS process captured, for a forked child to hand back
  // to the root (which never loaded what only the child did). Runs write()'s backfills first.
  // Content is omitted -- the root re-reads each file's bytes from disk in mergeShard().
  shardSnapshot() {
    this.#backfillObservedResolutions()
    this.#backfillBeforeWrite()
    // Forward ONLY what THIS process observed this run (#observed), not the seeded baseline --
    // re-shipping it would bloat every worker's shard past MAX_SHARD_BYTES. modules/formats/imports
    // are all filtered to #observed below; entries are dropped (mergeShard never marks entries).
    const modules = new Map()
    for (const [dir, info] of this.modules) {
      const files = {}
      for (const rel of Object.keys(info.files)) {
        if (this.#observed.has(moduleFileKey(dir, rel))) files[rel] = info.files[rel]
      }
      if (Object.keys(files).length === 0) continue
      modules.set(dir, info.ecosystem === undefined
        ? { name: info.name, version: info.version, files }
        : { name: info.name, version: info.version, ecosystem: info.ecosystem, files })
    }
    // formats: only observed files. imports: only edges whose PARENT was observed (a child adds an
    // edge only from a file it loaded), dropping bundle-seeded edges the root already attests.
    const formats = new Map()
    for (const file of this.#observed) {
      const fmt = this.formats.get(file)
      if (fmt !== undefined) formats.set(file, fmt)
    }
    const imports = new Map()
    for (const [conditions, byParent] of this.imports) {
      let kept
      for (const [parent, specs] of byParent) {
        if (!this.#observed.has(parent)) continue
        if (kept === undefined) { kept = new Map(); imports.set(conditions, kept) }
        kept.set(parent, specs)
      }
    }
    return new Lockfile({
      config: this.config.values,
      entries: new Set(),
      modules,
      imports,
      formats,
    }).serialize()
  }

  // Merge a child's shardSnapshot() (serialized lockfile) into this State as if this process read
  // those files itself: replay each file (re-reading bytes/listings from disk to hash) and edge.
  // This is how the root attests what only a forked child observed. Best-effort: a gone/out-of-scope
  // record is skipped rather than aborting the merge.
  mergeShard(lockText) {
    const lf = Lockfile.parse(lockText)
    // A shard must describe the SAME scope as this root (defense-in-depth: cross-scope is
    // signature-rejected upstream, but a mismatch here means a malformed/foreign shard -- refuse).
    assert.equal(lf.config.scope, this.config.scope, `shard scope "${lf.config.scope}" != root scope "${this.config.scope}"`)
    // A shard carries in-root KEYS, but the root re-reads bytes/listings from ITS OWN disk, where a
    // key may resolve (through a symlink) OUTSIDE the root. Re-attesting that would pull external
    // content in under an in-root key, so every replay below re-checks real-path containment -- the
    // same boundary fs.js enforces on live --fs reads. realRoot resolved once.
    let realRoot
    const realContained = (absolute) => {
      if (realRoot === undefined) {
        try { realRoot = realpathSync(this.root) } catch { realRoot = this.root }
      }
      let real
      try { real = realpathSync(absolute) } catch { return false }
      const rel = relative(realRoot, real)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    }
    // Files first (addFile records bytes/format/identity), then edges. Merged files are NEVER marked
    // entries -- a child's "entry" is its fork-target main, not a root entry; lf.entries is ignored.
    for (const [dir, info] of lf.modules) {
      for (const rel of Object.keys(info.files)) {
        // moduleFileKey inverts the child's bucketing: yields `dir` for a dir captured AT a bucket root (rel==='').
        const file = moduleFileKey(dir, rel)
        // Skip a file the root already attests (its baseline or own capture) -- the byte re-read is
        // the dominant merge cost. EXCEPTION: fall through to carry a concrete code format the root
        // LACKS (root fs-READ a .js with no format, child IMPORTED it as `module`), else a later
        // frozen run rejects the unattested format.
        if (this.hashes.has(file)) {
          const shardFormat = lf.formats?.get(file)
          if (shardFormat === undefined || (this.formats.get(file) ?? this.#lockFormats?.get(file)) !== undefined) continue
        }
        const absolute = resolve(this.root, file)
        const url = pathToFileURL(absolute).toString()
        const format = lf.formats?.get(file)
        // Skip a key whose on-disk path escapes the root through a symlink (see realContained), so no
        // external bytes/listing are attested under an in-root key.
        if (!realContained(absolute)) continue
        try {
          if (format === 'directory') {
            // A child's readdir capture: replay as a directory listing, re-reading from disk
            // (disk-is-truth). Range-check the path FIRST so a child-forged `..` key can't make us list it.
            const relFromRoot = relative(this.root, absolute)
            if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue
            this.addFsDir(url, readdirSync(absolute))
          } else if (format === 'resource' || format === 'resource:base64') {
            // A child's asset readFileSync capture: mark resource:true and let addFile re-derive the
            // exact 'resource'/'resource:base64' tag from the re-read bytes (don't pass it, risking a mismatch).
            this.addFile(url, { resource: true })
          } else if (format === undefined) {
            // Code file the child recorded with NO format (fs-READ a .js/.ts): replay with
            // inferFormat:false so we don't bake in the commonjs default and collide with the
            // `module` the loader records if the file is later imported.
            this.addFile(url, { inferFormat: false })
          } else {
            // Code file with a concrete format the child recorded: carry it, else a child-only ESM
            // .js under a no-`type` package re-defaults to commonjs and a frozen run rejects the
            // mismatch. addFile still validates it against an explicit package.json `type`.
            this.addFile(url, { format })
          }
        } catch {
          // Gone/unreadable, or addFile-rejected (out of scope): skip, like the edge replay below.
        }
      }
    }
    // Stat records live ONLY in the shard's formats map (no module-files entry), so replay each
    // here by re-deriving the kind from DISK (a shard can't inject a forged kind). Range-check
    // BEFORE touching disk; best-effort skip on a gone/unmodelled path.
    if (lf.formats) {
      for (const [file, format] of lf.formats) {
        if (!isStatFormat(format)) continue
        const absolute = resolve(this.root, file)
        const relFromRoot = relative(this.root, absolute)
        if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue
        try {
          // statSync (follow symlinks), NOT lstatSync: the child's capture followed them, so statSync
          // reproduces the kind a legitimate shard carries where lstatSync would report the link and drop it.
          const stats = statSync(absolute)
          const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null
          if (kind === null) continue
          // statSync follows links, so re-assert real-path containment (see realContained): a symlink
          // pointing OUT must not attest an external kind under an in-root key.
          if (!realContained(absolute)) continue
          this.addFsStat(pathToFileURL(absolute).toString(), kind)
        } catch {
          // Gone/dangling, or a kind conflict with the root's capture: skip.
        }
      }
    }
    if (lf.imports) {
      for (const [conditions, byParent] of lf.imports) {
        // Reverse #conditionsKey: '*' stays '*'; else a ', '-joined list, optionally ' (with: {json})'
        // for import attributes -- parse when present so attributed edges merge under the child's key.
        let condStr = conditions
        let importAttributes
        const withAt = conditions.indexOf(' (with: ')
        if (withAt !== -1) {
          condStr = conditions.slice(0, withAt)
          try { importAttributes = JSON.parse(conditions.slice(withAt + ' (with: '.length, -1)) } catch { /* leave undefined */ }
        }
        const cond = condStr === '*' ? '*' : condStr.split(', ')
        for (const [parent, specs] of byParent) {
          const parentURL = pathToFileURL(resolve(this.root, parent)).toString()
          for (const [specifier, file] of specs) {
            const url = pathToFileURL(resolve(this.root, file)).toString()
            try {
              this.addImport(parentURL, specifier, url, { conditions: cond, importAttributes })
            } catch {
              // Same best-effort stance as addFile above.
            }
          }
        }
      }
    }
  }

  // Emit one bundle artifact, returning its new "last serialized" cache. Empty under bundle=replace:
  // DELETE the file (a replace run is authoritative; don't leave a stale bundle) and reset the cache.
  // Otherwise serialize and write, skipping brotli + writeFileSync when byte-identical to the last write.
  #emitBundle(path, hasContent, lastText, serialize) {
    if (!hasContent && this.config.replaceBundle) {
      rmSync(path, { force: true })
      return null
    }
    const text = serialize()
    if (text !== lastText) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, brotliCompressSync(text, brotliOptions(this.config.brotliQuality)))
      return text
    }
    return lastText
  }

  get parent() {
    return this.#parent
  }

  // Capture stasis-core's own files + internal edges the live hooks missed: a preload-cached
  // stasis-core module is imported after Node cached it (before our hooks), so the resolve hook
  // records the edge but the load hook never fires. This BFS, scoped to the stasis-core src shape,
  // walks the graph from missing targets + captured files, addFile'ing and addImport'ing each edge.
  #backfillBeforeWrite() {
    // List what the live hooks missed; empty means nothing to do (the common case).
    const missing = this.#collectMissingImportedFiles()
    if (missing.size === 0) return

    const isStasisCoreFile = (file) => STASIS_CORE_FILE_RE.test(`/${file}`)

    // Split the uncaptured targets: stasis-core's preload-cached files are reconstructed (bytes +
    // transitive edges, the BFS below). Everything else is a resolution attested WITHOUT bundling
    // (require.resolve of a never-loaded module, a .node addon) -- the load-time getFile gate, not
    // this pass, enforces the trust boundary.
    const stasisCoreMissing = [...missing].filter((file) => isStasisCoreFile(file))
    if (stasisCoreMissing.length === 0) return

    const preloadRel = this.#preloadRoot ? relative(this.root, this.#preloadRoot) : null
    const canBackfill = preloadRel !== null && !preloadRel.startsWith('..')

    // No usable preloadRoot but uncaptured stasis-core sources exist -- a real gap (missing runtime); fail loud.
    assert.ok(canBackfill,
      `state.write() has imports referencing un-captured stasis-core files but no usable preloadRoot ` +
      `(preloadRoot=${this.#preloadRoot ?? 'unset'}). The live load hook missed an in-scope target -- ` +
      `investigate rather than silently patch: ${stasisCoreMissing.slice(0, 3).join(', ')}`)

    const PRELOAD_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons']
    const stasisAddFile = (file) => {
      // Every backfilled file MUST match the stasis-core source-file shape (asserted here to keep the contract local).
      assert.ok(isStasisCoreFile(file),
        `state.write() backfill refused: '${file}' is not a stasis-core source file ` +
        `(expected '.../@exodus/stasis-core/src/<name>.js')`)
      this.addFile(pathToFileURL(resolve(this.root, file)).toString(), { reason: null }) // backfill is a write-time self-containment step, not a consumer observation -- don't attribute it
    }

    // BFS through stasis-core's module graph, seeded from the missing files + every stasis-core
    // file already in sources (walk their transitive imports too). For each: addFile if uncaptured,
    // scan for relative-`.js` specifiers, addImport each edge, queue the target. `processed` dedups.
    const queue = [...stasisCoreMissing]
    for (const file of this.sources.keys()) {
      if (isStasisCoreFile(file)) queue.push(file)
    }

    const processed = new Set()
    while (queue.length > 0) {
      const file = queue.shift()
      if (processed.has(file)) continue
      processed.add(file)
      if (!this.sources.has(file) && !this.resources.has(file)) stasisAddFile(file)
      const source = this.sources.get(file)
      if (typeof source !== 'string') continue
      const baseURL = pathToFileURL(resolve(this.root, file)).toString()
      const recordEdge = (specifier) => {
        const targetURL = new URL(specifier, baseURL).toString()
        const targetAbsolute = fileURLToPath(targetURL)
        let targetFile
        try { targetFile = this.relative(targetAbsolute) } catch { return }
        if (!isStasisCoreFile(targetFile)) return
        if (!existsSync(targetAbsolute)) return
        queue.push(targetFile)
        this.addImport(baseURL, specifier, targetURL, { conditions: PRELOAD_CONDITIONS })
      }
      // (1) ESM `from './<name>.js'|'.cjs'\n` -- stasis-core's source import shape, tight enough to
      // ignore JSDoc/template-literal false positives. The `.cjs` arm covers state.js -> ./package.cjs.
      for (const m of source.matchAll(/ from '(\.\/[a-zA-Z-]+\.c?js)'\n/g)) recordEdge(m[1])
      // (2) CJS `require('../package.json')` -- the src/package.cjs version shim, matched exactly (tight as the ESM arm).
      for (const m of source.matchAll(/require\('(\.\.\/package\.json)'\)/g)) recordEdge(m[1])
    }
  }

  // Project-relative files referenced by this.imports but not captured into sources/resources,
  // restricted to the in-scope set (full: under state.root; nm: only node_modules). Out-of-scope
  // files are excluded (the live hooks correctly skip them).
  #collectMissingImportedFiles() {
    const missing = new Set()
    for (const [, byParent] of this.imports) {
      for (const [, specifiers] of byParent) {
        for (const [, file] of specifiers) {
          if (typeof file !== 'string') continue
          if (missing.has(file)) continue
          // "Captured" = hashes (addFile ran) OR sources/resources (bundle pre-seeded); a file in NONE is missing.
          if (this.hashes.has(file) || this.sources.has(file) || this.resources.has(file)) continue
          const url = pathToFileURL(resolve(this.root, file)).toString()
          if (!this.config.full && !this.inNodeModules(url)) continue
          missing.add(file)
        }
      }
    }
    return missing
  }
}

// Allowed shape for a backfillable stasis-core path -- a `src/<name>.js`/`.cjs` source or the
// package's own `package.json` (the version shim). Anchored against `/${file}` so a project-root
// file ending in `@exodus/stasis-core/...` isn't matched. Basenames are `[a-zA-Z-]+` (no `.`).
const STASIS_CORE_FILE_RE = /\/@exodus\/stasis-core\/(?:src\/[a-zA-Z-]+\.c?js|package\.json)$/

