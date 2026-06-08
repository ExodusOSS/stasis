import { greet } from './hello.js'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { setTimeout as pTimeout } from 'node:timers/promises'

// Every side-effecting call should be denied. fs writes and child_process are
// blocked by --permission; the network builtins and fetch/WebSocket by the
// JS mocks. All of them throw (or reject) -- fail closed -- so a single helper
// reports each outcome uniformly.
const log = (kind, fn) => {
  try { fn(); console.log(kind, 'NOT BLOCKED') }
  catch (e) { console.log(kind, 'blocked', e.code ?? e.message) }
}

log('write', () => writeFileSync(process.env.STASIS_MOCK_SENTINEL, 'pwned'))
log('spawn', () => spawnSync('node', ['-e', 'process.exit(0)']))
log('http', () => createServer())           // factory path
log('net', () => connect(1234, '127.0.0.1')) // connection path
log('ws', () => new WebSocket('ws://stasis.invalid')) // constructor path

// Awaited fetch, caught: proves fetch is intercepted as a clean rejection.
try { await fetch('http://stasis.invalid/api'); console.log('fetch', 'NOT BLOCKED') }
catch (e) { console.log('fetch', 'blocked', e.message) }

// Fire-and-forget beacon (no .catch): the mock's unhandledRejection trap must
// swallow our own denial so the capture still completes and writes the bundle.
void fetch('http://stasis.invalid/beacon')

// Timer scheduling must succeed but the callback must never run; the promise
// version must resolve immediately so awaiting code keeps moving.
let fired = 0
setTimeout(() => { fired++ }, 0)
setInterval(() => { fired++ }, 1)
setImmediate(() => { fired++ })
const v = await pTimeout(100_000, 'awaited')   // would otherwise hang the capture
console.log('timer await:', v)
console.log('timer callbacks fired:', fired)

console.log(greet('world'))

