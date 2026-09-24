// Cargo manifests for the Rust loader: a Cargo.toml / Cargo.lock reader (the TOML subset Cargo
// uses), per-bundle package lookup, dependency resolution among in-tree crates (the package's own
// lib, workspace `path` deps, `cargo vendor`ed registry crates) and feature resolution done the
// way `cargo build` does it, so `#[cfg(feature = "…")]` can be decided per crate.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'

import { toPosix } from '@exodus/stasis-core/util'

// `cargo vendor` copies registry crates in-tree under this dir.
export const VENDOR_DIR = 'vendor'

// A crate name as source spells it (`use proc_macro2`): Cargo allows `-`, rustc doesn't.
export const normName = (name) => name.replaceAll('-', '_')

export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readFileOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

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

// --- TOML subset ----------------------------------------------------------------------

// `[table]` / `[[array-table]]` header → its name; `key = value` → key (quotes kept) and raw value.
const TABLE_HEADER_RE = /^\[\[?\s*([^\]]+?)\s*\]\]?/u
const KEY_VALUE_RE = /^([\w."'-]+)\s*=\s*([\s\S]+)$/u

// One physical line: `code` is the line without its `# comment`, `depth` its net bracket depth,
// both judged outside quoted strings (a `#`, `[` or `{` inside one is text).
function scanTomlLine(line) {
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
    else if (ch === '#') return { code: line.slice(0, i), depth }
  }
  return { code: line, depth }
}

// Physical lines → logical lines: a `key = """` / `key = '''` multi-line string takes the lines
// up to its closing delimiter verbatim (a `[x]` inside a description is text, not a table), and a
// `key = [` / `key = {` whose brackets don't close on the line takes the following lines up to
// the close (multi-line arrays are how long `features` lists and `members` are written).
// Comments are dropped from the non-string lines.
function logicalLines(text) {
  const raw = text.split('\n')
  const out = []
  for (let i = 0; i < raw.length; i++) {
    let { code: line, depth } = scanTomlLine(raw[i])
    const kv = KEY_VALUE_RE.exec(line.trim())
    if (kv) {
      const ml = /^("""|''')/u.exec(kv[2])
      if (ml && kv[2].indexOf(ml[1], 3) === -1) {
        line = raw[i]
        while (i + 1 < raw.length) {
          line += `\n${raw[++i]}`
          if (raw[i].includes(ml[1])) break
        }
      } else {
        while (depth > 0 && i + 1 < raw.length) {
          const next = scanTomlLine(raw[++i])
          line += `\n${next.code}`
          depth += next.depth
        }
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
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const delim = text.slice(0, 3)
    const end = text.indexOf(delim, 3)
    return (end === -1 ? text.slice(3) : text.slice(3, end)).replace(/^\n/u, '')
  }
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
      const kv = KEY_VALUE_RE.exec(part.trim())
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
// Entries of a `[features]` list beyond a plain feature name: `dep:key` and `key/feat` / `key?/feat`.
const DEP_IMPLICATION_RE = /^dep:(.+)$/u
const DEP_FEATURE_RE = /^([^/?]+)(\?)?\/(.+)$/u

// What one dependency table asks of a crate. `defaultFeatures` is tri-state: null until the table
// says (an inherited `workspace = true` entry can only turn defaults on, not off).
const newRequest = () => ({ optional: false, defaultFeatures: null, features: [] })

// `--features a,b pkg/c` (cargo's syntax: repeatable, comma- or space-separated) → the list of names.
export function parseFeatureList(values) {
  return [...new Set(values.flatMap((s) => s.split(/[\s,]+/u)).map((s) => s.trim()).filter(Boolean))]
}

// Whether a source file belongs to a test or bench target of the package at `pkgDir` (`tests/*.rs`,
// `benches/*.rs` and what they declare): rustc compiles those with `cfg(test)`.
export function isTestTargetPath(pkgDir, fileRel) {
  const inside = pkgDir === '.' || pkgDir === '' ? fileRel : (fileRel.startsWith(`${pkgDir}/`) ? fileRel.slice(pkgDir.length + 1) : fileRel)
  const first = inside.split('/')[0]
  return first === 'tests' || first === 'benches'
}

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
    // key -> { key, name, version, path, package, workspace, kinds: Map<kind, { optional, defaultFeatures, features }> }:
    // what identifies the crate is shared, what is asked of it is per dependency table -- sha2's
    // `[dependencies] digest = "0.10"` and `[dev-dependencies] digest = { features = ["dev"] }` are
    // two requests, and only the first is part of a build of sha2's dependents.
    deps: new Map(),
    workspaceDeps: new Map(), // key -> { key, name, version, path, package, optional, defaultFeatures, features }
    workspacePackage: { version: null },
    patches: new Map(), // crate -> path
    isWorkspace: false,
  }
  // `key` is the `use` spelling (`-` → `_`); `name` the manifest's, which is also the implicit
  // feature an optional dependency defines (`#[cfg(feature = "proc-macro-crate")]`).
  const depOf = (map, name, { flat }) => {
    const key = normName(name)
    if (!map.has(key)) {
      map.set(key, { key, name, version: null, path: null, package: null, workspace: false, ...(flat ? newRequest() : { kinds: new Map() }) })
    }
    return map.get(key)
  }
  // Apply one table (or one `[dependencies.foo]` line) to a dependency: identity fields on the
  // record, request fields on the entry for `kind` (or on the record itself for a flat one).
  const setDepFields = (dep, table, kind) => {
    const request = kind === null ? dep : (dep.kinds.get(kind) ?? dep.kinds.set(kind, newRequest()).get(kind))
    if (typeof table === 'string') {
      dep.version = table // `foo = "1.2"`: a registry dep
      return
    }
    if (typeof table !== 'object' || table === null) return
    if (typeof table.version === 'string') dep.version = table.version
    if (typeof table.path === 'string') dep.path = table.path
    if (typeof table.package === 'string') dep.package = table.package
    if (table.workspace === true) dep.workspace = true
    if (table.optional === true) request.optional = true
    const defaults = table['default-features'] ?? table.default_features
    if (defaults === true || defaults === false) request.defaultFeatures = defaults
    if (Array.isArray(table.features)) request.features = [...new Set([...request.features, ...table.features.filter((f) => typeof f === 'string')])]
  }
  let table = ''
  for (const raw of logicalLines(text)) {
    const line = raw.trim()
    const header = TABLE_HEADER_RE.exec(line)
    if (header) {
      table = header[1].trim()
      if (table === 'workspace') manifest.isWorkspace = true
      continue
    }
    const kv = KEY_VALUE_RE.exec(line)
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
      if (typeof value?.path === 'string') manifest.patches.set(normName(key), value.path)
    } else {
      const ws = table.startsWith('workspace.')
      const m = DEP_TABLE_RE.exec(ws ? table.slice('workspace.'.length) : table)
      if (!m) continue
      const map = ws ? manifest.workspaceDeps : manifest.deps
      // `[dependencies.foo]` sub-table: each line is one field of `foo`; a dotted `foo.features = […]`
      // line is one field too; else each line is one dep.
      const dot = m[2] ? -1 : key.indexOf('.')
      const depName = m[2] ?? (dot === -1 ? key : key.slice(0, dot))
      const field = m[2] ? key : (dot === -1 ? null : key.slice(dot + 1))
      const dep = depOf(map, depName, { flat: ws })
      setDepFields(dep, field === null ? value : { [field]: value }, ws ? null : DEP_KINDS[m[1]])
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
  let cur = null // the [[package]] being read; null inside any other table
  // A dependency is `"name"`, or `"name version"` when several versions of it are locked.
  const dep = (s) => {
    const [name, version] = s.split(' ')
    return { name: normName(name), version: version ?? null }
  }
  for (const raw of logicalLines(text)) {
    const line = raw.trim()
    const header = TABLE_HEADER_RE.exec(line)
    if (header) {
      cur = header[1].trim() === 'package' ? { name: null, version: null, deps: [] } : null
      if (cur) packages.push(cur)
      continue
    }
    const kv = cur === null ? null : KEY_VALUE_RE.exec(line)
    if (!kv) continue
    const value = parseTomlValue(kv[2])
    if (kv[1] === 'name' && typeof value === 'string') cur.name = normName(value)
    else if (kv[1] === 'version' && typeof value === 'string') cur.version = value
    else if (kv[1] === 'dependencies' && Array.isArray(value)) {
      for (const s of value) if (typeof s === 'string') cur.deps.push(dep(s))
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

// --- Versions -------------------------------------------------------------------------

// `1.2.3-beta.1+build` → { parts: [1, 2, 3], pre: 'beta.1' }; a partial `1.2` keeps null for the
// missing parts (a requirement's precision matters). Null when it isn't a version.
function parseVersion(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text.trim())
  if (!m) return null
  return { parts: [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])], pre: m[4] ?? null }
}

// Semver order; a prerelease sorts below its release.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0)
    if (d !== 0) return d
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

// Descending, for picking the newest of several versions; unparsable strings sort last.
function compareVersionsDesc(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va && vb) return compareVersions(vb, va)
  if (va) return -1
  if (vb) return 1
  return a < b ? 1 : (a > b ? -1 : 0)
}

// One comparator of a Cargo requirement against a version: caret (the default -- `1.2` is
// `>=1.2.0, <2.0.0`; `0.9` is `>=0.9.0, <0.10.0`; `0.0.3` is `<0.0.4`), tilde, wildcard (`1.*`),
// `=` (partial `=1.2` covers the minor), and the comparison operators (a partial `>1.2` means
// `>=1.3.0`, `<=1.2` means `<1.3.0`: the whole minor is inside).
function satisfiesComparator(v, comparator) {
  const c = comparator.trim()
  if (c === '*' || c === '') return true
  const m = /^(\^|~|=|>=|>|<=|<)?\s*(.+)$/u.exec(c)
  let op = m[1] ?? '^'
  let text = m[2]
  const wild = /^(\d+)(?:\.(\d+))?\.[*xX]$/u.exec(text)
  if (wild) {
    op = '~'
    text = wild[2] === undefined ? wild[1] : `${wild[1]}.${wild[2]}`
  }
  const r = parseVersion(text)
  if (!r) return false
  const [ma, mi, pa] = r.parts
  const lower = { parts: [ma, mi ?? 0, pa ?? 0], pre: r.pre }
  const upper = (a, b, p) => ({ parts: [a, b, p], pre: null })
  const within = (hi) => compareVersions(v, lower) >= 0 && compareVersions(v, hi) < 0
  // The version just past a partial requirement's range (`1.2` → 1.3.0, `1` → 2.0.0); null when full.
  const past = pa !== null ? null : (mi === null ? upper(ma + 1, 0, 0) : upper(ma, mi + 1, 0))
  switch (op) {
    case '=':
      if (past === null) return compareVersions(v, lower) === 0
      return within(past)
    case '>': return past === null ? compareVersions(v, lower) > 0 : compareVersions(v, past) >= 0
    case '>=': return compareVersions(v, lower) >= 0
    case '<': return compareVersions(v, lower) < 0
    case '<=': return past === null ? compareVersions(v, lower) <= 0 : compareVersions(v, past) < 0
    case '~': return within(mi === null ? upper(ma + 1, 0, 0) : upper(ma, mi + 1, 0))
    default: // caret: the leftmost non-zero part may not change
      if (ma > 0) return within(upper(ma + 1, 0, 0))
      if (mi === null) return within(upper(1, 0, 0))
      if (mi > 0 || pa === null) return within(upper(0, mi + 1, 0))
      return within(upper(0, 0, pa + 1))
  }
}

// Whether `version` satisfies a Cargo version requirement (`"0.9"`, `"^1.2"`, `"~1.2.3"`,
// `"=1.0.0"`, `">=1, <2"`, `"1.*"`, `"*"`).
export function satisfiesCargoReq(version, req) {
  const v = parseVersion(version)
  if (!v) return false
  return req.split(',').every((c) => satisfiesComparator(v, c))
}

// --- cargo metadata -------------------------------------------------------------------

// The Cargo.lock governing `baseDir`: in it or in an ancestor (a member dir's lock is its workspace root's).
export function findCargoLock(baseDir) {
  let dir = baseDir
  for (;;) {
    const candidate = join(dir, 'Cargo.lock')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Run `cargo metadata` in the bundle root and return its JSON. Opt-in (`--cargo`) because it runs
// cargo, which reads the project's `.cargo/config.toml` and may touch the registry and Cargo.lock
// (doc/file-formats.md has the full caveat); never run on a bundle root unasked. With a lockfile
// present, `--locked` keeps the resolution the one the build uses. The feature flags pass through.
export function runCargoMetadata(baseDir, { features = [], noDefaultFeatures = false, allFeatures = false } = {}) {
  const args = ['metadata', '--format-version', '1']
  // A lock anywhere above governs too: never let metadata rewrite a workspace lock outside the bundle root.
  if (findCargoLock(baseDir) !== null) args.push('--locked')
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
  // Manifests at or above `dir`, nearest first, up to the bundle root.
  const manifestsAbove = function* (dir) {
    for (;;) {
      const m = readManifest(dir)
      if (m) yield m
      if (dir === '.' || dir === '') return
      dir = posix.dirname(dir)
    }
  }
  // The package owning a file: the nearest manifest above it with a [package]; memoized per
  // directory (every lookup below starts here, several times per file).
  const packageByDir = new Map()
  const packageFor = (fileRel) => {
    const dir = posix.dirname(fileRel)
    if (!packageByDir.has(dir)) {
      let found = null
      for (const m of manifestsAbove(dir)) {
        if (m.package) {
          found = m
          break
        }
      }
      packageByDir.set(dir, found)
    }
    return packageByDir.get(dir)
  }
  const workspaceFor = (dir) => {
    for (const m of manifestsAbove(dir)) if (m.isWorkspace) return m
    return null
  }
  // The manifest's lib target root when it is on disk (`[lib] path`, default `src/lib.rs`);
  // memoized on the manifest, since it is asked for once per crate reference.
  const libPath = (m) => {
    if (m.libRoot === undefined) {
      const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
      m.libRoot = rel !== null && isFile(join(baseDir, rel)) ? rel : null
    }
    return m.libRoot
  }
  const libName = (m) => normName(m.lib.name ?? m.package?.name ?? '')
  // Whether `fileRel` belongs to a test or bench target of its package (compiled with `cfg(test)`).
  const isTestTarget = (fileRel) => isTestTargetPath(packageFor(fileRel)?.dir ?? '.', fileRel)
  const version = (m) => {
    if (m.package.versionFromWorkspace) return workspaceFor(m.dir)?.workspacePackage.version ?? '0.0.0'
    return m.package.version ?? '0.0.0'
  }

  // --- dependency resolution

  // `vendor/<dir>/` crates as `[{ version, dir }]`, indexed `byName` (normalized package name; the
  // dir may hyphenate a snake_case name, and an older duplicate version lives in
  // `<name>-<version>/`) and `byLib` (lib name, for the crates whose `[lib] name` differs:
  // `md-5` → `md5`).
  let vendorIndex = null
  const vendored = () => {
    if (vendorIndex === null) {
      vendorIndex = { byName: new Map(), byLib: new Map() }
      let dirs = []
      try {
        dirs = readdirSync(join(baseDir, VENDOR_DIR))
      } catch { /* no vendor dir */ }
      for (const d of dirs) {
        const m = readManifest(`${VENDOR_DIR}/${d}`)
        if (!m?.package) continue
        const entry = { version: version(m), dir: m.dir }
        for (const [index, key] of [[vendorIndex.byName, normName(m.package.name)], [vendorIndex.byLib, libName(m)]]) {
          if (!index.has(key)) index.set(key, [])
          index.get(key).push(entry)
        }
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
        locate: (name, ver) => (typeof name === 'string' ? vendored().byName.get(normName(name))?.find((c) => c.version === ver)?.dir ?? null : null),
      })
    : null
  // A dependency as the package sees it through one of its tables (`request`, an entry of
  // `dep.kinds`; omit it for the identity alone): a `workspace = true` entry merged with the
  // workspace's -- features add up, the path is relative to the workspace root, and defaults are
  // the workspace's call (a member's `default-features = false` is ignored, with a cargo warning,
  // unless the workspace entry disables them too; a member's `true` turns them back on). Null when
  // it can't be resolved. `defaultFeatures` comes out boolean.
  const depSpec = (m, dep, request = null) => {
    const own = request ?? newRequest()
    if (!dep.workspace) {
      return { key: dep.key, version: dep.version, path: dep.path, package: dep.package, defaultFeatures: own.defaultFeatures !== false, features: own.features, relTo: m.dir }
    }
    const ws = workspaceFor(m.dir)
    const base = ws?.workspaceDeps.get(dep.key)
    if (!base) return null
    return {
      key: dep.key,
      version: base.version,
      path: base.path,
      package: base.package,
      defaultFeatures: base.defaultFeatures !== false || own.defaultFeatures === true,
      features: [...new Set([...base.features, ...own.features])],
      relTo: ws.dir,
    }
  }
  // Dependency → package, memoized per (package, dependency): the fixed-point loop asks many times.
  const depTargets = new Map()
  // The in-tree package a dependency of `m` resolves to: a `path` dep (or a `[patch]` path
  // override in the root manifest), else the vendored crate of that name -- the version Cargo.lock
  // records for `m`, else the newest that satisfies the requirement. A package can depend on two
  // versions of one crate (`borsh = "1"` beside `borsh0-9 = { package = "borsh", version = "0.9" }`):
  // the lock then lists both under it, and the requirement tells which is which. Null when it
  // isn't in-tree.
  const resolveDep = (m, dep) => {
    const memo = `${m.dir}\0${dep.key}`
    if (!depTargets.has(memo)) depTargets.set(memo, resolveDepUncached(m, dep))
    return depTargets.get(memo)
  }
  const resolveDepUncached = (m, dep) => {
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
    if (patch !== undefined) return asPackage(normalizeRel('.', patch))
    const candidates = vendored().byName.get(crate) ?? []
    if (candidates.length === 0) return null
    const req = typeof spec.version === 'string' ? spec.version : null
    const fits = (ver) => req === null || satisfiesCargoReq(ver, req)
    const lk = lockfile()
    if (lk) {
      const entry = lk.byId.get(`${normName(m.package.name)} ${version(m)}`)
      // The lock names a dependency with its version only when several versions of that crate are locked.
      const listed = (entry?.deps ?? []).filter((x) => x.name === crate)
      let want = null
      if (listed.length === 1) {
        const only = lk.byName.get(crate)
        want = listed[0].version ?? (only?.length === 1 ? only[0].version : null)
      } else if (listed.length > 1) {
        want = listed.map((x) => x.version).find((ver) => ver !== null && fits(ver)) ?? null
      }
      const hit = want === null ? undefined : candidates.find((c) => c.version === want)
      if (hit) return readManifest(hit.dir)
    }
    const fitting = candidates.filter((c) => fits(c.version))
    const pool = fitting.length > 0 ? fitting : candidates
    return readManifest(pool.toSorted((a, b) => compareVersionsDesc(a.version, b.version))[0].dir)
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
  // An optional dependency no `dep:` entry names gets an implicit feature of its own name -- as
  // the manifest spells it (`proc-macro-crate`), which is what `std = ["proc-macro-crate"]` and
  // `#[cfg(feature = "proc-macro-crate")]` refer to.
  const implicitFeatures = (m) => {
    if (m.implicit === undefined) {
      const referenced = new Set()
      for (const imps of m.features.values()) for (const s of imps) if (s.startsWith('dep:')) referenced.add(normName(s.slice(4)))
      m.implicit = new Map()
      for (const d of m.deps.values()) {
        if (isOptional(d) && !referenced.has(d.key)) m.implicit.set(d.name, [`dep:${d.key}`])
      }
    }
    return m.implicit
  }
  const isOptional = (d) => [...d.kinds.values()].some((r) => r.optional)
  const featureImplications = (m, f) => m.features.get(f) ?? implicitFeatures(m).get(f) ?? null

  let enabled = null
  // Enabled features per package dir, for every package the root packages' builds pull in:
  // the roots start from `default` (or the flags), then features imply features, activate
  // optional deps and request dependency features, and active deps get `default` plus what the
  // dependent asks for, to a fixed point -- cargo's unification, over-approximating where the
  // loader can't tell (target-specific dependency tables always count). Dev-dependencies: a
  // dependency's own are never built by anyone, so they never count; the root packages' count
  // under resolver 1 only (resolver 2 keeps them out of a normal build).
  const ensureResolved = () => {
    if (enabled !== null) return enabled
    if (metadata) {
      enabled = metadata.enabled
      return enabled
    }
    enabled = new Map()
    // The entries' packages (manifests are memoized per dir, so identity dedupes them).
    const roots = [...new Set(entries.map(packageFor).filter(Boolean))]
    if (roots.length === 0) return enabled
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
    const rootDirs = new Set(roots.map((r) => r.dir))
    // Dev-dependencies count for a root package under resolver 1, and for one whose entries include a
    // test/bench target (that build is `cargo test`'s, which links them).
    const testRootDirs = new Set(entries.filter((e) => isTestTarget(e)).map((e) => packageFor(e)?.dir))
    const kindApplies = (m, kind) => kind !== 'dev' || (rootDirs.has(m.dir) && (resolver === 1 || testRootDirs.has(m.dir)))
    // The tables of `d` that take part in the build, with an optional one only once activated.
    const activeRequests = (m, d) => [...d.kinds]
      .filter(([kind, r]) => kindApplies(m, kind) && (!r.optional || active.get(m.dir)?.has(d.key) === true))
      .map(([, r]) => r)
    // One entry of a feature's list: `other`, `dep:key`, `key/feat`, `key?/feat`. Returns whether it named anything.
    const applyImplication = (m, imp) => {
      const explicitDep = DEP_IMPLICATION_RE.exec(imp)
      if (explicitDep) {
        activate(m, normName(explicitDep[1]))
        return true
      }
      const depFeature = DEP_FEATURE_RE.exec(imp)
      if (depFeature) {
        const d = m.deps.get(normName(depFeature[1]))
        if (!d) return false
        // `dep/feat` enables an optional dep (and its implicit feature); `dep?/feat` only asks if it is already on.
        if (depFeature[2] !== '?' && isOptional(d)) {
          activate(m, d.key)
          if (implicitFeatures(m).has(d.name)) enable(m, d.name)
        }
        if (activeRequests(m, d).length > 0) {
          const t = resolveDep(m, d)
          if (t) enable(t, depFeature[3])
        }
        return true
      }
      if (featureImplications(m, imp) === null) return false
      enable(m, imp)
      return true
    }

    for (const m of roots) {
      inGraph(m)
      if (allFeatures) {
        for (const f of m.features.keys()) enable(m, f)
        for (const f of implicitFeatures(m).keys()) enable(m, f)
      } else if (!noDefaultFeatures) {
        enable(m, 'default')
      }
    }
    // `--features a,b,pkg/c`: a bare name is a feature of every root package; `x/c` is a feature of
    // the root package named `x`, else of the dependency `x` of each root (cargo's `dep/feat` form).
    const rootNames = new Set(roots.map((r) => normName(r.package.name)))
    for (const flag of parseFeatureList(features)) {
      const slash = flag.indexOf('/')
      const pkg = slash === -1 ? null : normName(flag.slice(0, slash))
      const scoped = pkg !== null && rootNames.has(pkg)
      const targets = scoped ? roots.filter((m) => normName(m.package.name) === pkg) : roots
      const imp = scoped ? flag.slice(slash + 1) : flag
      if (!targets.some((m) => applyImplication(m, imp))) {
        console.warn(`[stasis] --cargo-features: '${flag}' names no feature of the entries' packages, nor a dependency of theirs`)
      }
    }

    do {
      changed = false
      // Map/Set iteration is live: packages and features added mid-pass are visited in this pass.
      for (const dir of enabled.keys()) {
        const m = readManifest(dir)
        for (const f of enabled.get(dir)) {
          for (const imp of featureImplications(m, f) ?? []) applyImplication(m, imp)
        }
        for (const d of m.deps.values()) {
          for (const request of activeRequests(m, d)) {
            const spec = depSpec(m, d, request)
            const t = spec === null ? null : resolveDep(m, d)
            if (!t) continue
            inGraph(t)
            if (spec.defaultFeatures) enable(t, 'default')
            for (const f of spec.features) enable(t, f)
          }
        }
      }
    } while (changed)
    return enabled
  }

  // The in-tree crate root a name resolves to from package `m` (null: no owning package), leaving
  // out `m`'s own lib (which depends on the asking file): the package its dependency of that name
  // resolves to (path dep, `[patch]`, or the vendored version Cargo.lock says); a dependency whose
  // lib is named that (`md-5` is used as `md5`); or -- for a name no manifest declares -- a
  // vendored crate of that lib or package name. Memoized per (package, name): every file of a
  // package asks for the same few crates.
  const crateTargets = new Map()
  const depCrate = (m, norm) => {
    const memo = `${m?.dir ?? ''}\0${norm}`
    if (!crateTargets.has(memo)) crateTargets.set(memo, depCrateUncached(m, norm))
    return crateTargets.get(memo)
  }
  const depCrateUncached = (m, norm) => {
    if (m) {
      const d = m.deps.get(norm)
      if (d) {
        const t = resolveDep(m, d)
        const lib = t ? libPath(t) : null
        if (lib) return lib
      }
      for (const other of m.deps.values()) {
        if (other.key === norm || other.package !== null) continue // a rename is used by its key, not its lib name
        const t = resolveDep(m, other)
        if (t && libName(t) === norm) {
          const lib = libPath(t)
          if (lib) return lib
        }
      }
    }
    const { byLib, byName } = vendored()
    for (const index of [byLib, byName]) {
      for (const c of (index.get(norm) ?? []).toSorted((a, b) => compareVersionsDesc(a.version, b.version))) {
        const lib = libPath(readManifest(c.dir))
        if (lib) return lib
      }
    }
    return null
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
    // to a crate root in-tree: the owning package's own lib (from another of its files), else what
    // depCrate finds. Null for anything else (a registry dep that isn't vendored, std, a name that
    // isn't a crate).
    resolveCrate(name, fromFile) {
      const norm = normName(name)
      const m = packageFor(fromFile)
      if (m && libName(m) === norm) {
        const lib = libPath(m)
        if (lib && lib !== fromFile) return lib
      }
      return depCrate(m, norm)
    },
    isTestTarget,
    // The features enabled for the package owning `fileRel` in the build of the root packages, or
    // null when that is unknown: no owning manifest, no root package to resolve from, or a package
    // the resolved build doesn't pull in (its gated code is then kept, not dropped).
    featuresFor(fileRel) {
      const m = packageFor(fileRel)
      if (!m) return null
      return ensureResolved().get(m.dir) ?? null
    },
    // Every resolved package: dir -> Set<feature>. For diagnostics and tests.
    resolvedFeatures() {
      return ensureResolved()
    },
  }
}
