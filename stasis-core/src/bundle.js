import {
  KNOWN_FORMATS,
  assert,
  fileMapToObject,
  fileSetToObject,
  fromEntries,
  hasNodeModulesSegment,
  isPlainObject,
  mergeFormatMaps,
  mergeImportMaps,
  mergeExecutableSets,
  mergeModuleMaps,
  moduleFileKey,
  objectToMaps,
  parseExecutable,
  serializeExecutable,
  posixPathEscapes,
  sortPaths,
  splitNodeModulesPath,
} from './artifact-util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const normalize = ({ name, version, ecosystem, files }) => {
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path, name: null }

// Union of the informational `reason` maps in canonical form: consumers sorted, each file list
// deduped and path-sorted. Canonical even when only one side is given, so a fresh withReason()
// stamp or a parsed artifact can't leak discovery/record order into the map (state's
// #bundleReason sorts the same way). A non-array list (unvalidated -- informational) is dropped.
const mergeReason = (a, b) => {
  if (a === undefined && b === undefined) return undefined
  // Accumulated in a Map: on a plain object a '__proto__' consumer key would hit the prototype.
  const merged = new Map()
  for (const src of [a, b]) {
    for (const [consumer, files] of Object.entries(src ?? {})) {
      if (!Array.isArray(files)) continue
      let set = merged.get(consumer)
      if (set === undefined) merged.set(consumer, (set = new Set()))
      for (const file of files) set.add(file)
    }
  }
  return fromEntries([...merged.keys()].toSorted().map((c) => [c, fileSetToObject(merged.get(c))]))
}

// JSON shape of stasis.code.br; callers own the brotli wrap. parse accepts legacy v0 and v1, serialize always writes v1.
export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  formats
  imports
  // Project-relative paths of bundled files carrying a POSIX execute bit, for `stasis extract`. Files only, never a `directory`.
  executable
  // Informational only, NOT attested -- never consulted for verification.
  reason

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports, executable, reason, version = VERSION } = {}) {
    assert([LEGACY_VERSION, VERSION].includes(version))
    assert(['node_modules', 'full'].includes(config.scope))
    this.version = version
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
    this.executable = executable ?? new Set()
    this.reason = reason
  }

  // Flat project-relative view of the raw stored file contents (resources stay base64).
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(moduleFileKey(dir, rel), content)
      }
    }
    return m
  }

  static isResourceFormat(format) {
    return format === 'resource' || format === 'resource:base64' || format === 'directory'
  }

  // True if any bundled file is non-resource; a full-scope code bundle must declare an entry to be runnable (State#absorbCodeBundle).
  get hasCode() {
    for (const [dir, { files }] of this.modules) {
      for (const rel of Object.keys(files)) {
        if (!Bundle.isResourceFormat(this.formats.get(moduleFileKey(dir, rel)))) return true
      }
    }
    return false
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
          assert(hasNodeModulesSegment(dir))
          assert(!posixPathEscapes(dir))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
      }
      if (full) {
        assert(json.sources && typeof json.sources === 'object')
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!hasNodeModulesSegment(dir))
          assert(!posixPathEscapes(dir))
          // A workspace bucket may omit version (a private/unpublished package.json can lack one).
          assert(info?.name && info.files)
          modules.set(dir, normalize(info))
        }
        // Empty entries are valid (`stasis add` attests files without making them entry points); state.assertEntry fails closed on an empty set.
        assert(json.entries === undefined || Array.isArray(json.entries))
        entries = new Set(json.entries)
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

    // Flat keys must be unique across buckets: two different bucket splits can flatten to one path, and the `sources` getter would serve either payload.
    const flatKeys = new Set()
    for (const [dir, { files }] of modules) {
      for (const rel of Object.keys(files)) {
        const key = moduleFileKey(dir, rel)
        assert(!flatKeys.has(key), `duplicate file key '${key}' across bundle buckets`)
        flatKeys.add(key)
      }
    }

    // Reject paths escaping the root here (incl. mid-path `a/../../x`): getImport resolves against the root at load.
    const imports = objectToMaps(json.imports)
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
      // Every executable must be a file this bundle carries. A v0 `executable` is ignored: with no per-file `formats` it could point `extract` at any path to chmod +x.
      executable: json.version === VERSION
        ? parseExecutable(json.executable, { what: 'bundle', files: flatKeys, formats, scope: json.config.scope })
        : new Set(),
      reason: isPlainObject(json.reason) ? json.reason : undefined,
    })
  }

  #groupedFromModules() {
    const moduleEntries = []
    const sourceEntries = []
    for (const [dir, { name, version, ecosystem, files }] of this.modules) {
      if (Object.keys(files).length === 0) continue
      const inNodeModules = hasNodeModulesSegment(dir)
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
    const executable = serializeExecutable(this.executable, {
      what: 'bundle', modules: this.modules, formats: this.formats, scope: this.config.scope,
    })
    if (executable !== undefined) data.executable = executable
    // Canonicalized like every sorted field above, so a parsed artifact's order can't leak into the bytes.
    if (this.reason !== undefined) data.reason = mergeReason(this.reason, undefined)
    return JSON.stringify(data, undefined, 2)
  }

  // Stamp `consumer` onto every carried file in the informational `reason` map.
  withReason(consumer) {
    const files = [...this.sources.keys()]
    return new Bundle({
      version: this.version,
      config: this.config,
      entries: this.entries,
      modules: this.modules,
      formats: this.formats,
      imports: this.imports,
      executable: this.executable,
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
      // `other` (the incoming, newer build) wins for the files it carries -- see mergeExecutableSets.
      executable: mergeExecutableSets(this.executable, other.executable, other.modules, this.config.scope),
      reason: mergeReason(this.reason, other.reason),
    })
  }
}
