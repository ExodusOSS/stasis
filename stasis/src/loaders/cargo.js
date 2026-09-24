// Cargo manifests for the Rust loader: a Cargo.toml / Cargo.lock reader (the TOML subset Cargo
// uses), per-bundle package lookup, dependency resolution among in-tree crates (the package's own
// lib, workspace `path` deps, `cargo vendor`ed registry crates) and feature resolution done the
// way `cargo build` does it, so `#[cfg(feature = "…")]` can be decided per crate.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'

// `cargo vendor` copies registry crates in-tree under this dir.
export const VENDOR_DIR = 'vendor'

const toPosix = (p) => p.split(/[\\/]/u).join('/')

// --- Text helpers (shared with the Rust scanner) --------------------------------------

// Index of the bracket closing the one opened at `open`, or the last index when unbalanced.
export function matchClose(text, open) {
  const close = { '[': ']', '(': ')', '{': '}' }[text[open]]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return text.length - 1
}

// Split on commas outside brackets/braces/parentheses/strings.
export function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

// Project-relative `sub` under `dir`, normalized; null when it escapes the bundle root.
export function normalizeRel(dir, sub) {
  if (isAbsolute(sub) || posix.isAbsolute(sub)) return null
  const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, sub))
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return null
  return rel
}

const normName = (name) => name.replaceAll('-', '_')

function readFileOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// --- TOML subset ----------------------------------------------------------------------

// Drop a `# comment` outside strings.
function stripTomlComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

// Net bracket depth of a line (brackets inside strings don't count).
function bracketDepth(line) {
  let depth = 0
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
  }
  return depth
}

// Physical lines → logical lines: a `key = [` / `key = {` whose brackets don't close on the line
// takes the following lines up to the close (multi-line arrays are how long `features` lists and
// `members` are written). Comments are dropped first.
function logicalLines(text) {
  const lines = text.split('\n').map(stripTomlComment)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const kv = /^\s*[\w."'-]+\s*=\s*(.*)$/u.exec(line)
    if (kv) {
      let depth = bracketDepth(kv[1])
      while (depth > 0 && i + 1 < lines.length) {
        line += `\n${lines[++i]}`
        depth += bracketDepth(lines[i])
      }
    }
    out.push(line)
  }
  return out
}

// One TOML value: quoted string, bool, array (as an array), or a single-line inline table (as a
// plain object); anything else is returned raw.
export function parseTomlValue(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/u.exec(text)
    return m ? m[1].replaceAll(/\\(.)/gu, '$1') : text
  }
  if (text.startsWith("'")) {
    const m = /^'([^']*)'/u.exec(text)
    return m ? m[1] : text
  }
  if (text.startsWith('{')) {
    const end = matchClose(text, 0)
    const table = {}
    for (const part of splitTopLevel(text.slice(1, end))) {
      const kv = /^\s*([\w."'-]+)\s*=\s*([\s\S]+)$/u.exec(part)
      if (kv) table[kv[1].replaceAll(/["']/gu, '')] = parseTomlValue(kv[2])
    }
    return table
  }
  if (text.startsWith('[')) {
    const end = matchClose(text, 0)
    return splitTopLevel(text.slice(1, end)).map((p) => p.trim()).filter(Boolean).map(parseTomlValue)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

// --- Cargo.toml -----------------------------------------------------------------------

const DEP_TABLE_RE = /^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)(?:\.(.+))?$/u
const DEP_KINDS = { dependencies: 'normal', 'dev-dependencies': 'dev', 'build-dependencies': 'build' }

// Minimal Cargo.toml reader covering what crate and feature resolution and bucketing need: the
// package identity (name, version, edition, resolver), the lib target, every dependency table
// (kind, `path`/`version`/`package`/`workspace`, `optional`, `default-features`, `features`),
// `[features]`, `[patch.*]` path overrides and the workspace tables members inherit from.
// Dependency keys are normalized to the `use` spelling (`-` → `_`); feature names keep theirs.
export function parseCargoManifest(text) {
  const manifest = {
    package: null, // { name, version, versionFromWorkspace, edition }
    resolver: null, // "1" | "2" | "3" from [workspace] or [package]
    lib: { name: null, path: null },
    features: new Map(), // name -> implied entries (`other`, `dep:key`, `key/feat`, `key?/feat`)
    deps: new Map(), // key -> { key, version, path, package, workspace, optional, defaultFeatures, features, kinds }
    workspaceDeps: new Map(),
    workspacePackage: { version: null },
    patches: new Map(), // crate -> { path }
    isWorkspace: false,
  }
  const depOf = (map, name) => {
    const key = normName(name)
    if (!map.has(key)) map.set(key, { key, version: null, path: null, package: null, workspace: false, optional: false, defaultFeatures: true, features: [], kinds: new Set() })
    return map.get(key)
  }
  const setDepFields = (dep, table) => {
    if (typeof table === 'string') {
      dep.version = table // `foo = "1.2"`: a registry dep
      return
    }
    if (typeof table !== 'object' || table === null) return
    if (typeof table.version === 'string') dep.version = table.version
    if (typeof table.path === 'string') dep.path = table.path
    if (typeof table.package === 'string') dep.package = table.package
    if (table.workspace === true) dep.workspace = true
    if (table.optional === true) dep.optional = true
    if (table['default-features'] === false || table.default_features === false) dep.defaultFeatures = false
    if (Array.isArray(table.features)) dep.features = [...new Set([...dep.features, ...table.features.filter((f) => typeof f === 'string')])]
  }
  let table = ''
  for (const raw of logicalLines(text)) {
    const line = raw.trim()
    if (line === '') continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/u.exec(line)
    if (header) {
      table = header[1].trim()
      if (table === 'workspace') manifest.isWorkspace = true
      continue
    }
    const kv = /^([\w."'-]+)\s*=\s*([\s\S]+)$/u.exec(line)
    if (!kv) continue
    const key = kv[1].replaceAll(/["']/gu, '')
    const value = parseTomlValue(kv[2])
    if (table === 'package') {
      manifest.package ??= { name: null, version: null, versionFromWorkspace: false, edition: null }
      if (key === 'name' && typeof value === 'string') manifest.package.name = value
      else if (key === 'version' && typeof value === 'string') manifest.package.version = value
      else if ((key === 'version' && value?.workspace === true) || (key === 'version.workspace' && value === true)) manifest.package.versionFromWorkspace = true
      else if (key === 'edition' && typeof value === 'string') manifest.package.edition = value
      else if (key === 'resolver' && typeof value === 'string') manifest.resolver = value
    } else if (table === 'workspace') {
      if (key === 'resolver' && typeof value === 'string') manifest.resolver = value
    } else if (table === 'lib') {
      if (key === 'name' && typeof value === 'string') manifest.lib.name = value
      else if (key === 'path' && typeof value === 'string') manifest.lib.path = value
    } else if (table === 'workspace.package') {
      if (key === 'version' && typeof value === 'string') manifest.workspacePackage.version = value
    } else if (table === 'features') {
      if (Array.isArray(value)) manifest.features.set(key, value.filter((v) => typeof v === 'string'))
    } else if (table.startsWith('patch.')) {
      if (typeof value?.path === 'string') manifest.patches.set(normName(key), { path: value.path })
    } else {
      const ws = table.startsWith('workspace.')
      const m = DEP_TABLE_RE.exec(ws ? table.slice('workspace.'.length) : table)
      if (!m) continue
      const map = ws ? manifest.workspaceDeps : manifest.deps
      // `[dependencies.foo]` sub-table: each line is one field of `foo`; else each line is one dep.
      const dep = depOf(map, m[2] ?? key)
      setDepFields(dep, m[2] ? { [key]: value } : value)
      dep.kinds.add(DEP_KINDS[m[1]])
    }
  }
  if (manifest.package && !manifest.package.name) manifest.package = null
  return manifest
}

// --- Cargo.lock -----------------------------------------------------------------------

// `Cargo.lock` → `{ byId: Map<"name version", { name, version, deps: [{ name, version }] }>,
// byName: Map<name, [...] > }`, or null for no text. The lock is what says which of several
// vendored versions of a crate a given package depends on.
export function parseCargoLock(text) {
  if (text === null) return null
  const packages = []
  let cur = null
  let inDeps = false
  const dep = (s) => {
    const [name, version] = s.split(' ')
    return { name: normName(name), version: version ?? null }
  }
  for (const raw of text.split('\n')) {
    const line = stripTomlComment(raw).trim()
    if (line === '[[package]]') {
      cur = { name: null, version: null, deps: [] }
      packages.push(cur)
      inDeps = false
      continue
    }
    if (cur === null) continue
    if (inDeps) {
      if (line.startsWith(']')) inDeps = false
      else {
        const s = /^"([^"]*)"/u.exec(line)
        if (s) cur.deps.push(dep(s[1]))
      }
      continue
    }
    const kv = /^(\w+)\s*=\s*(.+)$/u.exec(line)
    if (!kv) continue
    if (kv[1] === 'name') cur.name = normName(parseTomlValue(kv[2]))
    else if (kv[1] === 'version') cur.version = parseTomlValue(kv[2])
    else if (kv[1] === 'dependencies') {
      if (kv[2].trim() === '[') inDeps = true
      else for (const s of parseTomlValue(kv[2])) if (typeof s === 'string') cur.deps.push(dep(s))
    }
  }
  const byId = new Map()
  const byName = new Map()
  for (const p of packages) {
    if (!p.name || !p.version) continue
    byId.set(`${p.name} ${p.version}`, p)
    if (!byName.has(p.name)) byName.set(p.name, [])
    byName.get(p.name).push(p)
  }
  return { byId, byName }
}

// Descending semver-ish order (numeric segments, prerelease last).
function compareVersionsDesc(a, b) {
  const pa = a.split(/[.+-]/u)
  const pb = b.split(/[.+-]/u)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    if (x === y) continue
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return ny - nx
    return y < x ? -1 : 1
  }
  return 0
}

// --- cargo metadata -------------------------------------------------------------------

// Run `cargo metadata` in the bundle root and return its JSON. Opt-in (`--cargo`): cargo compiles
// nothing and runs no build script for this, but it does what `cargo build` does to resolve --
// reads the project's `.cargo/config.toml` (which can point `build.rustc` or a wrapper at any
// executable), may refresh the registry index, and writes Cargo.lock when there is none -- so it
// is never run on a bundle root unasked. With a lockfile present, `--locked` keeps the
// resolution the one the build uses. `features`/`noDefaultFeatures`/`allFeatures` pass through.
export function runCargoMetadata(baseDir, { features = [], noDefaultFeatures = false, allFeatures = false } = {}) {
  const args = ['metadata', '--format-version', '1']
  if (existsSync(join(baseDir, 'Cargo.lock'))) args.push('--locked')
  if (allFeatures) args.push('--all-features')
  if (noDefaultFeatures) args.push('--no-default-features')
  for (const f of features) args.push('--features', f)
  const r = spawnSync('cargo', args, { cwd: baseDir, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) throw new Error(`cargo metadata could not run (${r.error.message}); is cargo on PATH?`, { cause: r.error })
  if (r.status !== 0) throw new Error(`cargo metadata failed (exit ${r.status}):\n${(r.stderr ?? '').trim()}`)
  return JSON.parse(r.stdout)
}

// `cargo metadata` JSON → `{ enabled: Map<dir, Set<feature>>, deps: Map<dir, Map<useName, dir>> }`
// over the packages the bundle can carry: those whose manifest lies inside the bundle root, plus
// registry packages cargo read from `~/.cargo/registry` (no `.cargo/config.toml` redirecting
// crates.io to `vendor/`) that `locate(name, version)` finds vendored in-tree -- `cargo vendor`
// copies exactly the lockfile's versions, so name + version identify the dir. Anything else (an
// unvendored registry crate, a path dep outside the root) can't be bundled and is dropped. `deps`
// maps each package's dependencies by the name code refers to them with (renames applied, `-` → `_`).
export function resolutionFromMetadata(metadata, baseDir, { locate = null } = {}) {
  let realBase = baseDir
  try {
    realBase = realpathSync(baseDir)
  } catch { /* keep the lexical path */ }
  const relDir = (manifestPath) => {
    if (typeof manifestPath !== 'string') return null
    const dir = dirname(manifestPath)
    for (const base of new Set([baseDir, realBase])) {
      const rel = toPosix(relative(base, dir))
      if (rel === '') return '.'
      if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
    }
    return null
  }
  const dirOf = new Map()
  for (const p of metadata.packages ?? []) {
    const dir = relDir(p.manifest_path) ?? locate?.(p.name, p.version) ?? null
    if (dir !== null) dirOf.set(p.id, dir)
  }
  const enabled = new Map()
  const deps = new Map()
  for (const node of metadata.resolve?.nodes ?? []) {
    const dir = dirOf.get(node.id)
    if (dir === undefined) continue
    enabled.set(dir, new Set((node.features ?? []).filter((f) => typeof f === 'string')))
    const byName = new Map()
    for (const d of node.deps ?? []) {
      const target = dirOf.get(d.pkg)
      if (target !== undefined && typeof d.name === 'string') byName.set(normName(d.name), target)
    }
    deps.set(dir, byName)
  }
  return { enabled, deps }
}

// --- Context ----------------------------------------------------------------------------

// Per-bundle Cargo state: manifest lookup (memoized per directory), crate-name resolution against
// in-tree sources, and feature resolution for the packages owning `entries` (the crate roots being
// bundled, like `cargo build -p …`). `features` / `noDefaultFeatures` / `allFeatures` mirror
// cargo's flags for those root packages (`pkg/feat` targets one of them). `cargo: true` takes the
// dependency graph and features from `cargo metadata` (see runCargoMetadata) instead of replaying
// the manifests. `baseDir` is the bundle root; every path in and out is project-relative POSIX.
export function createCargoContext(baseDir, { entries = [], features = [], noDefaultFeatures = false, allFeatures = false, cargo = false } = {}) {
  const manifests = new Map()
  const readManifest = (dir) => {
    if (!manifests.has(dir)) {
      const text = readFileOrNull(join(baseDir, dir, 'Cargo.toml'))
      manifests.set(dir, text === null ? null : { dir, ...parseCargoManifest(text) })
    }
    return manifests.get(dir)
  }
  const isFile = (rel) => {
    try {
      return statSync(join(baseDir, rel)).isFile()
    } catch {
      return false
    }
  }
  // Manifests at or above `dir`, nearest first, up to the bundle root.
  const manifestsAbove = function* (dir) {
    for (;;) {
      const m = readManifest(dir)
      if (m) yield m
      if (dir === '.' || dir === '') return
      dir = posix.dirname(dir)
    }
  }
  const packageFor = (fileRel) => {
    for (const m of manifestsAbove(posix.dirname(fileRel))) if (m.package) return m
    return null
  }
  const workspaceFor = (dir) => {
    for (const m of manifestsAbove(dir)) if (m.isWorkspace) return m
    return null
  }
  // The manifest's lib target root when it is on disk (`[lib] path`, default `src/lib.rs`).
  const libPath = (m) => {
    const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
    return rel !== null && isFile(rel) ? rel : null
  }
  const libName = (m) => normName(m.lib.name ?? m.package?.name ?? '')
  const version = (m) => {
    if (m.package.versionFromWorkspace) return workspaceFor(m.dir)?.workspacePackage.version ?? '0.0.0'
    return m.package.version ?? '0.0.0'
  }

  // --- dependency resolution

  // `vendor/<dir>/` crates by normalized name: [{ version, dir }]. The dir may hyphenate a
  // snake_case name, and an older duplicate version lives in `<name>-<version>/`.
  let vendorIndex = null
  const vendored = () => {
    if (vendorIndex === null) {
      vendorIndex = new Map()
      let dirs = []
      try {
        dirs = readdirSync(join(baseDir, VENDOR_DIR))
      } catch { /* no vendor dir */ }
      for (const d of dirs) {
        const m = readManifest(`${VENDOR_DIR}/${d}`)
        if (!m?.package) continue
        const key = normName(m.package.name)
        if (!vendorIndex.has(key)) vendorIndex.set(key, [])
        vendorIndex.get(key).push({ version: version(m), dir: m.dir })
      }
    }
    return vendorIndex
  }
  let lock
  const lockfile = () => {
    if (lock === undefined) lock = parseCargoLock(readFileOrNull(join(baseDir, 'Cargo.lock')))
    return lock
  }
  // `--cargo`: the graph and features as cargo resolved them, with registry packages it read from
  // the registry cache matched to their `vendor/` copy by name + version.
  const metadata = cargo
    ? resolutionFromMetadata(runCargoMetadata(baseDir, { features, noDefaultFeatures, allFeatures }), baseDir, {
        locate: (name, ver) => (typeof name === 'string' ? vendored().get(normName(name))?.find((c) => c.version === ver)?.dir ?? null : null),
      })
    : null
  // A dependency as the package sees it: a `workspace = true` entry merged with the workspace's
  // (features add up, the path is relative to the workspace root). Null when it can't be resolved.
  const depSpec = (m, dep) => {
    if (!dep.workspace) return { ...dep, relTo: m.dir }
    const ws = workspaceFor(m.dir)
    const base = ws?.workspaceDeps.get(dep.key)
    if (!base) return null
    return {
      ...base,
      key: dep.key,
      optional: dep.optional,
      kinds: dep.kinds,
      features: [...new Set([...base.features, ...dep.features])],
      defaultFeatures: base.defaultFeatures && dep.defaultFeatures,
      relTo: ws.dir,
    }
  }
  // The in-tree package a dependency of `m` resolves to: a `path` dep (or a `[patch]` path
  // override in the root manifest), else the vendored crate of that name -- the version Cargo.lock
  // records for `m`, or the newest when there is no lock to say. Null when it isn't in-tree.
  const resolveDep = (m, dep) => {
    const asPackage = (dir) => {
      const t = dir === null ? null : readManifest(dir)
      return t?.package ? t : null
    }
    // cargo metadata knows exactly which package each dependency edge points at.
    const known = metadata?.deps.get(m.dir)?.get(dep.key)
    if (known !== undefined) return asPackage(known)
    const spec = depSpec(m, dep)
    if (!spec) return null
    if (spec.path) return asPackage(normalizeRel(spec.relTo, spec.path))
    const crate = normName(spec.package ?? spec.key)
    const patch = readManifest('.')?.patches.get(crate)
    if (patch) return asPackage(normalizeRel('.', patch.path))
    const candidates = vendored().get(crate) ?? []
    if (candidates.length === 0) return null
    if (candidates.length === 1) return readManifest(candidates[0].dir)
    const lk = lockfile()
    if (lk) {
      const entry = lk.byId.get(`${normName(m.package.name)} ${version(m)}`)
      const d = entry?.deps.find((x) => x.name === crate)
      const only = lk.byName.get(crate)
      const want = d?.version ?? (only?.length === 1 ? only[0].version : null)
      const hit = want === null ? undefined : candidates.find((c) => c.version === want)
      if (hit) return readManifest(hit.dir)
    }
    return readManifest(candidates.toSorted((a, b) => compareVersionsDesc(a.version, b.version))[0].dir)
  }

  // --- feature resolution

  // Cargo's feature resolver: v2 (edition 2021+, or `resolver = "2"`/`"3"`) leaves dev-dependencies
  // out of a normal build's unification; v1 counts them.
  const resolverVersion = () => {
    const root = readManifest('.')
    const explicit = Number(root?.resolver)
    if (Number.isInteger(explicit) && explicit > 0) return explicit
    return Number(root?.package?.edition ?? 0) >= 2021 ? 2 : 1
  }
  // An optional dependency no `dep:` entry names gets an implicit feature of its own name.
  const implicitFeatures = (m) => {
    if (m.implicit === undefined) {
      const referenced = new Set()
      for (const imps of m.features.values()) for (const s of imps) if (s.startsWith('dep:')) referenced.add(normName(s.slice(4)))
      m.implicit = new Map()
      for (const d of m.deps.values()) if (d.optional && !referenced.has(d.key)) m.implicit.set(d.key, [`dep:${d.key}`])
    }
    return m.implicit
  }
  const featureImplications = (m, f) => m.features.get(f) ?? implicitFeatures(m).get(f) ?? null

  let resolution = null
  // Enabled features per package dir, for every package the root packages' builds pull in:
  // the roots start from `default` (or the flags), then features imply features, activate
  // optional deps and request dependency features, and active deps get `default` plus what the
  // dependent asks for, to a fixed point -- cargo's unification, over-approximating where the
  // loader can't tell (target-specific dependency tables always count).
  const ensureResolved = () => {
    if (resolution !== null) return resolution
    if (metadata) {
      resolution = { enabled: metadata.enabled }
      return resolution
    }
    const enabled = new Map()
    resolution = { enabled }
    const roots = [...new Set(entries.map((e) => packageFor(e)?.dir).filter((d) => d !== undefined))].map(readManifest)
    if (roots.length === 0) return resolution
    const resolver = resolverVersion()
    const active = new Map() // dir -> Set<dep key> (activated optional deps)
    let changed = false
    const inGraph = (m) => {
      if (!enabled.has(m.dir)) {
        enabled.set(m.dir, new Set())
        changed = true
      }
      return enabled.get(m.dir)
    }
    const enable = (m, f) => {
      const set = inGraph(m)
      if (featureImplications(m, f) === null || set.has(f)) return // unknown feature: cargo would error
      set.add(f)
      changed = true
    }
    const activate = (m, key) => {
      if (!active.has(m.dir)) active.set(m.dir, new Set())
      if (active.get(m.dir).has(key)) return
      active.get(m.dir).add(key)
      changed = true
    }
    const isActive = (m, d) => !d.optional || active.get(m.dir)?.has(d.key) === true
    const kindApplies = (d) => d.kinds.has('normal') || d.kinds.has('build') || (resolver === 1 && d.kinds.has('dev'))

    // `--features a,b,pkg/c`: bare names go to every root package, `pkg/c` to that one.
    const requested = new Map()
    for (const f of features.flatMap((s) => s.split(/[\s,]+/u)).filter(Boolean)) {
      const slash = f.indexOf('/')
      const [pkg, feat] = slash === -1 ? ['*', f] : [normName(f.slice(0, slash)), f.slice(slash + 1)]
      if (!requested.has(pkg)) requested.set(pkg, new Set())
      requested.get(pkg).add(feat)
    }
    for (const m of roots) {
      inGraph(m)
      if (allFeatures) {
        for (const f of m.features.keys()) enable(m, f)
        for (const f of implicitFeatures(m).keys()) enable(m, f)
      } else if (!noDefaultFeatures) {
        enable(m, 'default')
      }
      for (const f of requested.get('*') ?? []) enable(m, f)
      for (const f of requested.get(normName(m.package.name)) ?? []) enable(m, f)
    }

    do {
      changed = false
      // Map/Set iteration is live: packages and features added mid-pass are visited in this pass.
      for (const dir of enabled.keys()) {
        const m = readManifest(dir)
        for (const f of enabled.get(dir)) {
          for (const imp of featureImplications(m, f) ?? []) {
            const explicitDep = /^dep:(.+)$/u.exec(imp)
            if (explicitDep) {
              activate(m, normName(explicitDep[1]))
              continue
            }
            const depFeature = /^([^/?]+)(\?)?\/(.+)$/u.exec(imp)
            if (depFeature) {
              const d = m.deps.get(normName(depFeature[1]))
              if (!d) continue
              // `dep/feat` enables an optional dep (and its implicit feature); `dep?/feat` only asks if it is already on.
              if (depFeature[2] !== '?' && d.optional) {
                activate(m, d.key)
                if (implicitFeatures(m).has(d.key)) enable(m, d.key)
              }
              if (isActive(m, d) && kindApplies(d)) {
                const t = resolveDep(m, d)
                if (t) enable(t, depFeature[3])
              }
              continue
            }
            enable(m, imp)
          }
        }
        for (const d of m.deps.values()) {
          if (!kindApplies(d) || !isActive(m, d)) continue
          const t = resolveDep(m, d)
          if (!t) continue
          inGraph(t)
          const spec = depSpec(m, d)
          if (spec.defaultFeatures) enable(t, 'default')
          for (const f of spec.features) enable(t, f)
        }
      }
    } while (changed)
    return resolution
  }

  return {
    // Identity of the package owning `fileRel` -- `{ dir, name, version }` from the nearest
    // Cargo.toml with a [package] -- or null when no manifest claims it.
    packageInfo(fileRel) {
      const m = packageFor(fileRel)
      return m ? { dir: m.dir, name: m.package.name, version: version(m) } : null
    },
    // Whether `fileRel` is the lib target root of the package owning it (a crate root by role,
    // whatever its name).
    isLibRoot(fileRel) {
      const m = packageFor(fileRel)
      return m !== null && libPath(m) === fileRel
    },
    // Resolve a crate name as used in source (`use name::…`, `extern crate name`) from `fromFile`
    // to a crate root in-tree: the owning package's own lib, the package its dependency of that
    // name resolves to (path dep, `[patch]`, or the vendored version Cargo.lock says), or -- for a
    // name no manifest declares -- a vendored crate of that name. Null for anything else (a
    // registry dep that isn't vendored, std, a name that isn't a crate).
    resolveCrate(name, fromFile) {
      const norm = normName(name)
      const m = packageFor(fromFile)
      if (m) {
        if (libName(m) === norm) {
          const lib = libPath(m)
          if (lib && lib !== fromFile) return lib
        }
        const d = m.deps.get(norm)
        if (d) {
          const t = resolveDep(m, d)
          const lib = t ? libPath(t) : null
          if (lib) return lib
        }
      }
      for (const c of (vendored().get(norm) ?? []).toSorted((a, b) => compareVersionsDesc(a.version, b.version))) {
        const lib = libPath(readManifest(c.dir))
        if (lib) return lib
      }
      return null
    },
    // The features enabled for the package owning `fileRel` in the build of the root packages, or
    // null when that is unknown: no owning manifest, no root package to resolve from, or a package
    // the resolved build doesn't pull in (its gated code is then kept, not dropped).
    featuresFor(fileRel) {
      const m = packageFor(fileRel)
      if (!m) return null
      return ensureResolved().enabled.get(m.dir) ?? null
    },
    // Every resolved package: dir -> Set<feature>. For diagnostics and tests.
    resolvedFeatures() {
      return ensureResolved().enabled
    },
  }
}
