import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'

import { Config } from './config.js'
import {
  sha512integrity,
  readFileSyncMaybe,
  sortPaths,
  fileSetToObject,
  fileMapToObject,
  objectToMaps,
  noupsert,
} from './util.js'

const version = 0

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'
const FILE_RESOURCES = 'stasis.resources.br'

// TODO: stricter format validation

let instance

export class State {
  hashes = new Map()
  entries = new Set()
  sources = new Map()
  resources = new Map()
  formats = new Map()
  modules = new Map()
  imports = new Map()
  config = new Config()
  root

  constructor(root) {
    assert.ok(!instance, 'Only a single Stasis instance is supported')
    instance = this
    const potentialRoots = []
    let dir = root
    while (dir) {
      if (existsSync(join(dir, 'package.json'))) {
        potentialRoots.push(dir)
      } else if (
        existsSync(join(dir, FILE_CONFIG)) ||
        existsSync(join(dir, FILE_LOCK)) ||
        existsSync(join(dir, FILE_CODE)) ||
        existsSync(join(dir, FILE_RESOURCES))) {
        throw new Error('Unexpected stasis config without package.json')
      }

      if (dir === process.env.PROJECT_CWD) break // e.g. yarn sets this
      if (existsSync(join(dir, '.git'))) break // don't go higher than the repo root
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) break // pnpm workspace root
      const parent = dirname(dir)
      if (!parent || parent === dir) break
      dir = parent
    }

    // default root is top-level package.json, to opt-in to per-dir create stasis.config.json
    this.root = potentialRoots.at(-1)

    let loaded = false
    for (const dir of potentialRoots) {
      const config = readFileSyncMaybe(dir, FILE_CONFIG, 'utf-8')
      const lock = readFileSyncMaybe(dir, FILE_LOCK, 'utf-8')
      const sourcesPath = this.config.bundleFile || join(dir, FILE_CODE)
      const sources = readFileSyncMaybe(dirname(sourcesPath), basename(sourcesPath))
      const resources = readFileSyncMaybe(dir, FILE_RESOURCES)
      if (config !== null || lock !== null || sources !== null || resources !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        loaded = true
        this.root = dir

        if (config) this.config.loadConfig(config)

        if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
          throw new Error(`Unexpected ${join(dir, FILE_LOCK)} with config.lock = 'none'`)
        }
        if (sources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle) {
          throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
        }
        if (resources && !this.config.writeBundle && !this.config.loadBundle && !this.config.ignoreBundle) {
          throw new Error(`Unexpected ${join(dir, FILE_RESOURCES)} with config.bundle = 'none'`)
        }

        if (sources && !lock && this.config.useLockfile && !this.config.replaceLockfile) {
          throw new Error('stasis.lock.json missing, can not use sources')
        }

        if (this.config.frozen) assert.ok(lock, 'No lockfile, but attempting to run in frozen mode')
        if (lock && this.config.useLockfile && !this.config.replaceLockfile) {
          const json = JSON.parse(lock)
          assert.equal(json.version, version)
          assert.ok(['node_modules', 'full'].includes(json.config?.scope))
          if (this.config.frozen) assert.equal(json.config.scope, this.config.scope)

          const full = json.config.scope === 'full'
          assert.equal(!!json.entries, full)
          assert.equal(!!json.sources, full)
          assert.ok(json.modules)

          this.modules = new Map(Object.entries(json.modules))
          for (const [dir] of this.modules) assert.ok(dir.includes('node_modules'))
          if (full && this.config.full) {
            assert.ok(Array.isArray(json.entries))
            this.entries = new Set(json.entries)
            assert.ok(json.sources)
            for (const [dir, info] of Object.entries(json.sources)) {
              assert.ok(!dir.includes('node_modules'))
              this.modules.set(dir, info)
            }
          }

          for (const [dir, { files }] of this.modules) {
            assert.ok(!dir.startsWith('..'))
            assert.ok(files)
            for (const [name, hash] of Object.entries(files)) {
              assert.ok(!name.startsWith('..'))
              noupsert(this.hashes, join(dir, name), hash)
            }
          }
        }

        if (sources && (this.config.writeBundle || this.config.loadBundle) && !this.config.replaceBundle) {
          const json = JSON.parse(brotliDecompressSync(sources))
          assert.equal(json.version, version)
          assert.ok(['node_modules', 'full'].includes(json.config?.scope))
          if (this.config.frozen) assert.equal(json.config.scope, this.config.scope)
          assert.ok(json.sources)
          assert.ok(json.formats)
          assert.ok(json.imports)
          this.sources = new Map(Object.entries(json.sources))
          this.formats = new Map(Object.entries(json.formats))
          this.imports = objectToMaps(json.imports)
        }

        if (resources && (this.config.writeBundle || this.config.loadBundle) && !this.config.replaceBundle) {
          const json = JSON.parse(brotliDecompressSync(resources))
          assert.equal(json.version, version)
          assert.ok(json.resources)
          this.resources = new Map(Object.entries(json.resources))
        }
      }
    }
  }

  static get instance() {
    return instance
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

    const pkgAbsolute = findPackageJSON(url)
    const pkg = this.relative(pkgAbsolute)
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    assert.equal(basename(pkg), 'package.json')
    const dir = dirname(pkg)
    const jsonbuf = readFileSync(pkgAbsolute)
    assert.ok(isUtf8(jsonbuf))
    const json = jsonbuf.toString()
    const { name, version } = JSON.parse(json)
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

  addImport(parentURL, specifier, url, { conditions = '*', format } = {}) {
    if (conditions !== '*') {
      assert.ok(Array.isArray(conditions))
      conditions = conditions.join(', ')
    }

    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.relative(this.absolute(parentURL))
    const file = this.relative(this.absolute(url))

    if (!this.imports.has(conditions)) this.imports.set(conditions, new Map())
    const imports = this.imports.get(conditions)
    if (!imports.has(parent)) imports.set(parent, new Map())
    const specifiers = imports.get(parent)
    noupsert(specifiers, specifier, file)
    if (format) noupsert(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*' } = {}) {
    if (conditions !== '*') {
      assert.ok(Array.isArray(conditions))
      conditions = conditions.join(', ')
    }

    const parent = this.relative(this.absolute(parentURL))
    const file = this.imports.get(conditions)?.get(parent)?.get(specifier)
    assert.ok(file)
    const url = pathToFileURL(resolve(this.root, file)).toString()
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    return { url, format }
  }

  get lockData() {
    const config = this.config.values
    const entries = fileSetToObject(this.entries)
    const modules = []
    const sources = []
    for (const [dir, { name, version, files }] of this.modules) {
      const type = dir.includes('node_modules') ? modules : sources
      const sorted = Object.fromEntries(Object.entries(files).sort((a, b) => sortPaths(a[0], b[0])))
      type.push([dir, { name, version, files: sorted }])
    }

    modules.sort((a, b) => sortPaths(a[0], b[0]))
    sources.sort((a, b) => sortPaths(a[0], b[0]))

    const store = { version, config }
    if (this.config.full) Object.assign(store, { entries, sources: Object.fromEntries(sources) })
    Object.assign(store, { modules: Object.fromEntries(modules) })
    return JSON.stringify(store, undefined, 2) + '\n'
  }

  get sourceData() {
    const config = this.config.values
    const sources = fileMapToObject(this.sources)
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    return brotliCompressSync(JSON.stringify({ version, config, formats, imports, sources }, undefined, 2))
  }

  write() {
    // writeFileSync(join(this.root, FILE_CONFIG), this.config.json)
    if (this.config.writeLockfile) {
      writeFileSync(join(this.root, FILE_LOCK), this.lockData)
    }
    if (this.config.writeBundle) {
      const sourcesPath = this.config.bundleFile || join(this.root, FILE_CODE)
      mkdirSync(dirname(sourcesPath), { recursive: true })
      writeFileSync(sourcesPath, this.sourceData)
    }
  }
}
