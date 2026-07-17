import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

// Companion to the StasisMetro serializer plugin: the LOAD half of stasis for Metro.
//
// WHY A TRANSFORMER (the asymmetry that makes this possible):
//   Capture must MERGE every worker's observations into one lockfile/bundle, so it
//   runs in the main process (the serializer -- see metro.js). Load is the opposite:
//   it only ever READS an immutable bundle, and every worker reads the SAME bytes, so
//   there is nothing to synchronize between them. That makes the per-worker transformer
//   the natural seam for load -- each worker independently serves attested bytes, no IPC.
//
// HOW IT WIRES IN (metro.config.js) -- wire it PERMANENTLY, alongside the serializer half:
//   module.exports = {
//     transformerPath: require.resolve('@exodus/stasis/metro-transformer'),  // top-level, a sibling of `transformer`
//   }
//   // run with EXODUS_STASIS_BUNDLE=load (+ EXODUS_STASIS_BUNDLE_FILE / LOCK / SCOPE),
//   // OR a stasis.config.json with "bundle":"load". Outside load mode this transformer
//   // is a transparent pass-through (see getLoadState), and under load the StasisMetro
//   // serializer is one too -- so a single committed metro.config.js carries both
//   // halves and the mode picks which is active. That symmetry is load-bearing:
//   // metro.config.js is itself attested at capture, so a load/frozen run must
//   // execute it byte-identical -- neither half can demand mode-specific edits.
//
//   Metro calls `transformerPath`'s `transform(config, projectRoot, filename, data,
//   options)` in each worker with `data` = the file's on-disk bytes (a Buffer) and
//   `filename` project-relative. We wrap the user's real transformer (default
//   `metro-transform-worker`, override via EXODUS_STASIS_METRO_BASE_TRANSFORMER) and,
//   in load mode, replace `data` with the bundle's attested bytes before delegating --
//   so the transform consumes bundle bytes, hash-verified, fail-closed.
//
// WHAT THIS DOES AND DOESN'T GUARANTEE:
//   - The bytes that get TRANSFORMED are the bundle's, verified by State.getFile
//     (against the lockfile when one is loaded; against the bundle's own bytes under
//     lock=none). A tampered on-disk source is therefore ignored for the build output
//     and, under a lockfile, rejected outright. An in-scope file the bundle doesn't
//     carry throws -- never a silent disk fallback. Out-of-scope files pass their disk
//     bytes through untouched (mirrors webpack/esbuild load scope handling).
//   - KNOWN LIMITATION: this does NOT let Metro build with the sources fully absent
//     from disk. Metro reads each file from disk in the worker (and hashes it in the
//     main process for its transform cache) BEFORE this transformer runs, and resolves
//     package.json via its own fs in the main process. Serving those reads from the
//     bundle would need fs interception across the main + worker processes (stasis
//     --mock territory), which is larger than this seam. So today's guarantee is
//     "build the bundle's attested bytes, fail closed on disk drift," not "build from
//     a bundle with no source tree." This mirrors the documented node_modules-crossing
//     gap in the webpack load path.

const require = createRequire(import.meta.url)

// The real transformer we wrap. Default matches Metro's default; an app with a custom
// transformer (e.g. a TS/Babel preset) points this at theirs so we sit transparently
// in front of it. Resolved + required lazily (per worker process) so a non-load build
// pays nothing and we don't require Metro internals at import time.
const BASE_TRANSFORMER = process.env.EXODUS_STASIS_METRO_BASE_TRANSFORMER || 'metro-transform-worker'

let base
function getBase() {
  base ??= require(BASE_TRANSFORMER)
  return base
}

// Per-worker load State, built once. We construct a normal State (it reads the same
// EXODUS_STASIS_* env + stasis.config.json the rest of stasis does) and only act when
// it resolves to load mode; any other mode -> null -> this transformer is a transparent
// pass-through, so wiring it permanently in metro.config.js is safe.
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

// True iff `absolute` is a path the bundle is supposed to cover under load mode.
// `state.relative` throws for paths outside the project root, which we treat as
// out-of-scope (system files, scratch dirs) and defer to disk. Mirrors the webpack
// plugin's load-mode inScope.
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
    // `filename` is project-relative in Metro's transformer contract; resolve against
    // projectRoot (resolvePath ignores projectRoot when filename is already absolute).
    const absolute = resolvePath(projectRoot, filename)
    if (inScope(state, absolute)) {
      // getFile re-verifies the hash against the lockfile on every read and throws on a
      // file the bundle doesn't carry -- so an in-scope path the bundle is missing
      // surfaces here as a hard build error, not a silent disk fallback. Code sources
      // come back as strings; resources as Buffers (already decoded from base64).
      const { source } = state.getFile(pathToFileURL(absolute).toString())
      data = Buffer.isBuffer(source) ? source : Buffer.from(source)
    }
  }
  return getBase().transform(config, projectRoot, filename, data, options)
}

export function getCacheKey(config) {
  // Fold the wrapped transformer's own cache key in (so changing the base transformer
  // still invalidates), then add a stasis-load discriminator: load-mode transforms can
  // produce different bytes than a disk build for the same file (and Metro hashes the
  // on-disk bytes into its cache key BEFORE we substitute, so when disk == bundle the
  // content hash alone wouldn't tell a load result apart from a plain build), so their
  // cached results must not cross-pollinate. Derive the marker from the resolved load
  // State -- the SAME source of truth as transform() -- not the env var, so load activated
  // via stasis.config.json is keyed correctly too; the bundle path keys it to the bundle.
  const baseKey = typeof getBase().getCacheKey === 'function' ? getBase().getCacheKey(config) : ''
  const state = getLoadState()
  const marker = state ? `load:${state.config.bundleFile || 'default'}` : 'off'
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
