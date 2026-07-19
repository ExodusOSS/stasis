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
import { CODE_EXTENSIONS, classifyFormat, fileMapToObject, isStatFormat, moduleFileKey, objectToMaps, pathExt, reconcileFormat, sortPaths, splitNodeModulesPath } from './util.js'
import corePackage from './package.cjs'

// Destructure off the namespace, not `import { ... } from 'node:fs'`: the const
// captures function values at eval time, so stasis keeps writing through the real fs
// even after --mock calls syncBuiltinESMExports() to remock node:fs for user code.
// Direct ESM imports are live bindings and would re-resolve to the mocked names when
// state.write() fires on beforeExit.
const { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } = fs

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'

function readPackageJSON(pkgAbsolute) {
  const buf = readFileSync(pkgAbsolute)
  assert.ok(isUtf8(buf))
  return JSON.parse(buf.toString())
}

// This copy's own version, via src/package.cjs (a CommonJS re-export of package.json --
// bundler-safe, unlike a runtime fs read or `import ... with`). A sidecar State must
// EXACTLY match its parent's version (enforced in the constructor's parent branch): it
// shares the parent's maps by reference, so a version skew between two stasis-core copies
// in one process would be unsound.
const VERSION = corePackage.version

// Set `format` for `file` via the shared reconcileFormat rule (util.js): a weak 'stat:*' record
// yields to a real format of the same kind and never displaces one; two real formats, a stat kind
// flip, or a stat-vs-real kind mismatch are fatal. #mergedFormats applies the same rule.
function upsertFormat(map, file, format) {
  const currentFormat = map.get(file)
  map.set(file, currentFormat === undefined ? format : reconcileFormat(format, currentFormat, file))
}

// TODO: stricter format validation

// Process-wide registry of every live State, kept on globalThis so it is shared across
// duplicate stasis-core copies in one process (a `Symbol.for` key reaches the same Set
// across copies). Two roles:
//   - the preload (top-level) State is the unique member flagged isPreload, found by
//     State.preload; constructing a second preload (from ANY copy) is rejected, so the
//     "one top-level state" invariant holds process-wide; and
//   - #claimWritePath scans every member's claimed paths, so no two live States write the
//     same lockfile/bundle path -- across copies, and whether or not a preload exists.
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

  // True iff this is THE preload (top-level) State. Exposed via `get isPreload()` so
  // State.preload can find the unique flagged member of the global registry across copies.
  #isPreload = false

  // This State's claimed write-target paths (canonicalized -> label), for cross-State
  // collision detection. Exposed via `claimedWritePathLabel()` so the global scan in
  // #claimWritePath can consult States from other stasis-core copies.
  #claims = new Map()

  // For a parent: WRITE-mode sidecar States -- the lockfile CONTRIBUTORS. The unified
  // lockfile (parent's lockData via #mergedImports/#mergedFormats) must union the parent's
  // imports/formats with every sidecar's, else resolution edges and format attestations a
  // sidecar bundler-plugin observed into its sidecar-local maps never reach the lockfile.
  // Hashes/entries/modules are already shared by reference; this closes the same gap for
  // imports and formats. Also the set attestedBySidecar consults, so --fs skips
  // re-capturing a read the bundler plugin already records here. Unused on sidecars.
  #sidecars = new Set()

  // For a parent: LOAD-mode sidecar States -- read-only family members, NOT lockfile
  // contributors. A load-mode sidecar carries the module graph in its bundle; getFs*Family
  // consults this set so a --fs read at load of a graph file it carries is served from it
  // (symmetric counterpart to the #sidecars capture-skip). Kept separate from #sidecars so
  // these never enter #mergedImports/#mergedFormats -- a load-mode sidecar contributes no
  // resolution edges or formats (the lockfile's trust-bearing content) to the unified
  // lockfile (see the constructor and registerReadSidecar).
  #readSidecars = new Set()

  // Resolutions attested by the loaded lockfile (conditions -> parent -> specifier -> file),
  // or null when none was loaded / it predates resolution attestation. Kept separate from
  // this.imports (the live observed/bundle-served map): the lockfile may attest a superset of
  // what a run observes or a bundle carries.
  #lockImports = null

  // Loader formats attested by the loaded lockfile (file -> format), or null
  // when none was loaded / it predates format attestation. Like #lockImports,
  // kept apart from this.formats (the live observed/bundle-served map).
  #lockFormats = null

  // True iff this State (or, for a sidecar, its parent) loaded a lockfile at construction.
  // Drives #mergeBundleMetadata's cross-check-vs-absorb branch: with a lockfile the
  // bundle's metadata must agree with the lockfile's attestations; without one it is
  // absorbed as the source of truth. Sidecars inherit it so a sidecar bundle is
  // cross-checked against the parent's lockfile rather than silently trusted.
  #lockfileLoaded = false

  // Project-relative keys THIS process recorded via addFile/addFsDir this run (not the
  // lockfile baseline seeded at construction). shardSnapshot() forwards only these, so a
  // forked child's shard carries what it observed -- not a re-ship of the seeded lockfile.
  #observed = new Set()
  // file -> set of consumers that recorded it, for the bundle's informational `reason`
  // field. Keyed by consumer ('run' for the loader/CLI; a plugin label like 'StasisMetro').
  // Populated only when bundling. See #recordReason / #bundleReason.
  #reasonFiles = new Map()
  // Supporting state so the bundle `reason` map's "run" entry stays accurate (see
  // #bundleReason): files run loaded as a MODULE (#runImported), files run merely fs-READ
  // after a plugin attached (#fsReadPostPlugin), and whether a plugin has attached.
  #runImported = new Set()
  #fsReadPostPlugin = new Set()
  #pluginAttached = false

  // Files, resolutions, and formats attested by a frozen bundle (bundle=frozen), or null
  // when none was loaded. A frozen bundle plays the read-only attestation role a frozen
  // lockfile does, but anchored in the bundle's own bytes -- so it needs no sibling
  // lockfile. The byte check itself is the noupsert of observed disk content into
  // this.sources/this.resources (pre-seeded from the bundle); these sets/maps close the
  // attested set so a file/resolution/format the bundle never recorded is rejected. Kept
  // separate from the live this.sources/this.imports/this.formats, which addFile/addImport
  // mutate.
  #bundleSources = null
  #bundleResources = null
  #bundleImports = null
  #bundleFormats = null

  // Lazily-built set of directory paths IMPLIED by the bundle's recorded entries: a
  // recorded `node_modules/dep/index.js` proves `node_modules` and `node_modules/dep`
  // exist as directories even though neither was readdir'd. getFsStat consults it so
  // `fs.statSync('node_modules').isDirectory()` succeeds at bundle=load. Built once in
  // load mode, where this.imports/this.sources are immutable after construction.
  #impliedDirIndex = null

  // Capture-time native resolutions (parent URL -> specifier -> resolved URL) observed via
  // the Module._resolveFilename shim: require.resolve() and any CJS require() bypassing the
  // resolve hook. write()'s backfill records the edges the hook missed. Capture only.
  #observedResolutions = new Map()

  // Node's require-condition set (e.g. ['require', 'node', 'node-addons', 'module-sync'],
  // plus any --conditions), captured the first time addImport sees a require()-context
  // edge. require()/require.resolve() resolve under THESE conditions (they honor the
  // `require` branch of conditional `exports`), so #backfillObservedResolutions keys the
  // native (Module._resolveFilename) edges it recovers under this set rather than '*'. That
  // matches what the resolve hook records directly on newer Node, so any capture doing at
  // least one require() yields the same lockfile on every version. null until observed -- a
  // capture that ONLY require.resolve()s falls back to '*', which the getImport/
  // resolveBundled wildcard fallbacks still match.
  #requireConditions = null

  // Absolute path of a package whose source files Node loaded BEFORE our hooks registered
  // (the preload-cached set). Set by the loader's initState to stasis-core's own root;
  // sidecars inherit it so plugin-driven write()s also backfill internal edges. write()'s
  // backfill statically parses each file under this root and addImports its relative-
  // specifier edges -- recovering the (state.js -> config.js)-shape edges the live resolve
  // hook never observed.
  #preloadRoot = null

  // Per-artifact "last serialized" caches: write() compares each output's fresh JSON text
  // against the cached one (lockfile / unified bundle / split code / split resources) and
  // skips both brotli and the writeFileSync when they match. Brotli dominates write cost,
  // and watch-mode rebuilds call write() on every rebuild whether or not the graph changed
  // -- this makes those no-ops fast. Persistent across write() calls; null on the first.
  #lastLockData = null
  #lastUnifiedBundle = null
  #lastCodeBundle = null
  #lastResourcesBundle = null

  // Options:
  //   preload (boolean) -- register as the unique preload State (exposed via State.preload).
  //     Only one may exist at a time. The stasis loader is the only real caller.
  //   parent (State)    -- run as a sidecar of this parent. Shares the parent's
  //     hashes/entries/modules (so addFile updates the unified lockfile through them) but
  //     manages its own sources/formats/imports/resources and emits its own bundle file.
  //     write() on a sidecar skips the lockfile (parent owns it) and only writes its bundle.
  //   All other keys forward to Config.
  constructor(root, options = {}) {
    // skipDiscovery: build a caller-populated, in-memory State with NO filesystem discovery -- root is the passed `root`, and the maps are filled in by the caller (no package.json walk, no on-disk config/lockfile/bundle reads). For artifact-driven tooling like `stasis build`, which serves a parsed bundle (or an in-memory-verified lockfile) and must not depend on a project's stasis.config.json or read a stray stasis.code.br. Read-only (load/ignore) modes only.
    const { preload: isPreload = false, parent: parentState, preloadRoot, skipDiscovery = false, ...configOptions } = options
    this.config = new Config(configOptions)
    if (isPreload) assert.ok(!State.preload, 'Only one preload Stasis instance is supported')
    assert.ok(!(isPreload && parentState), 'preload and parent are mutually exclusive')
    this.#isPreload = isPreload

    if (parentState) {
      // A sidecar shares the parent's maps by reference and inherits its lockfile
      // attestation, so the parent MUST be the exact same stasis-core VERSION -- but need
      // NOT be the same module copy. A bundle carrying its OWN stasis-core (e.g. a webpack
      // script + StasisWebpack under `stasis run --bundle=load`) has the plugin's copy
      // coordinate with the outer loader's preload across the class brand. Everything the
      // sidecar reads goes through the parent's PUBLIC surface (`version`,
      // `sidecarInheritance`, `registerSidecar`, the shared maps), never a private field a
      // foreign class brand would deny; the exact-version match makes that sound. A version
      // skew is unsound -- reject it with a clear error.
      assert.equal(parentState.version, VERSION,
        `child State version '${VERSION}' must exactly match parent version '${parentState.version}'`)
      // Sidecar mode: short-circuit the on-disk discovery path. Lockfile data is shared by
      // reference with the parent; only the sidecar's bundleFile (if any) is parsed here.
      this.#parent = parentState
      this.root = parentState.root
      this.hashes = parentState.hashes
      this.entries = parentState.entries
      this.modules = parentState.modules
      // Inherit via the parent's public sidecarInheritance() so it works across copies:
      //  - preloadRoot, so plugin-driven write()s backfill stasis-core's internal edges the
      //    same way the parent does;
      //  - the lockfile attestation maps, so #mergeBundleMetadata cross-checks the sidecar
      //    bundle against the same attestation the parent loaded -- without this a tampered
      //    sidecar bundle could redirect a resolution or flip a format for hash-valid bytes,
      //    which the byte check alone misses.
      const inherited = parentState.sidecarInheritance()
      this.#preloadRoot = inherited.preloadRoot
      this.#lockImports = inherited.lockImports
      this.#lockFormats = inherited.lockFormats
      this.#lockfileLoaded = inherited.lockfileLoaded
      assert.ok(this.config.bundleFile, 'sidecar State requires bundleFile')
      // Claim the bundleFile (and resourcesBundleFile under the split layout) against the
      // process-wide registry so two write-intent States anywhere can't silently target the
      // same on-disk file (last-write-wins on `beforeExit`). Only writing States claim;
      // read-only modes may legitimately share a path with the writer that produced the
      // file. Config's own pairwise check (#checkInvariants) already rejects intra-State
      // collisions, so #claimWritePath only fires cross-State.
      if (this.config.writeBundle) {
        this.#claimWritePath(`sidecar bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
        if (this.config.resourcesBundleFile) {
          this.#claimWritePath(`sidecar resourcesBundleFile '${this.config.resourcesBundleFile}'`,
            this.config.resourcesBundleFile)
        }
      }
      // frozenBundle MUST go through this branch alongside write/load -- it has its own
      // attestation snapshot to build, and was previously missed (silently skipping parsing
      // made the post-construction frozen-bundle invariant unreachable on the sidecar path).
      if (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) {
        const sourcesPath = this.config.bundleFile
        const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
        if (sources && !this.config.replaceBundle) {
          const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
          // Same v0 refusal as the main load path: a v0 bundle has no per-file formats
          // and no import map, so serving/verifying one through a sidecar widens trust.
          assert.equal(bundle.version, Bundle.VERSION,
            `stasis sidecar requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
            `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point.`)
          assert.equal(bundle.config.scope, this.config.scope)
          // Cross-check the sidecar bundle's metadata against the parent's lockfile (or
          // absorb if none was loaded). hashes/entries/modules are shared with the parent,
          // so #mergeBundleMetadata's writes (no-lockfile case) propagate into the unified
          // attestation.
          this.#mergeBundleMetadata(bundle, { lockfileLoaded: this.#lockfileLoaded })
          for (const [file, content] of bundle.sources) {
            if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
            else this.sources.set(file, content)
          }
          this.formats = bundle.formats
          this.imports = bundle.imports
          if (this.config.frozenBundle) {
            // Same snapshot the main path takes -- closes the attested set so
            // addFile/addImport reject anything the bundle didn't carry.
            this.#bundleSources = new Set(this.sources.keys())
            this.#bundleResources = new Set(this.resources.keys())
            this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
            this.#bundleFormats = new Map(bundle.formats)
          }
        }

        // Sidecar split-bundle: same shape as the main path's resources-side load.
        if (this.config.resourcesBundleFile) {
          const resourcesPath = this.config.resourcesBundleFile
          const resourcesData = readFileSyncMaybe(dirname(resourcesPath), basename(resourcesPath))
          if (resourcesData && !this.config.replaceBundle) {
            this.#absorbResourcesBundle(resourcesData, { lockfileLoaded: this.#lockfileLoaded, resourcesPath })
          }
        }
      }
      // Mirror the post-discovery invariant from the main path: frozen modes must
      // have actually loaded their attestation, otherwise the run would fail open.
      if (this.config.frozenBundle) {
        assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')
      }
      // Register with the parent AFTER every fallible step (v0 refusal, scope
      // equality, #mergeBundleMetadata cross-check, frozenBundle invariant) so a
      // throw never leaves a dead reference in the parent's registries.
      // Write-mode sidecars are lockfile CONTRIBUTORS -- their addImport / addFile
      // observations have to land in the unified lockfile, otherwise a `lock=frozen`
      // re-run rejects them as unattested -- so they join #sidecars (which feeds
      // #mergedImports/#mergedFormats and attestedBySidecar). Load-mode sidecars are
      // CONSUMERS: they must NOT contribute to the parent's lockfile (the bundle has
      // its own integrity story, and under `lock=add` with no prior lockfile a
      // load-mode sidecar would otherwise silently make the bundle's content the
      // lockfile's source of truth), but they DO carry bundle bytes that --fs serves at
      // load, so they join the read-only #readSidecars (consulted by getFs*Family only).
      // Frozen sidecars join neither: --fs neither captures nor serves in frozen-bundle
      // mode (fs.js gates capture on writeBundle and serve on loadBundle), and their
      // lockfile cross-check already happened in #mergeBundleMetadata above.
      if (this.config.writeBundle) parentState.registerSidecar(this)
      else if (this.config.loadBundle) parentState.registerReadSidecar(this)
      liveStates().add(this)
      return
    }

    // skipDiscovery (see the constructor comment): a caller-populated, in-memory State.
    // Skip filesystem discovery -- anchor at the given root, read nothing, let the caller
    // fill in the maps. Only sound for read-only load/ignore modes: there is no on-disk
    // attestation to load or verify, so frozen modes are rejected.
    if (skipDiscovery) {
      // Read-only by contract: no on-disk baseline, so neither frozen verification (nothing
      // to verify against) nor write modes (nothing discovered to write) are meaningful.
      // `stasis build` uses bundle:'load', lock:'ignore'.
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

    // liveStates() registration happens after construction succeeds so a throw in setup
    // can't leave a half-built (and, for a preload, singleton-claiming) State behind.
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

    let loaded = false
    let lockfileLoaded = false
    // When `config.lockFile` is set, the lockfile lives at that explicit path, not at
    // join(rootDir, FILE_LOCK). Suppress the per-rootDir read for root-detection (so a
    // stale project-root stasis.lock.json can't shadow the explicit one), then substitute
    // the explicit content once root-detection commits to a rootDir below.
    const explicitLockPath = this.config.lockFile
    // A construction-time `bundleFile` (--bundle-file flag or EXODUS_STASIS_BUNDLE_FILE) is
    // rootDir-INDEPENDENT: reading it yields the same file at every candidate root. So, like
    // explicitLockPath, it must NOT act as a per-rootDir root-detection signal -- if it did,
    // the innermost package.json dir would win, diverging load's root from the (outer) root
    // the bundle was captured with. Since every bundle key is stored relative to the capture
    // root, that divergence makes every bundled dependency unreachable at load (the load hook
    // throws "outside project root" / "not attested", or Node's ESM->CJS translator hits
    // native disk resolution for a pruned/never-shipped file: `Cannot find module`). Root is
    // instead chosen from rootDir-DEPENDENT signals (stasis.config.json, the default
    // lockfile/bundle at the dir), then the explicit bundle is loaded at the committed root
    // -- or, when nothing committed, at the outermost root post-loop (like explicitLockPath).
    // A `bundleFile` coming only from stasis.config.json is NOT suppressed: it lives at a dir
    // already carrying the config signal, so it selects that dir at capture and load alike.
    const explicitBundlePath = this.config.bundleFile
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, FILE_CONFIG, 'utf-8')
      const lockProbe = explicitLockPath ? null : readFileSyncMaybe(rootDir, FILE_LOCK, 'utf-8')
      // Read the bundle at the construction-time bundleFile or, absent that, the default
      // <rootDir>/stasis.code.br -- used to LOAD the bundle once a root is committed. The
      // authoritative path can still change when loadConfig() applies a config `bundleFile`,
      // so it's re-read below.
      let sourcesPath = this.config.bundleFile || join(rootDir, FILE_CODE)
      let sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
      // Root-SELECTION signal: only the DEFAULT <rootDir>/stasis.code.br counts. An explicit
      // bundleFile is suppressed here (see explicitBundlePath above) so it can't bias
      // selection to the innermost dir; it is still loaded via `sources` once committed.
      const bundleProbe = explicitBundlePath ? null : sources
      if (config !== null || lockProbe !== null || bundleProbe !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = rootDir

        if (config) {
          this.config.loadConfig(config)
          // stasis.config.json may set `bundleFile`, which the probe above couldn't see.
          // Re-resolve against the now-authoritative config and re-read, so a config-only
          // bundleFile is honored for load/frozen (the write side already resolves it after
          // loadConfig). Mirrors the naturally-post-loadConfig resourcesBundleFile read below.
          const configuredPath = this.config.bundleFile || join(rootDir, FILE_CODE)
          if (configuredPath !== sourcesPath) {
            sourcesPath = configuredPath
            sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
          }
        }

        // Resolve the effective lockfile content + path. With an explicit `config.lockFile`
        // the lockfile is at that exact path; without one, fall back to
        // `<rootDir>/stasis.lock.json`.
        const lock = explicitLockPath
          ? readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
          : lockProbe
        const lockPath = explicitLockPath || join(rootDir, FILE_LOCK)

        lockfileLoaded = this.#absorbLockfile(lock, lockPath)
        this.#loadBundleArtifacts(sources, sourcesPath, lockfileLoaded)

        // The innermost matching rootDir is authoritative (per-dir opt-in), so stop scanning
        // once committed. An explicit/config `bundleFile` is rootDir-independent: without this
        // break an outer candidate root re-detects the SAME bundle at its own probe and trips
        // the `loaded` guard above -- which crashed bundle=load/frozen in any nested-package
        // (monorepo) layout where a leaf package sits under an ancestor with a package.json.
        break
      }
    }

    // Explicit lockfile path with no other discovery indicator at any rootDir: the loop
    // never set `loaded`, so the lockfile branch above never ran. Process it here against
    // the already-resolved `this.root` (outermost package.json) so the run still has its
    // attestation.
    if (!loaded && explicitLockPath) {
      const lock = readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
      lockfileLoaded = this.#absorbLockfile(lock, explicitLockPath)
    }

    // Explicit (flag/env) bundleFile and/or resourcesBundleFile with no rootDir-dependent
    // indicator: like the explicit lockfile above, it was suppressed as a root-detection
    // signal, so the loop never loaded it. Load it here against `this.root` (the outermost
    // package.json -- the root capture commits to when no signal exists) so its
    // capture-root-relative keys line up with the lookups. `resourcesBundleFile` is in the
    // gate for the resources-only split shape (see #absorbResourcesBundle): with no code
    // bundle on disk there's no other reason to reach here, yet the explicit resources half
    // must still be absorbed. Both paths are necessarily flag/env post-loop -- a config
    // could only set them by also committing the loop.
    //
    // NB: the outermost root depends on where the upward walk stopped (PROJECT_CWD, .git,
    // pnpm-workspace.yaml). Capture and load must agree on that boundary for keys to line up:
    // a capture under yarn (PROJECT_CWD = an inner workspace dir) and a bare load of the same
    // bundle (walks up to .git) commit different roots and fail "outside the project root".
    if (!loaded && (explicitBundlePath || this.config.resourcesBundleFile)) {
      const sources = explicitBundlePath
        ? readFileSyncMaybe(dirname(explicitBundlePath), basename(explicitBundlePath))
        : null
      this.#loadBundleArtifacts(sources, explicitBundlePath, lockfileLoaded)
    }

    // Frozen modes must have actually loaded their attestation. Asserting here, after the
    // loop, rather than only inside it closes a fail-open: with no stasis files on disk the
    // loop body never runs, and in node_modules scope the workspace entry sits outside the
    // attested zone (bytes/format/resolutions unchecked), letting it execute unverified. A
    // frozen run with nothing to verify against must fail closed instead.
    if (this.config.frozen) assert.ok(lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
    if (this.config.frozenBundle) assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')

    // Claim this State's write targets against the process-wide registry, so a sidecar or
    // an independent top-level State -- in this or another stasis-core copy -- can't
    // silently target the same on-disk file. Load/frozen/no-bundle modes don't claim (they
    // legitimately read what a previous writer produced). lockFile is claimed only by
    // writing top-level States -- sidecars don't write it, and the explicit path may
    // legitimately point at the parent's under unification. liveStates() registration
    // happens below, after every fallible step, so a throw never leaves a dead member.
    if (this.config.writeBundle && this.config.bundleFile) {
      this.#claimWritePath(`bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
    }
    if (this.config.writeBundle && this.config.resourcesBundleFile) {
      this.#claimWritePath(`resourcesBundleFile '${this.config.resourcesBundleFile}'`, this.config.resourcesBundleFile)
    }
    if (this.config.writeLockfile && this.config.lockFile) {
      this.#claimWritePath(`lockFile '${this.config.lockFile}'`, this.config.lockFile)
    }

    // preloadRoot is opt-in -- only the runtime loader (hooks.js's initState) sets it,
    // pointing at stasis-core's own package root. Plain top-level States (CLI / direct API)
    // leave it null and skip the internal-edges backfill entirely.
    if (preloadRoot !== undefined) {
      assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
      this.#preloadRoot = preloadRoot
    }

    liveStates().add(this)
  }

  // Absorb a lockfile's attestation into this State: the run-scope module/hash maps, the
  // imports/formats attestation, and the frozen-mode warnings for lockfiles predating those
  // attestations. Shared by the discovery loop and the post-loop fallback for an explicit
  // `config.lockFile`. Returns whether the lockfile was actually absorbed (the caller's
  // `lockfileLoaded`).
  #absorbLockfile(lock, lockPath) {
    if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
      throw new Error(`Unexpected ${lockPath} with config.lock = 'none'`)
    }
    if (!lock || !this.config.useLockfile || this.config.replaceLockfile) return false
    const lockfile = Lockfile.parse(lock)
    if (this.config.frozen) assert.equal(lockfile.config.scope, this.config.scope)

    const includeSources = lockfile.config.scope === 'full' && this.config.full
    for (const [dir, info] of lockfile.modules) {
      if (!dir.includes('node_modules') && !includeSources) continue
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
    // Frozen promises verification, but a lockfile predating resolution or format
    // attestation can only vouch for bytes -- that metadata (from a bundle or observed on
    // disk) goes unchecked until the lockfile is regenerated.
    if (this.config.frozen && this.#lockImports === null) {
      console.warn('[stasis] Warning: lockfile does not attest resolutions; they are trusted as-is. Regenerate the lockfile to enable this check.')
    }
    if (this.config.frozen && this.#lockFormats === null) {
      console.warn('[stasis] Warning: lockfile does not attest formats; they are trusted as-is. Regenerate the lockfile to enable this check.')
    }
    this.#lockfileLoaded = true
    return true
  }

  // Gate and load the bundle artifacts for an already-committed root: the unified
  // code[+resource] bundle from `sourcesPath`, plus the split `resourcesBundleFile` when
  // configured. Shared by the discovery loop and the post-loop explicit-path fallback so the
  // mode guards can't drift. `sources` may be null (no bundle on disk, or a resources-only
  // deployment), in which case only the resources half applies.
  //
  // The missing-lockfile guard tests `lockfileLoaded` (equivalent to raw lockfile presence
  // here: whenever it can fire, #absorbLockfile absorbed the lockfile iff it existed).
  #loadBundleArtifacts(sources, sourcesPath, lockfileLoaded) {
    if (sources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle && !this.config.frozenBundle) {
      throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
    }
    // A frozen bundle is self-attesting -- it verifies disk against its own bytes, so
    // (unlike load/add) it needs no sibling lockfile and is exempt from this "a lockfile is
    // required before a bundle's sources can be trusted" guard. This lets bundle=frozen
    // compose with lock=add (bootstrapping a fresh lockfile from the verified run).
    if (sources && !lockfileLoaded && this.config.useLockfile && !this.config.replaceLockfile && !this.config.frozenBundle) {
      throw new Error('stasis.lock.json missing, can not use sources')
    }
    if (sources && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
      this.#absorbCodeBundle(sources, sourcesPath, lockfileLoaded)
    }
    // Split-bundle layout: with `resourcesBundleFile` configured, resources live in a
    // separate file. Load it as a standalone Bundle (empty entries/imports, resource-tag
    // formats only) and union into the state already absorbed from `bundleFile`. The
    // strict-shape asserts catch a writer that leaked code into the resources file or a
    // tampered file claiming entries/imports it shouldn't have.
    if (this.config.resourcesBundleFile) {
      const resourcesPath = this.config.resourcesBundleFile
      const resourcesData = readFileSyncMaybe(dirname(resourcesPath), basename(resourcesPath))
      if (resourcesData && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
        this.#absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath })
      }
    }
  }

  // Absorb a unified code+resource bundle's metadata and payloads into this State. Shared by
  // the discovery loop and the post-loop explicit-bundleFile fallback.
  #absorbCodeBundle(sources, sourcesPath, lockfileLoaded) {
    // One unified bundle carries both code and resources. Split the flat file view into
    // this.sources (code) and this.resources (resource payloads -- raw UTF-8 for 'resource',
    // base64 for 'resource:base64') by format.
    const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
    // `Bundle.parse` accepts v0 for offline tooling (`stasis extract`, `diff`, `audit`,
    // `sbom`). The runtime path is stricter: a v0 bundle has no per-file `formats`
    // attestation (resources indistinguishable from code, loader can't pick
    // module-vs-commonjs) and no import map (resolution edges unchecked), so serving/
    // verifying one under `stasis run` would widen the trust boundary. Refuse it and point
    // at the upgrade path.
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis (\`stasis bundle\`) or \`stasis run --bundle=replace\` ` +
      `against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    for (const [file, content] of bundle.sources) {
      if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
      else this.sources.set(file, content)
    }
    this.formats = bundle.formats
    this.imports = bundle.imports
    if (this.config.frozenBundle) {
      // Snapshot the attested sets before addFile/addImport mutate the live maps. imports is
      // deep-cloned (this.imports shares bundle.imports's nested Maps, which addImport
      // extends); formats is a flat file->string map, so a shallow copy suffices. Code and
      // resource file sets are tracked separately to match addFile's per-kind check.
      this.#bundleSources = new Set(this.sources.keys())
      this.#bundleResources = new Set(this.resources.keys())
      this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
      this.#bundleFormats = new Map(bundle.formats)
    }
  }

  // Cross-check bundle metadata (entries/modules) against the loaded lockfile, or absorb it
  // as the source of truth when no lockfile is present. v0 bundles infer `name` from path
  // for node_modules buckets but carry no version; the workspace "." bucket has no inferable
  // name. We skip entries we can't cross-check (no name with lockfile, or no version when
  // populating state.modules -- addFile later asserts strict name+version equality against
  // disk's package.json, which would clash with a null stashed earlier). NB: the v0
  // path-inferred name disagrees with the lockfile for an aliased dep (`foo: npm:bar`); the
  // strict equality below then fails, which is right -- v0 can't attest the real identity,
  // so we refuse to silently mismatch.
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
      // Resolutions: every edge the bundle could serve must land on the file the lockfile
      // attests for that (parent, specifier). Source hashes alone don't close this: a
      // tampered bundle could redirect a specifier to a *different* hash-valid file. Unknown
      // edges are fatal; the lockfile may attest a superset (as with the file lists above).
      // Lockfiles predating resolution attestation (imports === null) skip the check --
      // regenerate with lock=replace.
      if (this.#lockImports !== null) {
        for (const [conditions, byParent] of bundle.imports) {
          for (const [parent, specifiers] of byParent) {
            for (const [specifier, file] of specifiers) {
              this.#assertAttestedResolution(this.#lockImports, conditions, parent, specifier, file, { what: 'bundle', source: 'lockfile' })
            }
          }
        }
      }
      // Formats: the loader picks module<->commonjs and (for *-typescript) whether Node
      // strips type syntax purely from this map, so a tampered bundle can change how
      // hash-valid bytes parse/run without touching a hash. Every format the bundle declares
      // must match the lockfile's. The bundle's file set is a subset of the lockfile, so an
      // unattested format is fatal (it can only mean a forged entry).
      if (this.#lockFormats !== null) {
        for (const [file, format] of bundle.formats) {
          this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'bundle', source: 'lockfile' })
        }
        // Inverse direction: if the lockfile tags a file the bundle carries as a resource,
        // the bundle MUST declare the matching resource format. Otherwise a tampered bundle
        // could OMIT the resource tag, and State.load would route the base64 payload through
        // `this.sources` (the code path) to the loader. Caught at the loader's NODEJS_FORMATS
        // gate too, but checking here surfaces a clean bundle/lockfile mismatch rather than
        // an opaque "unknown format" later. (Not extended to code formats: that would assert
        // `formats` is total over `modules`, stronger than the "format may be missing per
        // file" contract -- and the code-format hole is closed by the loader allowlist.)
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
      // Mutate in place rather than reassigning -- this.entries may be shared by
      // reference with a sidecar's parent (the unified-lockfile model), and a
      // reassignment would silently fork the shared set.
      for (const e of bundle.entries) this.entries.add(e)
      for (const [dir, info] of bundle.modules) {
        if (!info.name || !info.version) continue // partial metadata
        if (this.modules.has(dir)) {
          // A unified bundle populates `state.modules` from both code and resource entries;
          // a dir added twice (e.g. legacy duplicated metadata) must agree on name/version.
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

  // Load the resources side of a split-bundle layout: a standalone Bundle that MUST hold
  // only resource-format files (no entries/imports/code-format declarations). Unions into
  // the state already absorbed from `bundleFile`, extending this.resources, this.formats,
  // and -- under frozenBundle -- the attestation snapshots. The shape asserts catch a writer
  // that leaked code in or a tampered file claiming metadata it shouldn't carry.
  #absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath }) {
    const bundle = Bundle.parse(brotliDecompressSync(resourcesData).toString('utf-8'))
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 resources bundle; ${resourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // Resources file MUST NOT declare resolution edges or entry points -- those belong to
    // the code bundle. A populated map here means the writer mixed halves (or the file was
    // tampered with) and serving it would widen trust on the code-bundle side's metadata.
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
    // Union formats: conflict-free (bundleFile carries code formats, this one carries
    // resource formats -- the file sets must be disjoint).
    for (const [file, format] of bundle.formats) {
      const existing = this.formats.get(file)
      assert.ok(existing === undefined || existing === format,
        `format conflict for ${file}: bundleFile declares '${existing}', resourcesBundleFile declares '${format}'`)
      this.formats.set(file, format)
    }
    if (this.config.frozenBundle) {
      // Extend the frozen snapshot. bundleFile's path may not have populated these
      // (resources-only deployments are legal), so initialize lazily; #bundleSources may
      // stay null then, which the post-discovery invariant accepts because #bundleResources
      // is set.
      if (this.#bundleResources === null) this.#bundleResources = new Set()
      if (this.#bundleFormats === null) this.#bundleFormats = new Map()
      if (this.#bundleImports === null) this.#bundleImports = objectToMaps(fileMapToObject(this.imports))
      if (this.#bundleSources === null) this.#bundleSources = new Set(this.sources.keys())
      for (const f of bundle.sources.keys()) this.#bundleResources.add(f)
      for (const [f, fmt] of bundle.formats) this.#bundleFormats.set(f, fmt)
    }
  }

  // Verify one resolution edge against an attestation map (`source`: a loaded lockfile, or a
  // frozen bundle's own recorded imports). The final resolution matters, not how the edge is
  // keyed: the conditions key is matched exactly first; on a miss the edge is accepted only
  // when every condition set the attestation records for that (parent, specifier) agrees on
  // the same target -- this lets a static `stasis bundle` artifact (edges under '*') validate
  // against a runtime attestation (precise condition sets) and vice versa, while a claim over
  // a condition-divergent attestation stays fatal. Unknown edges are fatal unless the caller
  // opts out (see addImport's node_modules-scope carve-out).
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
    // A per-platform edge is a Map<platform, target>; compare it structurally -- assert.equal
    // is reference equality, so two identical Maps would never match. A flat string edge stays
    // a plain ===; a Map-vs-string (per-platform attestation vs single runtime target) is a
    // mismatch.
    const matches = file instanceof Map && attested instanceof Map
      ? file.size === attested.size && [...file].every(([platform, target]) => attested.get(platform) === target)
      : file === attested
    assert.ok(matches, `${what} resolution ${edge} mismatches the ${source}`)
  }

  // Verify one file's loader format against an attestation map (`source`: a loaded lockfile,
  // or a frozen bundle's own recorded formats). Callers only invoke this for files that must
  // be attested (the attestation is a superset of any bundle, and on the disk path the call
  // is gated to the hash-attested zone), so an unattested file means a forged/extra entry --
  // fatal.
  #assertAttestedFormat(attestation, file, format, { what, source = 'lockfile' }) {
    const attested = attestation.get(file)
    assert.ok(attested !== undefined, `${what} format for ${file} is not attested by the ${source}`)
    assert.equal(format, attested, `${what} format for ${file} mismatches the ${source}`)
  }

  assertEntry(url) {
    // Skipped silently when no entries info is available (v0 bundle + lock=none/ignore).
    // v1 full-scope bundles must declare at least one entry at parse time, so this fallback
    // only triggers for the legacy path.
    if (this.entries.size === 0) return
    const file = this.#canonicalFile(url)
    assert.ok(this.entries.has(file), `Unknown entry point: ${file}`)
  }

  // The one preload (top-level) State, or undefined. Scans the process-wide registry
  // (shared across stasis-core copies) for the member flagged isPreload.
  static get preload() {
    for (const state of liveStates()) if (state.isPreload) return state
    return undefined
  }

  // True iff this is THE preload (top-level) State. Public so State.preload can identify
  // it even when this State came from a different stasis-core copy.
  get isPreload() {
    return this.#isPreload
  }

  // The label under which this State claims `canonical` as a write target, or undefined.
  // Public so #claimWritePath's collision scan can consult a State from another copy.
  claimedWritePathLabel(canonical) {
    return this.#claims.get(canonical)
  }

  // Claim a write target, refusing a path another live State (in ANY copy) already
  // claims. Canonicalize so `./x` / `x` / symlinks compare equal. Scans the process-wide
  // registry, so collisions are caught across copies and without a preload. Intra-State
  // collisions are caught earlier by Config (#checkInvariants), so this only fires
  // cross-State. The claim is recorded on this instance; it becomes visible to later
  // States once this one is added to liveStates() at the end of construction.
  #claimWritePath(label, value) {
    if (!value) return
    const canonical = canonicalizePath(value)
    for (const other of liveStates()) {
      const owner = other.claimedWritePathLabel(canonical)
      assert.ok(owner === undefined, `${label} '${value}' is already claimed by ${owner} of another live State`)
    }
    this.#claims.set(canonical, label)
  }

  // This State's stasis-core version. Public so a child (sidecar) can verify it
  // exactly matches its parent's even when the two are different module copies
  // sharing the process-wide registry (see the constructor's parent branch).
  get version() {
    return VERSION
  }

  // The slice of parent state a child (sidecar) inherits. Exposed as a PUBLIC method
  // (rather than the child reading the parent's private fields) so a sidecar from a
  // different-but-version-matched stasis-core copy -- a bundle carrying its own
  // stasis-core, whose plugin sidecars the outer loader's preload -- can read it across
  // the class brand. Only ever called by the sidecar constructor, after its version
  // assert; the exact-version match guarantees these shapes are compatible.
  sidecarInheritance() {
    return {
      preloadRoot: this.#preloadRoot,
      lockImports: this.#lockImports,
      lockFormats: this.#lockFormats,
      lockfileLoaded: this.#lockfileLoaded,
    }
  }

  // Register a WRITE-mode child (sidecar) so this parent's unified lockData unions its
  // imports/formats (and attestedBySidecar sees its captures). Public (not a direct
  // `#sidecars.add`) for the same cross-copy reason as sidecarInheritance: the call runs
  // on the parent, touching the parent's own #sidecars, so it works even when the sidecar
  // is a foreign-copy instance.
  registerSidecar(sidecar) {
    this.#sidecars.add(sidecar)
  }

  // Register a LOAD-mode child as a read-only family member: getFs*Family serves bundle
  // bytes from it (a --fs read at load of a file the sidecar carries) but, unlike
  // registerSidecar, it never enters #mergedImports/#mergedFormats, so a load-mode sidecar
  // contributes no resolution edges or formats (the lockfile's trust-bearing content) to the
  // unified lockfile. Public for the same cross-copy reason as registerSidecar.
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
    // The project root itself is keyed '.' -- never '' (path.relative's raw answer).
    // Reached only by a `--fs` directory capture/lookup of the root; '.' is what
    // join('.', rel === '') re-derives when the lockfile is absorbed at load, so
    // recording/looking up under '' would desync write from read (the root listing
    // was written under '' yet hashed under '.', failing getFile's integrity check).
    return file === '' ? '.' : file
  }

  // A file reached under node_modules whose REAL path lies outside any node_modules is a
  // workspace source linked in (pnpm symlinks a workspace dependency). Canonicalize such a
  // URL to its real path so it is recorded/looked up as a *source*, not a dependency -- and
  // thus excluded from a node_modules-scope bundle. Everything else passes through untouched:
  // plain sources, real dependencies, and node_modules -> node_modules links (pnpm's `.pnpm`
  // store).
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
    // Outside the root, or still inside some node_modules (a real dependency,
    // e.g. pnpm's `.pnpm` store): leave the recorded path unchanged.
    if (realFile.startsWith('..') || splitNodeModulesPath(realFile)) return { url, absolute }
    return { url: pathToFileURL(real).toString(), absolute: real }
  }

  // The canonical project-relative path a URL is recorded/looked up under.
  #canonicalFile(url) {
    return this.relative(this.#canonical(url).absolute)
  }

  // True when `url` resolves (through any workspace symlink) to a file under node_modules --
  // a bundled dependency -- as opposed to a workspace source linked into node_modules (which
  // #canonical records as a source). The loader hooks gate on this rather than a raw
  // `/node_modules/` substring, so a symlinked workspace source is read from disk instead of
  // served from a node_modules-scope bundle that omits it. Tolerant: a URL it can't
  // canonicalize (non-file, outside root) is treated as not-a-dependency.
  inNodeModules(url) {
    let file
    try {
      file = this.#canonicalFile(url)
    } catch {
      return false
    }
    return splitNodeModulesPath(file) !== null
  }

  // Nearest package.json at or above a directory, for addFsDir (--fs readdir captures).
  // Replaces findPackageJSON, unreliable for a directory URL (see #locateModule). Walks up
  // via the destructured existsSync, bounded by the project root -- itself always a
  // package.json dir, so an in-root directory always resolves. Returns an absolute path.
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

  // Canonicalize `url` and resolve the package bucket that owns it, registering the module
  // (name/version, `npm` ecosystem under node_modules) on first sight. Shared by addFile and
  // addFsDir: everything here is independent of a file's bytes or loader format. Returns the
  // canonical absolute path, the project-relative `file`, the bucket `dir`/`module`, and the
  // nearest package `type` (for addFile's extension inference).
  //
  // `directory: true` (addFsDir): the url names a directory. Node's findPackageJSON is
  // unreliable for a directory URL -- by Node version it returns the PARENT's package.json,
  // `undefined` (at a bucket root), or a `node_modules/` DIRECTORY path that readPackageJSON
  // then reads as a file and throws EISDIR. So for a directory we walk up to the nearest
  // package.json ourselves (#nearestPackageJsonFor), correct on every Node version.
  #locateModule(url, { directory = false } = {}) {
    // Canonicalize first: a workspace source linked into node_modules is recorded under its
    // real (non-node_modules) path so it classifies as a source.
    const canonical = this.#canonical(url)
    url = canonical.url
    const absolute = canonical.absolute
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const closestPkgAbsolute = directory ? this.#nearestPackageJsonFor(absolute) : findPackageJSON(url)
    const closestPkg = readPackageJSON(closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')

    // findPackageJSON may land on a `{"type":"module"}`-style sub-bucket marker that lacks
    // name/version.
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
          // Allow fake module-name subpaths: the real module owns the prefix. Npm publish
          // wouldn't accept this anyway, so it's not a conflict.
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
      // node_modules buckets are installed dependencies; tag them `npm` so consumers can
      // tell deps from the workspace's own packages without re-deriving it from the path.
      // Workspace/top-level buckets (the scope=full `sources`) carry no ecosystem.
      this.modules.set(dir, nmRoot
        ? { name, version, ecosystem: 'npm', files: Object.create(null) }
        : { name, version, files: Object.create(null) })
    }
    const module = this.modules.get(dir)
    assert.equal(module.name, name)
    assert.equal(module.version, version)

    return { absolute, file, dir, module, closestType }
  }

  // `resource: true` (legacy alias `isBinary: true`) marks the file as a resource, not code.
  // Its format is then derived from the bytes: 'resource' for valid UTF-8 (stored raw) or
  // 'resource:base64' for binary. Code files keep their inferred loader format.
  //
  // `inferFormat: false` records the bytes WITHOUT inferring or recording any loader format
  // (an existing one is left intact). addFsFile uses it for `.js`/`.ts`, whose
  // module-vs-commonjs is Node's syntax-detection call: the loader is the authority, so the
  // fs-read capture must not impose the legacy `commonjs` default and collide with a `module`
  // the loader records when the file is both imported and read.
  addFile(url, { source, format, isEntry, isBinary, resource, inferFormat = true, reason = 'run', fsRead = false } = {}) {
    const asResource = resource === true || isBinary === true
    // A resource format must not arrive on the code path: 'resource'/'resource:base64'
    // identifies asset payloads, stored in `this.resources`. A caller passing the format
    // string without resource:true is asking for a code file tagged as a resource -- nonsense,
    // and exactly the misclassification the per-file format design catches. The reverse
    // (resource:true with a non-resource format) is rejected below via the content-derived
    // format check.
    if (!asResource && Bundle.isResourceFormat(format)) {
      throw new Error(`addFile: format '${format}' requires resource: true`)
    }
    // A payload-free stat record is never a legal addFile format: addFile records CONTENT
    // (bytes + hash), and a content record tagged 'stat:*' would desync the "stat records
    // carry no payload" invariant. The only producer is addFsStat; a caller passing it here
    // (e.g. a forged child shard replayed by mergeShard) is refused at the recording site.
    if (isStatFormat(format)) {
      throw new Error(`addFile: format '${format}' is a payload-free stat record; use addFsStat`)
    }
    // A resource can't be an entry: entries name code loaded by Node (the module graph's
    // roots), validated as code-shaped paths by Bundle.parse/assertEntry. A resource entry
    // would land in this.entries -> codeBundle.entries, producing a v1 bundle whose entries
    // refer to files absent from its sources -- structurally valid but semantically broken,
    // silent at capture and surfacing opaquely at the loader's NODEJS_FORMATS gate later.
    if (asResource && isEntry) {
      throw new Error(`addFile: a resource can't be an entry (resource:true + isEntry:true)`)
    }
    // Canonicalize + bucket by the owning package (shared with addFsDir).
    const { absolute, file, dir, module, closestType } = this.#locateModule(url)

    // A payload-free stat record (addFsStat: the path was stat'd before it was read or
    // imported) is superseded by real content: drop it so the inference/noupsert below
    // records the ACTUAL format instead of conflicting with the weak 'stat:*' tag. The
    // lockfile-baseline counterpart lives in the flip-check relaxation below and
    // #mergedFormats' upgrade rule.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)

    // A code file can NEVER be recorded as a resource. `resources` -- the only gate admitting
    // an asset payload -- rejects code extensions (see parseResourcesOption), so a
    // resource:true call for a code extension means a capture path bypassed that gate. That is
    // how an fs.readFileSync of a `.jsx` got tagged 'resource', desyncing the lockfile
    // (resource) from the bundle (code) until it surfaced as an opaque format mismatch at
    // load. Fail at the recording site, where the cause is obvious.
    if (asResource && CODE_EXTENSIONS.has(extname(file).slice(1).toLowerCase())) {
      throw new Error(`addFile: a code file can't be recorded as a resource: ${file}`)
    }

    // Resources get no loader format inferred from extension/package type -- their format is
    // chosen by content below. inferFormat:false (addFsFile for .js/.ts) skips inference.
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
        // No `type` in the nearest package.json: Node decides .js/.ts by module-syntax
        // detection, so either variant is legitimate and the caller's reported format wins.
        // With no format provided (e.g. bundler plugins' afterResolve/onLoad), defer to a
        // format already recorded for this file THIS session before the legacy commonjs
        // default. The runtime loader records Node's authoritative module/commonjs choice, so
        // a later no-format capture must KEEP a known `module` rather than re-default to
        // commonjs -- which would mis-attest the bundle and collide at the noupsert below (and
        // at #mergedFormats for a sidecar). A sidecar's loader records land in the parent's
        // formats, so consult it too. Only an extension-appropriate code format is reused; a
        // stale resource tag falls through to the default so the conflict still surfaces at
        // noupsert.
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
    // Verify a CALLER-PROVIDED source against disk (the loader passes the bytes it is about to
    // execute; this catches bytes that differ from the file on disk). When we read `source`
    // ourselves the comparison is tautological, so skip the redundant second read.
    if (!sourceFromDisk) assert.deepStrictEqual(readFileSync(absolute), buf)

    // Resource format is content-driven: raw UTF-8 stays 'resource' (don't base64 text);
    // anything else is 'resource:base64'.
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
      // Track HOW 'run' saw this file so #bundleReason can drop files run merely fs-READ after a
      // plugin attached that a plugin actually bundles (e.g. webpack+babel reading app source).
      if (reason === 'run') {
        if (!fsRead) this.#runImported.add(file)
        else if (this.#pluginAttached) this.#fsReadPostPlugin.add(file)
      }
    }
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    const inAttestedZone = dir.includes('node_modules') || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel))
    }

    // Frozen bundle: the observed bytes are checked against the bundle by the noupsert into
    // this.sources/this.resources below (pre-seeded from the bundle); here we close the set,
    // rejecting a file the bundle never recorded (mirrors the lockfile membership check
    // above). The scope carve-out matches the lockfile's: node_modules scope doesn't attest
    // workspace files, so they aren't required to be in the bundle.
    if (this.config.frozenBundle && inAttestedZone) {
      const attested = asResource ? this.#bundleResources : this.#bundleSources
      assert.ok(attested?.has(file), `File not attested by the frozen bundle: ${file}`)
    }

    // Frozen runs verify the on-disk format against the attestation, like addImport verifies
    // resolutions: the format is derived from the extension + nearest package.json `type`,
    // and `type` is usually not hash-attested, so flipping it recategorizes a hash-valid file
    // (commonjs<->module, .js<->module-typescript) with no hash mismatch. Checked against the
    // lockfile and/or the frozen bundle. Gated to the same attested zone as the hash check
    // above; files with no derived format (binary resources) are skipped via `format != null`.
    if (this.config.frozen && this.#lockFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
    }

    // A WRITING lock capture (lock=add) must catch a format flip on already-attested bytes
    // EARLY. The lockfile baseline lives in #lockFormats -- separate from this.formats -- so
    // addFile's noupsert below won't see the clash; it would otherwise surface only later at
    // write(), when #mergedFormats unions the baseline with session formats and noupsert
    // throws a bare `Conflict for <file>` with no cause or remedy. Detect it here with a
    // clear error instead. (Frozen rejects it via the format check above; lock=replace
    // discards the baseline so #lockFormats is null; bundle=add seeds bundle formats into
    // this.formats so a bundle-side flip already conflicts at the noupsert below. Re-attest a
    // genuine change with --lock=replace / --bundle=replace.)
    if (this.config.writeLockfile && this.#lockFormats !== null && format != null && inAttestedZone) {
      const attested = this.#lockFormats.get(file)
      // A payload-free 'stat:*' baseline is not a flip: the prior capture attested only
      // existence/kind, and this run observing real content UPGRADES the record
      // (#mergedFormats overwrites the stat record with the real format).
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

  // Record an `fs.readFileSync` capture (--fs, capture side). `source` is the raw bytes.
  // Classification follows classifyFormat's full vocabulary -- wider than the JS-graph
  // bundlers' classifyExtension -- so a native/source-language file it reads is code, no
  // resources allowlist entry needed:
  //  - a concrete code format (mjs/cjs/json/*-ts, a source language, a native build input) →
  //    recorded as code under it. addFile asserts UTF-8 -- a non-UTF-8 code file is refused.
  //  - null (a JS-family file: .js/.ts by package `type`/syntax, .jsx/.tsx none) → code with
  //    NO format imposed, so the loader stays authoritative if the file is also imported.
  //  - undefined (not code) → a 'resource'/'resource:base64' payload IFF its extension/basename
  //    is allowlisted, else THROW (recording an undeclared file would widen the attested set;
  //    the --fs hook turns the throw into a tainted, nothing-written run).
  // Routing through addFile means a both-imported-and-fs-read file lands in one deduped entry.
  // `content` is passed so an extensionless `#!/usr/bin/env bash` wrapper is seen as 'shell'.
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

  // Record an `fs.readdirSync(path)` capture (single-arg form only). The listing is SORTED
  // for reproducibility regardless of OS directory order, JSON-serialized, and stored as a
  // 'directory'-format payload -- a resource-like file whose integrity (sha512 over the JSON)
  // lands in the lockfile like any other content. Buckets/dedups via #locateModule; the
  // directory's own project-relative path is the key (a readdir of a module root keys the
  // listing at the bucket itself -- see moduleFileKey).
  addFsDir(url, names) {
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'),
      'addFsDir requires an array of string names')
    const { file, dir, module } = this.#locateModule(url, { directory: true })
    // As in addFile: a payload-free stat record (the dir was stat'd before readdir) is
    // superseded by the real listing -- drop it before the format noupsert records 'directory'.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)
    const content = JSON.stringify(names.toSorted())
    const format = 'directory'
    const integrity = sha512integrity(content)
    noupsert(this.hashes, file, integrity)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it; skip when the channel is off
    // Directory captures come only from the loader's --fs, and a plugin never records a readdir
    // listing (plugins only addFile), so a directory key is never in #bundleReason's pluginFiles
    // and can never be dropped from 'run' -- no need to track it in #fsReadPostPlugin.
    if (this.config.bundle) this.#recordReason('run', file)
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    // Frozen attestation, mirroring addFile: in the attested zone the listing must
    // already be recorded (closed set) and its format/integrity must match.
    const inAttestedZone = dir.includes('node_modules') || this.config.full
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

  // Record an `fs.lstatSync/statSync(path)` capture (--fs, capture side, single-arg form): a
  // PAYLOAD-FREE stat record -- `formats[file] = 'stat:file' | 'stat:directory'`, no bytes,
  // no hash, no module-files entry -- attesting only that the path existed with that KIND.
  // That is what the load-side type-getter shim needs (getFsStat sources
  // isFile()/isDirectory()), so a stat-ONLY path -- never read, readdir'd, or imported --
  // still answers `lstatSync(x).isDirectory()` (and, via getFsStatFamily, the
  // existsSync/accessSync/realpathSync probes) at bundle=load once it's gone from disk.
  //
  // Skipped when the path already has a content record (bytes or a directory listing,
  // captured this run or seeded from the lockfile/bundle): that already answers getFsStat, and
  // a weak stat record must never sit beside it (check-then-read is the common pattern). A
  // path with a REAL format but no content record -- addImport attesting a resolve-hook
  // target whose load hook never fires (a preload-cached module) -- is likewise left alone:
  // upsertFormat drops the stat record, the real format wins (a plain noupsert here aborted
  // real captures: enhanced-resolve stat'ing stasis-core's own src/util.js under --fs + a
  // plugin). The REVERSE order (stat first, real format later) is handled by addFile/addFsDir
  // dropping the stale record in place, addImport's upsertFormat, and #mergedFormats' upgrade
  // rule. A kind flip within the surviving stat records still conflicts and taints the
  // capture, like a mid-run byte conflict.
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

  // Serve an `fs.readFileSync` from the bundle (--fs, bundle=load). Returns the raw bytes as
  // a Buffer, or undefined when the path was not captured (the hook falls back to a real disk
  // read) or names a captured directory (a readFileSync of a directory must fail, not return
  // its listing). Decoding and the hash check reuse getFile. NB: a captured `.js`/`.ts` may
  // have no recorded format (see addFsFile); it's still served from `this.sources` by presence
  // -- the format only governs the module loader, not an fs read.
  getFsFile(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) === 'directory') return undefined
    if (!this.sources.has(file) && !this.resources.has(file)) return undefined
    const { source } = this.getFile(url)
    return Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  }

  // Serve an `fs.readdirSync(path)` from the bundle: the sorted listing captured at build
  // time, or undefined when the path was not captured as a directory (the hook falls back to
  // a real disk read). Reuses getFile for the hash check.
  getFsDir(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) !== 'directory') return undefined
    const { source } = this.getFile(url)
    const names = JSON.parse(source)
    assert.ok(Array.isArray(names), `corrupt directory listing for ${file}`)
    return names
  }

  // Every ancestor directory implied by the bundle's recorded file/resource/directory keys.
  // A recorded `node_modules/dep/index.js` implies `node_modules/dep`, `node_modules`, and
  // the root '.'. Built once; load-mode immutable (see field).
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
    // Payload-free stat records prove existence too: a 'stat:file' at
    // node_modules/dep/index.js implies node_modules and node_modules/dep like a content
    // record would, and a 'stat:directory' implies its own ancestors (the recorded dir
    // itself is answered directly by getFsStat's format branch, not via this index).
    for (const [key, format] of this.formats) if (isStatFormat(format)) add(key)
    this.#impliedDirIndex = dirs
    return dirs
  }

  // Classify a captured path for the `fs.lstatSync/statSync(x)` .isFile()/.isDirectory() shim
  // (--fs, bundle=load): 'directory' for a readdir capture, 'file' for a readFileSync
  // capture, the recorded kind for a payload-free stat record, 'directory' for an ancestor
  // implied by a recorded file (e.g. `node_modules` when the bundle carries
  // `node_modules/dep/index.js`), or undefined when the path wasn't captured (the shim falls
  // back to a real on-disk lstatSync). A directory lives in this.resources too, so 'directory'
  // is checked first; content records before stat records (defensive -- addFsStat never
  // records beside content); implied dirs last so an explicit record always wins. NB: 'file'
  // here means "recorded as a file", NOT "the bundle can serve its bytes" -- callers needing
  // the latter must use hasFsFileContent.
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

  // True when the bundle carries actual BYTE content for `url` as a file -- code or a
  // resource payload -- as opposed to a directory listing, a payload-free 'stat:*' record, or
  // nothing. The CJS-resolution shim (hooks.js) and the sidecar capture-skip route "can the
  // bundle serve this file's bytes?" through this instead of getFsStat, which also answers
  // 'file' for stat-only records.
  hasFsFileContent(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return false }
    if (this.formats.get(file) === 'directory') return false
    return this.sources.has(file) || this.resources.has(file)
  }

  // --fs <-> bundler-plugin coordination. A StasisWebpack/StasisEsbuild/StasisMetro sidecar
  // (its own bundleFile) captures the bundler's MODULE GRAPH into its OWN bundle. But the
  // bundler also reads every module's source through node:fs, which the --fs hook would
  // otherwise RE-record into THIS (main) bundle -- copying the whole graph into main and
  // defeating the split. So --fs consults the family two symmetric ways:
  //   - CAPTURE (write mode): attestedBySidecar SKIPS recording a read a write-mode sidecar
  //     already attests (the graph). Only reads no sidecar owns (a babel plugin's manual
  //     non-JS reads, etc.) are recorded into main.
  //   - LOAD (load mode): getFs*Family SERVES a graph file from a load-mode sidecar's bundle
  //     when main doesn't carry it (a program raw-reading a graph file via --fs at load).
  // The two paths consult DIFFERENT registries because a sidecar is a contributor XOR a
  // consumer: write-mode sidecars (#sidecars) feed the lockfile; load-mode (#readSidecars)
  // must not. readdir capture has no skip -- bundler plugins record files (addFile), never
  // directory LISTINGS, so a sidecar never owns a readdir result; a readdir is a genuine
  // program read for main.
  //
  // attestedBySidecar consults #sidecars and excludes THIS State on purpose: a file only this
  // State has stays subject to --fs's own dedup/byte-conflict detection; the skip applies
  // solely to a file a *sidecar* carries.
  attestedBySidecar(url) {
    // hasFsFileContent (not getFsStat): the skip targets a file whose BYTES a sidecar carries.
    // getFsStat would also match a 'directory' implied ancestor or a payload-free 'stat:*'
    // record -- neither carries bytes, so matching them would over-skip and leave a genuine
    // read unattested.
    for (const s of this.#sidecars) if (s.hasFsFileContent(url)) return true
    return false
  }

  // getFs* variants that also consult load-mode sidecars (#readSidecars; this State first), so
  // a file/dir a sidecar carries is served by --fs reads at load even when main doesn't carry
  // it. Only #readSidecars: write-mode sidecars exist only during capture, where --fs records
  // rather than serves, so they're never consulted here.
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
    // The sidecar loop is inert in practice: bundler plugins record files, never directory
    // LISTINGS, so a sidecar's bundle has no `directory` entry and s.getFsDir always returns
    // undefined. Kept for symmetry with the file/stat families.
    for (const s of this.#readSidecars) { const v = s.getFsDir(url); if (v !== undefined) return v }
    return undefined
  }

  getFile(url) {
    // #canonicalFile -> relative() throws a bare assertion if the URL escapes state.root.
    // Wrap it so callers get a contextual message instead of a stack pointing at relative()'s
    // assert.ok(!file.startsWith('..')).
    let file
    try { file = this.#canonicalFile(url) }
    catch (cause) { throw new Error(`stasis: file is outside the project root: ${url}`, { cause }) }
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    // Resources live in this.resources, code in this.sources. Decode per format:
    // 'resource:base64' is base64, 'resource' is raw UTF-8, code is raw text. A missing entry
    // throws with the URL in context so load-mode callers don't have to pre-check existence --
    // the single getFile call is the fail-closed gate.
    let source
    if (Bundle.isResourceFormat(format)) {
      source = this.resources.get(file)
      if (source === undefined) throw new Error(`stasis: file not attested in bundle: ${url}`)
      if (format === 'resource:base64') source = Buffer.from(source, 'base64')
    } else {
      source = this.sources.get(file)
      if (source === undefined) {
        // Name the stat-record case: the bundle DOES know this path, just not its bytes (a
        // stat capture attests existence/kind only), so "not attested" would misdiagnose it.
        // Loading it requires a capture that reads or imports it.
        if (isStatFormat(format)) {
          throw new Error(
            `stasis: only a payload-free stat record ('${format}') is attested for ${url} -- ` +
            `the capture stat'd this path but never read or imported it, so the bundle has no bytes to serve`
          )
        }
        throw new Error(`stasis: file not attested in bundle: ${url}`)
      }
    }
    // Without a lockfile the bundle is self-attesting: hashes would be derived from the same
    // source bytes we'd then verify -- a tautology.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  // The recorded LOADER format for a project-relative file, or undefined. Masks payload-free
  // stat records: 'stat:*' attests existence/kind for the --fs stat and probe shims, NOT how
  // bytes parse -- so loader-format consumers must see "no recorded format". Without the mask,
  // a require.resolve()d target that was also stat'd (a resolve-only edge, the supported
  // require.resolve case) came back as 'stat:file' and the resolve hook's executable-format
  // gate refused a valid resolution. getFile deliberately does NOT mask: it needs the stat tag
  // to explain a byte-less load, and bytes smuggled under a 'stat:*' tag must still hit the
  // loader's gate.
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

  // A require()/import() given an already-resolved ABSOLUTE path arrives at the resolve hook
  // with that absolute path AS the specifier -- CJS `require('/repo/node_modules/pkg/index.js')`
  // is the common case (webpack's loader-runner does `require(loader.path)`). Recorded
  // verbatim, that machine-specific path becomes a resolution KEY in the lockfile/bundle:
  // non-portable and unmatchable elsewhere. Once the target is confirmed inside the project
  // root, renormalize it relative to the IMPORTING FILE's directory -- the shape a hand-written
  // `require('./x')` / `require('../../pkg/x')` has. The resulting key may itself contain '../',
  // which is fine as long as the target stayed inside root.
  //
  // Keying against the parent makes the key portable AND collision-free: it is always
  // '.'-prefixed, so it can't clash with a bare ('pkg') or root-relative key, and an absolute
  // path naming the same file as a relative import unifies onto the identical key (noupsert
  // agrees). Bare/relative specifiers and file: URLs pass through untouched; an absolute path
  // escaping the root has no in-root relative form, so it's left as-is. Applied identically in
  // addImport and getImport so the key written and queried agree.
  #canonicalSpecifier(parentURL, specifier) {
    if (typeof specifier !== 'string' || !isAbsolute(specifier)) return specifier
    const fromRoot = relative(this.root, specifier)
    if (fromRoot === '' || fromRoot.startsWith('..')) return specifier // outside the project root
    const rel = relative(dirname(fileURLToPath(parentURL)), specifier)
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  addImport(parentURL, specifier, url, { conditions = '*', format, importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    // Capture Node's require-condition set the first time we see a require()-context edge: it
    // carries 'require' and never 'import'. Requiring the absence of 'import' also rejects an
    // import edge a user forced 'require' onto via --conditions. #backfillObservedResolutions
    // reuses this set to key native require.resolve() edges accurately instead of '*' (see
    // field doc).
    if (this.#requireConditions === null && Array.isArray(conditions) &&
        conditions.includes('require') && !conditions.includes('import')) {
      this.#requireConditions = conditions
    }
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)

    // Frozen runs verify resolutions observed from disk against the lockfile, mirroring the
    // bundle-side check: byte hashes can't see a resolution redirected to a *different*
    // attested file (via an unattested package.json `main` or a symlink). An edge the lockfile
    // attests must match in every scope. Unknown edges are fatal in full scope (the attested
    // set is closed), but tolerated for workspace parents in node_modules scope -- the
    // workspace is deliberately unattested there, so changed workspace code may legitimately
    // introduce new edges, including into pinned packages.
    const tolerateUnknown = !this.config.full && !parent.includes('node_modules')
    if (this.config.frozen && this.#lockImports !== null) {
      this.#assertAttestedResolution(this.#lockImports, key, parent, specifier, file, { what: 'observed', source: 'lockfile', tolerateUnknown })
    }
    // A frozen bundle attests resolutions the same way (every v1 bundle carries an `imports`
    // map, so #bundleImports is never null once one is loaded). Same redirect protection and
    // node_modules-scope carve-out, anchored in the bundle.
    if (this.config.frozenBundle && this.#bundleImports !== null) {
      this.#assertAttestedResolution(this.#bundleImports, key, parent, specifier, file, { what: 'observed', source: 'frozen bundle', tolerateUnknown })
    }

    if (!this.imports.has(key)) this.imports.set(key, new Map())
    const imports = this.imports.get(key)
    if (!imports.has(parent)) imports.set(parent, new Map())
    const specifiers = imports.get(parent)
    noupsert(specifiers, specifier, file)
    // upsertFormat (not a bare noupsert): the resolve hook may attest the format of a target
    // the program already stat'd under --fs (a payload-free 'stat:file' record) -- the real
    // format replaces the weak stat record instead of aborting the capture as a conflict.
    if (format) upsertFormat(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'getImport requires a parent') // matches addImport; #canonicalSpecifier needs it
    const parent = this.#canonicalFile(parentURL)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    // Statically-built bundles (e.g. `stasis bundle src/entry.js`) resolve edges offline and
    // store them under the wildcard '*' key, since they can't predict the condition set Node
    // will pass at load. The runtime loader records the precise conditions, so the specific
    // lookup wins when a runtime bundle is in play and only static bundles take the wildcard
    // fallback. Mismatches under the two condition sets remain caller territory -- the static
    // bundle is authoritative for whichever conditions its resolver used.
    let file = this.imports.get(key)?.get(parent)?.get(specifier)
    if (file === undefined && key !== '*') {
      file = this.imports.get('*')?.get(parent)?.get(specifier)
    }
    if (file === undefined) {
      // The (key, parent, spec) and '*' lookups missed, but the edge may be recorded under a
      // DIFFERENT conditions bucket -- e.g. the esbuild plugin asks with conditions='*' while
      // a Node-loader-captured bundle keyed it under 'require, node, ...'. resolveBundled scans
      // every bucket.
      if (this.config.loadBundle) {
        const abs = this.resolveBundled(parentURL, specifier)
        if (abs !== undefined) {
          const f = relative(this.root, abs)
          return { url: pathToFileURL(abs).toString(), format: this.#loaderFormat(f) }
        }
      }
      // Throw with Node's ERR_MODULE_NOT_FOUND shape rather than asserting: Node's resolver
      // throws this when a bare/relative specifier can't be found, and ESM dynamic-import
      // callers commonly do
      // `try { await import(x) } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e }`.
      // A bare assertion's ERR_ASSERTION code re-threw out of those guards.
      const err = new Error(`Cannot find module '${specifier}' imported from ${parent}`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    // A `stasis bundle --metro` artifact records a { platform: file } Map for an edge that
    // resolves differently per platform. Plain `stasis run --bundle=load` has no platform
    // context to pick one, so it fails closed rather than feeding a Map where a path is
    // expected.
    if (typeof file !== 'string') {
      const err = new Error(`Resolution of '${specifier}' from ${parent} is platform-specific (a --metro multi-platform bundle); it can't be loaded by plain node, build a single-platform bundle to load`)
      err.code = 'ERR_STASIS_PLATFORM_SPECIFIC'
      throw err
    }
    const url = pathToFileURL(resolve(this.root, file)).toString()
    // #loaderFormat: might be undefined (some bundlers record no format), and a payload-free
    // stat record is masked -- a resolve-only edge's target (recorded by require.resolve,
    // never loaded) may carry one, and it is not a loader format.
    const format = this.#loaderFormat(file)
    return { url, format }
  }

  // Resolve a CommonJS require() target to a bundled file, returning the absolute path the
  // loader should use (load() then serves its bytes), or undefined to defer to Node's native
  // resolution.
  //
  // Node's CommonJS loader resolves require() through Module._resolveFilename, which
  // registerHooks does NOT intercept. When the ESM->CJS translator runs a CJS module served
  // from the bundle (`import chalk from 'chalk'`, chalk being CJS), its nested require()s take
  // this native path and Node resolves them against disk -- so a bundle is not self-contained
  // for a CJS dependency graph once node_modules is pruned/absent. The CJS-loader shim in
  // hooks.js consults this to serve them from the bundle instead.
  //
  // Returns the recorded edge for this (parent, specifier) under ANY conditions bucket -- a
  // native require gives no conditions to key on, and divergent targets across buckets are
  // ambiguous, so we defer. EVERY require() edge is recorded at capture, including sibling
  // requires Node's module cache hid from the resolve hook (the Module._load shim observes
  // them) -- so a miss here means the bundle doesn't carry the target (an external), and we
  // defer to Node rather than guess.
  resolveBundled(parentURL, specifier) {
    let parent
    try { parent = this.#canonicalFile(parentURL) } catch { return undefined }
    const spec = this.#canonicalSpecifier(parentURL, specifier)
    const matches = new Set()
    for (const [, byParent] of this.imports) {
      const file = byParent.get(parent)?.get(spec)
      if (file !== undefined) matches.add(file)
    }
    return matches.size === 1 ? resolve(this.root, [...matches][0]) : undefined
  }

  // Union of the lockfile-attested resolutions and the live map (observed at runtime and/or
  // carried over from a loaded bundle), so a partial lock=add run extends the recorded
  // resolutions without dropping edges it didn't reach. Conflicting targets for the same edge
  // are fatal (add semantics, like hashes).
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
    // Union sidecars' imports too: a bundler-plugin's sidecar records the webpack-graph edges
    // into its own this.imports, and the lockfile must attest them so a frozen run can verify.
    for (const sidecar of this.#sidecars) mergeIn(sidecar.imports)
    return merged
  }

  // Union of lockfile-attested and observed/bundle-served formats, same append-only stance as
  // #mergedImports: conflicting formats for one file are fatal (noupsert). Sidecars' formats
  // are unioned in likewise. The one exception is a payload-free stat record ('stat:*'): it is
  // WEAK by design -- real content observed for the same file (a lock=add re-run reading a
  // path a prior capture only stat'd, or a sidecar bundling a file this run also stat'd)
  // UPGRADES the record, and a stat record never displaces a real format (upsertFormat). Two
  // REAL formats -- and two divergent stat kinds -- stay fatal.
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

  // Pair each module's recorded file list with content from perFile (state.sources for code,
  // state.resources for resources), dropping modules with no content. Bundle.serialize* then
  // groups them into sources/modules buckets and writes the lockfile-shaped output.
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

  // A bundler plugin instance has attached to this State (from resolvePluginState at the
  // plugin's construction). Files this run merely fs-READS *after* this point that a plugin
  // also bundles are the plugin's modules, not run's -- see #bundleReason. Idempotent. Public
  // so it works across stasis-core copies, like registerSidecar / sidecarInheritance.
  markPluginAttached() {
    this.#pluginAttached = true
  }

  // Record which consumer (`reason`) observed `file`, for the bundle's informational `reason` map.
  #recordReason(reason, file) {
    let set = this.#reasonFiles.get(reason)
    if (set === undefined) this.#reasonFiles.set(reason, set = new Set())
    set.add(file)
  }

  // Build the bundle's informational `reason` map, restricted to `bundledFiles`: { consumer:
  // [files] } for each consumer that recorded at least one file in it. Returned ONLY when more
  // than one consumer contributed -- a single-consumer bundle (plain `run`, or a standalone
  // plugin) omits it. Never attested; purely for humans / tooling.
  #bundleReason(bundledFiles) {
    const inBundle = bundledFiles instanceof Set ? bundledFiles : new Set(bundledFiles)
    // Files some PLUGIN bundles (any consumer other than 'run'). A file run merely fs-READ
    // (never imported) after a plugin attached, that a plugin also bundles, is the plugin's
    // module -- e.g. webpack+babel reading app source through --fs -- so 'run' must not claim it.
    const pluginFiles = new Set()
    for (const [who, recorded] of this.#reasonFiles) {
      if (who === 'run') continue
      for (const file of recorded) pluginFiles.add(file)
    }
    const runOverclaims = (file) =>
      this.#fsReadPostPlugin.has(file) && !this.#runImported.has(file) && pluginFiles.has(file)

    const reason = {}
    let consumers = 0
    // Sort consumer keys AND each file list, like every other map in the bundle: the emitted
    // JSON must be byte-reproducible regardless of loader-vs-plugin record order, else
    // #emitBundle's compare-and-skip would see spurious diffs.
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

  // The formats map a bundle artifact declares. Normally `this.formats` as-is; the one
  // adjustment is dropping a payload-free stat record that the run's UNIFIED attestation
  // upgraded to a real format -- a write-mode sidecar bundling a file this run also stat'd
  // (stat-before-plugin-capture ordering, so addFile's in-place drop never saw it). The
  // lockfile then attests the REAL format (#mergedFormats' upgrade), and a bundle still
  // declaring 'stat:*' would fail its lockfile cross-check at load. Cheap in the common case:
  // with no write-mode sidecars the live map is already consistent and returned as-is.
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
    // One bundle holds both code and resources; merge the two content maps (their key sets are
    // disjoint -- a file is either code or a resource) and let `formats` tag which is which.
    // Resource payloads are already encoded. The disjointness is enforced upstream in addFile
    // via noupsert on this.formats, so an overlap here would be a real bug -- assert it at the
    // merge site so the failure is local, not a silently-clobbered value.
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

  // Split-bundle counterparts to `sourceBundle` / `sourceData`. Used by `write()` when
  // `config.resourcesBundleFile` is set so the on-disk layout matches a bundle=load reader.
  // Each is a standalone v1 Bundle; metadata is partitioned, not duplicated -- the code half
  // owns entries/imports and code-format declarations, the resources half owns resource-format
  // declarations and the resource bytes. Both halves declare per-dir module identity
  // (name/version) so each file is verifiable on its own.
  get codeBundle() {
    // Resource files don't appear in `this.sources` (addFile routes by format), so restricting
    // #bundleModules to `this.sources` yields the code-only view. Formats/modules are filtered
    // to drop resource-only dirs/files. Payload-free stat records are NOT resource formats, so
    // they ride the code half (like entries/imports) -- the resources half's strict
    // resource-formats-only shape check would reject them.
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
      // Resources bundle carries no entries/imports -- those belong to the code half.
      // Bundle.parse accepts an empty entries set when no code is present (the hasCode check
      // sees only resource-format files and waives the requirement).
      entries: new Set(),
      modules: this.#bundleModules(this.resources),
      formats: resourceFormats,
      imports: new Map(),
      reason: this.#bundleReason(this.resources.keys()),
    })
  }

  // Record a capture-time native resolution (from the Module._resolveFilename shim). Stored
  // verbatim; #backfillObservedResolutions decides at write() which to add. Last-write-wins
  // per (parent, specifier) so duplicates collapse.
  observeResolution(parentURL, specifier, resolvedURL) {
    let byParent = this.#observedResolutions.get(parentURL)
    if (byParent === undefined) this.#observedResolutions.set(parentURL, (byParent = new Map()))
    byParent.set(specifier, resolvedURL)
  }

  // Backfill resolution edges the live resolve hook never observed -- require.resolve() (and
  // CJS require()s that resolve natively) on Node versions where they bypass the hook. Records
  // BOTH kinds the hook missed:
  //   - under-recorded require()s whose target the bundle carries (Node's module cache hid the
  //     require() from the hook -- another module loaded the target first), and
  //   - resolve-only edges whose target it does NOT carry: require.resolve() of a module never
  //     loaded in-process (an optional-dependency probe, a forked-worker child, a .node addon).
  //     The resolution is real and must be attested so the same require.resolve() returns the
  //     same path at load; the file has no bytes (load() never runs, so getFile never serves
  //     it). Bytes are attested only by whoever LOADS the file: a fork/worker target is loaded
  //     in the forked CHILD as its entry, contributed via the --child-process shard (flushed
  //     even on SIGTERM under the Metro plugin's opt-in, so a force-killed worker still
  //     reports). Deliberately NOT seeded from the parent: attesting bytes this process never
  //     loaded would widen the trust set to everything that merely resolves.
  // Guards:
  //   - skip out-of-scope targets (mirroring #collectMissingImportedFiles) so a node_modules-
  //     scope artifact doesn't attest workspace resolutions; an in-bundle target is always in
  //     scope. (Targets escaping the root throw in #canonicalFile -> caught below.)
  //   - only edges the hook didn't already record (dedup across all condition buckets).
  // Keyed under the observed require-condition set (#requireConditions) -- require()/
  // require.resolve() resolve under those conditions -- so a native-resolve Node keys them the
  // same way the resolve hook does on newer Node. Any capture doing at least one require() thus
  // yields the same lockfile on every version; '*' only when the set was never observed, which
  // getImport/resolveBundled still match via their wildcard fallback.
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
    // Backfill observed (native Module._resolveFilename) resolutions BEFORE the stasis-core
    // BFS. On native-resolve Node a resolve-only edge to a stasis-core src/*.js submodule
    // (e.g. require.resolve('@exodus/stasis-core/prune') of a module never loaded) is added
    // only here; running the BFS first would compute its missing-set without that edge, never
    // seed the file, and ship a dangling edge with no bytes -- which a later lock=frozen replay
    // rejects. Recording it first lets the BFS capture the bytes. Order is otherwise
    // independent: the BFS doesn't read #observedResolutions, and observe-backfill's `bundled`
    // check sees files loaded during capture regardless of when the BFS runs.
    this.#backfillObservedResolutions()
    this.#backfillBeforeWrite()
    // writeFileSync(join(this.root, FILE_CONFIG), this.config.json)
    // Sidecars never write the lockfile -- the parent owns it; they only emit their bundle. A
    // "sidecar" here shares the parent's lockfile data structures; an independent State with
    // its own lockFile path writes its own lockfile to `config.lockFile` instead of the rootDir
    // default.
    //
    // Per-artifact compare-and-skip: each output's serialized text is compared against the
    // cached previous text and both brotli + writeFileSync are skipped when they match.
    // Critical for watch-mode rebuilds, where compiler.hooks.done fires every rebuild but the
    // graph usually doesn't change; without this, every rebuild recompresses and rewrites.

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
        // Each is a standalone v1 Bundle (cross-check on load enforces shape). hasContent gates
        // per half so an empty half is dropped under replace rather than written empty -- see
        // #emitBundle. sources/resources size is the exact emptiness test: a code bundle's
        // entries/imports are non-empty only when sources are (every parent is an addFile'd
        // source).
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

  // Produce the lockfile-shaped snapshot of everything THIS process captured, for a child to
  // hand back to the root (which never loaded what only the child did -- e.g. a Metro transform
  // worker loading babel.config.js + its preset/plugins). Runs the same backfills write() does
  // so observed native resolutions and stasis-core internal edges are materialized first.
  // Content is omitted: the snapshot carries project-relative paths + the import graph +
  // formats + entries, and the root re-reads each file's bytes from disk in mergeShard().
  shardSnapshot() {
    this.#backfillObservedResolutions()
    this.#backfillBeforeWrite()
    // Forward ONLY what THIS process observed this run -- not the baseline seeded at
    // construction. On a lock=add re-run the root seeds the same lockfile baseline (and a BUNDLE
    // run the whole graph), so re-shipping it would bloat every worker's shard (toward
    // MAX_SHARD_BYTES, past which mergeChildShards drops it) and make the root re-merge it per
    // worker. #observed holds the files addFile/addFsDir recorded this run; modules, formats AND
    // imports are all filtered to it below. (Lockfile-seeded edges/formats live in
    // #lockImports/#lockFormats, but a bundle load seeds this.imports/this.formats DIRECTLY -- so
    // we filter explicitly.) Entries are dropped: mergeShard never marks a merged file as an
    // entry, and this.entries is itself seeded.
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
    // formats: only observed files. imports: only edges whose PARENT was observed -- a child
    // adds an edge only from a file it loaded (addImport's parent is addFile'd -> in #observed),
    // so its session edges are kept while bundle-seeded edges (parent never loaded here) are
    // dropped; the root already attests those from its own seed, so nothing is lost.
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

  // Merge a child's shardSnapshot() (a serialized lockfile) into this State, as if this process
  // had loaded/read those files itself: replay each file (addFile for code + `--fs` resources,
  // addFsDir for `--fs` directory captures -- re-reading bytes/listings from disk to hash +
  // classify) and addImport each edge. This is how the root attests files and edges ONLY a
  // forked child observed -- the child captures into its own State but is blocked from writing,
  // so without this its observations are lost. Project-relative paths are shared across the
  // process tree; URLs are reconstructed via resolve(this.root, file). Best-effort per record:
  // a path gone from disk or rejected by addFile/addImport (out of scope) is skipped rather than
  // aborting the merge -- the root's own capture stays intact.
  mergeShard(lockText) {
    const lf = Lockfile.parse(lockText)
    // A shard must describe the SAME scope as this root (children inherit scope via env).
    // Defense-in-depth: a cross-scope shard is already signature-rejected upstream, but a
    // mismatch here means a malformed/foreign shard -- refuse it rather than merge.
    assert.equal(lf.config.scope, this.config.scope, `shard scope "${lf.config.scope}" != root scope "${this.config.scope}"`)
    // Files first (so addFile records bytes/format/module identity), then edges. Merged files
    // are NEVER marked entries: a forked child's "entry" is its fork-target main (a Metro
    // worker's bootstrap), not a declared entry of the ROOT build -- recording it as one would
    // corrupt the root's entries list. The child's lf.entries is ignored here.
    for (const [dir, info] of lf.modules) {
      for (const rel of Object.keys(info.files)) {
        // moduleFileKey is the exact inverse of how the child bucketed the path -- it yields
        // `dir` (no trailing slash) for a directory captured AT a bucket root (rel==='').
        const file = moduleFileKey(dir, rel)
        // Skip a file the root already attests -- its seeded lockfile baseline or its own capture
        // this run. A child need only contribute what the root didn't observe; re-reading an
        // already-recorded file from disk (per worker shard) is the dominant merge cost, and
        // since this loop adds to this.hashes, identical toolchain files from later workers skip
        // too. EXCEPTION: still carry a concrete code format the root LACKS. If the root fs-READ
        // this `.js`/`.ts` (addFsFile records the hash but NO format) while the child IMPORTED it
        // as `module`, dropping the format would leave the lockfile format-less and make a later
        // frozen run -- where it loads as module -- reject the now-unattested format. Fall through
        // so addFile records (and validates) the format; the byte re-read is the only cost.
        if (this.hashes.has(file)) {
          const shardFormat = lf.formats?.get(file)
          if (shardFormat === undefined || (this.formats.get(file) ?? this.#lockFormats?.get(file)) !== undefined) continue
        }
        const absolute = resolve(this.root, file)
        const url = pathToFileURL(absolute).toString()
        const format = lf.formats?.get(file)
        try {
          if (format === 'directory') {
            // A child's `fs.readdirSync` capture (`--fs`): replay as a directory listing (addFile
            // rejects a directory). Re-read the listing from disk so the root's hash is
            // authoritative (disk-is-truth, like the byte re-reads below). Range-check the path
            // FIRST: addFsDir rejects a traversal but only AFTER readdirSync ran on the forged
            // path, so a child-forged `..` key can't make us list it.
            const relFromRoot = relative(this.root, absolute)
            if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue
            this.addFsDir(url, readdirSync(absolute))
          } else if (format === 'resource' || format === 'resource:base64') {
            // A child's `fs.readFileSync` capture of an asset: addFile needs resource:true. The
            // exact 'resource' vs 'resource:base64' tag is content-derived, so addFile re-derives
            // it from the re-read bytes -- we don't pass it (risking a spurious mismatch), just
            // mark it a resource.
            this.addFile(url, { resource: true })
          } else if (format === undefined) {
            // Code file the child recorded with NO format -- it fs-READ a `.js`/`.ts` (or
            // `.jsx`/`.tsx`), where addFsFile defers module-vs-commonjs to the loader. Replay the
            // same way (inferFormat:false): record the bytes but impose no format, so we don't
            // bake in the legacy commonjs default and collide -- at the frozen format check or
            // noupsert -- with the `module` the loader records when the file is later imported.
            // (Babel reading a worker's source `.js` under `--fs --child-process` is this case.)
            this.addFile(url, { inferFormat: false })
          } else {
            // Code file with a concrete loader format the child recorded (it imported the file, or
            // fs-read an unambiguous `.mjs`/`.cjs`/`.json`). Carry it: without it, a child-only ESM
            // `.js`/`.ts` under a no-`type` package would re-default to commonjs, and the frozen
            // run -- where it re-loads as module -- would reject the mismatch. addFile still
            // asserts the format agrees with an explicit package.json `type`, so no wrong format
            // can smuggle through.
            this.addFile(url, { format })
          }
        } catch {
          // A file the child loaded but gone/unreadable here, or that addFile rejects (an
          // out-of-scope path): skip it. The edge replay below tolerates the gap the same way.
        }
      }
    }
    // Payload-free stat records (`--fs` lstat/stat captures) live ONLY in the shard's formats
    // map -- no module-files entry -- so the modules loop above never visits them. Replay each
    // by re-deriving the kind from DISK (disk-is-truth: a shard can't inject a forged kind),
    // via addFsStat so a path the root already attests with content is skipped. Range-check the
    // path BEFORE touching disk, like the directory branch; a path gone from disk (or of an
    // unmodelled kind, e.g. a socket) is skipped, best-effort like every other replay.
    if (lf.formats) {
      let realRoot // resolved once, on the first record: the containment anchor below
      for (const [file, format] of lf.formats) {
        if (!isStatFormat(format)) continue
        const absolute = resolve(this.root, file)
        const relFromRoot = relative(this.root, absolute)
        if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue
        try {
          // statSync (follow symlinks), NOT lstatSync: the child's capture followed them -- a
          // statSync of an in-root symlink records the TARGET's kind keyed at the requested path
          // (pnpm's public node_modules/<pkg> links), and an lstat of a symlink was never
          // recorded. So for every key a legitimate shard carries, statSync reproduces the kind
          // while lstatSync would report the link itself and silently drop the record.
          const stats = statSync(absolute)
          const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null
          if (kind === null) continue
          // Because statSync follows links, re-assert the capture side's containment (fs.js
          // captureStat's realContained) before attesting: the REAL location must stay inside
          // the root's real path, so a shard entry keyed at an in-root symlink pointing OUT of
          // the tree is skipped, never recorded.
          if (realRoot === undefined) {
            try { realRoot = realpathSync(this.root) } catch { realRoot = this.root }
          }
          const relReal = relative(realRoot, realpathSync(absolute))
          if (relReal !== '' && (relReal.startsWith('..') || isAbsolute(relReal))) continue
          this.addFsStat(pathToFileURL(absolute).toString(), kind)
        } catch {
          // Gone from disk (or a dangling link), or rejected (kind conflict with the root's
          // own capture): skip -- the root's capture stays intact.
        }
      }
    }
    if (lf.imports) {
      for (const [conditions, byParent] of lf.imports) {
        // Reverse #conditionsKey: '*' stays '*'; otherwise a ', '-joined condition list,
        // optionally suffixed ' (with: {json})' for import attributes. Toolchain edges (CJS
        // require) carry none; parse them when present so attributed edges merge under the same
        // key the child recorded.
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

  // Emit one bundle artifact, returning its new "last serialized" cache value.
  //   - empty (hasContent === false) under bundle=replace: this run carries nothing for this
  //     artifact, so DELETE any file at `path` rather than write an empty bundle. A replace run
  //     is authoritative -- it ignores the prior on-disk bundle, so a stale file the run didn't
  //     produce must not survive as the "old one". Returning null resets the cache so a later
  //     non-empty write() (watch-mode rebuild) re-emits the file.
  //   - otherwise (has content, OR empty under add): serialize and write, skipping brotli +
  //     writeFileSync when the text is byte-identical to the last write (the watch-mode
  //     compare-and-skip). add keeps emitting an empty bundle so the file always exists -- only
  //     replace prunes a not-written artifact.
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

  // Capture stasis-core's own files + internal edges the live hooks missed. When app code (or
  // a bundler plugin) imports a stasis-core module, Node had it cached from preload-time --
  // BEFORE install() registered our hooks -- so the resolve hook records the edge but the load
  // hook never fires, leaving addFile/addImport blind to the file's bytes AND its outgoing
  // edges. This BFS, scoped strictly to the `<root>/.../@exodus/stasis-core/src/<name>.js`
  // shape, walks the graph from missing-imports targets + already-captured stasis-core files:
  // for each, addFile (asserting the shape), statically scans for relative-`.js` specifiers,
  // resolves, and addImports each edge. The strict shape allowlist + existsSync gate filter out
  // comment-noise like a `require('../../pkg/x')` in a JSDoc block.
  //
  // Called from write() so every State variant (preload via beforeExit/exit; sidecar /
  // independent plugin States via compiler.hooks.done) gets the same coverage.
  #backfillBeforeWrite() {
    // List what the live hooks missed first. An empty list means nothing to do -- either the
    // live hooks captured everything (the common case for non-preload runs and plugin-driven
    // States that don't touch preload-cached modules), or we're a State variant that doesn't
    // observe imports at all.
    const missing = this.#collectMissingImportedFiles()
    if (missing.size === 0) return

    const isStasisCoreFile = (file) => STASIS_CORE_FILE_RE.test(`/${file}`)

    // Split the uncaptured targets. stasis-core's own preload-cached files are the one case we
    // both can and must reconstruct -- bytes AND transitive edges (the BFS below). Everything
    // else uncaptured is a resolution we attest WITHOUT bundling: require.resolve() of a module
    // never loaded in-process, or a file Node can't serve from a bundle anyway (a .node addon).
    // Those edges stay in this.imports (the user needs the resolution pinned even without the
    // bytes) and we do nothing further with them here. The load-time getFile gate, not this
    // capture-time pass, enforces the trust boundary: an actual load of un-bundled bytes still
    // fails closed there, while require.resolve (which never loads) is served the attested path.
    const stasisCoreMissing = [...missing].filter((file) => isStasisCoreFile(file))
    if (stasisCoreMissing.length === 0) return

    const preloadRel = this.#preloadRoot ? relative(this.root, this.#preloadRoot) : null
    const canBackfill = preloadRel !== null && !preloadRel.startsWith('..')

    // stasis-core files to reconstruct but no usable preloadRoot (no loader present, or
    // stasis-core is a workspace sibling not under state.root): nothing this method can do, and
    // an uncaptured stasis-core source IS a real gap -- the bundle would be missing part of its
    // own runtime. Fail loud rather than silently ship it.
    assert.ok(canBackfill,
      `state.write() has imports referencing un-captured stasis-core files but no usable preloadRoot ` +
      `(preloadRoot=${this.#preloadRoot ?? 'unset'}). The live load hook missed an in-scope target -- ` +
      `investigate rather than silently patch: ${stasisCoreMissing.slice(0, 3).join(', ')}`)

    const PRELOAD_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons']
    const stasisAddFile = (file) => {
      // Tight invariant: every backfilled file MUST match the stasis-core source-file shape.
      // The caller pre-filters via isStasisCoreFile, but asserting here keeps the contract
      // local and catches any future code path that forgets.
      assert.ok(isStasisCoreFile(file),
        `state.write() backfill refused: '${file}' is not a stasis-core source file ` +
        `(expected '.../@exodus/stasis-core/src/<name>.js')`)
      this.addFile(pathToFileURL(resolve(this.root, file)).toString(), { reason: null }) // backfill is a write-time self-containment step, not a consumer observation -- don't attribute it
    }

    // BFS through stasis-core's module graph. Seed:
    //   (a) the missing stasis-core files -- user-code -> stasis-core edges the live load hook
    //       missed because Node's module cache short-circuited it.
    //   (b) every stasis-core file already in sources -- a static `stasis bundle` pass may have
    //       pulled one in via the live hook; we still need to walk its transitive imports.
    //
    // For each queued file: addFile if not yet captured, scan its source for relative-`.js`
    // specifiers, validate the resolved target, addImport the edge, and queue the target. The
    // single addFile site covers seeds AND transitive targets (a queued target gets addFile'd on
    // its next pop). BFS converges because the matching file set is finite and `processed` dedups.
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
      // (1) ESM `from './<name>.js'|'.cjs'\n` -- stasis-core's source import shape
      // (`import/export ... from`, single-quoted, basename without `.`). Tight enough to ignore
      // JSDoc / template-literal false positives, narrow enough to reject parent-relative
      // (`../`), subpath (`./dir/file.js`), or extensionless. The `.cjs` arm covers state.js ->
      // ./package.cjs (the version re-export shim).
      for (const m of source.matchAll(/ from '(\.\/[a-zA-Z-]+\.c?js)'\n/g)) recordEdge(m[1])
      // (2) CJS `require('../package.json')` -- the single CommonJS shim (src/package.cjs)
      // re-exporting stasis-core's own package.json so state.js can read its version. Matched
      // exactly (not a general require/`../` relaxation) to stay as tight as the ESM arm.
      for (const m of source.matchAll(/require\('(\.\.\/package\.json)'\)/g)) recordEdge(m[1])
    }
  }

  // Project-relative files referenced by `this.imports` that the live hooks didn't capture
  // into this.sources/this.resources, restricted to the in-scope set (full: everything under
  // state.root; nm: only node_modules). Out-of-scope files are NOT included -- the live hooks
  // correctly skip them (workspace files under nm-scope), and including them would force the
  // backfill caller to wave away false alarms.
  #collectMissingImportedFiles() {
    const missing = new Set()
    for (const [, byParent] of this.imports) {
      for (const [, specifiers] of byParent) {
        for (const [, file] of specifiers) {
          if (typeof file !== 'string') continue
          if (missing.has(file)) continue
          // Union of "captured" signals: hashes (addFile ran -- present under any lock mode)
          // and sources/resources (bundle pre-seeded -- present under bundle=load even without
          // a lockfile). Any one suffices; a file in NONE is the actual missing case.
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

// Allowed shape for a backfillable stasis-core path -- a `src/<name>.js`/`.cjs` source, or
// the package's own `package.json` (required by the src/package.cjs version shim). Used by the
// backfill BFS to reject anything that doesn't look like a real stasis-core file (comment
// noise, paths escaping `src/`). Matched against `/${projectRelativeFile}` so the leading-`/`
// anchor isn't fooled by a project-root file ending in `@exodus/stasis-core/...`. Source
// basenames are `[a-zA-Z-]+` only -- no `.` -- which is why `state.util.js` became
// `state-util.js`.
const STASIS_CORE_FILE_RE = /\/@exodus\/stasis-core\/(?:src\/[a-zA-Z-]+\.c?js|package\.json)$/

