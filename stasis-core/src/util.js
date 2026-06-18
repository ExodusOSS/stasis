import { realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative } from 'node:path'

const sep = '/'

// The full, finite universe of `format` strings stasis knows. Lockfile and bundle
// parsers reject any value outside this set so a tampered or forward-incompatible
// artifact fails closed at the schema boundary, not at a later string compare.
// Categories:
//   Executable by Node's loader — module, commonjs, json, *-typescript
//   Source languages (analysis-only, not runnable by Node) — solidity, php, bash, rust
//   Resources (asset payloads) — resource (raw UTF-8), resource:base64 (binary)
//   Filesystem captures (`stasis run --fs`) — directory (a JSON-serialized,
//     sorted `fs.readdirSync` listing; a resource-like raw-UTF-8 payload)
// Adding a new format is a deliberate schema change: list it here AND extend
// hooks.js's executable allowlist if Node should serve it from a bundle.
export const KNOWN_FORMATS = new Set([
  'module',
  'commonjs',
  'json',
  'module-typescript',
  'commonjs-typescript',
  'solidity',
  'php',
  'bash',
  'rust',
  'resource',
  'resource:base64',
  'directory',
])

// Flat project-relative key for the file `rel` inside module dir `dir`, inverse of
// the bucketing State/Bundle apply. The `rel === ''` branch is reached only by a
// `directory` capture whose path IS a module root (e.g. `fs.readdirSync` of a
// package dir, or of the project root): the listing is keyed at the bucket itself,
// so the flat key is the dir (or '' for the workspace root) — never `${dir}/`,
// which a trailing-slash join would wrongly produce and break the round-trip. For
// every ordinary file `rel` is a real basename, so this matches the historical
// `dir === '.' ? rel : `${dir}/${rel}`` exactly.
export function moduleFileKey(dir, rel) {
  if (rel === '') return dir === '.' ? '' : dir
  return dir === '.' ? rel : `${dir}/${rel}`
}

// Resolve `baseDir/relPath` through symlinks and confirm the real target stays
// within `realBase` (the caller-resolved real path of baseDir). Throws on a
// symlink that escapes the bundle root: a crafted in-tree symlink
// (`link.sh -> /etc/passwd`, or a symlinked directory) must not pull an
// external file into a self-contained, attestable bundle. The textual path
// guards elsewhere don't catch this because they never resolve symlinks.
// realpathSync surfaces ENOENT for a missing path, which the loaders' disk
// walks already handle as "missing".
export function assertRealPathWithinBase(realBase, baseDir, relPath) {
  const real = realpathSync(join(baseDir, relPath))
  const rel = relative(realBase, real).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to follow symlink escaping bundle root: ${relPath} -> ${real}`)
  }
}

export function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

export function sortPaths(a, b) {
  const [al, bl] = [a.split(sep), b.split(sep)]
  while (al.length > 0 && al[0] === bl[0]) {
    al.shift()
    bl.shift()
  }
  if (al.length === 0 && bl.length === 0) return 0

  // First process each file in dir, then subdirs
  if (al.length < 2) return bl.length < 2 && al > bl ? 1 : -1
  if (bl.length < 2) return 1

  // * comes first
  if (al[0] === '*') return -1
  if (bl[0] === '*') return 1

  // node_modules comes last
  if (al[0] === 'node_modules') return 1
  if (bl[0] === 'node_modules') return -1

  // Prefer example/ over example-something/
  const [an, bn] = [al, bl].map((list) => list.join(String.fromCodePoint(0)))
  if (an < bn) return -1
  if (an > bn) return 1
  throw new Error('Unreachable')
}

export const isPlainObject = (x) => x && [null, Object.prototype].includes(Object.getPrototypeOf(x))

export const fromEntries = (entries) => Object.setPrototypeOf(Object.fromEntries(entries), null)

export const fileSetToObject = (set) => [...set].toSorted((a, b) => sortPaths(a, b))

export const fileMapToObject = (map) => fromEntries(
  [...map]
    .toSorted((a, b) => sortPaths(a[0], b[0]))
    .map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v) : v])
)

export const objectToMaps = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)

// True when a POSIX, project-relative path escapes the root once normalized:
// a leading `..`, an absolute path, or a mid-path `..` that pops above the
// root (`a/../../x`). Plain `startsWith('..')` only catches the leading case,
// so it's not enough for paths that later get resolved against the root.
export function posixPathEscapes(path) {
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)
}

export function splitNodeModulesPath(path) {
  const marker = 'node_modules/'
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  const after = idx + marker.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const name = parts.slice(0, pkgLen).join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}
