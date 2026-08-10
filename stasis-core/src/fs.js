// `stasis run --fs=sync|async`: monkey-patch the fs readers (readFileSync/readdirSync/lstat/stat
// + existence/realpath probes; under =async their callback + fs.promises counterparts) to capture a
// program's explicit reads into the bundle (bundle=add|replace) or serve them from it (bundle=load).
// SECURITY INVARIANT: only paths whose REAL path (symlinks resolved) stays inside the project root are
// captured/served; anything else falls through to the real fs and is never attested.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { realReadFileSync } from './state-util.js'
import { isDotEnvFile, isStasisArtifactName } from './util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Snapshot the real fns while still genuine builtins; the hooks call THESE, never patched `fs.*`, so
// there's no recursion and capture/containment always see real bytes/paths.
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

// The legacy callback fs.exists is deliberately NOT reassigned (wrapping would clobber its
// util.promisify.custom); it still answers via the patched fs.access.
const realAccess = fs.access
const realAccessP = fs.promises.access
const realRealpath = fs.realpath
const realRealpathNative = fs.realpath.native
const realRealpathP = fs.promises.realpath

// The bundle serves read-only, so only an F_OK/R_OK-only mode may be answered from it; allowlist form
// so a W_OK/X_OK or out-of-range mode defers to the real fs.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

// Resolve a path argument to an absolute path, or null for what we don't capture (fd, non-file URL).
function toAbsPath(path) {
  if (typeof path === 'string') return resolve(path)
  if (Buffer.isBuffer(path)) return resolve(path.toString())
  if (path instanceof URL) return path.protocol === 'file:' ? fileURLToPath(path) : null
  return null
}

// True when `abs` is the project root or lives beneath it -- lexical only (see realContained).
function withinRoot(root, abs) {
  const rel = relative(root, abs)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

let realRootCache
function realRootOf(root) {
  if (realRootCache?.root !== root) {
    let real
    try { real = realRealpathSync(root) } catch { real = root }
    realRootCache = { root, real }
  }
  return realRootCache.real
}

// Capture-side containment: the path's REAL location must stay inside root's real path, else an
// in-tree symlink pointing OUT would pull external content into the signed bundle.
function realContained(root, abs) {
  let real
  try { real = realRealpathSync(abs) } catch { return false }
  const rel = relative(realRootOf(root), real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// At the project root, drop stasis's own artifacts from the RECORDED listing so it doesn't depend on
// whether an earlier run left them behind; the program still receives the true on-disk `names`.
function dirCaptureNames(root, abs, names) {
  if (relative(root, abs) !== '') return names
  return names.filter((name) => !isStasisArtifactName(name))
}

// Apply readFileSync's encoding arg to raw bytes; Buffer.toString matches fs's ERR_UNKNOWN_ENCODING.
function decode(buf, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  if (encoding == null) return buf
  return buf.toString(encoding)
}

// Honour realpath's `encoding` arg for the synthetic answer when a bundle-served path is gone from disk.
function encodeRealpath(abs, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding === 'buffer' ? Buffer.from(abs) : abs
}

// Source-map sidecars (`*.map`) are NON-EXISTENT under --fs (faithful ENOENT in both modes, so a
// captured build replays byte-identically). Opt out via `map` in resources, or bundle membership.
function isSkippedSourceMap(state, abs) {
  if (!abs.toLowerCase().endsWith('.map')) return false
  if (state.config.resources?.has('map')) return false
  if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) return false
  return true
}

// `.env`/`.env.*` are NON-EXISTENT under --fs so an automated capture can never bake a secret in. No
// resources opt-in: the ONE way one serves at load is membership (an explicit `stasis add .env`).
function isSkippedEnvFile(state, abs) {
  if (!isDotEnvFile(abs)) return false
  if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) return false
  return true
}

function isSkippedFsPath(state, abs) {
  return isSkippedSourceMap(state, abs) || isSkippedEnvFile(state, abs)
}

// A faithful Node-shaped ENOENT, indistinguishable from a real absent file.
function enoent(syscall, path) {
  const p = typeof path === 'string' ? path : Buffer.isBuffer(path) ? path.toString() : String(path)
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`)
  err.code = 'ENOENT'
  err.errno = -2
  err.syscall = syscall
  err.path = p
  return err
}

// File-type bits, so code reading stats.mode (not the is*() methods) still sees file-vs-dir.
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

// Neutral fs.Stats-shaped record for a bundle-served path gone from disk; never throws, so wrappers
// reading uid/gid etc. keep working.
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
// members from the REAL stat while on disk, else syntheticStat. `then` is short-circuited so a
// bundle-served Stats is never an accidental (rejecting) thenable under `await`.
function bundleStats(realStatFn, statPath, isDir) {
  let data
  const overrides = { isFile: () => !isDir, isDirectory: () => isDir }
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'isFile' || prop === 'isDirectory') return target[prop]
      if (prop === 'then') return undefined
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
  if (installed) return
  installed = true

  fs.readFileSync = function readFileSync(path, options) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedFsPath(state, abs)) throw enoent('open', path)
        const url = pathToFileURL(abs).toString()
        if (state.config.loadBundle) {
          const buf = state.getFsFileFamily(url)
          if (buf !== undefined) return decode(buf, options)
        } else if (state.config.writeBundle && !isLoadingModule()) {
          const buf = realReadFileSync(path)
          // A path whose real location escapes root (in-tree symlink) is read but NOT recorded, and
          // neither is a read a bundler-plugin sidecar already attests.
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
          // As in readFileSync: a dir whose real path escapes root is not recorded.
          if (realContained(state.root, abs)) {
            try { state.addFsDir(url, dirCaptureNames(state.root, abs, names)) } catch (err) { markAborted(err) }
          }
          return names
        }
      }
    }
    return realReaddirSync(path, options)
  }

  // Shared capture-side stat recording: record the path's KIND as a payload-free stat record so a
  // stat-ONLY path's type getters answer at load. Only file and dir are modelled.
  const captureStat = (state, abs, stats) => {
    const isDir = stats.isDirectory()
    if (!isDir && !stats.isFile()) return
    const url = pathToFileURL(abs).toString()
    if (!realContained(state.root, abs) || state.attestedBySidecar(url)) return
    try { state.addFsStat(url, isDir ? 'directory' : 'file') } catch (err) { markAborted(err) }
  }

  fs.lstatSync = function lstatSync(path, options) {
    const state = getState()
    // Single-arg form only; capture still hands the caller the REAL Stats/errors.
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedFsPath(state, abs)) throw enoent('lstat', path)
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

  // Mirrors lstatSync but follows symlinks, so it must use the real statSync: an in-root symlink
  // records the TARGET's kind here, nothing under lstatSync.
  fs.statSync = function statSync(path, options) {
    const state = getState()
    if (state && options == null) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedFsPath(state, abs)) throw enoent('stat', path)
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

  // existsSync/accessSync/realpathSync: existence + canonical-path PROBES, serve-only (bundle=load) --
  // a tool may probe before reading bytes (@babel/core does); capture mode and unrecorded paths defer.
  fs.existsSync = function existsSync(path) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedFsPath(state, abs)) return false
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
        if (isSkippedFsPath(state, abs)) throw enoent('access', path)
        if (state.config.loadBundle && isReadOnlyAccessMode(mode) &&
            state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) {
          return undefined
        }
      }
    }
    return realAccessSync(path, mode)
  }

  // Try the real realpath first (true symlink resolution while on disk), fall back to the lexical abs
  // once gone (ancestor symlinks not re-resolved then).
  const servedRealpathSync = (realFn) => function realpathSync(path, options) {
    const state = getState()
    if (state) {
      const abs = toAbsPath(path)
      if (abs !== null && withinRoot(state.root, abs)) {
        if (isSkippedFsPath(state, abs)) throw enoent('realpath', path)
        if (state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined) {
          try { return realFn(path, options) } catch { return encodeRealpath(abs, options) }
        }
      }
    }
    return realFn(path, options)
  }
  fs.realpathSync = servedRealpathSync(realRealpathSync)
  fs.realpathSync.native = servedRealpathSync(realRealpathSyncNative)

  // --fs=async counterparts; a served callback is deferred (queueMicrotask) to preserve fs's
  // always-async contract.
  if (patchAsync) {
    // Classify a path as the sync readers do: 'serve', 'capture', 'absent', or null (pass through).
    const fsTarget = (path) => {
      const state = getState()
      if (!state) return null
      const abs = toAbsPath(path)
      if (abs === null || !withinRoot(state.root, abs)) return null
      if (isSkippedFsPath(state, abs)) return { mode: 'absent', abs }
      const url = pathToFileURL(abs).toString()
      if (state.config.loadBundle) return { mode: 'serve', state, url, abs }
      if (state.config.writeBundle && !isLoadingModule()) return { mode: 'capture', state, url, abs }
      return null
    }

    // Route a decode error to the callback (as fs.readFile does); a throw from a deferred callback
    // would escape as an uncaught exception and crash the process.
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
        if (realContained(t.state.root, t.abs) && !t.state.attestedBySidecar(t.url)) { try { t.state.addFsFile(t.url, buf) } catch (e) { markAborted(e) } }
        return decode(buf, options)
      }
      return realReadFileP(path, options)
    }

    fs.readdir = function readdir(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      // Single-arg form only, and a null options must count as "no options" (graceful-fs normalises to
      // that), else its reads never hit the bundle.
      const t = ((options == null || typeof options === 'function') && typeof cb === 'function') ? fsTarget(path) : null
      if (t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) { queueMicrotask(() => cb(null, names)); return }
      } else if (t?.mode === 'capture') {
        realReaddir(path, (err, names) => {
          if (err) return cb(err)
          if (realContained(t.state.root, t.abs)) { try { t.state.addFsDir(t.url, dirCaptureNames(t.state.root, t.abs, names)) } catch (e) { markAborted(e) } }
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
        if (realContained(t.state.root, t.abs)) { try { t.state.addFsDir(t.url, dirCaptureNames(t.state.root, t.abs, names)) } catch (e) { markAborted(e) } }
        return names
      }
      return realReaddirP(path, options)
    }

    // lstat/stat mirror their sync siblings; bundleStats's field fallback stays sync.
    fs.lstat = function lstat(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
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

    fs.access = function access(path, mode, callback) {
      const cb = typeof mode === 'function' ? mode : callback
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
      if (t?.mode === 'serve' && isReadOnlyAccessMode(mode) && t.state.getFsStatFamily(t.url) !== undefined) return undefined
      return realAccessP(path, mode)
    }

    const servedRealpath = (realFn) => function realpath(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? undefined : options
      const t = typeof cb === 'function' ? fsTarget(path) : null
      if (t?.mode === 'absent') { queueMicrotask(() => cb(enoent('realpath', path))); return }
      if (t?.mode === 'serve' && t.state.getFsStatFamily(t.url) !== undefined) {
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
  // INVARIANT: a stasis module needing the real fs must snapshot it (`const { ... } = fs`), never live-import.
  syncBuiltinESMExports()
}
