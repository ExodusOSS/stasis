import assert from 'node:assert/strict'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { fileMapToObject, fileSetToObject, fromEntries, objectToMaps, sortPaths } from './util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const normalize = ({ name, version, files }) =>
  ({ name, version, files: fromEntries(Object.entries(files)) })

// Bundle (stasis.code.br / stasis.resources.br) on-disk version:
//   v0 — legacy flat layout: top-level `sources` (or `resources`) keyed by
//        project-relative path. No entries/modules metadata.
//   v1 — current layout, mirrors stasis.lock.json: per-package buckets under
//        `sources` (workspace) and `modules` (node_modules) with name+version+files,
//        plus `entries`. File payloads carry bytes (UTF-8 source strings or base64
//        resource blobs) instead of SRI digests.
// We load both v0 and v1; we always serialize v1. v0 is converted on load to
// the same in-memory shape: a single synthetic "." bucket with null name/version
// (carries no module metadata to cross-check).
export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  formats
  imports

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports } = {}) {
    assert.ok(['node_modules', 'full'].includes(config.scope))
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
  }

  // Flat project-relative view of file contents collected from this.modules.
  // For code bundles the values are UTF-8 source strings; for resource bundles
  // they are base64. Bundle does not disambiguate — the caller picks the getter
  // that matches the bundle's role.
  get sources() { return this.#flatFiles() }
  get resources() { return this.#flatFiles() }

  #flatFiles() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(dir === '.' ? rel : `${dir}/${rel}`, content)
      }
    }
    return m
  }

  static parseCode(buf) {
    const json = JSON.parse(brotliDecompressSync(buf))
    assert.ok(json.version === VERSION || json.version === LEGACY_VERSION)
    assert.ok(['node_modules', 'full'].includes(json.config?.scope))
    assert.ok(json.formats)
    assert.ok(json.imports)

    const modules = new Map()
    let entries = new Set()

    if (json.version === VERSION) {
      const full = json.config.scope === 'full'
      if (json.modules !== undefined) {
        assert.ok(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert.ok(dir.includes('node_modules'))
          assert.ok(!dir.startsWith('..'))
          assert.ok(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full) {
        assert.ok(Array.isArray(json.entries))
        assert.ok(json.sources && typeof json.sources === 'object')
        entries = new Set(json.entries)
        for (const [dir, info] of Object.entries(json.sources)) {
          assert.ok(!dir.includes('node_modules'))
          assert.ok(!dir.startsWith('..'))
          assert.ok(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      } else {
        assert.equal(json.entries, undefined)
        assert.equal(json.sources, undefined)
      }
      for (const [, { files }] of modules) {
        for (const rel of Object.keys(files)) assert.ok(!rel.startsWith('..'))
      }
    } else {
      // v0 legacy: flat sources at top level, no entries/modules metadata.
      assert.ok(json.sources)
      modules.set('.', { name: null, version: null, files: fromEntries(Object.entries(json.sources)) })
    }

    return new Bundle({
      config: json.config,
      entries,
      modules,
      formats: new Map(Object.entries(json.formats)),
      imports: objectToMaps(json.imports),
    })
  }

  static parseResources(buf) {
    const json = JSON.parse(brotliDecompressSync(buf))
    assert.ok(json.version === VERSION || json.version === LEGACY_VERSION)

    const modules = new Map()
    let config = { scope: 'full' }

    if (json.version === VERSION) {
      assert.ok(['node_modules', 'full'].includes(json.config?.scope))
      config = json.config
      const full = config.scope === 'full'
      if (json.modules !== undefined) {
        assert.ok(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert.ok(dir.includes('node_modules'))
          assert.ok(!dir.startsWith('..'))
          assert.ok(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full && json.sources !== undefined) {
        assert.ok(typeof json.sources === 'object' && json.sources !== null)
        for (const [dir, info] of Object.entries(json.sources)) {
          assert.ok(!dir.includes('node_modules'))
          assert.ok(!dir.startsWith('..'))
          assert.ok(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      } else if (!full) {
        assert.equal(json.sources, undefined)
      }
      for (const [, { files }] of modules) {
        for (const rel of Object.keys(files)) assert.ok(!rel.startsWith('..'))
      }
    } else {
      // v0 legacy: flat resources at top level, no modules/config metadata.
      assert.ok(json.resources)
      modules.set('.', { name: null, version: null, files: fromEntries(Object.entries(json.resources)) })
    }

    return new Bundle({ config, modules })
  }

  #groupedFromModules() {
    const moduleEntries = []
    const sourceEntries = []
    for (const [dir, { name, version, files }] of this.modules) {
      if (Object.keys(files).length === 0) continue
      const sorted = fromEntries(Object.entries(files).sort((a, b) => sortPaths(a[0], b[0])))
      const target = dir.includes('node_modules') ? moduleEntries : sourceEntries
      target.push([dir, { name, version, files: sorted }])
    }
    moduleEntries.sort((a, b) => sortPaths(a[0], b[0]))
    sourceEntries.sort((a, b) => sortPaths(a[0], b[0]))
    return { modules: fromEntries(moduleEntries), sources: fromEntries(sourceEntries) }
  }

  serializeCode() {
    const entries = fileSetToObject(this.entries)
    const { modules, sources } = this.#groupedFromModules()
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    const data = { version: this.version, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { entries, sources })
    Object.assign(data, { modules, formats, imports })
    return brotliCompressSync(JSON.stringify(data, undefined, 2))
  }

  serializeResources() {
    const { modules, sources } = this.#groupedFromModules()
    const data = { version: this.version, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { sources })
    Object.assign(data, { modules })
    return brotliCompressSync(JSON.stringify(data, undefined, 2))
  }
}
