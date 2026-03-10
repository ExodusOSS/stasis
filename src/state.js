import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'

import { Config } from './config.js'
import {
  sha512integrity,
  readFileSyncMaybe,
  fileSetToObject,
  fileMapToObject,
  objectToMaps,
  noupsert,
} from './util.js'

const version = 0

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_TREE = 'stasis.tree.br'

export class State {
  hashes = new Map()
  entries = new Set()
  sources = new Map()
  formats = new Map()
  modules = new Map()
  imports = new Map()
  config = new Config()
  root

  constructor(root) {
    const potentialRoots = []
    let dir = root
    while (dir) {
      if (existsSync(join(dir, 'package.json'))) {
        potentialRoots.push(dir)
      } else if (
        existsSync(join(dir, FILE_CONFIG)) ||
        existsSync(join(dir, FILE_LOCK)) ||
        existsSync(join(dir, FILE_TREE))) {
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
      const sources = readFileSyncMaybe(dir, FILE_TREE)
      if (config !== null || lock !== null || sources !== null) {
        if (loaded) throw new Error('Stasis config already loaded')
        if (sources && !lock) throw new Error('stasis.lock.json missing, can not use sources')
        loaded = true
        this.root = dir

        if (config) this.config.loadConfig(config)

        if (lock) {
          const json = JSON.parse(lock)
          assert.equal(json.version, version)
          assert.ok(Array.isArray(json.entries))
          assert.ok(json.files)
          this.entries = new Set(json.entries)
          this.modules = new Map(Object.entries(json.modules))
          this.hashes = new Map(Object.entries(json.files))
        }

        if (sources) {
          if (!this.config.writeBundle && !this.config.loadBundle) {
            throw new Error(`Unexpected ${join(dir, FILE_TREE)} with config.bundle = 'none'`)
          }

          const json = JSON.parse(brotliDecompressSync(sources))
          assert.equal(json.version, version)
          assert.ok(json.sources)
          this.sources = new Map(Object.entries(json.sources))
          this.formats = new Map(Object.entries(json.formats))
          this.imports = objectToMaps(json.imports)
        }
      }
    }
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

  addFile(url, source, format, isEntry) {
    const absolute = this.absolute(url)
    assert.ok(existsSync(absolute))
    const file = this.relative(absolute)

    const pkgAbsolute = findPackageJSON(url)
    const pkg = this.relative(pkgAbsolute)
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    const jsonbuf = readFileSync(pkgAbsolute)
    assert.ok(isUtf8(jsonbuf))
    const json = jsonbuf.toString()
    const { name, version } = JSON.parse(json)
    noupsert(this.modules, pkg, `${name}@${version}`)

    if (typeof source === 'string') {
      assert.ok(source.isWellFormed())
    } else {
      assert.ok(Buffer.isBuffer(source))
      assert.ok(isUtf8(source))
    }

    const str = typeof source === 'string' ? source : source.toString()
    const buf = typeof source === 'string' ? Buffer.from(source) : source
    assert.deepStrictEqual(readFileSync(absolute), buf)

    if (isEntry) this.entries.add(file)
    noupsert(this.hashes, file, sha512integrity(source))
    noupsert(this.sources, file, str)
    if (format) noupsert(this.formats, file, format)
  }

  getFile(url) {
    const file = this.relative(this.absolute(url))
    const source = this.sources.get(file)
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    assert.ok(source !== undefined)
    assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  addImport(parentURL, specifier, url, { conditions = '*', format } = {}) {
    if (conditions !== '*') {
      assert.ok(Array.isArray(conditions))
      conditions = conditions.join(', ')
    }

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
    const modules = fileMapToObject(this.modules)
    const files = fileMapToObject(this.hashes)
    return JSON.stringify({ version, config, entries, modules, files }, undefined, 2)
  }

  get sourceData() {
    const config = this.config.values
    const sources = fileMapToObject(this.sources)
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    return brotliCompressSync(JSON.stringify({ version, config, formats, imports, sources }, undefined, 2))
  }

  write() {
    writeFileSync(join(this.root, FILE_LOCK), this.lockData)
    if (this.config.writeBundle) writeFileSync(join(this.root, FILE_TREE), this.sourceData)
  }
}
