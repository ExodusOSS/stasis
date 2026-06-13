import {
  assert,
  fileMapToObject,
  fileSetToObject,
  fromEntries,
  isPlainObject,
  objectToMaps,
  posixPathEscapes,
  sortPaths,
  splitNodeModulesPath,
} from './util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const normalize = ({ name, version, files }) =>
  ({ name, version, files: fromEntries(Object.entries(files)) })

const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path, name: null }

// Bundle handles the JSON shape of stasis.code.br / stasis.resources.br;
// callers (State) are responsible for the brotli wrapper around the JSON
// text. On-disk version:
//   v0 — legacy flat layout: top-level `sources` (or `resources`) keyed by
//        project-relative path. No entries/modules metadata.
//   v1 — current layout, mirrors stasis.lock.json: per-package buckets under
//        `sources` (workspace) and `modules` (node_modules) with name+version+files,
//        plus `entries`. File payloads carry bytes (UTF-8 source strings or base64
//        resource blobs) instead of SRI digests.
// We load both v0 and v1; we always serialize v1. v0 is converted on load to
// the same in-memory shape — paths are regrouped by package dir via
// `inferModuleDir` (best-effort, last-wins). name/version stay null since v0
// records neither, which State uses as a marker to skip metadata cross-checks.
export class Bundle {
  static VERSION = VERSION

  // The on-disk version this instance represents. Defaults to VERSION; parse*
  // sets it to whatever the file declared (LEGACY_VERSION for v0 input).
  // Serialization always writes the current VERSION regardless — loading v0 and
  // re-saving promotes the bundle to v1.
  version = VERSION
  config
  entries
  modules
  formats
  imports

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports, version = VERSION } = {}) {
    assert([LEGACY_VERSION, VERSION].includes(version))
    assert(['node_modules', 'full'].includes(config.scope))
    this.version = version
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
  }

  // Flat project-relative view of file contents collected from this.modules.
  // Values are UTF-8 source strings for code bundles, base64 for resource bundles.
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(dir === '.' ? rel : `${dir}/${rel}`, content)
      }
    }
    return m
  }

  static parseCode(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    assert(isPlainObject(json.formats))
    assert(isPlainObject(json.imports))

    const modules = new Map()
    let entries = new Set()

    if (json.version === VERSION) {
      const full = json.config.scope === 'full'
      if (json.modules !== undefined) {
        assert(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert(dir.includes('node_modules'))
          assert(!dir.startsWith('..'))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full) {
        assert(Array.isArray(json.entries))
        // Empty entries in v1 + full would let `state.assertEntry` skip its check
        // (it short-circuits on entries.size === 0 for v0+no-lockfile compatibility).
        // Forbid the shape at parse time so tampered bundles can't exploit that path.
        assert(json.entries.length > 0, 'v1 bundle with scope=full must have at least one entry')
        assert(json.sources && typeof json.sources === 'object')
        entries = new Set(json.entries)
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!dir.includes('node_modules'))
          assert(!dir.startsWith('..'))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      } else {
        assert(json.entries === undefined)
        assert(json.sources === undefined)
      }
      for (const [, { files }] of modules) {
        for (const rel of Object.keys(files)) assert(!rel.startsWith('..'))
      }
    } else {
      // v0 legacy: flat sources at top level, regrouped by inferred module dir.
      assert(json.sources)
      for (const [path, content] of Object.entries(json.sources)) {
        assert(!path.startsWith('..'))
        const { dir, rel, name } = inferModuleDir(path)
        assert(!dir.startsWith('..') && !rel.startsWith('..'))
        if (!modules.has(dir)) modules.set(dir, { name, version: null, files: Object.create(null) })
        modules.get(dir).files[rel] = content
      }
    }

    // Resolution edges name project-relative files on both sides; getImport
    // resolves the target against the project root, so a path that escapes the
    // root (including a mid-path `a/../../x`) must be rejected here rather than
    // pulling an out-of-tree file in at load time.
    const imports = objectToMaps(json.imports)
    for (const [, byParent] of imports) {
      assert(byParent instanceof Map)
      for (const [parent, specifiers] of byParent) {
        assert(!posixPathEscapes(parent))
        assert(specifiers instanceof Map)
        for (const [, file] of specifiers) {
          assert(typeof file === 'string')
          assert(!posixPathEscapes(file))
        }
      }
    }

    // Format keys name project-relative files; validate them like the import
    // paths above so a tampered bundle can't smuggle an escaping path through
    // (e.g. into a lockfile derived by `stasis extract`).
    const formats = new Map()
    for (const [file, format] of Object.entries(json.formats)) {
      assert(!posixPathEscapes(file))
      formats.set(file, format)
    }

    return new Bundle({
      version: json.version,
      config: json.config,
      entries,
      modules,
      formats,
      imports,
    })
  }

  static parseResources(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION || json.version === LEGACY_VERSION)

    const modules = new Map()
    let config = { scope: 'full' }

    if (json.version === VERSION) {
      assert(['node_modules', 'full'].includes(json.config?.scope))
      config = json.config
      const full = config.scope === 'full'
      if (json.modules !== undefined) {
        assert(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert(dir.includes('node_modules'))
          assert(!dir.startsWith('..'))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full && json.sources !== undefined) {
        assert(typeof json.sources === 'object' && json.sources !== null)
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!dir.includes('node_modules'))
          assert(!dir.startsWith('..'))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      } else if (!full) {
        assert(json.sources === undefined)
      }
      for (const [, { files }] of modules) {
        for (const rel of Object.keys(files)) assert(!rel.startsWith('..'))
      }
    } else {
      // v0 legacy: flat resources at top level, regrouped by inferred module dir.
      assert(json.resources)
      for (const [path, content] of Object.entries(json.resources)) {
        assert(!path.startsWith('..'))
        const { dir, rel, name } = inferModuleDir(path)
        assert(!dir.startsWith('..') && !rel.startsWith('..'))
        if (!modules.has(dir)) modules.set(dir, { name, version: null, files: Object.create(null) })
        modules.get(dir).files[rel] = content
      }
    }

    return new Bundle({ version: json.version, config, modules })
  }

  #groupedFromModules() {
    const moduleEntries = []
    const sourceEntries = []
    for (const [dir, { name, version, files }] of this.modules) {
      if (Object.keys(files).length === 0) continue
      const inNodeModules = dir.includes('node_modules')
      if (inNodeModules) assert(name && version && files)
      const sorted = fromEntries(Object.entries(files).toSorted((a, b) => sortPaths(a[0], b[0])))
      const target = inNodeModules ? moduleEntries : sourceEntries
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
    const data = { version: VERSION, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { entries, sources })
    Object.assign(data, { modules, formats, imports })
    return JSON.stringify(data, undefined, 2)
  }

  serializeResources() {
    const { modules, sources } = this.#groupedFromModules()
    const data = { version: VERSION, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { sources })
    Object.assign(data, { modules })
    return JSON.stringify(data, undefined, 2)
  }
}
