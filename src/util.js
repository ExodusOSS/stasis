const sep = '/'

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

// Split a POSIX-style path at its *last* node_modules/ segment into the
// containing package's `dir`, the `rel` path inside the package, and the
// package `name` (taking 2 segments for `@scope/pkg`, otherwise 1). Returns
// null when the path has no node_modules segment, or when the node_modules
// slice is malformed (trailing slash, empty segments, or no file segment
// after the package dir).
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
