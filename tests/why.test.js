import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

import { collectWhy } from '../stasis/src/why.js'

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-why-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Build a bundle from a compact spec:
//   deps:   ['a', 'b', ...]         node_modules packages (version 1.0.0)
//   edges:  [[from, to], ...]       import edges; `to` is always a dep, `from` is
//                                   a dep name or a src file name (anything not
//                                   in `deps` -> src/<from>.js)
//   reason: { consumer: [nodes] }   provenance; a node is a dep name or src name
//   scope:  'full' (default) | 'node_modules'  (node_modules omits src entirely)
// Omitting `reason` yields a single-consumer bundle (no reason map).
const isDep = (deps, node) => deps.includes(node)
const fileFor = (deps, node) => (isDep(deps, node) ? `node_modules/${node}/index.js` : `src/${node}.js`)

const writeGraphBundle = (dir, { deps, edges, reason, scope = 'full' }, name = 'stasis.code.br') => {
  const path = join(dir, name)
  const modules = {}
  for (const d of deps) modules[`node_modules/${d}`] = { name: d, version: '1.0.0', files: { 'index.js': `// ${d}\n` } }

  const srcFiles = new Set()
  const noteSrc = (node) => { if (!isDep(deps, node)) srcFiles.add(`src/${node}.js`) }
  for (const [from] of edges) noteSrc(from)
  if (reason) for (const nodes of Object.values(reason)) for (const n of nodes) noteSrc(n)

  const imports = { '*': {} }
  for (const [from, to] of edges) {
    const parent = fileFor(deps, from)
    imports['*'][parent] ??= {}
    imports['*'][parent][to] = fileFor(deps, to)
  }

  const bundle = { version: 1, config: { scope }, formats: {}, imports, modules }
  if (scope === 'full') {
    const files = {}
    for (const f of srcFiles) files[f] = `// ${f}\n`
    if (Object.keys(files).length === 0) files['src/entry.js'] = '// entry\n'
    bundle.entries = Object.keys(files)
    bundle.sources = { '.': { name: 'top', version: '1.0.0', files } }
  }
  if (reason) {
    bundle.reason = Object.fromEntries(Object.entries(reason).map(([k, nodes]) => [k, nodes.map((n) => fileFor(deps, n))]))
  }
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(bundle))))
  return path
}

const linesFor = (why, key) => [...(why.get(key) ?? [])].toSorted((a, b) => a.localeCompare(b))

test('collectWhy prefixes each chain with its head\'s top-level importer reasons', withTmp((t, tmp) => {
  // runEntry (reason run) imports a,b; wpEntry (reason webpack) imports b,x.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'x'],
    edges: [
      ['runEntry', 'a'], ['runEntry', 'b'], ['wpEntry', 'b'], ['wpEntry', 'x'],
      ['a', 'b'], ['b', 'c'], ['x', 'c'],
    ],
    reason: {
      run: ['runEntry', 'a', 'b', 'c'],
      webpack: ['wpEntry', 'b', 'x', 'c'],
    },
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), [
    'run: a -> b -> c', // a is imported only by runEntry
    'run: b -> c',      // b is imported by both entries -> two lines
    'webpack: b -> c',
    'webpack: x -> c', // x imported only by wpEntry
  ])
}))

test('collectWhy with a reason filter keeps only that consumer\'s chains', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'x'],
    edges: [
      ['runEntry', 'a'], ['runEntry', 'b'], ['wpEntry', 'b'], ['wpEntry', 'x'],
      ['a', 'b'], ['b', 'c'], ['x', 'c'],
    ],
    reason: {
      run: ['runEntry', 'a', 'b', 'c'],
      webpack: ['wpEntry', 'b', 'x', 'c'],
    },
  })
  const why = collectWhy([file], new Set(['c@1.0.0']), 'run')
  // Under --reason the column is all one consumer, so chains render bare (no prefix).
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['a -> b -> c', 'b -> c'])
}))

test('collectWhy with a reason filter drops bare (unattributed) chains', withTmp((t, tmp) => {
  // No reason map -> chains are unattributed and can't match a named reason.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['e', 'a'], ['a', 'b'], ['b', 'c']],
  })
  const why = collectWhy([file], new Set(['c@1.0.0']), 'run')
  t.assert.equal(why.has('c@1.0.0'), false)
}))

test('collectWhy renders bare chains when a bundle has no reason map', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'x'],
    edges: [['e', 'a'], ['e', 'b'], ['e', 'x'], ['a', 'b'], ['x', 'b'], ['b', 'c']],
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['a -> b -> c', 'b -> c', 'x -> b -> c'])
}))

test('collectWhy includes a chain whose head is not imported by src (top of the tree)', withTmp((t, tmp) => {
  // scope=node_modules: no src at all. a -> b -> c, with a as the chain head.
  // a is recorded only by run, so the chain is attributed to run (head fallback).
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c']],
    reason: { run: ['a', 'b', 'c'], webpack: ['b', 'c'] },
    scope: 'node_modules',
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['run: a -> b -> c'])
}))

test('collectWhy falls back to the head\'s own reasons when there is no top-level importer', withTmp((t, tmp) => {
  // a is the head; recorded by both consumers -> both attributed.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c']],
    reason: { run: ['a', 'b', 'c'], webpack: ['a', 'b', 'c'] },
    scope: 'node_modules',
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['run: a -> b -> c', 'webpack: a -> b -> c'])
}))

test('collectWhy renders bare chains for a node_modules bundle with no reason map', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c']],
    scope: 'node_modules',
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['a -> b -> c'])
}))

test('collectWhy shows a single-node chain for a directly-imported dependency', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['c'],
    edges: [['e', 'c']],
    reason: { run: ['e', 'c'], webpack: ['c'] },
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  // c is imported by src file e (recorded by run); webpack recorded c but
  // did not import it at top level, so the chain is run's.
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['run: c'])
}))

test('collectWhy terminates on cycles and keeps only simple paths', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['e', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'a']], // a -> b -> c -> a cycle
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['a -> b -> c'])
}))

test('collectWhy restricts work to the requested target keys', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b'],
    edges: [['e', 'a'], ['a', 'b']],
  })
  const why = collectWhy([file], new Set(['b@1.0.0']))
  t.assert.deepEqual([...why.keys()], ['b@1.0.0'])
  t.assert.deepEqual(linesFor(why, 'b@1.0.0'), ['a -> b'])
}))

test('collectWhy returns nothing for an artifact without an imports graph', withTmp((t, tmp) => {
  const path = join(tmp, 'stasis.lock.json')
  writeFileSync(path, JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/entry.js'],
    sources: { '.': { name: 'top', version: '1.0.0', files: { 'src/entry.js': 'sha512-x' } } },
    modules: { 'node_modules/c': { name: 'c', version: '1.0.0', files: { 'index.js': 'sha512-y' } } },
  }))
  t.assert.equal(collectWhy([path]).size, 0)
}))

// --- chain dedup / compression --------------------------------------------

test('collectWhy collapses the shared tail, shortest chain shown in full', withTmp((t, tmp) => {
  // src imports a and b; a -> b -> c -> d, and b (imported directly) -> c -> d.
  // The shared tail `b -> c -> d` shows in full (shortest chain); the longer one
  // collapses its interior.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'd'],
    edges: [['e', 'a'], ['e', 'b'], ['a', 'b'], ['b', 'c'], ['c', 'd']],
  })
  t.assert.deepEqual(collectWhy([file], new Set(['d@1.0.0'])).get('d@1.0.0'), [
    'b -> c -> d',        // shortest -> full, first
    'a -> b -> ... -> d', // collapse the shared `b -> c -> d` tail
  ])
}))

test('collectWhy orders shortest-first, then alphabetically', withTmp((t, tmp) => {
  // a and x both go through b -> c -> d; b is imported directly too (convergence).
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'x', 'b', 'c', 'd'],
    edges: [['e', 'a'], ['e', 'x'], ['e', 'b'], ['a', 'b'], ['x', 'b'], ['b', 'c'], ['c', 'd']],
  })
  t.assert.deepEqual(collectWhy([file], new Set(['d@1.0.0'])).get('d@1.0.0'), [
    'b -> c -> d',        // shortest -> full canonical, first
    'a -> b -> ... -> d', // len 4, alpha before x
    'x -> b -> ... -> d',
  ])
}))

test('collectWhy does not collapse when paths branch above the target', withTmp((t, tmp) => {
  // b reaches d via c AND via f, so nothing deeper than d is shared -- no collapse.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'f', 'd'],
    edges: [['e', 'a'], ['e', 'b'], ['a', 'b'], ['b', 'c'], ['b', 'f'], ['c', 'd'], ['f', 'd']],
  })
  t.assert.deepEqual(collectWhy([file], new Set(['d@1.0.0'])).get('d@1.0.0'), [
    'b -> c -> d',
    'b -> f -> d',
    'a -> b -> c -> d',
    'a -> b -> f -> d',
  ])
}))

test('collectWhy collapses the shared tail once, keeping each chain\'s prefix', withTmp((t, tmp) => {
  // All chains funnel through E -> D -> C -> B -> A; D is also a direct dep, so the
  // shared tail is `D -> C -> B -> A`. It shows once (the D chain) and every other
  // chain collapses just that tail's interior, keeping its prefix down to D.
  const file = writeGraphBundle(tmp, {
    deps: ['P', 'Q', 'G', 'H', 'F', 'E', 'D', 'C', 'B', 'A'],
    edges: [
      ['e', 'P'], ['e', 'Q'], ['e', 'G'], ['e', 'H'], ['e', 'D'],
      ['P', 'E'], ['Q', 'E'], ['G', 'F'], ['H', 'F'], ['F', 'E'],
      ['E', 'D'], ['D', 'C'], ['C', 'B'], ['B', 'A'],
    ],
  })
  t.assert.deepEqual(collectWhy([file], new Set(['A@1.0.0'])).get('A@1.0.0'), [
    'D -> C -> B -> A',            // shared tail, shown once, first
    'P -> E -> D -> ... -> A',     // keep prefix down to the tail head D
    'Q -> E -> D -> ... -> A',
    'G -> F -> E -> D -> ... -> A',
    'H -> F -> E -> D -> ... -> A',
  ])
}))

test('collectWhy compresses only within a single reason bucket', withTmp((t, tmp) => {
  // run imports a (-> b -> c -> d); webpack imports b (-> c -> d) directly.
  // b -> c -> d must NOT collapse: nothing longer sits in the webpack bucket.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'd'],
    edges: [['runEntry', 'a'], ['wpEntry', 'b'], ['a', 'b'], ['b', 'c'], ['c', 'd']],
    reason: {
      run: ['runEntry', 'a', 'b', 'c', 'd'],
      webpack: ['wpEntry', 'b', 'c', 'd'],
    },
  })
  t.assert.deepEqual(collectWhy([file], new Set(['d@1.0.0'])).get('d@1.0.0'), [
    'run: a -> b -> c -> d',
    'webpack: b -> c -> d',
  ])
}))
