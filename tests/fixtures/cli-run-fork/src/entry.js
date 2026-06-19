import { fork, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Importing worker.js records it (and its hello.js edge) at capture time as a plain
// attested file; the children below then run it as their entry at run time.
import { ready } from './worker.js'

void ready
console.log('PARENT start')

const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))

// RUN_WORKER: a forked child. It inherits the loader (process.execArgv) and EXODUS_STASIS_*
// automatically and gets an IPC channel. The loader suppresses its write and relaxes its
// entry check (its entry is a fork target).
if (process.env.RUN_WORKER) {
  const child = fork(workerPath)
  child.on('exit', (code) => {
    console.log(`PARENT child-exit=${code}`)
    if (code) process.exitCode = code
  })
}

// SPAWN_WORKER: a NON-fork child that still runs the loader (explicit --import, inherited
// env, no IPC channel). It must still be blocked from writing -- the safeguard covers any
// child, not just fork() -- which is what this exercises (STASIS_LOADER is the loader path).
if (process.env.SPAWN_WORKER) {
  const r = spawnSync(process.execPath, ['--import', process.env.STASIS_LOADER, workerPath], { stdio: 'inherit' })
  if (r.status) process.exitCode = r.status
}
