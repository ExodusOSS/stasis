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
import { brotliOptions, splitNodeModulesPath } from './util.js'

// Object-destructure off the namespace rather than `import { ... } from 'node:fs'`:
// the destructured `const` captures function values at this module's eval time, so
// stasis keeps writing through the real fs even after --mock (loaded after us) calls
// module.syncBuiltinESMExports() to refresh node:fs's ESM wrapper for user code.
// Direct ESM destructured imports are live bindings and would re-resolve to the
// mocked names when state.write() fires on beforeExit.
const { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } = fs

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'
const FILE_RESOURCES = 'stasis.resources.br'

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

  // options.preload (boolean) -- mark this instance as the unique preload State, exposed via
  // State.preload. Only one preload State may exist at a time. Non-preload States can be
  // constructed freely (e.g. a bundler plugin that emits a sidecar bundle in a process that
  // already has a preload-owned lockfile). All other keys forward to Config.
  constructor(root, options = {}) {
    const { preload: isPreload = false, ...configOptions } = options
    this.config = new Config(configOptions)
    // Check the preload-uniqueness invariant up front so two simultaneous preload attempts
    // can't both pass through the constructor; the actual `preload = this` registration
    // happens after construction succeeds so a throw in setup can't leave a half-built
    // preload reference behind.
    if (isPreload) assert.ok(!preload, 'Only one preload Stasis instance is supported')
    const potentialRoots = []
    let cursor = root
    while (cursor) {
      if (existsSync(join(cursor, 'package.json'))) {
        potentialRoots.push(cursor)
      } else if (
        existsSync(join(cursor, FILE_CONFIG)) ||
        existsSync(join(cursor, FILE_LOCK)) ||
        existsSync(join(cursor, FILE_CODE)) ||
        existsSync(join(cursor, FILE_RESOURCES))) {
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
      // An explicit bundleFile is one fixed path, not a per-root marker: reading
      // it under each candidate root would make it "present" everywhere along the
      // walk and trip the "already loaded" guard below in any nested-package or
      // monorepo tree. Only the default-path code bundle is discovered per-root;
      // the explicit bundleFile is loaded once after the loop, against the root
      // that discovery settles on.
      const sources = this.config.bundleFile ? null : readFileSyncMaybe(rootDir, FILE_CODE)
      const resources = readFileSyncMaybe(rootDir, FILE_RESOURCES)
      if (config !== null || lock !== null || sources !== null || resources !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = rootDir

        if (config) this.config.loadConfig(config)

        if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
          throw new Error(`Unexpected ${join(rootDir, FILE_LOCK)} with config.lock = 'none'`)
        }
        if (sources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle) {
          throw new Error(`Unexpected ${join(rootDir, FILE_CODE)} with config.bundle = 'none'`)
        }
        if (resources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle) {
          throw new Error(`Unexpected ${join(rootDir, FILE_RESOURCES)} with config.bundle = 'none'`)
        }

        if (sources && !lock && this.config.useLockfile && !this.config.replaceLockfile) {
          throw new Error('stasis.lock.json missing, can not use sources')
        }

        if (this.config.frozen) assert.ok(lock, 'No lockfile, but attempting to run in frozen mode')
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
          lockfileLoaded = true
        }

        if (sources && (this.config.writeBundle || this.config.loadBundle) && !this.config.replaceBundle) {
          this.#loadCodeBundle(sources, { lockfileLoaded })
        }

        if (resources && (this.config.writeBundle || this.config.loadBundle) && !this.config.replaceBundle) {
          const bundle = Bundle.parseResources(brotliDecompressSync(resources).toString('utf-8'))
          // v0 resource bundles didn't record scope; only enforce on v1 where it's reliable.
          if (bundle.version === Bundle.VERSION) {
            assert.equal(bundle.config.scope, this.config.scope)
          }
          this.#mergeBundleMetadata(bundle, { lockfileLoaded })
          this.resources = bundle.sources
        }
      }
    }

    // An explicit bundleFile lives at a single fixed path rather than under one of
    // the candidate roots, so it sits out the per-root discovery above and is loaded
    // here against whichever root that settled on (the dir holding the lockfile/config,
    // or the default top-level package when none was found). The lockfile/config it
    // pairs with were discovered in the loop, so this.config and lockfileLoaded are
    // already final.
    if (this.config.bundleFile) {
      const sources = readFileSyncMaybe(dirname(this.config.bundleFile), basename(this.config.bundleFile))
      // frozen still requires a lockfile; when the bundleFile is the only artifact
      // present the discovery loop never reached its own frozen check.
      if (this.config.frozen) assert.ok(lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
      if (sources !== null) {
        if (!this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle) {
          throw new Error(`Unexpected ${this.config.bundleFile} with config.bundle = 'none'`)
        }
        if (!lockfileLoaded && this.config.useLockfile && !this.config.replaceLockfile) {
          throw new Error('stasis.lock.json missing, can not use sources')
        }
        if ((this.config.writeBundle || this.config.loadBundle) && !this.config.replaceBundle) {
          this.#loadCodeBundle(sources, { lockfileLoaded })
        }
      }
    }

    // Register only after every fallible step succeeds, so a thrown error during config
    // discovery / lockfile / bundle parsing leaves the static registry untouched.
    if (isPreload) preload = this
    liveStates.add(this)
  }

  // Parse a brotli-compressed code bundle and fold it into this State: cross-check
  // its metadata against the lockfile (or absorb it when none was loaded), then take
  // its sources/formats/imports. Shared by the per-root default-path load and the
  // explicit-bundleFile load above.
  #loadCodeBundle(compressed, { lockfileLoaded }) {
    const bundle = Bundle.parseCode(brotliDecompressSync(compressed).toString('utf-8'))
    assert.equal(bundle.config.scope, this.config.scope)
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    this.sources = bundle.sources
    this.formats = bundle.formats
    this.imports = bundle.imports
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
    } else {
      if (bundle.entries.size > 0) this.entries = new Set([...this.entries, ...bundle.entries])
      for (const [dir, info] of bundle.modules) {
        if (!info.name || !info.version) continue // partial metadata
        if (this.modules.has(dir)) {
          // Code and resources bundles both populate `state.modules` when no lockfile
          // is loaded. They must agree on name/version for the same dir.
          const existing = this.modules.get(dir)
          assert.equal(info.name, existing.name, `bundle ${dir} name mismatch`)
          assert.equal(info.version, existing.version, `bundle ${dir} version mismatch`)
        } else {
          this.modules.set(dir, { name: info.name, version: info.version, files: Object.create(null) })
        }
      }
    }
  }

  assertEntry(url) {
    // Skipped silently when no entries info is available (v0 bundle + lock=none/ignore).
    // v1 bundles in full scope are required to declare at least one entry at parse time,
    // so this fallback only ever triggers for the legacy path.
    if (this.entries.size === 0) return
    const file = this.relative(this.absolute(url))
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

  addFile(url, { source, format, isEntry, isBinary } = {}) {
    const absolute = this.absolute(url)
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const closestPkgAbsolute = findPackageJSON(url)
    const closestPkg = readPackageJSON(closestPkgAbsolute)

    const closestType = closestPkg.type ?? 'commonjs'
    assert.ok(closestType === 'module' || closestType === 'commonjs')
    const extToFormat = { __proto__: null, '.json': 'json', '.mjs': 'module', '.cjs': 'commonjs', '.js': closestType }
    const inferredFormat = extToFormat[extname(file)]
    if (inferredFormat !== undefined) {
      if (format != null) assert.equal(format, inferredFormat)
      else format = inferredFormat
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
    if (!this.modules.has(dir)) this.modules.set(dir, { name, version, files: Object.create(null) })
    const module = this.modules.get(dir)
    assert.equal(module.name, name)
    assert.equal(module.version, version)

    if (typeof source === 'string') {
      assert.ok(source.isWellFormed())
    } else {
      if (source === undefined || source === null) source = readFileSync(absolute)
      assert.ok(Buffer.isBuffer(source))
      if (!isBinary) assert.ok(isUtf8(source), `File is not UTF-8: ${file}`)
    }

    const buf = typeof source === 'string' ? Buffer.from(source) : source
    assert.deepStrictEqual(readFileSync(absolute), buf)

    if (isEntry) this.entries.add(file)
    const integrity = sha512integrity(source)
    noupsert(this.hashes, file, integrity)
    const rel = relative(dir, file)
    assert.ok(!rel.startsWith('..'))

    if (this.config.frozen && (dir.includes('node_modules') || this.config.full)) {
      assert.ok(Object.hasOwn(module.files, rel))
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)

    if (this.config.bundle) {
      if (isBinary) {
        noupsert(this.resources, file, buf.toString('base64'))
      } else {
        noupsert(this.sources, file, typeof source === 'string' ? source : source.toString())
      }
    }

    if (format) noupsert(this.formats, file, format)
  }

  getFile(url) {
    const file = this.relative(this.absolute(url))
    const source = this.sources.get(file)
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    assert.ok(source !== undefined)
    // Without a lockfile the bundle is self-attesting: hashes would be derived
    // from the same source bytes we'd then verify, which is a tautology.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  getFormat(url) {
    return this.formats.get(this.relative(this.absolute(url)))
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
    const parent = this.relative(this.absolute(parentURL))
    const file = this.relative(this.absolute(url))
    const key = this.#conditionsKey(conditions, importAttributes)

    if (!this.imports.has(key)) this.imports.set(key, new Map())
    const imports = this.imports.get(key)
    if (!imports.has(parent)) imports.set(parent, new Map())
    const specifiers = imports.get(parent)
    noupsert(specifiers, specifier, file)
    if (format) noupsert(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    const parent = this.relative(this.absolute(parentURL))
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

  get lockData() {
    return new Lockfile({
      config: this.config.values,
      entries: this.entries,
      modules: this.modules,
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
        modules.set(dir, { name: info.name, version: info.version, files })
      }
    }
    return modules
  }

  get sourceData() {
    return new Bundle({
      config: this.config.values,
      entries: this.entries,
      modules: this.#bundleModules(this.sources),
      formats: this.formats,
      imports: this.imports,
    }).serializeCode()
  }

  get resourceData() {
    return new Bundle({
      config: this.config.values,
      modules: this.#bundleModules(this.resources),
    }).serializeResources()
  }

  // Write through a descriptor opened with the module-eval (pre-mock) openSync.
  // Under `stasis run --mock`, fs.openSync is replaced with a write-flag denier;
  // writeFileSync(path, ...) re-enters that mocked openSync internally, which
  // would block stasis's own output alongside the user-code writes the mock is
  // meant to stop. Opening here with the captured-real openSync sidesteps the
  // property mock, and writeFileSync(fd, ...) takes a numeric fd so it skips the
  // internal open entirely (writeSync, which it does use, is never mocked).
  #writeFile(path, data) {
    const fd = openSync(path, 'w')
    try {
      writeFileSync(fd, data)
    } finally {
      closeSync(fd)
    }
  }

  write() {
    // writeFileSync(join(this.root, FILE_CONFIG), this.config.json)
    if (this.config.writeLockfile) {
      this.#writeFile(join(this.root, FILE_LOCK), this.lockData)
    }
    if (this.config.writeBundle) {
      const sourcesPath = this.config.bundleFile || join(this.root, FILE_CODE)
      mkdirSync(dirname(sourcesPath), { recursive: true })
      this.#writeFile(sourcesPath, brotliCompressSync(this.sourceData, brotliOptions()))
    }
  }
}
