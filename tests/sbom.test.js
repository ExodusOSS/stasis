import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { buildPurl, collectComponents, generateSbom, sbom, toCyclonedx, toSpdx } from '../stasis/src/sbom.js'
import { sbomCommand } from '../stasis/src/cmd/sbom.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

// The `@exodus/stasis/sbom` API operates on already-parsed artifacts, so build
// Lockfile/Bundle instances straight from JSON — no disk, no brotli.
const lockOf = (obj) => Lockfile.parse(JSON.stringify(obj))
const codeOf = (obj) => Bundle.parse(JSON.stringify(obj))

// A scope=full lockfile object: one workspace root + two node_modules deps (one
// scoped). Legacy shape — no per-dependency `ecosystem` field.
const LOCK = {
  version: 0,
  config: { scope: 'full' },
  entries: ['src/entry.js'],
  sources: { '.': { name: 'top-pkg', version: '1.0.0', files: { 'src/entry.js': 'sha512-x' } } },
  modules: {
    'node_modules/foo': { name: 'foo', version: '1.2.3', files: { 'index.js': 'sha512-y' } },
    'node_modules/@scope/bar': { name: '@scope/bar', version: '4.5.6', files: { 'index.js': 'sha512-z' } },
  },
}

// Deterministic generation options so structural assertions can also pin the
// timestamp/namespace shape without depending on the wall clock.
const fixed = { now: new Date('2026-01-02T03:04:05.678Z'), uuid: '00000000-0000-4000-8000-000000000000' }

// ── buildPurl ──────────────────────────────────────────────────────────────

test('buildPurl encodes npm packages, scoped and unscoped', (t) => {
  t.assert.equal(buildPurl('npm', 'lodash', '4.17.21'), 'pkg:npm/lodash@4.17.21')
  t.assert.equal(buildPurl('npm', '@exodus/bytes', '1.15.0'), 'pkg:npm/%40exodus/bytes@1.15.0')
})

test('buildPurl percent-encodes the version (build metadata)', (t) => {
  t.assert.equal(buildPurl('npm', 'foo', '1.0.0+build.1'), 'pkg:npm/foo@1.0.0%2Bbuild.1')
  // pre-release punctuation stays readable (hyphen/dot are unreserved)
  t.assert.equal(buildPurl('npm', 'foo', '1.0.0-alpha.3'), 'pkg:npm/foo@1.0.0-alpha.3')
})

test('buildPurl lowercases composer vendor/name per the purl spec', (t) => {
  t.assert.equal(buildPurl('composer', 'Monolog/Monolog', '3.5.0'), 'pkg:composer/monolog/monolog@3.5.0')
})

test('buildPurl mints cargo (flat) and github (owner/repo) purls', (t) => {
  t.assert.equal(buildPurl('cargo', 'serde', '1.0.0'), 'pkg:cargo/serde@1.0.0')
  t.assert.equal(buildPurl('github', 'vectorized/solady', '0.1.0'), 'pkg:github/vectorized/solady@0.1.0')
  // github is case-insensitive, so the purl spec requires lowercasing owner/repo
  // (forge submodule slugs like this come through verbatim from .gitmodules)
  t.assert.equal(buildPurl('github', 'OpenZeppelin/openzeppelin-contracts', '5.0.0'), 'pkg:github/openzeppelin/openzeppelin-contracts@5.0.0')
})

test('buildPurl returns null for ecosystems without a registered purl type', (t) => {
  t.assert.equal(buildPurl('soldeer', 'solmate', '6.8.0'), null)
  t.assert.equal(buildPurl('unknown', 'x', '1.0.0'), null)
})

// ── collectComponents ────────────────────────────────────────────────────────

test('collectComponents includes workspace and dependency packages (unlike audit)', (t) => {
  t.assert.deepEqual(collectComponents([lockOf(LOCK)]), [
    { name: '@scope/bar', version: '4.5.6', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/%40scope/bar@4.5.6' },
    { name: 'foo', version: '1.2.3', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/foo@1.2.3' },
    { name: 'top-pkg', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/top-pkg@1.0.0' },
  ])
})

test('collectComponents uses the per-dependency ecosystem field for purls and scope', (t) => {
  // A modern artifact tags each dependency bucket with its ecosystem; vendor/
  // soldeer/github/cargo deps live outside node_modules but are still deps.
  const tagged = {
    version: 0,
    config: { scope: 'full' },
    entries: ['src/i.js'],
    sources: {
      '.': { name: 'app', version: '1.0.0', files: { 'src/i.js': 'sha512-a' } },
      'vendor/acme/lib': { name: 'acme/lib', version: '1.4.2', ecosystem: 'composer', files: { 'C.php': 'sha512-b' } },
      'dependencies/solmate-6.8.0': { name: 'solmate', version: '6.8.0', ecosystem: 'soldeer', files: { 'T.sol': 'sha512-c' } },
      'lib/solady': { name: 'vectorized/solady', version: '0.1.0', ecosystem: 'github', files: { 'S.sol': 'sha512-d' } },
      'vendor/cool-lib': { name: 'cool-lib', version: '0.2.0', ecosystem: 'cargo', files: { 'lib.rs': 'sha512-e' } },
    },
    modules: {
      'node_modules/npmdep': { name: 'npmdep', version: '2.0.0', ecosystem: 'npm', files: { 'i.js': 'sha512-f' } },
    },
  }
  const byName = Object.fromEntries(collectComponents([lockOf(tagged)]).map((c) => [c.name, c]))
  // workspace root: untagged, ecosystem inferred (npm), still a purl
  t.assert.deepEqual(byName.app, { name: 'app', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app@1.0.0' })
  t.assert.equal(byName['acme/lib'].purl, 'pkg:composer/acme/lib@1.4.2')
  t.assert.equal(byName['acme/lib'].scope, 'dependency')
  t.assert.equal(byName['vectorized/solady'].purl, 'pkg:github/vectorized/solady@0.1.0')
  t.assert.equal(byName['cool-lib'].purl, 'pkg:cargo/cool-lib@0.2.0')
  t.assert.equal(byName.npmdep.purl, 'pkg:npm/npmdep@2.0.0')
  // soldeer has no purl type → no purl, but still classified as a dependency
  t.assert.equal(byName.solmate.purl, null)
  t.assert.equal(byName.solmate.scope, 'dependency')
})

test('collectComponents skips buckets without name+version (legacy v0 bundle)', (t) => {
  const v0 = { version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { 'node_modules/foo/index.js': 'x' } }
  t.assert.deepEqual(collectComponents([codeOf(v0)]), [])
})

test('collectComponents dedupes by ecosystem+name+version across artifacts', (t) => {
  t.assert.equal(collectComponents([lockOf(LOCK), lockOf(LOCK)]).length, 3)
})

test('collectComponents keeps the same name at different versions', (t) => {
  const other = { ...LOCK, modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': 'sha512-y' } } } }
  const foos = collectComponents([lockOf(LOCK), lockOf(other)]).filter((c) => c.name === 'foo')
  t.assert.deepEqual(foos.map((c) => c.version), ['1.2.3', '2.0.0'])
})

test('collectComponents classifies a package as workspace if any input is first-party (order-independent)', (t) => {
  // shared@1.0.0 is the workspace root in one artifact and a vendored dependency
  // in the other; the resulting scope must not depend on argument order.
  const ws = lockOf({
    version: 0, config: { scope: 'full' }, entries: ['i.js'],
    sources: { '.': { name: 'shared', version: '1.0.0', files: { 'i.js': 'sha512-a' } } },
    modules: {},
  })
  const dep = lockOf({
    version: 0, config: { scope: 'full' }, entries: ['i.js'],
    sources: { '.': { name: 'other', version: '9.9.9', files: { 'i.js': 'sha512-b' } } },
    modules: { 'node_modules/shared': { name: 'shared', version: '1.0.0', files: { 'index.js': 'sha512-c' } } },
  })
  const scopeOf = (artifacts) => collectComponents(artifacts).find((c) => c.name === 'shared').scope
  t.assert.equal(scopeOf([ws, dep]), 'workspace')
  t.assert.equal(scopeOf([dep, ws]), 'workspace', 'argument order must not change the classification')
})

test('collectComponents treats a legacy PHP bundle (php format, no ecosystem field) as composer', (t) => {
  const php = codeOf({
    version: 1,
    config: { scope: 'full' },
    entries: ['index.php'],
    sources: {
      '.': { name: 'acme/app', version: '1.0.0', files: { 'index.php': '<?php' } },
      'vendor/monolog/monolog': { name: 'monolog/monolog', version: '3.5.0', files: { 'src/Logger.php': '<?php' } },
    },
    modules: {},
    formats: { 'index.php': 'php', 'vendor/monolog/monolog/src/Logger.php': 'php' },
    imports: {},
  })
  t.assert.deepEqual(collectComponents([php]), [
    { name: 'acme/app', version: '1.0.0', scope: 'workspace', ecosystem: 'composer', purl: 'pkg:composer/acme/app@1.0.0' },
    { name: 'monolog/monolog', version: '3.5.0', scope: 'dependency', ecosystem: 'composer', purl: 'pkg:composer/monolog/monolog@3.5.0' },
  ])
})

// ── toSpdx ───────────────────────────────────────────────────────────────────

test('toSpdx DESCRIBES the single workspace root and the root DEPENDS_ON each dependency', (t) => {
  const doc = toSpdx(collectComponents([lockOf(LOCK)]), fixed)
  t.assert.equal(doc.spdxVersion, 'SPDX-2.3')
  t.assert.equal(doc.dataLicense, 'CC0-1.0')
  t.assert.equal(doc.SPDXID, 'SPDXRef-DOCUMENT')
  t.assert.equal(doc.name, 'top-pkg@1.0.0')
  t.assert.equal(doc.creationInfo.created, '2026-01-02T03:04:05Z')
  t.assert.deepEqual(doc.creationInfo.creators, [
    'Tool: @exodus/stasis-1.0.0-alpha.3',
    'Organization: Exodus Movement, Inc.',
  ])
  t.assert.ok(doc.documentNamespace.includes('00000000-0000-4000-8000-000000000000'))

  const root = doc.packages.find((p) => p.name === 'top-pkg')
  t.assert.equal(root.primaryPackagePurpose, 'APPLICATION')
  t.assert.equal(root.externalRefs[0].referenceLocator, 'pkg:npm/top-pkg@1.0.0')
  t.assert.equal(root.downloadLocation, 'NOASSERTION')
  t.assert.equal(root.filesAnalyzed, false)

  const describes = doc.relationships.filter((r) => r.relationshipType === 'DESCRIBES')
  t.assert.equal(describes.length, 1)
  t.assert.equal(describes[0].spdxElementId, 'SPDXRef-DOCUMENT')
  t.assert.equal(describes[0].relatedSpdxElement, root.SPDXID)

  const dependsOn = doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON')
  t.assert.equal(dependsOn.length, 2)
  t.assert.ok(dependsOn.every((r) => r.spdxElementId === root.SPDXID))
})

test('toSpdx with no single root (node_modules-only) DESCRIBES every package, no DEPENDS_ON', (t) => {
  const components = collectComponents([codeOf({
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': 'x' } },
      'node_modules/bar': { name: 'bar', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'y' } },
    },
    formats: {},
    imports: {},
  })])
  const doc = toSpdx(components, fixed)
  t.assert.equal(doc.name, 'stasis-sbom')
  t.assert.equal(doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON').length, 0)
  const describes = doc.relationships.filter((r) => r.relationshipType === 'DESCRIBES')
  t.assert.equal(describes.length, 2)
  t.assert.ok(describes.every((r) => r.spdxElementId === 'SPDXRef-DOCUMENT'))
})

test('toSpdx omits externalRefs when there is no purl', (t) => {
  const doc = toSpdx([{ name: 'solmate', version: '6.8.0', scope: 'dependency', ecosystem: 'soldeer', purl: null }], fixed)
  t.assert.equal(doc.packages[0].externalRefs, undefined)
})

test('toSpdx with several workspace roots DESCRIBES each root and emits no DEPENDS_ON', (t) => {
  const doc = toSpdx([
    { name: 'app-a', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app-a@1.0.0' },
    { name: 'app-b', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app-b@1.0.0' },
    { name: 'dep', version: '2.0.0', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/dep@2.0.0' },
  ], fixed)
  t.assert.equal(doc.name, 'stasis-sbom')
  const describes = doc.relationships.filter((r) => r.relationshipType === 'DESCRIBES')
  t.assert.deepEqual(describes.map((r) => r.relatedSpdxElement).toSorted(), ['SPDXRef-Package-0', 'SPDXRef-Package-1'])
  t.assert.ok(describes.every((r) => r.spdxElementId === 'SPDXRef-DOCUMENT'))
  t.assert.equal(doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON').length, 0)
})

// ── toCyclonedx ──────────────────────────────────────────────────────────────

test('toCyclonedx sets the root as metadata.component and lists deps with a flat dependency graph', (t) => {
  const doc = toCyclonedx(collectComponents([lockOf(LOCK)]), fixed)
  t.assert.equal(doc.bomFormat, 'CycloneDX')
  t.assert.equal(doc.specVersion, '1.5')
  t.assert.equal(doc.serialNumber, 'urn:uuid:00000000-0000-4000-8000-000000000000')
  t.assert.equal(doc.version, 1)
  t.assert.equal(doc.metadata.timestamp, '2026-01-02T03:04:05Z')
  t.assert.deepEqual(doc.metadata.tools, {
    components: [{ type: 'application', publisher: 'Exodus Movement, Inc.', name: '@exodus/stasis', version: '1.0.0-alpha.3' }],
  })

  t.assert.equal(doc.metadata.component.type, 'application')
  t.assert.equal(doc.metadata.component.name, 'top-pkg')
  t.assert.equal(doc.metadata.component.purl, 'pkg:npm/top-pkg@1.0.0')

  const scoped = doc.components.find((c) => c.purl === 'pkg:npm/%40scope/bar@4.5.6')
  t.assert.equal(scoped.group, '@scope')
  t.assert.equal(scoped.name, 'bar')
  t.assert.equal(scoped.type, 'library')

  t.assert.equal(doc.dependencies.length, 1)
  t.assert.equal(doc.dependencies[0].ref, 'pkg:npm/top-pkg@1.0.0')
  t.assert.deepEqual(doc.dependencies[0].dependsOn.toSorted(), [
    'pkg:npm/%40scope/bar@4.5.6',
    'pkg:npm/foo@1.2.3',
  ])
})

test('toCyclonedx without a single root omits metadata.component and dependencies', (t) => {
  const doc = toCyclonedx([
    { name: 'foo', version: '1.0.0', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/foo@1.0.0' },
  ], fixed)
  t.assert.equal(doc.metadata.component, undefined)
  t.assert.equal(doc.dependencies, undefined)
  t.assert.equal(doc.components.length, 1)
})

test('toCyclonedx with several workspace roots lists them all as components, no primary', (t) => {
  const doc = toCyclonedx([
    { name: 'app-a', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app-a@1.0.0' },
    { name: 'app-b', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app-b@1.0.0' },
  ], fixed)
  t.assert.equal(doc.metadata.component, undefined)
  t.assert.equal(doc.dependencies, undefined)
  t.assert.deepEqual(doc.components.map((c) => c.name).toSorted(), ['app-a', 'app-b'])
})

test('toCyclonedx bom-ref falls back to ecosystem:name@version when a dep has no purl', (t) => {
  const doc = toCyclonedx([
    { name: 'app', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/app@1.0.0' },
    { name: 'solmate', version: '6.8.0', scope: 'dependency', ecosystem: 'soldeer', purl: null },
  ], fixed)
  const dep = doc.components[0]
  t.assert.equal(dep['bom-ref'], 'soldeer:solmate@6.8.0')
  t.assert.equal(dep.purl, undefined)
  t.assert.deepEqual(doc.dependencies[0].dependsOn, ['soldeer:solmate@6.8.0'])
})

// ── generateSbom / sbom ──────────────────────────────────────────────────────

test('generateSbom dispatches on format and rejects unknown ones', (t) => {
  t.assert.equal(generateSbom('spdx', []).spdxVersion, 'SPDX-2.3')
  t.assert.equal(generateSbom('cyclonedx', []).bomFormat, 'CycloneDX')
  t.assert.throws(() => generateSbom('syft', []), /must be spdx or cyclonedx/)
})

test('sbom() composes collectComponents + generateSbom over artifacts', (t) => {
  const doc = sbom('cyclonedx', [lockOf(LOCK)], fixed)
  t.assert.equal(doc.bomFormat, 'CycloneDX')
  t.assert.equal(doc.metadata.component.name, 'top-pkg')
  t.assert.equal(doc.components.length, 2)
})

// ── the @exodus/stasis/sbom API must stay free of brotli ─────────────────────

test('importing @exodus/stasis/sbom does not pull in brotli (node:zlib)', (t) => {
  // The API operates on already-parsed Bundle/Lockfile instances; only the CLI
  // glue (src/cmd/sbom.js) reads .br files and so loads zlib.
  const url = pathToFileURL(join(here, '..', 'stasis', 'src', 'sbom.js')).href
  const probe = `await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(process.moduleLoadList.filter((m) => /zlib/u.test(m))))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.deepEqual(JSON.parse(r.stdout), [], 'the sbom API must not load node:zlib')
})

// ── sbomCommand (CLI glue, reads/writes files) ───────────────────────────────

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-sbom-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeLockFile = (dir, obj = LOCK, name = 'stasis.lock.json') => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(obj))
  return p
}

test('sbomCommand writes a pretty-printed document to --output', withTmp((t, tmp) => {
  const out = join(tmp, 'nested', 'sbom.json')
  const { components } = sbomCommand({ files: [writeLockFile(tmp)], format: 'spdx', output: out, ...fixed })
  t.assert.equal(components.length, 3)
  const text = readFileSync(out, 'utf8')
  t.assert.ok(text.endsWith('\n'))
  t.assert.equal(JSON.parse(text).spdxVersion, 'SPDX-2.3')
}))

test('sbomCommand requires at least one input file', (t) => {
  t.assert.throws(() => sbomCommand({ files: [], format: 'spdx' }), /at least one lockfile or bundle/)
})

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

test('sbom without --format prints usage', (t) => {
  const r = runCli(['sbom', 'whatever.json'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /requires --format/)
})

test('sbom with an unknown --format prints usage', (t) => {
  const r = runCli(['sbom', '--format=foo', 'whatever.json'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--format must be spdx or cyclonedx/)
})

test('sbom with --format but no files prints usage', (t) => {
  const r = runCli(['sbom', '--format=spdx'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to export/)
})

test('sbom --format=spdx streams a valid SPDX document to stdout', withTmp((t, tmp) => {
  const r = runCli(['sbom', '--format=spdx', writeLockFile(tmp)])
  t.assert.equal(r.status, 0)
  const doc = JSON.parse(r.stdout)
  t.assert.equal(doc.spdxVersion, 'SPDX-2.3')
  t.assert.deepEqual(doc.packages.map((p) => p.name).toSorted(), ['@scope/bar', 'foo', 'top-pkg'])
  // summary goes to stderr so it never corrupts the piped document
  t.assert.match(r.stderr, /\[stasis] Wrote spdx SBOM with 3 components to <stdout>/)
}))

test('sbom --format=cyclonedx reads a brotli bundle and streams a valid document', withTmp((t, tmp) => {
  const bundle = {
    version: 1,
    config: { scope: 'full' },
    entries: ['src/entry.js'],
    sources: { '.': { name: 'app', version: '9.9.9', files: { 'src/entry.js': 'export const x = 1\n' } } },
    modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'export const f = 1\n' } } },
    formats: { 'node_modules/foo/index.js': 'javascript:module' },
    imports: {},
  }
  const path = join(tmp, 'snapshot.br')
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(bundle))))
  const r = runCli(['sbom', '--format=cyclonedx', path])
  t.assert.equal(r.status, 0)
  const doc = JSON.parse(r.stdout)
  t.assert.equal(doc.bomFormat, 'CycloneDX')
  t.assert.equal(doc.metadata.component.name, 'app')
  t.assert.deepEqual(doc.components.map((c) => c.purl), ['pkg:npm/foo@2.0.0'])
}))

test('sbom -o writes the document to a file and keeps stdout clean', withTmp((t, tmp) => {
  const out = join(tmp, 'out.json')
  const r = runCli(['sbom', '--format=cyclonedx', '-o', out, writeLockFile(tmp)])
  t.assert.equal(r.status, 0)
  t.assert.equal(r.stdout, '')
  t.assert.equal(JSON.parse(readFileSync(out, 'utf8')).bomFormat, 'CycloneDX')
}))

test('sbom surfaces a clean error for an unparseable input', withTmp((t, tmp) => {
  const file = join(tmp, 'junk.json')
  writeFileSync(file, JSON.stringify({ hello: 'world' }))
  const r = runCli(['sbom', '--format=spdx', file])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Failed to parse stasis lockfile/)
}))

test('sbom reports a missing input file clearly', (t) => {
  const r = runCli(['sbom', '--format=spdx', join(tmpdir(), 'definitely-missing-stasis.lock.json')])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /File not found:/)
})
