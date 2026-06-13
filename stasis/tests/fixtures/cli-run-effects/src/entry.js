import { greet } from './hello.js'
import { writeFileSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { setTimeout as pTimeout } from 'node:timers/promises'

// All side-effecting calls below must be denied (fail closed). The JS mocks
// throw / reject; --permission also throws ERR_ACCESS_DENIED for anything that
// somehow bypasses the JS layer. The fixture reports each outcome through one
// helper so the test only has to match patterns.
const log = (kind, fn) => {
  try { fn(); console.log(kind, 'NOT BLOCKED') }
  catch (e) { console.log(kind, 'blocked', e.code ?? e.message) }
}

log('fs-destructured', () => writeFileSync(process.env.STASIS_MOCK_SENTINEL, 'pwned'))
log('spawn', () => spawnSync('node', ['-e', 'process.exit(0)']))
log('worker', () => new Worker('data:,'))
log('http', () => createServer())
log('net', () => connect(1234, '127.0.0.1'))
log('ws', () => new WebSocket('ws://stasis.invalid'))
log('chdir', () => process.chdir('/'))

// Fire-and-forget fetch: pending promise, no rejection (so no unhandled-
// rejection storm). Awaiting fetch would hang the script -- same semantics
// as the never-resolving timer below.
void fetch('http://stasis.invalid/beacon')

// Fire-and-forget promise-style fs writer pointed at a path *inside cwd*
// (cwd is on --allow-fs-write, so the kernel layer would let this through).
// Only the JS-level denyFnAsync mock prevents the write -- if the JS layer
// silently no-op'd or returned undefined, the kernel wouldn't catch it
// either, and STASIS_MOCK_INCWD_SENTINEL would land on disk. The test
// asserts it does not.
void writeFileAsync(process.env.STASIS_MOCK_INCWD_SENTINEL, 'pwned-async')

console.log(greet('world'))

// LAST: an awaited never-resolving timer. The capture has fully run by here;
// the await hangs and the process exits cleanly when the loop drains
// (beforeExit fires, the bundle is written, the mock zeros Node's exitCode=13
// "unsettled top-level await" back to 0). Anything past this line must NOT
// print.
await pTimeout(100_000, 'never-resolves')
console.log('UNREACHABLE: timer await resolved')
