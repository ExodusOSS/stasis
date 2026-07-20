import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '../stasis/src/diff.js'
import { diffCommand } from '../stasis/src/cmd/diff.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

// The `@exodus/stasis/diff` API operates on already-parsed artifacts, so build
// Lockfile/Bundle instances straight from JSON — no disk, no brotli — and tag
// each with the kind the CLI's loader would have reported.
const lockOf = (obj) => ({ artifact: Lockfile.parse(JSON.stringify(obj)), kind: 'lockfile' })
const codeOf = (obj) => ({ artifact: Bundle.parse(JSON.stringify(obj)), kind: 'bundle' })
// A resources bundle is now just a unified bundle whose files are all tagged as
// base64 resources. Synthesize the formats map so the fixtures stay terse.
const resourcesOf = ({ config = { scope: 'full' }, sources = {}, modules = {} }) => {
  const formats = {}
  for (const [dir, info] of [...Object.entries(sources), ...Object.entries(modules)]) {
    for (const rel of Object.keys(info.files)) formats[dir === '.' ? rel : `${dir}/${rel}`] = 'resource:base64'
  }
  const obj = { version: 1, config, modules, formats, imports: {} }
  if (config.scope === 'full') obj.sources = sources // node_modules scope must omit sources
  return { artifact: Bundle.parse(JSON.stringify(obj)), kind: 'bundle' }
}

// The diff API doesn't pull in crypto; the caller injects the hash. Tests that
// compare a bundle pass the canonical `sha512integrity` here.
const HASH = { hash: sha512integrity }

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
  }), HASH)
  t.assert.equal(norm.modules.get('.').files.get('src/index.js'), sha512integrity(src))
})

test('normalizeArtifact decodes base64 before hashing a resource bundle', (t) => {
  const raw = Buffer.from([0, 1, 2, 3, 255])
  const norm = normalizeArtifact(resourcesOf({
    version: 1,
    config: { scope: 'full' },
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'asset.bin': raw.toString('base64') } } },
    modules: {},
  }), HASH)
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

test('normalizeArtifact requires a hash function to compare a bundle, but not a lockfile', (t) => {
  // A lockfile already holds digests, so it normalizes without a hash...
  t.assert.ok(normalizeArtifact(lockOf(LOCK)))
  // ...but a bundle's bytes must be re-hashed, so omitting `hash` is a clear error.
  const bundle = codeOf({
    version: 1, config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'i.js': 'x' } } },
    formats: {}, imports: {},
  })
  t.assert.throws(() => normalizeArtifact(bundle), /hash/)
  t.assert.throws(() => diffArtifacts(lockOf(LOCK), bundle), /hash/)
})

test('the diff API does not load node:zlib or node:crypto', (t) => {
  // Mirrors the sbom zlib guard: importing `@exodus/stasis/diff` must stay light.
  // It pulls in neither brotli (brotliOptions lives in its own core module) nor
  // crypto (the caller injects the hash) — the two import surfaces we trimmed.
  const url = pathToFileURL(join(here, '..', 'stasis', 'src', 'diff.js')).href
  const probe = `await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(process.moduleLoadList.filter((m) => /zlib|crypto/u.test(m))))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.deepEqual(JSON.parse(r.stdout), [], 'the diff API must not load node:zlib or node:crypto')
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
  const { modules, files } = diffArtifacts(codeOf(v0), lockOf(lock), HASH)
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
  const diff = diffArtifacts(lock, bundle, HASH)
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

test('diffArtifacts sorts multi-file buckets by the project sortPaths rule', (t) => {
  // node_modules sorts last, files-in-dir before sub-dirs — assert the diff output
  // order matches the rest of the project rather than insertion/JSON order.
  const left = {
    version: 0, config: { scope: 'full' }, entries: ['src/i.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-x' } } },
    modules: {},
  }
  const right = {
    version: 0, config: { scope: 'full' }, entries: ['src/i.js'],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-x', 'src/z.js': 'sha512-z', 'README.md': 'sha512-r', 'src/lib/a.js': 'sha512-a' } } },
    modules: {},
  }
  const { files } = diffArtifacts(lockOf(left), lockOf(right))
  t.assert.deepEqual(files.added, ['README.md', 'src/z.js', 'src/lib/a.js'])
})

// ── diffArtifacts: imports (opt-in) ──────────────────────────────────────────

// Two scope=node_modules lockfiles whose only difference is the resolution graph.
const importsLock = (edges) => ({
  version: 0, config: { scope: 'node_modules' },
  modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': 'sha512-same' } } },
  imports: edges,
  formats: {}, // writers emit both facets together; parse rejects a one-sided shape
})

test('diffArtifacts only diffs imports when asked', (t) => {
  const a = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/a.js' } } })
  const b = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/b.js' } } })
  t.assert.equal(diffArtifacts(lockOf(a), lockOf(b)).imports, undefined)
  t.assert.ok(diffArtifacts(lockOf(a), lockOf(b), { imports: true }).imports)
})

test('diffArtifacts reports added, removed, and redirected import edges', (t) => {
  const left = importsLock({
    '*': {
      'node_modules/foo/index.js': {
        './keep.js': 'node_modules/foo/keep.js',
        './gone.js': 'node_modules/foo/gone.js',
        './moved.js': 'node_modules/foo/old.js',
      },
    },
  })
  const right = importsLock({
    '*': {
      'node_modules/foo/index.js': {
        './keep.js': 'node_modules/foo/keep.js',
        './fresh.js': 'node_modules/foo/fresh.js',
        './moved.js': 'node_modules/foo/new.js',
      },
    },
  })
  const { imports } = diffArtifacts(lockOf(left), lockOf(right), { imports: true })
  t.assert.deepEqual(imports.added, [{ parent: 'node_modules/foo/index.js', specifier: './fresh.js', to: ['node_modules/foo/fresh.js'] }])
  t.assert.deepEqual(imports.removed, [{ parent: 'node_modules/foo/index.js', specifier: './gone.js', from: ['node_modules/foo/gone.js'] }])
  t.assert.deepEqual(imports.changed, [{ parent: 'node_modules/foo/index.js', specifier: './moved.js', from: ['node_modules/foo/old.js'], to: ['node_modules/foo/new.js'] }])
  // a redirect is a real difference even when every file hash is unchanged
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(left), lockOf(right), { imports: true })), true)
})

test('diffImports reconciles wildcard "*" edges against precise condition sets (no false add/remove)', (t) => {
  // The fix for the keying wrinkle: a static bundle records edges under "*", a
  // runtime lockfile under precise conditions. The SAME resolution must compare
  // equal, not show as removed + added.
  const wildcard = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/a.js' } } })
  const precise = importsLock({ 'node, import': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/a.js' } } })
  const { imports } = diffArtifacts(lockOf(wildcard), lockOf(precise), { imports: true })
  t.assert.deepEqual(imports, { attested: { left: true, right: true }, added: [], removed: [], changed: [] })
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(wildcard), lockOf(precise), { imports: true })), false)

  // ...but a genuine redirect under differing conditions is still caught.
  const redirected = importsLock({ 'node, import': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/b.js' } } })
  const diff = diffArtifacts(lockOf(wildcard), lockOf(redirected), { imports: true })
  t.assert.deepEqual(diff.imports.changed, [{ parent: 'node_modules/foo/index.js', specifier: './a.js', from: ['node_modules/foo/a.js'], to: ['node_modules/foo/b.js'] }])
})

test('diffImports unions targets across conditions for a (parent, specifier)', (t) => {
  // A specifier resolving to different files under different conditions becomes a
  // set; identical sets (however keyed) are equal, a differing set is a change.
  const twoConds = importsLock({
    'node, import': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/node.js' } },
    browser: { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/browser.js' } },
  })
  const sameUnionOneKey = importsLock({
    'node, browser': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/node.js' } },
    'worker': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/browser.js' } },
  })
  t.assert.equal(diffArtifacts(lockOf(twoConds), lockOf(sameUnionOneKey), { imports: true }).imports.changed.length, 0)

  const narrower = importsLock({ '*': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/node.js' } } })
  const diff = diffArtifacts(lockOf(twoConds), lockOf(narrower), { imports: true })
  t.assert.deepEqual(diff.imports.changed, [{
    parent: 'node_modules/foo/index.js', specifier: './x.js',
    from: ['node_modules/foo/browser.js', 'node_modules/foo/node.js'], to: ['node_modules/foo/node.js'],
  }])
})

test('a resource-only bundle attests an empty import set (unified format always carries imports)', (t) => {
  // Collapse removed the separate resources-bundle shape: a unified bundle always
  // carries an `imports` map (empty for a resources-only bundle), so it attests an
  // empty resolution set rather than "not attesting" at all. Diffed against a
  // lockfile that records one edge, that edge surfaces as a single difference.
  const res = resourcesOf({
    config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'a.bin': Buffer.from('x').toString('base64') } } },
  })
  const withEdges = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/a.js' } } })
  const diff = diffArtifacts(res, lockOf(withEdges), { imports: true, hash: sha512integrity })
  t.assert.equal(diff.imports.attested.left, true)
  t.assert.equal(diff.imports.attested.right, true)
  t.assert.equal(diff.imports.added.length + diff.imports.removed.length + diff.imports.changed.length, 1)
})

test('diffArtifacts skips the import diff (without flipping hasDifferences) when a side does not attest imports', (t) => {
  // A legacy lockfile with no `imports` key parses to imports === null.
  const legacy = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': 'sha512-same' } } } }
  const withEdges = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/a.js' } } })
  const diff = diffArtifacts(lockOf(legacy), lockOf(withEdges), { imports: true })
  t.assert.deepEqual(diff.imports.attested, { left: false, right: true })
  t.assert.equal(diff.imports.added.length + diff.imports.removed.length + diff.imports.changed.length, 0)
  // nothing else differs, and an un-comparable import graph must not invent one
  t.assert.equal(hasDifferences(diff), false)
})

test('formatDiffStat renders the imports section and its skip note', (t) => {
  const a = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/old.js' } } })
  const b = importsLock({ '*': { 'node_modules/foo/index.js': { './a.js': 'node_modules/foo/new.js' } } })
  const out = formatDiffStat(diffArtifacts(lockOf(a), lockOf(b), { imports: true }), { left: 'a', right: 'b', leftKind: 'lockfile', rightKind: 'lockfile' })
  t.assert.match(out, /Imports: 0 added, 0 removed, 1 changed/)
  t.assert.match(out, /\* node_modules\/foo\/index\.js {2}'\.\/a\.js' {2}node_modules\/foo\/old\.js -> node_modules\/foo\/new\.js/)

  const legacy = { version: 0, config: { scope: 'node_modules' }, modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': 'sha512-same' } } } }
  const note = formatDiffStat(diffArtifacts(lockOf(legacy), lockOf(a), { imports: true }), { left: 'a', right: 'b' })
  t.assert.match(note, /Imports: a does not attest resolutions; skipping import diff/)
})

// ── hasDifferences ───────────────────────────────────────────────────────────

test('hasDifferences is false for identical artifacts and true once anything differs', (t) => {
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(LOCK), lockOf(LOCK))), false)
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO' } } } }
  t.assert.equal(hasDifferences(diffArtifacts(lockOf(LOCK), lockOf(bumped))), true)
})

// ── formatDiffStat ───────────────────────────────────────────────────────────

test('formatDiffStat renders module + file changes with the diff markers (* for changed, not ~)', (t) => {
  const bumped = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'sha512-FOO2' } } } }
  const out = formatDiffStat(diffArtifacts(lockOf(LOCK), lockOf(bumped)), { left: 'a.lock.json', right: 'b.lock.json', leftKind: 'lockfile', rightKind: 'lockfile' })
  t.assert.match(out, /stasis diff --stat/)
  t.assert.match(out, /- a\.lock\.json \(lockfile, scope=full\)/)
  t.assert.match(out, /\+ b\.lock\.json \(lockfile, scope=full\)/)
  t.assert.match(out, /\* node_modules\/foo {2}foo 1\.0\.0 -> 2\.0\.0/)
  t.assert.match(out, /\* node_modules\/foo\/index\.js/)
  // the changed marker must be `*`, never `~` (too close to `-` in a terminal)
  t.assert.doesNotMatch(out, /~/)
  t.assert.match(out, /Artifacts differ/)
  t.assert.ok(out.endsWith('\n'))
})

test('formatDiffStat reports no differences for identical artifacts', (t) => {
  const out = formatDiffStat(diffArtifacts(lockOf(LOCK), lockOf(LOCK)), { left: 'a', right: 'a' })
  t.assert.match(out, /Modules: 0 added, 0 removed, 0 changed/)
  t.assert.match(out, /Files \(within shared modules\): 0 added, 0 removed, 0 differing/)
  t.assert.match(out, /No differences/)
})

test('formatDiffStat omits the trailing space for a null-name (v0) added/removed module', (t) => {
  // A v0 code bundle's workspace bucket has a null name; the module line must not
  // carry a dangling double space where the name would be.
  const v0 = { version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { 'src/a.js': 'export const x = 1\n' } }
  const empty = { version: 0, config: { scope: 'full' }, entries: ['x'], sources: {}, modules: {} }
  const out = formatDiffStat(diffArtifacts(codeOf(v0), lockOf(empty), HASH))
  t.assert.match(out, /- \. \(1 file\)/)
  t.assert.doesNotMatch(out, /- \. {2}\(/)
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
  t.assert.match(r.stdout, /bundle/)
  t.assert.match(r.stdout, /No differences/)
}))

test('diff --stat reports a missing input file clearly', withTmp((t, tmp) => {
  const p = writeLock(tmp, LOCK, 'a.lock.json')
  const r = runCli(['diff', '--stat', p, join(tmp, 'nope.json')])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /File not found:/)
}))

test('diff --stat surfaces a clean error for an unparseable operand', withTmp((t, tmp) => {
  const good = writeLock(tmp, LOCK, 'a.lock.json')
  const junk = join(tmp, 'junk.json')
  writeFileSync(junk, JSON.stringify({ hello: 'world' }))
  const r = runCli(['diff', '--stat', good, junk])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Failed to parse stasis lockfile/)
}))

test('diff --stat reads two resource-carrying bundles off disk', withTmp((t, tmp) => {
  // Resources live in the unified bundle, tagged 'resource:base64'; the diff decodes
  // each base64 blob per its format and rehashes the decoded bytes.
  const asset = (s) => Buffer.from(s).toString('base64')
  const fmts = { 'node_modules/foo/a.bin': 'resource:base64', 'node_modules/foo/b.bin': 'resource:base64' }
  const a = writeBundle(tmp, {
    version: 1, config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'a.bin': asset('one'), 'b.bin': asset('shared') } } },
    formats: fmts, imports: {},
  }, 'a.code.br')
  const b = writeBundle(tmp, {
    version: 1, config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'a.bin': asset('two'), 'b.bin': asset('shared') } } },
    formats: fmts, imports: {},
  }, 'b.code.br')
  const r = runCli(['diff', '--stat', a, b])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stdout, /bundle/)
  // a.bin content changed, b.bin identical
  t.assert.match(r.stdout, /Files \(within shared modules\): 0 added, 0 removed, 1 differing/)
  t.assert.match(r.stdout, /\* node_modules\/foo\/a\.bin/)
}))

test('diff --stat --imports reports redirected edges and exits 1 on an import-only change', withTmp((t, tmp) => {
  // Identical file hashes; only a resolution target moves. Without --imports this
  // is "No differences"; with it, the redirect is caught.
  const base = {
    version: 0, config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': 'sha512-same' } } },
  }
  const a = writeLock(tmp, { ...base, formats: {}, imports: { '*': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/old.js' } } } }, 'a.lock.json')
  const b = writeLock(tmp, { ...base, formats: {}, imports: { '*': { 'node_modules/foo/index.js': { './x.js': 'node_modules/foo/new.js' } } } }, 'b.lock.json')

  const without = runCli(['diff', '--stat', a, b])
  t.assert.equal(without.status, 0)
  t.assert.match(without.stdout, /No differences/)
  t.assert.doesNotMatch(without.stdout, /Imports:/)

  const withImports = runCli(['diff', '--stat', '--imports', a, b])
  t.assert.equal(withImports.status, 1)
  t.assert.match(withImports.stdout, /Imports: 0 added, 0 removed, 1 changed/)
  t.assert.match(withImports.stdout, /old\.js -> node_modules\/foo\/new\.js/)
}))
