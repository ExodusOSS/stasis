import assert from 'node:assert/strict'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { fileMapToObject, objectToMaps } from './util.js'

const VERSION = 0

export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  sources
  formats
  imports
  resources

  constructor({ config = { scope: 'full' }, sources, formats, imports, resources } = {}) {
    assert.ok(['node_modules', 'full'].includes(config.scope))
    this.config = config
    this.sources = sources ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
    this.resources = resources ?? new Map()
  }

  static parseCode(buf) {
    const json = JSON.parse(brotliDecompressSync(buf))
    assert.equal(json.version, VERSION)
    assert.ok(['node_modules', 'full'].includes(json.config?.scope))
    assert.ok(json.sources)
    assert.ok(json.formats)
    assert.ok(json.imports)

    return new Bundle({
      config: json.config,
      sources: new Map(Object.entries(json.sources)),
      formats: new Map(Object.entries(json.formats)),
      imports: objectToMaps(json.imports),
    })
  }

  static parseResources(buf) {
    const json = JSON.parse(brotliDecompressSync(buf))
    assert.equal(json.version, VERSION)
    assert.ok(json.resources)

    return new Bundle({
      resources: new Map(Object.entries(json.resources)),
    })
  }

  serializeCode() {
    const sources = fileMapToObject(this.sources)
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    return brotliCompressSync(
      JSON.stringify(
        { version: this.version, config: this.config, formats, imports, sources },
        undefined,
        2
      )
    )
  }

  serializeResources() {
    const resources = fileMapToObject(this.resources)
    return brotliCompressSync(
      JSON.stringify({ version: this.version, resources }, undefined, 2)
    )
  }
}
