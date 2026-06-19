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
import { fileMapToObject, moduleFileKey, objectToMaps, splitNodeModulesPath } from './util.js'

// Object-destructure off the namespace rather than `import { ... } from 'node:fs'`:
// the destructured `const` captures function values at this module's eval time, so
// stasis keeps writing through the real fs even after --mock (loaded after us) calls
// module.syncBuiltinESMExports() to refresh node:fs's ESM wrapper for user code.
// Direct ESM destructured imports are live bindings and would re-resolve to the
// mocked names when state.write() fires on beforeExit.
const { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = fs

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'

// Extensions Node's CommonJS loader tries for an extensionless require() (and for
// a directory's index.*). Used by the bundle file-set fallback in resolveBundled.
const CJS_EXTENSIONS = ['.js', '.json', '.node']

// Extensions an `fs.readFileSync` capture records as code (its Node loader format),
// rather than as a 'resource'. Exactly the set addFile's extToFormat can infer a
// format for -- `.js`/`.ts` resolve to module/commonjs via the nearest package
// `type`, the rest map unambiguously. Any other extension (and any of these whose
// bytes aren't UTF-8) falls back to 'resource'/'resource:base64'. Kept in sync with
// addFile's extToFormat below.
const FS_CODE_EXTENSIONS = new Set(['.json', '.mjs', '.cjs', '.mts', '.cts', '.js', '.ts'])

function readPackageJSON(pkgAbsolute) {
  const buf = readFileSync(pkgAbsolute)
  assert.ok(isUtf8(buf))
  return JSON.parse(buf.toString())
}

// TODO: stricter format validation

let preload
const liveStates = new Set()

// Process-wide write-target claim registry: every write-mode State adds its
// bundleFile, resourcesBundleFile, and lockFile (canonicalized) here at
// construction; a second writer claiming the same path throws. Module-level
// rather than per-State because several write-intent States can be live in one
// process -- a parent and its sidecars, plus any independent top-level State a
// CLI/env run constructs (e.g. with a custom config.lockFile) -- each with its
// own per-instance registry, so a per-State Set would miss a cross-State
// collision. Canonicalize via realpathSync-when-extant + lexical-resolve
// fallback so a symlinked `/x/lock.json -> /shared/lock.json` and the literal
// `/shared/lock.json` compare equal. Read-only modes (load / frozen) don't
// claim -- they legitimately point at a path the writer produced.
const claimedPaths = new Map()

function claimWritePath(label, value) {
  if (!value) return
  const canonical = canonicalizePath(value)
  const existing = claimedPaths.get(canonical)
  assert.ok(existing === undefined,
    `${label} '${value}' is already claimed by ${existing} of another live State`)
  claimedPaths.set(canonical, label)
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

  // For a parent: the set of sidecar States constructed against it. The unified
  // lockfile (built by the parent's lockData via #mergedImports/#mergedFormats)
  // must union the parent's own imports / formats with every sidecar's, otherwise
  // resolution edges and format attestations a sidecar bundler-plugin observed
  // (sidecar.addImport / addFile populate sidecar-local this.imports/this.formats)
  // would never reach the lockfile. Hashes / entries / modules are already shared
  // by reference; this closes the same gap for imports and formats. Unused on
  // sidecars themselves.
  #sidecars = new Set()

  // Resolutions attested by the loaded lockfile (conditions -> parent ->
  // specifier -> file), or null when no lockfile was loaded / it predates
  // resolution attestation. Kept separate from this.imports (the live
  // observed/bundle-served map): the lockfile may attest a superset of what a
  // given run observes or a given bundle carries.
  #lockImports = null

  // Loader formats attested by the loaded lockfile (file -> format), or null
  // when none was loaded / it predates format attestation. Like #lockImports,
  // kept apart from this.formats (the live observed/bundle-served map).
  #lockFormats = null

  // True iff this State (or, for a sidecar, its parent) loaded a lockfile from
  // disk during construction. Drives #mergeBundleMetadata's cross-check-vs-absorb
  // branch: with a lockfile, the bundle's metadata must agree with the lockfile's
  // attestations; without one, the bundle's metadata is absorbed as the source of
  // truth. Sidecars inherit this from the parent at construction time so a sidecar
  // bundle is cross-checked against the parent's lockfile attestation rather than
  // silently trusted.
  #lockfileLoaded = false

  // Files, resolutions, and formats attested by a frozen bundle (bundle=frozen),
  // or null when no frozen bundle was loaded. A frozen bundle plays the same
  // read-only attestation role a frozen lockfile does, but anchored in the
  // bundle's own bytes -- so bundle=frozen needs no sibling lockfile. The byte
  // check itself is the noupsert of observed disk content into this.sources/
  // this.resources (both pre-seeded from the bundle); these sets/maps close the
  // attested set so a file, resolution, or format the bundle never recorded is
  // rejected. Kept separate from the live this.sources/this.imports/this.formats,
  // which addFile/addImport mutate.
  #bundleSources = null
  #bundleResources = null
  #bundleImports = null
  #bundleFormats = null

  // Lazily-built reverse index over the bundle's recorded resolutions, memoizing
  // the under-recorded fallbacks in resolveBundled (see #bundleIndex). Only ever
  // built/used in load mode, where this.imports / this.sources are immutable after
  // construction, so a single build is safe.
  #bundleResolveIndex = null

  // Lazily-built set of directory paths IMPLIED by the bundle's recorded entries
  // (files, resources, directory listings): a recorded `node_modules/dep/index.js`
  // proves `node_modules` and `node_modules/dep` exist as directories even though
  // neither was readdir'd. getFsStat consults it so
  // `fs.statSync('node_modules').isDirectory()` succeeds at bundle=load. Same load-mode
  // immutability assumption as #bundleResolveIndex, so a single build is safe.
  #impliedDirIndex = null

  // Capture-time native resolutions (parent URL -> specifier -> resolved URL)
  // observed via the Module._resolveFilename shim: require.resolve() and any CJS
  // require() that bypasses the resolve hook. write()'s backfill records the edges
  // the hook missed (deduped, in-bundle targets only). Populated only during capture.
  #observedResolutions = new Map()

  // Node's require-condition set (e.g. ['require', 'node', 'node-addons',
  // 'module-sync'], plus any --conditions), captured the first time addImport sees a
  // require()-context edge. require()/require.resolve() resolve under THESE conditions
  // -- they honor the `require` branch of conditional `exports`, so they're not
  // condition-free -- so #backfillObservedResolutions keys the native
  // (Module._resolveFilename) edges it recovers under this set rather than the
  // wildcard '*'. That matches what the resolve hook records directly (newer Node) and
  // unifies them with the require() bucket, so any capture that does at least one
  // require() (the common case) yields the same lockfile on every Node version. null
  // until observed -- a capture that ONLY require.resolve()s and never require()s
  // leaves it null and backfill falls back to '*' (as before this change), which the
  // getImport/resolveBundled wildcard fallbacks still match.
  #requireConditions = null

  // Absolute path of a package whose source files were loaded by Node BEFORE
  // our hooks registered (the preload-cached set). Set by the loader's
  // initState to stasis-core's own root; sidecars inherit it from their
  // parent so plugin-driven write()s also backfill internal edges. write()'s
  // backfill statically parses each file under this root and addImports its
  // relative-specifier edges -- recovering the (state.js -> config.js)-shape
  // edges that the live resolve hook never observed.
  #preloadRoot = null

  // Per-artifact "last serialized" caches: write() compares the freshly serialized
  // JSON text against the cached one for each output (lockfile / unified bundle /
  // split code / split resources) and skips both the brotli step and the writeFileSync
  // when they match. Brotli at quality 11 dominates write cost, and webpack/esbuild
  // watch-mode rebuilds call write() on every rebuild whether or not the captured
  // graph actually changed -- this cache makes those no-ops fast. Persistent across
  // write() calls within one process; null on the first call.
  #lastLockData = null
  #lastUnifiedBundle = null
  #lastCodeBundle = null
  #lastResourcesBundle = null

  // Options:
  //   preload (boolean) -- register as the unique preload State (exposed via State.preload).
  //     Only one preload may exist at a time. The stasis loader is the only real caller.
  //   parent (State)    -- run as a sidecar of this parent. Sidecar shares the parent's
  //     hashes/entries/modules (so addFile updates the unified lockfile through them) but
  //     manages its own sources/formats/imports/resources and emits its own bundle file.
  //     write() on a sidecar skips the lockfile (parent owns it) and only writes its bundle.
  //   All other keys forward to Config.
  constructor(root, options = {}) {
    const { preload: isPreload = false, parent: parentState, preloadRoot, ...configOptions } = options
    this.config = new Config(configOptions)
    if (isPreload) assert.ok(!preload, 'Only one preload Stasis instance is supported')
    assert.ok(!(isPreload && parentState), 'preload and parent are mutually exclusive')

    if (parentState) {
      // Sidecar mode: short-circuit the on-disk discovery path. Lockfile data is shared by
      // reference with the parent; only the sidecar's bundleFile (if any) is parsed here.
      this.#parent = parentState
      this.root = parentState.root
      this.hashes = parentState.hashes
      this.entries = parentState.entries
      this.modules = parentState.modules
      // Sidecar inherits the parent's preloadRoot so plugin-driven write()s
      // (StasisWebpack / StasisEsbuild done-hook saves) backfill stasis-core's
      // internal edges the same way the parent does.
      this.#preloadRoot = parentState.#preloadRoot
      // Inherit the parent's lockfile attestation maps so #mergeBundleMetadata
      // cross-checks the sidecar bundle against the same attestation the parent
      // already loaded. Without this the sidecar would silently trust whatever
      // formats / imports its own bundle declared, opening a hole where a
      // tampered sidecar bundle could redirect a resolution or flip a format
      // (commonjs <-> module-typescript) for hash-valid bytes -- the byte check
      // alone doesn't cover that.
      this.#lockImports = parentState.#lockImports
      this.#lockFormats = parentState.#lockFormats
      this.#lockfileLoaded = parentState.#lockfileLoaded
      assert.ok(this.config.bundleFile, 'sidecar State requires bundleFile')
      // Claim the bundleFile (and resourcesBundleFile under the split layout) via the
      // process-wide registry so two write-intent States anywhere -- whether a sibling
      // sidecar or an independent top-level State (a CLI/env run with a custom
      // lockfile/bundle path) -- can't silently target the same on-disk file
      // (last-write-wins on `beforeExit`). Only writing
      // States claim; read-only modes (load / frozen) may legitimately share a path
      // with the writer that produced the file. The Config's own pairwise cross-path
      // check (config.js:#checkInvariants) already rejects intra-State collisions, so
      // claimWritePath only fires on cross-State conflicts.
      if (this.config.writeBundle) {
        claimWritePath(`sidecar bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
        if (this.config.resourcesBundleFile) {
          claimWritePath(`sidecar resourcesBundleFile '${this.config.resourcesBundleFile}'`,
            this.config.resourcesBundleFile)
        }
      }
      // frozenBundle MUST go through this branch alongside write/load -- it has its
      // own attestation snapshot to build, and was previously missed (silently
      // skipping parsing made the post-construction frozen-bundle invariant
      // unreachable on the sidecar path).
      if (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) {
        const sourcesPath = this.config.bundleFile
        const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
        if (sources && !this.config.replaceBundle) {
          const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
          // Same v0 refusal as the main load path: a v0 bundle has no per-file
          // formats and no import map, so serving / verifying one through a
          // sidecar would silently widen trust.
          assert.equal(bundle.version, Bundle.VERSION,
            `stasis sidecar requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
            `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point.`)
          assert.equal(bundle.config.scope, this.config.scope)
          // Cross-check the sidecar bundle's metadata against the parent's lockfile
          // (or absorb if no lockfile was loaded). hashes/entries/modules are shared
          // with the parent, so #mergeBundleMetadata's writes -- when no lockfile is
          // loaded -- propagate into the unified attestation.
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
      // throw never leaves a dead reference in the parent's #sidecars registry.
      // Gated on writeBundle: load / frozen sidecars are CONSUMERS -- they read
      // attestations from their bundle but must not contribute to the parent's
      // lockfile (the bundle has its own integrity story, and under `lock=add`
      // with no prior lockfile a load-mode sidecar would otherwise silently make
      // the bundle's content the lockfile's source of truth). Write-mode sidecars
      // ARE contributors -- their addImport / addFile observations have to land
      // in the unified lockfile, otherwise a `lock=frozen` re-run rejects them
      // as unattested.
      if (this.config.writeBundle) parentState.#sidecars.add(this)
      liveStates.add(this)
      return
    }

    // Preload-uniqueness invariant must be checked before construction proceeds; the
    // actual `preload = this` registration happens after construction succeeds so a
    // throw in setup can't leave a half-built preload reference behind.
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
    // When `config.lockFile` is set, the lockfile lives at that explicit path -- not at
    // join(rootDir, FILE_LOCK) for any candidate rootDir. Suppress the per-rootDir read
    // for root-detection (so a stale stasis.lock.json at the project root can't shadow
    // the explicit one), then substitute the explicit content once root-detection has
    // committed to a rootDir below.
    const explicitLockPath = this.config.lockFile
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, FILE_CONFIG, 'utf-8')
      const lockProbe = explicitLockPath ? null : readFileSyncMaybe(rootDir, FILE_LOCK, 'utf-8')
      const sourcesPath = this.config.bundleFile || join(rootDir, FILE_CODE)
      const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
      if (config !== null || lockProbe !== null || sources !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = rootDir

        if (config) this.config.loadConfig(config)

        // Resolve the effective lockfile content + path for this run. With an explicit
        // `config.lockFile`, the lockfile is at that exact path (loaded once, not at a
        // per-rootDir probe); without one, fall back to `<rootDir>/stasis.lock.json`.
        const lock = explicitLockPath
          ? readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
          : lockProbe
        const lockPath = explicitLockPath || join(rootDir, FILE_LOCK)

        if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
          throw new Error(`Unexpected ${lockPath} with config.lock = 'none'`)
        }
        if (sources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle && !this.config.frozenBundle) {
          throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
        }

        // A frozen bundle is self-attesting -- it verifies disk against the bundle's
        // own bytes, so (unlike load/add) it needs no sibling lockfile and is exempt
        // from this "a lockfile is required before a bundle's sources can be trusted"
        // guard. This is what lets bundle=frozen compose with lock=add (bootstrapping a
        // fresh lockfile from the verified run) without a pre-existing lockfile.
        if (sources && !lock && this.config.useLockfile && !this.config.replaceLockfile && !this.config.frozenBundle) {
          throw new Error('stasis.lock.json missing, can not use sources')
        }

        if (lock && this.config.useLockfile && !this.config.replaceLockfile) {
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
          // Frozen promises verification, but a lockfile predating resolution
          // or format attestation can only vouch for bytes -- those metadata
          // (from a bundle OR observed on disk) go unchecked until it's
          // regenerated.
          if (this.config.frozen && this.#lockImports === null) {
            console.warn('[stasis] Warning: lockfile does not attest resolutions; they are trusted as-is. Regenerate the lockfile to enable this check.')
          }
          if (this.config.frozen && this.#lockFormats === null) {
            console.warn('[stasis] Warning: lockfile does not attest formats; they are trusted as-is. Regenerate the lockfile to enable this check.')
          }
          lockfileLoaded = true
          this.#lockfileLoaded = true
        }

        if (sources && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
          // One unified bundle carries both code and resources. Split the flat file
          // view into this.sources (code) and this.resources (resource payloads --
          // raw UTF-8 for 'resource', base64 for 'resource:base64') by format.
          const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
          // `Bundle.parse` accepts v0 for offline tooling (`stasis extract`, `diff`,
          // `audit`, `sbom`) -- it has the metadata those commands need. The runtime
          // path is stricter: a v0 bundle has no per-file `formats` attestation
          // (resources can't be distinguished from code, the loader can't pick
          // module-vs-commonjs) and no import map (resolution edges go unchecked),
          // so serving / verifying one under `stasis run` would silently widen the
          // trust boundary. Refuse it explicitly and point at the upgrade path.
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
            // Snapshot the attested sets before addFile/addImport mutate the live maps.
            // imports is deep-cloned (this.imports shares bundle.imports's nested Maps,
            // which addImport extends); formats is a flat file->string map, so a shallow
            // copy suffices. Code and resource file sets are tracked separately to match
            // addFile's per-kind frozen-bundle membership check.
            this.#bundleSources = new Set(this.sources.keys())
            this.#bundleResources = new Set(this.resources.keys())
            this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
            this.#bundleFormats = new Map(bundle.formats)
          }
        }

        // Split-bundle layout: when `resourcesBundleFile` is configured, resources
        // live in a separate file. Load it as a standalone Bundle (entries empty,
        // imports empty, formats restricted to resource tags) and union into the
        // state already absorbed from `bundleFile`. The strict-shape asserts catch
        // a writer that accidentally leaked code into the resources file or a
        // tampered file claiming entries/imports it shouldn't have.
        if (this.config.resourcesBundleFile) {
          const resourcesPath = this.config.resourcesBundleFile
          const resourcesData = readFileSyncMaybe(dirname(resourcesPath), basename(resourcesPath))
          if (resourcesData && (this.config.writeBundle || this.config.loadBundle || this.config.frozenBundle) && !this.config.replaceBundle) {
            this.#absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath })
          }
        }
      }
    }

    // Explicit lockfile path with no other discovery indicator at any rootDir: the
    // discovery loop never set `loaded`, so the lockfile branch above never ran. Process
    // the explicit lockfile here against the already-resolved `this.root` (outermost
    // package.json) so the run still has its attestation. Inlines the same gates as the
    // in-loop branch -- a future refactor could merge the two by extracting a helper.
    if (!loaded && explicitLockPath) {
      const lock = readFileSyncMaybe(dirname(explicitLockPath), basename(explicitLockPath), 'utf-8')
      if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
        throw new Error(`Unexpected ${explicitLockPath} with config.lock = 'none'`)
      }
      if (lock && this.config.useLockfile && !this.config.replaceLockfile) {
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
        if (this.config.frozen && this.#lockImports === null) {
          console.warn('[stasis] Warning: lockfile does not attest resolutions; they are trusted as-is. Regenerate the lockfile to enable this check.')
        }
        if (this.config.frozen && this.#lockFormats === null) {
          console.warn('[stasis] Warning: lockfile does not attest formats; they are trusted as-is. Regenerate the lockfile to enable this check.')
        }
        lockfileLoaded = true
        this.#lockfileLoaded = true
      }
    }

    // Frozen modes must have actually loaded their attestation. Asserting here --
    // after the discovery loop -- rather than only inside it closes a fail-open: with
    // no stasis files on disk at all the loop body never runs, so a per-rootDir guard
    // would never fire, and in node_modules scope the workspace entry sits outside the
    // attested zone (its bytes/format/resolutions aren't checked), letting it execute
    // unverified. A frozen run with nothing to verify against must fail closed instead.
    if (this.config.frozen) assert.ok(lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
    if (this.config.frozenBundle) assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')

    // Register only after every fallible step succeeds, so a thrown error during config
    // discovery / lockfile / bundle parsing leaves the registry untouched. Claim this
    // State's write targets in the process-wide registry so a sidecar OR an independent
    // top-level State (a CLI/env run with a custom lockfile/bundle path) constructed
    // against the same path can't silently target the same file. Load / frozen / no-bundle modes don't claim --
    // they legitimately read what a previous writer produced. lockFile is claimed too
    // (only by writing parents -- sidecars don't write the lockfile and the explicit
    // path may legitimately point at the parent's lockfile under unification).
    if (this.config.writeBundle && this.config.bundleFile) {
      claimWritePath(`bundleFile '${this.config.bundleFile}'`, this.config.bundleFile)
    }
    if (this.config.writeBundle && this.config.resourcesBundleFile) {
      claimWritePath(`resourcesBundleFile '${this.config.resourcesBundleFile}'`, this.config.resourcesBundleFile)
    }
    if (this.config.writeLockfile && this.config.lockFile) {
      claimWritePath(`lockFile '${this.config.lockFile}'`, this.config.lockFile)
    }

    // preloadRoot is opt-in -- only the runtime loader (hooks.js's initState)
    // sets it, pointing at stasis-core's own package root. Plain top-level
    // States constructed via the CLI / direct API leave it null and skip
    // the internal-edges backfill entirely.
    if (preloadRoot !== undefined) {
      assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
      this.#preloadRoot = preloadRoot
    }

    if (isPreload) preload = this
    liveStates.add(this)
  }

  // Cross-check bundle metadata (entries/modules) with what the lockfile already
  // loaded, or absorb it as the source of truth when no lockfile is present.
  // v0 bundles infer `name` from path for node_modules buckets but carry no
  // version; the workspace "." bucket has no inferable name. We skip entries
  // we can't cross-check (no name with lockfile, or no version when populating
  // state.modules — addFile later asserts strict name+version equality against
  // disk's package.json, which would clash with a null we stashed earlier).
  // Note: the path-inferred name for v0 will disagree with the lockfile when a
  // dep is installed under an alias (`foo: npm:bar` writes `node_modules/foo`
  // with `name: "bar"` in package.json); the strict equality below will fail
  // in that case, which is the right call — the v0 bundle has no way to
  // attest the real package identity, so we refuse to silently mismatch.
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
      // Resolutions: every edge the bundle could serve must land on the file
      // the lockfile attests for that (parent, specifier) -- source hashes
      // alone don't close this hole: a tampered bundle could redirect a
      // specifier to a *different* hash-valid file. Unknown edges are fatal.
      // The lockfile may attest a superset (same stance as the file lists
      // above). Lockfiles that predate resolution attestation
      // (imports === null) skip the check -- regenerate with lock=replace.
      if (this.#lockImports !== null) {
        for (const [conditions, byParent] of bundle.imports) {
          for (const [parent, specifiers] of byParent) {
            for (const [specifier, file] of specifiers) {
              this.#assertAttestedResolution(this.#lockImports, conditions, parent, specifier, file, { what: 'bundle', source: 'lockfile' })
            }
          }
        }
      }
      // Formats: the loader picks module<->commonjs and (for *-typescript)
      // whether Node strips type syntax purely from this map, so a tampered
      // bundle can change how hash-valid bytes parse/run without touching a
      // hash. Every format the bundle declares must match the lockfile's. The
      // bundle's file set is a subset of the lockfile, so an unattested format
      // is fatal here (it can only mean a forged entry).
      if (this.#lockFormats !== null) {
        for (const [file, format] of bundle.formats) {
          this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'bundle', source: 'lockfile' })
        }
        // Inverse direction: if the lockfile tags a file the bundle carries as a
        // resource, the bundle MUST declare the matching resource format. Without
        // this, a tampered bundle could OMIT the resource tag entirely -- State.load
        // would then see no resource format, route the base64 payload through
        // `this.sources` (the code path), and hand it to the loader. Caught at the
        // loader's NODEJS_FORMATS gate too, but checking here surfaces it as a clean
        // bundle/lockfile mismatch rather than as an opaque "unknown format" later.
        // (We don't extend this to code formats: doing so would mean asserting
        // `formats` is total over `modules`, which is a stronger schema invariant
        // than the historical "format may be missing per file" contract -- and the
        // code-format hole is closed by the loader allowlist anyway.)
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
          // A unified bundle populates `state.modules` from both its code and resource
          // entries; if the same dir is added twice (e.g. legacy duplicated metadata)
          // they must agree on name/version.
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

  // Load the resources side of a split-bundle layout: a standalone Bundle file
  // that MUST hold only resource-format files (no entries, no imports, no
  // code-format declarations). Unions into the state already absorbed from
  // `bundleFile`, extending this.resources, this.formats, and -- under
  // frozenBundle -- the attestation snapshots. The shape asserts catch a writer
  // that leaked code into the resources file or a tampered file claiming
  // metadata it shouldn't carry.
  #absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath }) {
    const bundle = Bundle.parse(brotliDecompressSync(resourcesData).toString('utf-8'))
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 resources bundle; ${resourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // Resources file MUST NOT declare resolution edges or entry points -- those
    // belong to the code bundle. A populated map here means the writer mixed
    // halves (or the file was tampered with) and serving it would silently widen
    // trust on the code-bundle side's metadata.
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
      // (resources-only deployments are legal -- only the resources file exists),
      // so initialize lazily; #bundleSources may stay null in that case, which the
      // post-discovery invariant check accepts because #bundleResources is set.
      if (this.#bundleResources === null) this.#bundleResources = new Set()
      if (this.#bundleFormats === null) this.#bundleFormats = new Map()
      if (this.#bundleImports === null) this.#bundleImports = objectToMaps(fileMapToObject(this.imports))
      if (this.#bundleSources === null) this.#bundleSources = new Set(this.sources.keys())
      for (const f of bundle.sources.keys()) this.#bundleResources.add(f)
      for (const [f, fmt] of bundle.formats) this.#bundleFormats.set(f, fmt)
    }
  }

  // Verify one resolution edge against an attestation map (`source`: a loaded
  // lockfile, or a frozen bundle's own recorded imports). The final resolution
  // is what matters, not how the edge is keyed: the conditions key is matched
  // exactly first; on a miss the edge is accepted only when every condition set
  // the attestation records for that (parent, specifier) agrees on the same
  // target -- this lets a static `stasis bundle` artifact (edges under '*')
  // validate against a runtime-generated attestation (precise condition sets),
  // and vice versa, while a claim over a condition-divergent attestation stays
  // fatal: either target would be served under conditions where the other is
  // the attested resolution. Unknown edges are fatal unless the caller opts out
  // (see addImport's node_modules-scope carve-out).
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
    assert.equal(file, attested, `${what} resolution ${edge} mismatches the ${source}`)
  }

  // Verify one file's loader format against an attestation map (`source`: a
  // loaded lockfile, or a frozen bundle's own recorded formats). Callers only
  // invoke this for files that must be attested (the attestation is a superset
  // of any bundle, and on the disk path the call is gated to the hash-attested
  // zone), so an unattested file means a forged/extra entry and is fatal.
  #assertAttestedFormat(attestation, file, format, { what, source = 'lockfile' }) {
    const attested = attestation.get(file)
    assert.ok(attested !== undefined, `${what} format for ${file} is not attested by the ${source}`)
    assert.equal(format, attested, `${what} format for ${file} mismatches the ${source}`)
  }

  assertEntry(url) {
    // Skipped silently when no entries info is available (v0 bundle + lock=none/ignore).
    // v1 bundles in full scope are required to declare at least one entry at parse time,
    // so this fallback only ever triggers for the legacy path.
    if (this.entries.size === 0) return
    const file = this.#canonicalFile(url)
    assert.ok(this.entries.has(file), `Unknown entry point: ${file}`)
  }

  static get preload() {
    return preload
  }

  // Back-compat accessor: returns the preload State if one exists, else the sole live State.
  // Throws when several non-preload States coexist -- callers in that situation must reach
  // for State.preload (or hold their own reference). Returns undefined when no State is live.
  static get instance() {
    if (preload) return preload
    if (liveStates.size === 0) return undefined
    if (liveStates.size > 1) throw new Error('Multiple Stasis instances; use State.preload')
    return [...liveStates][0]
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
    return file
  }

  // A file reached under node_modules whose REAL path lies outside any
  // node_modules is a workspace source linked into node_modules (pnpm links a
  // workspace dependency in via a symlink). Canonicalize such a URL to its real
  // path so it is recorded/looked up as a *source*, not a dependency -- and thus
  // excluded from a node_modules-scope bundle. Everything else is returned
  // untouched: plain sources, real dependencies, and node_modules -> node_modules
  // links (e.g. pnpm's `.pnpm` store) keep their original path.
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

  // True when `url` resolves (through any workspace symlink) to a file under
  // node_modules -- i.e. a bundled dependency -- as opposed to a workspace source
  // linked into node_modules (which #canonical records as a source). The loader
  // hooks gate on this rather than a raw `/node_modules/` substring, so a
  // symlinked workspace source is read from disk / resolved by Node instead of
  // being served from a node_modules-scope bundle that deliberately omits it.
  // Tolerant: a URL it can't canonicalize (non-file, outside root) is treated as
  // not-a-dependency, so the hook falls back to Node's default handling.
  inNodeModules(url) {
    let file
    try {
      file = this.#canonicalFile(url)
    } catch {
      return false
    }
    return splitNodeModulesPath(file) !== null
  }

  // Nearest package.json at or above a directory, for addFsDir (`stasis run --fs`
  // readdir captures). Replaces findPackageJSON, which is unreliable for a directory
  // URL (see #locateModule). Walks up using the real fs (the destructured existsSync
  // snapshot), bounded by the project root -- which is always an existing-package.json
  // dir, so an in-root directory always resolves. Returns an absolute package.json path.
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
    // Unreachable in practice: state.root is resolved to a dir that has package.json.
    assert.fail(`no package.json at or above directory ${this.relative(dirAbsolute)}`)
  }

  // Canonicalize `url` and resolve the package bucket that owns it, registering the
  // module (name/version, `npm` ecosystem under node_modules) on first sight. Shared
  // by addFile (code/resource) and addFsDir (directory captures): everything here is
  // independent of a file's bytes or loader format, so both reuse it. Returns the
  // canonical absolute path, the project-relative `file`, the bucket `dir`/`module`,
  // and the nearest package `type` (for addFile's extension inference).
  //
  // `directory: true` (addFsDir): the url names a directory, not a file. Node's
  // findPackageJSON is unreliable for a directory URL -- depending on Node version
  // it returns the PARENT's package.json, `undefined` (at a bucket root), or even a
  // `node_modules/` DIRECTORY path, which readPackageJSON would then read as a file
  // and throw EISDIR. So for a directory we walk up to the nearest package.json
  // ourselves (#nearestPackageJsonFor), which is correct on every Node version.
  #locateModule(url, { directory = false } = {}) {
    // Canonicalize first: a workspace source linked into node_modules is recorded
    // under its real (non-node_modules) path so it classifies as a source.
    const canonical = this.#canonical(url)
    url = canonical.url
    const absolute = canonical.absolute
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const closestPkgAbsolute = directory ? this.#nearestPackageJsonFor(absolute) : findPackageJSON(url)
    const closestPkg = readPackageJSON(closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')

    // findPackageJSON may land on a `{"type":"module"}`-style sub-bucket
    // marker that lacks name/version.
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
          // Allow fake module name subpaths: real module owns the prefix.
          // Npm publish wouldn't accept this anyway, so it's not a conflict.
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
      // node_modules buckets are installed dependencies; tag them with the `npm`
      // ecosystem so consumers can tell deps from the workspace's own packages
      // without re-deriving it from the path. Workspace/top-level buckets (the
      // scope=full `sources`) carry no ecosystem.
      this.modules.set(dir, nmRoot
        ? { name, version, ecosystem: 'npm', files: Object.create(null) }
        : { name, version, files: Object.create(null) })
    }
    const module = this.modules.get(dir)
    assert.equal(module.name, name)
    assert.equal(module.version, version)

    return { absolute, file, dir, module, closestType }
  }

  // `resource: true` (alias: legacy `isBinary: true`) marks the file as a resource
  // rather than code. Its format is then derived from the bytes: 'resource' for valid
  // UTF-8 (stored raw, human-readable in the bundle) or 'resource:base64' for binary
  // (base64-encoded). Code files keep their inferred loader format.
  //
  // `inferFormat: false` records the bytes WITHOUT inferring or recording any loader
  // format (an existing recorded format, if any, is left intact). addFsFile uses it
  // for `.js`/`.ts`, whose module-vs-commonjs is Node's syntax-detection call (not
  // knowable from bytes): the module loader is the authority, so the fs-read capture
  // must not impose the legacy `commonjs` default and collide with a `module` the
  // loader records for the same file when it is both imported and read.
  addFile(url, { source, format, isEntry, isBinary, resource, inferFormat = true } = {}) {
    const asResource = resource === true || isBinary === true
    // A resource format must not arrive on the code path: 'resource' /
    // 'resource:base64' identifies asset payloads, which State stores in
    // `this.resources` with content-derived encoding (UTF-8 vs base64). A caller
    // who passes the format string without setting resource:true is asking for
    // a code file tagged as a resource -- nonsense, and exactly the kind of
    // accidental misclassification the per-file format design is meant to
    // catch. The reverse (resource:true with a non-resource format) is rejected
    // below when the content-derived format is checked against any explicit one.
    if (!asResource && Bundle.isResourceFormat(format)) {
      throw new Error(`addFile: format '${format}' requires resource: true`)
    }
    // A resource can't be an entry: entries name code loaded by Node (the module
    // graph's roots), and Bundle.parse / assertEntry validate them as code-shaped
    // paths. A resource entry would land in this.entries -> codeBundle.entries
    // (state.js's split-bundle getter), producing a v1 bundle whose entries refer
    // to files absent from its sources -- structurally valid but semantically
    // broken, and the kind of misclassification that's silent at capture time and
    // surfaces opaquely at the loader's NODEJS_FORMATS gate later.
    if (asResource && isEntry) {
      throw new Error(`addFile: a resource can't be an entry (resource:true + isEntry:true)`)
    }
    // Canonicalize + bucket by the owning package (shared with addFsDir).
    const { absolute, file, dir, module, closestType } = this.#locateModule(url)

    // Resources don't get a loader format inferred from extension/package type --
    // their format ('resource' / 'resource:base64') is chosen by content below.
    // inferFormat:false (addFsFile for .js/.ts) skips inference entirely.
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
        // No `type` in the nearest package.json: Node decides .js/.ts by
        // module-syntax detection, so either variant is legitimate and the
        // caller's reported format wins. When no format was provided at all
        // (e.g. bundler plugins, whose afterResolve/onLoad pass none), defer to
        // a format already recorded for this file THIS session before falling
        // back to the legacy commonjs default. The runtime loader records Node's
        // authoritative module/commonjs choice (hooks.js's load hook), so a
        // later no-format capture of the same file must KEEP a known `module`
        // rather than re-default it to commonjs -- which would both mis-attest
        // the bundle and collide at the noupsert below (and, for a bundler
        // sidecar whose formats merge into the parent's unified lockfile, at
        // #mergedFormats). A sidecar's loader records land in the parent's
        // formats, so consult it too. Only an extension-appropriate code format
        // is reused; a stale resource tag from a conflicting prior capture falls
        // through to the default so the conflict still surfaces at noupsert.
        const variants = {
          __proto__: null,
          '.js': ['commonjs', 'module'],
          '.ts': ['commonjs-typescript', 'module-typescript'],
        }[extname(file)]
        const known = this.formats.get(file) ?? this.#parent?.formats.get(file)
        format = variants?.includes(known) ? known : variants?.[0]
      }
    }

    if (typeof source === 'string') {
      assert.ok(source.isWellFormed())
    } else {
      if (source === undefined || source === null) source = readFileSync(absolute)
      assert.ok(Buffer.isBuffer(source))
      if (!asResource) assert.ok(isUtf8(source), `File is not UTF-8: ${file}`)
    }

    const buf = typeof source === 'string' ? Buffer.from(source) : source
    assert.deepStrictEqual(readFileSync(absolute), buf)

    // Resource format is content-driven: raw UTF-8 stays 'resource' (don't base64
    // bytes that are already text); anything else is 'resource:base64'.
    if (asResource) {
      const derived = isUtf8(buf) ? 'resource' : 'resource:base64'
      if (format != null) assert.equal(format, derived, `resource format mismatch for ${file}`)
      format = derived
    }

    if (isEntry) this.entries.add(file)
    const integrity = sha512integrity(source)
    noupsert(this.hashes, file, integrity)
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    const inAttestedZone = dir.includes('node_modules') || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel))
    }

    // Frozen bundle: the observed bytes are checked against the bundle by the
    // noupsert into this.sources/this.resources below (both pre-seeded from the
    // bundle); here we close the set, rejecting a file the bundle never recorded
    // (mirrors the lockfile membership check above, anchored in the bundle). The
    // scope carve-out matches the lockfile's: node_modules scope doesn't attest
    // workspace files, so they aren't required to be in the bundle.
    if (this.config.frozenBundle && inAttestedZone) {
      const attested = asResource ? this.#bundleResources : this.#bundleSources
      assert.ok(attested?.has(file), `File not attested by the frozen bundle: ${file}`)
    }

    // Frozen runs verify the format observed on disk against the attestation, the
    // way addImport verifies resolutions: the on-disk format is derived from the
    // file extension + nearest package.json `type`, and `type` is usually not
    // itself hash-attested, so flipping it recategorizes a hash-valid file
    // (commonjs<->module, or .js<->module-typescript) with no hash mismatch.
    // Checked against the lockfile and/or the frozen bundle, each anchored in its
    // own recorded formats. Gated to the same attested zone as the hash check
    // above (the node_modules-scope workspace is deliberately unattested, like
    // its bytes); files with no derived format (binary resources) are skipped via
    // `format != null`.
    if (this.config.frozen && this.#lockFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
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

  // Record an `fs.readFileSync` capture (`stasis run --fs`, capture side). `source`
  // is the raw bytes (a Buffer). The format is "generic by extension":
  //  - an unambiguous code extension (.json/.mjs/.cjs/.mts/.cts) carrying UTF-8 →
  //    code, with the Node loader format addFile infers from the extension;
  //  - `.js`/`.ts` carrying UTF-8 → code, but with `inferFormat: false` so NO format
  //    is imposed: module-vs-commonjs is Node's syntax-detection call, the module
  //    loader is the authority for it, and forcing a default here would collide
  //    (noupsert) with the loader's record when the same file is both imported and
  //    fs-read. The loader sets the format if/when it loads the module; getFsFile
  //    serves the bytes regardless of whether a format was recorded;
  //  - anything else (unknown extension, or a code extension whose bytes aren't
  //    UTF-8 -- an fs read is data, not an import) → a 'resource'/'resource:base64'
  //    payload.
  // Routing through addFile means a file that is BOTH imported and fs-read lands in
  // one consistent, deduped entry, hashed and bucketed exactly like every other file.
  addFsFile(url, source) {
    assert.ok(Buffer.isBuffer(source), 'addFsFile requires a Buffer source')
    const ext = extname(fileURLToPath(url)).toLowerCase()
    if (FS_CODE_EXTENSIONS.has(ext) && isUtf8(source)) {
      this.addFile(url, { source, inferFormat: ext !== '.js' && ext !== '.ts' })
    } else {
      this.addFile(url, { source, resource: true })
    }
  }

  // Record an `fs.readdirSync(path)` capture (single-arg form only). The listing is
  // SORTED so the attested content is reproducible regardless of the OS's directory
  // order, JSON-serialized, and stored as a 'directory'-format payload -- a
  // resource-like file whose integrity (sha512 over the JSON text) lands in the
  // lockfile just like any other content. Buckets/dedups via #locateModule like
  // addFile; the directory's own project-relative path is the key (a readdir of a
  // module root keys the listing at the bucket itself -- see moduleFileKey).
  addFsDir(url, names) {
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'),
      'addFsDir requires an array of string names')
    const { file, dir, module } = this.#locateModule(url, { directory: true })
    const content = JSON.stringify(names.toSorted())
    const format = 'directory'
    const integrity = sha512integrity(content)
    noupsert(this.hashes, file, integrity)
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

  // Serve an `fs.readFileSync` from the bundle (`stasis run --fs`, bundle=load).
  // Returns the raw bytes as a Buffer, or undefined when the path was not captured
  // (the hook then falls back to a real disk read) or names a captured directory (a
  // readFileSync of a directory must fail, not return its listing). Decoding and the
  // lockfile hash check reuse getFile. Note a captured `.js`/`.ts` may have no
  // recorded format (see addFsFile); it's still served from `this.sources` by
  // presence -- the format only governs the module loader, not an fs read.
  getFsFile(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) === 'directory') return undefined
    if (!this.sources.has(file) && !this.resources.has(file)) return undefined
    const { source } = this.getFile(url)
    return Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  }

  // Serve an `fs.readdirSync(path)` from the bundle: the sorted listing captured at
  // build time, or undefined when the path was not captured as a directory (the hook
  // falls back to a real disk read). Reuses getFile for the hash check.
  getFsDir(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) !== 'directory') return undefined
    const { source } = this.getFile(url)
    const names = JSON.parse(source)
    assert.ok(Array.isArray(names), `corrupt directory listing for ${file}`)
    return names
  }

  // Every ancestor directory implied by the bundle's recorded file/resource/directory
  // keys. A recorded `node_modules/dep/index.js` implies `node_modules/dep` and
  // `node_modules` (and the root, ''). Built once; load-mode immutable (see field).
  #impliedDirs() {
    if (this.#impliedDirIndex) return this.#impliedDirIndex
    const dirs = new Set([''])
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
    this.#impliedDirIndex = dirs
    return dirs
  }

  // Classify a captured path for the `fs.lstatSync(x)/statSync(x)` .isFile()/.isDirectory()
  // shim (`stasis run --fs`, bundle=load): 'directory' for a readdir capture, 'file' for
  // a readFileSync capture, 'directory' for an ancestor directory implied by a recorded
  // file (e.g. `node_modules` when the bundle carries `node_modules/dep/index.js`), or
  // undefined when the path wasn't captured (the shim then falls back to a real on-disk
  // lstatSync). A directory lives in this.resources too, so the 'directory' format is
  // checked first; implied dirs are checked last so an explicit file/dir record wins.
  getFsStat(url) {
    let file
    try { file = this.#canonicalFile(url) } catch { return undefined }
    if (this.formats.get(file) === 'directory') return 'directory'
    if (this.sources.has(file) || this.resources.has(file)) return 'file'
    if (this.#impliedDirs().has(file)) return 'directory'
    return undefined
  }

  getFile(url) {
    // #canonicalFile -> relative() throws a bare assertion if the URL is outside
    // state.root (an absolute path that escapes the project). Wrap it so callers
    // get a contextual message instead of a stack pointing at relative()'s
    // assert.ok(!file.startsWith('..')).
    let file
    try { file = this.#canonicalFile(url) }
    catch (cause) { throw new Error(`stasis: file is outside the project root: ${url}`, { cause }) }
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    // Resources live in this.resources, code in this.sources. Decode per the format:
    // 'resource:base64' is base64, 'resource' is raw UTF-8, code is raw text.
    // A missing entry throws with the URL in context so load-mode callers (the
    // bundler plugins, the run loader) don't have to pre-check existence -- the
    // single getFile call is the fail-closed gate.
    let source
    if (Bundle.isResourceFormat(format)) {
      source = this.resources.get(file)
      if (source === undefined) throw new Error(`stasis: file not attested in bundle: ${url}`)
      if (format === 'resource:base64') source = Buffer.from(source, 'base64')
    } else {
      source = this.sources.get(file)
      if (source === undefined) throw new Error(`stasis: file not attested in bundle: ${url}`)
    }
    // Without a lockfile the bundle is self-attesting: hashes would be derived
    // from the same source bytes we'd then verify, which is a tautology.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  getFormat(url) {
    return this.formats.get(this.#canonicalFile(url))
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

  // A require()/import() given an already-resolved ABSOLUTE path arrives at the
  // resolve hook with that absolute path AS the specifier -- CJS
  // `require('/repo/node_modules/pkg/index.js')` is the common case (webpack's
  // loader-runner does `require(loader.path)`). Recorded verbatim, that
  // machine-specific absolute path becomes a resolution KEY in the lockfile and
  // bundle: non-portable, and unmatchable on any other machine. Once the target
  // is confirmed inside the project root, renormalize it to a path relative to
  // the IMPORTING FILE's directory -- the same shape a hand-written
  // `require('./x')` / `require('../../pkg/x')` has. The root check is only the
  // gate; the resulting key may itself contain '../' (going up from the importing
  // file), which is expected and fine as long as the target stayed inside root.
  //
  // Keying against the parent makes the key portable AND collision-free: it is
  // always '.'-prefixed, so it can never clash with a bare ('pkg') or
  // root-relative key, and an absolute path naming the same file as a relative
  // import unifies onto the identical key (same value -> noupsert agrees, no
  // throw). Bare/relative specifiers and file: URLs (handled separately by the
  // loader) pass through untouched; an absolute path that escapes the root has no
  // in-root relative form, so it's left as-is. Applied identically in addImport
  // (record) and getImport (lookup) so the key written and the key queried agree.
  #canonicalSpecifier(parentURL, specifier) {
    if (typeof specifier !== 'string' || !isAbsolute(specifier)) return specifier
    const fromRoot = relative(this.root, specifier)
    if (fromRoot === '' || fromRoot.startsWith('..')) return specifier // outside the project root
    const rel = relative(dirname(fileURLToPath(parentURL)), specifier)
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  addImport(parentURL, specifier, url, { conditions = '*', format, importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    // Capture Node's require-condition set the first time we see a require()-context
    // edge: it carries 'require' and never 'import' (the import set carries 'import'
    // instead). Requiring the absence of 'import' also rejects an import edge a user
    // forced 'require' onto via --conditions. #backfillObservedResolutions reuses this
    // set to key native require.resolve() edges accurately instead of '*' (see field doc).
    if (this.#requireConditions === null && Array.isArray(conditions) &&
        conditions.includes('require') && !conditions.includes('import')) {
      this.#requireConditions = conditions
    }
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)

    // Frozen runs verify resolutions observed from disk against the lockfile,
    // mirroring the bundle-side check: byte hashes can't see a resolution
    // redirected to a *different* attested file (e.g. via an unattested
    // package.json `main` or a symlink). An edge the lockfile attests must
    // match in every scope. Unknown edges are fatal in full scope (the
    // attested file set is closed, so the traversed edge set should be too),
    // but tolerated for workspace parents in node_modules scope -- the
    // workspace is deliberately unattested there, so changed workspace code
    // may legitimately introduce new edges, including into pinned packages.
    const tolerateUnknown = !this.config.full && !parent.includes('node_modules')
    if (this.config.frozen && this.#lockImports !== null) {
      this.#assertAttestedResolution(this.#lockImports, key, parent, specifier, file, { what: 'observed', source: 'lockfile', tolerateUnknown })
    }
    // A frozen bundle attests resolutions the same way (every v1 bundle carries an
    // `imports` map, so #bundleImports is never null once one is loaded). Same
    // redirect protection and node_modules-scope carve-out, anchored in the bundle.
    if (this.config.frozenBundle && this.#bundleImports !== null) {
      this.#assertAttestedResolution(this.#bundleImports, key, parent, specifier, file, { what: 'observed', source: 'frozen bundle', tolerateUnknown })
    }

    if (!this.imports.has(key)) this.imports.set(key, new Map())
    const imports = this.imports.get(key)
    if (!imports.has(parent)) imports.set(parent, new Map())
    const specifiers = imports.get(parent)
    noupsert(specifiers, specifier, file)
    if (format) noupsert(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'getImport requires a parent') // matches addImport; #canonicalSpecifier needs it
    const parent = this.#canonicalFile(parentURL)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    // Statically-built bundles (e.g. `stasis bundle src/entry.js`) resolve edges
    // offline and store them under the wildcard '*' key, since they can't
    // predict the exact condition set Node will pass at load time. The runtime
    // loader always records the precise conditions Node reported, so the
    // specific lookup wins when a runtime bundle is in play and only static
    // bundles take the wildcard fallback. Mismatches between the resolved file
    // for a given (parent, spec) under the two condition sets remain caller
    // territory -- the static bundle is authoritative for whichever conditions
    // the static resolver used.
    let file = this.imports.get(key)?.get(parent)?.get(specifier)
    if (file === undefined && key !== '*') {
      file = this.imports.get('*')?.get(parent)?.get(specifier)
    }
    if (file === undefined) {
      // Under-recorded edge: Node's module cache hid this require() from the
      // resolve hook at capture (another module loaded the target first), so no
      // edge was recorded under this importer. Newer Node routes a bundle-served
      // CJS require() through the resolve hook (this path) rather than through
      // Module._resolveFilename (where the CJS-loader shim recovers it) -- the
      // routing changed within 26.x -- so recover it from the bundle here too.
      if (this.config.loadBundle) {
        const abs = this.resolveBundled(parentURL, specifier)
        if (abs !== undefined) {
          const f = relative(this.root, abs)
          return { url: pathToFileURL(abs).toString(), format: this.formats.get(f) }
        }
      }
      // Throw with Node's ERR_MODULE_NOT_FOUND shape rather than asserting:
      // plain Node's resolver throws this when a bare or relative specifier
      // can't be found, and ESM dynamic-import callers commonly do
      // `try { await import(x) } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e }`.
      // A bare assertion produced an ERR_ASSERTION code that re-threw out of
      // those guards.
      const err = new Error(`Cannot find module '${specifier}' imported from ${parent}`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const url = pathToFileURL(resolve(this.root, file)).toString()
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    return { url, format }
  }

  // Resolve a CommonJS require() target to a bundled file, returning the absolute
  // path the loader should use (load() then serves its bytes from the bundle), or
  // undefined to defer to Node's native resolution.
  //
  // Node's CommonJS loader resolves require() through Module._resolveFilename,
  // which registerHooks does NOT intercept. When the ESM->CJS translator runs a
  // CJS module we served from the bundle (`import chalk from 'chalk'`, chalk
  // being CJS), that module's nested require()s take this native path and Node
  // resolves them against disk -- so a bundle is not self-contained for a CJS
  // dependency graph once node_modules is pruned/absent. The CJS-loader shim in
  // hooks.js consults this to serve them from the bundle instead.
  //
  // Resolution order:
  //   1. The recorded edge for this exact (parent, specifier), under any
  //      conditions bucket (the native require gives us no conditions to key on);
  //      this is the attested resolution. Divergent targets across buckets are
  //      ambiguous -> skip.
  //   2. Fallback against the bundle's own file set. The resolve hook never
  //      observes a require() satisfied from Node's module cache, so an edge can
  //      be absent under the importer that needs it at load time (another module
  //      resolved the same target first -- e.g. fs-extra's copy-sync.js
  //      require('../mkdirs') when copy.js already cached it). A relative/absolute
  //      specifier resolves by path (deterministic -- a fixed path can't be
  //      redirected); a bare specifier reuses a recorded target for the same
  //      specifier (it names the same package from any importer in the tree).
  //   Both fallbacks return only files the bundle actually carries, and load()
  //   still hash-verifies the bytes, so the trust boundary is unchanged.
  resolveBundled(parentURL, specifier) {
    let parent
    try { parent = this.#canonicalFile(parentURL) } catch { return undefined }
    const spec = this.#canonicalSpecifier(parentURL, specifier)

    // 1. The recorded edge for this exact (parent, specifier), under any
    //    conditions bucket -- the attested resolution. Ambiguous across buckets -> skip.
    const exact = new Set()
    for (const [, byParent] of this.imports) {
      const file = byParent.get(parent)?.get(spec)
      if (file !== undefined) exact.add(file)
    }
    if (exact.size === 1) return resolve(this.root, [...exact][0])

    // 2. Under-recorded fallback (see the note above), reusing only already-attested
    //    targets from the bundle (load() still hash-verifies the bytes).
    const index = this.#bundleIndex()
    if (spec.startsWith('.') || isAbsolute(spec)) {
      // Relative/absolute: a fixed resolved location. Reuse the target another
      // importer attested for that SAME location -- this honors a directory's
      // package.json `main` (which the bundle can't carry, so structural index
      // resolution would otherwise run the wrong file). Fall back to structural
      // extension/index resolution only when nothing attested it.
      const absCandidate = resolve(isAbsolute(spec) ? this.root : dirname(resolve(this.root, parent)), spec)
      const attested = index.byLocation.get(absCandidate) // null == ambiguous across importers
      if (typeof attested === 'string') return resolve(this.root, attested)
      const file = this.#resolveFileInBundle(absCandidate)
      if (file !== undefined) return resolve(this.root, file)
    } else {
      const file = this.#resolveBareInBundle(index, resolve(this.root, parent), spec)
      if (file !== undefined) return resolve(this.root, file)
    }
    return undefined
  }

  // Reverse index over the bundle's recorded resolutions, for resolveBundled's
  // under-recorded fallbacks. Built once and cached: load mode never mutates
  // this.imports / this.sources after construction, so per-miss rescans (which are
  // O(edges)) become O(1)/O(node_modules-depth) lookups.
  //   byLocation: a relative/absolute specifier's resolved ABSOLUTE location ->
  //     the attested target, or null when importers disagree (ambiguous).
  //   byBareSpec: a bare specifier -> { package dir -> attested target } -- the
  //     candidate copies for node_modules-nesting-aware resolution.
  // Both include only targets the bundle actually serves (this.sources).
  #bundleIndex() {
    if (this.#bundleResolveIndex) return this.#bundleResolveIndex
    const byLocation = new Map()
    const byBareSpec = new Map()
    for (const [, byParent] of this.imports) {
      for (const [p, specs] of byParent) {
        const pdir = dirname(resolve(this.root, p))
        for (const [s, file] of specs) {
          if (!this.sources.has(file)) continue
          if (s.startsWith('.') || isAbsolute(s)) {
            const loc = resolve(isAbsolute(s) ? this.root : pdir, s)
            byLocation.set(loc, byLocation.has(loc) && byLocation.get(loc) !== file ? null : file)
          } else {
            const nm = splitNodeModulesPath(file)
            if (!nm) continue
            let copies = byBareSpec.get(s)
            if (copies === undefined) byBareSpec.set(s, (copies = new Map()))
            copies.set(nm.dir, file)
          }
        }
      }
    }
    this.#bundleResolveIndex = { byLocation, byBareSpec }
    return this.#bundleResolveIndex
  }

  // CommonJS file/extension/index resolution against the bundle's code files, for
  // an absolute candidate path. Returns the project-relative bundled file, or
  // undefined. Bounded to this.sources (the code the bundle carries), so it can
  // never reach outside the bundle or onto disk. package.json `main` isn't
  // consulted (the bundle doesn't carry package.json) -- directory targets fall
  // back to index.*, which covers the common case; anything else defers to Node.
  #resolveFileInBundle(absCandidate) {
    let base
    try { base = this.relative(absCandidate) } catch { return undefined } // escapes root
    if (this.sources.has(base)) return base
    for (const ext of CJS_EXTENSIONS) if (this.sources.has(base + ext)) return base + ext
    for (const ext of CJS_EXTENSIONS) {
      const index = base === '' ? `index${ext}` : `${base}/index${ext}`
      if (this.sources.has(index)) return index
    }
    return undefined
  }

  // node_modules-nesting-aware resolution of an under-recorded bare specifier
  // against the bundle's recorded targets (index.byBareSpec). Among the candidate
  // copies, pick the one Node would: the nearest node_modules/<pkg> enclosing the
  // importer, so the correct copy wins when several versions are bundled. A single
  // recorded copy is used directly.
  #resolveBareInBundle(index, parentAbs, spec) {
    const byPkgDir = index.byBareSpec.get(spec)
    if (byPkgDir === undefined) return undefined
    // A subpath import ('#name', a package's "imports" field) is bare-looking but
    // resolves within the importer's OWN package -- NOT via a node_modules walk for
    // a package literally named '#name'. Scope it to the importer's package dir.
    if (spec.startsWith('#')) {
      const nm = splitNodeModulesPath(relative(this.root, parentAbs))
      return nm ? byPkgDir.get(nm.dir) : undefined
    }
    if (byPkgDir.size === 1) return [...byPkgDir.values()][0]
    // Several versions bundled: nearest enclosing node_modules/<pkg> wins.
    const parts = spec.split('/')
    const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    let dir = dirname(parentAbs)
    while (true) {
      const candidate = relative(this.root, join(dir, 'node_modules', pkg))
      if (!candidate.startsWith('..') && byPkgDir.has(candidate)) return byPkgDir.get(candidate)
      const up = dirname(dir)
      if (up === dir) return undefined
      dir = up
    }
  }

  // Union of the lockfile-attested resolutions and the live map (observed at
  // runtime and/or carried over from a loaded bundle), so a partial lock=add
  // run extends the recorded resolutions without dropping edges it didn't
  // reach. Conflicting targets for the same edge are fatal (add semantics,
  // same as hashes).
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
    // Union sidecars' imports too: a bundler-plugin's sidecar records the
    // webpack-graph edges into its own this.imports, and the lockfile must
    // attest those edges so a frozen run can verify them.
    for (const sidecar of this.#sidecars) mergeIn(sidecar.imports)
    return merged
  }

  // Union of lockfile-attested and observed/bundle-served formats, same
  // append-only stance as #mergedImports: conflicting formats for one file are
  // fatal (noupsert). Sidecars' formats are unioned in for the same reason.
  #mergedFormats() {
    const merged = new Map()
    if (this.#lockFormats) for (const [file, format] of this.#lockFormats) merged.set(file, format)
    for (const [file, format] of this.formats) noupsert(merged, file, format)
    for (const sidecar of this.#sidecars) {
      for (const [file, format] of sidecar.formats) noupsert(merged, file, format)
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

  // Pair each module's recorded file list with the corresponding content from
  // perFile (state.sources for code, state.resources for resources), dropping
  // modules with no content. Bundle.serialize* then groups them into sources/
  // modules buckets and writes the lockfile-shaped output.
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

  get sourceBundle() {
    // One bundle holds both code and resources; merge the two content maps (their key
    // sets are disjoint -- a file is either code or a resource) and let `formats` tag
    // which is which. Resource payloads are already encoded per their format. The
    // disjointness invariant is enforced upstream in addFile via noupsert on
    // this.formats (a file's format is either a resource one or not, and cannot
    // change), so an overlap here would be a real bug -- assert it explicitly at
    // the merge site so the failure is local, not a silently-clobbered value.
    const contents = new Map(this.sources)
    for (const [file, content] of this.resources) {
      assert.ok(!contents.has(file), `state invariant: file ${file} in both sources and resources`)
      contents.set(file, content)
    }
    return new Bundle({
      config: this.config.values,
      entries: this.entries,
      modules: this.#bundleModules(contents),
      formats: this.formats,
      imports: this.imports,
    })
  }

  get sourceData() {
    return this.sourceBundle.serialize()
  }

  // Split-bundle counterparts to `sourceBundle` / `sourceData`. Used by `write()`
  // when `config.resourcesBundleFile` is set so the on-disk layout matches a
  // bundle=load reader. Each is a standalone v1 Bundle (independently parseable);
  // metadata is partitioned, not duplicated -- the code half owns entries/imports
  // and code-format declarations, the resources half owns resource-format
  // declarations and the resource bytes. Both halves declare their per-dir
  // module identity (name/version) so each file is verifiable on its own.
  get codeBundle() {
    // Resource files don't appear in `this.sources` (addFile routes by format), so
    // restricting #bundleModules to `this.sources` automatically yields the code-only
    // view. Formats and modules are filtered to drop resource-only dirs/files.
    const codeFormats = new Map()
    for (const [file, format] of this.formats) {
      if (!Bundle.isResourceFormat(format)) codeFormats.set(file, format)
    }
    return new Bundle({
      config: this.config.values,
      entries: this.entries,
      modules: this.#bundleModules(this.sources),
      formats: codeFormats,
      imports: this.imports,
    })
  }

  get resourcesBundle() {
    const resourceFormats = new Map()
    for (const [file, format] of this.formats) {
      if (Bundle.isResourceFormat(format)) resourceFormats.set(file, format)
    }
    return new Bundle({
      config: this.config.values,
      // Resources bundle carries no entries / imports -- those belong to the code half.
      // Bundle.parse accepts an empty entries set when no code is present (the hasCode
      // check sees only resource-format files and waives the requirement).
      entries: new Set(),
      modules: this.#bundleModules(this.resources),
      formats: resourceFormats,
      imports: new Map(),
    })
  }

  // Record a capture-time native resolution (from the Module._resolveFilename
  // shim). Stored verbatim; #backfillObservedResolutions decides at write() which
  // to add. Last-write-wins per (parent, specifier) so duplicates collapse.
  observeResolution(parentURL, specifier, resolvedURL) {
    let byParent = this.#observedResolutions.get(parentURL)
    if (byParent === undefined) this.#observedResolutions.set(parentURL, (byParent = new Map()))
    byParent.set(specifier, resolvedURL)
  }

  // Backfill resolution edges the live resolve hook never observed -- require.resolve()
  // (and CJS require()s that resolve natively) on Node versions where they bypass
  // the hook. Records BOTH kinds the hook missed:
  //   - under-recorded require()s whose target the bundle carries (Node's module
  //     cache hid the require() from the resolve hook -- another module loaded the
  //     target first), and
  //   - resolve-only edges whose target it does NOT carry: require.resolve() of a
  //     module never loaded in-process (an optional-dependency probe, a forked-
  //     worker child like worker-farm's, a .node addon). The resolution is real and
  //     must be attested so the same require.resolve() returns the same path at
  //     load; the file simply has no bytes -- require.resolve returns a path, load()
  //     never runs for it, so getFile is never asked to serve it.
  // Guards:
  //   - skip out-of-scope targets (mirroring #collectMissingImportedFiles) so a
  //     node_modules-scope artifact doesn't attest workspace resolutions it isn't
  //     responsible for; an in-bundle target is always in scope, so it's exempt.
  //     (Targets escaping the root throw in #canonicalFile -> caught below.)
  //   - only edges the hook didn't already record (dedup across all condition
  //     buckets), so this never double-records a normal require().
  // Keyed under the observed require-condition set (#requireConditions) -- require()/
  // require.resolve() resolve under those conditions, not condition-free -- so a
  // native-resolve Node (where these edges land here) keys them the same way the
  // resolve hook keys them directly on newer Node. Any capture that does at least one
  // require() thus yields the same lockfile on every version; '*' only when the set was
  // never observed (a capture with no require() at all), which getImport/resolveBundled
  // still match via their wildcard fallback.
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
    // Backfill observed (native Module._resolveFilename) resolutions BEFORE the
    // stasis-core BFS. On Node's native-resolve versions a resolve-only edge to a
    // stasis-core src/*.js submodule (e.g. require.resolve('@exodus/stasis-core/
    // prune') of a module never loaded) is added only here; running the BFS first
    // would compute its missing-set without that edge, never seed the file, and
    // ship a dangling edge with no bytes -- which a later lock=frozen replay then
    // rejects. Recording it first lets the BFS capture the bytes, matching what the
    // resolve-hook path already records in-line on newer Node. Order is otherwise
    // independent: the BFS doesn't read #observedResolutions, and observe-backfill's
    // `bundled` check sees files loaded during capture (already in this.sources)
    // regardless of when the BFS runs.
    this.#backfillObservedResolutions()
    this.#backfillBeforeWrite()
    // writeFileSync(join(this.root, FILE_CONFIG), this.config.json)
    // Sidecars never write the lockfile -- the parent owns it. They only emit their bundle.
    // A "sidecar" here is one sharing the parent's lockfile data structures; an independent
    // State with its own lockFile path (constructed via the no-parent code path) writes its
    // own lockfile to `config.lockFile` instead of the rootDir default.
    //
    // Per-artifact compare-and-skip: each output's serialized text is compared against the
    // cached previous text and the brotli + writeFileSync are both skipped when they match.
    // Critical for webpack/esbuild watch-mode rebuilds, where compiler.hooks.done fires on
    // every rebuild but the captured graph usually doesn't change. Without this, every
    // rebuild brotli-compresses (quality 11) and rewrites every output.

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
        // Each is a standalone v1 Bundle (cross-check on load enforces shape).
        const codeText = this.codeBundle.serialize()
        if (codeText !== this.#lastCodeBundle) {
          mkdirSync(dirname(sourcesPath), { recursive: true })
          writeFileSync(sourcesPath, brotliCompressSync(codeText, brotliOptions()))
          this.#lastCodeBundle = codeText
        }
        const resourcesPath = this.config.resourcesBundleFile
        const resText = this.resourcesBundle.serialize()
        if (resText !== this.#lastResourcesBundle) {
          mkdirSync(dirname(resourcesPath), { recursive: true })
          writeFileSync(resourcesPath, brotliCompressSync(resText, brotliOptions()))
          this.#lastResourcesBundle = resText
        }
      } else {
        const text = this.sourceData
        if (text !== this.#lastUnifiedBundle) {
          mkdirSync(dirname(sourcesPath), { recursive: true })
          writeFileSync(sourcesPath, brotliCompressSync(text, brotliOptions()))
          this.#lastUnifiedBundle = text
        }
      }
    }
  }

  get parent() {
    return this.#parent
  }

  // Capture stasis-core's own files + internal edges that the live hooks missed.
  // When app code (or a bundler plugin) imports a stasis-core module, Node had
  // it cached from preload-time -- BEFORE install() registered our hooks -- so
  // the resolve hook records the edge but the load hook never fires, leaving
  // addFile / addImport blind to the file's bytes AND its outgoing edges. This
  // BFS, scoped strictly to the `<root>/.../@exodus/stasis-core/src/<name>.js`
  // shape, walks the graph starting from missing imports targets + already-
  // captured stasis-core files: for each, addFile (asserting the shape),
  // statically scans for relative-`.js` specifiers, resolves them, and
  // addImports each edge. The strict shape allowlist + existsSync gate filter
  // out comment-noise like a `require('../../pkg/x')` sitting in a JSDoc block.
  //
  // Called from write() so every State variant (preload via beforeExit/exit;
  // sidecar / independent plugin States via compiler.hooks.done) gets the
  // same coverage.
  #backfillBeforeWrite() {
    // List what the live hooks missed first. An empty list means there's
    // nothing to do -- either the live hooks captured everything (the common
    // case for non-preload runs and for plugin-driven States that don't
    // touch preload-cached modules), or we're a State variant that doesn't
    // observe imports at all.
    const missing = this.#collectMissingImportedFiles()
    if (missing.size === 0) return

    const isStasisCoreFile = (file) => STASIS_CORE_FILE_RE.test(`/${file}`)

    // Split the uncaptured targets. stasis-core's own preload-cached files are the
    // one case we both can and must reconstruct -- bytes AND transitive edges (the
    // BFS below). Everything else uncaptured is a resolution we attest WITHOUT
    // bundling: require.resolve() of a module never loaded in-process (an optional-
    // dependency probe, a forked-worker child like worker-farm's), or a file Node
    // can't serve from a bundle anyway (a .node addon). Those edges stay in
    // this.imports -- the user needs the resolution pinned even though the bytes are
    // absent -- and we do nothing further with them here. The load-time getFile
    // gate, not this capture-time pass, enforces the trust boundary: an actual load
    // of un-bundled bytes still fails closed there, while require.resolve (which
    // never loads) is served the attested path.
    const stasisCoreMissing = [...missing].filter((file) => isStasisCoreFile(file))
    if (stasisCoreMissing.length === 0) return

    const preloadRel = this.#preloadRoot ? relative(this.root, this.#preloadRoot) : null
    const canBackfill = preloadRel !== null && !preloadRel.startsWith('..')

    // We have stasis-core files to reconstruct but no usable preloadRoot (no loader
    // present, or stasis-core is a workspace sibling not under state.root): nothing
    // this method can do, and a stasis-core source going uncaptured IS a real gap --
    // the bundle would be missing part of its own runtime. Fail loud rather than
    // silently ship it.
    assert.ok(canBackfill,
      `state.write() has imports referencing un-captured stasis-core files but no usable preloadRoot ` +
      `(preloadRoot=${this.#preloadRoot ?? 'unset'}). The live load hook missed an in-scope target -- ` +
      `investigate rather than silently patch: ${stasisCoreMissing.slice(0, 3).join(', ')}`)

    const PRELOAD_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons']
    const stasisAddFile = (file) => {
      // Tight invariant: every backfilled file MUST match the stasis-core
      // source-file shape. The caller pre-filters via isStasisCoreFile, but
      // asserting here keeps the contract local and catches any future code
      // path that forgets.
      assert.ok(isStasisCoreFile(file),
        `state.write() backfill refused: '${file}' is not a stasis-core source file ` +
        `(expected '.../@exodus/stasis-core/src/<name>.js')`)
      this.addFile(pathToFileURL(resolve(this.root, file)).toString(), {})
    }

    // BFS through stasis-core's module graph. Seed:
    //   (a) the missing stasis-core files -- user-code -> stasis-core edges the
    //       live load hook missed because Node's module cache short-circuited it.
    //   (b) every stasis-core file already in sources -- a static `stasis
    //       bundle` pass may have pulled one in via the live hook; we still
    //       need to walk its transitive imports.
    //
    // For each queued file: addFile if not yet captured, then scan its
    // source for relative-`.js` specifiers, validate the resolved target,
    // addImport the edge, and queue the target. The single addFile site
    // covers seeds AND transitive targets -- a queued target gets addFile'd
    // on its next pop, no separate inner addFile call needed. BFS converges
    // because the matching file set is finite and `processed` dedups.
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
      // Match `from './<name>.js'\n` -- the only import shape stasis-core
      // uses (ESM `import ... from` and `export ... from`, always single-
      // quoted, filenames without `.`). Tight enough to ignore JSDoc /
      // template-literal false positives, narrow enough to reject parent-
      // relative (`../`), subpath (`./dir/file.js`), or extensionless.
      for (const m of source.matchAll(/ from '(\.\/[a-zA-Z-]+\.js)'\n/g)) {
        const specifier = m[1]
        const targetURL = new URL(specifier, baseURL).toString()
        const targetAbsolute = fileURLToPath(targetURL)
        let targetFile
        try { targetFile = this.relative(targetAbsolute) } catch { continue }
        if (!isStasisCoreFile(targetFile)) continue
        if (!existsSync(targetAbsolute)) continue
        queue.push(targetFile)
        this.addImport(baseURL, specifier, targetURL, { conditions: PRELOAD_CONDITIONS })
      }
    }
  }

  // Project-relative files referenced by `this.imports` that the live hooks
  // didn't capture into this.sources / this.resources, restricted to the
  // in-scope set (full: everything under state.root; nm: only node_modules).
  // Out-of-scope files are NOT included -- the live hooks correctly skip them
  // (workspace files under nm-scope), and including them would force the
  // backfill caller to wave away false alarms.
  #collectMissingImportedFiles() {
    const missing = new Set()
    for (const [, byParent] of this.imports) {
      for (const [, specifiers] of byParent) {
        for (const [, file] of specifiers) {
          if (typeof file !== 'string') continue
          if (missing.has(file)) continue
          // Union of three "captured" signals: hashes (addFile ran -- present
          // under any lock mode), sources/resources (bundle pre-seeded -- present
          // under bundle=load even without a lockfile). Any one suffices; a
          // file in NONE of them is the actual missing-from-capture case.
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

// Allowed shape for a stasis-core source path -- `.../@exodus/stasis-core/src/<name>.js`.
// Used by the backfill BFS to reject anything that doesn't look like a real
// stasis-core module (comment noise, paths escaping `src/`, etc.). Matched
// against `/${projectRelativeFile}` so the leading-`/` anchor isn't fooled
// by a file at the project root happening to end in `@exodus/stasis-core/...`.
// Filenames are `[a-zA-Z-]+\.js` only -- no `.` in the basename, which is why
// `state.util.js` was renamed to `state-util.js`.
const STASIS_CORE_FILE_RE = /\/@exodus\/stasis-core\/src\/[a-zA-Z-]+\.js$/

