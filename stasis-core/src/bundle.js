import {
  KNOWN_FORMATS,
  assert,
  fileMapToObject,
  fileSetToObject,
  fromEntries,
  isPlainObject,
  moduleFileKey,
  objectToMaps,
  posixPathEscapes,
  sortPaths,
  splitNodeModulesPath,
} from './util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const normalize = ({ name, version, ecosystem, files }) => {
  // `ecosystem` (when present) names the package ecosystem a dependency came from
  // (`npm`, `composer`, `soldeer`); the workspace/top-level buckets omit it.
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path, name: null }

// Bundle handles the JSON shape of stasis.code.br; callers (State) are responsible
// for the brotli wrapper around the JSON text. One unified shape carries both code
// and resources, distinguished per file by `formats[file]` ('resource' = raw UTF-8
// payload, 'resource:base64' = base64-encoded; everything else is code). On-disk
// version:
//   v0 — legacy flat layout: top-level `sources` keyed by project-relative path.
//        No entries / modules / formats / imports.
//   v1 — current layout, mirrors stasis.lock.json: per-package buckets under
//        `sources` (workspace) and `modules` (node_modules) with name+version+files,
//        plus `entries`, `formats`, and `imports`.
// `Bundle.parse` accepts both; offline tooling (stasis extract / diff / audit /
// sbom) reads v0 -- paths are regrouped by package dir via `inferModuleDir`
// (best-effort, last-wins); name/version stay null since v0 records neither,
// which State uses as a marker to skip metadata cross-checks. `stasis run`
// refuses v0 -- see State's load path. We always serialize v1.
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
  // Informational only (NOT attested): maps each consumer that recorded a bundled file --
  // 'run' (the loader/CLI), 'StasisWebpack', 'StasisMetro', etc. -- to the files it contributed.
  // Present only when a single bundle had MORE THAN ONE consumer (e.g. `run` plus a plugin sharing
  // the same bundleFile); a single-consumer bundle omits it. Never consulted for verification.
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

  // Flat project-relative view of file contents collected from this.modules.
  // Per-file encoding is signalled by `formats[file]`: 'resource:base64' is a
  // base64 string, everything else (including 'resource' and 'directory') is a
  // raw UTF-8 string.
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(moduleFileKey(dir, rel), content)
      }
    }
    return m
  }

  // True for the resource-like, non-executable payload formats. Their bundle
  // content is a raw UTF-8 string ('resource', and 'directory' — a JSON-serialized
  // `fs.readdirSync` listing) or a base64 blob ('resource:base64'). State stores
  // all three in `this.resources` (vs `this.sources` for code) and the loader's
  // executable allowlist rejects them, so this is the single "is this a code file?"
  // discriminator. Only 'resource:base64' is base64-decoded; the others are raw.
  static isResourceFormat(format) {
    return format === 'resource' || format === 'resource:base64' || format === 'directory'
  }

  // One parser for the unified shape (and legacy v0 code bundles). Resources are just
  // files tagged 'resource'/'resource:base64' in `formats`; State splits them back out
  // by consulting the formats map.
  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    assert(isPlainObject(json.formats))
    assert(isPlainObject(json.imports))

    // Validate `formats` early so downstream branches (hasCode, etc.) can consult
    // the typed Map instead of the raw `json.formats` object -- a missing key like
    // `__proto__` would otherwise short-circuit on the prototype, and an unknown
    // tag would only surface late at a string compare.
    const formats = new Map()
    for (const [file, format] of Object.entries(json.formats)) {
      assert(!posixPathEscapes(file))
      assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
      formats.set(file, format)
    }

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
        assert(json.sources && typeof json.sources === 'object')
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!dir.includes('node_modules'))
          assert(!dir.startsWith('..'))
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalize(info))
        }
        // A bundle that carries code in full scope must declare at least one entry:
        // empty entries would let `state.assertEntry` skip its check (it short-circuits
        // on entries.size === 0 for v0+no-lockfile compatibility), which a tampered
        // bundle could exploit. A resources-only bundle has no code files and thus no
        // entries -- allowed, since there is nothing for assertEntry to guard.
        let hasCode = false
        for (const [dir, { files }] of modules) {
          for (const rel of Object.keys(files)) {
            // moduleFileKey (not `${dir}/${rel}`): a `directory` capture at a module
            // root keys at rel === '', whose trailing-slash join would miss its
            // resource-format lookup and miscount the listing as code here.
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
    // An edge target is normally a file string. A `stasis bundle --metro` edge that
    // resolves differently per platform is instead a { platform: file } map (which
    // objectToMaps has turned into a Map). Validate both shapes; reject anything else
    // (e.g. a deeper nesting) so a tampered artifact fails closed at the schema edge.
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
      reason: isPlainObject(json.reason) ? json.reason : undefined, // informational, preserved for round-trip
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

  // One unified on-disk shape for code AND resources. A file is a resource when its
  // `formats` entry is 'resource' (raw UTF-8 content) or 'resource:base64' (binary,
  // base64-encoded); every other format is code carrying a raw UTF-8 source string.
  // A single bundle can therefore hold both; readers split by consulting `formats`.
  serialize() {
    const entries = fileSetToObject(this.entries)
    const { modules, sources } = this.#groupedFromModules()
    const formats = fileMapToObject(this.formats)
    const imports = fileMapToObject(this.imports)
    const data = { version: VERSION, config: this.config }
    if (this.config.scope === 'full') Object.assign(data, { entries, sources })
    Object.assign(data, { modules, formats, imports })
    // Informational provenance, last: only present when set (more than one consumer).
    if (this.reason !== undefined) data.reason = this.reason
    return JSON.stringify(data, undefined, 2)
  }
}
