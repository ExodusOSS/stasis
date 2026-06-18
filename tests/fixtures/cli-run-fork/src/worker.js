import { pathToFileURL } from 'node:url'

import { greet } from './hello.js'

// Importable so the build (and a frozen lock) records worker.js + its hello.js edge
// without forking; the work below only runs when this file is the forked child's
// own entry (process.argv[1]), not when entry.js imports it in the parent.
export const ready = true

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // Report the stasis config the child actually sees, so tests can assert what was
  // (and was not) propagated. greet() exercises the worker's own import edge.
  const lock = process.env.EXODUS_STASIS_LOCK || ''
  const bundle = process.env.EXODUS_STASIS_BUNDLE || ''
  console.log(`WORKER ${greet('child')} lock=${lock} bundle=${bundle}`)
  if (process.send) process.send('done')
}
