import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { collectPackages, collectPackagesFromFile, flattenAdvisories, formatTable } from '../src/audit.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')

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

test('collectPackages reads name/version from a lockfile', withTmp((t, tmp) => {
  const file = writeLock(tmp)
  const pkgs = collectPackagesFromFile(file)
  t.assert.deepEqual(
    pkgs.sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'bar', version: '4.5.6' },
      { name: 'foo', version: '1.2.3' },
      { name: 'top-pkg', version: '1.0.0' },
    ]
  )
}))

test('collectPackages reads name/version from a brotli bundle', withTmp((t, tmp) => {
  const file = writeBundle(tmp)
  const pkgs = collectPackagesFromFile(file)
  t.assert.deepEqual(
    pkgs.sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'baz', version: '0.0.1' },
      { name: 'foo', version: '2.0.0' },
      { name: 'top-pkg', version: '9.9.9' },
    ]
  )
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
    { name: 'top-pkg', version: '1.0.0' },
    { name: 'top-pkg', version: '9.9.9' },
  ])
}))

test('collectPackages dedupes exact name+version duplicates', withTmp((t, tmp) => {
  const a = writeLock(tmp, 'a.json')
  const b = writeLock(tmp, 'b.json')
  const pkgs = collectPackages([a, b])
  t.assert.equal(pkgs.length, 3)
}))

test('collectPackagesFromFile rejects unknown files', withTmp((t, tmp) => {
  const file = join(tmp, 'junk.json')
  writeFileSync(file, JSON.stringify({ hello: 'world' }))
  t.assert.throws(() => collectPackagesFromFile(file), /Unrecognised file/)
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
  t.assert.match(r.stderr, /Unrecognised file/)
}))
