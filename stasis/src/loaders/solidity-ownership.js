// Who owns each file of a Solidity project -- the project or one of its dependencies -- decided by
// where the file really is, for the import resolution (solidity.js), forge's config discovery
// (foundry.js) and the bundler's --manifests. Dependencies are untrusted input: a link one plants
// out of itself is never followed.

import { isUtf8 } from 'node:buffer'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

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

// A config file's text, or null when there's no file. One that isn't UTF-8 throws: forge and git
// refuse it, and a text read with U+FFFD in it isn't the one they read. A byte-order mark stays.
export function readUtf8OrNull(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return null
    throw err
  }
  if (!isUtf8(buf)) throw new Error(`${file}: not valid UTF-8`)
  return buf.toString('utf8')
}

// --- .gitmodules ------------------------------------------------------------------------------

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

// `.gitmodules` text -> its submodules, `{ name, path, url, branch }` (those set), as git reads the
// file: keys case-insensitive, values unquoted and unescaped, a line ending in `\` continued, a
// key after a section header on its line (`[submodule "x"] path = lib/x`), and a submodule's
// sections merged by name.
export function parseGitmodules(text) {
  const byName = new Map()
  let cur = null
  const lines = text.split(/\r?\n/u)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    while (/(?:^|[^\\])(?:\\\\)*\\$/u.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]
    const header = /^\s*\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/u.exec(line)
    if (header) {
      const section = header[1].toLowerCase()
      let name = null
      if (section === 'submodule' && header[2] !== undefined) name = header[2].replaceAll(/\\(.)/gu, '$1')
      else if (section.startsWith('submodule.')) name = header[1].slice('submodule.'.length)
      cur = name === null ? null : (byName.get(name) ?? byName.set(name, { name }).get(name))
      line = line.slice(header[0].length)
    }
    const pair = cur && /^\s*([a-z][\w-]*)\s*(?:=(.*))?$/iu.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    if (key === 'path' || key === 'url' || key === 'branch') cur[key] = gitConfigValue(pair[2] ?? '')
  }
  return [...byName.values()]
}

// The submodules of the project at `baseDir` (its `.gitmodules`, see parseGitmodules).
export const readGitmodules = (baseDir) => parseGitmodules(readUtf8OrNull(join(baseDir, '.gitmodules')) ?? '')

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
// `lib/forge-std`), and the `packages` (git submodules). `of(path)` gives `{ real, outside,
// dependency, escape }`:
// - `real`: the real path, spelled as the filesystem spells it (project-relative; null when
//   nothing is there), `outside` when it's out of the root;
// - `dependency`: the real path lies in a dependency, however the path got there (a project's
//   `src/vendor -> ../lib/dep/src` holds the dependency's code);
// - `escape`: `{ link, root, why }` (and `reason`, saying so) when the path may not be read: it
//   crosses a symlink that no one
//   trusted placed -- one planted inside the dependency `root` that leads out of it to anything but
//   another dependency (`lib/evil/src/Evil.sol -> ../../../.env`), or one outside the project
//   (`root` null) that leads back into it (a dependency linked from elsewhere: `lib/evil ->
//   ../../shared/evil` holding `Evil.sol -> ../../proj/.env`) -- or (`why: 'unresolved'`) the walk
//   below can't vouch for it: it resolves the path link by link, and where that doesn't land where
//   the OS's realpath does (a link target it can't read as the OS does, one that isn't UTF-8), the
//   path is refused rather than trusted. A link the project placed (a workspace package in
//   node_modules, a linked `lib/` entry) may lead anywhere in the root, and so may one on the path
//   the project was named by (a symlinked checkout, macOS's `/tmp`).
export function solidityOwnership(baseDir, { dirs = [], packages = [] } = {}) {
  const realBase = realpathSync.native(baseDir)
  const named = resolve(baseDir)
  const onNamedPath = (abs) => named === abs || named.startsWith(abs.endsWith(sep) ? abs : `${abs}${sep}`)
  const toRel = (abs) => toSlashes(relative(realBase, abs)) || '.'
  const inRoot = (rel) => rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
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
      const path = join(realBase, rel)
      let { abs, escape } = walk(realBase, rel.split('/'), 0)
      // The OS's answer is the one a read gets: the walk must agree with it, or the path is refused.
      // (Past its last link the walk's path is spelled as given; with none, it's `path` itself.)
      const os = realpathOrNull(path)
      if (escape === null) {
        const walked = abs === null ? null : abs === path ? os : realpathOrNull(abs)
        if (walked !== os) escape = { link: rel, root: null, why: 'unresolved' }
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
  return { of }
}

// The ownership of the project at `baseDir` given its lib dirs (`soldeer`: forge's `dependencies/`
// holds dependencies too), with its git submodules.
export const projectOwnership = (baseDir, libs, { soldeer = false } = {}) =>
  solidityOwnership(baseDir, { dirs: [...libs, ...(soldeer ? ['dependencies'] : [])], packages: readGitmodules(baseDir).map((s) => s.path).filter(Boolean) })

// Why a path is refused (see solidityOwnership).
function escapeReason(path, { link, root, why }) {
  if (why === 'unresolved') return `${path} crosses a link stasis can't follow the way the filesystem does`
  const what = root === null ? 'a link from outside the project root back into it' : `a link out of the dependency ${root}`
  return link === path ? `${path} is ${what}` : `it resolves to ${path} through ${link}, ${what}`
}
