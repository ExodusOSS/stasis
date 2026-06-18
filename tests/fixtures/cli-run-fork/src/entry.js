import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Importing worker.js gets it (and its hello.js edge) recorded at build time as a
// plain attested file; the fork below then runs it as a child's entry at run time.
import { ready } from './worker.js'

void ready
console.log('PARENT start')

// Gated on an env var the tests set so the build step (which must not fork) and the
// enforced run (which must) share one entry file -- a frozen run rejects an entry the
// lockfile/bundle never recorded, so build and run have to use the very same entry.
if (process.env.RUN_WORKER) {
  const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))
  // execArgv: [] deliberately drops anything inherited -- under --child-process the
  // loader must re-inject itself so the child still can't escape enforcement.
  const child = fork(workerPath, [], { execArgv: [] })
  child.on('exit', (code) => {
    console.log(`PARENT child-exit=${code}`)
    if (code) process.exitCode = code
  })
}
