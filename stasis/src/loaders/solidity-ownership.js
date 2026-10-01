// Who owns each file of a Solidity project -- the project or one of its dependencies -- decided by
// where the file really is, for the import resolution (solidity.js), forge's config discovery
// (foundry.js) and the bundler's --manifests. Dependencies are untrusted input: a link one plants
// out of itself is never followed.

import { isUtf8 } from 'node:buffer'
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

import { utf8toString } from '@exodus/bytes/utf8.js'
import { LockfileError, parseGitmodules } from '@preventive/lockfile/foundry.js'
import { NO_ENTRY, readRegularFileOrNull } from '@exodus/stasis-core/bundle-util'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { isDir } from '../resolve-typescript.js'

// `/`-separated, as the loader's paths are: only Windows' separator is converted (on POSIX a `\\` is
// part of a name, and must not read as a directory boundary).
const toSlashes = (p) => (sep === '\\' ? p.replaceAll('\\', '/') : p)

// --- Reading --------------------------------------------------------------------------------

// `p`'s real path as the OS resolves it (realpath(3): the filesystem's own spelling), or null.
export function realpathOrNull(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

// A path relative to a dir (slashes) that stays inside it.
const inRoot = (rel) => rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)

// `abs`, a file the resolution read, relative to the project `root` (slashes): as spelled when that
// lies inside it with no `..` to resolve (a linked lib's files keep the lib's path), else by real
// paths -- where the read went (an absolute or `/proc/self/cwd` lib; a `..` after a symlink) --
// `../` when outside the project. One whose real path the OS can't give (past PATH_MAX) is never
// normalized, which could name another file: it keeps the path it was read by, `..` and all, from
// the root however that's spelled (as given or by its real path), for solidityOwnership to refuse,
// or else stays absolute, a name --manifests refuses as unresolvable.
export function projectRelative(root, abs) {
  const rel = toSlashes(relative(root, abs))
  if (inRoot(rel) && !toSlashes(abs).split('/').includes('..')) return rel
  const real = realpathOrNull(abs)
  const realRoot = realpathOrNull(root)
  if (real !== null) return toSlashes(relative(realRoot ?? root, real))
  return below(resolve(root), abs) ?? (realRoot === null ? null : below(realRoot, abs)) ?? toSlashes(abs)
}

// `abs` from `dir`, component by component as spelled (empty and `.` ones dropped, `..` kept), or
// null when it doesn't start with `dir`'s components.
function below(dir, abs) {
  const parts = (p) => toSlashes(p).split('/').filter((c) => c !== '' && c !== '.')
  const d = parts(dir)
  const a = parts(abs)
  return d.length < a.length && d.every((c, i) => a[i] === c) ? a.slice(d.length).join('/') : null
}

// realpath(3) of `p`: `{ real }`, or `{ real: null, missing }`, `missing` only when nothing is
// there at all. The OS may fail to resolve what is there -- a real path past PATH_MAX, a loop, a
// link whose end it can't name (`/proc/self/fd/0` on a pipe), a dir it may not search -- and a
// read may still get through.
function osRealpath(p) {
  try {
    return { real: realpathSync.native(p), missing: false }
  } catch (err) {
    return { real: null, missing: NO_ENTRY.has(err.code) && !lexists(p) }
  }
}

function lexists(p) {
  try {
    lstatSync(p)
    return true
  } catch (err) {
    if (NO_ENTRY.has(err.code)) return false
    throw err
  }
}

// `bytes` as UTF-8 text, a byte-order mark kept. Bytes that aren't UTF-8 throw, naming them
// `label`, rather than read with U+FFFD in their place: forge, solc and git refuse such a file, and
// the text bundled or read must be the file's own.
export function decodeUtf8(bytes, label) {
  try {
    return utf8toString(bytes)
  } catch (err) {
    throw new Error(`${label}: not valid UTF-8`, { cause: err })
  }
}

// A config file's text (decodeUtf8), or null when there's no file (readRegularFileOrNull: a regular
// file only). Errors name it `label`.
export function readUtf8OrNull(file, label) {
  const buf = readRegularFileOrNull(file, label)
  return buf === null ? null : decodeUtf8(buf, label)
}

// --- .gitmodules ------------------------------------------------------------------------------

// The submodules of the project at `baseDir`, `{ path, url, branch }` (`url` and `branch` when set),
// from its `.gitmodules` as @preventive/lockfile reads it (as git does). A url is taken as written
// (`checkUrls: false`): relative to the superproject's remote, a path or none, as it only names a
// GitHub submodule's bucket. A file the library refuses -- something git reads two ways, or that it
// doesn't check (`update = none`, `active`, a `[core]` section) -- never fails the bundle: it's
// warned about and read submodule by submodule (gitmodulesLeniently).
export function readGitmodules(baseDir) {
  const text = readUtf8OrNull(join(baseDir, '.gitmodules'), '.gitmodules')
  if (text === null) return []
  try {
    return Object.values(parseGitmodules(text, { checkUrls: false }))
  } catch (err) {
    if (!(err instanceof LockfileError)) throw err
    const { submodules, notes } = gitmodulesLeniently(text)
    if (!notes.some((note) => note.startsWith(`${err.message};`))) notes.unshift(`${err.message}; reading it submodule by submodule`)
    for (const note of notes) console.warn(`[loader.solidity] .gitmodules: ${note}`)
    return submodules
  }
}

// The keys a submodule is read for; past `path`, they're dropped in this order to read the rest.
const SUBMODULE_KEYS = new Set(['path', 'url', 'branch'])
const DROPPABLE = ['branch', 'url']

// `.gitmodules` text the library refused as a whole, read a submodule section at a time (`[submodule
// "name"]`, or `[submodule.name]` with the name lowercased, as git reads it): its first `path`,
// `url` and `branch` (the first, as git's submodule commands read it; the sections of one name
// merged), each submodule then read by the library alone. One that still doesn't read loses its
// branch, then its url; one whose path doesn't read fails closed: its directory, when the path
// names one inside the repository (`./lib/x`, `lib/x/`), is still a dependency, just unnamed, and
// else the submodule is skipped. `notes` say what was dropped.
function gitmodulesLeniently(text) {
  const sections = new Map() // the name, as written in the header -> Map<key, its lines>
  const notes = []
  let keys = null // the current section's, when it's a submodule's
  let lines = null // the kept key's lines, while it runs on (a line ending in `\`)
  let continued = false
  for (let line of text.split(/\r?\n/u)) {
    const runsOn = continued
    continued = /(?:^|[^\\])(?:\\\\)*\\$/u.test(line)
    if (runsOn) {
      lines?.push(line)
      continue
    }
    lines = null
    const header = /^\s*\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/u.exec(line)
    if (header) {
      const section = header[1].toLowerCase()
      let name = section === 'submodule' ? header[2] : undefined
      if (name === undefined && section.startsWith('submodule.')) {
        name = section.slice('submodule.'.length)
        notes.push(`[${header[1]}], a section git reads as [submodule "${name}"]; reading it as that`)
      }
      keys = name === undefined ? null : (sections.get(name) ?? sections.set(name, new Map()).get(name))
      line = line.slice(header[0].length) // a key may follow on the line
    }
    const key = keys && /^\s*([A-Za-z][\w-]*)\s*(?:=|$)/u.exec(line)?.[1].toLowerCase()
    if (SUBMODULE_KEYS.has(key) && !keys.has(key)) keys.set(key, (lines = [line]))
  }
  const submodules = []
  for (const [name, kept] of sections) {
    const read = () => Object.values(parseGitmodules([`[submodule "${name}"]`, ...[...kept.values()].flat(), ''].join('\n'), { checkUrls: false }))
    let first = null
    const dropped = []
    for (;;) {
      try {
        submodules.push(...read())
        if (first !== null) notes.push(`${first.message}; ignoring its ${dropped.join(' and ')}`)
        break
      } catch (err) {
        if (!(err instanceof LockfileError)) throw err
        first ??= err
        const next = DROPPABLE.find((key) => kept.has(key))
        if (next !== undefined) {
          kept.delete(next)
          dropped.push(next)
          continue
        }
        const path = kept.has('path') ? normalSubmodulePath(kept.get('path')) : null
        if (path === null) {
          notes.push(`${first.message}; skipping the submodule`)
        } else {
          submodules.push({ path, url: undefined, branch: undefined })
          notes.push(`${first.message}; still taking ${path} as a dependency, unnamed`)
        }
        break
      }
    }
  }
  return { submodules, notes }
}

// A `path = ...` key's lines -> the directory it names, normalized, when that lies inside the
// repository (else null): `./lib/x` and `lib/x/` are lib/x.
function normalSubmodulePath(lines) {
  const raw = lines.map((l, i) => (i < lines.length - 1 ? l.slice(0, -1) : l)).join('') // a `\` runs on
  const eq = raw.indexOf('=')
  if (eq === -1) return null
  const path = posix.normalize(gitConfigValue(raw.slice(eq + 1))).replace(/\/+$/u, '')
  return path !== '' && path !== '.' && inRoot(path) ? path : null
}

const GIT_ESCAPES = { n: '\n', t: '\t', b: '\b' }

// A git-config value as git reads it: `"` quotes (dropped), `\` escapes, a `#`/`;` comment outside
// quotes, and whitespace trimmed at both ends outside quotes.
function gitConfigValue(raw) {
  let out = ''
  let held = '' // unquoted whitespace, kept only if more value follows
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[++i] ?? ''
      out += held + (GIT_ESCAPES[next] ?? next)
      held = ''
    } else if (ch === '"') {
      quoted = !quoted
    } else if (!quoted && (ch === '#' || ch === ';')) {
      break
    } else if (!quoted && (ch === ' ' || ch === '\t')) {
      if (out !== '') held += ch
    } else {
      out += held + ch
      held = ''
    }
  }
  return out
}

// --- Ownership --------------------------------------------------------------------------------

const readdirOrEmpty = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const NOTHING = { abs: null, escape: null }
// A link target's separators, as the OS reads them (a `\\` is part of a name on POSIX).
const TARGET_SEPARATORS = sep === '\\' ? /[\\/]/u : /\//u

// Who owns each project-relative path, decided from how it resolves on disk. The dependencies are
// every `node_modules/<pkg>` (`@scope/<pkg>`), each entry of the `dirs` (forge's libs, Soldeer's
// `dependencies/`; a linked entry is the dependency where it points, as a symlinked
// `lib/forge-std`), and the `packages` (git submodules). `assert(path)` throws for a path `of`
// refuses; `of(path)` gives `{ real, outside, dependency, escape }`:
// - `real`: the real path, spelled as the filesystem spells it (project-relative; null when
//   nothing is there), `outside` when it's out of the root;
// - `dependency`: the real path lies in a dependency, however the path got there (a project's
//   `src/vendor -> ../lib/dep/src` holds the dependency's code);
// - `escape`: `{ link, root, why }` (and `reason`, saying so) when the path may not be read: it
//   crosses a symlink that no one trusted placed -- one planted inside the dependency `root` that
//   leads out of it to anything but another dependency (`lib/evil/src/Evil.sol -> ../../../.env`),
//   or one outside the project (`root` null) that leads back into it (a dependency linked from
//   elsewhere: `lib/evil -> ../../shared/evil` holding `Evil.sol -> ../../proj/.env`) -- or
//   (`why: 'unresolved'`) the walk below can't vouch for it: it resolves the path link by link, and
//   where that doesn't land where the OS's realpath does (a link target it can't read as the OS
//   does, one that isn't UTF-8), or the OS can't resolve it at all (a real path past PATH_MAX), the
//   path is refused rather than trusted. `real` null with no `escape` means nothing is there. A
//   link the project placed (a workspace package in node_modules, a linked `lib/` entry) may lead
//   anywhere in the root, and so may one on the path the project was named by (a symlinked
//   checkout, macOS's `/tmp`).
export function solidityOwnership(baseDir, { dirs = [], packages = [] } = {}) {
  const realBase = realpathSync.native(baseDir)
  const named = resolve(baseDir)
  const onNamedPath = (abs) => named === abs || named.startsWith(abs.endsWith(sep) ? abs : `${abs}${sep}`)
  const toRel = (abs) => toSlashes(relative(realBase, abs)) || '.'
  const inside = (rel) => rel !== '.' && inRoot(rel)
  const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`)
  const clean = (d) => posix.normalize(toSlashes(d)).replace(/\/+$/u, '')

  // Dirs whose entries are dependencies, and dependency dirs themselves; each by its real path too.
  const holders = new Set()
  const roots = new Set()
  const addReal = (set, rel) => {
    const real = realpathOrNull(join(baseDir, rel))
    if (real !== null && inside(toRel(real))) set.add(toRel(real))
  }
  // A dir as the project names it: relative to the root, or (an absolute lib) by its real path.
  const projectDir = (d) => {
    if (!isAbsolute(d)) return clean(d)
    const real = realpathOrNull(d)
    return real === null ? null : toRel(real)
  }
  for (const d of dirs.map(projectDir).filter((rel) => rel !== null && inside(rel))) {
    if (posix.basename(d) === 'node_modules') continue // a package's own rule, below
    holders.add(d)
    addReal(holders, d)
    for (const e of readdirOrEmpty(join(baseDir, d))) if (e.isSymbolicLink() && isDir(join(baseDir, d, e.name))) addReal(roots, `${d}/${e.name}`)
  }
  for (const p of packages.map(clean).filter(inside)) {
    roots.add(p)
    addReal(roots, p)
  }
  const dependencyDirs = [...holders, ...roots]
  const inDependency = (rel) => inside(rel) && (hasNodeModulesSegment(rel) || dependencyDirs.some((d) => under(rel, d)))
  // The innermost dependency holding `rel`, a real path.
  const rootOf = (rel) => {
    if (!inside(rel)) return null
    const parts = rel.split('/')
    let best = null
    const take = (r) => {
      if (best === null || r.length > best.length) best = r
    }
    for (let i = 0; i < parts.length; i++) {
      const end = i + (parts[i + 1]?.startsWith('@') ? 3 : 2)
      if (parts[i] === 'node_modules' && end <= parts.length) take(parts.slice(0, end).join('/'))
    }
    for (const d of holders) if (rel.startsWith(`${d}/`)) take(`${d}/${rel.slice(d.length + 1).split('/')[0]}`)
    for (const r of roots) if (under(rel, r)) take(r)
    return best
  }

  // Resolve `parts` from the real dir `start` as realpath does, checking each symlink crossed
  // (and those its target crosses): `{ abs, escape }`, `abs` null when nothing is there, and
  // spelled as given past the last link. A link's dir and target take the filesystem's spelling (a
  // case-insensitive one finds `lib` for `LIB`) before their owners are judged.
  const walk = (start, parts, depth) => {
    let cur = start
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        cur = parse(cur).root === cur ? cur : join(cur, '..')
        continue
      }
      const next = join(cur, part)
      let target
      try {
        if (!lstatSync(next).isSymbolicLink()) {
          cur = next
          continue
        }
        const bytes = readlinkSync(next, { encoding: 'buffer' })
        if (!isUtf8(bytes)) return NOTHING // not a name a string path can spell: unresolved
        target = bytes.toString('utf8')
      } catch {
        return NOTHING
      }
      if (depth >= 40) return NOTHING // ELOOP
      const r = walk(isAbsolute(target) ? parse(target).root : cur, target.split(TARGET_SEPARATORS), depth + 1)
      if (r.abs === null || r.escape !== null) return r
      const dir = realpathOrNull(cur) ?? cur
      const abs = realpathOrNull(r.abs)
      if (abs === null) return NOTHING
      const at = toRel(join(dir, part))
      const to = toRel(abs)
      if (inside(at)) {
        const root = rootOf(toRel(dir))
        if (root !== null && !under(to, root) && !inDependency(to)) return { abs, escape: { link: at, root } }
      } else if (inRoot(to) && !onNamedPath(next)) {
        return { abs, escape: { link: at, root: null } }
      }
      cur = abs
    }
    return { abs: cur, escape: null }
  }

  const owners = new Map()
  const of = (rel) => {
    let owner = owners.get(rel)
    if (owner === undefined) {
      // As given, not normalized: the OS resolves a `..` after a link from where the link leads.
      const path = rel === '' ? realBase : `${realBase}${sep}${rel}`
      let { abs, escape } = walk(realBase, rel.split('/'), 0)
      if (escape === null) {
        // The OS's answer is the one a read gets: the walk must agree with it, or the path is
        // refused, as it is when the OS can't resolve it at all, though a read may still get through.
        // (Past its last link the walk's path is spelled as given; with none, it's `path` itself.)
        const { real: os, missing } = osRealpath(path)
        const walked = abs === null ? null : abs === path ? os : realpathOrNull(abs)
        if (walked !== os || (os === null && !missing)) escape = { link: rel, root: null, why: 'unresolved' }
        abs = os
      }
      const real = abs === null ? null : toRel(abs)
      owner = {
        real,
        outside: real !== null && !inRoot(real),
        dependency: real !== null && inDependency(real),
        escape,
        reason: escape && escapeReason(rel, escape),
      }
      owners.set(rel, owner)
    }
    return owner
  }
  // Throws, saying why, for a path `of` refuses; `what` names it (`'entry '`).
  const assert = (rel, what = '') => {
    const { reason } = of(rel)
    if (reason) throw new Error(`Refusing ${what}${rel}: ${reason}`)
  }
  return { of, assert }
}

// The ownership of the project at `baseDir` given its lib dirs (`soldeer`: forge's `dependencies/`
// holds dependencies too), with its git submodules, which it keeps as `submodules` (readGitmodules).
export function projectOwnership(baseDir, libs, { soldeer = false } = {}) {
  const submodules = readGitmodules(baseDir)
  const dirs = [...libs, ...(soldeer ? ['dependencies'] : [])]
  return { ...solidityOwnership(baseDir, { dirs, packages: submodules.map((s) => s.path) }), submodules }
}

// Why a path is refused (see solidityOwnership).
function escapeReason(path, { link, root, why }) {
  if (why === 'unresolved') return `${path} crosses a link stasis can't follow the way the filesystem does`
  const what = root === null ? 'a link from outside the project root back into it' : `a link out of the dependency ${root}`
  return link === path ? `${path} is ${what}` : `it resolves to ${path} through ${link}, ${what}`
}
