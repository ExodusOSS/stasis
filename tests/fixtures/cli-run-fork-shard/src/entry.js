import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// NB: this package.json has no "type" on purpose -- worker.js/childdep.js are then ESM by Node's
// syntax detection, and since the ROOT never loads them their format is known ONLY from the
// child's shard. That exercises mergeShard carrying the child's recorded format (a frozen run
// would reject them as commonjs otherwise).
//
// The parent NEVER imports worker.js -- it only forks it by path. So worker.js and its
// childdep.js import are loaded ONLY in the forked child. A capture must still attest them
// (via the child's shard), and a later frozen run must verify them. This is the reduced
// repro of Metro's transform workers loading babel.config.js + the babel preset/plugins.

// Opt-in (test-only): drop a forged shard into the root's dir to prove signature verification
// rejects it. Gated so the normal capture/frozen tests above don't see it.
if (process.env.FORGE_SHARD) await import('./forge.js')

const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))
console.log('PARENT start')
// Fork WORKER_COUNT workers (default 1). >1 exercises a worker POOL: several children each write a
// pid-named shard into the root's dir, and a module two workers both load is merged once (dedup).
const workerCount = Number(process.env.WORKER_COUNT ?? '1')
for (let i = 0; i < workerCount; i++) {
  const child = fork(workerPath)
  child.on('exit', (code) => {
    console.log(`PARENT child-exit=${code}`)
    if (code) process.exitCode = code
  })
}
