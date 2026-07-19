// Imported by src/loader-mock.js (the `stasis run --mock` entry) after the core hooks lib is
// evaluated but before its hooks are installed. Captures the import graph by running user code
// with side-effects denied. Pairs with Node's `--permission` (see bin/stasis.js), which denies fs
// writes/child procs/workers/addons/inspector at the runtime boundary; this file covers what
// `--permission` can't -- there is no `--allow-net`, so the network builtins are neutralized in JS.
//
// FAIL CLOSED, WHOLE MODULE: replace *every* callable on a denied builtin with a thrower, not a
// curated method list -- higher-level clients (axios/undici/ws) fall closed too since they bottom
// out at node:net/tls/dns, and anything unmodelled still throws rather than silently succeeding.
//
// Mechanism: go through `createRequire` to grab the *mutable* CJS exports object -- ESM namespace
// objects freeze their bindings, so mocking them throws "Cannot redefine property". ESM live-bindings
// track CJS mutation for builtins, so importers loading *after* us see the mocks; modules linked
// before (the loader's own state.js) keep their real bindings.

import { mock } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)

// Force lazy init of process.std{in,out,err} before mocking net/tls: they're lazy getters that
// build a net.Socket/tty.WriteStream on first read, which syncBuiltinESMExports() below would
// otherwise trigger through our mock mid-setup. Reading once here caches the real Socket/TTY.
void process.stdin
void process.stdout
void process.stderr

const MARKER = '[stasis --mock]'

// Tagged (__stasisMock) so the unhandledRejection trap below can tell our denials from real bugs.
const blocked = (label) => {
  const err = new Error(`${MARKER} ${label} is blocked while capturing imports`)
  err.code = 'ERR_STASIS_MOCK_BLOCKED'
  err.__stasisMock = true
  return err
}

// A *regular* (constructable) function so both `mod.factory()` and `new mod.Constructor()` throw
// our error; an arrow would make `new` fail with a confusing "is not a constructor".
const denyFn = (label) => function () { throw blocked(label) }

// Promise-shaped version: rejects instead of sync-throwing, so fire-and-forget callers surface via
// the unhandledRejection trap below rather than crashing the script synchronously.
const denyFnAsync = (label) => function () { return Promise.reject(blocked(label)) }

// Replace every own function on `mod` (and one level down on `mod.promises`) with a thrower.
// Promise-shaped surfaces use denyFnAsync so fire-and-forget callers reject quietly -- except
// class-shaped exports (PascalCase): `new Class()` returning a Promise yields the Promise as the
// constructed value, so classes sync-throw to give a clean error in both `new` and call form.
const isClassName = (key) => /^[A-Z]/.test(key)
const denyModuleSurface = (specifier, mod, opts = {}) => {
  const { prefix = specifier, async: isAsync = specifier.endsWith('/promises') } = opts
  for (const key of Object.getOwnPropertyNames(mod)) {
    const value = mod[key]
    if (typeof value === 'function') {
      const label = `${prefix}.${key}()`
      const impl = (isAsync && !isClassName(key)) ? denyFnAsync(label) : denyFn(label)
      try {
        mock.method(mod, key, impl)
      } catch {
        try { mod[key] = impl } catch { /* frozen: leave as-is */ }
      }
    } else if (key === 'promises' && value && typeof value === 'object') {
      denyModuleSurface(specifier, value, { prefix: `${prefix}.promises`, async: true })
    }
  }
}

// Every callable on these builtins is replaced with a thrower.
const DENY_ALL = [
  // Network surface (no --allow-net counterpart -- JS-mock is the only layer).
  'node:http', 'node:https', 'node:http2',
  'node:net', 'node:dgram', 'node:tls',
  'node:dns', 'node:dns/promises',
  // Process/worker/debug: already --permission-denied; duplicated for attributable errors and
  // defense in depth against a future --allow-* slip-up or a process.binding bypass.
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  'node:inspector',
  'node:inspector/promises',
  // Other side-effect surfaces nothing else covers:
  'node:repl',         // repl.start() opens an interactive stdin loop
  'node:sqlite',       // DatabaseSync can open/create SQLite files (Node 22+)
  'node:trace_events', // createTracing() can write trace files
  'node:v8',           // writeHeapSnapshot bypasses node:fs; setFlagsFromString mutates global V8 state
  // node:wasi is deliberately omitted: require('node:wasi') emits an ExperimentalWarning, and
  // --permission already denies WASI construction at the kernel level.
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

// process method denials. process.exit / process.abort are deliberately left alone -- early
// termination isn't a side effect we should hide. The rest mutate global process state, do real
// I/O, or talk to a parent over IPC; note setUncaughtExceptionCaptureCallback would also disable
// our exitCode=13 cleanup below.
const PROCESS_DENY = [
  'chdir', 'kill', 'umask', 'dlopen', 'binding',
  'setUid', 'setGid', 'setEuid', 'setEgid', 'setgroups', 'initgroups',
  'send', 'disconnect',
  'setSourceMapsEnabled', 'loadEnvFile',
  'setUncaughtExceptionCaptureCallback',
]
for (const name of PROCESS_DENY) {
  if (typeof process[name] === 'function') {
    mock.method(process, name, denyFn(`process.${name}()`))
  }
}

// process.report.writeReport writes a diagnostic JSON file to disk; deny it too.
if (process.report && typeof process.report.writeReport === 'function') {
  mock.method(process.report, 'writeReport', denyFn('process.report.writeReport()'))
}

// fs writers: --permission blocks these at the kernel level too, but JS-mocking gives cleaner
// errors and stops user code mutating even cwd files (cwd is on --allow-fs-write for the bundle).
// Reads stay real so node_modules resolution keeps working.
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
    mock.method(fsPromises, name, denyFnAsync(`node:fs/promises.${name}()`))
  }
}

// Refresh the node:fs ESM wrappers so ESM imports after this point see the mocked names;
// bindings stasis already captured (linked before this file ran) keep their real snapshot.
syncBuiltinESMExports()

// Global fetch / WebSocket / EventSource come from undici, not node:http, so handle separately.
// fetch returns a *forever-pending* promise (not a rejection) so an awaiter hangs and the capture
// still drains to write the bundle on beforeExit; WebSocket/EventSource throw from their
// constructors to preserve the synchronous shape.
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = () => new Promise(() => {})
}
for (const name of ['WebSocket', 'EventSource']) {
  if (typeof globalThis[name] === 'function') {
    globalThis[name] = class {
      constructor() { throw blocked(name) }
    }
  }
}

// Our denials become unhandledRejections for fire-and-forget callers, which would tear the process
// down before the loader writes the bundle. Swallow *only* our own denials; rethrow everything else.
process.on('unhandledRejection', (reason) => {
  if (reason?.__stasisMock) return
  throw reason
})

// Node 24+ sets exitCode=13 when a top-level await stays unsettled (e.g. an awaited denied
// promise). The bundle already wrote at beforeExit, so reset 13 -> 0; any other code is preserved.
process.on('exit', () => {
  if (process.exitCode === 13) process.exitCode = 0
})

// Timers: silently ignored. Callback timers (setTimeout/setInterval/setImmediate) become no-ops;
// promise timers (node:timers/promises) return *forever-pending* promises so `await setTimeout()`
// suspends forever. A pending promise doesn't keep the event loop alive, so the process still
// exits cleanly and the loader's beforeExit hook writes the bundle.
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
// setInterval returns an async iterable; each `await iter.next()` is forever-pending, so
// `for await (const _ of setInterval(...))` hangs at the first iteration.
mock.method(timersPromises, 'setInterval', () => ({
  [Symbol.asyncIterator]() {
    return { next: pending }
  },
}))
