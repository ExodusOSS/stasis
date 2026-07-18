import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

// The genuine fs readers, snapshotted off the namespace before any --fs patch. This
// module is the single source of truth for "the real reader" -- imported by stasis's
// own internals (here; and fs.js's --fs hook imports realReadFileSync so its capture
// path sees real bytes and never recurses) AND by every bundler plugin (webpack.js /
// esbuild.js / metro.js; esbuild uses the async realReadFile for its async onLoad). A
// plugin's capture read is stasis-internal bookkeeping, NOT a program fs
// read, so routing it through the patched fs would re-record the bundler's module graph
// into the preload/main bundle -- duplicating into main what the plugin captured into
// its own sidecar. `import { readFileSync } from 'node:fs'` would NOT do: `stasis run
// --fs` monkey-patches fs.readFileSync then calls module.syncBuiltinESMExports(), which
// rebinds that named import to the patched fn -- and a plugin loads AFTER the patch.
// Snapshotting off the namespace dodges that. state-util.js is the lowest-level module
// (a leaf with no internal imports), evaluated during the `--import` preload before any
// patch, so these are always the real builtins -- and the snapshot is taken as early as
// possible. (`fs.promises` IS node:fs/promises, the same object, so realReadFile also
// covers `import { readFile } from 'node:fs/promises'`.)
export const realReadFileSync = fs.readFileSync
export const realReadFile = fs.promises.readFile
// `realReaddirSync` is snapshotted for the SAME reason: `stasis run --fs` patches
// fs.readdirSync too (to capture/serve directory listings), so a plugin that walks a
// directory as its own bookkeeping -- StasisMetro's native-dependency capture -- must use
// the genuine reader, or the walk would re-record every listing into the preload/main state.
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
