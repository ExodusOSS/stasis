import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { diskHost } from './host.js'

// Genuine fs readers snapshotted off the namespace before any --fs patch. A plain `import { readFileSync }`
// won't do: --fs monkey-patches fs then syncBuiltinESMExports() rebinds named imports, so snapshotting dodges that.
export const realReadFileSync = fs.readFileSync
export const realReadFile = fs.promises.readFile
export const realReaddirSync = fs.readdirSync
export const realExistsSync = fs.existsSync

assert.equal(sep, '/', 'Not tested on Windows')

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

export function readFileSyncMaybe(dir, file, encoding, host = diskHost) {
  let buf
  try {
    buf = host.readFile(join(dir, file))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return encoding === undefined ? buf : buf.toString(encoding)
}

export function noupsert(map, key, value) {
  if (map.has(key)) {
    assert.deepStrictEqual(map.get(key), value, `Conflict for ${JSON.stringify(key)}`)
  } else {
    map.set(key, value)
  }
}

// Canonicalize for write-target collision detection: the host's realpath catches symlink aliases resolve() would miss; lexical fallback for not-yet-written targets.
export function canonicalizePath(p, host = diskHost) {
  const abs = resolve(p)
  try {
    return host.realpath(abs)
  } catch {
    return abs
  }
}
