'use strict'

const { Worker, MessageChannel, isMainThread, parentPort, workerData } = require('node:worker_threads')
const { once } = require('node:events')
const { availableParallelism } = require('node:os')

// Babel transforms are CPU-bound and `stasis build` fires many concurrently (esbuild loads
// files in parallel), so they run on a small worker-thread pool off the main thread. Workers
// are unref()ed: a pending transform keeps the process alive through its open MessagePort,
// but an idle pool never holds the process open after the build finishes.
//
// Babel is the project's dependency, not stasis's, so each pool is keyed by the resolved
// @babel/core entry path and the worker loads that exact copy (passed via workerData).
if (isMainThread) {
  const maxWorkers = availableParallelism() >= 4 ? 2 : 1
  const pools = new Map() // resolved @babel/core path -> [{ worker, busy }]

  const getWorker = (babelPath) => {
    if (!pools.has(babelPath)) pools.set(babelPath, [])
    const workers = pools.get(babelPath)

    const idle = workers.find((info) => info.busy === 0)
    if (idle) return idle

    if (workers.length < maxWorkers) {
      const worker = new Worker(__filename, { workerData: { babelPath } })
      worker.unref()
      // unhandled top-level errors crash the process automatically, which is the desired
      // behavior -- no need to listen to 'error'
      workers.unshift({ worker, busy: 0 })
    } else if (workers.length > 1) {
      workers.sort((a, b) => a.busy - b.busy)
    }

    return workers[0]
  }

  const transformAsync = async (babelPath, code, options) => {
    const info = getWorker(babelPath)
    info.busy++
    const channel = new MessageChannel()
    info.worker.postMessage({ port: channel.port1, code, options }, [channel.port1])
    const [{ result, error }] = await once(channel.port2, 'message')
    info.busy--
    if (error) throw error
    return result
  }

  module.exports = { transformAsync }
} else {
  const babel = require(workerData.babelPath)

  parentPort.on('message', ({ port, code: input, options }) => {
    try {
      // transformSync: the worker is already off the main thread, async only adds overhead
      const { code, map } = babel.transformSync(input, options)
      // only plain data crosses the port -- a full Babel result carries non-cloneable state
      port.postMessage({ result: { code, map } })
    } catch (error) {
      port.postMessage({ error })
    }

    port.close()
  })
}
