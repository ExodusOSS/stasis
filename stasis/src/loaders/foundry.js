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

import { diskHost } from '@exodus/stasis-core/host'
import { toPosix } from '@exodus/stasis-core/util'
import { isDir } from '../resolve-typescript.js'
import { projectOwnership, projectRelative, readUtf8OrNull, realpathOrNull } from './solidity-ownership.js'
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
  const real = realpathOrNull(p, host)
  return real === null ? null : toPosix(real)
}

// How messages name a file of the project at `root` (absolute POSIX, read through `host`): from the
// root, by its lexical or its canonical path, else as given.
export function shownFrom(root, host = diskHost, canonicalRoot = canonicalize(root, host) ?? root) {
  return (abs) => stripPrefix(abs, root) || stripPrefix(abs, canonicalRoot) || abs
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

// Rust's `str::trim`: Unicode White_Space only, so a byte-order mark (U+FEFF, which JS's `trim`
// takes) stays, as it does for forge.
const rustTrim = (s) => s.replaceAll(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

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
  if (rustTrim(name) === '' || (!emptyPath && rustTrim(path) === '')) return null
  if (context !== null && rustTrim(context) === '') context = null
  return { context, name, path }
}

// A remappings.txt / env var body: one remapping per non-blank (trimmed) line. A line that isn't
// one throws, naming `label` (the file or variable) and the line, as forge and solc refuse the
// file. `emptyPath`: see parseRemapping.
export function parseRemappingLines(text, { label = 'remappings', emptyPath = false } = {}) {
  const out = []
  text.split('\n').forEach((raw, i) => {
    const line = rustTrim(raw)
    if (line === '') return
    const r = parseRemapping(line, { emptyPath })
    if (r === null) throw new Error(`${label}:${i + 1}: invalid remapping ${JSON.stringify(line)}`)
    out.push(r)
  })
  return out
}

// A foundry.toml's `remappings` value, parsed. One forge rejects -- not an array of strings, or an
// entry that isn't `[context:]name=path` -- throws, naming `file` when given.
function configRemappings(value, file) {
  const where = `${file === null ? '' : `${file}: `}\`remappings\``
  if (!Array.isArray(value)) throw new Error(`${where} is not an array of strings`)
  return value.map((entry) => {
    const r = typeof entry === 'string' ? parseRemapping(entry) : null
    if (r === null) throw new Error(`${where}: invalid remapping ${typeof entry === 'string' ? JSON.stringify(entry) : String(entry)}`)
    return r
  })
}

// A config forge refuses for its settings (a missing or nested `extends`, colliding keys) or that a
// dependency may not read (a link out of it): forge skips such a dependency's config, and so does
// loadNestedConfig. Anything else wrong with a config -- text that isn't TOML, an invalid
// remapping -- is another error, and fatal.
class ConfigRefused extends Error {}

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

// forge's `Extends`: a path, or `{ path, strategy? }`.
const EXTEND_STRATEGIES = new Set(['extend-arrays', 'replace-arrays', 'no-collision'])
const isExtends = (v) => typeof v === 'string'
  || (isTomlTable(v) && typeof v.path === 'string' && (v.strategy === undefined || EXTEND_STRATEGIES.has(v.strategy)))

// A foundry.toml's profiles, with the selected profile's `extends` base merged in (forge's
// `TomlFileProvider`). `files` lists what was read; `topLevel` is the file's own (see
// parseFoundryToml). Throws where forge refuses the config, and where `refused` (a dependency's
// config: see findNestedFoundryRemappings) gives a reason not to read the file or its base: a
// dependency's config may not read the project's files. Messages name files `show(file)`.
function readFoundryProfiles(file, profile, { refused = () => null, show, host }) {
  const name = show(file)
  const refusal = refused(file)
  if (refusal) throw new ConfigRefused(`${name}: refusing to read it: ${refusal}`)
  const text = readUtf8OrNull(file, name, host)
  if (text === null) return { profiles: new Map(), topLevel: new Map(), files: [] }
  let { profiles, topLevel } = parseFoundryToml(text, name)
  const files = [file]
  const ext = profiles.get(profile)?.get('extends')
  if (ext !== undefined) {
    if (!isExtends(ext)) throw new Error(`${name}: \`extends\` must be a path, or a table with a \`path\` and an optional \`strategy\` (${[...EXTEND_STRATEGIES].join(', ')})`)
    const { path: extPath, strategy = 'extend-arrays' } = typeof ext === 'string' ? { path: ext } : ext
    // Joined as forge joins it, not normalized: the read resolves a `..` after a symlink the way
    // forge's does (from where the link leads), not textually.
    const baseFile = rustJoin(posix.dirname(file), extPath)
    const baseRefusal = refused(baseFile)
    if (baseRefusal) throw new ConfigRefused(`${name}: refusing to extend ${extPath}: ${baseRefusal}`)
    const baseName = show(baseFile)
    const baseText = readUtf8OrNull(baseFile, baseName, host)
    if (baseText === null) throw new ConfigRefused(`${name}: the inherited config file does not exist: ${extPath}`)
    const base = parseFoundryToml(baseText, baseName).profiles
    if (base.get(profile)?.has('extends')) {
      throw new ConfigRefused(`${name}: nested inheritance is not allowed (${extPath} has an 'extends' field in profile '${profile}')`)
    }
    if (strategy === 'no-collision') {
      const collisions = [...(profiles.get(profile)?.keys() ?? [])].filter((k) => k !== 'extends' && base.get(profile)?.has(k))
      if (collisions.length > 0) throw new ConfigRefused(`${name}: key collision in profile '${profile}' when extending ${extPath}: ${collisions.join(', ')}`)
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
// it), else the file's top-level `remappings` (a mapping file written for stasis), as written; an
// invalid one throws (configRemappings, naming `file`).
function profileRemappings({ profiles, topLevel }, profile, file = null) {
  const value = selectProfile(profiles, profile).get('remappings') ?? topLevel.get('remappings')
  return value === undefined ? [] : configRemappings(value, file)
}

// A foundry.toml text's own remappings for `profile` (see profileRemappings).
export function foundryTomlRemappings(text, profile = 'default') {
  return profileRemappings(parseFoundryToml(text), profile)
}

// The same for a foundry.toml file, with its `extends` base: what `--mapping=foundry.toml` takes.
// `files` lists what was read; `profiled` whether the selected `profile` is one of the file's.
// Messages name files `show(file)`.
export function readFoundryTomlRemappings(file, profile, { show, host = diskHost }) {
  const abs = toPosix(resolve(file))
  const read = readFoundryProfiles(abs, profile, { show, host })
  return { remappings: profileRemappings(read, profile, show(abs)), files: read.files, profiled: hasProfile(read.profiles, profile) }
}

// Whether the selected `profile` is one of `profiles` (not the default, which always applies).
const hasProfile = (profiles, profile) => profile !== 'default' && profiles.has(profile)

// hasProfile, for the root foundry.toml: one that isn't there is warned about (forge uses
// `[profile.default]` for it).
function profileApplies(profiles, profile) {
  if (profile !== 'default' && !profiles.has(profile)) {
    console.warn(`[loader.solidity] FOUNDRY_PROFILE=${profile} is not a profile in foundry.toml; using [profile.default]`)
  }
  return hasProfile(profiles, profile)
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

// The selected profile's settings for a Foundry project at `root` (absolute POSIX), defaults
// filled in the way forge fills them. `remappings` are the profile's own, unnormalized; an invalid
// one throws (configRemappings). `refused`, `show` (from the root by default), `host`: see
// readFoundryProfiles.
function loadFoundryConfig(root, profile, { refused, host, show = shownFrom(root, host) }) {
  const file = rustJoin(root, FOUNDRY_TOML)
  const name = show(file)
  const { profiles, files } = readFoundryProfiles(file, profile, { refused, show, host })
  const dict = selectProfile(profiles, profile)
  // A setting of the wrong type throws, as forge refuses the config: no quiet default.
  const setting = (key, ok, what) => {
    const value = dict.get(key)
    if (value !== undefined && !ok(value)) throw new Error(`${name}: \`${key}\` must be ${what}`)
    return value
  }
  const isString = (v) => typeof v === 'string'
  return {
    profiles,
    files,
    src: setting('src', isString, 'a string') ?? findSourceDir(root, host),
    test: setting('test', isString, 'a string') ?? 'test',
    script: setting('script', isString, 'a string') ?? 'script',
    libs: setting('libs', (v) => Array.isArray(v) && v.every(isString), 'an array of strings') ?? detectLibs(root, host),
    remappings: dict.has('remappings') ? configRemappings(dict.get('remappings'), name) : [],
    autoDetect: setting('auto_detect_remappings', (v) => typeof v === 'boolean', 'a boolean') !== false,
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
// or when `refused` refuses it or its `extends` base (warned: ConfigRefused); a remappings.txt it
// refuses is skipped (warned). One that isn't TOML or holds an invalid remapping throws: forge
// refuses a bad remappings.txt line too, and skips a foundry.toml it can't read, which here is an
// error rather than a config quietly left out. `refused`, `show`: see readFoundryProfiles.
function loadNestedConfig(canonical, profile, { refused, show, host }) {
  let config
  try {
    config = loadFoundryConfig(canonical, profile, { refused, show, host })
  } catch (err) {
    if (!(err instanceof ConfigRefused)) throw err
    console.warn(`[loader.solidity] Skipping a dependency's config: ${err.message}`)
    return null
  }
  const txt = rustJoin(canonical, REMAPPINGS_TXT)
  const txtName = show(txt)
  const refusal = refused(txt) // (null when nothing is there)
  if (refusal) console.warn(`[loader.solidity] Skipping a dependency's ${txtName}: ${refusal}`)
  const text = refusal ? null : readUtf8OrNull(txt, txtName, host)
  return {
    src: config.src,
    libs: config.libs,
    files: [...config.files, ...(text === null ? [] : [txt])],
    // `sanitized()` roots them, then `Remapping::from` makes the path absolute and slash-terminated.
    remappings: config.remappings.map((r) => fromRelative(relativePreservingBoundary(fromRelative({ ...r, path: { parent: null, path: r.path } }), canonical))),
    fileRemappings: text === null ? [] : parseRemappingLines(text, { label: txtName }),
  }
}

// `find_nested_foundry_remappings`: `[lexicalLibPath, remapping, isPackageEntry]` for every
// dependency (transitively, through each one's own libs) that is a Foundry project. A dependency's
// config reads only its own files and other dependencies' (by real path: `ownership`, see
// solidityOwnership), as forge would find them from its lexical path.
function findNestedFoundryRemappings(root, libPaths, profile, files, ownership, host) {
  const canonicalRoot = canonicalize(root, host) ?? root
  const shown = shownFrom(root, host, canonicalRoot)
  // A dependency's file (a path from its canonical dir) under its lexical path: where the bundle
  // sees it, and how messages name it.
  const lexical = (entry, file) => rustJoin(entry.path, stripPrefix(file, entry.canonical) ?? file)
  // Why the config of the dependency at `entry` may not read `file` (a path from its canonical
  // dir), or null: judged by the path from the root, the lexical one or else the canonical one (an
  // absolute lib, `/proc/self/cwd/...`). It may read its own files and other dependencies'; a
  // dependency outside the root reads nothing, and one a dependency's `libs` named must be a
  // dependency itself (not the project's own dir passed off as one). Nothing there (the OS agrees:
  // solidityOwnership) is left for the read to find missing.
  const refused = (entry) => (file) => {
    const dir = stripPrefix(entry.path, root) ?? stripPrefix(entry.canonical, canonicalRoot)
    if (dir === null) return 'the dependency lies outside the project root'
    if (entry.viaDependency && !ownership.of(dir).dependency) return `${dir}, which a dependency's \`libs\` names, isn't a dependency`
    // `file` as joined under the dependency's dir (an `extends` path unnormalized, for the walk to
    // resolve as the read does); one not under it (an absolute path elsewhere) lies outside it.
    if (!file.startsWith(`${entry.canonical}/`)) return 'it lies outside the dependency'
    const o = ownership.of(`${dir}/${file.slice(entry.canonical.length + 1)}`)
    if (o.reason) return o.reason
    if (o.outside) return `it resolves to ${o.real}, outside the project root`
    if (o.real === null || o.dependency || pathStartsWith(rustJoin(canonicalRoot, o.real), entry.canonical)) return null
    return `it resolves to the project's own ${o.real}`
  }
  const show = (entry) => (file) => shown(lexical(entry, file))
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
      const config = loadNestedConfig(entry.canonical, profile, { refused: refused(entry), show: show(entry), host })
      configs.set(entry.canonical, config)
      for (const f of config?.files ?? []) files.add(lexical(entry, f))
    }
    const config = configs.get(entry.canonical)
    if (!config) continue
    for (const r of config.remappings) out.push([entry.path, rebaseNested(r, entry.canonical, entry.path), false])
    for (const r of config.fileRemappings) out.push([entry.path, fromRelative(toRelative(r, entry.path)), false])
    if (!entry.isSymlink && !seen.has(entry.canonical)) {
      seen.add(entry.canonical)
      for (const lib of config.libs) {
        for (const e of foundryTomlDirEntries(rustJoin(entry.path, lib), host)) if (!e.isSymlink) addPending({ ...e, viaDependency: true })
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
function providerRemappings(root, { userRemappings, libs, autoDetect, profile, files, ownership, host }) {
  const authoritativeUser = userRemappings.map((r) => (r.context === null ? r : { ...r, context: rustJoin(root, r.context) }))
  const all = new Remappings([...userRemappings])
  if (!autoDetect) return all.intoInner()

  const nested = findNestedFoundryRemappings(root, libs, profile, files, ownership, host)
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

// The lib dirs `forge build` uses for the Foundry project at `baseDir`, `{ libs, profiled, files }`:
// the selected profile's `libs` (`profiled` when that profile is the file's), else the detected
// ones; also those, warned, when forge would reject the foundry.toml's settings (ConfigRefused; with
// a pinned mapping file, nothing else is read from it). `files` lists the config files read (the
// foundry.toml, its `extends` base). A foundry.toml that isn't TOML or holds an invalid remapping
// throws.
export function foundryLibs(baseDir, { env = process.env, host = diskHost } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  try {
    const config = loadFoundryConfig(root, profile, { host })
    return { libs: config.libs, profiled: profileApplies(config.profiles, profile), files: config.files }
  } catch (err) {
    if (!(err instanceof ConfigRefused)) throw err
    console.warn(`[loader.solidity] Using the default lib dirs: ${err.message}`)
    return { libs: detectLibs(root, host), profiled: false, files: [rustJoin(root, FOUNDRY_TOML)] }
  }
}

// The Foundry project at `baseDir`: what `forge build` would use. `remappings` are
// `{ context, prefix, target }` relative to the root, in forge's order; `libs` the lib dirs;
// `files` the config files read (project-relative, `../` when outside the project); `envUsed` the
// environment variables that shaped them; `ownership` its files' owners (see solidityOwnership),
// which also confines what a dependency's config reads. `env` supplies FOUNDRY_PROFILE and
// FOUNDRY_REMAPPINGS / DAPP_REMAPPINGS.
export function foundryProject(baseDir, { env = process.env, host = diskHost } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  const config = loadFoundryConfig(root, profile, { host })
  const profiled = profileApplies(config.profiles, profile)
  const ownership = projectOwnership(baseDir, config.libs, { soldeer: true, host })
  const files = new Set(config.files)

  const envName = env.DAPP_REMAPPINGS !== undefined ? 'DAPP_REMAPPINGS' : env.FOUNDRY_REMAPPINGS !== undefined ? 'FOUNDRY_REMAPPINGS' : null
  const envRemappings = envName === null ? [] : parseRemappingLines(env[envName], { label: envName })
  const txtFile = rustJoin(root, REMAPPINGS_TXT)
  const txt = readUtf8OrNull(txtFile, REMAPPINGS_TXT, host)
  if (txt !== null) files.add(txtFile)
  const userRemappings = [...envRemappings, ...(txt === null ? [] : parseRemappingLines(txt, { label: REMAPPINGS_TXT })), ...config.remappings]

  const provided = providerRemappings(root, { userRemappings, libs: config.libs, autoDetect: config.autoDetect, profile, files, ownership, host })
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

  // One read from outside the root (an `extends = "../base.toml"`) stays `../`, for --manifests to
  // refuse (it can't be carried).
  const relFiles = [...files].map((f) => projectRelative(root, f, host))
  const envUsed = [...(profiled ? [`FOUNDRY_PROFILE=${env.FOUNDRY_PROFILE}`] : []), ...(envName === null ? [] : [envName])]
  return { remappings, libs: config.libs, files: relFiles, envUsed, ownership }
}
