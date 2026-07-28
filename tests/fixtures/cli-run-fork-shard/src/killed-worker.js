// Loaded only as the forked child's entry under KILL_WORKER (see entry.js). Models Metro's transform
// worker being SIGKILLed before it can flush its shard: jest-worker force-exits a worker 500ms after
// the END message and SIGKILLs it 500ms after that, and a big toolchain's exit-time snapshot does not
// always fit. SIGKILL cannot be handled, so beforeExit/exit/SIGTERM all run zero handlers here --
// exactly the case where the root loses everything this child observed unless it forwarded early.
//
// killeddep.js is loaded ONLY here, so it reaches the lockfile only via an INCREMENTAL shard.
import { extra } from './killeddep.js'

console.log(`KILLED-WORKER extra=${extra}`)

// Give the periodic flush (EXODUS_STASIS_SHARD_FLUSH_MS) one window to land, then die uncatchably.
// Polling for the shard would be circular -- the point is that this process gets no say in its death.
setTimeout(() => {
  console.log('KILLED-WORKER dying')
  process.kill(process.pid, 'SIGKILL')
}, Number(process.env.KILL_AFTER_MS ?? 400))
