// Loaded only as a worker THREAD's entry (see entry.js). Its threaddep.js import is therefore
// a thread-only module the root process never sees -- the stand-in for the babel config and
// preset that only Metro's transform workers load.
import { extra } from './threaddep.js'

console.log(`THREAD extra=${extra}`)
