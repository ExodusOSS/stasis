import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state.util'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '../stasis/src/diff.js'
import { diffCommand } from '../stasis/src/cmd/diff.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

// The `@exodus/stasis/diff` API operates on already-parsed artifacts, so build
// Lockfile/Bundle instances straight from JSON — no disk, no brotli — and tag
// each with the kind the CLI's loader would have reported.
const lockOf = (obj) => ({ artifact: Lockfile.parse(JSON.stringify(obj)), kind: 'lockfile' })
const codeOf = (obj) => ({ artifact: Bundle.parseCode(JSON.stringify(obj)), kind: 'code' })
const resourcesOf = (obj) => ({ artifact: Bundle.parseResources(JSON.stringify(obj)), kind: 'resources' })

// A scope=full lockfile: one workspace root + one node_modules dep.
const LOCK = {
  version: 0,
  config: { scope: 'full' },
  entries: ['src/index.js'],
  sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-AAA', 'src/util.js': 'sha512-UTIL' } } },
  modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO' } } },
}

// ── normalizeArtifact ────────────────────────────────────────────────────────

test('normalizeArtifact rehashes a code bundle into the SRI digests a lockfile records', (t) => {
  const src = 'export const x = 1\n'
  const norm = normalizeArtifact(codeOf({
    version: 1,
    config: { scope: 'full' },
    entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': src } } },
    modules: {},
    formats: { 'src/index.js': 'module' },
    imports: {},
  }))
  t.assert.equal(norm.modules.get('.').files.get('src/index.js'), sha512integrity(src))
})

test('normalizeArtifact decodes base64 before hashing a resource bundle', (t) => {
  const raw = Buffer.from([0, 1, 2, 3, 255])
  const norm = normalizeArtifact(resourcesOf({
    version: 1,
    config: { scope: 'full' },
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'asset.bin': raw.toString('base64') } } },
    modules: {},
  }))
  // Matches sha512 of the raw bytes — what `stasis run` records in the lockfile —
  // not a hash of the base64 text.
  t.assert.equal(norm.modules.get('.').files.get('asset.bin'), sha512integrity(raw))
})

test('normalizeArtifact passes a lockfile digest through unchanged', (t) => {
  const norm = normalizeArtifact(lockOf(LOCK))
  t.assert.equal(norm.modules.get('node_modules/foo').files.get('index.js'), 'sha512-FOO')
  t.assert.equal(norm.scope, 'full')
})

test('normalizeArtifact rejects a missing artifact or an unknown kind', (t) => {
  t.assert.throws(() => normalizeArtifact(undefined), /kind/)
  t.assert.throws(() => normalizeArtifact({ artifact: Lockfile.parse(JSON.stringify(LOCK)), kind: 'nope' }), /kind/)
  t.assert.throws(() => normalizeArtifact({ kind: 'lockfile' }), /kind/)
})

// ── diffArtifacts: module level ──────────────────────────────────────────────

test('diffArtifacts reports added, removed, and version-changed modules', (t) => {
  const right = {
    ...LOCK,
    modules: {
      'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO2' } },
      'node_modules/added': { name: 'added', version: '3.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-ADD', 'lib.js': 'sha512-LIB' } },
    },
  }
  // also drop a workspace dep by removing nothing there; add a removed dep on the left
  const left = {
    ...LOCK,
    modules: {
      ...LOCK.modules,
      'node_modules/gone': { name: 'gone', version: '0.1.0', ecosystem: 'npm', files: { 'index.js': 'sha512-GONE' } },
    },
  }
  const { modules } = diffArtifacts(lockOf(left), lockOf(right))

  t.assert.deepEqual(modules.added.map((m) => m.dir), ['node_modules/added'])
  t.assert.equal(modules.added[0].files, 2)
  t.assert.deepEqual(modules.removed.map((m) => m.dir), ['node_modules/gone'])
  t.assert.equal(modules.removed[0].files, 1)
  t.assert.deepEqual(modules.changed, [{ dir: 'node_modules/foo', name: 'foo', versionChange: { from: '1.0.0', to: '2.0.0' } }])
})

test('diffArtifacts reports a module name change at the same dir', (t) => {
  const left = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/x': { name: 'old', version: '1.0.0', files: { 'i.js': 'sha512-a' } } } }
  const right = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/x': { name: 'new', version: '1.0.0', files: { 'i.js': 'sha512-a' } } } }
  const { modules } = diffArtifacts(lockOf(left), lockOf(right))
  t.assert.deepEqual(modules.changed, [{ dir: 'node_modules/x', name: 'new', nameChange: { from: 'old', to: 'new' } }])
})

test('diffArtifacts does not report a version change when one side lacks a version (v0 bundle)', (t) => {
  // A v0 bundle records no name/version; comparing it against a lockfile must not
  // invent a version change just because one side is null.
  const v0 = { version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { 'node_modules/foo/index.js': 'export const x = 1\n' } }
  const lock = {
    version: 0, config: { scope: 'full' }, entries: ['src/i.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-a' } } },
    modules: { 'node_modules/foo': { name: 'foo', version: '9.9.9', files: { 'index.js': sha512integrity('export const x = 1\n') } } },
  }
  const { modules, files } = diffArtifacts(codeOf(v0), lockOf(lock))
  t.assert.equal(modules.changed.length, 0)
  // foo/index.js content matches across the v0 bundle and the lockfile
  t.assert.equal(files.differing.length, 0)
})

// ── diffArtifacts: file level ────────────────────────────────────────────────

test('diffArtifacts reports added, removed, and differing files within shared modules', (t) => {
  const left = {
    version: 0, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-SAME', 'src/old.js': 'sha512-OLD', 'src/changed.js': 'sha512-V1' } } },
    modules: {},
  }
  const right = {
    version: 0, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-SAME', 'src/new.js': 'sha512-NEW', 'src/changed.js': 'sha512-V2' } } },
    modules: {},
  }
  const { files } = diffArtifacts(lockOf(left), lockOf(right))
  t.assert.deepEqual(files.added, ['src/new.js'])
  t.assert.deepEqual(files.removed, ['src/old.js'])
  t.assert.deepEqual(files.differing, ['src/changed.js'])
})

test('diffArtifacts does not re-list files of an added/removed module at the file level', (t) => {
  const left = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/keep': { name: 'keep', version: '1.0.0', files: { 'i.js': 'sha512-k' } } } }
  const right = {
    version: 0, config: { scope: 'node_modules' },
    modules: {
      'node_modules/keep': { name: 'keep', version: '1.0.0', files: { 'i.js': 'sha512-k' } },
      'node_modules/fresh': { name: 'fresh', version: '1.0.0', files: { 'a.js': 'sha512-a', 'b.js': 'sha512-b' } },
    },
  }
  const diff = diffArtifacts(lockOf(left), lockOf(right))
  t.assert.deepEqual(diff.modules.added.map((m) => m.dir), ['node_modules/fresh'])
  // The two files of the freshly-added module are summarized by the module entry,
  // not re-counted as added files.
  t.assert.deepEqual(diff.files.added, [])
})

test('diffArtifacts compares a lockfile against a code bundle by rehashing the bundle bytes', (t) => {
  const same = 'export const x = 1\n'
  const changed = 'export const x = 2\n'
  const bundle = codeOf({
    version: 1, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': same } } },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': same } } },
    formats: {}, imports: {},
  })
  const lock = lockOf({
    version: 0, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': sha512integrity(same) } } },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': sha512integrity(changed) } } },
  })
  const diff = diffArtifacts(lock, bundle)
  // src/index.js content is byte-identical → no diff; foo/index.js bytes differ → flagged.
  t.assert.deepEqual(diff.files.differing, ['node_modules/foo/index.js'])
  t.assert.equal(diff.files.added.length + diff.files.removed.length, 0)
})

test('diffArtifacts notes scope differences in the result', (t) => {
  const full = { version: 0, config: { scope: 'full' }, entries: ['src/i.js'], sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-a' } } }, modules: {} }
  const nm = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'i.js': 'sha512-b' } } } }
  const diff = diffArtifacts(lockOf(full), lockOf(nm))
  t.assert.deepEqual(diff.scope, { left: 'full', right: 'node_modules' })
  // workspace "." is only in the full-scope side → removed module
  t.assert.ok(diff.modules.removed.some((m) => m.dir === '.'))
})

// ── hasDifferences ───────────────────────────────────────────────────────────

test('hasDifferences is false for identical artifacts and true once anything differs', (t) => {
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(LOCK), lockOf(LOCK))), false)
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO' } } } }
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(LOCK), lockOf(bumped))), true)
})

// ── formatDiffStat ───────────────────────────────────────────────────────────

test('formatDiffStat renders module + file changes with the diff markers', (t) => {
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO2' } } } }
  const out = formatDiffStat(diffArtifacts(lockOf(LOCK), lockOf(bumped)), { left: 'a.lock.json', right: 'b.lock.json', leftKind: 'lockfile', rightKind: 'lockfile' })
  t.assert.match(out, /stasis diff --stat/)
  t.assert.match(out, /- a\.lock\.json \(lockfile, scope=full\)/)
  t.assert.match(out, /\+ b\.lock\.json \(lockfile, scope=full\)/)
  t.assert.match(out, /~ node_modules\/foo {2}foo 1\.0\.0 -> 2\.0\.0/)
  t.assert.match(out, /~ node_modules\/foo\/index\.js/)
  t.assert.match(out, /Artifacts differ/)
  t.assert.ok(out.endsWith('\n'))
})

test('formatDiffStat reports no differences for identical artifacts', (t) => {
  const out = formatDiffStat(diffArtifacts(lockOf(LOCK), lockOf(LOCK)), { left: 'a', right: 'a' })
  t.assert.match(out, /Modules: 0 added, 0 removed, 0 changed/)
  t.assert.match(out, /Files: 0 added, 0 removed, 0 differing/)
  t.assert.match(out, /No differences/)
})

test('formatDiffStat surfaces a scope-mismatch note', (t) => {
  const full = { version: 0, config: { scope: 'full' }, entries: ['src/i.js'], sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-a' } } }, modules: {} }
  const nm = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'i.js': 'sha512-b' } } } }
  const out = formatDiffStat(diffArtifacts(lockOf(full), lockOf(nm)), { left: 'l', right: 'r', leftKind: 'lockfile', rightKind: 'lockfile' })
  t.assert.match(out, /scopes differ/)
})

// ── diffCommand (CLI glue, reads files) ──────────────────────────────────────

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-diff-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeLock = (dir, obj, name) => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(obj))
  return p
}
const writeBundle = (dir, obj, name) => {
  const p = join(dir, name)
  writeFileSync(p, brotliCompressSync(Buffer.from(JSON.stringify(obj))))
  return p
}

test('diffCommand reads two files, returns the diff and a differences flag', withTmp((t, tmp) => {
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO2' } } } }
  const sink = { writes: [], write(s) { this.writes.push(s) } }
  const { diff, differences } = diffCommand({
    left: writeLock(tmp, LOCK, 'a.lock.json'),
    right: writeLock(tmp, bumped, 'b.lock.json'),
    stat: true,
    out: sink,
  })
  t.assert.equal(differences, true)
  t.assert.equal(diff.modules.changed.length, 1)
  t.assert.match(sink.writes.join(''), /node_modules\/foo {2}foo 1\.0\.0 -> 2\.0\.0/)
}))

test('diffCommand compares a lockfile against a brotli code bundle on disk', withTmp((t, tmp) => {
  const src = 'export const x = 1\n'
  const lock = writeLock(tmp, {
    version: 0, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': sha512integrity(src) } } },
    modules: {},
  }, 'stasis.lock.json')
  const bundle = writeBundle(tmp, {
    version: 1, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': src } } },
    modules: {}, formats: { 'src/index.js': 'module' }, imports: {},
  }, 'stasis.code.br')
  const sink = { write() {} }
  const { differences } = diffCommand({ left: lock, right: bundle, stat: true, out: sink })
  t.assert.equal(differences, false, 'a lockfile and a matching code bundle have no differences')
}))

test('diffCommand requires --stat and two files', withTmp((t, tmp) => {
  const p = writeLock(tmp, LOCK, 'a.lock.json')
  t.assert.throws(() => diffCommand({ left: p, right: p, stat: false }), /--stat/)
  t.assert.throws(() => diffCommand({ left: p, stat: true }), /two files/)
}))

// ── CLI integration ──────────────────────────────────────────────────────────

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

test('diff without --stat prints usage and exits 1', withTmp((t, tmp) => {
  const p = writeLock(tmp, LOCK, 'a.lock.json')
  const r = runCli(['diff', p, p])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /requires --stat/)
}))

test('diff --stat with a wrong number of files prints usage', withTmp((t, tmp) => {
  const p = writeLock(tmp, LOCK, 'a.lock.json')
  const r = runCli(['diff', '--stat', p])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /exactly two files/)
}))

test('diff --stat of two differing lockfiles streams a report and exits 1', withTmp((t, tmp) => {
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO2' } } } }
  const a = writeLock(tmp, LOCK, 'a.lock.json')
  const b = writeLock(tmp, bumped, 'b.lock.json')
  const r = runCli(['diff', '--stat', a, b])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stdout, /Modules: 0 added, 0 removed, 1 changed/)
  t.assert.match(r.stdout, /foo 1\.0\.0 -> 2\.0\.0/)
  t.assert.match(r.stdout, /Artifacts differ/)
}))

test('diff --stat of identical artifacts exits 0 with no differences', withTmp((t, tmp) => {
  const a = writeLock(tmp, LOCK, 'a.lock.json')
  const r = runCli(['diff', '--stat', a, a])
  t.assert.equal(r.status, 0)
  t.assert.match(r.stdout, /No differences/)
}))

test('diff --stat reads a brotli bundle as either operand', withTmp((t, tmp) => {
  const src = 'export const x = 1\n'
  const lock = writeLock(tmp, {
    version: 0, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': sha512integrity(src) } } },
    modules: {},
  }, 'stasis.lock.json')
  const bundle = writeBundle(tmp, {
    version: 1, config: { scope: 'full' }, entries: ['src/index.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': src } } },
    modules: {}, formats: { 'src/index.js': 'module' }, imports: {},
  }, 'stasis.code.br')
  const r = runCli(['diff', '--stat', lock, bundle])
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.match(r.stdout, /code bundle/)
  t.assert.match(r.stdout, /No differences/)
}))

test('diff --stat reports a missing input file clearly', withTmp((t, tmp) => {
  const p = writeLock(tmp, LOCK, 'a.lock.json')
  const r = runCli(['diff', '--stat', p, join(tmp, 'nope.json')])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /File not found:/)
}))
