import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Genuine fs readers snapshotted off the namespace before any --fs patch. A plain `import { readFileSync }`
// won't do: --fs monkey-patches fs then syncBuiltinESMExports() rebinds named imports, so snapshotting dodges that.
export const realReadFileSync = fs.readFileSync
export const realReadFile = fs.promises.readFile
export const realReaddirSync = fs.readdirSync
const { realpathSync } = fs

assert.equal(sep, '/', 'Not tested on Windows')

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

export function readFileSyncMaybe(dir, file, encoding) {
  try {
    return realReadFileSync(join(dir, file), encoding)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function noupsert(map, key, value) {
  if (map.has(key)) {
    assert.deepStrictEqual(map.get(key), value, `Conflict for ${JSON.stringify(key)}`)
  } else {
    map.set(key, value)
  }
}

// Canonicalize for write-target collision detection: resolve() misses symlinks, so two chains to one inode
// would compare distinct. realpathSync closes that; fall back to lexical resolve() for not-yet-written targets.
export function canonicalizePath(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}
