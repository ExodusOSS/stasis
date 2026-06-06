// Imported via `--import` *before* `src/loader.js`. The goal is to capture
// the import graph for a bundle by actually running user code, but without
// any outbound side-effects: no listening sockets, no HTTP requests, no
// UDP/TLS chatter. Pair with Node's `--permission` flag (see `bin/stasis.js`
// when run with `--mock`) to additionally block disk writes, child
// processes, and worker threads at the kernel level.
//
// node:test's MockTracker can only redefine *configurable* properties.
// ESM namespace objects (e.g. `import * as fs from 'node:fs'`) freeze their
// bindings, so `mock.method(fs, 'writeFileSync', …)` against the ESM
// namespace throws "Cannot redefine property". The CommonJS exports object
// for the same builtin is mutable, and ESM live-bindings track CJS mutation
// for builtins -- so we go through `createRequire` to grab the mutable
// object and let live bindings propagate to any importer that loads *after*
// us. Modules linked before this file runs keep their original bindings
// (that's how the loader's own `state.js` continues to talk to real `fs`).

import { mock } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Chainable no-op shaped like a Server/Socket/Stream. Enough surface that
// `createServer().listen(p, cb).on('error', …)` and similar patterns don't
// blow up. `listen()` deliberately does not invoke its callback: we don't
// want to pretend the server is up.
const fakeSocket = () => {
  const obj = {
    listen() { return obj },
    close(cb) { if (cb) queueMicrotask(cb); return obj },
    address() { return null },
    on() { return obj },
    once() { return obj },
    off() { return obj },
    removeListener() { return obj },
    removeAllListeners() { return obj },
    addListener() { return obj },
    emit() { return false },
    setMaxListeners() { return obj },
    setTimeout() { return obj },
    setKeepAlive() { return obj },
    setNoDelay() { return obj },
    unref() { return obj },
    ref() { return obj },
    pipe(dst) { return dst },
    pause() { return obj },
    resume() { return obj },
    write() { return true },
    end() { return obj },
    destroy() { return obj },
    connect() { return obj },
    bind() { return obj },
    listening: false,
    readable: false,
    writable: false,
    closed: true,
    destroyed: true,
  }
  return obj
}

// http.ClientRequest-shaped: we accept writes and end() but never emit a
// 'response' or 'error'. Code that awaits a response hangs -- the caller is
// expected to kill the run once the import graph is collected, or wrap
// `await` in their own timeout.
const fakeRequest = () => {
  const req = {
    on() { return req },
    once() { return req },
    off() { return req },
    removeListener() { return req },
    removeAllListeners() { return req },
    addListener() { return req },
    emit() { return false },
    setMaxListeners() { return req },
    setTimeout() { return req },
    setHeader() {},
    getHeader() {},
    removeHeader() {},
    write() { return true },
    end() { return req },
    abort() {},
    destroy() { return req },
    flushHeaders() {},
    setSocketKeepAlive() {},
    setNoDelay() {},
    unref() { return req },
    ref() { return req },
    writableEnded: true,
    destroyed: true,
  }
  return req
}

const intercepts = [
  ['node:http', { createServer: fakeSocket, request: fakeRequest, get: fakeRequest }],
  ['node:https', { createServer: fakeSocket, request: fakeRequest, get: fakeRequest }],
  ['node:http2', { createServer: fakeSocket, createSecureServer: fakeSocket, connect: fakeSocket }],
  ['node:net', { createServer: fakeSocket, createConnection: fakeSocket, connect: fakeSocket }],
  ['node:dgram', { createSocket: fakeSocket }],
  ['node:tls', { createServer: fakeSocket, connect: fakeSocket }],
]

for (const [specifier, methods] of intercepts) {
  const mod = require(specifier)
  for (const [name, impl] of Object.entries(methods)) {
    if (typeof mod[name] === 'function') mock.method(mod, name, impl)
  }
}
