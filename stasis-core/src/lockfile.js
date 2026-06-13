import { assert, fileMapToObject, fileSetToObject, fromEntries, isPlainObject, posixPathEscapes, sortPaths } from './util.js'

const VERSION = 0

const normalize = ({ name, version, ecosystem, files }) => {
  // `ecosystem` (when present) names the package ecosystem a dependency came from
  // (`npm`, `composer`, `soldeer`); the workspace/top-level buckets omit it.
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

export class Lockfile {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  // Recorded resolutions, mirroring the bundle's `imports` shape:
  // conditions key -> parent file -> specifier -> resolved file. `null` (not an
  // empty Map) when the lockfile predates resolution attestation -- consumers
  // use that to tell "attests no resolutions" apart from "doesn't attest them".
  imports
  // Recorded loader formats: project-relative file -> Node format string
  // (module/commonjs/json/{module,commonjs}-typescript), mirroring the bundle's
  // `formats` map. `null` when the lockfile predates format attestation, same
  // "attests none" vs "doesn't attest" distinction as `imports`.
  formats

  constructor({ config = { scope: 'full' }, entries, modules, imports, formats } = {}) {
    assert(['node_modules', 'full'].includes(config.scope))
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.imports = imports ?? null
    this.formats = formats ?? null
  }

  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))

    const full = json.config.scope === 'full'
    assert(!!json.entries === full)
    assert(!!json.sources === full)
    assert(json.modules)

    const modules = new Map()
    for (const [dir, info] of Object.entries(json.modules)) {
      assert(dir.includes('node_modules'))
      assert(info?.name && info.version && info.files)
      modules.set(dir, normalize(info))
    }

    let entries = new Set()
    if (full) {
      assert(Array.isArray(json.entries))
      entries = new Set(json.entries)
      for (const [dir, info] of Object.entries(json.sources)) {
        assert(!dir.includes('node_modules'))
        modules.set(dir, normalize(info))
      }
    }

    for (const [dir, { files }] of modules) {
      assert(!dir.startsWith('..'))
      assert(files)
      for (const name of Object.keys(files)) {
        assert(!name.startsWith('..'))
      }
    }

    let imports = null
    if (json.imports !== undefined) {
      assert(isPlainObject(json.imports))
      imports = new Map()
      for (const [conditions, byParent] of Object.entries(json.imports)) {
        assert(isPlainObject(byParent))
        const parents = new Map()
        for (const [parent, specifiers] of Object.entries(byParent)) {
          assert(!posixPathEscapes(parent))
          assert(isPlainObject(specifiers))
          const specs = new Map()
          for (const [specifier, file] of Object.entries(specifiers)) {
            assert(typeof file === 'string')
            assert(!posixPathEscapes(file))
            specs.set(specifier, file)
          }
          parents.set(parent, specs)
        }
        imports.set(conditions, parents)
      }
    }

    let formats = null
    if (json.formats !== undefined) {
      assert(isPlainObject(json.formats))
      formats = new Map()
      for (const [file, format] of Object.entries(json.formats)) {
        assert(!posixPathEscapes(file))
        assert(typeof format === 'string')
        formats.set(file, format)
      }
    }

    return new Lockfile({ config: json.config, entries, modules, imports, formats })
  }

  serialize() {
    const entries = fileSetToObject(this.entries)
    const modules = []
    const sources = []
    for (const [dir, { name, version, ecosystem, files }] of this.modules) {
      const inNodeModules = dir.includes('node_modules')
      if (inNodeModules) assert(name && version && files)
      const type = inNodeModules ? modules : sources
      const sorted = fromEntries(Object.entries(files).toSorted((a, b) => sortPaths(a[0], b[0])))
      type.push([dir, { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: sorted }])
    }
    modules.sort((a, b) => sortPaths(a[0], b[0]))
    sources.sort((a, b) => sortPaths(a[0], b[0]))

    const store = { version: this.version, config: this.config }
    if (this.config.scope === 'full') Object.assign(store, { entries, sources: fromEntries(sources) })
    Object.assign(store, { modules: fromEntries(modules) })
    // Legacy lockfiles (imports/formats === null) round-trip without the key,
    // so parse-serialize of an old file stays byte-stable.
    if (this.imports !== null) Object.assign(store, { imports: fileMapToObject(this.imports) })
    if (this.formats !== null) Object.assign(store, { formats: fileMapToObject(this.formats) })
    return JSON.stringify(store, undefined, 2) + '\n'
  }
}
