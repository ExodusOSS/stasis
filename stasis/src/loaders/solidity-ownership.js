// Who owns each file of a Solidity project -- the project or one of its dependencies -- decided by
// where the file really is, for the import resolution (solidity.js), forge's config discovery
// (foundry.js) and the bundler's --manifests. Dependencies are untrusted input: a link one plants
// out of itself is never followed.

import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

import { toPosix } from '@exodus/stasis-core/util'
import { isDir } from '../resolve-typescript.js'
import { readFileOrNull } from './cargo.js'

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
// file: keys case-insensitive, values unquoted and unescaped, a line ending in `\` continued, and a
// submodule's sections merged by name.
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
      continue
    }
    const pair = cur && /^\s*([a-z][\w-]*)\s*(?:=(.*))?$/iu.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    if (key === 'path' || key === 'url' || key === 'branch') cur[key] = gitConfigValue(pair[2] ?? '')
  }
  return [...byName.values()]
}

// The directories of `.gitmodules`' submodules: dependencies, whatever their host.
export function gitSubmodulePaths(baseDir) {
  return parseGitmodules(readFileOrNull(join(baseDir, '.gitmodules')) ?? '').map((s) => s.path).filter(Boolean)
}

// --- Ownership --------------------------------------------------------------------------------

const realpathOrNull = (p) => {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

const readdirOrEmpty = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const NOTHING = { abs: null, escape: null }

// Who owns each project-relative path, decided from how it resolves on disk. The dependencies are
// every `node_modules/<pkg>` (`@scope/<pkg>`), each entry of the `dirs` (forge's libs, Soldeer's
// `dependencies/`; a linked entry is the dependency where it points, as a symlinked
// `lib/forge-std`), and the `packages` (git submodules). `of(path)` gives `{ real, outside,
// dependency, escape }`:
// - `real`: the real path, spelled as the filesystem spells it (project-relative; null when
//   nothing is there), `outside` when it's out of the root;
// - `dependency`: the real path lies in a dependency, however the path got there (a project's
//   `src/vendor -> ../lib/dep/src` holds the dependency's code);
// - `escape`: `{ link, root }` when the path crosses a symlink that no one trusted placed: one
//   planted inside the dependency `root` that leads out of it to anything but another dependency
//   (`lib/evil/src/Evil.sol -> ../../../.env`), or one outside the project (`root` null) that leads
//   back into it (a dependency linked from elsewhere: `lib/evil -> ../../shared/evil` holding
//   `Evil.sol -> ../../proj/.env`). Such a path is never read. A link the project placed (a
//   workspace package in node_modules, a linked `lib/` entry) may lead anywhere in the root, and so
//   may one on the path the project was named by (a symlinked checkout, macOS's `/tmp`).
export function solidityOwnership(baseDir, { dirs = [], packages = [] } = {}) {
  const realBase = realpathSync.native(baseDir)
  const named = resolve(baseDir)
  const onNamedPath = (abs) => named === abs || named.startsWith(abs.endsWith(sep) ? abs : `${abs}${sep}`)
  const toRel = (abs) => toPosix(relative(realBase, abs)) || '.'
  const inRoot = (rel) => rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
  const inside = (rel) => rel !== '.' && inRoot(rel)
  const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`)
  const clean = (d) => posix.normalize(toPosix(d)).replace(/\/+$/u, '')

  // Dirs whose entries are dependencies, and dependency dirs themselves; each by its real path too.
  const holders = new Set()
  const roots = new Set()
  const addReal = (set, rel) => {
    const real = realpathOrNull(join(baseDir, rel))
    if (real !== null && inside(toRel(real))) set.add(toRel(real))
  }
  for (const d of dirs.map(clean).filter(inside)) {
    if (posix.basename(d) === 'node_modules') continue // a package's own rule, below
    holders.add(d)
    addReal(holders, d)
    for (const e of readdirOrEmpty(join(baseDir, d))) if (e.isSymbolicLink() && isDir(join(baseDir, d, e.name))) addReal(roots, `${d}/${e.name}`)
  }
  for (const p of packages.map(clean).filter(inside)) {
    roots.add(p)
    addReal(roots, p)
  }
  const inDependency = (rel) => inside(rel) && (rel.split('/').includes('node_modules') || [...holders, ...roots].some((d) => under(rel, d)))
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
  // (and those its target crosses): `{ abs, escape }`, `abs` null when nothing is there. Each
  // component takes the filesystem's spelling (a case-insensitive one finds `lib` for `LIB`).
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
          cur = realpathOrNull(next) ?? next
          continue
        }
        target = readlinkSync(next)
      } catch {
        return NOTHING
      }
      if (depth >= 40) return NOTHING // ELOOP
      const r = walk(isAbsolute(target) ? parse(target).root : cur, target.split(/[\\/]/u), depth + 1)
      if (r.abs === null || r.escape !== null) return r
      const at = toRel(next)
      const to = toRel(r.abs)
      if (inside(at)) {
        const root = rootOf(toRel(cur))
        if (root !== null && !under(to, root) && !inDependency(to)) return { abs: r.abs, escape: { link: at, root } }
      } else if (inRoot(to) && !onNamedPath(next)) {
        return { abs: r.abs, escape: { link: at, root: null } }
      }
      cur = r.abs
    }
    return { abs: cur, escape: null }
  }

  const owners = new Map()
  const of = (rel) => {
    let owner = owners.get(rel)
    if (owner === undefined) {
      const { abs, escape } = walk(realBase, rel.split('/'), 0)
      const real = abs === null ? null : toRel(abs)
      owner = { real, outside: real !== null && !inRoot(real), dependency: real !== null && inDependency(real), escape }
      owners.set(rel, owner)
    }
    return owner
  }
  return { of }
}

// The ownership of the project at `baseDir` given its lib dirs (`soldeer`: forge's `dependencies/`
// holds dependencies too), with its git submodules.
export const projectOwnership = (baseDir, libs, { soldeer = false } = {}) =>
  solidityOwnership(baseDir, { dirs: [...libs, ...(soldeer ? ['dependencies'] : [])], packages: gitSubmodulePaths(baseDir) })

// Why a path crossing an untrusted link is refused (see solidityOwnership).
export function escapeReason(path, { link, root }) {
  const what = root === null ? 'a link from outside the project root back into it' : `a link out of the dependency ${root}`
  return link === path ? `${path} is ${what}` : `it resolves to ${path} through ${link}, ${what}`
}
