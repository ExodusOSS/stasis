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
  // run recorded all of a,b,c so its chain runs the full a -> b -> c. webpack
  // recorded only b,c: the a -> b edge (a's file) isn't webpack's, so webpack's
  // maximal file-level path is the shorter b -> c.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c']],
    reason: { run: ['a', 'b', 'c'], webpack: ['b', 'c'] },
    scope: 'node_modules',
  })
  const why = collectWhy([file], new Set(['c@1.0.0']))
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['run: a -> b -> c', 'webpack: b -> c'])
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
  // c is imported by src file e (recorded by run) -> `run: c`. webpack recorded
  // c's own file too, so even though it never imports c through the graph, the
  // flagged package still surfaces for it as a bare `webpack: c`.
  t.assert.deepEqual(linesFor(why, 'c@1.0.0'), ['run: c', 'webpack: c'])
}))

test('collectWhy attributes a chain per reason at the file-edge level', withTmp((t, tmp) => {
  // e -> A -> B -> C -> D. run recorded every file, so its chain is the full
  // A -> B -> C -> D. metro recorded e,A,C,D but NOT B: the B -> C edge (B's file)
  // isn't metro's, so `metro: A -> B -> C -> D` must NOT appear. metro's maximal
  // file-level path is the suffix below the break -> `metro: C -> D`.
  const file = writeGraphBundle(tmp, {
    deps: ['A', 'B', 'C', 'D'],
    edges: [['e', 'A'], ['A', 'B'], ['B', 'C'], ['C', 'D']],
    reason: {
      run: ['e', 'A', 'B', 'C', 'D'],
      metro: ['e', 'A', 'C', 'D'], // B missing -> the B -> C edge isn't metro's
    },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['D@1.0.0'])), 'D@1.0.0'), [
    'metro: C -> D',
    'run: A -> B -> C -> D',
  ])
}))

test('collectWhy surfaces a flagged package for a reason that shipped it but never imports it', withTmp((t, tmp) => {
  // e -> A -> D, all under run. metro recorded only D's own file and never imports
  // it through the graph -- but D is flagged and metro shipped it, so metro still
  // appears, as a bare `metro: D` (no import path to trace).
  const file = writeGraphBundle(tmp, {
    deps: ['A', 'D'],
    edges: [['e', 'A'], ['A', 'D']],
    reason: { run: ['e', 'A', 'D'], metro: ['D'] },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['D@1.0.0'])), 'D@1.0.0'), [
    'metro: D',
    'run: A -> D',
  ])
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

test('collectWhy collapses against a standalone sub-family tail, not just the bucket-wide suffix', withTmp((t, tmp) => {
  // C -> B -> A / D -> B -> A / E -> C -> B -> A / F -> C -> B -> A. The whole
  // bucket only shares `B -> A` (too short to collapse), but `C -> B -> A` is its
  // own line and is the tail of the E and F chains -- so those collapse against it
  // (`E -> C -> ... -> A`), while C and D stay full.
  const file = writeGraphBundle(tmp, {
    deps: ['A', 'B', 'C', 'D', 'E', 'F'],
    edges: [
      ['e', 'C'], ['e', 'D'], ['e', 'E'], ['e', 'F'],
      ['C', 'B'], ['D', 'B'], ['E', 'C'], ['F', 'C'], ['B', 'A'],
    ],
  })
  t.assert.deepEqual(collectWhy([file], new Set(['A@1.0.0'])).get('A@1.0.0'), [
    'C -> B -> A',
    'D -> B -> A',
    'E -> C -> ... -> A',
    'F -> C -> ... -> A',
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

// --- react-native -> other-package /package.json edges are not dependencies ---

const writeRnBundle = (dir) => {
  const path = join(dir, 'stasis.code.br')
  const bundle = {
    version: 1,
    config: { scope: 'full' },
    formats: {},
    entries: ['src/entry.js'],
    sources: { '.': { name: 'top', version: '1.0.0', files: { 'src/entry.js': '// e\n' } } },
    modules: {
      'node_modules/react-native': { name: 'react-native', version: '1.0.0', files: { 'index.js': '// rn\n' } },
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': '// foo\n', 'package.json': '{}' } },
      'node_modules/bar': { name: 'bar', version: '1.0.0', files: { 'index.js': '// bar\n' } },
    },
    imports: {
      '*': {
        'src/entry.js': { 'react-native': 'node_modules/react-native/index.js' },
        'node_modules/react-native/index.js': {
          './foo.json': 'node_modules/foo/package.json', // metadata read, NOT a dependency
          bar: 'node_modules/bar/index.js', // a real dependency
        },
      },
    },
  }
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(bundle))))
  return path
}

test('collectWhy ignores react-native edges into another package\'s package.json', withTmp((t, tmp) => {
  const file = writeRnBundle(tmp)
  const why = collectWhy([file])
  // The react-native -> foo/package.json edge is dropped, so foo is not
  // attributed to react-native (it shows as an orphan head instead)...
  t.assert.deepEqual(linesFor(why, 'foo@1.0.0'), ['foo'])
  // ...but a real react-native -> bar dependency still shows.
  t.assert.deepEqual(linesFor(why, 'bar@1.0.0'), ['react-native -> bar'])
}))

// --- terminal packages: never walk past @babel/core / react-native / metro ---

test('collectWhy stops a chain at a terminal package, keeping its reason prefix', withTmp((t, tmp) => {
  // src -> topdep -> @babel/core -> mid -> victim. run recorded the whole chain,
  // so its path stops at @babel/core (topdep dropped) as the head. metro recorded
  // only mid,victim -- it never touches @babel/core, but the mid -> victim edge is
  // metro's, so metro still surfaces via its maximal file-level path `mid -> victim`.
  const file = writeGraphBundle(tmp, {
    deps: ['topdep', '@babel/core', 'mid', 'victim'],
    edges: [['e', 'topdep'], ['topdep', '@babel/core'], ['@babel/core', 'mid'], ['mid', 'victim']],
    reason: {
      run: ['e', 'topdep', '@babel/core', 'mid', 'victim'],
      metro: ['mid', 'victim'],
    },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['victim@1.0.0'])), 'victim@1.0.0'), [
    'metro: mid -> victim',
    'run: @babel/core -> mid -> victim',
  ])
}))

test('collectWhy treats metro and react-native as terminal too', withTmp((t, tmp) => {
  const file = writeGraphBundle(tmp, {
    deps: ['top', 'metro', 'react-native', 'x', 'y'],
    edges: [['e', 'top'], ['top', 'metro'], ['metro', 'x'], ['e', 'react-native'], ['react-native', 'y']],
  })
  const why = collectWhy([file])
  t.assert.deepEqual(linesFor(why, 'x@1.0.0'), ['metro -> x']) // `top` dropped past metro
  t.assert.deepEqual(linesFor(why, 'y@1.0.0'), ['react-native -> y'])
}))

test('collectWhy renders a terminal target bare, once per reason that reaches it', withTmp((t, tmp) => {
  // A terminal package is never walked past -- and that applies when it's the
  // flagged target too: `run: a -> b -> @babel/core` / `metro: c -> d -> @babel/core`
  // both stop AT @babel/core, so the target is emitted bare (`@babel/core`), once
  // per reason that reaches it. The chains above it are noise and never shown.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'd', '@babel/core'],
    edges: [
      ['runEntry', 'a'], ['a', 'b'], ['b', '@babel/core'],
      ['metroEntry', 'c'], ['c', 'd'], ['d', '@babel/core'],
    ],
    reason: {
      run: ['runEntry', 'a', 'b', '@babel/core'],
      metro: ['metroEntry', 'c', 'd', '@babel/core'],
    },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['@babel/core@1.0.0'])), '@babel/core@1.0.0'), [
    'metro: @babel/core',
    'run: @babel/core',
  ])
}))

test('collectWhy keeps every reason for a terminal head, even one src-imported under another', withTmp((t, tmp) => {
  // @babel/core is src-imported under metro AND pulled in via a -> b -> c under run,
  // and it imports victim. The chain to victim stops at @babel/core (terminal); its
  // provenance must include BOTH reasons -- crediting only its src importer (metro)
  // would silently drop run. So both `run:` and `metro: @babel/core -> victim` show.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', '@babel/core', 'victim'],
    edges: [
      ['runEntry', 'a'], ['a', 'b'], ['b', 'c'], ['c', '@babel/core'],
      ['metroEntry', '@babel/core'], ['@babel/core', 'victim'],
    ],
    reason: {
      run: ['runEntry', 'a', 'b', 'c', '@babel/core', 'victim'],
      metro: ['metroEntry', '@babel/core', 'victim'],
    },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['victim@1.0.0'])), 'victim@1.0.0'), [
    'metro: @babel/core -> victim',
    'run: @babel/core -> victim',
  ])
}))

test('collectWhy credits a terminal by its importers, not its (hoisted) own file record', withTmp((t, tmp) => {
  // @babel/core is reached by run (a -> b -> @babel/core) and metro (c -> d ->
  // @babel/core), but its own file is recorded ONLY under run -- a hoisted dep is
  // recorded once. Its reasons must come from what IMPORTS it (b under run, d under
  // metro), so both reasons show; relying on its own file record would drop metro.
  const file = writeGraphBundle(tmp, {
    deps: ['a', 'b', 'c', 'd', '@babel/core'],
    edges: [
      ['runEntry', 'a'], ['a', 'b'], ['b', '@babel/core'],
      ['metroEntry', 'c'], ['c', 'd'], ['d', '@babel/core'],
    ],
    reason: {
      run: ['runEntry', 'a', 'b', '@babel/core'], // @babel/core recorded here only
      metro: ['metroEntry', 'c', 'd'], //            metro reaches it via d, doesn't record it
    },
  })
  t.assert.deepEqual(linesFor(collectWhy([file], new Set(['@babel/core@1.0.0'])), '@babel/core@1.0.0'), [
    'metro: @babel/core',
    'run: @babel/core',
  ])
}))
