import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import {
  buildPurl,
  collectComponents,
  generateSbom,
  sbomCommand,
  toCyclonedx,
  toSpdx,
} from '../src/sbom.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-sbom-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A scope=full lockfile: one workspace root (".") plus two node_modules deps,
// one of them scoped.
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
      'node_modules/@scope/bar': { name: '@scope/bar', version: '4.5.6', files: { 'index.js': 'sha512-z' } },
    },
    ...extra,
  }
  writeFileSync(path, JSON.stringify(lock))
  return path
}

const writeBundle = (dir, json, name = 'snapshot.br') => {
  const path = join(dir, name)
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(json))))
  return path
}

// Deterministic generation options so structural assertions can also check the
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

test('buildPurl returns null for ecosystems without a purl type', (t) => {
  t.assert.equal(buildPurl('cargo', 'serde', '1.0.0'), null)
})

// ── collectComponents ────────────────────────────────────────────────────────

test('collectComponents includes workspace and dependency packages (unlike audit)', withTmp((t, tmp) => {
  const components = collectComponents([writeLock(tmp)])
  t.assert.deepEqual(components, [
    { name: '@scope/bar', version: '4.5.6', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/%40scope/bar@4.5.6' },
    { name: 'foo', version: '1.2.3', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/foo@1.2.3' },
    { name: 'top-pkg', version: '1.0.0', scope: 'workspace', ecosystem: 'npm', purl: 'pkg:npm/top-pkg@1.0.0' },
  ])
}))

test('collectComponents skips buckets without name+version (legacy v0 bundle)', withTmp((t, tmp) => {
  const file = writeBundle(tmp, {
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { 'node_modules/foo/index.js': 'x' },
  })
  t.assert.deepEqual(collectComponents([file]), [])
}))

test('collectComponents dedupes by ecosystem+name+version across files', withTmp((t, tmp) => {
  const a = writeLock(tmp, 'a.json')
  const b = writeLock(tmp, 'b.json')
  const components = collectComponents([a, b])
  t.assert.equal(components.length, 3)
}))

test('collectComponents keeps the same name at different versions', withTmp((t, tmp) => {
  const a = writeLock(tmp, 'a.json')
  const b = writeLock(tmp, 'b.json', {
    modules: { 'node_modules/foo': { name: 'foo', version: '2.0.0', files: { 'index.js': 'sha512-y' } } },
  })
  const foos = collectComponents([a, b]).filter((c) => c.name === 'foo')
  t.assert.deepEqual(foos.map((c) => c.version), ['1.2.3', '2.0.0'])
}))

test('collectComponents treats a PHP bundle as composer and vendor pkgs as dependencies', withTmp((t, tmp) => {
  // PHP vendor packages live outside node_modules (`vendor/<vendor>/<pkg>`), so
  // classification must lean on the composer ecosystem, not the path.
  const file = writeBundle(tmp, {
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
  const components = collectComponents([file])
  t.assert.deepEqual(components, [
    { name: 'acme/app', version: '1.0.0', scope: 'workspace', ecosystem: 'composer', purl: 'pkg:composer/acme/app@1.0.0' },
    { name: 'monolog/monolog', version: '3.5.0', scope: 'dependency', ecosystem: 'composer', purl: 'pkg:composer/monolog/monolog@3.5.0' },
  ])
}))

// ── toSpdx ───────────────────────────────────────────────────────────────────

test('toSpdx DESCRIBES the single workspace root and the root DEPENDS_ON each dependency', withTmp((t, tmp) => {
  const doc = toSpdx(collectComponents([writeLock(tmp)]), fixed)
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

  // primary first, with its purl as an external ref
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
}))

test('toSpdx with no single root (node_modules-only) DESCRIBES every package, no DEPENDS_ON', withTmp((t, tmp) => {
  const file = writeBundle(tmp, {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'index.js': 'x' } },
      'node_modules/bar': { name: 'bar', version: '2.0.0', files: { 'index.js': 'y' } },
    },
    formats: {},
    imports: {},
  })
  const doc = toSpdx(collectComponents([file]), fixed)
  t.assert.equal(doc.name, 'stasis-sbom')
  t.assert.equal(doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON').length, 0)
  const describes = doc.relationships.filter((r) => r.relationshipType === 'DESCRIBES')
  t.assert.equal(describes.length, 2)
  t.assert.ok(describes.every((r) => r.spdxElementId === 'SPDXRef-DOCUMENT'))
}))

test('toSpdx omits externalRefs when there is no purl', (t) => {
  const doc = toSpdx([{ name: 'x', version: '1.0.0', scope: 'dependency', ecosystem: 'cargo', purl: null }], fixed)
  t.assert.equal(doc.packages[0].externalRefs, undefined)
})

// ── toCyclonedx ──────────────────────────────────────────────────────────────

test('toCyclonedx sets the root as metadata.component and lists deps with a flat dependency graph', withTmp((t, tmp) => {
  const doc = toCyclonedx(collectComponents([writeLock(tmp)]), fixed)
  t.assert.equal(doc.bomFormat, 'CycloneDX')
  t.assert.equal(doc.specVersion, '1.5')
  t.assert.equal(doc.serialNumber, 'urn:uuid:00000000-0000-4000-8000-000000000000')
  t.assert.equal(doc.version, 1)
  t.assert.equal(doc.metadata.timestamp, '2026-01-02T03:04:05Z')
  t.assert.deepEqual(doc.metadata.tools, [
    { vendor: 'Exodus Movement, Inc.', name: '@exodus/stasis', version: '1.0.0-alpha.3' },
  ])

  t.assert.equal(doc.metadata.component.type, 'application')
  t.assert.equal(doc.metadata.component.name, 'top-pkg')
  t.assert.equal(doc.metadata.component.purl, 'pkg:npm/top-pkg@1.0.0')

  // scoped dep splits into group + name
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
}))

test('toCyclonedx without a single root omits metadata.component and dependencies', (t) => {
  const doc = toCyclonedx([
    { name: 'foo', version: '1.0.0', scope: 'dependency', ecosystem: 'npm', purl: 'pkg:npm/foo@1.0.0' },
  ], fixed)
  t.assert.equal(doc.metadata.component, undefined)
  t.assert.equal(doc.dependencies, undefined)
  t.assert.equal(doc.components.length, 1)
})

// ── generateSbom ─────────────────────────────────────────────────────────────

test('generateSbom dispatches on format and rejects unknown ones', (t) => {
  t.assert.equal(generateSbom('spdx', []).spdxVersion, 'SPDX-2.3')
  t.assert.equal(generateSbom('cyclonedx', []).bomFormat, 'CycloneDX')
  t.assert.throws(() => generateSbom('syft', []), /--format must be spdx or cyclonedx/)
})

// ── sbomCommand (programmatic) ───────────────────────────────────────────────

test('sbomCommand writes a pretty-printed document to --output', withTmp((t, tmp) => {
  const out = join(tmp, 'nested', 'sbom.json')
  const { components } = sbomCommand({ files: [writeLock(tmp)], format: 'spdx', output: out, ...fixed })
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
  const r = runCli(['sbom', '--format=spdx', writeLock(tmp)])
  t.assert.equal(r.status, 0)
  const doc = JSON.parse(r.stdout)
  t.assert.equal(doc.spdxVersion, 'SPDX-2.3')
  t.assert.deepEqual(doc.packages.map((p) => p.name).toSorted(), ['@scope/bar', 'foo', 'top-pkg'])
  // summary goes to stderr so it never corrupts the piped document
  t.assert.match(r.stderr, /\[stasis] Wrote spdx SBOM with 3 components to <stdout>/)
}))

test('sbom --format=cyclonedx streams a valid CycloneDX document to stdout', withTmp((t, tmp) => {
  const r = runCli(['sbom', '--format=cyclonedx', writeLock(tmp)])
  t.assert.equal(r.status, 0)
  const doc = JSON.parse(r.stdout)
  t.assert.equal(doc.bomFormat, 'CycloneDX')
  t.assert.equal(doc.metadata.component.name, 'top-pkg')
  t.assert.equal(doc.components.length, 2)
}))

test('sbom -o writes the document to a file and keeps stdout clean', withTmp((t, tmp) => {
  const out = join(tmp, 'out.json')
  const r = runCli(['sbom', '--format=cyclonedx', '-o', out, writeLock(tmp)])
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
