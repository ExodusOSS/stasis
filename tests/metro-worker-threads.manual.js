// Reproduction: Metro's worker-THREAD transform pool defeats stasis's root/child model, so the
// bundler's transform workers become uncoordinated writers of the project's artifacts and their
// capture is silently lost.
//
// WHY THIS IS A `.manual.js` AND NOT A `.test.js`
// It documents a live defect, so as a test it would simply fail. Run it directly:
//     node tests/metro-worker-threads.manual.js
// It exits 0 only once the defect is fixed, so it doubles as the regression check.
//
// THE MECHANISM
// hooks.js classifies a process by PID:
//     const OWN_PID = String(process.pid)
//     if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
//     const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
// and save() branches on it: a child forwards a signed shard the root merges before writing,
// while a NON-child writes stasis.lock.json / the bundle itself ("root owns the artifact; a 2nd
// writer races", hooks.js). A worker_threads thread inherits both EXODUS_STASIS_PID and execArgv
// (so the loader runs) but shares the PID, so `isChildProcess` is false in every thread: each one
// believes it is the root.
//
// WHERE METRO HITS IT
// Metro's transform pool is jest-worker with `enableWorkerThreads:
// config.transformer.unstable_workerThreads` (metro/src/DeltaBundler/WorkerFarm.js). With that
// public config option on, every transform worker is a thread of the bundler process, and
// StasisMetro's constructor assert -- which demands --child-process precisely so "the toolchain
// they load (babel.config.js, @babel/core, the RN preset + plugins) is never attested" cannot
// happen -- is satisfied while guaranteeing nothing.
//
// CONFIRMED AGAINST REAL METRO (metro 0.87.0, jest-worker 29.7.0, 4 workers, 600-module graph):
//   * transformer.unstable_workerThreads: false (default, forked children)
//       105 node_modules buckets / 638 files; babel.config.js, the babel plugin, @babel/core,
//       metro-babel-transformer and metro-transform-worker all attested via the shard merge.
//   * transformer.unstable_workerThreads: true (threads)
//       89 buckets / 511 files; every one of those worker-side entries missing. Exit code 0, no
//       warning. Five save() calls in ONE pid all took the artifact-writer branch (main thread
//       plus each transform thread), and two different threads wrote stasis.lock.json (231124
//       bytes each) within 3ms of one another before the main thread overwrote it with 423670.
//       A later `--lock=frozen` build with the DEFAULT (child-process) pool then fails on that
//       lockfile: "observed resolution './workers/ChildProcessWorker.js' from
//       node_modules/jest-worker/build/WorkerPool.js ... is not attested by the lockfile",
//       where the same frozen build passes against a capture taken with the default pool.
//
// This script reproduces the mechanism with no Metro dependency (the repo has none): the
// cli-run-thread-shard fixture spawns worker threads instead of forked children, which is the
// only difference from cli-run-fork-shard -- whose thread-only twin modules ARE attested.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const threadFixture = join(here, 'fixtures', 'cli-run-thread-shard')
const forkFixture = join(here, 'fixtures', 'cli-run-fork-shard')

// Strip inherited stasis env so the CLI's env-conflict guard doesn't trip (as tests/cli.test.js does).
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('EXODUS_STASIS_'))
)

const run = async (args, cwd) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv })
  const out = []
  const err = []
  child.stdout.on('data', (d) => out.push(d))
  child.stderr.on('data', (d) => err.push(d))
  const [status] = await once(child, 'close')
  return { status, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') }
}

const withFixture = async (fixture, fn) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-thread-repro-'))
  try {
    cpSync(fixture, tmp, { recursive: true })
    return await fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const attestedFiles = (tmp) => {
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  return Object.keys(lock.sources['.'].files).toSorted()
}

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (detail) console.log(`       ${detail}`)
  if (!ok) failures.push(label)
}

// Control: the same shape with a forked CHILD instead of a thread. Its child-only modules must be
// attested -- that is the guarantee --child-process exists to provide, and what Metro's default
// (child-process) transform pool relies on.
await withFixture(forkFixture, async (tmp) => {
  const r = await run(['run', '--lock=add', '--child-process', 'src/entry.js'], tmp)
  const files = r.status === 0 ? attestedFiles(tmp) : []
  check(
    r.status === 0 && files.includes('src/worker.js') && files.includes('src/childdep.js'),
    'control: forked-child modules are attested via the shard merge',
    `status=${r.status} attested=${JSON.stringify(files)}`
  )
})

await withFixture(threadFixture, async (tmp) => {
  const r = await run(['run', '--lock=add', '--child-process', 'src/entry.js'], tmp)
  if (r.status !== 0) {
    check(false, 'thread fixture runs cleanly', `status=${r.status}\n${r.stderr}`)
    return
  }

  // 1. A worker thread wrote the project's lockfile. entry.js reads it after every thread has
  //    exited but before the root's own beforeExit/exit write, so a lockfile there can only have
  //    come from a thread -- a second, uncoordinated writer of a path the root owns.
  const midBuild = /PARENT mid-build-files=(\[.*\])/u.exec(r.stdout)
  check(
    !/PARENT lockfile-mid-build=true/u.test(r.stdout),
    'a worker thread must not write the project lockfile',
    midBuild
      ? `a thread wrote stasis.lock.json mid-build, carrying its own private view: ${midBuild[1]}`
      : 'no mid-build lockfile observed'
  )

  // 2. The root's write then wins the race and drops what the threads captured, so thread-only
  //    modules never reach the artifact -- Metro's babel config + preset, in the real thing.
  const files = attestedFiles(tmp)
  check(
    files.includes('src/thread-worker.js') && files.includes('src/threaddep.js'),
    'thread-only modules are attested',
    `attested=${JSON.stringify(files)}`
  )
})

console.log(
  failures.length === 0
    ? '\nall checks passed'
    : `\n${failures.length} check(s) failed -- the worker-thread capture race is present`
)
process.exitCode = failures.length === 0 ? 0 : 1
