// Cargo manifests for the Rust loader: a Cargo.toml / Cargo.lock reader (over the TOML reader in
// toml.js), per-bundle package lookup, dependency resolution among in-tree crates (the package's
// own lib, workspace `path` deps, `cargo vendor`ed registry crates) and feature resolution done the
// way `cargo build` does it, so `#[cfg(feature = "…")]` can be decided per crate.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

import { toPosix } from '@exodus/stasis-core/util'

import { isTomlTable, readToml, splitTopLevel } from './toml.js'

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

// --- Paths ---------------------------------------------------------------------------

// Project-relative `sub` under `dir`, normalized; null when it escapes the bundle root.
export function normalizeRel(dir, sub) {
  if (isAbsolute(sub) || posix.isAbsolute(sub)) return null
  const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, sub))
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return null
  return rel
}

// --- Cargo.toml -----------------------------------------------------------------------

const DEP_KINDS = new Map([['dependencies', 'normal'], ['dev-dependencies', 'dev'], ['build-dependencies', 'build']])
// A request's kind (`normal`/`dev`/`build`), a target-specific table's `@<cfg>` suffix dropped.
const kindOf = (request) => request.split('@')[0]

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
// It reads the parsed table tree, so `[dependencies.foo] features = […]`, `[dependencies]
// foo.features = […]` and `foo = { features = […] }` are one thing. Throws a TomlError naming
// `file` on text that isn't TOML.
export function parseCargoManifest(text, file = null) {
  const manifest = {
    package: null, // { name, version, versionFromWorkspace, edition, editionFromWorkspace, build }
    resolver: null, // "1" | "2" | "3" from [workspace] or [package]
    lib: { name: null, path: null, procMacro: false }, // `procMacro`: `[lib] proc-macro = true`, a crate compiled for the host
    features: new Map(), // name -> implied entries (`other`, `dep:key`, `key/feat`, `key?/feat`)
    // key -> { key, name, version, path, package, workspace, kinds: Map<request, { optional, defaultFeatures, features }> }:
    // what identifies the crate is shared, what is asked of it is per dependency table -- sha2's
    // `[dependencies] digest = "0.10"` and `[dev-dependencies] digest = { features = ["dev"] }` are
    // two requests, and only the first is part of a build of sha2's dependents. A request is the
    // table's kind (`normal`, `dev`, `build`), with `@<cfg>` appended for a target-specific table:
    // `[target.'cfg(unix)'.dependencies] foo = { optional = true }` beside `[dependencies] foo = "1"`
    // is a second request of `foo`, not a change to the first.
    deps: new Map(),
    workspaceDeps: new Map(), // key -> { key, name, version, path, package, optional, defaultFeatures, features }
    workspacePackage: { version: null, edition: null },
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
  // Apply one dependency's spec to its record: identity fields on the record, request fields on
  // the entry for `kind` (or on the record itself for a flat one).
  const setDepFields = (dep, spec, kind) => {
    const request = kind === null ? dep : (dep.kinds.get(kind) ?? dep.kinds.set(kind, newRequest()).get(kind))
    if (typeof spec === 'string') {
      dep.version = spec // `foo = "1.2"`: a registry dep
      return
    }
    if (!isTomlTable(spec)) return
    if (typeof spec.version === 'string') dep.version = spec.version
    if (typeof spec.path === 'string') dep.path = spec.path
    if (typeof spec.package === 'string') dep.package = spec.package
    if (spec.workspace === true) dep.workspace = true
    if (spec.optional === true) request.optional = true
    const defaults = spec['default-features'] ?? spec.default_features
    if (defaults === true || defaults === false) request.defaultFeatures = defaults
    if (Array.isArray(spec.features)) request.features = [...new Set([...request.features, ...spec.features.filter((f) => typeof f === 'string')])]
  }
  const doc = readToml(text, file)
  const str = (v) => (typeof v === 'string' ? v : null)
  const table = (v) => (isTomlTable(v) ? v : null)
  // `version = { workspace = true }` or `version.workspace = true`: inherited, as `edition` may be.
  const inherited = (v) => table(v)?.workspace === true
  const pkg = table(doc.package)
  if (pkg !== null && typeof pkg.name === 'string') {
    manifest.package = {
      name: pkg.name,
      version: str(pkg.version),
      versionFromWorkspace: inherited(pkg.version),
      edition: str(pkg.edition),
      editionFromWorkspace: inherited(pkg.edition),
      // the build script: a path, `false` for none, null to look for `build.rs`
      build: typeof pkg.build === 'string' || pkg.build === false ? pkg.build : null,
    }
  }
  const ws = table(doc.workspace)
  // A `[workspace]` table, however it is spelled out, makes this a workspace root.
  manifest.isWorkspace = 'workspace' in doc
  manifest.resolver = str(ws?.resolver) ?? str(pkg?.resolver)
  const wsPackage = table(ws?.package)
  manifest.workspacePackage = { version: str(wsPackage?.version), edition: str(wsPackage?.edition) }
  const lib = table(doc.lib)
  manifest.lib = { name: str(lib?.name), path: str(lib?.path), procMacro: lib?.['proc-macro'] === true || lib?.proc_macro === true }
  for (const [name, list] of Object.entries(table(doc.features) ?? {})) {
    if (Array.isArray(list)) manifest.features.set(name, list.filter((v) => typeof v === 'string'))
  }
  // `[patch.<registry>] crate = { path = "…" }`, however it is spelled out.
  for (const registry of Object.values(table(doc.patch) ?? {})) {
    for (const [crate, spec] of Object.entries(table(registry) ?? {})) {
      const patch = str(table(spec)?.path)
      if (patch !== null) manifest.patches.set(normName(crate), patch)
    }
  }
  // `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, under `target.<cfg>` (a
  // request of its own, `<kind>@<cfg>`) or `workspace`, in the order the manifest has them: each
  // dependency a version string or a table.
  const depTables = (scope, into, flat, cfg = null) => {
    for (const [key, value] of Object.entries(scope)) {
      if (key === 'target' && cfg === null) {
        for (const [platform, tables] of Object.entries(table(value) ?? {})) depTables(table(tables) ?? {}, into, flat, platform)
        continue
      }
      const kind = DEP_KINDS.get(key)
      if (kind === undefined) continue
      const request = flat ? null : (cfg === null ? kind : `${kind}@${cfg}`)
      for (const [depName, spec] of Object.entries(table(value) ?? {})) setDepFields(depOf(into, depName, { flat }), spec, request)
    }
  }
  depTables(doc, manifest.deps, false)
  if (ws !== null) depTables(ws, manifest.workspaceDeps, true)
  return manifest
}

// --- Cargo.lock -----------------------------------------------------------------------

// `Cargo.lock` → `{ byId: Map<"name version", { name, version, deps: [{ name, version }] }>,
// byName: Map<name, [...] > }`, or null for no text. The lock is what says which of several
// vendored versions of a crate a given package depends on. Throws a TomlError naming `file` on
// text that isn't TOML.
export function parseCargoLock(text, file = null) {
  if (text === null) return null
  // A dependency is `"name"`, or `"name version"` when several versions of it are locked.
  const dep = (s) => {
    const [name, version] = s.split(' ')
    return { name: normName(name), version: version ?? null }
  }
  const packages = []
  const locked = readToml(text, file).package
  for (const p of Array.isArray(locked) ? locked : []) {
    if (!isTomlTable(p)) continue
    packages.push({
      name: typeof p.name === 'string' ? normName(p.name) : null,
      version: typeof p.version === 'string' ? p.version : null,
      deps: Array.isArray(p.dependencies) ? p.dependencies.filter((d) => typeof d === 'string').map(dep) : [],
    })
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
    // A bare wildcard is a tilde range; with an operator the `*` just omits the component (`>=1.*` is `>=1`).
    if (m[1] === undefined) op = '~'
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

// The Cargo.lock governing `baseDir`: beside the workspace root's Cargo.toml -- the nearest manifest
// at or above `baseDir` with a `[workspace]` table, as cargo finds it -- else beside `baseDir`'s
// own. A lock further up belongs to some other project: passing `--locked` for it would make
// cargo refuse to create the one it needs.
export function findCargoLock(baseDir) {
  let root = baseDir
  for (let dir = baseDir; ;) {
    const file = join(dir, 'Cargo.toml')
    const text = readFileOrNull(file)
    if (text !== null && parseCargoManifest(text, file).isWorkspace) {
      root = dir
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const candidate = join(root, 'Cargo.lock')
  return existsSync(candidate) ? candidate : null
}

// --- cfg predicates ---------------------------------------------------------------------

export const normalizeCfg = (pred) => pred.replaceAll(/\s+/gu, ' ').trim()

const FEATURE_CFG_RE = /^feature\s*=\s*"([^"]*)"$/u
// Any other leaf: `unix`, `target_os = "linux"`.
const CFG_LEAF_RE = /^([A-Za-z_]\w*)\s*(?:=\s*"([^"]*)")?$/u

// The cfg keys rustc sets from the target alone (`rustc --print cfg --target <triple>`), decided by
// membership in that set when the target is known. Not among them: `debug_assertions`, `panic`,
// `overflow_checks` and the like, which the build profile sets; `target_feature`, which the build
// may add to or take from (`-C target-feature=-crt-static`, `-C target-cpu=native`); and
// `target_thread_local`, which a stable rustc never prints.
export const TARGET_CFG_KEYS = new Set(['unix', 'windows', 'target_abi', 'target_arch', 'target_endian', 'target_env', 'target_family', 'target_has_atomic', 'target_os', 'target_pointer_width', 'target_vendor'])

// Three-valued evaluation of a cfg predicate: `false` when it can never hold in the build (so the
// item it gates is dead code for the bundle), `true` when it always does, `null` when the loader
// can't tell. `all`/`any`/`not` compose. `test` holds only in a test/bench target (`env.test`);
// `doctest` and `doc` never do when a program is built; `feature = "x"` is decided against
// `env.features`, the crate's features on for certain (see createCargoContext) -- unknown for one
// of `env.maybeFeatures`, on only in some builds, and without either set; a target leaf (`unix`,
// `target_os = …`) against `env.target`, the platform's cfg set as rustc prints it
// (rustcTargetCfgs), and unknown without one; every other leaf stays unknown. `env.units`, a list
// of such envs, is code compiled several ways (a crate built for the target and, as a
// build-dependency, for the host): false only when false in each, true only when true in each.
export function evalCfg(pred, env = {}) {
  if (env.units) {
    const each = env.units.map((u) => evalCfg(pred, u))
    return each.every((r) => r === false) ? false : (each.every((r) => r === true) ? true : null)
  }
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'test') return env.test === true
    if (p === 'doctest' || p === 'doc') return false
    const feature = FEATURE_CFG_RE.exec(p)
    if (feature) return env.features ? (env.features.has(feature[1]) ? true : (env.maybeFeatures?.has(feature[1]) ? null : false)) : null
    const leaf = CFG_LEAF_RE.exec(p)
    if (leaf && env.target && TARGET_CFG_KEYS.has(leaf[1])) return env.target.has(leaf[2] === undefined ? leaf[1] : `${leaf[1]}="${leaf[2]}"`)
    return null
  }
  const args = splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean).map((a) => evalCfg(a, env))
  if (m[1] === 'not') return args.length === 1 && args[0] !== null ? !args[0] : null
  if (m[1] === 'all') return args.includes(false) ? false : (args.every((a) => a === true) ? true : null)
  return args.includes(true) ? true : (args.every((a) => a === false) ? false : null)
}

// `rustc --print cfg` output → the set of cfg leaves as printed, one per line (`unix`,
// `target_os="linux"`).
export function parseRustcCfg(text) {
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))
}

// How long a toolchain query may take before it counts as hung.
const TOOL_TIMEOUT_MS = 60_000
// Never let rustup install a toolchain on the loader's behalf, whatever a `rust-toolchain` file says.
const TOOL_ENV = { ...process.env, RUSTUP_AUTO_INSTALL: '0' }
// Where rustc is run from: the user's home directory, else the filesystem root. A rustup proxy
// picks its toolchain from the `rust-toolchain(.toml)` files of the working directory and its
// parents, and such a file may name a `path` to any binary -- so never the project being bundled
// (untrusted input: its toolchain file must not choose what runs), and never a temp dir (anyone
// can plant a file in a world-writable one). The home directory is the user's -- unless it is the
// bundle root (`baseDir`) or lies inside it (a project bundled from a home directory, a CI job
// whose HOME is its checkout): then the root, whose toolchain file, if any, is the machine's.
function toolCwd(baseDir) {
  const home = homedir()
  const root = parse(process.cwd()).root
  if (!home) return root
  if (baseDir === null) return home
  // Real paths: a home directory or bundle root reached through a link is where it really is.
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const base = real(baseDir)
  const homeAbs = real(home)
  return homeAbs === base || homeAbs.startsWith(base.endsWith(sep) ? base : base + sep) ? root : home
}

// Run rustc: `$RUSTC` when set, as cargo honours it (a target only another toolchain knows, such
// as Solana's `sbf-solana-solana` in its platform-tools), else `rustc` from PATH -- a rustup proxy
// resolving to the user's default toolchain (or `RUSTUP_TOOLCHAIN`), from toolCwd. With
// RUSTUP_AUTO_INSTALL=0 an uninstalled toolchain is an error, not a download.
function rustc(args, what, baseDir) {
  const bin = process.env.RUSTC || 'rustc'
  const r = spawnSync(bin, args, { cwd: toolCwd(baseDir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TOOL_TIMEOUT_MS, env: TOOL_ENV })
  if (r.error) throw new Error(`${bin} could not run (${r.error.message}); ${what} needs rustc on PATH (or $RUSTC)`, { cause: r.error })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').trim()}`)
  return r.stdout
}

// The cfg set of a target: `{ triple, cfgs }` from `rustc --print cfg --target <triple>`, which
// needs only rustc's built-in knowledge of the target, not its standard library. `host` is the
// running rustc's host triple (`rustc -vV`). `baseDir` is the bundle root, which rustc is never
// run from (toolCwd).
export function rustcTargetCfgs(target, baseDir = null) {
  const triple = target === 'host' ? /^host: (\S+)$/mu.exec(rustc(['-vV'], '--cargo-target=host', baseDir))?.[1] ?? null : target
  if (triple === null) throw new Error('rustc -vV printed no host triple')
  return { triple, cfgs: parseRustcCfg(rustc(['--print', 'cfg', '--target', triple], '--cargo-target', baseDir)) }
}

// Run `cargo metadata` in the bundle root and return its JSON. Opt-in (`--cargo`) because it runs
// cargo, which reads the project's `.cargo/config.toml` and may touch the registry and Cargo.lock
// (doc/file-formats.md has the full caveat); never run on a bundle root unasked. With a lockfile
// present, `--locked` keeps the resolution the one the build uses. The feature flags pass through;
// `platform`, a target triple, restricts the graph to that target's dependencies.
export function runCargoMetadata(baseDir, { features = [], noDefaultFeatures = false, allFeatures = false, platform = null } = {}) {
  const args = ['metadata', '--format-version', '1']
  // The workspace's lock may sit above the bundle root: never let metadata rewrite it.
  if (findCargoLock(baseDir) !== null) args.push('--locked')
  if (allFeatures) args.push('--all-features')
  if (noDefaultFeatures) args.push('--no-default-features')
  for (const f of features) args.push('--features', f)
  if (platform !== null) args.push('--filter-platform', platform)
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

// The cargo config in directory `dir` (project-relative; `.` for the bundle root), project-relative:
// `.cargo/config` when it exists -- cargo prefers the extensionless file over `.cargo/config.toml`
// when both are there -- else `.cargo/config.toml`; null when there is neither.
function cargoConfigIn(baseDir, dir) {
  return ['.cargo/config', '.cargo/config.toml'].map((f) => (dir === '.' ? f : `${dir}/${f}`)).find((rel) => isFile(join(baseDir, rel))) ?? null
}
const cargoConfigOf = (baseDir) => cargoConfigIn(baseDir, '.')

// The directory `cargo vendor` filled, as the project's cargo config says: the `directory` of the
// source `[source.crates-io] replace-with` names, through any chain of replacements (`cargo
// vendor` suggests `vendored-sources`, but any name does), else of the one source some
// `replace-with` names; the default `vendor` when the config replaces nothing with a directory.
// A configured directory that doesn't exist is warned about (a stale `vendor/` beside it is not
// what cargo builds from). Throws a TomlError when the config isn't TOML.
function vendorDirOf(baseDir) {
  const rel = cargoConfigOf(baseDir)
  const text = rel === null ? null : readFileOrNull(join(baseDir, rel))
  if (text === null) return VENDOR_DIR
  // source name -> { replaceWith, directory }
  const sources = new Map()
  const config = readToml(text, rel)
  for (const [name, fields] of Object.entries(isTomlTable(config.source) ? config.source : {})) {
    if (!isTomlTable(fields)) continue
    const str = (v) => (typeof v === 'string' ? v : null)
    sources.set(name, { replaceWith: str(fields['replace-with']), directory: str(fields.directory) })
  }
  const follow = (name) => {
    const seen = new Set()
    for (let s = sources.get(name); s && !seen.has(s); s = sources.get(s.replaceWith)) {
      seen.add(s)
      if (s.directory !== null) return s.directory
      if (s.replaceWith === null) return null
    }
    return null
  }
  let dir = follow('crates-io')
  if (dir === null) {
    const replaced = new Set([...sources.values()].map((s) => (s.replaceWith === null ? null : follow(s.replaceWith))).filter((d) => d !== null))
    if (replaced.size === 1) [dir] = replaced
  }
  if (dir === null) return VENDOR_DIR
  const norm = normalizeRel('.', dir)?.replace(/\/+$/u, '') || null
  if (norm === null) {
    console.warn(`[loader.cargo] ${rel} names a vendored source directory outside the bundle root: ${dir}`)
    return VENDOR_DIR
  }
  if (!existsSync(join(baseDir, norm))) console.warn(`[loader.cargo] ${rel} names a vendored source directory that doesn't exist: ${norm}`)
  return norm
}

// The `--cfg` names in rustflags: `--cfg name`, `--cfg=name`, `--cfg 'name="value"'`.
function cfgFlags(flags) {
  const out = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const arg = flag === '--cfg' ? flags[++i] : (flag.startsWith('--cfg=') ? flag.slice('--cfg='.length) : null)
    const name = typeof arg === 'string' ? /^[A-Za-z_]\w*/u.exec(arg)?.[0] : undefined
    if (name !== undefined) out.push(name)
  }
  return out
}
// The cfgs the rustflags of a build of `baseDir` may set: those of its cargo config's
// `build.rustflags` and `target.<…>.rustflags` (every target's: which applies is the build's
// business), and of the environment cargo reads them from (CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS,
// CARGO_BUILD_RUSTFLAGS). Throws a TomlError when the config isn't TOML.
function rustflagsCfgsOf(baseDir, env = process.env) {
  const names = new Set()
  const add = (value) => {
    const flags = Array.isArray(value) ? value.filter((f) => typeof f === 'string') : (typeof value === 'string' ? value.split(/\s+/u).filter(Boolean) : [])
    for (const name of cfgFlags(flags)) names.add(name)
  }
  const rel = cargoConfigOf(baseDir)
  const text = rel === null ? null : readFileOrNull(join(baseDir, rel))
  // The `rustflags` of the `build` table and of every `target.<…>` one.
  const config = text === null ? null : readToml(text, rel)
  const table = (v) => (isTomlTable(v) ? v : null)
  add(table(config?.build)?.rustflags)
  for (const target of Object.values(table(config?.target) ?? {})) add(table(target)?.rustflags)
  if (env.CARGO_ENCODED_RUSTFLAGS) add(env.CARGO_ENCODED_RUSTFLAGS.split('\u001F'))
  for (const v of [env.RUSTFLAGS, env.CARGO_BUILD_RUSTFLAGS]) if (v) add(v)
  return names
}
// What a build script prints as `cargo:rustc-cfg=<name>` (or `cargo::`), among the texts of its
// files: the names it may set, and whether it may set one the loader can't read (a name it
// formats, `autocfg`'s probes).
const RUSTC_CFG_RE = /cargo::?rustc-cfg=([A-Za-z_]\w*)?/gu
function cfgsPrinted(texts) {
  const names = new Set()
  let any = false
  for (const text of texts) {
    for (const m of text.matchAll(RUSTC_CFG_RE)) {
      if (m[1] === undefined) any = true
      else names.add(m[1])
    }
    if (/\bautocfg\b/u.test(text)) any = true
  }
  return { names, any }
}

// --- Context ----------------------------------------------------------------------------

// No custom cfg a build sets (see cfgsSetFor).
export const NO_CFGS_SET = { names: new Set(), any: false }

// A compile unit: the feature context a file's code sees (`target`: the build's; `host`: that of
// what is built for the host -- build-dependencies, proc-macro crates and their dependencies --
// which resolver 2 keeps apart) and the platform it is compiled for, as `<features>|<platform>`.
// A package's code is compiled as `target|target`, its build script as `target|host`, a
// build-dependency's or proc-macro's code as `host|host`; one file may be compiled as several.
export const unitKey = (featureCtx, platform) => `${featureCtx}|${platform}`
export const TARGET_UNIT = unitKey('target', 'target')
export const HOST_UNIT = unitKey('host', 'host')
const unitFeatureCtx = (unit) => unit.slice(0, unit.indexOf('|'))
export const unitPlatform = (unit) => unit.slice(unit.indexOf('|') + 1)

// Per-bundle Cargo state: manifest lookup (memoized per directory), crate-name resolution against
// in-tree sources, and feature resolution for the packages owning `entries` (the crate roots being
// bundled, like `cargo build -p …`). `features` / `noDefaultFeatures` / `allFeatures` mirror
// cargo's flags for those root packages (`pkg/feat` targets one of them). `cargo: true` takes the
// dependency graph and features from `cargo metadata` (see runCargoMetadata) instead of replaying
// the manifests. `target` names the build's target -- a triple or `host`, asked of rustc
// (rustcTargetCfgs), or its `{ triple, cfgs }` outright -- so target-specific dependency tables
// and `#[cfg(unix)]`-style code are decided; without one they are kept. `baseDir` is the bundle
// root; every path in and out is project-relative POSIX.
export function createCargoContext(baseDir, { entries = [], features = [], noDefaultFeatures = false, allFeatures = false, cargo = false, target = null } = {}) {
  const targetInfo = target === null ? null : (typeof target === 'string' ? rustcTargetCfgs(target, baseDir) : target)
  // The host's platform, known when the target is the host.
  const hostInfo = target === 'host' ? targetInfo : null
  const manifests = new Map()
  const readManifest = (dir) => {
    if (!manifests.has(dir)) {
      const file = posix.join(dir, 'Cargo.toml')
      const text = readFileOrNull(join(baseDir, file))
      manifests.set(dir, text === null ? null : { dir, ...parseCargoManifest(text, file) })
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
  // A vendored package's `[lib] path` may not leave its directory (a published crate's never
  // does; one that tries is reaching for the project's files).
  const libPath = (m) => {
    if (m.libRoot === undefined) {
      const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
      const inside = rel !== null && (!isVendoredDir(m.dir) || rel.startsWith(`${m.dir}/`))
      if (rel !== null && !inside) console.warn(`[loader.cargo] Refusing lib path outside its package: ${m.lib.path} in ${m.dir}`)
      m.libRoot = inside && isFile(join(baseDir, rel)) ? rel : null
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

  // The vendored crates, `<vendorDir>/<dir>/`, as `[{ version, dir }]`, indexed `byName` (normalized
  // package name; the dir may hyphenate a snake_case name, and an older duplicate version lives in
  // `<name>-<version>/`) and `byLib` (lib name, for the crates whose `[lib] name` differs:
  // `md-5` → `md5`).
  const vendorDir = vendorDirOf(baseDir)
  // Whether a package directory is a vendored crate's (a registry crate `cargo vendor` copied in).
  const isVendoredDir = (dir) => dir !== vendorDir && dir.startsWith(`${vendorDir}/`)
  let vendorIndex = null
  const vendored = () => {
    if (vendorIndex === null) {
      vendorIndex = { byName: new Map(), byLib: new Map() }
      let dirs = []
      try {
        dirs = readdirSync(join(baseDir, vendorDir))
      } catch { /* no vendor dir */ }
      for (const d of dirs) {
        const m = readManifest(`${vendorDir}/${d}`)
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
    if (lock === undefined) lock = parseCargoLock(readFileOrNull(join(baseDir, 'Cargo.lock')), 'Cargo.lock')
    return lock
  }
  // `--cargo`: the graph and features as cargo resolved them, with registry packages it read from
  // the registry cache matched to their `vendor/` copy by name + version.
  const metadata = cargo
    ? resolutionFromMetadata(runCargoMetadata(baseDir, { features, noDefaultFeatures, allFeatures, platform: targetInfo?.triple ?? null }), baseDir, {
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
  // override in the workspace root's manifest), else the vendored crate of that name -- the
  // version Cargo.lock records for `m`, else the one vendored version that satisfies the
  // requirement. A package can depend on two versions of one crate (`borsh = "1"` beside
  // `borsh0-9 = { package = "borsh", version = "0.9" }`): the lock then lists both under it, and
  // the requirement tells which is which. Null when it isn't in-tree -- a path outside the bundle
  // root, or no vendored copy -- and, warned, when the vendored copies don't settle it: the locked
  // version isn't among them, none satisfies the requirement, or several do and no lock chooses.
  // Cargo would build none of those from what the bundle holds, so none is guessed.
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
    const root = workspaceFor(m.dir) ?? readManifest('.')
    const patch = root?.patches.get(crate)
    if (patch !== undefined) return asPackage(normalizeRel(root.dir, patch))
    const candidates = vendored().byName.get(crate) ?? []
    if (candidates.length === 0) return null
    const req = typeof spec.version === 'string' ? spec.version : null
    const fits = (ver) => req === null || satisfiesCargoReq(ver, req)
    const who = `${m.package.name} ${version(m)}`
    const vendoredList = candidates.map((c) => c.version).toSorted(compareVersionsDesc).join(', ')
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
      if (want !== null) {
        const hit = candidates.find((c) => c.version === want)
        if (hit) return readManifest(hit.dir)
        console.warn(`[loader.cargo] ${who} is locked to ${crate} ${want}, which isn't vendored (vendored: ${vendoredList})`)
        return null
      }
    }
    const fitting = candidates.filter((c) => fits(c.version))
    if (fitting.length === 1) return readManifest(fitting[0].dir)
    if (fitting.length === 0) console.warn(`[loader.cargo] No vendored version of ${crate} satisfies ${who}'s requirement ${req} (vendored: ${vendoredList})`)
    else console.warn(`[loader.cargo] Several vendored versions of ${crate} satisfy ${who}'s requirement ${req ?? '*'} (${fitting.map((c) => c.version).join(', ')}) and no Cargo.lock says which`)
    return null
  }

  // --- feature resolution

  // Cargo's feature resolver: v2 (edition 2021+, or `resolver = "2"`/`"3"`) leaves dev-dependencies
  // out of a normal build's unification, resolves what is built for the host apart from what is
  // built for the target, and ignores the tables of platforms not being built; v1 unifies them all.
  // It is the workspace's setting: its root manifest's `resolver`, else its edition -- the
  // workspace of the entries' package (the package itself outside any), else the bundle root's.
  let resolverMemo = null
  const resolverVersion = () => {
    if (resolverMemo !== null) return resolverMemo
    const pkg = entries.map(packageFor).find(Boolean)
    const root = (pkg ? workspaceFor(pkg.dir) ?? pkg : null) ?? readManifest('.')
    const explicit = Number(root?.resolver)
    const edition = root?.package?.editionFromWorkspace ? workspaceFor(root.dir)?.workspacePackage.edition : root?.package?.edition
    resolverMemo = Number.isInteger(explicit) && explicit > 0 ? explicit : (Number(edition ?? 0) >= 2021 ? 2 : 1)
    return resolverMemo
  }
  // The feature context a unit's code sees (resolver 2 keeps the host's apart; resolver 1 has one).
  const featureCtx = (c) => (resolverVersion() === 1 ? 'target' : c)
  const isProcMacroPkg = (m) => m?.lib.procMacro === true
  // The platform a context compiles for, as far as the loader knows it: the target's triple and
  // cfgs when `target` was given; the host's only when the target is the host (`host`), since the
  // machine that builds need not be the one that bundles.
  const platformInfo = (platform) => (platform === 'target' ? targetInfo : hostInfo)
  // Whether a table applies in a build for `platform`: `yes`, `no`, or `maybe` when the platform's
  // cfgs aren't known or don't decide it. A build-dependency table is about the host its build
  // script runs on. Resolver 1 counts every platform's table, as cargo's v1 unification does.
  const tableApplies = (request, platform) => {
    const at = request.indexOf('@')
    if (at === -1 || resolverVersion() === 1) return 'yes'
    const info = platformInfo(kindOf(request) === 'build' ? 'host' : platform)
    if (info === null) return 'maybe'
    const spec = request.slice(at + 1)
    const cfg = /^cfg\((.*)\)$/u.exec(spec)
    const holds = cfg ? evalCfg(cfg[1], { target: info.cfgs }) : spec === info.triple
    return holds === true ? 'yes' : (holds === false ? 'no' : 'maybe')
  }
  // The context a dependency of a package built in context `c` is built in: the host's for a
  // build-dependency (its build script's) and for a proc-macro crate, else `c`'s.
  const depCtx = (c, request, t) => featureCtx(kindOf(request) === 'build' || isProcMacroPkg(t) ? 'host' : c)
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
  const nodeKey = (c, dir) => `${c}\0${dir}`

  // Enabled features per (context, package dir), for every package the root packages' builds pull
  // in: the roots start from `default` (or the flags), then features imply features, activate
  // optional deps and request dependency features, and active deps get `default` plus what the
  // dependent asks for, to a fixed point -- cargo's unification. `includeMaybe`: whether the
  // tables whose platform the loader can't decide count; resolved both ways, the features on
  // without them are on for certain, the rest of those on with them only maybe (a feature can turn
  // code off -- `#[cfg(not(feature = "std"))]` -- so counting a table that may not apply is no
  // safe over-approximation). Dev-dependencies: a dependency's own are never built by anyone, so
  // they never count; the root packages' count under resolver 1, and for a test/bench entry.
  const resolveFeatures = (includeMaybe) => {
    const enabled = new Map()
    // The entries' packages (manifests are memoized per dir, so identity dedupes them).
    const roots = [...new Set(entries.map(packageFor).filter(Boolean))]
    if (roots.length === 0) return enabled
    const resolver = resolverVersion()
    const active = new Map() // node -> Set<dep key> (activated optional deps)
    let changed = false
    const inGraph = (c, m) => {
      const key = nodeKey(c, m.dir)
      if (!enabled.has(key)) {
        enabled.set(key, new Set())
        changed = true
      }
      return enabled.get(key)
    }
    const enable = (c, m, f) => {
      const set = inGraph(c, m)
      if (featureImplications(m, f) === null || set.has(f)) return // unknown feature: cargo would error
      set.add(f)
      changed = true
    }
    const activate = (c, m, key) => {
      const node = nodeKey(c, m.dir)
      if (!active.has(node)) active.set(node, new Set())
      if (active.get(node).has(key)) return
      active.get(node).add(key)
      changed = true
    }
    const rootDirs = new Set(roots.map((r) => r.dir))
    // Dev-dependencies count for a root package under resolver 1, and for one whose entries include a
    // test/bench target (that build is `cargo test`'s, which links them).
    const testRootDirs = new Set(entries.filter((e) => isTestTarget(e)).map((e) => packageFor(e)?.dir))
    const kindApplies = (m, request) => kindOf(request) !== 'dev' || (rootDirs.has(m.dir) && (resolver === 1 || testRootDirs.has(m.dir)))
    const applies = (request, c) => {
      const a = tableApplies(request, c)
      return a === 'yes' || (includeMaybe && a === 'maybe')
    }
    // The tables of `d` that take part in `m`'s build in context `c`, as [request, entry] pairs,
    // an optional one only once activated.
    const activeRequests = (c, m, d) => [...d.kinds]
      .filter(([request, r]) => kindApplies(m, request) && applies(request, c) && (!r.optional || active.get(nodeKey(c, m.dir))?.has(d.key) === true))
    // One entry of a feature's list: `other`, `dep:key`, `key/feat`, `key?/feat`. Returns whether it named anything.
    const applyImplication = (c, m, imp) => {
      const explicitDep = DEP_IMPLICATION_RE.exec(imp)
      if (explicitDep) {
        activate(c, m, normName(explicitDep[1]))
        return true
      }
      const depFeature = DEP_FEATURE_RE.exec(imp)
      if (depFeature) {
        const d = m.deps.get(normName(depFeature[1]))
        if (!d) return false
        // `dep/feat` enables an optional dep (and its implicit feature); `dep?/feat` only asks if it is already on.
        if (depFeature[2] !== '?' && isOptional(d)) {
          activate(c, m, d.key)
          if (implicitFeatures(m).has(d.name)) enable(c, m, d.name)
        }
        const t = resolveDep(m, d)
        if (t) for (const [request] of activeRequests(c, m, d)) enable(depCtx(c, request, t), t, depFeature[3])
        return true
      }
      if (featureImplications(m, imp) === null) return false
      enable(c, m, imp)
      return true
    }

    for (const m of roots) {
      inGraph('target', m)
      if (allFeatures) {
        for (const f of m.features.keys()) enable('target', m, f)
        for (const f of implicitFeatures(m).keys()) enable('target', m, f)
      } else if (!noDefaultFeatures) {
        enable('target', m, 'default')
      }
    }
    // `--features a,b,pkg/c`: a bare name is a feature of every root package; `x/c` is a feature of
    // the root package named `x`, else of the dependency `x` of each root (cargo's `dep/feat` form).
    const rootNames = new Set(roots.map((r) => normName(r.package.name)))
    const requested = []
    for (const flag of parseFeatureList(features)) {
      const slash = flag.indexOf('/')
      const pkg = slash === -1 ? null : normName(flag.slice(0, slash))
      const scoped = pkg !== null && rootNames.has(pkg)
      const targets = scoped ? roots.filter((m) => normName(m.package.name) === pkg) : roots
      const imp = scoped ? flag.slice(slash + 1) : flag
      // Whether a name is known doesn't depend on what is active yet, so the check happens once.
      if (targets.filter((m) => applyImplication('target', m, imp)).length === 0 && includeMaybe) {
        console.warn(`[stasis] --cargo-features: '${flag}' names no feature of the entries' packages, nor a dependency of theirs`)
      }
      requested.push({ targets, imp })
    }

    do {
      changed = false
      // The requested features re-apply on every pass like the manifest's entries do: a weak
      // `dep?/x` asked for on the command line takes effect once `default` has activated `dep`.
      for (const { targets, imp } of requested) for (const m of targets) applyImplication('target', m, imp)
      // Map/Set iteration is live: packages and features added mid-pass are visited in this pass.
      for (const node of enabled.keys()) {
        const cut = node.indexOf('\0')
        const c = node.slice(0, cut)
        const m = readManifest(node.slice(cut + 1))
        for (const f of enabled.get(node)) {
          for (const imp of featureImplications(m, f) ?? []) applyImplication(c, m, imp)
        }
        for (const d of m.deps.values()) {
          for (const [request, r] of activeRequests(c, m, d)) {
            const spec = depSpec(m, d, r)
            const t = spec === null ? null : resolveDep(m, d)
            if (!t) continue
            const dc = depCtx(c, request, t)
            inGraph(dc, t)
            if (spec.defaultFeatures) enable(dc, t, 'default')
            for (const f of spec.features) enable(dc, t, f)
          }
        }
      }
    } while (changed)
    return enabled
  }
  // Both resolutions, per (context, package dir): `sure` without the undecided tables, `all` with
  // them. `--cargo`: cargo metadata's features, the same in either context.
  let resolved = null
  const ensureResolved = () => {
    if (resolved !== null) return resolved
    if (metadata) {
      const byNode = new Map([...metadata.enabled].flatMap(([dir, set]) => [[nodeKey('target', dir), set], [nodeKey('host', dir), set]]))
      resolved = { sure: byNode, all: byNode }
    } else {
      resolved = { sure: resolveFeatures(false), all: resolveFeatures(true) }
    }
    return resolved
  }
  // Per node, the features on only maybe: in `all`, not in `sure` (one object per node).
  const maybeByNode = new Map()
  const maybeOf = (node) => {
    if (!maybeByNode.has(node)) {
      const { sure, all } = ensureResolved()
      const on = sure.get(node)
      const maybe = new Set([...(all.get(node) ?? [])].filter((f) => !on?.has(f)))
      maybeByNode.set(node, maybe.size === 0 ? null : maybe)
    }
    return maybeByNode.get(node)
  }
  // A package in the `all` resolution but not the `sure` one is built only maybe: nothing of its
  // is on for certain.
  const NO_FEATURES = new Set()

  // --- cfgs a build may set
  let rustflagCfgs = null
  const cfgsSetMemo = new Map()
  // A build script's text and that of the modules it declares (`mod probe;`, beside it), a few
  // levels down: where its `cargo:rustc-cfg=` lines are.
  const buildScriptTexts = (script) => {
    const texts = []
    const queue = [[script, 0]]
    const seen = new Set()
    for (let qi = 0; qi < queue.length; qi++) {
      const [rel, depth] = queue[qi]
      if (seen.has(rel)) continue
      seen.add(rel)
      const text = readFileOrNull(join(baseDir, rel))
      if (text === null) continue
      texts.push(text)
      if (depth >= 3) continue
      const dir = posix.dirname(rel)
      const sub = qi === 0 || posix.basename(rel) === 'mod.rs' ? dir : posix.join(dir, posix.basename(rel, '.rs'))
      for (const m of text.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*;/gu)) {
        for (const f of [posix.join(sub, `${m[1]}.rs`), posix.join(sub, m[1], 'mod.rs')]) if (isFile(join(baseDir, f))) queue.push([f, depth + 1])
      }
    }
    return texts
  }

  // The in-tree crate root a name resolves to from package `m` (null: no owning package), leaving
  // out `m`'s own lib (which depends on the asking file): the package its dependency of that name
  // resolves to (path dep, `[patch]`, or the vendored version Cargo.lock says); a dependency whose
  // lib is named that (`md-5` is used as `md5`); or -- for a file no manifest claims -- the one
  // vendored crate of that lib or package name. A package's own name for a crate is its manifest's
  // word: a declared dependency that doesn't resolve in-tree (a path outside the bundle root, a
  // version no vendored copy has) never falls back to some vendored copy of that name, and a
  // name it doesn't declare is no crate of its. Memoized per (package, name): every file of a
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
        return t ? libPath(t) : null
      }
      for (const other of m.deps.values()) {
        if (other.package !== null) continue // a rename is used by its key, not its lib name
        const t = resolveDep(m, other)
        if (t && libName(t) === norm) return libPath(t)
      }
      return null
    }
    const { byLib, byName } = vendored()
    const found = new Set()
    for (const index of [byLib, byName]) for (const c of index.get(norm) ?? []) found.add(c.dir)
    if (found.size > 1) {
      console.warn(`[loader.cargo] Several vendored crates are named ${norm} (${[...found].join(', ')}) and no manifest says which`)
      return null
    }
    for (const dir of found) return libPath(readManifest(dir))
    return null
  }

  return {
    // Where `cargo vendor` put the registry crates (project-relative): `vendor`, or what
    // .cargo/config.toml names. A package under it is a vendored dependency.
    vendorDir,
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
    // Whether `fromFile`'s package declares a dependency of that name (in any table, by the key
    // code uses): then the name is that crate -- rustc refuses a `use` path whose lead a glob
    // import also provides, as ambiguous (E0659) -- in-tree or not.
    declaresCrate(name, fromFile) {
      return packageFor(fromFile)?.deps.has(normName(name)) === true
    },
    // The build's target: its triple and cfg set (`unix`, `target_os="linux"`, … as rustc prints
    // them), or null for both when none was given.
    targetTriple: targetInfo?.triple ?? null,
    targetCfgs: targetInfo?.cfgs ?? null,
    // The files that describe the build of `fileRel`'s package, project-relative, as `{ path,
    // kind }`, those on disk. A vendored package's: its Cargo.toml (`manifest`) and the
    // `.cargo-checksum.json` cargo checks its files against (`checksum`) -- the lock and config a
    // registry crate was published with play no part in a build that depends on it. Any other
    // package's: its own Cargo.toml and, inside the bundle root, the workspace's above it
    // (`manifest`); that workspace's -- or, without one, the package's own -- Cargo.lock (`lock`);
    // and the cargo config of every directory from the package's up to the bundle root
    // (`config`), each of which cargo reads when run there. Empty for a file no manifest claims.
    buildFilesFor(fileRel) {
      const m = packageFor(fileRel)
      if (!m) return []
      const out = [{ path: posix.join(m.dir, 'Cargo.toml'), kind: 'manifest' }]
      if (isVendoredDir(m.dir)) {
        const checksum = posix.join(m.dir, '.cargo-checksum.json')
        if (isFile(join(baseDir, checksum))) out.push({ path: checksum, kind: 'checksum' })
        return out
      }
      const ws = workspaceFor(m.dir)
      if (ws && ws.dir !== m.dir) out.push({ path: posix.join(ws.dir, 'Cargo.toml'), kind: 'manifest' })
      const top = ws?.dir ?? m.dir
      const lockPath = posix.join(top, 'Cargo.lock')
      if (isFile(join(baseDir, lockPath))) out.push({ path: lockPath, kind: 'lock' })
      for (let dir = m.dir; ; dir = posix.dirname(dir)) {
        const config = cargoConfigIn(baseDir, dir)
        if (config !== null) out.push({ path: config, kind: 'config' })
        if (dir === '.') break
      }
      return out
    },
    // Whether `fileRel` belongs to a vendored package (a registry crate `cargo vendor` copied in).
    isVendored(fileRel) {
      const m = packageFor(fileRel)
      return m !== null && isVendoredDir(m.dir)
    },
    // The build script of `fileRel`'s package, project-relative, when there is one on disk:
    // `[package] build = "…"`, else `build.rs` beside the manifest; `build = false` means none. A
    // vendored package's may not name a file outside the package (a published crate never does).
    buildScriptOf(fileRel) {
      const m = packageFor(fileRel)
      if (!m || m.package.build === false) return null
      const rel = normalizeRel(m.dir, m.package.build ?? 'build.rs')
      if (rel === null || !isFile(join(baseDir, rel))) return null
      if (this.isVendored(fileRel) && !rel.startsWith(`${m.dir}/`)) {
        console.warn(`[loader.cargo] Refusing build script outside its package: ${m.package.build} in ${m.dir}`)
        return null
      }
      return rel
    },
    // The custom cfgs the build of `fileRel`'s package may set (a `--cfg` a default build lacks is
    // otherwise presumed off): `{ names, any }` -- the names its build script prints as
    // `cargo:rustc-cfg=…` and those the rustflags set, and whether the script may set one the
    // loader can't read. One object per package (and one for every package that sets none).
    cfgsSetFor(fileRel) {
      const m = packageFor(fileRel)
      const memo = m?.dir ?? '\0'
      if (!cfgsSetMemo.has(memo)) {
        rustflagCfgs ??= rustflagsCfgsOf(baseDir)
        const script = m ? this.buildScriptOf(fileRel) : null
        const printed = script === null ? { names: new Set(), any: false } : cfgsPrinted(buildScriptTexts(script))
        const names = new Set([...rustflagCfgs, ...printed.names])
        cfgsSetMemo.set(memo, names.size === 0 && !printed.any ? NO_CFGS_SET : { names, any: printed.any })
      }
      return cfgsSetMemo.get(memo)
    },
    // The features on for certain for the package owning `fileRel`, compiled as `unit` (see
    // unitOfCrate), in the build of the root packages; null when that is unknown: no owning
    // manifest, no root package to resolve from, or a package the resolved build doesn't pull in
    // (its gated code is then kept, not dropped).
    featuresFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      if (!m) return null
      const node = nodeKey(featureCtx(unitFeatureCtx(unit)), m.dir)
      const { sure, all } = ensureResolved()
      return sure.get(node) ?? (all.has(node) ? NO_FEATURES : null)
    },
    // The features on only in some of the builds the loader can't tell apart (a target-specific
    // table it can't decide, or what only such a table requests), for the same package and unit;
    // null when there are none.
    maybeFeaturesFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      if (!m) return null
      return maybeOf(nodeKey(featureCtx(unitFeatureCtx(unit)), m.dir))
    },
    // Every package of a context the build may pull in: dir -> { on, maybe }, the features on for
    // certain and those on only maybe (a package only an undecided table pulls in has every
    // feature of its maybe). For diagnostics and tests.
    featureResolution(context = 'target') {
      const out = new Map()
      for (const node of ensureResolved().all.keys()) {
        const cut = node.indexOf('\0')
        if (node.slice(0, cut) !== featureCtx(context)) continue
        out.set(node.slice(cut + 1), { on: ensureResolved().sure.get(node) ?? NO_FEATURES, maybe: maybeOf(node) ?? NO_FEATURES })
      }
      return out
    },
    // Every resolved package of a context: dir -> Set<feature on for certain>. For diagnostics and tests.
    resolvedFeatures(context = 'target') {
      const out = new Map()
      for (const [node, set] of ensureResolved().sure) {
        const cut = node.indexOf('\0')
        if (node.slice(0, cut) === featureCtx(context)) out.set(node.slice(cut + 1), set)
      }
      return out
    },
    // The compile unit of a crate root `libFile` named from code compiled as `fromUnit`: a proc-macro
    // crate, and anything code compiled for the host names (a build script's build-dependencies,
    // a proc-macro's dependencies), is built for the host in the host's feature context; else the
    // namer's unit.
    unitOfCrate(libFile, fromUnit = TARGET_UNIT) {
      return isProcMacroPkg(packageFor(libFile)) || unitPlatform(fromUnit) === 'host' ? HOST_UNIT : fromUnit
    },
    // The unit of a build script of a package compiled as `pkgUnit`: for the host, with the
    // package's features.
    buildScriptUnit(pkgUnit = TARGET_UNIT) {
      return unitKey(unitFeatureCtx(pkgUnit), 'host')
    },
    // The cfgs and triple of the platform `unit` compiles for, as far as known (see platformInfo).
    platformOf(unit = TARGET_UNIT) {
      return platformInfo(unitPlatform(unit))
    },
  }
}
