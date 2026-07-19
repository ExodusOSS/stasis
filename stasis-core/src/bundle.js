import {
  KNOWN_FORMATS,
  assert,
  fileMapToObject,
  fileSetToObject,
  fromEntries,
  isPlainObject,
  mergeFormatMaps,
  mergeImportMaps,
  mergeModuleMaps,
  moduleFileKey,
  objectToMaps,
  posixPathEscapes,
  sortPaths,
  splitNodeModulesPath,
} from './util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const normalize = ({ name, version, ecosystem, files }) => {
  // `ecosystem` names the source ecosystem (npm/composer/soldeer); workspace buckets omit it.
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path, name: null }

// Union the informational, never-attested `reason` provenance of two bundles.
const mergeReason = (a, b) => {
  if (a === undefined) return b
  if (b === undefined) return a
  const out = {}
  for (const src of [a, b]) {
    for (const [consumer, files] of Object.entries(src)) {
      out[consumer] = fileSetToObject(new Set([...(out[consumer] ?? []), ...files]))
    }
  }
  return out
}

// JSON shape of stasis.code.br (code + resources; callers own the brotli wrap). parse accepts
// legacy v0 (flat `sources`, null metadata) and v1; serialize always writes v1.
export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  formats
  imports
  // Informational only, NOT attested -- never consulted for verification. Present only with >1 consumer.
  reason

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports, reason, version = VERSION } = {}) {
    assert([LEGACY_VERSION, VERSION].includes(version))
    assert(['node_modules', 'full'].includes(config.scope))
    this.version = version
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
    this.reason = reason
  }

  // Flat project-relative view of raw stored file contents from this.modules.
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(moduleFileKey(dir, rel), content)
      }
    }
    return m
  }

  // The single "is this a code file?" discriminator: true for the non-code resource formats the loader rejects.
  static isResourceFormat(format) {
    return format === 'resource' || format === 'resource:base64' || format === 'directory'
  }

  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    assert(isPlainObject(json.formats))
    assert(isPlainObject(json.imports))

    // Validate formats into a typed Map early: a raw-object lookup like `__proto__` would hit the prototype.
    const formats = new Map()
    for (const [file, format] of Object.entries(json.formats)) {
      assert(!posixPathEscapes(file))
      assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
      // '' and '.' alias to the same key (older bundles keyed the root listing ''); normalize, fail closed on dupes.
      const key = file === '' ? '.' : file
      assert(!formats.has(key), `duplicate format key '${key}'`)
      formats.set(key, format)
    }

    const modules = new Map()
    let entries = new Set()

    if (json.version === VERSION) {
      const full = json.config.scope === 'full'
      if (json.modules !== undefined) {
        assert(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert(dir.includes('node_modules'))
          assert(!posixPathEscapes(dir))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full) {
        assert(json.sources && typeof json.sources === 'object')
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!dir.includes('node_modules'))
          assert(!posixPathEscapes(dir))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
        // Code in full scope must declare an entry, else a tampered bundle bypasses state.assertEntry (it short-circuits on entries.size 0).
        let hasCode = false
        for (const [dir, { files }] of modules) {
          for (const rel of Object.keys(files)) {
            // moduleFileKey, not `${dir}/${rel}`: a root `directory` capture keys at rel==='' and a slash-join would miscount it as code.
            const fp = moduleFileKey(dir, rel)
            if (!Bundle.isResourceFormat(formats.get(fp))) { hasCode = true; break }
          }
          if (hasCode) break
        }
        if (hasCode) {
          assert(Array.isArray(json.entries) && json.entries.length > 0,
            'bundle carrying code in scope=full must have at least one entry')
          entries = new Set(json.entries)
        } else {
          assert(json.entries === undefined || (Array.isArray(json.entries) && json.entries.length === 0))
        }
      } else {
        assert(json.entries === undefined)
        assert(json.sources === undefined)
      }
      for (const [, { files }] of modules) {
        // posixPathEscapes (not a '..' prefix): also catches mid-path escapes and absolute paths.
        for (const rel of Object.keys(files)) assert(!posixPathEscapes(rel))
      }
    } else {
      assert(json.sources)
      for (const [path, content] of Object.entries(json.sources)) {
        assert(!posixPathEscapes(path))
        const { dir, rel, name } = inferModuleDir(path)
        assert(!posixPathEscapes(dir) && !posixPathEscapes(rel))
        if (!modules.has(dir)) modules.set(dir, { name, version: null, files: Object.create(null) })
        modules.get(dir).files[rel] = content
      }
    }

    // Reject paths escaping the root here (incl. mid-path `a/../../x`): getImport resolves against the root at load.
    const imports = objectToMaps(json.imports)
    // Target is a file string or a {platform: file} map (--metro); reject anything else (fail closed).
    const assertTarget = (target) => {
      if (typeof target === 'string') {
        assert(!posixPathEscapes(target))
        return
      }
      assert(target instanceof Map && target.size > 0, 'import target must be a file or a non-empty {platform: file} map')
      for (const [platform, file] of target) {
        assert(typeof platform === 'string' && platform.length > 0 && !platform.includes('/'), `invalid platform key '${platform}'`)
        assert(typeof file === 'string')
        assert(!posixPathEscapes(file))
      }
    }
    for (const [, byParent] of imports) {
      assert(byParent instanceof Map)
      for (const [parent, specifiers] of byParent) {
        assert(!posixPathEscapes(parent))
        assert(specifiers instanceof Map)
        for (const [, target] of specifiers) assertTarget(target)
      }
    }

    return new Bundle({
      version: json.version,
      config: json.config,
      entries,
      modules,
      formats,
      imports,
      reason: isPlainObject(json.reason) ? json.reason : undefined,
    })
  }

  #groupedFromModules() {
    const moduleEntries = []
    const sourceEntries = []
    for (const [dir, { name, version, ecosystem, files }] of this.modules) {
      if (Object.keys(files).length === 0) continue
      const inNodeModules = dir.includes('node_modules')
      if (inNodeModules) assert(name && version && files)
      const sorted = fromEntries(Object.entries(files).toSorted((a, b) => sortPaths(a[0], b[0])))
      const target = inNodeModules ? moduleEntries : sourceEntries
      target.push([dir, { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: sorted }])
    }
    moduleEntries.sort((a, b) => sortPaths(a[0], b[0]))
    sourceEntries.sort((a, b) => sortPaths(a[0], b[0]))
    return { modules: fromEntries(moduleEntries), sources: fromEntries(sourceEntries) }
  }

  serialize() {
    const entries = fileSetToObject(this.entries)
    const { modules, sources } = this.#groupedFromModules()
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    const data = { version: VERSION, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { entries, sources })
    Object.assign(data, { modules, formats, imports })
    if (this.reason !== undefined) data.reason = this.reason
    return JSON.stringify(data, undefined, 2)
  }

  // Stamp `consumer` onto every carried file in the informational `reason` map (static builders do this; the runtime tags as it records).
  withReason(consumer) {
    const files = [...this.sources.keys()]
    return new Bundle({
      version: this.version,
      config: this.config,
      entries: this.entries,
      modules: this.modules,
      formats: this.formats,
      imports: this.imports,
      reason: mergeReason(this.reason, { [consumer]: files }),
    })
  }

  // Strict union of two Bundles (returns a NEW one): any genuine conflict throws -- a bundle is an attestation.
  merge(other) {
    assert(this.config.scope === other.config.scope,
      `bundle merge: scope mismatch ('${this.config.scope}' vs '${other.config.scope}')`)
    return new Bundle({
      config: { scope: this.config.scope },
      entries: new Set([...this.entries, ...other.entries]),
      modules: mergeModuleMaps(this.modules, other.modules, 'bundle merge'),
      formats: mergeFormatMaps(this.formats, other.formats, 'bundle merge'),
      imports: mergeImportMaps(this.imports, other.imports, 'bundle merge'),
      reason: mergeReason(this.reason, other.reason),
    })
  }
}
