import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hash } from 'node:crypto'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'

const version = 0

assert.equal(sep, '/', 'Not tested on Windows')

function sortPaths(a, b) {
  const [al, bl] = [a.split(sep), b.split(sep)]
  while (al[0] === bl[0]) {
    al.shift()
    bl.shift()
  }

  // First process each file in dir, then subdirs
  if (al.length < 2) return bl.length < 2 && al > bl ? 1 : -1
  if (bl.length < 2) return 1

  // * comes first
  if (al[0] === '*') return -1
  if (bl[0] === '*') return 1

  // node_modules comes last
  if (al[0] === 'node_modules') return 1
  if (bl[0] === 'node_modules') return -1

  // Prefer example/ over example-something/
  const [an, bn] = [al, bl].map((list) => list.join(String.fromCodePoint(0)))
  if (an < bn) return -1
  if (an > bn) return 1
  throw new Error('Unreachable')
}

function readFileSyncMaybe(dir, file, encoding) {
  try {
    return readFileSync(join(dir, file), encoding)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function noupsert(map, key, value) {
  if (map.has(key)) {
    assert.equal(map.get(key), value)
  } else {
    map.set(key, value)
  }
}

const fileSetToObject = (set) => [...set].sort((a, b) => sortPaths(a, b))
const fileMapToObject = (map) => Object.fromEntries(
  [...map]
    .sort((a, b) => sortPaths(a[0], b[0]))
    .map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v) : v])
)

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_TREE = 'stasis.tree.br'

export class State {
  hashes
  entries
  root

  constructor(root) {
    this.hashes = new Map()
    this.entries = new Set()
    this.sources = new Map()
    this.formats = new Map()
    this.modules = new Map()
    this.imports = new Map()

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
        if (config) {
          // TODO: process config
        }

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
          const json = JSON.parse(brotliDecompressSync(sources))
          assert.equal(json.version, version)
          assert.ok(json.sources)
          this.sources = new Map(Object.entries(json.sources))
          this.formats = new Map(Object.entries(json.formats))
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

    const pkg = this.relative(findPackageJSON(url))
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    const { name, version } = JSON.parse(readFileSync(pkg), 'utf-8')
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

    const sha512 = hash('sha512', source)
    if (isEntry) this.entries.add(file)
    noupsert(this.hashes, file, sha512)
    noupsert(this.sources, file, str)
    if (format) noupsert(this.formats, file, format)
  }

  getFile(url) {
    const file = this.relative(this.absolute(url))
    const source = this.sources.get(file)
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    assert.ok(source !== undefined)
    assert.equal(this.hashes.get(file), hash('sha512', source))
    return { source, format }
  }

  addImport(parentURL, specifier, url, { conditions,format }) {
    if (conditions) {
      assert.ok(Array.isArray(conditions))
      conditions = conditions.join(', ')
    } else {
      conditions = '*'
    }

    const parent = this.relative(this.absolute(parentURL))
    const resolved = this.relative(this.absolute(url))

    if (!this.imports.has(conditions)) this.imports.set(conditions, new Map())
    const imports = this.imports.get(conditions)
    if (!imports.has(parent)) imports.set(parent, new Map())
    noupsert(imports.get(parent), specifier, resolved)
    if (format) noupsert(this.formats, resolved, format)
  }

  get shouldLoad() {
    return false
  }

  get lockData() {
    const entries = fileSetToObject(this.entries)
    const modules = fileMapToObject(this.modules)
    const files = fileMapToObject(this.hashes)
    return JSON.stringify({ version, entries, modules, files }, undefined, 2)
  }

  get sourceData() {
    const sources = fileMapToObject(this.sources)
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    return brotliCompressSync(JSON.stringify({ version, formats, imports, sources }, undefined, 2))
  }

  write() {
    writeFileSync(join(this.root, FILE_LOCK), this.lockData)
    writeFileSync(join(this.root, FILE_TREE), this.sourceData)
  }
}
