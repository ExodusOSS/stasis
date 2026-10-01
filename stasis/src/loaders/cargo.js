// Cargo manifests for the Rust loader: Cargo.toml, Cargo.lock and cargo's configuration read by
// @preventive/lockfile, per-bundle package lookup, dependency resolution among in-tree crates (the
// package's own lib, workspace `path` deps, `cargo vendor`ed registry crates) and feature
// resolution done the way `cargo build` does it, so `#[cfg(feature = "…")]` can be decided per
// crate: @preventive/lockfile's, cargo's own resolver, where the build's lockfile and target are
// known; a replay of the manifests otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

import { toPosix } from '@exodus/stasis-core/util'

import { LockfileError, linkCargo, parseCargoConfig, parseCargoLock, parseCargoManifest as readCargoManifest, readCargoVendor, resolveCargoFeatures } from '@preventive/lockfile/cargo.js'
import { matches, parseVersion, parseVersionReq } from '@preventive/lockfile/rust-semver.js'

import { TomlError, isTomlTable, readToml, splitTopLevel } from './toml.js'

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

// A request's kind (`normal`/`dev`/`build`), a target-specific table's `@<cfg>` suffix dropped.
const kindOf = (request) => request.split('@')[0]

// Entries of a `[features]` list beyond a plain feature name: `dep:key` and `key/feat` / `key?/feat`.
const DEP_IMPLICATION_RE = /^dep:(.+)$/u
const DEP_FEATURE_RE = /^([^/?]+)(\?)?\/(.+)$/u

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

// `read()`, with a TomlError or LockfileError it throws naming `file`: what @preventive/lockfile
// refuses stops the build, saying which file.
function readNamed(file, read) {
  try {
    return read()
  } catch (err) {
    if (file === null) throw err
    if (err instanceof TomlError) {
      const named = new TomlError(`${file}: ${err.message}`)
      named.line = err.line
      throw named
    }
    if (err instanceof LockfileError) {
      const named = new LockfileError(`${file}: ${err.message}`)
      named.where = err.where
      throw named
    }
    throw err
  }
}

// A Cargo.toml as the loader reads it: @preventive/lockfile's reading (`cargo`) -- the package, its
// features (with the one each optional dependency no `dep:` names turns on) and every dependency
// table, what a member inherits from its workspace applied, refused where cargo would refuse it or
// the reader can't tell how cargo reads it -- plus what that reading leaves out: the lib target
// (`[lib] name`, `path`) and the build script (`[package] build`). `workspace` is the workspace
// root's, read before, for a member that inherits from it. Dependency keys are the `use` spelling
// (`-` → `_`); each table is a request of its own, `<kind>` or `<kind>@<platform>` (`normal`,
// `build`, `dev@cfg(windows)`): `[dependencies] rand = "0.7"` beside `[build-dependencies] rand =
// "0.8"` are two crates, and sha2's dev-dependency on digest asks digest for nothing a build of
// sha2's dependents sees. Throws a TomlError or LockfileError naming `file`.
export function parseCargoManifest(text, file = null, workspace = null) {
  const root = workspace?.cargo.workspace === undefined ? undefined : workspace.cargo
  const doc = readToml(text, file)
  const cargo = readNamed(file, () => readCargoManifest(text, isTomlTable(doc.workspace) ? undefined : root))
  const pkg = cargo.package
  const table = (v) => (isTomlTable(v) ? v : null)
  const lib = table(doc.lib)
  const build = table(doc.package ?? doc.project)?.build
  const deps = new Map()
  for (const d of pkg?.dependencies ?? []) {
    const key = normName(d.name)
    if (!deps.has(key)) deps.set(key, { key, name: d.name, kinds: new Map() })
    deps.get(key).kinds.set(d.target === undefined ? d.kind : `${d.kind}@${d.target}`, {
      version: d.version ?? null,
      path: d.source.type === 'path' ? d.source.path : null,
      source: d.source.type,
      package: d.package,
      renamed: d.package !== d.name,
      inherited: d.inherited,
      optional: d.optional,
      defaultFeatures: d.defaultFeatures,
      features: d.features,
    })
  }
  return {
    cargo,
    package: pkg === undefined ? null : { name: pkg.name, version: pkg.version, edition: pkg.edition, build: typeof build === 'string' || build === false ? build : null },
    resolver: cargo.workspace?.resolver ?? pkg?.resolver ?? null,
    isWorkspace: cargo.workspace !== undefined,
    lib: { name: typeof lib?.name === 'string' ? lib.name : null, path: typeof lib?.path === 'string' ? lib.path : null, procMacro: pkg?.procMacro === true },
    features: new Map(Object.entries(pkg?.features ?? {})),
    deps,
  }
}

// Whether `version` satisfies the Cargo requirement `req`, by the semver crate's rules
// (@preventive/lockfile's rust-semver.js): a prerelease only where the requirement names one of
// its major, minor and patch.
const satisfies = (version, req) => {
  const v = parseVersion(version)
  const comparators = parseVersionReq(req)
  return v !== undefined && comparators !== undefined && matches(comparators, v)
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
    if (text !== null && 'workspace' in readToml(text, file)) {
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

// A cfg predicate with its whitespace collapsed outside string literals: `my = "a  b"` and
// `my = "a b"` are two values.
export const normalizeCfg = (pred) => pred.replaceAll(/"(?:[^"\\]|\\.)*"|\s+/gu, (m) => (m.startsWith('"') ? m : ' ')).trim()

const FEATURE_CFG_RE = /^(?:r#)?feature\s*=\s*"([^"]*)"$/u
// Any other leaf: `unix`, `target_os = "linux"`, a raw identifier's `r#` dropped.
const CFG_LEAF_RE = /^(?:r#)?([A-Za-z_]\w*)\s*(?:=\s*"([^"]*)")?$/u

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
// A predicate an unknown leaf occurs in more than once is decided when it comes out the same
// whatever the unknown leaves are (up to six of them): `all(any(test, kani), not(kani))` -- zerocopy's
// `#[cfg(any(test, kani))] mod tests { #[cfg(not(kani))] mod compatibility { … } }` -- never holds.
const MAX_FREE_CFG_LEAVES = 6
export function evalCfg(pred, env = {}) {
  if (env.units) {
    const each = env.units.map((u) => evalCfg(pred, u))
    return each.every((r) => r === false) ? false : (each.every((r) => r === true) ? true : null)
  }
  const free = { counts: null } // unknown leaf → how often it occurs, once one is met
  const r = evalCfgWith(pred, env, null, free)
  if (r !== null || free.counts === null || free.counts.size > MAX_FREE_CFG_LEAVES || [...free.counts.values()].every((n) => n === 1)) return r
  const leaves = [...free.counts.keys()]
  let out
  for (let bits = 0; bits < 1 << leaves.length; bits++) {
    const v = evalCfgWith(pred, env, new Map(leaves.map((l, k) => [l, ((bits >> k) & 1) === 1])))
    if (out === undefined) out = v
    else if (v !== out) return null
  }
  return out
}
// evalCfg's three-valued pass: an unknown leaf takes its value from `assume` (leaf → value) when
// that has it, else is counted in `free.counts`.
function evalCfgWith(pred, env, assume, free = null) {
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    const known = evalCfgLeaf(p, env)
    if (known !== null) return known
    const kv = CFG_LEAF_RE.exec(p) // the same leaf however it is spaced, its value as written
    const leaf = kv === null ? p : (kv[2] === undefined ? kv[1] : `${kv[1]}="${kv[2]}"`)
    if (assume?.has(leaf)) return assume.get(leaf)
    if (free !== null) (free.counts ??= new Map()).set(leaf, (free.counts.get(leaf) ?? 0) + 1)
    return null
  }
  const args = splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean).map((a) => evalCfgWith(a, env, assume, free))
  if (m[1] === 'not') return args.length === 1 && args[0] !== null ? !args[0] : null
  if (m[1] === 'all') return args.includes(false) ? false : (args.every((a) => a === true) ? true : null)
  return args.includes(true) ? true : (args.every((a) => a === false) ? false : null)
}
function evalCfgLeaf(p, env) {
  if (p === 'true' || p === 'false') return p === 'true' // the literals (rustc 1.88); `r#true` is a name
  const name = p.startsWith('r#') ? p.slice(2) : p
  if (name === 'test') return env.test === true
  if (name === 'doctest' || name === 'doc') return false
  const feature = FEATURE_CFG_RE.exec(p)
  if (feature) return env.features ? (env.features.has(feature[1]) ? true : (env.maybeFeatures?.has(feature[1]) ? null : false)) : null
  const leaf = CFG_LEAF_RE.exec(p)
  if (leaf && env.target && TARGET_CFG_KEYS.has(leaf[1])) return env.target.has(leaf[2] === undefined ? leaf[1] : `${leaf[1]}="${leaf[2]}"`)
  return null
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

// --- An undecided host ----------------------------------------------------------------

// The stand-in platforms an undecided host is resolved against (hostUndecided): the target's cfgs
// carry a mark of the target and of its name, the host's only a mark of the host.
const MARK_TARGET = '__stasis_target'
const MARK_HOST = '__stasis_host'
const MARK_NAME = '__stasis_target_name'
// `graph` (linkCargo's) with every target-specific dependency's platform holding on the target as
// written and on the host as `on` says -- nowhere, for the features on for certain, or everywhere,
// for all that may be: cargo's resolver takes a host it knows, and the machine that builds need not
// be the one that bundles.
function hostUndecided(graph, on) {
  const packages = Object.create(null)
  for (const [key, pkg] of Object.entries(graph.packages)) {
    const dependencies = pkg.dependencies.map((d) => {
      if (d.target === undefined) return d
      const onTarget = /^cfg\((.*)\)$/su.exec(d.target)?.[1] ?? `${MARK_NAME} = "${d.target}"`
      return { ...d, target: `cfg(any(all(${MARK_TARGET}, ${onTarget}), all(${MARK_HOST}, ${on})))` }
    })
    packages[key] = { ...pkg, dependencies }
  }
  return { ...graph, packages }
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
// dependency graph and features from `cargo metadata` (see runCargoMetadata) instead. `target`
// names the build's target -- a triple or `host`, asked of rustc (rustcTargetCfgs), or its `{
// triple, cfgs }` outright -- so target-specific dependency tables and `#[cfg(unix)]`-style code
// are decided; without one they are kept. The host's platform is known when the target is the
// host, or given as `host` (`{ triple, cfgs }`). `baseDir` is the bundle root; every path in and
// out is project-relative POSIX.
export function createCargoContext(baseDir, { entries = [], features = [], noDefaultFeatures = false, allFeatures = false, cargo = false, target = null, host = null } = {}) {
  const targetInfo = target === null ? null : (typeof target === 'string' ? rustcTargetCfgs(target, baseDir) : target)
  const hostInfo = target === 'host' ? targetInfo : host
  const manifests = new Map()
  const tables = new Map() // dir -> the manifest's table tree, or null (rootOf's look for [workspace])
  const tableOf = (dir) => {
    if (!tables.has(dir)) {
      const file = posix.join(dir, 'Cargo.toml')
      const text = readFileOrNull(join(baseDir, file))
      tables.set(dir, text === null ? null : { file, text, doc: readToml(text, file) })
    }
    return tables.get(dir)
  }
  // The workspace root a manifest inherits from: its `[package] workspace` path, else the nearest
  // manifest above it with a [workspace] table, inside the bundle root -- null for a root, a
  // vendored crate (a published manifest inherits nothing) or a package outside any workspace.
  const rootOf = (dir, doc) => {
    if (isTomlTable(doc.workspace) || isVendoredDir(dir)) return null
    const named = (isTomlTable(doc.package) ? doc.package : null)?.workspace
    if (typeof named === 'string') {
      const rel = normalizeRel(dir, named)
      return rel === null ? null : rel
    }
    for (let d = dir; d !== '.' && d !== '';) {
      d = posix.dirname(d)
      if (isTomlTable(tableOf(d)?.doc.workspace)) return d
    }
    return null
  }
  const readManifest = (dir) => {
    if (!manifests.has(dir)) {
      const raw = tableOf(dir)
      const root = raw === null ? null : rootOf(dir, raw.doc)
      const workspace = root === null ? null : readManifest(root)
      manifests.set(dir, raw === null ? null : { dir, ...parseCargoManifest(raw.text, raw.file, workspace) })
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
  const version = (m) => m.package.version

  // --- dependency resolution

  // The vendored crates, `<vendorDir>/<dir>/`, as `[{ version, dir, git }]`, indexed `byName`
  // (normalized package name; the dir may hyphenate a snake_case name, and an older duplicate
  // version lives in `<name>-<version>/`) and `byLib` (lib name, for the crates whose `[lib] name`
  // differs: `md-5` → `md5`). `git`: whether the copy is of a git repository -- its
  // `.cargo-checksum.json` has no package checksum, which a registry's always does -- or null
  // without that file.
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
        if (d.startsWith('.')) continue // a directory source reads none of these
        const m = readManifest(`${vendorDir}/${d}`)
        if (!m?.package) continue
        const sums = checksumOf(m.dir)
        const entry = { version: version(m), dir: m.dir, git: sums === null ? null : sums.package === null }
        for (const [index, key] of [[vendorIndex.byName, normName(m.package.name)], [vendorIndex.byLib, libName(m)]]) {
          if (!index.has(key)) index.set(key, [])
          index.get(key).push(entry)
        }
      }
    }
    return vendorIndex
  }
  // A vendored package's `.cargo-checksum.json`, parsed, or null when it has none.
  const checksums = new Map()
  const checksumOf = (dir) => {
    if (!checksums.has(dir)) {
      const file = posix.join(dir, '.cargo-checksum.json')
      const text = readFileOrNull(join(baseDir, file))
      let value = null
      if (text !== null) {
        try {
          value = JSON.parse(text)
        } catch (err) {
          throw new Error(`${file}: not JSON: ${err.message}`, { cause: err })
        }
      }
      checksums.set(dir, value === null ? null : { text, package: value?.package ?? null })
    }
    return checksums.get(dir)
  }
  // The build's workspace root: that of the first entry's package that isn't vendored (else the
  // package itself, outside any workspace), else the bundle root's manifest; its Cargo.lock is the
  // build's, as cargo finds it. A vendored crate's own published lock plays no part.
  const buildRoot = () => {
    const pkg = entries.map(packageFor).find((m) => m && !isVendoredDir(m.dir))
    return pkg ? (workspaceFor(pkg.dir) ?? pkg) : readManifest('.')
  }
  // The build's Cargo.lock, read by @preventive/lockfile (`version = 3` or `4`; an older one, or a
  // lock that isn't what cargo writes or could be read two ways, stops the build), as `{ file,
  // text, lock, byId }` (`byId`: `name version` → the keys of that version's packages); null when
  // there is none.
  let lock
  const lockfile = () => {
    if (lock === undefined) {
      const root = buildRoot()
      const file = posix.join(root?.dir ?? '.', 'Cargo.lock')
      const text = readFileOrNull(join(baseDir, file))
      lock = null
      if (text !== null) {
        const parsed = readNamed(file, () => parseCargoLock(text))
        const byId = new Map()
        for (const [key, p] of Object.entries(parsed.packages)) {
          const id = `${normName(p.name)} ${p.version}`
          if (!byId.has(id)) byId.set(id, [])
          byId.get(id).push(key)
        }
        lock = { file, lock: parsed, byId }
      }
    }
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
  // `dep.kinds`; what a member inherits from its workspace is already in it): its path relative to
  // the manifest's directory, or the workspace root's where the entry is inherited.
  const depSpec = (m, dep, request) => ({
    key: dep.key,
    version: request.version,
    path: request.path,
    source: request.source,
    package: request.package,
    renamed: request.renamed,
    defaultFeatures: request.defaultFeatures,
    features: request.features,
    relTo: request.inherited ? (workspaceFor(m.dir)?.dir ?? m.dir) : m.dir,
  })
  // The `[patch]` tables of the cargo config of every directory from `dir` up to the bundle root,
  // the nearest first, as @preventive/lockfile reads them, each with the directory its paths are
  // relative to (the one holding its `.cargo`); the config's text too, for the reading as cargo
  // merges them (the exact resolution). Throws a TomlError or LockfileError naming the config.
  const configsMemo = new Map()
  const configsFrom = (dir) => {
    if (!configsMemo.has(dir)) {
      const out = []
      for (let d = dir; ; d = posix.dirname(d)) {
        const rel = cargoConfigIn(baseDir, d)
        const text = rel === null ? null : readFileOrNull(join(baseDir, rel))
        if (text !== null) out.push({ dir: d, file: rel, text, patch: readNamed(rel, () => parseCargoConfig([text])).patch })
        if (d === '.' || d === '') break
      }
      configsMemo.set(dir, out)
    }
    return configsMemo.get(dir)
  }
  // The `[patch]` of crate `crate` in a build rooted at `root` (the workspace root's manifest, else
  // the bundle root's), as `{ spec, dir, from }`: the cargo config's first, then the root
  // manifest's -- `spec` as @preventive/lockfile reads it, `dir` the patch's directory for a path
  // (null outside the bundle root), `from` the file saying so. Undefined when nothing patches it.
  const patchFor = (root, crate) => {
    const patches = [
      ...configsFrom(root?.dir ?? '.').map((c) => ({ patch: c.patch, relTo: c.dir, from: c.file })),
      ...(root ? [{ patch: root.cargo.patch, relTo: root.dir, from: posix.join(root.dir, 'Cargo.toml') }] : []),
    ]
    for (const { patch, relTo, from } of patches) {
      for (const specs of Object.values(patch)) {
        for (const [name, spec] of Object.entries(specs)) {
          if (normName(name) !== crate) continue
          return { spec, dir: spec.source.type === 'path' ? normalizeRel(relTo, spec.source.path) : null, from }
        }
      }
    }
    return undefined
  }
  // Where a lockfile's package comes from: `path`, `git` or `registry` (sparse or not).
  const sourceKind = (source) => (source === undefined ? 'path' : (source.startsWith('git+') ? 'git' : 'registry'))
  // The keys of the build's lockfile that are package `m`: its path package, or for a vendored copy
  // the locked package of its name and version from where the copy came from (a git checkout or a
  // registry, see vendored).
  const lockKeysOf = (lk, m) => {
    const keys = lk.byId.get(`${normName(m.package.name)} ${version(m)}`) ?? []
    if (!isVendoredDir(m.dir)) return keys.filter((k) => lk.lock.packages[k].source === undefined)
    const sums = checksumOf(m.dir)
    const kind = sums === null ? null : (sums.package === null ? 'git' : 'registry')
    return keys.filter((k) => lk.lock.packages[k].source !== undefined && (kind === null || sourceKind(lk.lock.packages[k].source) === kind))
  }
  // Dependency → package, memoized per (package, request): the fixed-point loop asks many times.
  const depTargets = new Map()
  // The in-tree package a dependency of `m` resolves to through one of its tables (`request`): a
  // `path` dep, else a `[patch]` path override (patchFor) whose version satisfies the requirement,
  // else the vendored crate of that name from where the dependency says (a git dependency, or one a
  // git `[patch]` replaces, takes a copy of a git checkout; any other a registry's) -- the version
  // Cargo.lock records for `m` from that source when it satisfies the requirement, else the one
  // vendored version that does. A package can depend on two versions of one crate (`borsh = "1"`
  // beside `borsh0-9 = { package = "borsh", version = "0.9" }`, or one per table): the lock then
  // lists both under it, and the requirement tells which is which. Null when it isn't in-tree -- a
  // path (or patch) outside the bundle root, or no vendored copy -- and, warned, when the vendored
  // copies don't settle it: the locked version isn't among them, none satisfies the requirement,
  // or several do and no lock chooses. Cargo would build none of those from what the bundle holds,
  // so none is guessed.
  const resolveDep = (m, dep, request) => {
    let byRequest = depTargets.get(m.dir)
    if (byRequest === undefined) depTargets.set(m.dir, byRequest = new Map())
    if (!byRequest.has(request)) byRequest.set(request, resolveDepUncached(m, dep, request))
    return byRequest.get(request)
  }
  const resolveDepUncached = (m, dep, request) => {
    const asPackage = (dir) => {
      const t = dir === null ? null : readManifest(dir)
      return t?.package ? t : null
    }
    // cargo metadata knows exactly which package each dependency edge points at.
    const known = metadata?.deps.get(m.dir)?.get(dep.key)
    if (known !== undefined) return asPackage(known)
    const spec = depSpec(m, dep, request)
    const who = `${m.package.name} ${version(m)}`
    if (spec.path) {
      const dir = normalizeRel(spec.relTo, spec.path)
      const t = asPackage(dir)
      if (dir === null) console.warn(`[loader.cargo] ${who}'s dependency ${dep.name} is a path outside the bundle root: ${spec.path}`)
      else if (t === null) console.warn(`[loader.cargo] ${who}'s dependency ${dep.name} names ${dir}, which holds no Cargo.toml with a [package]`)
      return t
    }
    const crate = normName(spec.package)
    const req = spec.version
    const fits = (ver) => req === null || satisfies(ver, req)
    let kind = spec.source
    const patch = patchFor(workspaceFor(m.dir) ?? readManifest('.'), crate)
    if (patch?.spec.source.type === 'path') {
      if (patch.dir === null) {
        console.warn(`[loader.cargo] ${patch.from} patches ${crate} with a path outside the bundle root`)
        return null
      }
      const t = asPackage(patch.dir)
      // cargo uses a patch only where its version satisfies the requirement ("patch … was not used").
      if (t !== null && fits(version(t))) return t
      console.warn(t === null
        ? `[loader.cargo] ${patch.from} patches ${crate} with ${patch.dir}, which holds no Cargo.toml with a [package]`
        : `[loader.cargo] ${patch.from}'s patch of ${crate} (${version(t)}) doesn't satisfy ${who}'s requirement ${req}: not used`)
    } else if (patch?.spec.source.type === 'git') {
      kind = 'git'
    }
    // A copy of where the dependency comes from (a copy without `.cargo-checksum.json` could be either).
    const candidates = (vendored().byName.get(crate) ?? []).filter((c) => c.git === null || c.git === (kind === 'git'))
    if (candidates.length === 0) return null
    const vendoredList = candidates.map((c) => c.version).toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true })).join(', ')
    const lk = lockfile()
    if (lk) {
      const pins = lockKeysOf(lk, m)
        .flatMap((k) => lk.lock.packages[k].dependencies)
        .map((k) => lk.lock.packages[k])
        .filter((p) => normName(p.name) === crate && sourceKind(p.source) === kind)
        .map((p) => p.version)
      const want = pins.find(fits) ?? null
      // A lock whose pin the requirement no longer allows is out of date: cargo would resolve
      // again, so the requirement decides.
      if (want === null && pins.length > 0) console.warn(`[loader.cargo] ${lk.file} pins ${who} to ${crate} ${pins.join(', ')}, which ${req} doesn't allow: the lock is out of date`)
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
    resolverMemo = root?.resolver ?? (Number(root?.package?.edition ?? 0) >= 2021 ? 2 : 1)
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
  const isOptional = (d) => [...d.kinds.values()].some((r) => r.optional)
  // A feature's list, from cargo's feature map (an optional dependency no `dep:` names has a
  // feature of its own name, as the manifest spells it: `proc-macro-crate`), or null for none.
  const featureImplications = (m, f) => m.features.get(f) ?? null
  // The feature context a root package's own code is resolved in: the host's for a proc-macro
  // crate, which cargo builds for the host; the target's for any other.
  const rootCtx = (m) => featureCtx(isProcMacroPkg(m) ? 'host' : 'target')
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
        // `dep/feat` enables an optional dep, and the package's feature of the dependency's name
        // where it has one, implicit or written (`serde = ["dep:serde", "extra"]` beside `full =
        // ["serde/derive"]` turns `serde` and `extra` on); `dep?/feat` only asks if it is already on.
        if (depFeature[2] !== '?' && isOptional(d)) {
          activate(c, m, d.key)
          if (featureImplications(m, d.name) !== null) enable(c, m, d.name)
        }
        for (const [request, r] of activeRequests(c, m, d)) {
          const t = resolveDep(m, d, r)
          if (t) enable(depCtx(c, request, t), t, depFeature[3])
        }
        return true
      }
      if (featureImplications(m, imp) === null) return false
      enable(c, m, imp)
      return true
    }

    for (const m of roots) {
      inGraph(rootCtx(m), m)
      if (allFeatures) {
        for (const f of m.features.keys()) enable(rootCtx(m), m, f)
      } else if (!noDefaultFeatures) {
        enable(rootCtx(m), m, 'default')
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
      if (targets.filter((m) => applyImplication(rootCtx(m), m, imp)).length === 0 && includeMaybe) {
        console.warn(`[stasis] --cargo-features: '${flag}' names no feature of the entries' packages, nor a dependency of theirs`)
      }
      requested.push({ targets, imp })
    }

    do {
      changed = false
      // The requested features re-apply on every pass like the manifest's entries do: a weak
      // `dep?/x` asked for on the command line takes effect once `default` has activated `dep`.
      for (const { targets, imp } of requested) for (const m of targets) applyImplication(rootCtx(m), m, imp)
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
            const t = resolveDep(m, d, r)
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
  // --- the exact resolution: cargo's resolver, by @preventive/lockfile

  // The directories a workspace `members` pattern names, project-relative (glob's syntax, as cargo
  // takes it: `*`, `?` and `[…]` within a segment, `**` for any depth); null when it leaves the
  // bundle root.
  const subdirs = (dir) => {
    try {
      return readdirSync(join(baseDir, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
    } catch {
      return []
    }
  }
  const globDirs = (rootDir, pattern) => {
    let dirs = [rootDir]
    for (const seg of pattern.split('/').filter((x) => x !== '' && x !== '.')) {
      const next = []
      for (const dir of dirs) {
        if (seg === '**') {
          const all = [dir]
          for (let i = 0; i < all.length; i++) all.push(...subdirs(all[i]).filter((d) => !posix.basename(d).startsWith('.')))
          next.push(...all)
        } else if (/[*?[]/u.test(seg)) {
          const re = new RegExp(`^${seg.replaceAll(/[.+^${}()|\\]/gu, '\\$&').replaceAll('[!', '[^').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`, 'u')
          next.push(...subdirs(dir).filter((d) => re.test(posix.basename(d))))
        } else {
          const rel = normalizeRel(dir, seg)
          if (rel === null) return null
          next.push(rel)
        }
      }
      dirs = next
    }
    return dirs
  }
  // The workspace's members, project-relative, as cargo finds them: the root package, the
  // packages its `members` patterns name, and the path dependencies of members inside the root's
  // directory, less what `exclude` names; null when a pattern leaves the bundle root.
  const membersOf = (root) => {
    const ws = root.cargo.workspace
    if (ws === undefined) return [root.dir]
    const excluded = ws.exclude.map((e) => normalizeRel(root.dir, e)).filter((e) => e !== null)
    const isExcluded = (dir) => excluded.some((e) => dir === e || dir.startsWith(`${e}/`))
    const inRoot = (dir) => root.dir === '.' || dir === root.dir || dir.startsWith(`${root.dir}/`)
    const out = new Set(root.package ? [root.dir] : [])
    for (const pattern of ws.members) {
      const dirs = globDirs(root.dir, pattern)
      if (dirs === null) return null
      for (const dir of dirs) if (!isExcluded(dir) && readManifest(dir)?.package) out.add(dir)
    }
    // Set iteration is live: a path dependency added is walked in turn.
    for (const dir of out) {
      for (const d of readManifest(dir).deps.values()) {
        for (const r of d.kinds.values()) {
          if (r.path === null) continue
          const sub = normalizeRel(r.inherited ? root.dir : dir, r.path)
          if (sub !== null && inRoot(sub) && !isExcluded(sub) && readManifest(sub)?.package) out.add(sub)
        }
      }
    }
    return [...out]
  }
  // The build as cargo resolves it, where the loader holds all that takes -- the build's lockfile
  // and target, a manifest for every package the lockfile has (each path package inside the
  // bundle root, every other one vendored, `.cargo-checksum.json` and all) and entries whose
  // packages are workspace members: @preventive/lockfile lays the lockfile's graph over the
  // manifests (linkCargo) and turns on the features `cargo build -p <the entries' packages>` does
  // (resolveCargoFeatures), cargo's rules throughout -- each table's own source, a [patch] from the
  // root manifest or the cargo config, proc-macros and build-dependencies built for the host, the
  // command line's features handed out as cargo hands them out. What either refuses -- a lockfile
  // out of date with the manifests, a vendored copy whose checksum isn't the lockfile's, a feature
  // asked of a package that hasn't it -- stops the build. A host the loader doesn't know (a
  // target that isn't `host`) is resolved both ways: the host's target-specific tables off for the
  // features on for certain, on for all that may be (hostUndecided). `{ graph, dirOf, keyOf,
  // resolved }` -- package key ↔ dir, and the features per (context, dir) as resolveFeatures
  // gives them -- or null when something it takes is missing, for the replay to decide: no
  // lockfile, no target, a package not vendored, a path outside the bundle root.
  let exactMemo
  const exact = () => {
    if (exactMemo === undefined) exactMemo = exactUncached()
    return exactMemo
  }
  const exactUncached = () => {
    if (metadata || targetInfo === null) return null
    const lk = lockfile()
    const root = buildRoot()
    if (lk === null || root === null) return null
    const memberDirs = membersOf(root)
    if (memberDirs === null) return null
    // The path packages: the members, the path dependencies of each, the path [patch]es.
    const keyOf = new Map() // dir -> package key
    const dirOf = new Map() // package key -> dir
    const queue = [...memberDirs]
    for (const { patch, relTo } of [...configsFrom(root.dir).map((c) => ({ patch: c.patch, relTo: c.dir })), { patch: root.cargo.patch, relTo: root.dir }]) {
      for (const specs of Object.values(patch)) {
        for (const spec of Object.values(specs)) {
          if (spec.source.type !== 'path') continue
          const dir = normalizeRel(relTo, spec.source.path)
          if (dir === null) return null
          queue.push(dir)
        }
      }
    }
    for (const dir of queue) {
      if (keyOf.has(dir)) continue
      const m = readManifest(dir)
      if (!m?.package) return null
      const key = `${m.package.name} ${m.package.version}`
      keyOf.set(dir, key)
      dirOf.set(key, dir)
      for (const d of m.deps.values()) {
        for (const r of d.kinds.values()) {
          if (r.path === null) continue
          const sub = normalizeRel(r.inherited ? (workspaceFor(dir)?.dir ?? dir) : dir, r.path)
          if (sub === null) return null
          queue.push(sub)
        }
      }
    }
    // The vendor directory as a directory source reads it, and every package of the lockfile there.
    const vendor = Object.create(null)
    const held = new Set()
    for (const sub of subdirs(vendorDir)) {
      const name = posix.basename(sub)
      const m = name.startsWith('.') ? null : readManifest(sub)
      if (!m?.package) continue
      const sums = checksumOf(sub)
      if (sums === null) return null
      vendor[name] = { manifest: tableOf(sub).text, checksum: sums.text }
      held.add(`${m.package.name} ${m.package.version}`)
    }
    for (const [key, p] of Object.entries(lk.lock.packages)) {
      if (p.source === undefined ? !dirOf.has(key) : !held.has(`${p.name} ${p.version}`)) return null
    }
    const copies = readNamed(lk.file, () => readCargoVendor(lk.lock, vendor))
    const manifestsByKey = Object.create(null)
    for (const [key, dir] of dirOf) manifestsByKey[key] = readManifest(dir).cargo
    for (const [key, { directory }] of Object.entries(copies)) {
      const dir = `${vendorDir}/${directory}`
      keyOf.set(dir, key)
      dirOf.set(key, dir)
      manifestsByKey[key] = readManifest(dir).cargo
    }
    const memberKeys = memberDirs.map((dir) => keyOf.get(dir))
    const entryKeys = [...new Set(entries.map(packageFor).filter(Boolean).map((m) => keyOf.get(m.dir)))]
    if (entryKeys.length === 0 || entryKeys.some((k) => !memberKeys.includes(k))) return null
    const configs = configsFrom(root.dir)
    const config = readNamed(configs[0]?.file ?? null, () => parseCargoConfig(configs.map((c) => c.text)))
    const graph = readNamed(lk.file, () => linkCargo(lk.lock, manifestsByKey, { workspace: root.cargo, members: memberKeys, config }))
    const rootFile = posix.join(root.dir, 'Cargo.toml')
    const build = { packages: entryKeys, features, allFeatures, noDefaultFeatures, dev: entries.some((e) => isTestTarget(e)) }
    const platform = (info, marks = []) => ({ name: info.triple, cfg: [...info.cfgs, ...marks] })
    const featuresOf = (g, platforms) => readNamed(rootFile, () => resolveCargoFeatures(g, { ...build, ...platforms }))
    let sure
    let all
    if (hostInfo === null) {
      const platforms = { host: { name: MARK_HOST, cfg: [MARK_HOST] }, targets: [platform(targetInfo, [MARK_TARGET, `${MARK_NAME}="${targetInfo.triple}"`])] }
      sure = featuresOf(hostUndecided(graph, false), platforms)
      all = featuresOf(hostUndecided(graph, true), platforms)
    } else {
      sure = featuresOf(graph, { host: platform(hostInfo), targets: [platform(targetInfo)] })
      all = sure
    }
    // Per (context, dir), as resolveFeatures keys them: resolver 1's one set under `target`.
    const byNode = (result) => {
      const out = new Map()
      for (const [key, { normal, host: onHost }] of Object.entries(result)) {
        const dir = dirOf.get(key)
        if (dir === undefined) continue
        if (resolverVersion() === 1) out.set(nodeKey('target', dir), new Set(normal ?? onHost))
        else {
          if (normal !== undefined) out.set(nodeKey('target', dir), new Set(normal))
          if (onHost !== undefined) out.set(nodeKey('host', dir), new Set(onHost))
        }
      }
      return out
    }
    return { graph, dirOf, keyOf, resolved: { sure: byNode(sure), all: byNode(all) } }
  }

  // Both resolutions, per (context, package dir): `sure` without the undecided tables, `all` with
  // them -- the exact resolution's where there is one, the replay's otherwise. `--cargo`: cargo
  // metadata's features, the same in either context.
  let resolved = null
  const ensureResolved = () => {
    if (resolved !== null) return resolved
    if (metadata) {
      const byNode = new Map([...metadata.enabled].flatMap(([dir, set]) => [[nodeKey('target', dir), set], [nodeKey('host', dir), set]]))
      resolved = { sure: byNode, all: byNode }
    } else {
      resolved = exact()?.resolved ?? { sure: resolveFeatures(false), all: resolveFeatures(true) }
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
  // name it doesn't declare is no crate of its. Which of the dependency's tables names the crate
  // is the asking file's `role`: a build script's are the `[build-dependencies]`, a test or bench
  // target's the `[dependencies]` and `[dev-dependencies]`, other code's the `[dependencies]` (any
  // table when none of those has it). Memoized per (package, name, role): every file of a package
  // asks for the same few crates.
  const crateTargets = new Map()
  const depCrate = (m, norm, role) => {
    const memo = `${m?.dir ?? ''}\0${norm}\0${role}`
    if (!crateTargets.has(memo)) crateTargets.set(memo, depCrateUncached(m, norm, role))
    return crateTargets.get(memo)
  }
  const ROLE_KINDS = { build: ['build'], test: ['normal', 'dev'], normal: ['normal'] }
  const requestsFor = (d, role) => {
    const all = [...d.kinds]
    const own = all.filter(([request]) => ROLE_KINDS[role].includes(kindOf(request)))
    return (own.length > 0 ? own : all).map(([, r]) => r)
  }
  // depCrate from the exact resolution: the package's dependency of that key, else the unrenamed
  // one whose lib is named that, from the asking file's tables when it has one there, as the
  // lockfile resolves it.
  const exactCrate = (x, key, norm, role) => {
    const deps = x.graph.packages[key].dependencies
    const libOf = (d) => readManifest(x.dirOf.get(d.resolved))
    const pick = (list) => {
      const own = list.filter((d) => ROLE_KINDS[role].includes(d.kind))
      const d = (own.length > 0 ? own : list).find((dep) => dep.resolved !== undefined)
      return d === undefined ? null : libPath(libOf(d))
    }
    const declared = deps.filter((d) => normName(d.name) === norm)
    if (declared.length > 0) return pick(declared)
    return pick(deps.filter((d) => d.name === d.package && d.resolved !== undefined && libName(libOf(d)) === norm))
  }
  const depCrateUncached = (m, norm, role) => {
    const x = m ? exact() : null
    const key = x?.keyOf.get(m.dir)
    if (key !== undefined) return exactCrate(x, key, norm, role)
    if (m) {
      const d = m.deps.get(norm)
      if (d) {
        for (const r of requestsFor(d, role)) {
          const t = resolveDep(m, d, r)
          if (t) return libPath(t)
        }
        return null
      }
      for (const other of m.deps.values()) {
        for (const r of requestsFor(other, role)) {
          if (r.renamed) continue // a rename is used by its key, not its lib name
          const t = resolveDep(m, other, r)
          if (t && libName(t) === norm) return libPath(t)
        }
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
      const script = m === null || m.package.build === false ? null : normalizeRel(m.dir, m.package.build ?? 'build.rs')
      return depCrate(m, norm, fromFile === script ? 'build' : (isTestTarget(fromFile) ? 'test' : 'normal'))
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
