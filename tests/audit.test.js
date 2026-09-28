import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { advisoryPackages, audit, collectPackages, collectPackagesFromFile, collectReasons, flattenAdvisories, formatTable, printAuditReport } from '../stasis/src/audit.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeLock = (dir, name = 'stasis.lock.json', extra = {}) => {
  const path = join(dir, name)
  const lock = {
    version: 0,
    config: { scope: 'full' },
    entries: ['src/entry.js'],
    sources: {
      '.': { name: 'top-pkg', version: '1.0.0', files: { 'src/entry.js': 'sha512-x' } },
    },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.2.3', files: { 'index.js': 'sha512-y' } },
      'node_modules/bar': { name: 'bar', version: '4.5.6', files: { 'index.js': 'sha512-z' } },
    },
    imports: {},
    formats: {},
    ...extra,
  }
  writeFileSync(path, JSON.stringify(lock))
  return path
}

const writeBundle = (dir, name = 'snapshot.br', extra = {}) => {
  const path = join(dir, name)
  const bundle = {
    version: 1,
    config: { scope: 'full' },
    entries: ['src/entry.js'],
    sources: {
      '.': { name: 'top-pkg', version: '9.9.9', files: { 'src/entry.js': 'export const x = 1\n' } },
    },
    modules: {
      'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': 'export const f = 1\n' } },
      'node_modules/baz': { name: 'baz', version: '0.0.1', files: { 'index.js': 'export const b = 1\n' } },
    },
    formats: { 'node_modules/foo/index.js': 'module' },
    imports: {},
    ...extra,
  }
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(bundle))))
  return path
}

test('collectPackages reads name/version from a lockfile (node_modules only)', withTmp((t, tmp) => {
  const file = writeLock(tmp)
  const pkgs = collectPackagesFromFile(file)
  t.assert.deepEqual(
    pkgs.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { ecosystem: 'npm', name: 'bar', version: '4.5.6' },
      { ecosystem: 'npm', name: 'foo', version: '1.2.3' },
    ]
  )
}))

test('collectPackages reads name/version from a brotli bundle (node_modules only)', withTmp((t, tmp) => {
  const file = writeBundle(tmp)
  const pkgs = collectPackagesFromFile(file)
  t.assert.deepEqual(
    pkgs.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { ecosystem: 'npm', name: 'baz', version: '0.0.1' },
      { ecosystem: 'npm', name: 'foo', version: '2.0.0' },
    ]
  )
}))

test('collectPackages skips workspace (first-party) modules', withTmp((t, tmp) => {
  const lock = writeLock(tmp)
  const bundle = writeBundle(tmp)
  const pkgs = collectPackages([lock, bundle])
  t.assert.ok(!pkgs.some((p) => p.name === 'top-pkg'), 'workspace package must not be audited')
}))

test('collectPackages skips bundle modules without name/version (v0 legacy)', withTmp((t, tmp) => {
  const path = join(tmp, 'legacy.br')
  const legacy = {
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { 'node_modules/foo/index.js': 'x' },
  }
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(legacy))))
  t.assert.deepEqual(collectPackagesFromFile(path), [])
}))

test('collectPackages deduplicates across files', withTmp((t, tmp) => {
  const lock = writeLock(tmp)
  const bundle = writeBundle(tmp)
  const pkgs = collectPackages([lock, bundle])
  // foo appears in both at different versions, both should remain
  t.assert.deepEqual(pkgs, [
    { ecosystem: 'npm', name: 'bar', version: '4.5.6' },
    { ecosystem: 'npm', name: 'baz', version: '0.0.1' },
    { ecosystem: 'npm', name: 'foo', version: '1.2.3' },
    { ecosystem: 'npm', name: 'foo', version: '2.0.0' },
  ])
}))

test('collectPackages dedupes exact name+version duplicates', withTmp((t, tmp) => {
  const a = writeLock(tmp, 'a.json')
  const b = writeLock(tmp, 'b.json')
  const pkgs = collectPackages([a, b])
  t.assert.equal(pkgs.length, 2)
}))

// --- audit corrections: only recorded real-code evidence counts as presence ---

test('collectPackages skips ws recorded only as its noop browser.js (+ manifest)', withTmp((t, tmp) => {
  // The real shape: ws bundled only through `-> ws/browser.js` (a throw-only stub)
  // records browser.js + the resolver-read package.json. None of ws's real code
  // ships, so it is not audited; foo (real code recorded) is.
  const bundle = writeBundle(tmp, 'ws.br', {
    modules: {
      'node_modules/ws': { name: 'ws', version: '7.5.9', files: { 'browser.js': '// noop\n', 'package.json': '{}' } },
      'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': '// f\n' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [{ ecosystem: 'npm', name: 'foo', version: '2.0.0' }])
}))

test('collectPackages keeps ws when any real file of it is recorded', withTmp((t, tmp) => {
  const bundle = writeBundle(tmp, 'ws.br', {
    modules: {
      'node_modules/ws': { name: 'ws', version: '7.5.9', files: { 'browser.js': '// noop\n', 'lib.js': '// real\n', 'package.json': '{}' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [{ ecosystem: 'npm', name: 'ws', version: '7.5.9' }])
}))

test('collectPackages flags recorded code even when no import edge targets it', withTmp((t, tmp) => {
  // Entry and `add`-consumer files are recorded with NO in-edge in the resolution
  // graph -- presence is recorded-files-based, never edge-based, so real code
  // stays audited even when the graph doesn't reach it.
  const bundle = writeBundle(tmp, 'noedge.br', {
    modules: {
      'node_modules/added': { name: 'added', version: '1.0.0', files: { 'index.js': '// preloaded\n' } },
      'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': '// f\n' } },
    },
    imports: { '*': { 'src/entry.js': { foo: 'node_modules/foo/index.js' } } },
  })
  t.assert.deepEqual(collectPackages([bundle]), [
    { ecosystem: 'npm', name: 'added', version: '1.0.0' },
    { ecosystem: 'npm', name: 'foo', version: '2.0.0' },
  ])
}))

test('collectPackages does not correct ws versions outside the verified range', withTmp((t, tmp) => {
  // The stub is only verified up to the range pinned in audit-corrections.js; a
  // newer ws stays audited even when recorded only as browser.js.
  const bundle = writeBundle(tmp, 'ws9.br', {
    modules: {
      'node_modules/ws': { name: 'ws', version: '9.0.0', files: { 'browser.js': '// ?\n', 'package.json': '{}' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [{ ecosystem: 'npm', name: 'ws', version: '9.0.0' }])
}))

test('collectPackages skips node-fetch recorded only as browser.js (<= 2.7.0)', withTmp((t, tmp) => {
  // node-fetch's browser.js just re-exports the native fetch; it carries none of
  // the node-fetch implementation. Corrected through 2.7.0 (the last with it).
  const bundle = writeBundle(tmp, 'nf.br', {
    modules: {
      'node_modules/node-fetch': { name: 'node-fetch', version: '2.7.0', files: { 'browser.js': '// native fetch\n', 'package.json': '{}' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [])
}))

test('collectPackages keeps node-fetch 3.x (no browser.js correction)', withTmp((t, tmp) => {
  const bundle = writeBundle(tmp, 'nf3.br', {
    modules: {
      'node_modules/node-fetch': { name: 'node-fetch', version: '3.3.2', files: { 'src.js': '// impl\n' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [{ ecosystem: 'npm', name: 'node-fetch', version: '3.3.2' }])
}))

test('collectPackages corrections are package-specific', withTmp((t, tmp) => {
  // A browser.js recorded in any OTHER package still counts as present.
  const bundle = writeBundle(tmp, 'other.br', {
    modules: {
      'node_modules/other': { name: 'other', version: '1.0.0', files: { 'browser.js': '// b\n' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [{ ecosystem: 'npm', name: 'other', version: '1.0.0' }])
}))

test('collectPackages never counts a package.json manifest as presence', withTmp((t, tmp) => {
  // A package recorded only through its manifest (a resolver/metadata read, or a
  // `require('pkg/package.json')`) ships none of its code -- not audited.
  const bundle = writeBundle(tmp, 'manifest.br', {
    modules: {
      'node_modules/meta-only': { name: 'meta-only', version: '1.0.0', files: { 'package.json': '{}' } },
    },
  })
  t.assert.deepEqual(collectPackages([bundle]), [])
}))

test('collectPackages applies the same evidence rule to lockfiles', withTmp((t, tmp) => {
  // A ws attested as only its browser.js (+package.json) is corrected away; foo
  // (real code attested) stays audited.
  const lock = writeLock(tmp, 'ws.lock.json', {
    modules: {
      'node_modules/ws': { name: 'ws', version: '8.21.1', files: { 'browser.js': 'sha512-w', 'package.json': 'sha512-p' } },
      'node_modules/foo': { name: 'foo', version: '1.2.3', files: { 'index.js': 'sha512-y', 'package.json': 'sha512-p' } },
    },
  })
  t.assert.deepEqual(collectPackages([lock]), [{ ecosystem: 'npm', name: 'foo', version: '1.2.3' }])
}))

test('collectReasons excludes a consumer that recorded only corrected files', withTmp((t, tmp) => {
  // webpack shipped nothing of ws but the stub (+ manifest): none of ws's real
  // code is in its bundle, so webpack is not one of ws's reasons; run (which
  // bundled the real index.js) is.
  const bundle = writeBundle(tmp, 'wsreason.br', {
    modules: {
      'node_modules/ws': { name: 'ws', version: '7.5.9', files: { 'browser.js': '// noop\n', 'index.js': '// real\n', 'package.json': '{}' } },
    },
    reason: {
      webpack: ['node_modules/ws/browser.js', 'node_modules/ws/package.json'],
      run: ['node_modules/ws/index.js'],
    },
  })
  t.assert.deepEqual([...collectReasons([bundle]).get('ws@7.5.9')], ['run'])
}))

test('collectPackagesFromFile rejects unknown JSON shape with a lockfile-specific error', withTmp((t, tmp) => {
  const file = join(tmp, 'junk.json')
  writeFileSync(file, JSON.stringify({ hello: 'world' }))
  t.assert.throws(() => collectPackagesFromFile(file), /Failed to parse stasis lockfile/)
}))

test('collectPackagesFromFile rejects non-brotli non-JSON binary with a bundle-specific error', withTmp((t, tmp) => {
  const file = join(tmp, 'junk.bin')
  writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd, 0xfc]))
  t.assert.throws(() => collectPackagesFromFile(file), /Failed to read .* as a stasis bundle/)
}))

test('collectPackagesFromFile reports a clean error when the input is missing', (t) => {
  const file = join(tmpdir(), 'definitely-does-not-exist-stasis.lock.json')
  t.assert.throws(() => collectPackagesFromFile(file), /File not found:/)
})

test('collectPackagesFromFile wraps brotli-valid but JSON-corrupt bundles', withTmp((t, tmp) => {
  const file = join(tmp, 'corrupt.br')
  writeFileSync(file, brotliCompressSync(Buffer.from('not valid json {')))
  t.assert.throws(() => collectPackagesFromFile(file), /Failed to parse stasis bundle/)
}))

test('collectPackagesFromFile accepts a bundle carrying only resources', withTmp((t, tmp) => {
  const file = join(tmp, 'resources.br')
  const json = {
    version: 1,
    config: { scope: 'full' },
    sources: {
      '.': { name: 'top', version: '1.0.0', files: { 'a.bin': 'AAA=' } },
    },
    modules: {
      'node_modules/lib': { name: 'lib', version: '3.2.1', files: { 'b.bin': 'BBB=' } },
    },
    // Resources are tagged per-file in the unified bundle; no code => no entries.
    formats: { 'a.bin': 'resource:base64', 'node_modules/lib/b.bin': 'resource:base64' },
    imports: {},
  }
  writeFileSync(file, brotliCompressSync(Buffer.from(JSON.stringify(json))))
  t.assert.deepEqual(collectPackagesFromFile(file), [{ ecosystem: 'npm', name: 'lib', version: '3.2.1' }])
}))

test('collectPackages does not collapse different packages at the same version', withTmp((t, tmp) => {
  const file = join(tmp, 'lock.json')
  writeFileSync(file, JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/a': { name: 'a', version: '1.0.0', files: { 'i.js': 'sha512-x' } },
      'node_modules/b': { name: 'b', version: '1.0.0', files: { 'i.js': 'sha512-y' } },
    },
    imports: {},
    formats: {},
  }))
  t.assert.deepEqual(collectPackages([file]), [
    { ecosystem: 'npm', name: 'a', version: '1.0.0' },
    { ecosystem: 'npm', name: 'b', version: '1.0.0' },
  ])
}))

test('collectReasons maps a bundle reason map to node_modules packages', withTmp((t, tmp) => {
  const file = writeBundle(tmp, 'r.br', {
    reason: {
      run: ['node_modules/foo/index.js'],
      // src/entry.js is a workspace source (not node_modules) and must be ignored
      webpack: ['node_modules/baz/index.js', 'node_modules/foo/index.js', 'src/entry.js'],
    },
  })
  const reasons = collectReasons([file])
  t.assert.deepEqual([...reasons.get('foo@2.0.0')].toSorted(), ['run', 'webpack'])
  t.assert.deepEqual([...reasons.get('baz@0.0.1')].toSorted(), ['webpack'])
}))

test('collectReasons returns nothing for a lockfile (no reason map)', withTmp((t, tmp) => {
  const file = writeLock(tmp)
  t.assert.equal(collectReasons([file]).size, 0)
}))

test('collectReasons returns nothing for a bundle without a reason map', withTmp((t, tmp) => {
  const file = writeBundle(tmp)
  t.assert.equal(collectReasons([file]).size, 0)
}))

test('collectReasons unions reasons across multiple files', withTmp((t, tmp) => {
  const a = writeBundle(tmp, 'a.br', { reason: { run: ['node_modules/foo/index.js'] } })
  const b = writeBundle(tmp, 'b.br', { reason: { webpack: ['node_modules/foo/index.js'] } })
  const reasons = collectReasons([a, b])
  t.assert.deepEqual([...reasons.get('foo@2.0.0')].toSorted(), ['run', 'webpack'])
}))

// A row as @preventive/upstream's advisories() answers it.
const found = (name, versions, fields = {}) => ({ ecosystem: 'npm', name, source: 'registry', id: 'GHSA-aaaa-bbbb-cccc', aliases: [], cwe: [], range: '*', versions, ...fields })

test('flattenAdvisories sorts by severity then package', (t) => {
  const result = [
    found('bar', ['1.0.0'], { severity: 'critical', title: 'aaa', range: '<5' }),
    found('foo', ['1.0.0'], { severity: 'low', title: 't1', range: '<2' }),
    found('foo', ['1.0.0'], { severity: 'critical', title: 't2', range: '<2' }),
  ]
  const rows = flattenAdvisories(result)
  t.assert.deepEqual(rows.map((r) => [r.severity, r.package, r.title]), [
    ['critical', 'bar', 'aaa'],
    ['critical', 'foo', 't2'],
    ['low', 'foo', 't1'],
  ])
})

test('flattenAdvisories lists the covered versions and carries range, title and id', (t) => {
  const rows = flattenAdvisories([found('foo', ['1.0.0', '1.5.0'], { severity: 'high', title: 'x', range: '<2' })])
  t.assert.deepEqual(rows, [{ package: 'foo', installed: '1.0.0, 1.5.0', vulnerable: '<2', severity: 'high', title: 'x', id: 'GHSA-aaaa-bbbb-cccc', reason: '' }])
})

test('flattenAdvisories joins the reasons of the affected versions, sorted', (t) => {
  // foo@3.0.0 is installed too, but the advisory covers only 1.0.0: only its reasons show,
  // ordered plugins then run.
  const result = [found('foo', ['1.0.0'], { severity: 'high', title: 'x', range: '<2' })]
  const reasons = new Map([
    ['foo@1.0.0', new Set(['run', 'webpack'])],
    ['foo@3.0.0', new Set(['metro'])],
  ])
  const rows = flattenAdvisories(result, reasons)
  t.assert.equal(rows.length, 1)
  t.assert.equal(rows[0].installed, '1.0.0')
  t.assert.equal(rows[0].reason, 'webpack, run')
})

test('flattenAdvisories leaves reason empty when a package has none', (t) => {
  const rows = flattenAdvisories([found('foo', ['1.0.0'], { severity: 'high', title: 'x', range: '<2' })])
  t.assert.equal(rows[0].reason, '')
})

test('flattenAdvisories uses the --why paths (newline-joined) as the reason cell', (t) => {
  const result = [found('foo', ['1.0.0'], { severity: 'high', title: 'x' })]
  const why = new Map([['foo@1.0.0', new Set(['run: a -> foo', 'webpack: b -> foo'])]])
  const rows = flattenAdvisories(result, undefined, why)
  // The why map wins over the (absent) consumer list; consumers order plugins then run.
  t.assert.equal(rows[0].reason, 'webpack: b -> foo\nrun: a -> foo')
})

test('flattenAdvisories orders --why consumers plugins -> run -> add', (t) => {
  const result = [found('foo', ['1.0.0'], { severity: 'high', title: 'x' })]
  const why = new Map([['foo@1.0.0', new Set(['add: foo', 'run: foo', 'metro: a -> foo'])]])
  const rows = flattenAdvisories(result, undefined, why)
  t.assert.equal(rows[0].reason, 'metro: a -> foo\nrun: foo\nadd: foo')
})

test('flattenAdvisories groups a consumer\'s --why lines across affected versions', (t) => {
  const result = [found('foo', ['1.0.0', '2.0.0'], { severity: 'high', title: 'x' })]
  // Each version contributes a metro and a run line; unioned naively they would
  // interleave (metro, run, metro). Grouping keeps all metro lines together, then run.
  const why = new Map([
    ['foo@1.0.0', new Set(['metro: a -> foo', 'run: foo'])],
    ['foo@2.0.0', new Set(['metro: b -> foo', 'run: foo'])],
  ])
  const rows = flattenAdvisories(result, undefined, why)
  t.assert.equal(rows[0].reason, 'metro: a -> foo\nmetro: b -> foo\nrun: foo')
})

test('flattenAdvisories --reason narrows the consumer list and drops unrelated rows', (t) => {
  const result = [
    found('bar', ['1.0.0'], { severity: 'low', title: 'y' }),
    found('foo', ['1.0.0'], { severity: 'high', title: 'x' }),
  ]
  const reasons = new Map([
    ['foo@1.0.0', new Set(['run', 'webpack'])],
    ['bar@1.0.0', new Set(['webpack'])],
  ])
  const rows = flattenAdvisories(result, reasons, null, 'run')
  // bar is only webpack -> dropped; foo's cell is narrowed to run.
  t.assert.deepEqual(rows.map((r) => [r.package, r.reason]), [['foo', 'run']])
})

test('formatTable renders a multiline cell across physical rows', (t) => {
  const out = formatTable([{ a: 'x', b: 'l1\nl2' }], ['a', 'b'], { multiline: ['b'] })
  const lines = out.split('\n')
  // top border + header + separator + 2 body lines + bottom border
  t.assert.equal(lines.length, 6)
  t.assert.match(lines[3], /│ x +│ l1 +│/u)
  t.assert.match(lines[4], /│ +│ l2 +│/u) // the 'a' cell is blank on the continuation row
})

test('printAuditReport renders the --why reason column across multiple lines', (t) => {
  const out = []
  printAuditReport(
    {
      why: true,
      packages: [{ name: 'foo', version: '1.0.0' }],
      rows: [{ severity: 'high', package: 'foo', installed: '1.0.0', vulnerable: '*', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: 'run: a -> foo\nrun: b -> foo' }],
    },
    { out: { write: (s) => out.push(s) }, err: { write: () => {} } }
  )
  const text = stripVTControlCharacters(out.join(''))
  t.assert.equal(text.split('\n').filter((l) => l.includes('-> foo')).length, 2)
})

test('printAuditReport shows a reason column when a row has reasons', (t) => {
  const out = []
  printAuditReport(
    {
      packages: [{ name: 'foo', version: '1.0.0' }],
      rows: [{ severity: 'high', package: 'foo', installed: '1.0.0', vulnerable: '<2', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: 'run, webpack' }],
    },
    { out: { write: (s) => out.push(s) }, err: { write: () => {} } }
  )
  const text = stripVTControlCharacters(out.join(''))
  t.assert.match(text, /│ reason\s+│/u)
  t.assert.match(text, /run, webpack/u)
})

test('printAuditReport omits the reason column when no row has reasons', (t) => {
  const out = []
  printAuditReport(
    {
      packages: [{ name: 'foo', version: '1.0.0' }],
      rows: [{ severity: 'high', package: 'foo', installed: '1.0.0', vulnerable: '<2', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: '' }],
    },
    { out: { write: (s) => out.push(s) }, err: { write: () => {} } }
  )
  t.assert.doesNotMatch(stripVTControlCharacters(out.join('')), /reason/u)
})

test('printAuditReport hides the reason column under --reason without --why', (t) => {
  const out = []
  printAuditReport(
    {
      reason: 'run',
      packages: [{ name: 'foo', version: '1.0.0' }],
      // Every cell would just repeat the filter value ('run'), so the column is noise.
      rows: [{ severity: 'high', package: 'foo', installed: '1.0.0', vulnerable: '<2', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: 'run' }],
    },
    { out: { write: (s) => out.push(s) }, err: { write: () => {} } }
  )
  t.assert.doesNotMatch(stripVTControlCharacters(out.join('')), /reason/u)
})

test('printAuditReport keeps the reason column under --reason WITH --why', (t) => {
  const out = []
  printAuditReport(
    {
      reason: 'run',
      why: true,
      packages: [{ name: 'foo', version: '1.0.0' }],
      rows: [{ severity: 'high', package: 'foo', installed: '1.0.0', vulnerable: '<2', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: 'run: a -> foo' }],
    },
    { out: { write: (s) => out.push(s) }, err: { write: () => {} } }
  )
  const text = stripVTControlCharacters(out.join(''))
  t.assert.match(text, /│ reason/u)
  t.assert.match(text, /run: a -> foo/u)
})

test('printAuditReport summarizes the alerts by severity, most severe first', (t) => {
  const err = []
  const row = (severity) => ({ severity, package: 'foo', installed: '1.0.0', vulnerable: '*', title: 't', id: 'GHSA-aaaa-bbbb-cccc', reason: '' })
  printAuditReport(
    { packages: [{ name: 'foo', version: '1.0.0' }, { name: 'bar', version: '1.0.0' }, { name: 'baz', version: '1.0.0' }], rows: [row('critical'), row('high'), row('high'), row('low'), row('')] },
    { out: { write: () => {} }, err: { write: (s) => err.push(s) } }
  )
  t.assert.equal(err.join(''), 'Scanned 3 packages: 5 alerts, 1 critical, 2 high, 1 low, 1 unrated\n')
})

test('printAuditReport reports 0 alerts and prints no table', (t) => {
  const out = []
  const err = []
  printAuditReport({ packages: [{ name: 'foo', version: '1.0.0' }], rows: [] }, { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } })
  t.assert.equal(err.join(''), 'Scanned 1 package: 0 alerts\n')
  t.assert.deepEqual(out, [])
})

test('printAuditReport hints when nothing was scanned', (t) => {
  const lines = []
  const err = { write: (s) => lines.push(s) }
  printAuditReport({ packages: [], rows: [] }, { out: { write: () => {} }, err })
  t.assert.equal(lines.join(''), 'Scanned 0 packages\nNo dependencies found in the input files\n')
})

test('formatTable produces a boxed table with header and separator', (t) => {
  const out = formatTable(
    [
      { a: 'x', b: 'yyy' },
      { a: 'xxx', b: 'y' },
    ],
    ['a', 'b']
  )
  const lines = out.split('\n')
  t.assert.equal(lines.length, 6)
  t.assert.match(lines[0], /^┌─+┬─+┐$/u)
  t.assert.match(lines[1], /^│ a +│ b +│$/u)
  t.assert.match(lines[2], /^├─+┼─+┤$/u)
  t.assert.match(lines[5], /^└─+┴─+┘$/u)
})

// CLI integration
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const runCli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

test('audit with no files prints usage', (t) => {
  const r = runCli(['audit'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to audit/)
})

test('audit rejects unknown file shape', withTmp((t, tmp) => {
  const file = join(tmp, 'junk.json')
  writeFileSync(file, JSON.stringify({ hello: 'world' }))
  const r = runCli(['audit', file])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Failed to parse stasis lockfile/)
}))

test('audit rejects an unknown flag', (t) => {
  const r = runCli(['audit', '--nope'])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Error:/)
})

test('audit --why with no files prints usage', (t) => {
  const r = runCli(['audit', '--why'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to audit/)
})

test('audit --reason consumes its value (space form) then reports no files', (t) => {
  // `--reason run` must swallow `run` as the value, leaving no positional file.
  const r = runCli(['audit', '--reason', 'run'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to audit/)
})

const withFetch = (impl, fn) => async (t) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return impl({ url, opts })
  }
  try {
    return await fn(t, calls)
  } finally {
    globalThis.fetch = original
  }
}

test('audit() POSTs grouped versions to the npm bulk endpoint and joins rows', withFetch(
  () => new Response(JSON.stringify({
    foo: [{ id: 1, severity: 'high', title: 'bug', url: 'https://x', vulnerable_versions: '<2' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t, calls) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const lock = writeLock(tmp)
      const report = await audit([lock])
      t.assert.equal(calls.length, 1)
      t.assert.equal(calls[0].url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
      t.assert.equal(calls[0].opts.method, 'POST')
      const body = JSON.parse(calls[0].opts.body)
      t.assert.deepEqual(body, { bar: ['4.5.6'], foo: ['1.2.3'] }, 'workspace top-pkg must not be sent')
      t.assert.equal(report.rows.length, 1)
      t.assert.equal(report.rows[0].severity, 'high')
      t.assert.equal(report.rows[0].installed, '1.2.3')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit() collects from a brotli bundle and POSTs its node_modules versions', withFetch(
  () => new Response(JSON.stringify({
    foo: [{ id: 1, severity: 'critical', title: 'bug', url: 'https://x', vulnerable_versions: '<3' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t, calls) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const bundle = writeBundle(tmp)
      const report = await audit([bundle])
      t.assert.equal(calls.length, 1)
      t.assert.equal(calls[0].url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
      t.assert.equal(calls[0].opts.method, 'POST')
      const body = JSON.parse(calls[0].opts.body)
      t.assert.deepEqual(body, { baz: ['0.0.1'], foo: ['2.0.0'] }, 'workspace top-pkg must not be sent')
      t.assert.equal(report.rows.length, 1)
      t.assert.equal(report.rows[0].severity, 'critical')
      t.assert.equal(report.rows[0].installed, '2.0.0')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit() attaches bundle reasons to advisory rows', withFetch(
  () => new Response(JSON.stringify({
    foo: [{ id: 1, severity: 'critical', title: 'bug', url: 'https://x', vulnerable_versions: '<3' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const bundle = writeBundle(tmp, 'snapshot.br', {
        reason: {
          run: ['node_modules/foo/index.js'],
          webpack: ['node_modules/foo/index.js'],
        },
      })
      const report = await audit([bundle])
      const foo = report.rows.find((r) => r.package === 'foo')
      t.assert.equal(foo.reason, 'webpack, run')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit(--why) replaces the reason cell with per-consumer import paths', withFetch(
  () => new Response(JSON.stringify({
    foo: [{ id: 1, severity: 'high', title: 'bug', url: 'https://x', vulnerable_versions: '*' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const path = join(tmp, 'stasis.code.br')
      writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify({
        version: 1,
        config: { scope: 'full' },
        entries: ['src/entry.js'],
        sources: { '.': { name: 'top', version: '1.0.0', files: { 'src/entry.js': '// e\n' } } },
        modules: {
          'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': '// foo\n' } },
          'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': '// dep\n' } },
        },
        formats: {},
        imports: {
          '*': {
            'src/entry.js': { dep: 'node_modules/dep/index.js' },
            'node_modules/dep/index.js': { foo: 'node_modules/foo/index.js' },
          },
        },
        reason: {
          run: ['src/entry.js', 'node_modules/dep/index.js', 'node_modules/foo/index.js'],
          webpack: ['src/entry.js', 'node_modules/dep/index.js', 'node_modules/foo/index.js'],
        },
      }))))
      const report = await audit([path], { why: true })
      t.assert.equal(report.why, true)
      const foo = report.rows.find((r) => r.package === 'foo')
      t.assert.equal(foo.reason, 'webpack: dep -> foo\nrun: dep -> foo')

      // --reason narrows the chains to that single consumer.
      // Under --reason the chains render bare (no `run:` prefix -- the whole
      // column is that one consumer).
      const filtered = await audit([path], { why: true, reason: 'run' })
      t.assert.equal(filtered.rows.find((r) => r.package === 'foo').reason, 'dep -> foo')

      // --reason for a consumer that recorded nothing drops the row entirely.
      const none = await audit([path], { why: true, reason: 'metro' })
      t.assert.equal(none.rows.length, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit(--why-deep) implies --why and keeps chains the default prunes', withFetch(
  () => new Response(JSON.stringify({
    foo: [{ id: 1, severity: 'high', title: 'bug', url: 'https://x', vulnerable_versions: '*' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const path = join(tmp, 'stasis.code.br')
      // src imports foo directly AND via dep: the bare `foo` chain suppresses
      // `dep -> foo` by default; --why-deep keeps both.
      writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify({
        version: 1,
        config: { scope: 'full' },
        entries: ['src/entry.js'],
        sources: { '.': { name: 'top', version: '1.0.0', files: { 'src/entry.js': '// e\n' } } },
        modules: {
          'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': '// foo\n' } },
          'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': '// dep\n' } },
        },
        formats: {},
        imports: {
          '*': {
            'src/entry.js': { foo: 'node_modules/foo/index.js', dep: 'node_modules/dep/index.js' },
            'node_modules/dep/index.js': { foo: 'node_modules/foo/index.js' },
          },
        },
      }))))
      const pruned = await audit([path], { why: true })
      t.assert.equal(pruned.rows.find((r) => r.package === 'foo').reason, 'foo')

      const deep = await audit([path], { whyDeep: true })
      t.assert.equal(deep.why, true) // --why-deep implies --why
      t.assert.equal(deep.rows.find((r) => r.package === 'foo').reason, 'foo\ndep -> foo')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit() wraps non-2xx npm responses in a helpful error', withFetch(
  () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const lock = writeLock(tmp)
      await t.assert.rejects(() => audit([lock]), /advisories request failed: POST https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk 503: boom/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit() wraps network/abort errors with the cause preserved', withFetch(
  () => { throw new Error('connection refused') },
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const lock = writeLock(tmp)
      await t.assert.rejects(() => audit([lock]), /advisories request failed: connection refused/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('audit() lists only the installed versions a range covers, and drops ranges covering none', withFetch(
  () => new Response(JSON.stringify({
    foo: [
      { id: 1, severity: 'high', title: 'old', url: 'https://github.com/advisories/GHSA-2222-3333-4444', vulnerable_versions: '<1' },
      { id: 2, severity: 'low', title: 'current', url: 'https://github.com/advisories/GHSA-5555-6666-7777', vulnerable_versions: '>=1.2.0 <2' },
    ],
    bar: [{ id: 3, severity: 'moderate', title: 'any', url: 'https://x', vulnerable_versions: '*' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const report = await audit([writeLock(tmp)])
      t.assert.deepEqual(report.rows.map((r) => [r.package, r.installed, r.vulnerable, r.title, r.id]), [
        ['bar', '4.5.6', '*', 'any', 'npm:3'],
        ['foo', '1.2.3', '>=1.2.0 <2', 'current', 'GHSA-5555-6666-7777'],
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

// --- ecosystems beyond npm, and repos from bundled package.json files -------------------------

// A bundle mixing every bucket kind stasis tags: first-party code, a vendored crate (and one with
// only its manifest), Composer packages (a release and a dev branch), a GitHub-hosted Solidity
// library (lib/), a Soldeer package, and an npm package of the crate's name and version.
const writeMultiBundle = (dir, extra = {}) => writeBundle(dir, 'multi.br', {
  entries: ['src/main.rs'],
  sources: {
    '.': { name: 'app', version: '1.0.0', files: { 'src/main.rs': 'fn main() {}\n' } },
    'vendor/serde': { name: 'serde', version: '1.0.200', ecosystem: 'cargo', files: { 'src/lib.rs': '//\n', 'Cargo.toml': '' } },
    'vendor/manifest-only': { name: 'manifest-only', version: '1.0.0', ecosystem: 'cargo', files: { 'Cargo.toml': '' } },
    'vendor/guzzlehttp/guzzle': { name: 'guzzlehttp/guzzle', version: 'v7.8.1', ecosystem: 'composer', files: { 'src/Client.php': '<?php\n' } },
    'vendor/acme/wip': { name: 'acme/wip', version: 'dev-main', ecosystem: 'composer', files: { 'src/A.php': '<?php\n' } },
    'lib/forge-std': { name: 'foundry-rs/forge-std', version: '1.9.0', ecosystem: 'github', files: { 'src/Test.sol': '//\n', 'foundry.toml': '' } },
    'dependencies/solady-0.1.0': { name: 'solady', version: '0.1.0', ecosystem: 'soldeer', files: { 'src/A.sol': '//\n' } },
    'crates/internal': { name: 'internal', version: '0.1.0', files: { 'src/lib.rs': '//\n' } },
  },
  modules: {
    'node_modules/serde': { name: 'serde', version: '1.0.200', files: { 'index.js': '//\n' } },
  },
  formats: {},
  ...extra,
})

test('collectPackages audits vendored crates, Composer releases and GitHub-hosted libraries too', withTmp((t, tmp) => {
  // Left out: first-party buckets (untagged), a crate with no .rs recorded, a Composer dev
  // branch (no advisory lists one), and Soldeer (no advisory source).
  t.assert.deepEqual(collectPackages([writeMultiBundle(tmp)]), [
    { ecosystem: 'cargo', name: 'serde', version: '1.0.200' },
    { ecosystem: 'composer', name: 'guzzlehttp/guzzle', version: 'v7.8.1' },
    { ecosystem: 'github', name: 'foundry-rs/forge-std', version: '1.9.0' },
    { ecosystem: 'npm', name: 'serde', version: '1.0.200' },
  ])
}))

test('collectReasons keeps a crate and an npm package of one name and version apart', withTmp((t, tmp) => {
  const file = writeMultiBundle(tmp, { reason: { run: ['vendor/serde/src/lib.rs'], webpack: ['node_modules/serde/index.js'] } })
  const reasons = collectReasons([file])
  t.assert.deepEqual([...reasons.get('cargo:serde@1.0.200')], ['run'])
  t.assert.deepEqual([...reasons.get('serde@1.0.200')], ['webpack'])
}))

test('collectPackages takes an npm package\'s GitHub repo from its bundled package.json', withTmp((t, tmp) => {
  const bundle = writeBundle(tmp, 'b.br', {
    modules: {
      'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': '//\n', 'package.json': JSON.stringify({ name: 'foo', repository: { type: 'git', url: 'git+https://github.com/acme/foo.git' } }) } },
      'node_modules/nolink': { name: 'nolink', version: '1.0.0', files: { 'index.js': '//\n', 'package.json': JSON.stringify({ name: 'nolink' }) } },
      'node_modules/broken': { name: 'broken', version: '1.0.0', files: { 'index.js': '//\n', 'package.json': '{not json' } },
    },
    formats: {},
  })
  t.assert.deepEqual(collectPackages([bundle]), [
    { ecosystem: 'npm', name: 'broken', version: '1.0.0' },
    { ecosystem: 'npm', name: 'foo', version: '2.0.0', github: 'acme/foo' },
    { ecosystem: 'npm', name: 'nolink', version: '1.0.0' },
  ])
  // A lockfile records the manifest's hash, not its content: nothing to read a repo from.
  const lock = writeLock(tmp, 'l.json', { modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': 'sha512-y', 'package.json': 'sha512-z' } } } })
  t.assert.deepEqual(collectPackages([lock]), [{ ecosystem: 'npm', name: 'foo', version: '2.0.0' }])
  // Across files, the bundle's repo is kept for the package the lockfile also lists.
  t.assert.deepEqual(collectPackages([lock, bundle]).find((p) => p.name === 'foo'), { ecosystem: 'npm', name: 'foo', version: '2.0.0', github: 'acme/foo' })
}))

test('advisoryPackages asks each name once, with a repo only where its package.jsons agree', (t) => {
  t.assert.deepEqual(advisoryPackages([
    { ecosystem: 'npm', name: 'a', version: '1.0.0', github: 'acme/a' },
    { ecosystem: 'npm', name: 'a', version: '2.0.0', github: 'Acme/A' },
    { ecosystem: 'npm', name: 'a', version: '3.0.0' },
    { ecosystem: 'npm', name: 'b', version: '1.0.0', github: 'acme/b' },
    { ecosystem: 'npm', name: 'b', version: '2.0.0', github: 'acme/b-moved' },
    { ecosystem: 'cargo', name: 'a', version: '1.0.0' },
  ]), [
    // One repo in any case spelling; GitHub's names are case-insensitive.
    { ecosystem: 'npm', name: 'a', versions: ['1.0.0', '2.0.0', '3.0.0'], github: 'Acme/A' },
    // Two repos for one name: upstream would refuse it, so the lookup decides.
    { ecosystem: 'npm', name: 'b', versions: ['1.0.0', '2.0.0'] },
    { ecosystem: 'cargo', name: 'a', versions: ['1.0.0'] },
  ])
})

test('audit() asks each ecosystem\'s source and prefixes non-npm packages in the table', withFetch(
  ({ url, opts }) => {
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk') return json({})
    if (url === 'https://api.osv.dev/v1/querybatch') {
      const { queries } = JSON.parse(opts.body)
      return json({ results: queries.map((q) => (q.package.ecosystem === 'crates.io' ? { vulns: [{ id: 'RUSTSEC-2099-0001' }] } : {})) })
    }
    if (url === 'https://api.osv.dev/v1/vulns/RUSTSEC-2099-0001') {
      return json({ id: 'RUSTSEC-2099-0001', summary: 'serde bug', aliases: [], affected: [{ package: { ecosystem: 'crates.io', name: 'serde' } }] })
    }
    return new Response('unexpected', { status: 404 })
  },
  async (t, calls) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const asked = []
      const github = { listRepoAdvisories: async ({ repo }) => (asked.push(repo), []) }
      const report = await audit([writeMultiBundle(tmp)], { github })
      const osv = calls.filter((c) => c.url === 'https://api.osv.dev/v1/querybatch').flatMap((c) => JSON.parse(c.opts.body).queries)
      t.assert.deepEqual(osv.toSorted((a, b) => a.package.ecosystem.localeCompare(b.package.ecosystem)), [
        { package: { name: 'serde', ecosystem: 'crates.io' }, version: '1.0.200' },
        { package: { name: 'guzzlehttp/guzzle', ecosystem: 'Packagist' }, version: 'v7.8.1' },
      ])
      t.assert.deepEqual(asked, ['foundry-rs/forge-std'])
      t.assert.deepEqual(report.rows.map((r) => [r.package, r.installed, r.id, r.severity]), [['cargo:serde', '1.0.200', 'RUSTSEC-2099-0001', '']])
      // --why walks a crate's `use` edges the same way: first-party code imports it directly.
      const withEdge = writeMultiBundle(tmp, { imports: { '*': { 'src/main.rs': { serde: 'vendor/serde/src/lib.rs' } } } })
      const why = await audit([withEdge], { github, why: true })
      t.assert.deepEqual(why.rows.map((r) => [r.package, r.reason]), [['cargo:serde', 'serde']])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

