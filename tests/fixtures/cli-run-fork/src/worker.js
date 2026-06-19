import { pathToFileURL } from 'node:url'

import { greet } from './hello.js'

// Importable so a normal capture (and a frozen lock) records worker.js + its hello.js
// edge without forking; the body below runs only when this file is the forked child's
// own entry (process.argv[1]), not when entry.js imports it in the parent.
export const ready = true

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // Report the modes the child actually sees (it inherits them from the root) and exercise
  // worker.js's own import edge via greet(). The whole line is asserted on by the tests.
  const lock = process.env.EXODUS_STASIS_LOCK || ''
  const bundle = process.env.EXODUS_STASIS_BUNDLE || ''
  console.log(`WORKER ${greet('child')} lock=${lock} bundle=${bundle}`)
  if (process.send) process.send('done')
}
