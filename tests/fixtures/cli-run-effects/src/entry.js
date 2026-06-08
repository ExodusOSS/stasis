import { greet } from './hello.js'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { setTimeout as pTimeout } from 'node:timers/promises'

// All side-effecting calls below must be denied (fail closed). The JS mocks
// throw / reject; --permission throws ERR_ACCESS_DENIED for fs writes and
// child processes that bypass JS. The fixture reports each outcome through
// one helper so the test only has to match patterns.
const log = (kind, fn) => {
  try { fn(); console.log(kind, 'NOT BLOCKED') }
  catch (e) { console.log(kind, 'blocked', e.code ?? e.message) }
}

log('fs-destructured', () => writeFileSync(process.env.STASIS_MOCK_SENTINEL, 'pwned'))
log('spawn', () => spawnSync('node', ['-e', 'process.exit(0)']))
log('http', () => createServer())
log('net', () => connect(1234, '127.0.0.1'))
log('ws', () => new WebSocket('ws://stasis.invalid'))

try { await fetch('http://stasis.invalid/api'); console.log('fetch', 'NOT BLOCKED') }
catch (e) { console.log('fetch', 'blocked', e.message) }

// Fire-and-forget beacon: the unhandledRejection trap must swallow our denial
// or this would crash the run before the bundle is written.
void fetch('http://stasis.invalid/beacon')

// Callback timers: scheduling returns normally, callbacks never fire.
let fired = 0
setTimeout(() => { fired++ }, 0)
setInterval(() => { fired++ }, 1)
setImmediate(() => { fired++ })

console.log(greet('world'))

// LAST: an awaited promise timer. With "never resolve" semantics this hangs
// forever; the loader's beforeExit hook still fires when the event loop
// drains and writes the bundle. Anything past this line must NOT print.
await pTimeout(100_000, 'never-resolves')
console.log('UNREACHABLE: timer await resolved', 'fired:', fired)
