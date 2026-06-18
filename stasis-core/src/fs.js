// `stasis run --fs` (EXODUS_STASIS_FS): monkey-patch the SYNC filesystem readers
// fs.readFileSync, fs.readdirSync, and fs.lstatSync so that, alongside the module
// graph the loader hooks already capture, a program's explicit file/directory reads
// are recorded into the bundle (bundle=add|replace) and served back from it
// (bundle=load).
//
// SCOPE, deliberately narrow:
//   - Only the SYNC fs.readFileSync / fs.readdirSync / fs.lstatSync / fs.statSync
//     plus async `fs.stat` (serve-only). The async stat exception exists because
//     enhanced-resolve (webpack's resolver) probes file/directory existence via
//     async `fs.stat` by default; without it, bundle=load can't resolve any path
//     that isn't also on disk. fs.readFile, fs.promises.*, fs.opendir, streams,
//     and other async readers are still NOT touched.
//   - readdirSync: only the single-argument form `readdirSync(path)`. Any options
//     (encoding, withFileTypes, recursive) fall through untouched -- Dirent objects
//     and recursive listings aren't modelled.
//   - readFileSync: the optional second argument (an `encoding` string, or an
//     options object with `encoding`) is honoured; the raw bytes are what we
//     capture/serve and `encoding` is applied on the way out.
//   - lstatSync / statSync / stat: serve-only, bundle=load, single-argument form
//     (async stat additionally accepts the trailing callback). For a recorded path
//     each returns a Stats-like object whose isFile()/isDirectory() come from the
//     bundle (the common existence check), and every other member LAZILY passes
//     through to the real lstatSync(path) (which throws if the file is absent, just
//     as without the bundle). Never patched in capture mode (the file is on disk
//     there, so the real Stats is correct).
//   - Only paths inside the project root -- whose REAL path (symlinks resolved)
//     also stays inside the root -- are captured/served; anything else (a system
//     path, a symlink escaping the root, an fd, a non-file URL) falls through to
//     the real call and is NOT attested.
//
// Mechanism mirrors the @exodus/stasis tooling package's src/mock.js: reach the
// mutable CJS `node:fs` object through createRequire, snapshot the real functions
// at module-eval time (BEFORE install() patches anything, so stasis's own snapshots
// and these stay real), then on install replace the readers and
// syncBuiltinESMExports() so user code's later ESM `import { readFileSync } from
// 'node:fs'` sees the patched binding too. (Unlike mock.js it assigns directly
// rather than via node:test's MockTracker -- no test-time restore is needed.) State
// is read lazily per call (it's created when the entry loads), and decode/lookup
// reuse State's getFs* / addFs* methods.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Snapshot the real functions now, while they're still the genuine builtins. The
// hooks below call THESE (never the patched `fs.*`), so there is no recursion and
// capture always sees real bytes. realpathSync/lstatSync aren't patched, but are
// snapshotted for symmetry and to stay immune to any future patch.
const realReadFileSync = fs.readFileSync
const realReaddirSync = fs.readdirSync
const realLstatSync = fs.lstatSync
const realStatSync = fs.statSync
const realStat = fs.stat
const realRealpathSync = fs.realpathSync

// Resolve a path argument to an absolute filesystem path, or null when it's
// something we don't capture (an integer fd, or a non-file URL). Strings/Buffers
// are resolved against cwd exactly like fs does; a trailing slash on a directory is
// dropped by resolve(), keeping the file: URL we build in agreement with State's
// pathToFileURL round-trip.
function toAbsPath(path) {
  if (typeof path === 'string') return resolve(path)
  if (Buffer.isBuffer(path)) return resolve(path.toString())
  if (path instanceof URL) return path.protocol === 'file:' ? fileURLToPath(path) : null
  return null // integer fd or unknown
}

// True when `abs` is the project root or lives beneath it. Out-of-root reads (system
// files, parent escapes) are left entirely to the real implementation.
function withinRoot(root, abs) {
  const rel = relative(root, abs)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

// Memoized real path of the project root, for the symlink-containment check below.
let realRootCache
function realRootOf(root) {
  if (realRootCache?.root !== root) {
    let real
    try { real = realRealpathSync(root) } catch { real = root }
    realRootCache = { root, real }
  }
  return realRootCache.real
}

// Capture-side containment: the path's REAL location (all symlinks resolved) must
// stay inside the project root's real path. `withinRoot` is lexical only, so a
// symlink inside the tree pointing OUT (`src/peek -> /etc`) would otherwise be read
// and its bytes/listing attested as if in-root -- pulling external content into the
// closed, signed bundle. An escaping (or vanished) path returns false: the hook
// then leaves it to the real fs and records nothing. Only used while capturing; the
// path exists (we just read it).
function realContained(root, abs) {
  let real
  try { real = realRealpathSync(abs) } catch { return false }
  const rel = relative(realRootOf(root), real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Apply readFileSync's second argument to raw bytes: a string encoding, or an
// options object's `encoding`. No encoding yields the Buffer; anything else is
// handed to Buffer.toString, which decodes a known encoding and throws
// ERR_UNKNOWN_ENCODING for an unknown one -- matching fs's contract, including
// that an invalid encoding like 'buffer' throws rather than returning the Buffer.
function decode(buf, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  if (encoding == null) return buf
  return buf.toString(encoding)
}

// A Stats-like object for a bundle-served path (bundle=load). isFile()/isDirectory()
// answer from the bundle's record (always available, even when the file is absent
// from disk -- the point of the shim). EVERYTHING else lazily passes through to the
// real lstatSync(path): if the file is on disk you get its true metadata, and if it
// isn't you get the same error you'd get without stasis. Built as a Proxy so the
// passthrough covers the full Stats surface (methods AND numeric/Date fields)
// without enumerating it.
//
// `then` is short-circuited to undefined: a real fs.Stats is never thenable, but the
// lazy passthrough would otherwise forward the `then` probe that `await`/Promise
// resolution performs to realLstatSync -- which THROWS for an absent file, making a
// bundle-served Stats an accidental rejecting thenable (`await lstatSync(x)` would
// reject with ENOENT for exactly the absent-from-disk case the shim exists to serve).
// Returning undefined keeps it non-thenable in both the present and absent cases.
function bundleStats(realPath, isDir) {
  let real
  const realStat = () => (real ??= realLstatSync(realPath))
  const overrides = { isFile: () => !isDir, isDirectory: () => isDir }
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'isFile' || prop === 'isDirectory') return target[prop]
      if (prop === 'then') return undefined // never an (accidentally rejecting) thenable
      const r = realStat()
      const value = r[prop]
      return typeof value === 'function' ? value.bind(r) : value
    },
  })
}

let installed = false

export function installFsHooks({ getState, markAborted, isLoadingModule }) {
  if (installed) return // idempotent: install() is the sole caller, but guard anyway
  installed = true

  fs.readFileSync = function readFileSync(path, options) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          // Serve the captured bytes; a path the bundle never recorded (or one
          // recorded as a directory) returns undefined and falls back to disk.
          const buf = state.getFsFile(url)
          if (buf !== undefined) return decode(buf, options)
        } else if (state.config.writeBundle && !isLoadingModule()) {
          // (Skip while Node's loader is reading a module's source -- that's captured
          // as code by the load hook, not a program fs read.) Read once via the real
          // reader (faithful errors on the user's original path), record, and hand
          // the user the same bytes. A capture conflict (the file read twice with
          // diverging bytes) taints the run so nothing inconsistent is written; the
          // user's read still succeeds. A path whose real location escapes the root
          // (in-tree symlink) is read but NOT recorded -- its content isn't in-bundle
          // and must not be attested.
          const buf = realReadFileSync(path)
          if (realContained(state.root, abs)) {
            try { state.addFsFile(url, buf) } catch (err) { markAborted(err) }
          }
          return decode(buf, options)
        }
      }
    }
    return realReadFileSync(path, options)
  }

  fs.readdirSync = function readdirSync(path, options) {
    const state = getState()
    // Single-argument form only: any options (encoding/withFileTypes/recursive)
    // are out of scope and pass straight through.
    if (state && options === undefined) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          const names = state.getFsDir(url)
          if (names !== undefined) return names // sorted at capture time
        } else if (state.config.writeBundle && !isLoadingModule()) {
          // (Node's loader doesn't readdir to load a module, but skip during a load
          // window anyway, symmetric with readFileSync.)
          const names = realReaddirSync(path) // string[] (single-arg)
          // As in readFileSync: skip recording a directory whose real path escapes
          // the root (an in-tree symlink to outside), so an external listing is
          // never baked into the bundle/lockfile.
          if (realContained(state.root, abs)) {
            try { state.addFsDir(url, names) } catch (err) { markAborted(err) }
          }
          return names
        }
      }
    }
    return realReaddirSync(path, options)
  }

  fs.lstatSync = function lstatSync(path, options) {
    const state = getState()
    // Serve-only, single-argument form. Capture mode is left to the real lstatSync
    // (the file is on disk, so its Stats is correct and complete).
    if (state?.config.loadBundle && options === undefined) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const kind = state.getFsStat(pathToFileURL(abs).toString())
        if (kind !== undefined) return bundleStats(path, kind === 'directory')
      }
    }
    return realLstatSync(path, options)
  }

  // statSync mirrors lstatSync. enhanced-resolve uses statSync for file-existence
  // probes under `useSyncFileSystemCalls`; without serving from the bundle here,
  // bundle=load can't resolve any path that isn't also on disk.
  fs.statSync = function statSync(path, options) {
    const state = getState()
    if (state?.config.loadBundle && options === undefined) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const kind = state.getFsStat(pathToFileURL(abs).toString())
        if (kind !== undefined) return bundleStats(path, kind === 'directory')
      }
    }
    return realStatSync(path, options)
  }

  // Async stat. enhanced-resolve uses fs.stat by default (no useSyncFileSystemCalls)
  // for webpack's loader and module resolution: without this, a bundle=load build
  // fails with "Can't resolve '<loader>'" / "Can't resolve './entry.js'" because
  // every existence probe ENOENTs through the unpatched async path. We schedule
  // the success callback on a microtask to match the real fs's deferred shape
  // (callers depend on `cb` running after the current frame).
  fs.stat = function stat(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    const state = getState()
    if (state?.config.loadBundle && options === undefined) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const kind = state.getFsStat(pathToFileURL(abs).toString())
        if (kind !== undefined) {
          const stats = bundleStats(path, kind === 'directory')
          queueMicrotask(() => callback(null, stats))
          return
        }
      }
    }
    return options === undefined ? realStat(path, callback) : realStat(path, options, callback)
  }

  // Refresh the node:fs ESM wrapper so destructured/namespace ESM imports made
  // AFTER this point resolve to the patched functions. Stasis's own modules, linked
  // earlier, keep their pre-patch snapshots.
  syncBuiltinESMExports()
}
