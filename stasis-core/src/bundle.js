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
  // `ecosystem` (when present) names the package ecosystem a dependency came from
  // (`npm`, `composer`, `soldeer`); the workspace/top-level buckets omit it.
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return { name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files: fromEntries(Object.entries(files)) }
}

const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path, name: null }

// Union the informational `reason` provenance of two bundles (consumer -> the files
// it contributed). Undefined on one side yields the other; present on both unions
// each consumer's file list (sorted the way State serializes it -- see #bundleReason).
// Never attested, so a best-effort union is fine.
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

// Bundle handles the JSON shape of stasis.code.br; callers (State) own the brotli
// wrapper. One unified shape carries code and resources, distinguished per file by
// `formats[file]` ('resource' = raw UTF-8, 'resource:base64' = base64; else code).
// On-disk version:
//   v0 — legacy flat layout: top-level `sources` keyed by project-relative path.
//        No entries / modules / formats / imports.
//   v1 — current layout, mirrors stasis.lock.json: per-package `sources` (workspace)
//        and `modules` (node_modules) buckets with name+version+files, plus
//        `entries`, `formats`, `imports`.
// parse accepts both; offline tooling (extract / diff / audit / sbom) reads v0,
// regrouping paths by package dir via `inferModuleDir` (best-effort, last-wins). v0
// leaves name/version null, State's marker to skip metadata cross-checks. `stasis run`
// refuses v0 (see State's load path). We always serialize v1.
export class Bundle {
  static VERSION = VERSION

  // On-disk version this instance represents. Defaults to VERSION; parse sets it to
  // whatever the file declared (LEGACY_VERSION for v0). Serialization always writes
  // VERSION, so loading v0 and re-saving promotes the bundle to v1.
  version = VERSION
  config
  entries
  modules
  formats
  imports
  // Informational only (NOT attested): maps each consumer that recorded a bundled file
  // ('run', 'StasisWebpack', ...) to the files it contributed. Present only when a bundle
  // had MORE THAN ONE consumer (e.g. `run` plus a plugin sharing the same bundleFile);
  // omitted otherwise. Never consulted for verification.
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

  // Flat project-relative view of file contents from this.modules. Per-file encoding is
  // signalled by `formats[file]`: 'resource:base64' is base64, everything else
  // (including 'resource' and 'directory') is raw UTF-8.
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) {
        m.set(moduleFileKey(dir, rel), content)
      }
    }
    return m
  }

  // True for the resource-like, non-executable payload formats: raw UTF-8 ('resource',
  // and 'directory' — a JSON-serialized `fs.readdirSync` listing) or a base64 blob
  // ('resource:base64'). State stores all three in `this.resources` (vs `this.sources`
  // for code) and the loader's allowlist rejects them, so this is the single "is this a
  // code file?" discriminator. Only 'resource:base64' is base64-decoded.
  static isResourceFormat(format) {
    return format === 'resource' || format === 'resource:base64' || format === 'directory'
  }

  // One parser for the unified shape (and legacy v0 code bundles). Resources are just
  // files tagged 'resource'/'resource:base64' in `formats`; State splits them back out.
  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    assert(isPlainObject(json.formats))
    assert(isPlainObject(json.imports))

    // Validate `formats` early so downstream branches (hasCode, etc.) consult the typed
    // Map, not the raw `json.formats` object -- a key like `__proto__` would short-circuit
    // on the prototype, and an unknown tag would only surface late at a string compare.
    const formats = new Map()
    for (const [file, format] of Object.entries(json.formats)) {
      assert(!posixPathEscapes(file))
      assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
      // The root `directory` listing is keyed '.'; older bundles keyed it '' (see
      // moduleFileKey), which no load-time lookup hits. Normalize on parse so they keep
      // serving; '' and '.' alias to the SAME key, so both appearing is a duplicate -- fail closed.
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
        // A bundle carrying code in full scope must declare at least one entry: empty
        // entries would let `state.assertEntry` skip its check (it short-circuits on
        // entries.size === 0 for v0+no-lockfile compat), which a tampered bundle could
        // exploit. A resources-only bundle has no code and thus no entries -- allowed,
        // nothing for assertEntry to guard.
        let hasCode = false
        for (const [dir, { files }] of modules) {
          for (const rel of Object.keys(files)) {
            // moduleFileKey (not `${dir}/${rel}`): a `directory` capture at a module root
            // keys at rel === '', whose trailing-slash join would miss its resource-format
            // lookup and miscount the listing as code.
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
        // posixPathEscapes (not a '..' prefix check) so a mid-path escape or absolute
        // path fails too, matching Lockfile.parse. rel === '' (a `directory` capture at a
        // module root) normalizes to '.' and passes.
        for (const rel of Object.keys(files)) assert(!posixPathEscapes(rel))
      }
    } else {
      // v0 legacy: flat sources at top level, regrouped by inferred module dir.
      assert(json.sources)
      for (const [path, content] of Object.entries(json.sources)) {
        assert(!posixPathEscapes(path))
        const { dir, rel, name } = inferModuleDir(path)
        assert(!posixPathEscapes(dir) && !posixPathEscapes(rel))
        if (!modules.has(dir)) modules.set(dir, { name, version: null, files: Object.create(null) })
        modules.get(dir).files[rel] = content
      }
    }

    // Resolution edges name project-relative files on both sides; getImport resolves the
    // target against the project root, so a path escaping the root (including a mid-path
    // `a/../../x`) must be rejected here rather than pulling an out-of-tree file in at load.
    const imports = objectToMaps(json.imports)
    // An edge target is normally a file string, or a { platform: file } map (turned into
    // a Map by objectToMaps) for a `stasis bundle --metro` edge that resolves per platform.
    // Validate both shapes; reject anything else so a tampered artifact fails closed.
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

  // One unified on-disk shape for code AND resources, distinguished per file by `formats`
  // ('resource'/'resource:base64' = resource, else code). A bundle can hold both; readers
  // split by consulting `formats`.
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

  // Return a NEW Bundle attributing every file it carries to `consumer` in the
  // informational `reason` map (unioned with any existing attribution). The runtime path
  // tags files with a consumer as it records them, but static builders construct a Bundle
  // directly, so they stamp the consumer here -- keeping provenance complete when `--add`
  // merges statically bundled files into a bundle other consumers also touched.
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

  // Merge another Bundle into this one, returning a NEW Bundle carrying the union of both.
  // Backs `stasis bundle --add`: a freshly built bundle merges into the one on disk so the
  // artifact GROWS instead of being overwritten. Strict -- a bundle is an attestation, so
  // any genuine conflict (scope, module identity, bytes, format, import target) throws
  // rather than picking a winner; re-adding an identical file is a no-op. `reason` is
  // unioned per consumer.
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
