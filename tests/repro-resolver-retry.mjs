// Diagnostic harness: runs webpack@4 against the fixture and logs every
// afterResolve event so we can see whether the same (issuer, request) edge
// fires more than once with different resolutions -- the user-reported
// "Conflict for 'isarray'" symptom in StasisWebpack.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import webpack from 'webpack'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'webpack-resolver-retry')

const events = []

class TraceAfterResolve {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap('Trace', (nmf) => {
      nmf.hooks.afterResolve.tap('Trace', (data) => {
        const issuer = data.resourceResolveData?.context?.issuer
        const target = data.resourceResolveData?.path
        events.push({
          rawRequest: data.rawRequest,
          issuer: issuer ? relative(fixture, issuer) : null,
          target: target ? relative(fixture, target) : null,
        })
      })
    })
  }
}

const dist = await mkdtemp(join(tmpdir(), 'stasis-repro-'))
try {
  const compiler = webpack({
    mode: 'none',
    target: 'node',
    entry: join(fixture, 'src', 'entry.js'),
    output: { path: dist, filename: 'bundle.js' },
    plugins: [new TraceAfterResolve()],
  })
  const stats = await promisify(compiler.run.bind(compiler))()
  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: false, errors: true, errorDetails: true }))
  }
} finally {
  await rm(dist, { recursive: true, force: true })
}

// Pretty-print every afterResolve event.
console.log('--- afterResolve events ---')
for (const [i, e] of events.entries()) {
  console.log(`${i}: '${e.rawRequest}' from ${e.issuer} -> ${e.target}`)
}

// Group by (issuer, rawRequest) and report any edge that fired more than once.
console.log('--- duplicate (issuer, request) edges ---')
const byEdge = new Map()
for (const e of events) {
  const key = `${e.issuer} :: ${e.rawRequest}`
  if (!byEdge.has(key)) byEdge.set(key, [])
  byEdge.get(key).push(e.target)
}
let anyDup = false
for (const [key, targets] of byEdge) {
  if (targets.length > 1) {
    const distinct = new Set(targets)
    anyDup = true
    console.log(`${key}`)
    for (const t of targets) console.log(`  -> ${t}`)
    if (distinct.size > 1) console.log(`  !!! distinct targets: ${[...distinct].join(', ')}`)
  }
}
if (!anyDup) console.log('(none)')
