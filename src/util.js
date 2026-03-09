import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

assert.equal(sep, '/', 'Not tested on Windows')

function sortPaths(a, b) {
  const [al, bl] = [a.split(sep), b.split(sep)]
  while (al[0] === bl[0]) {
    al.shift()
    bl.shift()
  }

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

export function readFileSyncMaybe(dir, file, encoding) {
  try {
    return readFileSync(join(dir, file), encoding)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function noupsert(map, key, value) {
  if (map.has(key)) {
    assert.equal(map.get(key), value)
  } else {
    map.set(key, value)
  }
}

export const isPlainObject = (x) => x && [null, Object.prototype].includes(Object.getPrototypeOf(x))

export const fileSetToObject = (set) => [...set].sort((a, b) => sortPaths(a, b))

export const fileMapToObject = (map) => Object.fromEntries(
  [...map]
    .sort((a, b) => sortPaths(a[0], b[0]))
    .map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v) : v])
)

export const objectToMaps = (obj) => new Map(
  [...Object.entries(obj)].map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)
