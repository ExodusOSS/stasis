import { KNOWN_FORMATS, assert, fileMapToObject, fileSetToObject, fromEntries, hasNodeModulesSegment, isPlainObject, mergeFormatMaps, mergeImportMaps, mergeModuleMaps, posixPathEscapes, sortPaths } from './util.js'

const VERSION = 0

const normalize = ({ name, version, ecosystem, files }) => {
  // `ecosystem` names the source ecosystem (npm/composer/soldeer); workspace buckets omit it.
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

export class Lockfile {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  // conditions -> parent -> specifier -> resolved file. null (not empty Map) = predates attestation ("doesn't attest" vs "attests none").
  imports
  // file -> format string. null = predates attestation (same "doesn't attest" vs "attests none" as imports).
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
      assert(hasNodeModulesSegment(dir))
      assert(info?.name && info.version && info.files)
      modules.set(dir, normalize(info))
    }

    let entries = new Set()
    if (full) {
      assert(Array.isArray(json.entries))
      entries = new Set(json.entries)
      for (const [dir, info] of Object.entries(json.sources)) {
        assert(!hasNodeModulesSegment(dir))
        modules.set(dir, normalize(info))
      }
    }

    for (const [dir, { files }] of modules) {
      assert(!posixPathEscapes(dir))
      assert(files)
      for (const name of Object.keys(files)) {
        assert(!posixPathEscapes(name))
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
          for (const [specifier, target] of Object.entries(specifiers)) {
            // A file string, or a { platform: file } map (--metro); reject any other shape (fail closed).
            if (typeof target === 'string') {
              assert(!posixPathEscapes(target))
              specs.set(specifier, target)
            } else {
              assert(isPlainObject(target) && Object.keys(target).length > 0,
                'import target must be a file or a non-empty {platform: file} map')
              const byPlatform = new Map()
              for (const [platform, file] of Object.entries(target)) {
                assert(typeof platform === 'string' && platform.length > 0 && !platform.includes('/'), `invalid platform key '${platform}'`)
                assert(typeof file === 'string')
                assert(!posixPathEscapes(file))
                byPlatform.set(platform, file)
              }
              specs.set(specifier, byPlatform)
            }
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
        // Reject unknown formats at the schema boundary (not downstream) so a tampered lockfile fails closed.
        assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
        // '' and '.' alias to the same key (older lockfiles keyed the root listing ''); normalize, fail closed on dupes.
        const key = file === '' ? '.' : file
        assert(!formats.has(key), `duplicate format key '${key}'`)
        formats.set(key, format)
      }
    }

    // Both facets ship together from every writer (lockData and shardSnapshot always emit both;
    // merge rejects a one-sided null), so exactly one missing can only come from hand-editing or
    // corruption -- fail closed at the schema boundary, in EVERY lock mode. Both-null stays valid
    // (a true pre-attestation legacy lockfile); a silent one-facet accept would let lock=add
    // regenerate the stripped facet from one run's partial observations, dropping attestation.
    assert((imports === null) === (formats === null),
      'lockfile attests exactly one of imports/formats; every stasis writer emits both or neither -- the file is corrupt or hand-edited')

    return new Lockfile({ config: json.config, entries, modules, imports, formats })
  }

  serialize() {
    const entries = fileSetToObject(this.entries)
    const modules = []
    const sources = []
    for (const [dir, { name, version, ecosystem, files }] of this.modules) {
      const inNodeModules = hasNodeModulesSegment(dir)
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
    // Legacy lockfiles (imports/formats null) omit the key so parse-serialize stays byte-stable.
    if (this.imports !== null) Object.assign(store, { imports: fileMapToObject(this.imports) })
    if (this.formats !== null) Object.assign(store, { formats: fileMapToObject(this.formats) })
    return JSON.stringify(store, undefined, 2) + '\n'
  }

  // Strict union of two Lockfiles (returns a NEW one): buckets must agree, and a file in both must carry the identical hash (fail closed).
  merge(other) {
    assert(this.config.scope === other.config.scope,
      `lockfile merge: scope mismatch ('${this.config.scope}' vs '${other.config.scope}')`)
    return new Lockfile({
      config: { scope: this.config.scope },
      entries: new Set([...this.entries, ...other.entries]),
      modules: mergeModuleMaps(this.modules, other.modules, 'lockfile merge'),
      imports: mergeNullable(this.imports, other.imports, (a, b) => mergeImportMaps(a, b, 'lockfile merge'), 'imports'),
      formats: mergeNullable(this.formats, other.formats, (a, b) => mergeFormatMaps(a, b, 'lockfile merge'), 'formats'),
    })
  }
}

// Merge nullable facets (imports/formats): both-null stays null; a one-sided null throws rather than drop the other's attestation.
const mergeNullable = (a, b, merge, what) => {
  if (a === null && b === null) return null
  assert(a !== null && b !== null,
    `lockfile merge: cannot merge ${what} (one lockfile attests ${what}, the other does not)`)
  return merge(a, b)
}
