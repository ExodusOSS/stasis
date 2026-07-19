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

// The real transformer we wrap (default matches Metro's; override for a custom TS/Babel preset).
// Required lazily per worker so a non-load build pays nothing.
const BASE_TRANSFORMER = process.env.EXODUS_STASIS_METRO_BASE_TRANSFORMER || 'metro-transform-worker'

let base
function getBase() {
  base ??= require(BASE_TRANSFORMER)
  return base
}

// Per-worker load State, built once from the usual env + stasis.config.json. Non-load mode -> null
// -> transparent pass-through, so wiring it permanently is safe.
let stateInited = false
let loadState = null
function getLoadState() {
  if (!stateInited) {
    stateInited = true
    const state = new State(process.cwd())
    loadState = state.config.loadBundle ? state : null
  }
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
  // Fold in the base transformer's cache key, then add a stasis-load discriminator so load results
  // (which can differ from a disk build even when disk == bundle) don't cross-pollinate the cache.
  // Derive the marker from the resolved load State (not the env) so config.json activation keys too.
  const baseKey = typeof getBase().getCacheKey === 'function' ? getBase().getCacheKey(config) : ''
  const state = getLoadState()
  const marker = state ? `load:${state.config.bundleFile || 'default'}` : 'off'
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
