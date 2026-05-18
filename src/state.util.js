import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

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
    assert.deepStrictEqual(map.get(key), value)
  } else {
    map.set(key, value)
  }
}
