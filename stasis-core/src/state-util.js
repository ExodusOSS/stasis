import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

// The genuine fs readers, snapshotted off the namespace before any --fs patch. The single source
// of truth for "the real reader" -- used by stasis's own internals (here; fs.js's --fs hook, so its
// capture path sees real bytes and never recurses) AND by every bundler plugin (webpack/esbuild/
// metro). A plugin's capture read is stasis-internal bookkeeping, not a program fs read: routing it
// through the patched fs would re-record the bundler's module graph into the main bundle. A plain
// `import { readFileSync }` won't do -- `stasis run --fs` monkey-patches fs.readFileSync then
// syncBuiltinESMExports() rebinds that named import, and a plugin loads AFTER the patch; snapshotting
// off the namespace dodges that. state-util.js is a leaf evaluated during the `--import` preload
// before any patch, so these are always the real builtins. (`fs.promises` IS node:fs/promises, so
// realReadFile also covers its `readFile`.)
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

// Canonicalize a filesystem path for write-target collision detection. `resolve()` normalizes
// `./` and `../` but NOT symlinks -- two paths through different symlink chains naming the same
// inode would compare as distinct strings, letting a "same target?" check silently fork the
// claim sets. `realpathSync` closes that hole when the file exists; for not-yet-written targets
// (the common case for a fresh capture), fall back to lexical `resolve()` -- there's no symlink
// to follow, and a later writer claiming the same target's realpath canonicalizes to the same
// string this resolve() produced.
export function canonicalizePath(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}
