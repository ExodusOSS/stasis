import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Snapshot off the namespace (not `import { readFileSync } from 'node:fs'`) so
// `stasis run --fs` -- which monkey-patches fs.readFileSync and then calls
// module.syncBuiltinESMExports() to reach user code's ESM imports -- can't swap
// the binding stasis itself reads config/lockfile/bundle/package.json through.
// Matches state.js's identical snapshot of the real fs writers/readers.
const { readFileSync, realpathSync } = fs

// Async counterpart, snapshotted off the namespace for the same reason and exported
// for the bundler plugins (esbuild.js): under `--fs=async` fs.promises.readFile is
// patched too, and a plugin module loads AFTER the patch, so importing
// `node:fs/promises` directly there would route the bundler's OWN source reads
// through the --fs capture hook. This pre-patch snapshot keeps them genuine. This
// module is evaluated during stasis's `--import` preload (via state.js), before any
// patch, so the snapshot is always the real builtin.
export const realReadFile = fs.promises.readFile

assert.equal(sep, '/', 'Not tested on Windows')

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
    assert.deepStrictEqual(map.get(key), value, `Conflict for ${JSON.stringify(key)}`)
  } else {
    map.set(key, value)
  }
}

// Canonicalize a filesystem path for write-target collision detection.
// `resolve()` normalizes `./` and `../` but NOT symlinks -- two paths through
// different symlink chains that ultimately name the same inode would compare as
// distinct strings, letting a "is this the same target?" check silently fork
// (the resourcesBundleFile/lockFile/bundleFile claim sets). `realpathSync`
// closes that hole when the file already exists;
// for not-yet-written targets (the common case for a fresh capture's write
// path), fall back to the lexical `resolve()` -- there's no symlink to follow,
// and a later writer claiming the realpath of the same target will canonicalize
// to the same string the first writer's resolve() produced.
export function canonicalizePath(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}
