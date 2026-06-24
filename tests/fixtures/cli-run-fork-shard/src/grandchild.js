// Loaded only as the GRANDCHILD's entry (forked by worker.js under SPAWN_GRANDCHILD). Its
// grandchilddep.js import is a DEPTH-2 child-only module: neither the root nor the worker loads it
// directly -- it reaches the root's lockfile only via the grandchild's shard propagating up.
import { deep } from './grandchilddep.js'

console.log(`GRANDCHILD deep=${deep}`)
