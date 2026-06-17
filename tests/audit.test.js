import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { audit, collectPackages, collectPackagesFromFile, flattenAdvisories, formatTable, printAuditReport } from '../stasis/src/audit.js'

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
    ...extra,
  }
  writeFileSync(path, JSON.stringify(lock))
  return path
}

const writeBundle = (dir, name = 'snapshot.br') => {
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
      { name: 'bar', version: '4.5.6' },
      { name: 'foo', version: '1.2.3' },
    ]
  )
}))

test('collectPackages reads name/version from a brotli bundle (node_modules only)', withTmp((t, tmp) => {
  const file = writeBundle(tmp)
  const pkgs = collectPackagesFromFile(file)
  t.assert.deepEqual(
    pkgs.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'baz', version: '0.0.1' },
      { name: 'foo', version: '2.0.0' },
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
    { name: 'bar', version: '4.5.6' },
    { name: 'baz', version: '0.0.1' },
    { name: 'foo', version: '1.2.3' },
    { name: 'foo', version: '2.0.0' },
  ])
}))

test('collectPackages dedupes exact name+version duplicates', withTmp((t, tmp) => {
  const a = writeLock(tmp, 'a.json')
  const b = writeLock(tmp, 'b.json')
  const pkgs = collectPackages([a, b])
  t.assert.equal(pkgs.length, 2)
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
  t.assert.deepEqual(collectPackagesFromFile(file), [{ name: 'lib', version: '3.2.1' }])
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
  }))
  t.assert.deepEqual(collectPackages([file]), [
    { name: 'a', version: '1.0.0' },
    { name: 'b', version: '1.0.0' },
  ])
}))

test('flattenAdvisories sorts by severity then package', (t) => {
  const result = {
    foo: [
      { id: 1, severity: 'low', title: 't1', url: 'u1', vulnerable_versions: '<2' },
      { id: 2, severity: 'critical', title: 't2', url: 'u2', vulnerable_versions: '<2' },
    ],
    bar: [
      { id: 3, severity: 'critical', title: 'aaa', url: 'u3', vulnerable_versions: '<5' },
    ],
  }
  const rows = flattenAdvisories(result)
  t.assert.deepEqual(rows.map((r) => [r.severity, r.package, r.title]), [
    ['critical', 'bar', 'aaa'],
    ['critical', 'foo', 't2'],
    ['low', 'foo', 't1'],
  ])
})

test('flattenAdvisories joins installed versions matching vulnerable_versions', (t) => {
  const packages = [
    { name: 'foo', version: '1.0.0' },
    { name: 'foo', version: '3.0.0' },
    { name: 'bar', version: '2.0.0' },
  ]
  const result = {
    foo: [{ severity: 'high', title: 'x', url: 'u', vulnerable_versions: '<2' }],
    bar: [{ severity: 'low', title: 'y', url: 'u', vulnerable_versions: '*' }],
  }
  const rows = flattenAdvisories(result, packages)
  const foo = rows.find((r) => r.package === 'foo')
  const bar = rows.find((r) => r.package === 'bar')
  t.assert.equal(foo.installed, '1.0.0', 'only the affected installed version of foo is listed')
  t.assert.equal(bar.installed, '2.0.0')
})

test('printAuditReport hints when nothing was scanned', (t) => {
  const lines = []
  const err = { write: (s) => lines.push(s) }
  printAuditReport({ packages: [], rows: [] }, { out: { write: () => {} }, err })
  t.assert.equal(lines.join(''), 'Scanned 0 packages\nNo node_modules entries found in the input files\n')
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

test('audit() wraps non-2xx npm responses in a helpful error', withFetch(
  () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
  async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'stasis-audit-'))
    try {
      const lock = writeLock(tmp)
      await t.assert.rejects(() => audit([lock]), /npm advisories request failed: 503/)
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
      await t.assert.rejects(() => audit([lock]), /npm advisories request failed: connection refused/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
))

test('flattenAdvisories drops advisories that match no installed version', (t) => {
  const packages = [{ name: 'foo', version: '5.0.0' }]
  const result = {
    foo: [
      { severity: 'high', title: 'old', url: 'u', vulnerable_versions: '<2' },
      { severity: 'low', title: 'current', url: 'u', vulnerable_versions: '>=5' },
    ],
  }
  const rows = flattenAdvisories(result, packages)
  t.assert.equal(rows.length, 1)
  t.assert.equal(rows[0].title, 'current')
})
