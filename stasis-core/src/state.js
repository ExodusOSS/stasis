import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { join, resolve, relative, basename, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Config } from './config.js'
import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity, readFileSyncMaybe, noupsert } from './state.util.js'
import { brotliOptions } from './brotli.js'
import { fileMapToObject, objectToMaps, splitNodeModulesPath } from './util.js'

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

function readPackageJSON(pkgAbsolute) {
  const buf = readFileSync(pkgAbsolute)
  assert.ok(isUtf8(buf))
  return JSON.parse(buf.toString())
}

// TODO: stricter format validation

let preload
const liveStates = new Set()

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

  // For a parent: absolute, normalized bundleFile paths claimed by this State and
  // all sidecars hanging off it. A new sidecar checks for membership before adding
  // its own, so two sidecars of the same parent can't silently target the same
  // file (last-write-wins) and a sidecar can't collide with the parent's bundle.
  // We resolve() before comparing so './dist/x.br' and 'dist/x.br' don't slip past.
  // Unused on sidecars.
  #claimedBundleFiles = new Set()

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

  // Options:
  //   preload (boolean) -- register as the unique preload State (exposed via State.preload).
  //     Only one preload may exist at a time. The stasis loader is the only real caller.
  //   parent (State)    -- run as a sidecar of this parent. Sidecar shares the parent's
  //     hashes/entries/modules (so addFile updates the unified lockfile through them) but
  //     manages its own sources/formats/imports/resources and emits its own bundle file.
  //     write() on a sidecar skips the lockfile (parent owns it) and only writes its bundle.
  //   All other keys forward to Config.
  constructor(root, options = {}) {
    const { preload: isPreload = false, parent: parentState, ...configOptions } = options
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
      // Claim the bundleFile path so two write-intent States can't silently target
      // the same on-disk file (last-write-wins). Normalize via resolve() before
      // comparing -- raw string equality would let './dist/x.br' and 'dist/x.br'
      // slip past. Only writing States claim; read-only modes (load / frozen) may
      // legitimately share a path with the writer that produced the file.
      if (this.config.writeBundle) {
        const myBundleFile = resolve(this.config.bundleFile)
        assert.ok(!parentState.#claimedBundleFiles.has(myBundleFile),
          `sidecar bundleFile '${this.config.bundleFile}' is already claimed by the parent or an earlier sidecar`)
        parentState.#claimedBundleFiles.add(myBundleFile)
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
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, FILE_CONFIG, 'utf-8')
      const lock = readFileSyncMaybe(rootDir, FILE_LOCK, 'utf-8')
      const sourcesPath = this.config.bundleFile || join(rootDir, FILE_CODE)
      const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
      if (config !== null || lock !== null || sources !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = rootDir

        if (config) this.config.loadConfig(config)

        if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
          throw new Error(`Unexpected ${join(rootDir, FILE_LOCK)} with config.lock = 'none'`)
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
    // discovery / lockfile / bundle parsing leaves the static registry untouched.
    // Seed the bundleFile claim registry with this parent's own bundleFile so a
    // sidecar of this State can't silently target the same write target. Only
    // tracked when this parent itself writes; load / frozen / no-bundle modes
    // don't claim. Normalized so the registry compares on canonical absolute
    // paths regardless of how callers spelled the relative form.
    if (this.config.writeBundle && this.config.bundleFile) {
      this.#claimedBundleFiles.add(resolve(this.config.bundleFile))
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
            const file = dir === '.' ? rel : `${dir}/${rel}`
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

  // `resource: true` (alias: legacy `isBinary: true`) marks the file as a resource
  // rather than code. Its format is then derived from the bytes: 'resource' for valid
  // UTF-8 (stored raw, human-readable in the bundle) or 'resource:base64' for binary
  // (base64-encoded). Code files keep their inferred loader format.
  addFile(url, { source, format, isEntry, isBinary, resource } = {}) {
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
    // Canonicalize first: a workspace source linked into node_modules is recorded
    // under its real (non-node_modules) path so it classifies as a source.
    const canonical = this.#canonical(url)
    url = canonical.url
    const absolute = canonical.absolute
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const closestPkgAbsolute = findPackageJSON(url)
    const closestPkg = readPackageJSON(closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')
    // Resources don't get a loader format inferred from extension/package type --
    // their format ('resource' / 'resource:base64') is chosen by content below.
    if (!asResource) {
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
        // (e.g. bundler plugins), keep the legacy commonjs default.
        format = { __proto__: null, '.js': 'commonjs', '.ts': 'commonjs-typescript' }[extname(file)]
      }
    }

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

  getFile(url) {
    const file = this.#canonicalFile(url)
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

  addImport(parentURL, specifier, url, { conditions = '*', format, importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
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
    const parent = this.#canonicalFile(parentURL)
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
      // Throw with Node's ERR_MODULE_NOT_FOUND shape rather than asserting:
      // plain Node's resolver throws this when a bare or relative specifier
      // can't be found, and ESM dynamic-import callers commonly do
      // `try { await import(x) } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e }`.
      // A bare assertion produced an ERR_ASSERTION code that re-threw out of
      // those guards. (CJS `require()` doesn't hit this path: Node's CJS
      // resolver throws MODULE_NOT_FOUND upstream of our hook, so the only
      // miss-shape callers can observe is dynamic ESM import().)
      const err = new Error(`Cannot find module '${specifier}' imported from ${parent}`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const url = pathToFileURL(resolve(this.root, file)).toString()
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    return { url, format }
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
        const file = dir === '.' ? rel : `${dir}/${rel}`
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

  write() {
    // writeFileSync(join(this.root, FILE_CONFIG), this.config.json)
    // Sidecars never write the lockfile -- the parent owns it. They only emit their bundle.
    if (this.config.writeLockfile && !this.#parent) {
      writeFileSync(join(this.root, FILE_LOCK), this.lockData)
    }
    if (this.config.writeBundle) {
      const sourcesPath = this.config.bundleFile || join(this.root, FILE_CODE)
      mkdirSync(dirname(sourcesPath), { recursive: true })
      writeFileSync(sourcesPath, brotliCompressSync(this.sourceData, brotliOptions()))
    }
  }

  get parent() {
    return this.#parent
  }
}
