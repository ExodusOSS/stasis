import { existsSync, readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

// Worker-THREAD twin of the cli-run-fork-shard fixture, and the reduced repro of Metro's
// `transformer.unstable_workerThreads: true` transform pool (jest-worker's
// `enableWorkerThreads`), where the transform workers are threads of the bundler process
// rather than forked children.
//
// A thread inherits execArgv, so it runs the stasis loader too -- but it shares the root's
// PID, and hooks.js decides "root vs forwarding child" by PID
// (EXODUS_STASIS_PID !== String(process.pid)). So every thread classifies itself as the ROOT:
// it mints its own shard dir, never writes a shard, and writes the project's
// stasis.lock.json / bundle itself, racing the real root and the other threads for the same
// paths. Compare cli-run-fork-shard, where the same code in a forked CHILD correctly
// forwards a shard the root merges.
//
// The parent NEVER imports thread-worker.js -- it only spawns it by path. So thread-worker.js
// and its threaddep.js import are loaded ONLY in the worker threads, exactly as Metro's
// workers are the only ones to load babel.config.js and the RN babel preset.

const workerPath = fileURLToPath(new URL('./thread-worker.js', import.meta.url))
const lockPath = fileURLToPath(new URL('../stasis.lock.json', import.meta.url))

console.log('PARENT start')
// Spawn WORKER_COUNT threads (default 2). >1 makes the artifact writers overlap: the threads
// finish together, so their unsynchronised writes to the one lockfile path interleave.
const count = Number(process.env.WORKER_COUNT ?? '2')
await Promise.all(
  Array.from({ length: count }, () => new Promise((resolve) => {
    const worker = new Worker(workerPath)
    worker.on('exit', (code) => {
      console.log(`PARENT thread-exit=${code}`)
      if (code) process.exitCode = code
      resolve()
    })
  }))
)

// Every thread has exited and the ROOT has not written yet (it writes on beforeExit/exit), so
// anything on disk HERE was written by a worker thread -- i.e. by a second writer that the
// root neither coordinates with nor knows about. Reported so the repro can name the writer.
console.log(`PARENT lockfile-mid-build=${existsSync(lockPath)}`)
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  console.log(`PARENT mid-build-files=${JSON.stringify(Object.keys(lock.sources['.'].files).sort())}`)
}
