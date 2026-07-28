import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

// Companion to the StasisMetro serializer: the LOAD half of stasis for Metro. Load only READS an
// immutable bundle and every worker reads the same bytes (no IPC), so a per-worker transformer is
// the natural seam. Wire it permanently in metro.config.js (transformerPath); outside load mode it
// is a transparent pass-through, and under load the serializer is too -- the mode picks the active
// half. In load mode, wrap the user's real transformer and replace Metro's on-disk `data` with the
// bundle's hash-verified bytes (fail-closed; out-of-scope files pass their disk bytes through).
// KNOWN LIMITATION: does NOT build with sources absent from disk -- Metro reads + hashes each file
// before this runs, so the guarantee is "build attested bytes, fail closed on disk drift."

const require = createRequire(import.meta.url)

// Marker that this transformer is wired, readable by the serializer half IN THE SAME PROCESS (Metro
// requires transformerPath in the main process to compute the cache key, before the serializer runs).
// It tells StasisMetro that the cache-nonce lever below is available, so it needn't warn. Symbol.for
// so it reaches across duplicate stasis-plugins copies, matching stasis-core's live-State registry.
globalThis[Symbol.for('@exodus/stasis-plugins/metro-transformer')] = true

// The real transformer we wrap (default matches Metro's; override for a custom TS/Babel preset).
// Required lazily per worker so a non-load build pays nothing.
const BASE_TRANSFORMER = process.env.EXODUS_STASIS_METRO_BASE_TRANSFORMER || 'metro-transform-worker'

let base
function getBase() {
  base ??= require(BASE_TRANSFORMER)
  return base
}

// Per-worker load State, built once from the usual env + stasis.config.json. Non-load mode -> null
// -> transparent pass-through, so wiring it permanently is safe. A construction failure is cached
// and rethrown on every call -- never throw-once-then-silently-pass-through.
let stateInited = false
let loadState = null
let stateError = null
function getLoadState() {
  if (!stateInited) {
    try {
      const state = new State(process.cwd())
      loadState = state.config.loadBundle ? state : null
    } catch (err) {
      stateError = err
      throw err
    } finally {
      stateInited = true
    }
  }
  if (stateError) throw stateError
  return loadState
}

// True iff `absolute` is in scope for load mode. state.relative throws outside the project root
// (out-of-scope: system files, scratch) -> defer to disk. Mirrors the webpack plugin's inScope.
function inScope(state, absolute) {
  try {
    state.relative(absolute)
  } catch {
    return false
  }
  if (state.config.full) return true
  return state.inNodeModules(pathToFileURL(absolute).toString())
}

export function transform(config, projectRoot, filename, data, options) {
  const state = getLoadState()
  if (state) {
    // `filename` is project-relative in Metro's contract; resolve against projectRoot.
    const absolute = resolvePath(projectRoot, filename)
    if (inScope(state, absolute)) {
      // getFile re-verifies the hash and throws on a file the bundle doesn't carry (fail-closed,
      // no disk fallback). Code sources come back as strings; resources as Buffers.
      const { source } = state.getFile(pathToFileURL(absolute).toString())
      data = Buffer.isBuffer(source) ? source : Buffer.from(source)
    }
  }
  return getBase().transform(config, projectRoot, filename, data, options)
}

export function getCacheKey(config) {
  // Fold in the base transformer's cache key, then add a stasis-mode discriminator so results from
  // one mode don't cross-pollinate another's cache.
  //   load:<bundleFile> -- load results can differ from a disk build even when disk == bundle.
  //   capture:<nonce>   -- a per-RUN value StasisMetro mints for a capture/verify it could not drop
  //     `cacheStores` for (a hand-wired serializer; withStasis owns the config and drops them
  //     instead). Metro serves a cache HIT without calling a worker, so the toolchain the workers
  //     load would never be loaded in any process -- unattested under capture, unchecked under
  //     frozen, and the file degrades to a payload-free stat record. A value that changes per run
  //     makes every lookup miss, so the workers really run. Costs single-use entries in Metro's
  //     store, which is why withStasis prefers dropping the stores outright.
  // The load marker comes from the resolved State (not the env) so config.json activation keys too;
  // the nonce's absence is itself the signal that no capture needs forcing.
  const baseKey = typeof getBase().getCacheKey === 'function' ? getBase().getCacheKey(config) : ''
  const state = getLoadState()
  const nonce = process.env.EXODUS_STASIS_METRO_CACHE_NONCE
  let marker = 'off'
  if (state) marker = `load:${state.config.bundleFile || 'default'}`
  else if (nonce) marker = `capture:${nonce}`
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
