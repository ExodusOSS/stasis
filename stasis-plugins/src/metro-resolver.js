import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { EMPTY_MODULE_PATH } from '@exodus/stasis-core/util'

// Companion to the StasisMetro serializer plugin and the worker transformer: the
// RESOLUTION half of load mode for Metro.
//
// WHY METRO NEEDS THIS (and webpack/esbuild don't):
//   Metro resolves with its own in-process resolver (metro-resolver + the crawled file
//   map) in the MAIN process -- it never consults Node's module resolution, so none of
//   the stasis load machinery (the ESM resolve hook, the CJS Module._resolveFilename
//   shim, the --fs reader patches) is on its path. It re-derives every resolution from
//   the filesystem: name resolution probes literal layouts (`pkg/helpers/x` as
//   `<nm>/pkg/helpers/x(.js|.<platform>.js|...)`), package.json redirects, the Haste
//   map. A bundle=load tree is attested-files-only -- it carries the files resolution
//   LANDED ON at capture, not the alias layouts/manifests the probing walks through
//   (e.g. `@babel/runtime`'s `helpers/*` specifiers whose package.json redirect lands
//   on other files: only the targets were loaded, so only the targets are attested) --
//   so Metro's re-derivation dies with UnableToResolveError on paths the bundle serves
//   perfectly well. The bundle already carries the ANSWER: capture records every graph
//   edge as (parent, as-written specifier) -> resolved file (the serializer's
//   addImport; the Node loader's, for a runtime capture). This plugin is the missing
//   consumer: it replays those recorded edges through Metro's own extension point,
//   `resolver.resolveRequest`, which runs exactly where the resolver lives (the main
//   process), so no cross-process state is needed -- the same asymmetry that lets load
//   bytes live in the per-worker transformer.
//
// HOW IT WIRES IN (metro.config.js) -- wire it PERMANENTLY, alongside the other halves:
//   const { resolveRequest } = require('@exodus/stasis/metro-resolver')
//   module.exports = {
//     resolver: { resolveRequest },  // nested under `resolver` (unlike transformerPath, a top-level key)
//     transformerPath: require.resolve('@exodus/stasis/metro-transformer'),
//   }
//   // run with EXODUS_STASIS_BUNDLE=load (+ EXODUS_STASIS_BUNDLE_FILE / LOCK / SCOPE),
//   // OR a stasis.config.json with "bundle":"load", OR under `stasis run --bundle=load`.
//   // Outside load mode this resolver and the transformer pass through, and under load
//   // the StasisMetro serializer does -- one committed metro.config.js carries all three
//   // and the mode picks the active pieces (the config is itself attested at capture, so
//   // a load run must execute it unedited -- see the class note in metro.js).
//   // An app with its own resolveRequest composes via createResolveRequest(theirs):
//   // stasis serves recorded edges first and defers misses to theirs.
//
//   NB -- WIRING CHANGES NEED A FRESH CAPTURE. Because a load run executes the ATTESTED
//   metro.config.js (served from the bundle, not read from disk), adding this resolver to
//   the on-disk config does NOTHING for an existing artifact: the old attested config --
//   without the resolver -- is what runs, and the resolver's own module files aren't in
//   the bundle to be loaded anyway. Re-capture with the resolver wired, then load. Run
//   with EXODUS_STASIS_DEBUG=1 to see whether the resolver is live and what it serves.
//
// NO-SOURCE-TREE BUILDS -- MATERIALIZE WITH `stasis extract` FIRST:
//   Metro cannot build from a bundle alone, resolver or not: metro-file-map enumerates
//   files by crawling the watch folders with watchman or native `find` (child processes
//   -- no fs seam to serve), the transform cache demands a file-map SHA-1 for every
//   resolved file, and each worker pre-reads its file from disk BEFORE the stasis
//   transformer swaps in attested bytes. None of that is interceptable through Metro
//   config. The supported no-disk flow therefore starts from the artifact and
//   materializes the attested tree:
//     stasis extract --output=work app.stasis.code.br   # attested files + stasis.lock.json
//     cd work && stasis run --lock=frozen --bundle=load --bundle-file=../app.stasis.code.br \
//       -- <metro build cmd>   # invoke metro by real path; node_modules/.bin symlinks aren't bundle content
//   The materialized tree carries EXACTLY the attested files -- which is where this
//   resolver earns its keep: layouts that exist upstream but were never loaded (the
//   `@babel/runtime/helpers/*` alias files behind a package.json redirect, manifests
//   never read) are NOT in that tree, so Metro's own probing dies on them, while the
//   recorded edges resolve straight to the attested targets. The materialized files
//   exist to satisfy Metro's crawl, cache hashing, and worker pre-reads; the BYTES that
//   get transformed still come from the bundle, hash-verified, via the transformer.
//   (Capture with `--fs=async --child-process` so the manifests/configs Metro reads
//   through fs -- package.json, babel.config.js -- are attested and materialize too.)
//
// WHAT THIS DOES AND DOESN'T GUARANTEE:
//   - A recorded edge is served AS RECORDED: Metro's probing (platform suffixes,
//     package.json fields, Haste) is short-circuited for it, so resolution can't drift
//     from what was attested -- and can't fail on alias layouts the attested tree
//     doesn't carry. Per-platform edges (a `stasis bundle --metro` multi-platform
//     artifact) are served through the `platform` Metro hands each resolution, so one
//     multi-platform artifact serves every platform it was built for.
//   - This is an AVAILABILITY bridge, not a new trust gate: byte integrity stays where
//     it is (the worker transformer / State.getFile, hash-verified, fail-closed). An
//     edge the bundle doesn't record -- out-of-scope parents, asset imports (capture
//     attests asset FILES but records no edge for them), anything new -- defers to
//     Metro's own resolver, which needs the on-disk tree exactly as before; if that
//     resolution lands on an in-scope file, the transformer still serves/verifies the
//     attested bytes, so a deferred edge can pick only attested content.
//   - KNOWN LIMITATION (same boundary as the transformer): serving resolution does not
//     make bundle-only files buildable -- Metro still reads a resolved file from disk in
//     the worker (and hashes it in the main process) before the transformer swaps in
//     attested bytes, and its file map still crawls the watched roots. A browser/
//     react-native `false` redirect is the exception: the reserved empty-module edge is
//     translated to Metro's native `{ type: 'empty' }`, so it never touches disk.
//
// Inert outside load mode: any other mode resolves to a null State and this defers
// every request untouched -- in a capture run Metro must resolve naturally, because
// that natural resolution IS what gets recorded.

// Per-process load State, built once, lazily (Metro constructs its resolver well after
// config load, so this never races the stasis loader's init). Reuse the ambient preload
// when one exists -- under `stasis run` the resolver then consults the very State the
// loader serves from instead of parsing the bundle a second time, and in a capture run
// it goes inert without constructing a State at all (no write-target claims to collide
// with the preload's). Standalone Metro (env/stasis.config.json only, no loader) builds
// its own State exactly like the worker transformer does.
let stateInited = false
let loadState = null
function getLoadState() {
  if (!stateInited) {
    stateInited = true
    const state = State.preload ?? new State(process.cwd())
    loadState = state.config.loadBundle ? state : null
    // A misconfigured resolver fails SILENT (every request defers to Metro, which then
    // probes disk and produces its own UnableToResolveError) -- announce the resolved
    // mode once under EXODUS_STASIS_DEBUG so "wired but inert" is diagnosable: a stale
    // capture (the attested config predates the wiring), a root/cwd mismatch, or a
    // non-load mode all show up right here.
    if (state.config.debug) {
      console.warn(loadState
        ? `[stasis] StasisMetroResolver: load mode active -- root=${loadState.root}, bundleFile=${loadState.config.bundleFile ?? '<default>'}, scope=${loadState.config.full ? 'full' : 'node_modules'}`
        : '[stasis] StasisMetroResolver: not in load mode -- passing every request through')
    }
  }
  return loadState
}

// True iff `absolute` is a path the bundle is supposed to cover under load mode --
// the ORIGIN gate: edges are replayed only for parents the bundle's scope owns, and
// everything else defers to Metro. Mirrors the worker transformer's inScope (and the
// Node loader's resolve-hook gate): out-of-root origins are out of scope; full scope
// covers every in-root origin; node_modules scope covers only dependency origins, so
// workspace/app code keeps resolving through Metro against disk.
function inScope(state, absolute) {
  try {
    state.relative(absolute)
  } catch {
    return false
  }
  if (state.config.full) return true
  return state.inNodeModules(pathToFileURL(absolute).toString())
}

// Build a Metro `resolver.resolveRequest`: serve recorded resolution edges from the
// bundle, defer everything else. `base` is an app's existing custom resolver to defer
// to (so stasis composes in front of it); with none, misses go to Metro's default
// resolver via `context.resolveRequest` -- which Metro rebinds to the default algorithm
// before invoking a custom resolver, precisely for this delegation pattern.
export function createResolveRequest(base = undefined) {
  if (base !== undefined && typeof base !== 'function') {
    throw new TypeError('createResolveRequest(base?): base must be a function or omitted')
  }
  return function stasisMetroResolveRequest(context, moduleName, platform) {
    const state = getLoadState()
    if (state) {
      const origin = context.originModulePath
      if (typeof origin === 'string' && isAbsolute(origin) && inScope(state, origin)) {
        // resolveBundled scans every conditions bucket for the recorded (parent,
        // specifier) edge -- Metro resolutions carry no Node conditions to key on --
        // and picks the `platform` entry from a per-platform edge map. As-written
        // specifiers ('./Button', '@babel/runtime/helpers/x') match symmetrically:
        // capture recorded them via the same canonicalization. A miss (unrecorded
        // edge, divergent buckets, platform the map doesn't carry) returns undefined
        // and we defer below -- never guess.
        const target = state.resolveBundled(pathToFileURL(origin).toString(), moduleName, {
          platform: typeof platform === 'string' ? platform : undefined,
        })
        if (target !== undefined) {
          // The reserved empty module (a browser/react-native `false` redirect in a
          // `stasis bundle --metro/--mainFields` artifact) maps to Metro's own notion
          // of an empty resolution -- Metro then never tries to read the synthetic
          // path from disk, which only the bundle carries.
          const empty = state.relative(target) === EMPTY_MODULE_PATH
          if (state.config.debug) {
            console.warn(`[stasis] StasisMetroResolver: '${moduleName}' from ${origin} -> ${empty ? '<empty>' : target}`)
          }
          return empty ? { type: 'empty' } : { type: 'sourceFile', filePath: target }
        }
        // An in-scope origin with no recorded edge: the request Metro is about to
        // re-derive from disk. Under debug, name it -- when the disk probe then fails
        // (UnableToResolveError), this line is the difference between "the bundle
        // never recorded the edge" (stale/static capture) and "the resolver never ran".
        if (state.config.debug) {
          console.warn(`[stasis] StasisMetroResolver: no recorded edge for '${moduleName}' from ${origin}${typeof platform === 'string' ? ` (platform=${platform})` : ''} -- deferring to Metro`)
        }
      }
    }
    const next = base ?? context.resolveRequest
    if (typeof next !== 'function') {
      throw new TypeError(
        'StasisMetroResolver: context.resolveRequest is not a function -- Metro supplies it ' +
        'when resolver.resolveRequest is set; pass your own base resolver to createResolveRequest() ' +
        'if you are driving this outside Metro'
      )
    }
    return next(context, moduleName, platform)
  }
}

// Drop-in for the common case (no existing custom resolver):
//   resolver: { resolveRequest } -- see the wiring example above.
export const resolveRequest = createResolveRequest()
