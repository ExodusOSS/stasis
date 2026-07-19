// `stasis run --fs=sync|async` (EXODUS_STASIS_FS, or "fs" in stasis.config.json): monkey-patch
// the filesystem readers fs.readFileSync/readdirSync/lstatSync/statSync so that, alongside
// the module graph the loader hooks already capture, a program's explicit file/directory
// reads -- and the KIND (file vs directory) it lstat/stats -- are recorded into the bundle
// (bundle=add|replace) and served back from it (bundle=load). The existence/canonical-path
// PROBES existsSync/accessSync/realpathSync are also served (load mode) so a tool that checks
// a file before reading it finds a bundle-only file -- see their bullet below.
//
// MODE:
//   - `=sync` patches only the sync readers above (the default; `--fs` bare == sync).
//   - `=async` additionally patches the async counterparts -- callback forms
//     fs.readFile/readdir/lstat/stat + probes fs.access/realpath, and the promise forms
//     fs.promises.* (which IS node:fs/promises, same object, so syncBuiltinESMExports()
//     covers ESM `import ... from 'node:fs/promises'` too). Each async wrapper shares its
//     sync sibling's capture/serve logic; only the I/O plumbing differs.
//
// SCOPE, deliberately narrow:
//   - The four readers plus the existence/canonical-path probes existsSync/accessSync/
//     realpathSync (and under =async fs.access/realpath and the fs.promises forms). Other
//     fs (fs.opendir, streams, fs.cp, watchers, deprecated callback fs.exists, ...) is NOT
//     touched. Notably fs.readlink is left unserved: enhanced-resolve probes it per
//     path-segment but treats a read error as "not a symlink" and continues, so an absent
//     recorded file still resolves correctly (same ancestor-symlink limitation as
//     realpathSync's lexical fallback).
//   - readdirSync: only the single-argument `readdirSync(path)`. Any options (encoding,
//     withFileTypes, recursive) fall through -- Dirent objects and recursive listings
//     aren't modelled.
//   - readFileSync: the optional second arg (`encoding` string, or options object with
//     `encoding`) is honoured -- raw bytes are captured/served, encoding applied on the way
//     out.
//   - lstatSync / statSync: single-arg form, captured AND served -- but ONLY the path's
//     kind (the isFile()/isDirectory() getters); full Stats fields are never attested.
//     CAPTURE runs the real call first (caller gets genuine Stats and errors), then records
//     the kind as a PAYLOAD-FREE stat record, so a stat-ONLY path (never read/readdir'd/
//     imported) still answers at load. Anything but a regular file or directory (symlink
//     under lstat, socket, FIFO, ...) records nothing. SERVE returns a Stats-like object
//     (see bundleStats). statSync vs lstatSync differ only in symlink following: a statSync
//     of an in-root symlink records the TARGET's kind under the requested path (keyed like a
//     byte read), an lstatSync of one records nothing.
//   - existsSync / accessSync / realpathSync (+ async/promise forms under =async):
//     existence/canonical-path PROBES, serve-only, bundle=load only -- see their per-wrapper
//     comments below. A recorded path answers existent / accessible (read-only: F_OK/R_OK,
//     while W_OK/X_OK defer) / its-path even once gone from disk; unrecorded paths and all of
//     capture mode defer to the real call. Serve-only means a path ONLY probed (never read or
//     imported) isn't recorded and falls through to disk; an lstat/stat of it, by contrast,
//     DOES record its kind (same getFsStatFamily these probes consult).
//   - Source-map sidecars (`*.map`): treated as NON-EXISTENT under --fs -- never captured,
//     never served, ENOENT to the reader, in both capture and load. See isSkippedSourceMap;
//     opt in via `map` in the resources allowlist.
//   - Only paths inside the project root -- whose REAL path (symlinks resolved) also stays
//     inside it -- are captured/served; anything else (system path, escaping symlink, fd,
//     non-file URL) falls through to the real call and is NOT attested.
//
// Mechanism mirrors @exodus/stasis's src/mock.js: reach the mutable CJS `node:fs` via
// createRequire, snapshot the real functions at module-eval (BEFORE install() patches
// anything, so stasis's own snapshots and these stay real), then on install replace the
// readers and syncBuiltinESMExports() so user code's later ESM `import { readFileSync } from
// 'node:fs'` sees the patched binding too. (Unlike mock.js it assigns directly rather than
// via node:test's MockTracker -- no test-time restore needed.) State is read lazily per call;
// decode/lookup reuse State's getFs* / addFs* methods.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The genuine sync source reader (snapshotted before any --fs patch). Lives in
// state-util.js so there's a single source of truth shared with the bundler plugins;
// see that module for why it must not be a patched `node:fs` named import.
import { realReadFileSync } from './state-util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Snapshot the real functions now, while they're still the genuine builtins. The hooks
// below call THESE (never the patched `fs.*`), so there's no recursion, capture always
// sees real bytes, and the patched lstatSync/statSync/realpathSync fall back to them.
// realRealpathSync also backs realRootOf/realContained, whose containment checks must stay
// on the genuine builtin even after realpathSync is patched. (realReadFileSync, the sync
// source reader, is imported from state-util.js above -- only the dir/stat/realpath readers
// are snapshotted here, since only the --fs hook needs them.)
const realReaddirSync = fs.readdirSync
const realLstatSync = fs.lstatSync
const realStatSync = fs.statSync
const realRealpathSync = fs.realpathSync
const realRealpathSyncNative = fs.realpathSync.native
const realExistsSync = fs.existsSync
const realAccessSync = fs.accessSync

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

// Async access/realpath probe counterparts, snapshotted for `--fs=async`. The legacy callback
// fs.exists is deliberately NOT reassigned (deprecated, and wrapping would clobber its
// util.promisify.custom) -- but it still answers from the bundle under --fs=async, since Node
// implements it by delegating to the (now-patched) fs.access; under --fs=sync it falls through
// to disk like every other async API (desirable, consistent with existsSync). There is no
// fs.promises.exists. realpath's `.native` variant is snapshotted too.
const realAccess = fs.access
const realAccessP = fs.promises.access
const realRealpath = fs.realpath
const realRealpathNative = fs.realpath.native
const realRealpathP = fs.promises.realpath

// True iff an access() mode requests ONLY read-class bits (F_OK / R_OK) -- nothing implying
// mutation or execution. The bundle serves files read-only, so only such a request is answered
// from it; a W_OK/X_OK request defers to the real fs (truthful: ENOENT for a bundle-only file,
// real perms on disk). Phrased as an allowlist ("no bits outside READ_ACCESS") not a
// `& (W_OK|X_OK) === 0` denylist, so an out-of-range/garbage mode (e.g. 8) also defers and gets
// its faithful ERR_OUT_OF_RANGE. `| 0` coerces the default `undefined` to F_OK.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

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

// realpathSync/realpath honour an `encoding` arg exactly like fs: 'buffer' yields a Buffer,
// anything else (incl. the default 'utf8') a string. Used for the synthetic answer returned
// when a bundle-served path is gone from disk -- the real realpath would ENOENT there.
function encodeRealpath(abs, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding === 'buffer' ? Buffer.from(abs) : abs
}

// Source-map sidecars (`*.map`) are build-time debug artifacts that never affect a
// program's output, yet tools read them INDEPENDENTLY of any "sourcemaps off" setting
// (@babel/core's normalizeFile reads a transformed file's sibling `.js.map` to chain an
// INPUT source map regardless of devtool, skipping it via try/catch when absent). Under
// --fs such a map is treated as NON-EXISTENT: never captured (a stray map read can't abort
// a capture or bloat the lockfile/bundle), never served, faithful ENOENT in BOTH modes --
// returning ENOENT at CAPTURE too is what keeps a captured build byte-identical to a
// hermetic replay.
//
// NOT gated on bundle mode: --fs capture writes the lockfile (hashes, via addFile) as well
// as the bundle, so the skip can't depend on bundle mode. (The hook only runs under --fs,
// which always has a bundle mode, so no explicit check is needed.)
//
// Two opt-outs keep this from hiding a map a user genuinely wants:
//   - `map` in the resources allowlist -> captured + served as a normal resource
//     (classifyExtension tags `.map` 'resource' once `map` is allowed).
//   - at load, a map the bundle actually CARRIES is served regardless of the load run's
//     resources flag -- bundle membership wins, like every other recorded resource, so a map
//     captured under `--resources=map` still loads even if the load run forgets the flag (for
//     a skipped map getFsStatFamily returns undefined, so the common "never captured" case
//     still falls through to the ENOENT below).
// Uses getFsStatFamily, matching the serve paths: a map a bundler-plugin sidecar carries
// counts as carried by the family, not just by main.
function isSkippedSourceMap(state, abs) {
  if (!abs.toLowerCase().endsWith('.map')) return false
  if (state.config.resources?.has('map')) return false
  if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) return false
  return true
}

// A faithful Node-shaped ENOENT, so a skipped source map is indistinguishable from a
// genuinely absent file to the caller (code/errno/syscall/path all set, exactly what a
// real failed open/stat throws). Callers like @babel/core catch it and carry on.
function enoent(syscall, path) {
  const p = typeof path === 'string' ? path : Buffer.isBuffer(path) ? path.toString() : String(path)
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`)
  err.code = 'ENOENT'
  err.errno = -2
  err.syscall = syscall
  err.path = p
  return err
}

// File-type bits, so code that derives the kind from stats.mode (rather than the
// is*() methods) still sees file-vs-directory for an absent bundle-served path.
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

// Benign fs.Stats-shaped record for a recorded path served from the bundle but GONE from
// disk. isFile/isDirectory come from the bundle; the rest are neutral defaults (zeros, epoch
// Dates, file/dir mode bits) -- never a throw. This lets fs wrappers that read more than
// isFile()/isDirectory() keep working under bundle=load: graceful-fs's statFixSync reads
// stats.uid/gid, which would otherwise re-trigger the very ENOENT the bundle papers over.
// The other is*() are false -- the shim models only files and directories.
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
// always answer from the bundle's record (the point of the shim); every other member comes
// from the REAL stat while the file is on disk, and once it's gone realStatFn throws and we
// fall back to syntheticStat's benign defaults instead of forwarding the ENOENT. A Proxy so
// this covers the full Stats surface (methods AND numeric/Date fields) without enumerating it.
//
// `then` is short-circuited to undefined: a real fs.Stats is never thenable, but lazy
// resolution would otherwise forward the `then` probe of `await`/Promise resolution to
// realStatFn -- which THROWS for an absent file, making a bundle-served Stats an accidental
// rejecting thenable (`await lstatSync(x)` would reject with ENOENT for exactly the
// absent-from-disk case the shim exists to serve). Undefined keeps it non-thenable either way.
//
// Read-only: no `set` trap, so a write to a field (a wrapper normalising e.g. stats.uid)
// lands on the override target, not on `data`, and isn't reflected back on read. No real
// consumer needs mutate-then-read here -- graceful-fs only writes uid/gid when < 0, which the
// synthetic 0 (and modern Node) never hit.
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
        // Source-map sidecars are absent in both modes (see isSkippedSourceMap) -- before
        // any serve/capture so a `.js.map` is neither read from the bundle nor recorded.
        if (isSkippedSourceMap(state, abs)) throw enoent('open', path)
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          // Serve the captured bytes (consulting sidecar bundles too -- a bundler-plugin
          // sidecar may carry it). A path no family bundle recorded (or one recorded as a
          // directory) returns undefined and falls back to disk.
          const buf = state.getFsFileFamily(url)
          if (buf !== undefined) return decode(buf, options)
        } else if (state.config.writeBundle && !isLoadingModule()) {
          // (Skip while Node's loader reads a module's source -- captured as code by the
          // load hook, not a program fs read.) Read once via the real reader (faithful
          // errors on the user's path), record, and hand the user the same bytes. A capture
          // conflict (file read twice with diverging bytes) taints the run so nothing
          // inconsistent is written; the user's read still succeeds. A path whose real
          // location escapes the root (in-tree symlink) is read but NOT recorded -- its
          // content isn't in-bundle and must not be attested.
          const buf = realReadFileSync(path)
          // Skip a read a bundler-plugin sidecar already attests (the module graph webpack
          // reads through inputFileSystem) -- recording it here would duplicate the graph
          // into this (main) bundle. Reads no sidecar owns (the plugin's manual non-JS
          // file reads, etc.) ARE recorded here.
          if (realContained(state.root, abs) && !state.attestedBySidecar(url)) {
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
          const names = state.getFsDirFamily(url)
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

  // Capture-side stat recording, shared by the sync/async lstat/stat wrappers: record the
  // path's KIND (file vs directory) as a payload-free stat record (state.addFsStat), so the
  // type getters (isFile()/isDirectory(), the common existence-and-kind check) of a stat-ONLY
  // path answer from the bundle at load. Only those two kinds are modelled (the serve shim's
  // contract); a symlink (under lstat), socket, FIFO, or device records nothing. The caller
  // has already received (or will receive) the REAL Stats -- recording never alters what the
  // program sees. Guards mirror the byte readers: a path whose real location escapes the root
  // (in-tree symlink) is not attested, a file a write-mode sidecar already carries is skipped,
  // and a kind-flip conflict mid-run taints the capture via markAborted.
  const captureStat = (state, abs, stats) => {
    const isDir = stats.isDirectory()
    if (!isDir && !stats.isFile()) return
    const url = pathToFileURL(abs).toString()
    if (!realContained(state.root, abs) || state.attestedBySidecar(url)) return
    try { state.addFsStat(url, isDir ? 'directory' : 'file') } catch (err) { markAborted(err) }
  }

  fs.lstatSync = function lstatSync(path, options) {
    const state = getState()
    // Single-argument form. Serve (bundle=load) the bundle-backed type getters for a
    // recorded path; capture (bundle=add|replace) the observed kind via captureStat,
    // handing the caller the REAL Stats (and real errors, e.g. ENOENT) untouched.
    // A skipped source-map sidecar is reported absent in both modes.
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) throw enoent('lstat', path)
        if (state.config.loadBundle) {
          const kind = state.getFsStatFamily(pathToFileURL(abs).toString())
          if (kind !== undefined) return bundleStats(realLstatSync, path, kind === 'directory')
        } else if (state.config.writeBundle && !isLoadingModule()) {
          // (Node's loader stats module paths through internal bindings, not this
          // public API, but skip during a load window anyway, symmetric with
          // readFileSync/readdirSync.)
          const stats = realLstatSync(path)
          captureStat(state, abs, stats)
          return stats
        }
      }
    }
    return realLstatSync(path, options)
  }

  // statSync mirrors lstatSync exactly; the only difference is symlink following, moot for
  // a bundle-served path but relevant for the passthrough/present-on-disk case AND capture
  // -- a statSync of an in-root symlink records the TARGET's kind (keyed at the requested
  // path, like a byte read), while an lstatSync of it records nothing (a symlink isn't
  // modelled) -- so each uses its own real implementation.
  fs.statSync = function statSync(path, options) {
    const state = getState()
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) throw enoent('stat', path)
        if (state.config.loadBundle) {
          const kind = state.getFsStatFamily(pathToFileURL(abs).toString())
          if (kind !== undefined) return bundleStats(realStatSync, path, kind === 'directory')
        } else if (state.config.writeBundle && !isLoadingModule()) {
          const stats = realStatSync(path)
          captureStat(state, abs, stats)
          return stats
        }
      }
    }
    return realStatSync(path, options)
  }

  // existsSync / accessSync / realpathSync: existence + canonical-path PROBES, distinct from
  // the byte readers above. A build tool may check a file's existence (and realpath) on a
  // channel that never reads its bytes -- @babel/core guards config loading with
  // fs.existsSync(babel.config.js) and canonicalizes it with realpath BEFORE require()ing it.
  // Under bundle=load the bytes come from the bundle, but without serving these probes too the
  // file would still have to exist on disk or the tool concludes it's absent and skips it.
  // Serve-only, like lstat/stat: a recorded path answers from getFsStatFamily (so a file a
  // bundler-plugin sidecar carries answers here too -- a check-then-read tool sees it);
  // everything else -- and all of capture mode -- falls through to the real call. A skipped
  // source-map sidecar is reported absent in both modes, matching readFileSync/statSync.
  fs.existsSync = function existsSync(path) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) return false
        if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) return true
      }
    }
    return realExistsSync(path)
  }

  fs.accessSync = function accessSync(path, mode) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) throw enoent('access', path)
        // The bundle serves files READ-ONLY: a carried path satisfies an existence/read probe
        // (F_OK / R_OK -- what build tools check), but a write/exec probe (W_OK / X_OK) is not
        // ours to grant, so it falls through to the real fs (which reports a bundle-only,
        // absent-on-disk file as not writable). Unrecorded paths and capture mode also defer.
        if (state.config.loadBundle && isReadOnlyAccessMode(mode) &&
            state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) {
          return undefined
        }
      }
    }
    return realAccessSync(path, mode)
  }

  // realpathSync carries a `.native` variant (enhanced-resolve and some tools call it);
  // both share this serve logic. Try the real realpath first so a path still on disk gets
  // true symlink resolution; fall back to the lexically-resolved abs once it's gone
  // (bundle-served) -- ancestor symlinks aren't re-resolved in that fallback.
  const servedRealpathSync = (realFn) => function realpathSync(path, options) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) throw enoent('realpath', path)
        if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) {
          try { return realFn(path, options) } catch { return encodeRealpath(abs, options) }
        }
      }
    }
    return realFn(path, options)
  }
  fs.realpathSync = servedRealpathSync(realRealpathSync)
  fs.realpathSync.native = servedRealpathSync(realRealpathSyncNative)

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
      // Source-map sidecars are absent in both modes (see isSkippedSourceMap); 'absent'
      // makes the read/stat wrappers below hand back ENOENT instead of serving/capturing.
      if (isSkippedSourceMap(state, abs)) return { mode: 'absent', abs }
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
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('open', path))); return }
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFileFamily(t.url)
        if (buf !== undefined) { queueMicrotask(() => decodeToCb(cb, buf, opts)); return }
      } else if (t?.mode === 'capture') {
        realReadFile(path, (err, buf) => {
          if (err) return cb(err)
          // Skip what a sidecar already attests (see readFileSync); record only the rest.
          if (realContained(t.state.root, t.abs) && !t.state.attestedBySidecar(t.url)) { try { t.state.addFsFile(t.url, buf) } catch (e) { markAborted(e) } }
          decodeToCb(cb, buf, opts)
        })
        return
      }
      return realReadFile(path, options, callback)
    }

    fs.promises.readFile = async function readFile(path, options) {
      const t = fsTarget(path)
      if (t?.mode === 'absent') throw enoent('open', path)
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFileFamily(t.url)
        if (buf !== undefined) return decode(buf, options)
      } else if (t?.mode === 'capture') {
        const buf = await realReadFileP(path)
        // Skip what a sidecar already attests (see readFileSync); record only the rest.
        if (realContained(t.state.root, t.abs) && !t.state.attestedBySidecar(t.url)) { try { t.state.addFsFile(t.url, buf) } catch (e) { markAborted(e) } }
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
        const names = t.state.getFsDirFamily(t.url)
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
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return names
      } else if (t?.mode === 'capture') {
        const names = await realReaddirP(path)
        if (realContained(t.state.root, t.abs)) { try { t.state.addFsDir(t.url, names) } catch (e) { markAborted(e) } }
        return names
      }
      return realReaddirP(path, options)
    }

    // lstat/stat capture and serve exactly like their sync siblings: serve the
    // bundle-backed type getters, or record the real call's observed kind via
    // captureStat while handing the caller the real Stats. bundleStats's field
    // fallback is synchronous, so it uses the sync real stat.
    fs.lstat = function lstat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // "single-argument" form (path, cb) or (path, null/undefined, cb) -- see readdir's
      // note above on why a null options must count as "no options" (graceful-fs).
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('lstat', path))); return }
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) { queueMicrotask(() => cb(null, bundleStats(realLstatSync, path, kind === 'directory'))); return }
      } else if (t?.mode === 'capture') {
        realLstat(path, (err, stats) => {
          if (err) return cb(err) // faithful error on the user's original path; nothing recorded
          captureStat(t.state, t.abs, stats)
          cb(null, stats)
        })
        return
      }
      return realLstat(path, options, callback)
    }

    fs.stat = function stat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // "single-argument" form (path, cb) or (path, null/undefined, cb) -- see readdir's
      // note above on why a null options must count as "no options" (graceful-fs).
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('stat', path))); return }
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) { queueMicrotask(() => cb(null, bundleStats(realStatSync, path, kind === 'directory'))); return }
      } else if (t?.mode === 'capture') {
        realStat(path, (err, stats) => {
          if (err) return cb(err)
          captureStat(t.state, t.abs, stats)
          cb(null, stats)
        })
        return
      }
      return realStat(path, options, callback)
    }

    fs.promises.lstat = async function lstat(path, options) {
      const t = options == null ? fsTarget(path) : null
      if (t?.mode === 'absent') throw enoent('lstat', path)
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) return bundleStats(realLstatSync, path, kind === 'directory')
      } else if (t?.mode === 'capture') {
        const stats = await realLstatP(path)
        captureStat(t.state, t.abs, stats)
        return stats
      }
      return realLstatP(path, options)
    }

    fs.promises.stat = async function stat(path, options) {
      const t = options == null ? fsTarget(path) : null
      if (t?.mode === 'absent') throw enoent('stat', path)
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) return bundleStats(realStatSync, path, kind === 'directory')
      } else if (t?.mode === 'capture') {
        const stats = await realStatP(path)
        captureStat(t.state, t.abs, stats)
        return stats
      }
      return realStatP(path, options)
    }

    // Access + realpath probes, async forms (serve-only, mirroring the sync siblings and
    // reusing fsTarget: 'serve' answers from the bundle when the path is recorded, 'absent'
    // is a skipped source map, and capture / unrecorded paths fall through to the real call).
    fs.access = function access(path, mode, callback) {
      const cb = typeof mode === 'function' ? mode : callback
      // Read-only serve: a W_OK/X_OK probe is deferred to the real fs (see accessSync).
      const accessMode = typeof mode === 'function' ? undefined : mode
      const t = typeof cb === 'function' ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('access', path))); return }
      if (t?.mode === 'serve' && isReadOnlyAccessMode(accessMode) && t.state.getFsStatFamily(t.url) !== undefined) {
        queueMicrotask(() => cb(null)); return
      }
      return realAccess(path, mode, callback)
    }

    fs.promises.access = async function access(path, mode) {
      const t = fsTarget(path)
      if (t?.mode === 'absent') throw enoent('access', path)
      // Read-only serve: a W_OK/X_OK probe is deferred to the real fs (see accessSync).
      if (t?.mode === 'serve' && isReadOnlyAccessMode(mode) && t.state.getFsStatFamily(t.url) !== undefined) return undefined
      return realAccessP(path, mode)
    }

    const servedRealpath = (realFn) => function realpath(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? undefined : options
      const t = typeof cb === 'function' ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('realpath', path))); return }
      if (t?.mode === 'serve' && t.state.getFsStatFamily(t.url) !== undefined) {
        // Real first (symlink resolution while present); lexically-resolved abs once gone.
        realFn(path, opts, (err, resolved) => (err ? cb(null, encodeRealpath(t.abs, opts)) : cb(null, resolved)))
        return
      }
      return realFn(path, options, callback)
    }
    fs.realpath = servedRealpath(realRealpath)
    fs.realpath.native = servedRealpath(realRealpathNative)

    fs.promises.realpath = async function realpath(path, options) {
      const t = fsTarget(path)
      if (t?.mode === 'absent') throw enoent('realpath', path)
      if (t?.mode === 'serve' && t.state.getFsStatFamily(t.url) !== undefined) {
        try { return await realRealpathP(path, options) } catch { return encodeRealpath(t.abs, options) }
      }
      return realRealpathP(path, options)
    }
  }

  // Refresh the node:fs (and node:fs/promises) ESM wrappers so user-code destructured/namespace
  // ESM imports resolve to the patched functions -- repointing a LIVE `import { existsSync }
  // from 'node:fs'` binding whether the module evaluated before or after this.
  // INVARIANT: stasis's own run-graph modules must stay on the genuine builtin. The run-graph
  // ones (state.js, state-util.js, util.js) snapshot fs at module-eval via `const { ... } = fs`
  // and are immune. The bundler plugins (webpack.js / metro.js) DO live-import, but never reach
  // it in load mode (apply()/#run route away from the capture path) and capture-mode probes are
  // byte-for-byte transparent; the CLI subcommands/loaders/launcher (prune, scan, bundle,
  // extract, the language loaders, the bins) run in processes where installFsHooks never fires.
  // A NEW stasis module that needs real fs under --fs must snapshot (`const { x } = fs`), not
  // live-import.
  syncBuiltinESMExports()
}
