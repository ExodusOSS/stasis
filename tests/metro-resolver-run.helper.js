// Drives the StasisMetroResolver in isolation (Metro isn't installed): imports the
// resolver and calls it the way Metro's module resolution would -- (context, moduleName,
// platform), with context carrying originModulePath and the default-resolver delegate
// as context.resolveRequest -- then prints what happened, so the test can assert which
// requests were served from the bundle and which deferred (and with what arguments).
//
// Run with cwd = the project root and EXODUS_STASIS_* env describing the load State.
// Spawn-per-test, like the transformer helper: the resolver caches its load State per
// process, and node --test isolates files but not cases.
//
// Usage:
//   node tests/metro-resolver-run.helper.js '<JSON requests>'
//     requests: [{ "origin": "src/entry.js", "moduleName": "./hello.js", "platform": "ios" }, ...]
//     `origin` is project-relative (resolved against cwd); `platform` defaults to null,
//     matching what Metro passes for a platform-less resolution.
//   -> prints JSON, one entry per request:
//        { "served": <Resolution> }                      -- answered from the bundle
//        { "deferred": {origin,moduleName,platform}, "result": <Resolution> } -- delegated
//        { "error": "<message>" }                        -- the call threw
// STASIS_TEST_COMPOSE_BASE=1 -- route through createResolveRequest(base) with the
//   recording delegate as `base`; context.resolveRequest is then a poison function that
//   must NOT be called (asserts base wins over Metro's default).
// STASIS_TEST_NO_FALLBACK=1 -- omit context.resolveRequest (and any base), so a
//   deferral trips the resolver's own contract error.

import { resolve } from 'node:path'

const requests = JSON.parse(process.argv[2] ?? '[]')
const { createResolveRequest, resolveRequest } = await import('../stasis/src/metro-resolver.js')

const compose = process.env.STASIS_TEST_COMPOSE_BASE === '1'
const noFallback = process.env.STASIS_TEST_NO_FALLBACK === '1'

const out = []
for (const { origin, moduleName, platform = null } of requests) {
  // The recording delegate stands in for Metro's default resolver: it captures the
  // arguments it was handed and returns a sentinel resolution.
  let deferred = null
  const fallback = (context, name, plat) => {
    deferred = { origin: context.originModulePath, moduleName: name, platform: plat ?? null }
    return { type: 'sourceFile', filePath: '<fallback>' }
  }
  const poison = () => {
    throw new Error('context.resolveRequest must not be called when a base is provided')
  }
  const fn = compose ? createResolveRequest(fallback) : resolveRequest
  const context = {
    originModulePath: resolve(origin),
    ...(noFallback ? {} : { resolveRequest: compose ? poison : fallback }),
  }
  try {
    const result = fn(context, moduleName, platform)
    out.push(deferred ? { deferred, result } : { served: result })
  } catch (err) {
    out.push({ error: err.message })
  }
}
process.stdout.write(JSON.stringify(out))
