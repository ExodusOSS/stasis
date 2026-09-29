// Foundry configuration for the Solidity loader: foundry.toml profiles (with `extends`) and the
// remappings `forge build` hands solc -- the `FOUNDRY_REMAPPINGS`/`DAPP_REMAPPINGS` env var,
// remappings.txt, the profile's `remappings`, those of every dependency that is itself a Foundry
// project, and the ones forge auto-detects under the `libs` dirs (global, plus per-dependency
// contexts for an alias two dependencies map differently). A port of foundry v1.8.3's
// `RemappingsProvider` (crates/config/src/providers/remappings.rs) and foundry-compilers'
// `Remapping::find_many_with_context` (artifacts/solc/src/remappings/find.rs), including the
// `forge build` pass that drops aliases of the project's own src/test/script dirs.
//
// Paths are absolute POSIX strings internally, compared the way Rust compares `Path`s (by
// component: a trailing `/` doesn't count), and returned relative to the project root. Not read:
// the global ~/.foundry/foundry.toml, `FOUNDRY_CONFIG`, and the FOUNDRY_*/DAPP_* overrides of
// other keys (`FOUNDRY_PROFILE` and the remapping env vars are). The project is read through a
// `host` (@exodus/stasis-core/host), the disk's by default.

import { posix, resolve } from 'node:path'

import { readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { toPosix } from '@exodus/stasis-core/util'
import { isDir } from '../resolve-typescript.js'
import { readFileOrNull } from './cargo.js'
import { projectOwnership } from './solidity-ownership.js'
import { isTomlTable, readToml } from './toml.js'

export const FOUNDRY_TOML = 'foundry.toml'
export const REMAPPINGS_TXT = 'remappings.txt'

// --- Path helpers (Rust `Path` semantics on POSIX strings) --------------------------------

const isAbs = (p) => p.startsWith('/')
const normalComps = (p) => p.split('/').filter((c) => c !== '' && c !== '.')
const compCount = (p) => normalComps(p).length + (isAbs(p) ? 1 : 0)
const fileName = (p) => normalComps(p).at(-1) ?? null
const pathKey = (p) => (isAbs(p) ? '/' : '') + normalComps(p).join('/')
const pathEq = (a, b) => pathKey(a) === pathKey(b)
// `Path::ends_with` with a relative suffix: the last components match.
const pathEndsWith = (p, suffix) => {
  const a = normalComps(p)
  const b = normalComps(suffix)
  return b.length <= a.length && b.every((c, i) => a[a.length - b.length + i] === c)
}
// `Path::strip_prefix`: the remaining components (no trailing `/`), or null.
function stripPrefix(p, base) {
  if (isAbs(p) !== isAbs(base)) return null
  const a = normalComps(p)
  const b = normalComps(base)
  if (b.length > a.length || !b.every((c, i) => a[i] === c)) return null
  return a.slice(b.length).join('/')
}
const pathStartsWith = (p, base) => stripPrefix(p, base) !== null
// `PathBuf::join`: an absolute `p` replaces; otherwise appended with one separator.
const rustJoin = (base, p) => (isAbs(p) ? p : base.endsWith('/') ? `${base}${p}` : `${base}/${p}`)
const parentOf = (p) => {
  const c = normalComps(p)
  if (c.length === 0) return null
  return (isAbs(p) ? '/' : '') + c.slice(0, -1).join('/')
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// `Ord for Path`: component by component.
function cmpPath(a, b) {
  if (isAbs(a) !== isAbs(b)) return isAbs(a) ? -1 : 1
  const x = normalComps(a)
  const y = normalComps(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = cmpStr(x[i], y[i])
    if (c !== 0) return c
  }
  return x.length - y.length
}

function canonicalize(p, host) {
  try {
    return toPosix(host.realpath(p))
  } catch {
    return null
  }
}

const isSymlinkPath = (p, host) => {
  try {
    return host.readlink(p) !== null
  } catch {
    return false
  }
}

// A dir's entries with their (symlink-followed) kind, in the filesystem's own order where the host
// has one (readdirUnsorted): forge walks `read_dir` unsorted, and where two packages share a lib
// window the first one listed decides a remapping. An entry whose symlink doesn't resolve is dropped.
function listDir(dir, host) {
  let entries
  try {
    entries = host.readdirUnsorted ? host.readdirUnsorted(dir) : host.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    const path = rustJoin(dir, e.name)
    const kind = e.isSymbolicLink() ? host.stat(path) : e
    if (kind === null) continue
    out.push({ path, name: e.name, isFile: kind.isFile(), isDir: kind.isDirectory(), isSymlink: e.isSymbolicLink() })
  }
  return out
}

// The auto-detection's view of a dir: hidden entries skipped.
const readDir = (dir, host) => listDir(dir, host).filter((e) => !e.name.startsWith('.'))

// --- Remapping values ----------------------------------------------------------------------

// `[context:]name=path`, as forge (`Remapping::from_str`) and solc split it: at the first `=`, then
// the first `:` before it. An empty context is global; an empty name or path is invalid (null),
// but for solc (`emptyPath`) only an empty name is: `x/=` maps `x/A.sol` to `A.sol`.
export function parseRemapping(entry, { emptyPath = false } = {}) {
  const eq = entry.indexOf('=')
  if (eq === -1) return null
  let name = entry.slice(0, eq)
  const path = entry.slice(eq + 1)
  let context = null
  const colon = name.indexOf(':')
  if (colon !== -1) {
    context = name.slice(0, colon)
    name = name.slice(colon + 1)
  }
  if (name.trim() === '' || (!emptyPath && path.trim() === '')) return null
  if (context !== null && context.trim() === '') context = null
  return { context, name, path }
}

// A remappings.txt / env var body: one remapping per non-blank (trimmed) line; invalid lines
// (forge rejects the whole file on one) are skipped, and reported when a `label` names the source.
// `options`: see parseRemapping.
export function parseRemappingLines(text, label, options) {
  const out = []
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const r = parseRemapping(line, options)
    if (r) out.push(r)
    else if (label !== undefined) console.warn(`[loader.solidity] Invalid remapping in ${label}: ${line}`)
  }
  return out
}

// Forge's trailing `/` on a remapping's name and path, unless they end in `/` or `.sol`.
const withSlash = (s) => (s.endsWith('/') || s.endsWith('.sol') ? s : `${s}/`)

// A remapping as forge hands it to solc, in the loader's `{ context, prefix, target }` shape:
// `forge-std=lib/forge-std/src` is `forge-std/=lib/forge-std/src/`.
export const toSolcRemapping = (r) => ({ context: r.context, prefix: withSlash(r.name), target: withSlash(r.path) })

// The profile forge selects: FOUNDRY_PROFILE, else `default`. Profile names are case-insensitive
// (figment's `Profile`), so they are compared lowercased.
export const foundryProfile = (env) => (env.FOUNDRY_PROFILE || 'default').toLowerCase()

// `RelativeRemappingPathBuf::with_root`.
function withRoot(parent, path) {
  const rest = stripPrefix(path, parent)
  if (rest !== null) return { parent, path: rest }
  if (isAbs(path)) return { parent: null, path }
  return { parent, path }
}

// `RelativeRemapping::new(remapping, root)`.
function toRelative(r, root) {
  return {
    context: r.context === null ? null : withRoot(root, r.context).path,
    name: r.name,
    path: withRoot(root, r.path),
  }
}

// `From<RelativeRemapping> for Remapping`: the path joined back onto its parent, and a trailing
// `/` on name and path unless they end in `/` or `.sol`.
function fromRelative(rr) {
  const { parent, path } = rr.path
  const joined = isAbs(path) || parent === null ? path : rustJoin(parent, path)
  return { context: rr.context, name: withSlash(rr.name), path: withSlash(joined) }
}

// `relative_remapping_preserving_context_boundary`: relative to `root`, keeping a context's
// trailing `/` (it bounds the directory the context names).
function relativePreservingBoundary(r, root) {
  const rr = toRelative(r, root)
  if (r.context?.endsWith('/') && rr.context !== null) rr.context = withTrailing(rr.context)
  return rr
}

// `Display for RelativeRemapping`.
function displayRelative(rr) {
  const s = `${rr.context === null ? '' : `${rr.context}:`}${rr.name}=${rr.path.path}`
  return withSlash(s)
}

// `RelativeRemapping` equality (paths by component).
const relKey = (rr) => `${rr.context}\0${rr.name}\0${rr.path.parent === null ? '\u0001' : pathKey(rr.path.parent)}\0${pathKey(rr.path.path)}`

// `Remappings`: a list that only takes an alias not already claimed (in the same context) by an
// equal or shorter one, and never an alias of the project's own src/test/script dirs.
class Remappings {
  constructor(remappings = [], projectPaths = []) {
    this.remappings = remappings
    this.projectPaths = projectPaths
  }

  push(r) {
    if (r.name.endsWith('.sol') && !r.path.endsWith('.sol')) return
    const conflicting = this.remappings.some((e) => {
      if (r.name.endsWith('.sol')) return e.name === r.name && e.context === r.context && e.path === r.path
      return r.name.startsWith(withTrailing(e.name)) && e.context === r.context
    })
    if (conflicting) return
    if (this.projectPaths.some((p) => p.toLowerCase() === r.name.toLowerCase())) return
    this.remappings.push(r)
  }

  // First of each (context, name).
  intoInner() {
    const seen = new Set()
    return this.remappings.filter((r) => {
      const key = `${r.context}\0${r.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}

const withTrailing = (s) => (s.endsWith('/') ? s : `${s}/`)
const trimSlashes = (s) => s.replace(/\/+$/u, '')

// `remapping_name_is_prefix`: `prefix` names `name` or a parent namespace of it.
function nameIsPrefix(prefix, name) {
  const p = trimSlashes(prefix)
  const n = trimSlashes(name)
  return p === n || (n.startsWith(p) && n.slice(p.length).startsWith('/'))
}

// --- Auto-detection (foundry-compilers find.rs) ---------------------------------------------

const SRC_DIR = 'src'
const JS_SRC_DIR = 'contracts'
const isSourceDir = (p) => [SRC_DIR, JS_SRC_DIR].includes(fileName(p))
const isLibName = (name) => name === 'lib' || name === 'node_modules'
const isLibDir = (p) => isLibName(fileName(p))
const noRecurse = (name) => name === 'tests' || name === 'test' || name === 'demo'

function dirDistance(root, current) {
  const rest = stripPrefix(current, root)
  return rest === null ? 0 : normalComps(rest).length
}

// The window a dir under the lib dir `root` belongs to: `root`'s child on the way to `current`.
// (Upstream loops `while !is_lib_dir(next) || !next.ends_with("contracts")`, which always holds on
// the first component.)
function nextNestedWindow(root, current) {
  if (!isLibDir(root)) return root
  const first = normalComps(stripPrefix(current, root) ?? '')[0]
  return first === undefined ? root : rustJoin(root, first)
}

function lastNestedSourceDir(root, dir) {
  if (isSourceDir(dir)) return dir
  let p = dir
  for (let parent = parentOf(p); parent !== null; parent = parentOf(p)) {
    if (pathEq(parent, root)) return root
    if (isSourceDir(parent)) return parent
    p = parent
  }
  return root
}

const endsWithJsSource = (c) => fileName(c.sourceDir) === JS_SRC_DIR || pathEndsWith(c.sourceDir, 'contracts/src')

function mergeOnSameLevel(candidates, currentDir, level, windowStart, insideNodeModules) {
  // A single `src` candidate wins outright.
  const srcs = candidates.filter((c) => fileName(c.sourceDir) === SRC_DIR)
  if (srcs.length === 1) {
    candidates.splice(0, candidates.length, srcs[0])
    return
  }
  // Else the current dir absorbs the candidates of its level (`current/{auth,tokens}/*.sol`).
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i].level === level) candidates.splice(i, 1)
  }
  const sourceDir = insideNodeModules ? windowStart : currentDir
  // `<dep>/src/lib/` mistaken for a package of its own.
  if (level > 0 && pathEq(sourceDir, windowStart) && (isSourceDir(sourceDir) || isLibDir(sourceDir))) return
  candidates.push({ windowStart, sourceDir, level })
}

// Candidates below `currentDir`: a window opens at each `lib`/`node_modules` barrier, and a dir
// holding `.sol` files is a source dir of the window it lies in. Symlinked dirs are followed,
// except back into the current traversal path.
function findRemappingCandidates(currentDir, open, level, insideNodeModules, visited, host) {
  let isCandidate = false
  let current
  const search = []
  for (const e of readDir(currentDir, host)) {
    if (!isCandidate && e.isFile && e.name.endsWith('.sol')) {
      isCandidate = true
    } else if (e.isDir) {
      let seen = visited
      if (e.isSymlink) {
        const target = canonicalize(e.path, host)
        if (target !== null) {
          current ??= canonicalize(currentDir, host)
          if (visited.has(target) || (current !== null && pathStartsWith(current, target))) continue
          seen = new Set(visited).add(target)
        }
      }
      if (!noRecurse(e.name)) search.push([e, seen])
    }
  }

  const candidates = []
  for (const [{ path, name }, seen] of search) {
    candidates.push(...(isLibName(name)
      ? findRemappingCandidates(path, path, level + 1, insideNodeModules, seen, host)
      : findRemappingCandidates(path, open, level, insideNodeModules, seen, host)))
  }

  const windowStart = nextNestedWindow(open, currentDir)
  if (isCandidate || candidates.filter((c) => c.level === level && pathEq(c.windowStart, windowStart)).length > 1) {
    mergeOnSameLevel(candidates, currentDir, level, windowStart, insideNodeModules)
  } else {
    // A single nested candidate: `current/nested/contracts/c.sol` maps to `current`.
    const c = candidates.find((x) => x.level === level)
    if (c) {
      const distance = dirDistance(c.windowStart, c.sourceDir)
      if (distance > 1 && endsWithJsSource(c)) c.sourceDir = windowStart
      else if (!isSourceDir(c.sourceDir) && !pathEq(c.sourceDir, c.windowStart)) c.sourceDir = lastNestedSourceDir(open, c.sourceDir)
    }
  }
  return candidates
}

// Prefer the shorter path, then one ending in `src`.
function insertPrioritized(map, key, path) {
  const existing = map.get(key)
  if (existing === undefined || compCount(existing) > compCount(path) || (fileName(path) === SRC_DIR && fileName(existing) !== SRC_DIR)) {
    map.set(key, path)
  }
}

// The dependency owning a nested package window: the path before the last `lib`/`node_modules`
// component below `root` (null at the top level).
function dependencyOwner(root, windowStart) {
  const rest = stripPrefix(windowStart, root)
  if (rest === null) return null
  const parts = normalComps(rest)
  const barrier = parts.findLastIndex((c) => c === 'lib' || c === 'node_modules')
  return barrier > 0 ? parts.slice(0, barrier).reduce((p, c) => rustJoin(p, c), root) : null
}

const byContextDepth = (a, b) => {
  const x = a.context ?? ''
  const y = b.context ?? ''
  return compCount(y) - compCount(x) || cmpStr(x, y)
}

// `Remapping::find_many_with_context(dir)`: `{ global, contextual }` remappings for the packages
// under a lib dir, `contextual` keyed by the dependency whose own lib dir holds the package.
export function findRemappingsWithContext(dir, host = diskHost) {
  const insideNodeModules = fileName(dir) === 'node_modules'
  const candidates = readDir(dir, host)
    .filter((e) => e.isDir)
    .flatMap((e) => findRemappingCandidates(e.path, e.path, 0, insideNodeModules, new Set(), host))
    .toSorted((a, b) => cmpPath(a.sourceDir, b.sourceDir))

  const global = new Map()
  const contextual = new Map()
  for (const c of candidates) {
    const name = fileName(c.windowStart)
    if (name === null) continue
    const key = `${name}/`
    const owner = dependencyOwner(dir, c.windowStart)
    if (owner !== null) {
      if (!contextual.has(owner)) contextual.set(owner, new Map())
      insertPrioritized(contextual.get(owner), key, c.sourceDir)
    }
    insertPrioritized(global, key, c.sourceDir)
  }
  const sortedEntries = (map, cmp) => [...map].toSorted(([a], [b]) => cmp(a, b))
  return {
    global: sortedEntries(global, cmpStr).map(([name, path]) => ({ context: null, name, path: `${path}/` })),
    contextual: sortedEntries(contextual, cmpPath)
      .flatMap(([owner, map]) => sortedEntries(map, cmpStr).map(([name, path]) => ({ context: `${owner}/`, name, path: `${path}/` })))
      .toSorted(byContextDepth),
  }
}

// --- foundry.toml ---------------------------------------------------------------------------

const snakeCase = (k) => k.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2').replaceAll('-', '_').toLowerCase()

// Top-level tables that are sections of their own, not (legacy) profiles (`Config::STANDALONE_SECTIONS`).
const STANDALONE_SECTIONS = new Set([
  'profile', 'external', 'rpc_endpoints', 'etherscan', 'fmt', 'lint', 'doc', 'fuzz', 'invariant', 'symbolic',
  'coverage', 'mutation', 'tracing', 'labels', 'dependencies', 'soldeer', 'vyper', 'bind_json',
])

// foundry.toml -> `{ profiles, topLevel }`. `profiles` is Map<profile, Map<key, value>> (profile
// names lowercased, keys snake_cased as forge does) from the `[profile.<name>]` tables and the
// legacy top-level `[<name>]` ones forge still reads (not for `extends`), the former winning key
// by key; a profile's sub-tables are its values like any other (`extends`, `fuzz`: forge compares
// them all for a `no-collision` extends). `topLevel` holds the values set outside any table (forge
// rejects those; a `--mapping` file may list its `remappings` there). Throws a TomlError naming
// `file` on text that isn't TOML, as forge refuses the file.
function parseFoundryToml(text, file = null) {
  const current = new Map()
  const legacy = new Map()
  const topLevel = new Map()
  const read = (map, name, table) => {
    const profile = name.toLowerCase()
    const dict = map.get(profile) ?? map.set(profile, new Map()).get(profile)
    for (const [key, value] of Object.entries(table)) {
      const k = snakeCase(key)
      if (k !== 'extends' || map === current) dict.set(k, value) // forge reads `extends` from `[profile.<name>]` only
    }
  }
  for (const [key, value] of Object.entries(readToml(text, file))) {
    if (!isTomlTable(value)) topLevel.set(snakeCase(key), value)
    else if (key === 'profile') {
      for (const [name, table] of Object.entries(value)) if (isTomlTable(table)) read(current, name, table)
    } else if (!STANDALONE_SECTIONS.has(key)) read(legacy, key, value)
  }
  const profiles = new Map([...legacy].map(([name, dict]) => [name, new Map(dict)]))
  for (const [name, dict] of current) profiles.set(name, new Map([...(profiles.get(name) ?? []), ...dict]))
  return { profiles, topLevel }
}

// Figment's merge of an `extends` base under the local file: local keys win, and with the
// default `extend-arrays` strategy an array set on both sides is the base's followed by the local's.
function mergeExtended(base, local, strategy) {
  const out = new Map([...base].map(([p, dict]) => [p, new Map(dict)]))
  for (const [p, dict] of local) {
    if (!out.has(p)) out.set(p, new Map())
    const merged = out.get(p)
    for (const [k, v] of dict) {
      const prev = merged.get(k)
      merged.set(k, strategy === 'extend-arrays' && Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v)
    }
  }
  return out
}

// A foundry.toml's profiles, with the selected profile's `extends` base merged in (forge's
// `TomlFileProvider`). `files` lists what was read; `topLevel` is the file's own (see
// parseFoundryToml). Throws where forge refuses the config, and where `readable` (a dependency's
// config: see findNestedFoundryRemappings) refuses the file or its base: a dependency's config may
// not read the project's files.
function readFoundryProfiles(file, profile, { readable } = {}) {
  const text = readFileOrNull(file)
  if (text === null) return { profiles: new Map(), topLevel: new Map(), files: [] }
  if (readable && !readable(file)) throw new Error(`${file}: refusing to read it, a link out of the dependency`)
  let { profiles, topLevel } = parseFoundryToml(text, file)
  const files = [file]
  const ext = profiles.get(profile)?.get('extends')
  const extPath = typeof ext === 'string' ? ext : ext?.path
  if (typeof extPath === 'string') {
    const strategy = (typeof ext === 'object' && typeof ext.strategy === 'string') ? ext.strategy : 'extend-arrays'
    const baseFile = toPosix(resolve(posix.dirname(file), extPath))
    if (readable && !readable(baseFile)) throw new Error(`${file}: refusing to extend ${extPath}, which lies outside the dependency`)
    const baseText = readFileOrNull(baseFile)
    if (baseText === null) throw new Error(`${file}: the inherited config file does not exist: ${extPath}`)
    const base = parseFoundryToml(baseText, baseFile).profiles
    if (base.get(profile)?.has('extends')) {
      throw new Error(`${file}: nested inheritance is not allowed (${extPath} has an 'extends' field in profile '${profile}')`)
    }
    if (strategy === 'no-collision') {
      const collisions = [...(profiles.get(profile)?.keys() ?? [])].filter((k) => k !== 'extends' && base.get(profile)?.has(k))
      if (collisions.length > 0) throw new Error(`${file}: key collision in profile '${profile}' when extending ${extPath}: ${collisions.join(', ')}`)
    }
    profiles = mergeExtended(base, profiles, strategy)
    files.push(baseFile)
  }
  return { profiles, topLevel, files }
}

// `[profile.default]` overlaid with the selected profile (a missing selected profile falls back to
// the default, as forge does for dependency configs).
function selectProfile(profiles, profile) {
  const dict = new Map(profiles.get('default') ?? [])
  if (profile !== 'default') for (const [k, v] of profiles.get(profile) ?? []) dict.set(k, v)
  return dict
}

// The `remappings` a foundry.toml's profiles set for `profile` (`[profile.default]` overlaid by
// it), else the file's top-level `remappings` (a mapping file written for stasis), as written.
const profileRemappings = ({ profiles, topLevel }, profile) =>
  (stringList(selectProfile(profiles, profile).get('remappings')) ?? stringList(topLevel.get('remappings')) ?? []).map(parseRemapping).filter(Boolean)

// A foundry.toml text's own remappings for `profile` (see profileRemappings).
export function foundryTomlRemappings(text, profile = 'default') {
  return profileRemappings(parseFoundryToml(text), profile)
}

// The same for a foundry.toml file, with its `extends` base: what `--mapping=foundry.toml` takes.
// `files` lists what was read; `profiled` whether the selected `profile` is one of the file's.
export function readFoundryTomlRemappings(file, profile = 'default') {
  const read = readFoundryProfiles(toPosix(resolve(file)), profile)
  return { remappings: profileRemappings(read, profile), files: read.files, profiled: profile !== 'default' && read.profiles.has(profile) }
}

// Whether the selected `profile` is one of the root foundry.toml's `profiles` (forge uses
// `[profile.default]` for one that isn't: warned).
function profileApplies(profiles, profile) {
  if (profile === 'default') return false
  if (profiles.has(profile)) return true
  console.warn(`[loader.solidity] FOUNDRY_PROFILE=${profile} is not a profile in foundry.toml; using [profile.default]`)
  return false
}

// `ProjectPathsConfig::find_source_dir`: `src` unless only `contracts` exists.
const findSourceDir = (root, host) => (isDir(rustJoin(root, 'src'), host) || !isDir(rustJoin(root, JS_SRC_DIR), host) ? 'src' : JS_SRC_DIR)

// `DappHardhatDirProvider`: `lib` and/or `node_modules`, whichever exist (`lib` when neither).
function detectLibs(root, host) {
  const nm = isDir(rustJoin(root, 'node_modules'), host)
  const lib = isDir(rustJoin(root, 'lib'), host)
  if (!nm) return ['lib']
  return lib ? ['lib', 'node_modules'] : ['node_modules']
}

const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null)

// The selected profile's settings for a Foundry project at `root` (absolute POSIX), defaults
// filled in the way forge fills them. `remappings` are the profile's own, unnormalized. Null
// `remappings` means one didn't parse (forge rejects such a config). `readable`: see
// readFoundryProfiles.
function loadFoundryConfig(root, profile, { readable } = {}) {
  const { profiles, files } = readFoundryProfiles(rustJoin(root, FOUNDRY_TOML), profile, { readable })
  const dict = selectProfile(profiles, profile)
  const str = (k) => (typeof dict.get(k) === 'string' ? dict.get(k) : null)
  const remappings = (stringList(dict.get('remappings')) ?? []).map(parseRemapping)
  return {
    profiles,
    files,
    src: str('src') ?? findSourceDir(root, host),
    test: str('test') ?? 'test',
    script: str('script') ?? 'script',
    libs: stringList(dict.get('libs')) ?? detectLibs(root, host),
    remappings: remappings.includes(null) ? null : remappings,
    autoDetect: dict.get('auto_detect_remappings') !== false,
  }
}

// --- The remappings provider ----------------------------------------------------------------

// `foundry_toml_dir_entries`: `dir` and its direct subdirs (symlinks resolved) that hold a
// foundry.toml, as `{ canonical, path, isSymlink }`.
function foundryTomlDirEntries(dir, host) {
  const out = []
  const consider = (path, isSymlink) => {
    if (host.stat(rustJoin(path, FOUNDRY_TOML)) === null) return
    const canonical = canonicalize(path, host)
    if (canonical !== null) out.push({ canonical, path, isSymlink })
  }
  consider(dir, isSymlinkPath(dir, host))
  for (const e of listDir(dir, host)) if (e.isDir) consider(e.path, e.isSymlink)
  return out
}

const cmpEntry = (a, b) => cmpPath(a.canonical, b.canonical) || cmpPath(a.path, b.path)

function rebaseNested(r, canonical, lexical) {
  const rebase = (v) => {
    const rest = stripPrefix(v, canonical)
    return rest === null ? v : rustJoin(lexical, rest)
  }
  const out = { ...r, path: rebase(r.path) }
  if (r.context !== null) {
    const boundary = r.context.endsWith('/')
    let context
    if (isAbs(r.context)) {
      context = rebase(r.context)
    } else {
      const parts = []
      for (const c of normalComps(rustJoin(lexical, r.context))) {
        if (c === '..') parts.pop()
        else parts.push(c)
      }
      context = `/${parts.join('/')}`
    }
    out.context = boundary ? withTrailing(context) : context
  }
  return out
}

// A dependency's config as forge's `load_nested_config` reads it: remappings rebased onto its
// canonical root, its remappings.txt, its src and libs. Null when forge would reject the config,
// or when `readable` refuses it or its `extends` base (warned); a remappings.txt it refuses is
// skipped (warned).
function loadNestedConfig(canonical, profile, readable) {
  let config
  try {
    config = loadFoundryConfig(canonical, profile, { readable })
  } catch (err) {
    console.warn(`[loader.solidity] Skipping a dependency's config: ${err.message}`)
    return null
  }
  if (config.remappings === null) return null
  const txt = rustJoin(canonical, REMAPPINGS_TXT)
  let text = readFileOrNull(txt)
  if (text !== null && !readable(txt)) {
    console.warn(`[loader.solidity] Skipping a dependency's ${txt}: it is a link out of the dependency`)
    text = null
  }
  return {
    src: config.src,
    libs: config.libs,
    files: [...config.files, ...(text === null ? [] : [txt])],
    // `sanitized()` roots them, then `Remapping::from` makes the path absolute and slash-terminated.
    remappings: config.remappings.map((r) => fromRelative(relativePreservingBoundary(fromRelative({ ...r, path: { parent: null, path: r.path } }), canonical))),
    fileRemappings: text === null ? [] : parseRemappingLines(text, txt),
  }
}

// `find_nested_foundry_remappings`: `[lexicalLibPath, remapping, isPackageEntry]` for every
// dependency (transitively, through each one's own libs) that is a Foundry project. A dependency's
// config reads only its own files and other dependencies' (by real path: `ownership`, see
// solidityOwnership), as forge would find them from its lexical path.
function findNestedFoundryRemappings(root, libPaths, profile, files, ownership) {
  const canonicalRoot = canonicalize(root) ?? root
  const readable = (entry) => (file) => {
    const o = ownership.of(`${stripPrefix(entry.path, root)}/${posix.relative(entry.canonical, file)}`)
    return o.real === null || (o.escape === null && (o.dependency || pathStartsWith(canonicalize(file) ?? file, entry.canonical)))
  }
  // A BTreeSet popped in (canonical, path) order.
  const pending = new Map()
  const addPending = (e) => pending.set(`${e.canonical}\0${e.path}`, e)
  for (const lib of libPaths) for (const e of foundryTomlDirEntries(rustJoin(root, lib), host)) addPending(e)
  const seen = new Set([canonicalRoot])
  const configs = new Map()
  const out = []
  while (pending.size > 0) {
    let key
    let entry
    for (const [k, e] of pending) {
      if (entry === undefined || cmpEntry(e, entry) < 0) [key, entry] = [k, e]
    }
    pending.delete(key)
    if (entry.canonical === canonicalRoot) continue
    if (!configs.has(entry.canonical)) {
      const config = loadNestedConfig(entry.canonical, profile, readable(entry))
      configs.set(entry.canonical, config)
      // Record what was read under the dependency's lexical path (where the bundle sees it).
      for (const f of config?.files ?? []) files.add(rustJoin(entry.path, stripPrefix(f, entry.canonical) ?? f))
    }
    const config = configs.get(entry.canonical)
    if (!config) continue
    for (const r of config.remappings) out.push([entry.path, rebaseNested(r, entry.canonical, entry.path), false])
    for (const r of config.fileRemappings) out.push([entry.path, fromRelative(toRelative(r, entry.path)), false])
    if (!entry.isSymlink && !seen.has(entry.canonical)) {
      seen.add(entry.canonical)
      for (const lib of config.libs) {
        for (const e of foundryTomlDirEntries(rustJoin(entry.path, lib), host)) if (!e.isSymlink) addPending(e)
      }
    }
    // A custom (or missing) source dir isn't auto-detected: forge synthesizes `<dep>/=<dep>/<src>/`.
    const standard = ['src', 'contracts', 'lib'].some((s) => pathEq(s, config.src))
    const name = fileName(entry.path)
    if ((!standard || !isDir(rustJoin(entry.canonical, config.src), host)) && name !== null) {
      out.push([entry.path, { context: null, name: `${name}/`, path: withTrailing(rustJoin(entry.path, config.src)) }, true])
    }
  }
  return out
}

// `configured_auto_remapping`: an auto-detected alias a dependency's config redirects (its
// synthesized `<dep>/<src>/` entry) takes that target.
function configuredAutoRemapping(r, packageEntries) {
  let best = null
  for (const [lib, configured] of packageEntries) {
    if (configured.name !== r.name) continue
    if (r.context !== null && (pathEq(lib, r.context) || !pathStartsWith(lib, r.context))) continue
    let rank
    if (pathStartsWith(r.path, lib)) rank = [0, Number.MAX_SAFE_INTEGER - compCount(lib)]
    else if (r.context !== null && pathStartsWith(lib, r.context) && pathStartsWith(lib, r.path)) rank = [1, compCount(lib)]
    else continue
    // `min_by` rank, then lib path: the first minimum wins.
    const order = best === null ? -1 : (rank[0] - best.rank[0] || rank[1] - best.rank[1] || cmpPath(lib, best.lib))
    if (order < 0) best = { rank, lib, configured }
  }
  return best === null ? r : { ...r, path: best.configured.path }
}

// `contextual_overlays`: null when an applicable authoritative alias already covers the
// refinement; else the authoritative aliases below it, re-scoped to the refinement's context.
function contextualOverlays(authoritative, refinement) {
  const applicable = authoritative.filter((m) => m.context === null || (refinement.context !== null && pathStartsWith(refinement.context, m.context)))
  if (applicable.some((m) => nameIsPrefix(m.name, refinement.name))) return null
  return applicable
    .filter((m) => nameIsPrefix(refinement.name, m.name))
    .toSorted((a, b) => b.name.length - a.name.length)
    .map((m) => ({ ...m, context: refinement.context }))
}

// `expand_scoped_contextual_remapping`: a contextual `@scope/=<..>/node_modules/@scope/` becomes
// one remapping per package in the scope.
function expandScopedContextual(r, host) {
  const scope = trimSlashes(r.name)
  if (!scope.startsWith('@') || fileName(r.path) !== scope || fileName(parentOf(r.path) ?? '') !== 'node_modules') return [r]
  const packages = listDir(r.path, host)
    .filter((e) => e.isDir)
    .map((e) => ({ context: r.context, name: `${scope}/${e.name}/`, path: `${e.path}/` }))
    .toSorted((a, b) => cmpStr(a.name, b.name))
  return packages.length === 0 ? [r] : packages
}

// Forge's closest-path choice per alias: fewer components, then `src`, then path order.
function insertClosest(m, key, path) {
  const existing = m.get(key)
  const srcRank = (p) => (fileName(p) === SRC_DIR ? 0 : 1)
  if (existing === undefined || (compCount(path) - compCount(existing) || srcRank(path) - srcRank(existing) || cmpPath(path, existing)) < 0) {
    m.set(key, path)
  }
}

// A refinement with the authoritative aliases it overlays, or nothing when one already covers it.
const withOverlays = (authoritative, r) => {
  const overlays = contextualOverlays(authoritative, r)
  return overlays ? [...overlays, r] : []
}

// `RemappingsProvider::get_remappings`: the remappings in the order forge settles them.
function providerRemappings(root, { userRemappings, libs, autoDetect, profile, files, ownership }) {
  const authoritativeUser = userRemappings.map((r) => (r.context === null ? r : { ...r, context: rustJoin(root, r.context) }))
  const all = new Remappings([...userRemappings])
  if (!autoDetect) return all.intoInner()

  const nested = findNestedFoundryRemappings(root, libs, profile, files, ownership)
  const auto = { global: [], contextual: [] }
  for (const lib of libs) {
    const found = findRemappingsWithContext(rustJoin(root, lib), host)
    auto.global.push(...found.global)
    auto.contextual.push(...found.contextual)
  }

  const packageEntries = nested.filter(([, , pkg]) => pkg)
  const safeAlias = (r) => !['lib/', 'src/', 'contracts/'].includes(r.name)
  const global = auto.global.map((r) => configuredAutoRemapping(r, packageEntries)).filter(safeAlias)
  const contextual = auto.contextual.map((r) => configuredAutoRemapping(r, packageEntries)).filter(safeAlias)
  const detected = [...global, ...contextual]

  const targetsByAlias = new Map()
  for (const r of detected) {
    if (!targetsByAlias.has(r.name)) targetsByAlias.set(r.name, new Set())
    targetsByAlias.get(r.name).add(pathKey(r.path))
  }
  const ambiguous = new Set([...targetsByAlias].filter(([, t]) => t.size > 1).map(([name]) => name))

  const explicitContextual = nested.filter(([, r]) => r.context !== null).flatMap(([, r]) => withOverlays(authoritativeUser, r))
  const authoritative = [...authoritativeUser, ...explicitContextual]
  // Forge's per-(context, alias) closest paths; only global remappings ever reach it.
  const closest = new Map()
  const contextualRemappings = []
  for (const [lib, r, isPackageEntry] of nested) {
    if (r.context !== null) continue
    // A dependency refining an auto-detected package root to its source dir: scope the refinement
    // to that dependency so root imports keep the broader mapping.
    const refines = !isPackageEntry && detected.some((a) => a.name === r.name && !pathEq(r.path, a.path)
      && ((a.context !== null && pathEq(a.context, lib)) || (a.context === null && pathStartsWith(r.path, a.path))))
    if (refines) contextualRemappings.push(...withOverlays(authoritative, { ...r, context: `${lib}/` }))
    insertClosest(closest, r.name, r.path)
  }
  for (const r of contextual.filter((c) => ambiguous.has(c.name)).flatMap((c) => expandScopedContextual(c, host))) {
    contextualRemappings.push(...withOverlays(authoritative, r))
  }
  for (const r of global) insertClosest(closest, r.name, r.path)

  const explicit = new Set(all.remappings.map((r) => relKey(relativePreservingBoundary(r, root))))
  for (const c of [...explicitContextual.toSorted(byContextDepth), ...contextualRemappings.toSorted(byContextDepth)]) {
    if (!explicit.has(relKey(relativePreservingBoundary(c, root)))) all.push(c)
  }
  for (const [name, path] of [...closest].toSorted(([a], [b]) => cmpStr(a, b))) all.push({ context: null, name, path })
  return all.intoInner()
}

// The lib dirs `forge build` uses for the Foundry project at `baseDir`, `{ libs, profiled }`: the
// selected profile's `libs` (`profiled` when that profile is the file's), else the detected ones;
// also those, warned, when forge would reject the foundry.toml (with a pinned mapping file,
// nothing else is read from it).
export function foundryLibs(baseDir, { env = process.env } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  try {
    const config = loadFoundryConfig(root, profile)
    return { libs: config.libs, profiled: profileApplies(config.profiles, profile) }
  } catch (err) {
    console.warn(`[loader.solidity] Using the default lib dirs: ${err.message}`)
    return { libs: detectLibs(root), profiled: false }
  }
}

// The Foundry project at `baseDir`: what `forge build` would use. `remappings` are
// `{ context, prefix, target }` relative to the root, in forge's order; `libs` the lib dirs;
// `files` the config files read (project-relative, when inside the project); `envUsed` the
// environment variables that shaped them; `ownership` its files' owners (see solidityOwnership),
// which also confines what a dependency's config reads. `env` supplies FOUNDRY_PROFILE and
// FOUNDRY_REMAPPINGS / DAPP_REMAPPINGS.
export function foundryProject(baseDir, { env = process.env } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  const config = loadFoundryConfig(root, profile)
  const profiled = profileApplies(config.profiles, profile)
  const ownership = projectOwnership(baseDir, config.libs, { soldeer: true })
  if (config.remappings === null) throw new Error(`${rustJoin(root, FOUNDRY_TOML)}: invalid remapping in \`remappings\``)
  const files = new Set(config.files)

  const envName = env.DAPP_REMAPPINGS !== undefined ? 'DAPP_REMAPPINGS' : env.FOUNDRY_REMAPPINGS !== undefined ? 'FOUNDRY_REMAPPINGS' : null
  const envRemappings = envName === null ? [] : parseRemappingLines(env[envName], envName)
  const txt = readText(host, rustJoin(root, REMAPPINGS_TXT))
  if (txt !== null) files.add(rustJoin(root, REMAPPINGS_TXT))
  const userRemappings = [...envRemappings, ...(txt === null ? [] : parseRemappingLines(txt, REMAPPINGS_TXT)), ...config.remappings]

  const provided = providerRemappings(root, { userRemappings, libs: config.libs, autoDetect: config.autoDetect, profile, files, ownership })
    .map((r) => displayRelative(relativePreservingBoundary(r, root)))

  // `forge build` re-reads them as config remappings, dropping aliases of its own input dirs.
  const build = new Remappings([], [config.src, config.test, config.script].map((p) => `${p}/`))
  for (const s of provided) {
    const r = parseRemapping(s)
    if (r) build.push(r)
  }
  // ...and hands them to solc as the config's `RelativeRemapping`s: slash-terminated.
  const remappings = build.intoInner()
    .map((r) => parseRemapping(displayRelative(relativePreservingBoundary(r, root))))
    .filter(Boolean)
    .map(toSolcRemapping)

  const relFiles = [...files].map((f) => stripPrefix(f, root)).filter((f) => f !== null && f !== '')
  const envUsed = [...(profiled ? [`FOUNDRY_PROFILE=${env.FOUNDRY_PROFILE}`] : []), ...(envName === null ? [] : [envName])]
  return { remappings, libs: config.libs, files: relFiles, envUsed, ownership }
}
