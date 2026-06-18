// `stasis run --fs=sync|async` (EXODUS_STASIS_FS): monkey-patch the filesystem readers
// fs.readFileSync, fs.readdirSync, fs.lstatSync, fs.statSync so that, alongside the
// module graph the loader hooks already capture, a program's explicit file/directory
// reads are recorded into the bundle (bundle=add|replace) and served back from it
// (bundle=load).
//
// MODE:
//   - `=sync` patches only the sync readers above (the default; `--fs` bare == sync).
//   - `=async` additionally patches their async counterparts -- the callback forms
//     fs.readFile/readdir/lstat/stat and the promise forms fs.promises.* (the latter
//     IS node:fs/promises, the same object, so syncBuiltinESMExports() covers ESM
//     `import ... from 'node:fs/promises'` too). Each async wrapper shares the exact
//     capture/serve logic of its sync sibling; only the I/O plumbing differs.
//
// SCOPE, deliberately narrow:
//   - Only those four operations. Other fs (fs.opendir, streams, fs.cp, watchers,
//     ...) is NOT touched, in either mode.
//   - readdirSync: only the single-argument form `readdirSync(path)`. Any options
//     (encoding, withFileTypes, recursive) fall through untouched -- Dirent objects
//     and recursive listings aren't modelled.
//   - readFileSync: the optional second argument (an `encoding` string, or an
//     options object with `encoding`) is honoured; the raw bytes are what we
//     capture/serve and `encoding` is applied on the way out.
//   - lstatSync / statSync: serve-only, bundle=load, single-argument form. For a
//     recorded path they return a Stats-like object whose isFile()/isDirectory() come
//     from the bundle (the common existence check); every other member is the real
//     stat while the file is still on disk, and a benign synthetic default (0 / epoch
//     / file-or-dir mode) once it's gone -- so fs wrappers that read more than
//     isFile()/isDirectory() (graceful-fs reads stats.uid/gid) keep working under
//     bundle=load instead of re-throwing ENOENT. Never patched in capture mode (the
//     file is on disk there, so the real Stats is correct). statSync vs lstatSync
//     differ only in symlink following, which matters solely for that on-disk
//     passthrough -- each falls back to its own real implementation.
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
// hooks below call THESE (never the patched `fs.*`), so there is no recursion,
// capture always sees real bytes, and the patched lstatSync/statSync fall back to
// the real impls here. realpathSync isn't patched, but is snapshotted for symmetry
// and to stay immune to any future patch.
const realReadFileSync = fs.readFileSync
const realReaddirSync = fs.readdirSync
const realLstatSync = fs.lstatSync
const realStatSync = fs.statSync
const realRealpathSync = fs.realpathSync

// Async counterparts, snapshotted for `--fs=async`. Callback forms off `fs`, promise
// forms off `fs.promises` (which IS node:fs/promises -- same object, so patching it +
// syncBuiltinESMExports() also covers `import ... from 'node:fs/promises'`). The
// bundleStats shim still falls back to the SYNC real stat (a Stats field read is
// synchronous), so no async stat snapshot is needed.
const realReadFile = fs.readFile
const realReaddir = fs.readdir
const realLstat = fs.lstat
const realStat = fs.stat
const realReadFileP = fs.promises.readFile
const realReaddirP = fs.promises.readdir
const realLstatP = fs.promises.lstat
const realStatP = fs.promises.stat

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

// File-type bits, so code that derives the kind from stats.mode (rather than the
// is*() methods) still sees file-vs-directory for an absent bundle-served path.
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

// Benign fs.Stats-shaped record for a recorded path whose bytes are served from the
// bundle but is GONE from disk. isFile/isDirectory come from the bundle; the rest are
// neutral defaults (zeros, epoch Dates, file/dir mode bits) -- never a throw. This is
// what lets fs wrappers that read more than isFile()/isDirectory() off the returned
// Stats keep working under bundle=load: graceful-fs's statFixSync, for instance,
// reads stats.uid/gid, which would otherwise re-trigger the very ENOENT the bundle
// exists to paper over. The other is*() are false -- the shim models only files and
// directories.
function syntheticStat(isDir) {
  const epoch = new Date(0)
  return {
    dev: 0, ino: 0, mode: isDir ? S_IFDIR : S_IFREG, nlink: 1, uid: 0, gid: 0,
    rdev: 0, size: 0, blksize: 4096, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    atime: epoch, mtime: epoch, ctime: epoch, birthtime: epoch,
    isSymbolicLink: () => false, isBlockDevice: () => false,
    isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  }
}

// A Stats-like object for a bundle-served path (bundle=load). isFile()/isDirectory()
// always answer from the bundle's record (the point of the shim -- available even
// when the file is absent from disk). Every other member comes from the REAL stat
// while the file is still on disk (faithful metadata); once it's gone -- the
// bundle-load case -- realStatFn throws and we fall back to syntheticStat's benign
// defaults instead of forwarding the ENOENT. Built as a Proxy so this covers the
// full Stats surface (methods AND numeric/Date fields) without enumerating it.
//
// `then` is short-circuited to undefined: a real fs.Stats is never thenable, but the
// lazy resolution would otherwise forward the `then` probe that `await`/Promise
// resolution performs to realStatFn -- which THROWS for an absent file, making a
// bundle-served Stats an accidental rejecting thenable (`await lstatSync(x)` would
// reject with ENOENT for exactly the absent-from-disk case the shim exists to serve).
// Returning undefined keeps it non-thenable in both the present and absent cases.
//
// Read-only: there is no `set` trap, so a write to a field (a wrapper normalising
// e.g. stats.uid) lands on the override target, not on `data`, and isn't reflected
// back on read. No real consumer needs mutate-then-read here -- graceful-fs only
// writes uid/gid when they're < 0, which the synthetic 0 (and modern Node) never hit.
function bundleStats(realStatFn, statPath, isDir) {
  let data // real fs.Stats, or the synthetic fallback -- resolved once, on demand
  const overrides = { isFile: () => !isDir, isDirectory: () => isDir }
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'isFile' || prop === 'isDirectory') return target[prop]
      if (prop === 'then') return undefined // never an (accidentally rejecting) thenable
      if (data === undefined) {
        try { data = realStatFn(statPath) } catch { data = syntheticStat(isDir) }
      }
      const value = data[prop]
      return typeof value === 'function' ? value.bind(data) : value
    },
  })
}

let installed = false

export function installFsHooks({ async: patchAsync, getState, markAborted, isLoadingModule }) {
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
    if (state && options == null) {
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
    if (state?.config.loadBundle && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const kind = state.getFsStat(pathToFileURL(abs).toString())
        if (kind !== undefined) return bundleStats(realLstatSync, path, kind === 'directory')
      }
    }
    return realLstatSync(path, options)
  }

  // statSync mirrors lstatSync exactly; the only difference is symlink following,
  // which is moot for a bundle-served path (there is no link to follow once the
  // bytes come from the bundle) but matters for the passthrough/present-on-disk
  // case, so it falls back to the real statSync rather than lstatSync.
  fs.statSync = function statSync(path, options) {
    const state = getState()
    if (state?.config.loadBundle && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const kind = state.getFsStat(pathToFileURL(abs).toString())
        if (kind !== undefined) return bundleStats(realStatSync, path, kind === 'directory')
      }
    }
    return realStatSync(path, options)
  }

  // --fs=async: the async counterparts. Each shares its sync sibling's capture/serve
  // logic via fsTarget(); only the I/O plumbing (callback / promise) differs. A served
  // callback is deferred (queueMicrotask) so a bundle hit never fires it synchronously,
  // preserving fs's "the callback is always async" contract. fs.promises.* IS
  // node:fs/promises (same object), so syncBuiltinESMExports() below propagates these
  // to ESM `import ... from 'node:fs/promises'` as well.
  if (patchAsync) {
    // Classify a path exactly as the sync readers do: serve from the bundle
    // (loadBundle), capture into it (writeBundle, outside a module-load window), or
    // pass through (null) for out-of-root / fd / non-file-URL / no-state.
    const fsTarget = (path) => {
      const state = getState()
      if (!state) return null
      const abs = toAbsPath(path)
      if (abs === null || !withinRoot(state.root, abs)) return null
      const url = pathToFileURL(abs).toString()
      if (state.config.loadBundle) return { mode: 'serve', state, url, abs }
      if (state.config.writeBundle && !isLoadingModule()) return { mode: 'capture', state, url, abs }
      return null
    }

    // Decode bytes for a callback reader, routing a decode error (e.g. an invalid
    // encoding like 'buffer') to the callback -- exactly as fs.readFile does. Without
    // this the throw escapes the deferred/real-reader callback as an UNCAUGHT exception
    // and crashes the process (the sync path is fine: there the throw is the caller's
    // to catch). The promise readers don't need it -- a throw there rejects the promise.
    const decodeToCb = (cb, buf, options) => {
      let out
      try { out = decode(buf, options) } catch (err) { cb(err); return }
      cb(null, out)
    }

    fs.readFile = function readFile(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? undefined : options
      const t = typeof cb === 'function' ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFile(t.url)
        if (buf !== undefined) { queueMicrotask(() => decodeToCb(cb, buf, opts)); return }
      } else if (t?.mode === 'capture') {
        realReadFile(path, (err, buf) => {
          if (err) return cb(err)
          if (realContained(t.state.root, t.abs)) { try { t.state.addFsFile(t.url, buf) } catch (e) { markAborted(e) } }
          decodeToCb(cb, buf, opts)
        })
        return
      }
      return realReadFile(path, options, callback)
    }

    fs.promises.readFile = async function readFile(path, options) {
      const t = fsTarget(path)
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFile(t.url)
        if (buf !== undefined) return decode(buf, options)
      } else if (t?.mode === 'capture') {
        const buf = await realReadFileP(path)
        if (realContained(t.state.root, t.abs)) { try { t.state.addFsFile(t.url, buf) } catch (e) { markAborted(e) } }
        return decode(buf, options)
      }
      return realReadFileP(path, options)
    }

    // Single-argument form only (options === the callback / undefined), like readdirSync.
    fs.readdir = function readdir(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // "single-argument" form: fn(path, cb) OR fn(path, null/undefined, cb). graceful-fs
      // normalises readdir(path, cb) to readdir(path, null, cb), so a null options must
      // count as "no options" -- otherwise its reads never hit the bundle (the exact
      // gap that made --fs=async fail for enhanced-resolve's async file system).
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const names = t.state.getFsDir(t.url)
        if (names !== undefined) { queueMicrotask(() => cb(null, names)); return }
      } else if (t?.mode === 'capture') {
        realReaddir(path, (err, names) => {
          if (err) return cb(err)
          if (realContained(t.state.root, t.abs)) { try { t.state.addFsDir(t.url, names) } catch (e) { markAborted(e) } }
          cb(null, names)
        })
        return
      }
      return realReaddir(path, options, callback)
    }

    fs.promises.readdir = async function readdir(path, options) {
      const t = options == null ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const names = t.state.getFsDir(t.url)
        if (names !== undefined) return names
      } else if (t?.mode === 'capture') {
        const names = await realReaddirP(path)
        if (realContained(t.state.root, t.abs)) { try { t.state.addFsDir(t.url, names) } catch (e) { markAborted(e) } }
        return names
      }
      return realReaddirP(path, options)
    }

    // lstat/stat are serve-only (like their sync siblings); capture is left to the real
    // call. bundleStats's field fallback is synchronous, so it uses the sync real stat.
    fs.lstat = function lstat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // "single-argument" form: fn(path, cb) OR fn(path, null/undefined, cb). graceful-fs
      // normalises readdir(path, cb) to readdir(path, null, cb), so a null options must
      // count as "no options" -- otherwise its reads never hit the bundle (the exact
      // gap that made --fs=async fail for enhanced-resolve's async file system).
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStat(t.url)
        if (kind !== undefined) { queueMicrotask(() => cb(null, bundleStats(realLstatSync, path, kind === 'directory'))); return }
      }
      return realLstat(path, options, callback)
    }

    fs.stat = function stat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // "single-argument" form: fn(path, cb) OR fn(path, null/undefined, cb). graceful-fs
      // normalises readdir(path, cb) to readdir(path, null, cb), so a null options must
      // count as "no options" -- otherwise its reads never hit the bundle (the exact
      // gap that made --fs=async fail for enhanced-resolve's async file system).
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStat(t.url)
        if (kind !== undefined) { queueMicrotask(() => cb(null, bundleStats(realStatSync, path, kind === 'directory'))); return }
      }
      return realStat(path, options, callback)
    }

    fs.promises.lstat = async function lstat(path, options) {
      const t = options == null ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStat(t.url)
        if (kind !== undefined) return bundleStats(realLstatSync, path, kind === 'directory')
      }
      return realLstatP(path, options)
    }

    fs.promises.stat = async function stat(path, options) {
      const t = options == null ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStat(t.url)
        if (kind !== undefined) return bundleStats(realStatSync, path, kind === 'directory')
      }
      return realStatP(path, options)
    }
  }

  // Refresh the node:fs (and node:fs/promises) ESM wrappers so destructured/namespace
  // ESM imports made AFTER this point resolve to the patched functions. Stasis's own
  // modules, linked earlier, keep their pre-patch snapshots.
  syncBuiltinESMExports()
}
