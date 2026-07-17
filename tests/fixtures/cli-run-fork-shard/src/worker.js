// Loaded only as the forked child's entry. Its childdep.js import is therefore a child-only
// module the root process never sees directly.
import { extra } from './childdep.js'

// Depth-2: optionally fork a GRANDCHILD that loads its OWN child-only module. The shard channel
// (dir+key) rides process.env, so the grandchild inherits it transitively and contributes a shard
// too -- proving a subprocess that spawns a subprocess is still captured. Await its exit so its
// shard is on disk before this worker exits (and thus before the root merges at its own exit).
if (process.env.SPAWN_GRANDCHILD) {
  const { fork } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const gc = fork(fileURLToPath(new URL('./grandchild.js', import.meta.url)))
  await new Promise((resolve) => gc.on('exit', resolve))
}

// Env-gated (test-only): lstat a path NOTHING in the tree ever reads -- a stat-ONLY
// observation unique to this forked child, so its payload-free stat record can reach
// the root's lockfile/bundle exclusively via the shard channel (mergeShard's stat
// replay). Requires an --fs run; inert otherwise.
if (process.env.STAT_PROBE) {
  const { lstatSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const probed = lstatSync(fileURLToPath(new URL('./statonly.dat', import.meta.url)))
  console.log(`WORKER stat-only=${probed.isFile()}`)
}

console.log(`WORKER extra=${extra}`)
if (process.send) process.send('done')
