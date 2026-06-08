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
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)

// Force lazy initialization of process.stdin/stdout/stderr *before* we mock
// the net/tls constructors. Node's process.std{in,out,err} are lazy getters
// that construct an underlying net.Socket (or tty.WriteStream) on first read;
// syncBuiltinESMExports() below would otherwise trigger those getters as it
// materializes node:process's ESM wrapper, and the constructor would hit our
// mock and throw mid-setup. Reading the property once here caches the real
// Socket/TTY in Node's closure, so the later sync just reads the cached value.
void process.stdin
void process.stdout
void process.stderr

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

// Every callable on these builtins is replaced with a thrower. The list
// covers two categories:
//
//   1) Network surface (http/https/http2/net/dgram/tls/dns) -- the permission
//      system has no --allow-net counterpart, so JS-mock is the *only* layer.
//
//   2) Process / worker surface (child_process/worker_threads/cluster/
//      inspector) -- already denied at the kernel level by --permission (no
//      --allow-child-process / --allow-worker / --allow-inspector and no
//      --allow-addons). We duplicate the deny here on purpose: a JS-level
//      thrower surfaces a clean, attributable ERR_STASIS_MOCK_BLOCKED instead
//      of the kernel's ERR_ACCESS_DENIED, and it's defense in depth against
//      anything that might quietly slip the permission rule (a future
//      bypass, a misconfigured --allow flag, code that grabs primitives via
//      process.binding before --permission's check fires, ...).
const DENY_ALL = [
  // Network
  'node:http', 'node:https', 'node:http2',
  'node:net', 'node:dgram', 'node:tls',
  'node:dns', 'node:dns/promises',
  // Process / worker / debug -- duplicated with --permission
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  'node:inspector',
  'node:inspector/promises',
]

for (const specifier of DENY_ALL) {
  let mod
  try {
    mod = require(specifier)
  } catch {
    continue // not present on this build
  }
  denyModuleSurface(specifier, mod)
}

// fs writers: --permission blocks them at the kernel level too, but we mock
// at the JS layer for cleaner attributable errors and so that user code can't
// even *try* to mutate files inside the project's cwd (which is on the
// --allow-fs-write list so stasis can emit its bundle/lockfile). Reads stay
// real so node_modules resolution and config discovery keep working. This
// works because loader.js loads us *after* stasis's own destructured
// `import { writeFileSync } from 'node:fs'` snapshots, so stasis keeps real
// fs; the syncBuiltinESMExports() call below then refreshes the node:fs ESM
// wrapper so the user's subsequent ESM imports see the mocked names.
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const FS_WRITERS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'mkdir', 'mkdirSync', 'rename', 'renameSync',
  'link', 'linkSync', 'symlink', 'symlinkSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'futimes', 'futimesSync',
  'chmod', 'chmodSync', 'lchmod', 'lchmodSync', 'fchmod', 'fchmodSync',
  'chown', 'chownSync', 'lchown', 'lchownSync', 'fchown', 'fchownSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createWriteStream', 'mkdtemp', 'mkdtempSync',
]
for (const name of FS_WRITERS) {
  if (typeof fs[name] === 'function') {
    mock.method(fs, name, denyFn(`node:fs.${name}()`))
  }
  if (typeof fsPromises[name] === 'function') {
    mock.method(fsPromises, name, denyFn(`node:fs/promises.${name}()`))
  }
}

// Refresh the node:fs / node:fs/promises ESM wrappers so destructured/
// namespace ESM imports made *after* this point see the mocked names.
// Bindings already captured by stasis's own modules (linked before this file
// ran) keep their snapshot of the real functions.
syncBuiltinESMExports()

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

// User code that awaits a denied promise (a forever-pending timer, an
// undelivered fetch) leaves the top-level await unsettled, which Node 24+
// flags by setting exitCode=13 at exit time. The bundle has already been
// written by then (state.write() ran at beforeExit, before this), so the
// capture itself succeeded -- override the 13 back to 0 so the CLI doesn't
// report failure. Anything other than 13 (real assertion failure, syntax
// error, ...) is preserved.
process.on('exit', () => {
  if (process.exitCode === 13) process.exitCode = 0
})

// Timers: silently ignored. Callback-style timers (setTimeout/setInterval/
// setImmediate) become no-ops -- the callback never runs and the scheduling
// call returns normally so user code keeps going. Promise-style timers
// (node:timers/promises) return *forever-pending* promises: `await
// setTimeout(...)` suspends forever and any code past the await never runs.
// That's the "silently ignored" semantics for promise timers -- the awaiter
// is dropped, not given a synthetic value. The process still exits cleanly
// because a pending promise on its own doesn't keep the event loop alive, so
// once everything else drains, Node tears down (logging an unsettled-
// top-level-await warning) and the loader's beforeExit hook writes the
// bundle.
//
// Stasis itself does not import node:timers anywhere, so unlike node:fs the
// ESM wrapper for node:timers/timers-promises is not pre-materialized; the
// CJS exports mutation below propagates to the user's first ESM import.
const noop = () => undefined
const pending = () => new Promise(() => {})
for (const name of ['setTimeout', 'setInterval', 'setImmediate']) globalThis[name] = noop
for (const name of ['clearTimeout', 'clearInterval', 'clearImmediate']) globalThis[name] = noop

const timers = require('node:timers')
for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate']) {
  mock.method(timers, name, noop)
}

const timersPromises = require('node:timers/promises')
mock.method(timersPromises, 'setTimeout', pending)
mock.method(timersPromises, 'setImmediate', pending)
// setInterval returns an async iterable; each `await iter.next()` is also a
// forever-pending promise, so `for await (const _ of setInterval(...))` hangs
// at the first iteration -- the loop body never runs.
mock.method(timersPromises, 'setInterval', () => ({
  [Symbol.asyncIterator]() {
    return { next: pending }
  },
}))
