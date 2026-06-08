// Imported via `--import` *before* `src/loader.js`. The goal is to capture the
// import graph for a bundle by actually running user code, but with outbound
// side-effects denied. Pair with Node's `--permission` flag (see bin/stasis.js
// when run with `--mock`), which fail-closed-denies fs writes, child processes,
// worker threads, native addons, and the inspector at the runtime boundary.
// This file covers what `--permission` cannot: there is no `--allow-net`, so
// the network builtins are neutralized here in JS.
//
// Design: FAIL CLOSED, WHOLE MODULE.
//  - We replace *every* callable on each network builtin with a thrower, not a
//    curated method list. There is no "I forgot net.Socket#connect" gap: if
//    it's a function on a denied module (factory, constructor, or helper),
//    invoking it is denied. This also closes higher-level HTTP clients
//    (axios/got/node-fetch/undici/ws) for free -- they all bottom out at
//    node:net / node:tls / node:dns.
//  - Anything we don't explicitly model still fails closed, because the call
//    throws rather than silently succeeding.
//
// Mechanism: node:test's MockTracker can only redefine *configurable*
// properties. ESM namespace objects (`import * as net from 'node:net'`) freeze
// their bindings, so mocking the ESM namespace throws "Cannot redefine
// property". The CommonJS exports object for the same builtin is mutable, and
// ESM live-bindings track CJS mutation for builtins -- so we go through
// `createRequire` to grab the mutable object and let live bindings propagate to
// any importer that loads *after* us. Modules linked before this file runs keep
// their original bindings -- which is exactly why the loader's own state.js
// (node:fs/path/url/module/zlib/buffer, none of them network) keeps working.

import { mock } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const MARKER = '[stasis --mock]'

// Tagged so the unhandledRejection trap below can tell our denials apart from
// genuine application bugs.
const blocked = (label) => {
  const err = new Error(`${MARKER} ${label} is blocked while capturing imports`)
  err.code = 'ERR_STASIS_MOCK_BLOCKED'
  err.__stasisMock = true
  return err
}

// A *regular* (constructable) function, so that both `mod.factory()` and
// `new mod.Constructor()` throw our attributable error -- an arrow function
// would make `new` fail with a confusing "is not a constructor" TypeError.
const denyFn = (label) => function () { throw blocked(label) }

// Replace every own function on `mod` (and, one level down, on `mod.promises`)
// with a thrower. Functions are configurable on the builtins we target; fall
// back to direct assignment on the off chance one isn't.
const denyModuleSurface = (specifier, mod, prefix = specifier) => {
  for (const key of Object.getOwnPropertyNames(mod)) {
    const value = mod[key]
    if (typeof value === 'function') {
      const label = `${prefix}.${key}()`
      try {
        mock.method(mod, key, denyFn(label))
      } catch {
        try { mod[key] = denyFn(label) } catch { /* frozen: leave as-is */ }
      }
    } else if (key === 'promises' && value && typeof value === 'object') {
      denyModuleSurface(specifier, value, `${prefix}.promises`)
    }
  }
}

// Every network-capable builtin. inspector (debug port) and cluster/worker
// (which fork) are already denied by the permission system, so they're not here.
const DENY = [
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:dgram',
  'node:tls',
  'node:dns',
  'node:dns/promises',
]

for (const specifier of DENY) {
  let mod
  try {
    mod = require(specifier)
  } catch {
    continue // not present on this build
  }
  denyModuleSurface(specifier, mod)
}

// Global fetch / WebSocket / EventSource come from undici, not node:http, so
// they need separate handling. (Their transport bottoms out at node:net, which
// is already blocked above -- but intercepting here yields a clean, attributable
// error instead of a confusing low-level socket failure.) These globals are
// writable + configurable, so assign directly.
//
// fetch returns a *rejected* promise rather than throwing synchronously, to
// honor its contract -- defensive `fetch(...).catch(...)` code then keeps
// running and we capture more of the graph. WebSocket/EventSource throw from
// their constructors (fail closed).
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = () => Promise.reject(blocked('fetch()'))
}
for (const name of ['WebSocket', 'EventSource']) {
  if (typeof globalThis[name] === 'function') {
    globalThis[name] = class {
      constructor() { throw blocked(name) }
    }
  }
}

// A denied fetch used fire-and-forget (e.g. an analytics beacon: `void
// fetch(url)`) would otherwise surface as an unhandledRejection and tear the
// process down before the loader writes the bundle on `beforeExit`. Swallow
// *only* our own denials; rethrow everything else so real bugs still crash.
process.on('unhandledRejection', (reason) => {
  if (reason?.__stasisMock) return
  throw reason
})

// Timers: silently ignored. Callback-style timers (setTimeout/setInterval/
// setImmediate) become no-ops -- the callback never runs but the scheduling
// call returns normally so user code keeps going. Promise-style timers
// (node:timers/promises) resolve *immediately* with the value the caller
// passed, so `await setTimeout(1000, x)` returns `x` without delay rather
// than hanging forever. That keeps `await`-based control flow moving past
// pacing/debounce code instead of deadlocking the capture.
//
// Stasis itself does not import node:timers anywhere, so unlike node:fs
// the ESM wrapper for node:timers is not pre-materialized; the CJS exports
// mutation below is picked up by the user's first ESM import lazily and
// propagates to destructured `import { setTimeout } from 'node:timers'`.
const noop = () => undefined
for (const name of ['setTimeout', 'setInterval', 'setImmediate']) globalThis[name] = noop
for (const name of ['clearTimeout', 'clearInterval', 'clearImmediate']) globalThis[name] = noop

const timers = require('node:timers')
for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate']) {
  mock.method(timers, name, noop)
}

const timersPromises = require('node:timers/promises')
mock.method(timersPromises, 'setTimeout', (_ms, value) => Promise.resolve(value))
mock.method(timersPromises, 'setImmediate', (value) => Promise.resolve(value))
// setInterval returns an async iterable that yields on each tick; we yield
// nothing so `for await (const _ of setInterval(...))` exits immediately.
mock.method(timersPromises, 'setInterval', () => ({
  [Symbol.asyncIterator]() {
    return { next: () => Promise.resolve({ done: true, value: undefined }) }
  },
}))
