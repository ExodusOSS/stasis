// `stasis run --fs=sync|async`: monkey-patch the fs readers (readFileSync/readdirSync/lstat/stat
// + existence/realpath probes; under =async their callback + fs.promises counterparts) to capture a
// program's explicit reads into the bundle (bundle=add|replace) or serve them from it (bundle=load).
// SECURITY INVARIANT: only paths whose REAL path (symlinks resolved) stays inside the project root are
// captured/served; anything else falls through to the real fs and is never attested. Source-map
// sidecars (*.map) are treated as non-existent unless opted in via `map` in the resources allowlist.
// Mechanism (mirrors mock.js): snapshot the real fns at module-eval before install() patches, so
// stasis's own reads stay real; on install, replace the readers and syncBuiltinESMExports().

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The genuine sync source reader (snapshotted before any --fs patch), shared via state-util.js.
import { realReadFileSync } from './state-util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Snapshot the real functions while still genuine builtins. The hooks call THESE (never patched
// `fs.*`) so there's no recursion and capture/containment always see real bytes/paths.
const realReaddirSync = fs.readdirSync
const realLstatSync = fs.lstatSync
const realStatSync = fs.statSync
const realRealpathSync = fs.realpathSync
const realRealpathSyncNative = fs.realpathSync.native
const realExistsSync = fs.existsSync
const realAccessSync = fs.accessSync

// Async counterparts, snapshotted for `--fs=async`. fs.promises IS node:fs/promises (same object).
const realReadFile = fs.readFile
const realReaddir = fs.readdir
const realLstat = fs.lstat
const realStat = fs.stat
const realReadFileP = fs.promises.readFile
const realReaddirP = fs.promises.readdir
const realLstatP = fs.promises.lstat
const realStatP = fs.promises.stat

// Async access/realpath probe counterparts for `--fs=async`. The legacy callback fs.exists is NOT
// reassigned (wrapping would clobber its util.promisify.custom) but still answers via the patched fs.access.
const realAccess = fs.access
const realAccessP = fs.promises.access
const realRealpath = fs.realpath
const realRealpathNative = fs.realpath.native
const realRealpathP = fs.promises.realpath

// True iff an access() mode requests ONLY read-class bits (F_OK/R_OK). The bundle serves read-only,
// so a W_OK/X_OK (or garbage) mode defers to the real fs. Allowlist form so out-of-range modes defer too.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

// Resolve a path argument to an absolute path, or null for what we don't capture (fd, non-file URL).
function toAbsPath(path) {
  if (typeof path === 'string') return resolve(path)
  if (Buffer.isBuffer(path)) return resolve(path.toString())
  if (path instanceof URL) return path.protocol === 'file:' ? fileURLToPath(path) : null
  return null
}

// True when `abs` is the project root or lives beneath it (lexical); out-of-root reads defer to real fs.
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

// Capture-side containment: the path's REAL location (symlinks resolved) must stay inside root's real
// path, else an in-tree symlink pointing OUT would pull external content into the signed bundle. An
// escaping or vanished path returns false (leave it to the real fs, record nothing).
function realContained(root, abs) {
  let real
  try { real = realRealpathSync(abs) } catch { return false }
  const rel = relative(realRootOf(root), real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Apply readFileSync's encoding arg to raw bytes: no encoding yields the Buffer, else Buffer.toString
// (which throws ERR_UNKNOWN_ENCODING for an unknown encoding, matching fs).
function decode(buf, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  if (encoding == null) return buf
  return buf.toString(encoding)
}

// Honour realpath's `encoding` arg ('buffer' -> Buffer, else string) for the synthetic answer
// returned when a bundle-served path is gone from disk.
function encodeRealpath(abs, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding === 'buffer' ? Buffer.from(abs) : abs
}

// Source-map sidecars (`*.map`) are treated as NON-EXISTENT under --fs (never captured/served,
// faithful ENOENT in both modes -- keeps a captured build byte-identical to a hermetic replay).
// Opt out via `map` in the resources allowlist, or a map the bundle actually carries (membership wins).
function isSkippedSourceMap(state, abs) {
  if (!abs.toLowerCase().endsWith('.map')) return false
  if (state.config.resources?.has('map')) return false
  if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) return false
  return true
}

// A faithful Node-shaped ENOENT (code/errno/syscall/path set), indistinguishable from a real absent file.
function enoent(syscall, path) {
  const p = typeof path === 'string' ? path : Buffer.isBuffer(path) ? path.toString() : String(path)
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`)
  err.code = 'ENOENT'
  err.errno = -2
  err.syscall = syscall
  err.path = p
  return err
}

// File-type bits, so code reading stats.mode (not the is*() methods) sees file-vs-dir for an absent path.
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

// Benign fs.Stats-shaped record for a bundle-served path gone from disk: isFile/isDirectory from the
// bundle, the rest neutral defaults (never a throw), so wrappers reading uid/gid etc. keep working.
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

// A Stats-like Proxy for a bundle-served path: isFile()/isDirectory() answer from the bundle, other
// members from the REAL stat while on disk, falling back to syntheticStat once gone (not forwarding
// ENOENT). `then` is short-circuited to undefined so a bundle-served Stats is never an accidental
// (rejecting) thenable under `await`. Read-only (no set trap).
function bundleStats(realStatFn, statPath, isDir) {
  let data // real fs.Stats, or the synthetic fallback -- resolved once, on demand
  const overrides = { isFile: () => !isDir, isDirectory: () => isDir }
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'isFile' || prop === 'isDirectory') return target[prop]
      if (prop === 'then') return undefined // keep it non-thenable
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
  if (installed) return // idempotent
  installed = true

  fs.readFileSync = function readFileSync(path, options) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        // Source-map sidecars are absent in both modes (see isSkippedSourceMap).
        if (isSkippedSourceMap(state, abs)) throw enoent('open', path)
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          // Serve the captured bytes (family bundles too); undefined (unrecorded, or a dir) -> disk.
          const buf = state.getFsFileFamily(url)
          if (buf !== undefined) return decode(buf, options)
        } else if (state.config.writeBundle && !isLoadingModule()) {
          // Read once via the real reader (faithful errors), record, hand back the same bytes. A
          // conflict taints the run; a path escaping root (in-tree symlink) is read but NOT recorded.
          const buf = realReadFileSync(path)
          // Skip a read a bundler-plugin sidecar already attests (avoids duplicating its graph here).
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
    // Single-argument form only; any options pass straight through.
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          const names = state.getFsDirFamily(url)
          if (names !== undefined) return names // sorted at capture time
        } else if (state.config.writeBundle && !isLoadingModule()) {
          const names = realReaddirSync(path)
          // As in readFileSync: skip a dir whose real path escapes root, so no external listing is baked in.
          if (realContained(state.root, abs)) {
            try { state.addFsDir(url, names) } catch (err) { markAborted(err) }
          }
          return names
        }
      }
    }
    return realReaddirSync(path, options)
  }

  // Shared capture-side stat recording (sync/async lstat/stat): record the path's KIND (file vs dir)
  // as a payload-free stat record so a stat-ONLY path's type getters answer at load. Only those two
  // kinds are modelled; guards mirror the byte readers (escaping path/sidecar-carried/conflict).
  const captureStat = (state, abs, stats) => {
    const isDir = stats.isDirectory()
    if (!isDir && !stats.isFile()) return
    const url = pathToFileURL(abs).toString()
    if (!realContained(state.root, abs) || state.attestedBySidecar(url)) return
    try { state.addFsStat(url, isDir ? 'directory' : 'file') } catch (err) { markAborted(err) }
  }

  fs.lstatSync = function lstatSync(path, options) {
    const state = getState()
    // Single-arg form: serve the bundle-backed type getters, or capture the observed kind via
    // captureStat while handing the caller the REAL Stats/errors. Skipped source map: absent both modes.
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedSourceMap(state, abs)) throw enoent('lstat', path)
        if (state.config.loadBundle) {
          const kind = state.getFsStatFamily(pathToFileURL(abs).toString())
          if (kind !== undefined) return bundleStats(realLstatSync, path, kind === 'directory')
        } else if (state.config.writeBundle && !isLoadingModule()) {
          const stats = realLstatSync(path)
          captureStat(state, abs, stats)
          return stats
        }
      }
    }
    return realLstatSync(path, options)
  }

  // statSync mirrors lstatSync; the difference is symlink following (a statSync of an in-root symlink
  // records the TARGET's kind, an lstatSync records nothing), so each uses its own real implementation.
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

  // existsSync/accessSync/realpathSync: existence + canonical-path PROBES (serve-only, bundle=load).
  // A tool may check existence/realpath before reading bytes (@babel/core guards config loading that
  // way), so a recorded path answers from getFsStatFamily; unrecorded paths and capture mode defer.
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
        // Read-only serve: a carried path satisfies F_OK/R_OK; a W_OK/X_OK probe defers to the real fs.
        if (state.config.loadBundle && isReadOnlyAccessMode(mode) &&
            state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) {
          return undefined
        }
      }
    }
    return realAccessSync(path, mode)
  }

  // realpathSync + its `.native` variant share this: try real realpath first (true symlink resolution
  // while on disk), fall back to the lexical abs once gone (ancestor symlinks not re-resolved then).
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

  // --fs=async: the async counterparts, each sharing its sync sibling's capture/serve logic via
  // fsTarget(). A served callback is deferred (queueMicrotask) to preserve fs's always-async contract.
  if (patchAsync) {
    // Classify a path as the sync readers do: 'serve', 'capture', 'absent', or null (pass through).
    const fsTarget = (path) => {
      const state = getState()
      if (!state) return null
      const abs = toAbsPath(path)
      if (abs === null || !withinRoot(state.root, abs)) return null
      // Skipped source map -> 'absent' so the wrappers below hand back ENOENT.
      if (isSkippedSourceMap(state, abs)) return { mode: 'absent', abs }
      const url = pathToFileURL(abs).toString()
      if (state.config.loadBundle) return { mode: 'serve', state, url, abs }
      if (state.config.writeBundle && !isLoadingModule()) return { mode: 'capture', state, url, abs }
      return null
    }

    // Decode bytes for a callback reader, routing a decode error to the callback (as fs.readFile does);
    // otherwise the throw escapes the deferred callback as an uncaught exception and crashes the process.
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
      // Single-arg form fn(path, cb) or fn(path, null/undefined, cb): a null options must count as
      // "no options" (graceful-fs normalises to that), else its reads never hit the bundle.
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

    // lstat/stat capture and serve like their sync siblings; bundleStats's field fallback is sync.
    fs.lstat = function lstat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // Single-arg form -- see readdir's note on why a null options counts as "no options".
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('lstat', path))); return }
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) { queueMicrotask(() => cb(null, bundleStats(realLstatSync, path, kind === 'directory'))); return }
      } else if (t?.mode === 'capture') {
        realLstat(path, (err, stats) => {
          if (err) return cb(err)
          captureStat(t.state, t.abs, stats)
          cb(null, stats)
        })
        return
      }
      return realLstat(path, options, callback)
    }

    fs.stat = function stat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // Single-arg form -- see readdir's note on why a null options counts as "no options".
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

    // Access + realpath probes, async forms (serve-only, mirroring the sync siblings via fsTarget).
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

  // Refresh the node:fs (+ node:fs/promises) ESM wrappers so user-code live imports see the patched fns.
  // INVARIANT: stasis's own run-graph modules must stay on the genuine builtin -- they snapshot fs via
  // `const { ... } = fs` and are immune. A NEW stasis module needing real fs under --fs must snapshot too, not live-import.
  syncBuiltinESMExports()
}
