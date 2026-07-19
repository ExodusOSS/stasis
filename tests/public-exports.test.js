import { test } from 'node:test'

import { Bundle } from '@exodus/stasis/bundle'
import { buildBundle, bundleCommand } from '@exodus/stasis/cmd/bundle'
import { buildCommand, bundleFromLockfile } from '@exodus/stasis/cmd/build'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '@exodus/stasis/diff'
import { Lockfile } from '@exodus/stasis/lockfile'
import { buildPurl, collectComponents, generateSbom, sbom, toCyclonedx, toSpdx } from '@exodus/stasis/sbom'
import { StasisEsbuild } from '@exodus/stasis/esbuild'
import { StasisWebpack } from '@exodus/stasis/webpack'
import { StasisMetro } from '@exodus/stasis/metro'
import * as metroTransformer from '@exodus/stasis/metro-transformer'
import { StasisEsbuild as PluginsEsbuild } from '@exodus/stasis-plugins/esbuild'
import { StasisWebpack as PluginsWebpack } from '@exodus/stasis-plugins/webpack'
import { StasisMetro as PluginsMetro } from '@exodus/stasis-plugins/metro'
import * as pluginsMetroTransformer from '@exodus/stasis-plugins/metro-transformer'

test('@exodus/stasis/bundle exports Bundle class', (t) => {
  t.assert.equal(typeof Bundle, 'function')
  t.assert.equal(Bundle.VERSION, 1)
})

test('@exodus/stasis/{esbuild,webpack,metro} re-export the stasis-plugins plugins', (t) => {
  t.assert.equal(typeof StasisEsbuild, 'function')
  t.assert.equal(typeof StasisWebpack, 'function')
  t.assert.equal(typeof StasisMetro, 'function')
  t.assert.equal(StasisEsbuild, PluginsEsbuild)
  t.assert.equal(StasisWebpack, PluginsWebpack)
  t.assert.equal(StasisMetro, PluginsMetro)
})

test('@exodus/stasis/metro-transformer re-exports the stasis-plugins worker transformer', (t) => {
  t.assert.equal(typeof metroTransformer.transform, 'function')
  t.assert.equal(typeof metroTransformer.getCacheKey, 'function')
  t.assert.equal(metroTransformer.transform, pluginsMetroTransformer.transform)
  t.assert.equal(metroTransformer.getCacheKey, pluginsMetroTransformer.getCacheKey)
})

test('@exodus/stasis/cmd/bundle exports the bundle command and its in-memory API', (t) => {
  t.assert.equal(typeof buildBundle, 'function')
  t.assert.equal(typeof bundleCommand, 'function')
})

test('@exodus/stasis/cmd/build exports the build command and the lockfile-to-bundle helper', (t) => {
  t.assert.equal(typeof buildCommand, 'function')
  t.assert.equal(typeof bundleFromLockfile, 'function')
})

test('@exodus/stasis/lockfile exports Lockfile class', (t) => {
  t.assert.equal(typeof Lockfile, 'function')
  t.assert.equal(Lockfile.VERSION, 0)
})

test('@exodus/stasis/sbom exports the file-free SBOM API', (t) => {
  for (const fn of [buildPurl, collectComponents, generateSbom, sbom, toCyclonedx, toSpdx]) {
    t.assert.equal(typeof fn, 'function')
  }
  // Operates on already-parsed artifacts; an empty set still renders both formats.
  t.assert.equal(toSpdx([]).spdxVersion, 'SPDX-2.3')
  t.assert.equal(toCyclonedx([]).bomFormat, 'CycloneDX')
})

test('@exodus/stasis/diff exports the file-free diff API', (t) => {
  for (const fn of [diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact]) {
    t.assert.equal(typeof fn, 'function')
  }
  // Operates on already-parsed artifacts: an empty lockfile diffed against
  // itself has no differences and renders a stat with zero counts.
  const empty = { artifact: new Lockfile({ config: { scope: 'node_modules' } }), kind: 'lockfile' }
  const diff = diffArtifacts(empty, empty)
  t.assert.equal(hasDifferences(diff), false)
  t.assert.match(formatDiffStat(diff), /No differences/)
})

test('Lockfile round-trip preserves structure', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: {
      '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } },
    },
    modules: {
      'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } },
    },
  })
  const first = Lockfile.parse(text).serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
})

test('Lockfile round-trip preserves imports and a legacy lockfile stays without them', (t) => {
  const withImports = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: {
      '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } },
    },
    modules: {},
    imports: {
      'node, import': { 'src/a.js': { './b.js': 'src/b.js' } },
    },
  })
  const parsed = Lockfile.parse(withImports)
  t.assert.equal(parsed.imports.get('node, import').get('src/a.js').get('./b.js'), 'src/b.js')
  const first = parsed.serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
  t.assert.ok(JSON.parse(first).imports, 'imports must survive serialization')

  // A legacy lockfile (no imports key) parses to imports === null and
  // round-trips without gaining the key.
  const legacy = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } } },
  })
  const legacyParsed = Lockfile.parse(legacy)
  t.assert.equal(legacyParsed.imports, null)
  t.assert.equal(JSON.parse(legacyParsed.serialize()).imports, undefined)
})

test('Lockfile round-trip preserves formats and a legacy lockfile stays without them', (t) => {
  const withFormats = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: { '.': { name: 'x', version: '1.0.0', files: { 'src/a.js': 'sha512-aaa' } } },
    modules: {},
    formats: { 'src/a.js': 'module' },
  })
  const parsed = Lockfile.parse(withFormats)
  t.assert.equal(parsed.formats.get('src/a.js'), 'module')
  const first = parsed.serialize()
  const second = Lockfile.parse(first).serialize()
  t.assert.equal(first, second)
  t.assert.deepEqual(JSON.parse(first).formats, { 'src/a.js': 'module' })

  // A legacy lockfile (no formats key) parses to formats === null and
  // round-trips without gaining the key.
  const legacy = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-bbb' } } },
  })
  const legacyParsed = Lockfile.parse(legacy)
  t.assert.equal(legacyParsed.formats, null)
  t.assert.equal(JSON.parse(legacyParsed.serialize()).formats, undefined)
})

test('Lockfile.parse rejects malformed formats (escaping path / non-string value)', (t) => {
  const base = {
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  }
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { '../evil.js': 'module' } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { 'a/../../evil.js': 'module' } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: { 'src/a.js': 42 } })))
  t.assert.throws(() => Lockfile.parse(JSON.stringify({ ...base, formats: [] })))
})

test('Lockfile.parse rejects an unknown format string (allowlist gate)', (t) => {
  // KNOWN_FORMATS is the full universe of recognized formats. A tampered or
  // forward-incompatible lockfile carrying an unexpected tag (typo, attacker
  // payload, or a newer-stasis format) must fail closed at parse time, not at a
  // downstream string compare.
  const base = {
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  }
  t.assert.throws(
    () => Lockfile.parse(JSON.stringify({ ...base, formats: { 'node_modules/w/i.js': 'banana' } })),
    /unknown format 'banana'/
  )
  // resource:base64 is in KNOWN_FORMATS, but a typo variant must not slip through.
  t.assert.throws(
    () => Lockfile.parse(JSON.stringify({ ...base, formats: { 'node_modules/w/i.js': 'resource:base64x' } })),
    /unknown format 'resource:base64x'/
  )
})

test('Bundle.parse rejects an unknown format string (allowlist gate)', (t) => {
  // Same allowlist gate as Lockfile.parse, in the bundle's base parser.
  const base = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'export const x = 1\n' } } },
    imports: {},
  }
  t.assert.throws(
    () => Bundle.parse(JSON.stringify({ ...base, formats: { 'node_modules/w/i.js': 'banana' } })),
    /unknown format 'banana'/
  )
})

test('Bundle.parse and Lockfile.parse accept every documented KNOWN_FORMAT', (t) => {
  // Exercise every recognized format value through both parsers so the allowlist
  // and the recognized-format documentation stay in lockstep.
  const all = ['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
    'solidity', 'php', 'shell', 'rust', 'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c',
    'cpp', 'c-header', 'cpp-header', 'ruby', 'cmake', 'podspec', 'podfile', 'podfile-lock',
    'template', 'xml', 'env', 'fastlane', 'pbxproj', 'resource', 'resource:base64']
  for (const format of all) {
    const lockBase = {
      version: 0,
      config: { scope: 'node_modules' },
      modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
      formats: { 'node_modules/w/i.js': format },
    }
    t.assert.ok(Lockfile.parse(JSON.stringify(lockBase)), `Lockfile accepts format=${format}`)
    const bundleBase = {
      version: 1,
      config: { scope: 'node_modules' },
      modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'payload' } } },
      formats: { 'node_modules/w/i.js': format },
      imports: {},
    }
    t.assert.ok(Bundle.parse(JSON.stringify(bundleBase)), `Bundle accepts format=${format}`)
  }
})

test('Lockfile.parse rejects imports whose paths escape the project root', (t) => {
  const base = {
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  }
  const escapingTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': '../outside.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(escapingTarget))
  // A mid-path `..` that pops above the root is rejected too: plain
  // startsWith('..') would have let this through.
  const midPathTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 'a/../../outside.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(midPathTarget))
  const escapingParent = JSON.stringify({
    ...base,
    imports: { '*': { '../outside.js': { './b.js': 'src/b.js' } } },
  })
  t.assert.throws(() => Lockfile.parse(escapingParent))
  const nonStringTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 42 } } },
  })
  t.assert.throws(() => Lockfile.parse(nonStringTarget))
})

test('Bundle.parse rejects imports whose paths escape the project root', (t) => {
  const base = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'x' } } },
    formats: {},
  }
  const escapingTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': '../outside.js' } } },
  })
  t.assert.throws(() => Bundle.parse(escapingTarget))
  const midPathTarget = JSON.stringify({
    ...base,
    imports: { '*': { 'src/a.js': { './b.js': 'a/../../outside.js' } } },
  })
  t.assert.throws(() => Bundle.parse(midPathTarget))
  const escapingParent = JSON.stringify({
    ...base,
    imports: { '*': { '../outside.js': { './b.js': 'src/b.js' } } },
  })
  t.assert.throws(() => Bundle.parse(escapingParent))
  // An array `imports` (malformed shape) is rejected, matching Lockfile.parse.
  const arrayImports = JSON.stringify({ ...base, imports: [] })
  t.assert.throws(() => Bundle.parse(arrayImports))
})

test('Bundle.parse rejects module/source dirs and file keys that escape the project root', (t) => {
  // Same posixPathEscapes gate as Lockfile.parse (and the formats/imports checks
  // above): a mid-path `..` that pops above the root, or an absolute path, must
  // fail at the schema boundary -- the old '..'-prefix check let both through.
  const base = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {} }
  const info = { name: 'w', version: '1.0.0', files: { 'i.js': 'x' } }
  // a modules dir escaping mid-path (still contains 'node_modules', so only the
  // path check can reject it)
  t.assert.throws(() => Bundle.parse(JSON.stringify({
    ...base,
    modules: { 'node_modules/a/../../../evil': info },
  })))
  // an absolute modules dir
  t.assert.throws(() => Bundle.parse(JSON.stringify({
    ...base,
    modules: { '/node_modules/pkg': info },
  })))
  // a per-file key escaping its bucket mid-path
  t.assert.throws(() => Bundle.parse(JSON.stringify({
    ...base,
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'sub/../../x': 'boom' } } },
  })))
  // a workspace sources dir escaping mid-path (scope=full branch)
  t.assert.throws(() => Bundle.parse(JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: { 'src/../../evil': { name: 'x', version: '1.0.0', files: { 'a.js': 'x' } } },
    modules: {},
    formats: {},
    imports: {},
  })))
})

test('Bundle.parse rejects a v0 flat source path that escapes the project root', (t) => {
  const v0 = (path) => JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { [path]: 'boom' },
  })
  t.assert.throws(() => Bundle.parse(v0('../x')))
  t.assert.throws(() => Bundle.parse(v0('a/../../x')))
  t.assert.throws(() => Bundle.parse(v0('/etc/passwd')))
})

test('Bundle.parse keeps accepting a directory listing keyed at a module root (rel === \'\')', (t) => {
  // `stasis run --fs` keys a readdir of a package root at rel '' inside its own
  // bucket (moduleFileKey collapses that to the dir itself, see fs.test.js).
  // posixPathEscapes('') normalizes to '.' -- inside the root -- so the stricter
  // per-file check must keep accepting it.
  const text = JSON.stringify({
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/dep': { name: 'dep', version: '1.0.0', files: { '': '["package.json"]' } },
    },
    formats: { 'node_modules/dep': 'directory' },
    imports: {},
  })
  const parsed = Bundle.parse(text)
  t.assert.equal(parsed.modules.get('node_modules/dep').files[''], '["package.json"]')
  t.assert.equal(parsed.sources.get('node_modules/dep'), '["package.json"]')
  t.assert.equal(parsed.formats.get('node_modules/dep'), 'directory')
  // and the listing survives a serialize -> parse round-trip
  const again = Bundle.parse(parsed.serialize())
  t.assert.equal(again.modules.get('node_modules/dep').files[''], '["package.json"]')
})

test('Bundle.parse rejects a non-object formats (malformed shape)', (t) => {
  // formats is attested under frozen bundles, so a non-plain-object value is rejected at
  // parse time -- mirroring `imports` above and Lockfile.parse's `formats` check, rather
  // than the weaker truthiness test that let an array/number through.
  const base = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', version: '1.0.0', files: { 'i.js': 'x' } } },
    imports: {},
  }
  t.assert.throws(() => Bundle.parse(JSON.stringify({ ...base, formats: [] })))
  t.assert.throws(() => Bundle.parse(JSON.stringify({ ...base, formats: 5 })))
  t.assert.ok(Bundle.parse(JSON.stringify({ ...base, formats: {} })))
})

test('Bundle.serialize round-trip preserves entries, modules, formats, imports', (t) => {
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/a.js']),
    modules: new Map([
      ['.', { name: 'x', version: '1.0.0', files: { 'src/a.js': 'export const x = 1\n' } }],
      ['node_modules/w', { name: 'w', version: '1.0.0', files: { 'i.js': 'export const y = 2\n' } }],
    ]),
    formats: new Map([['src/a.js', 'module']]),
    imports: new Map([['*', new Map([['src/a.js', new Map([['./b.js', 'src/b.js']])]])]]),
  })

  const text = bundle.serialize()
  t.assert.equal(typeof text, 'string')
  const parsed = Bundle.parse(text)

  t.assert.deepEqual([...parsed.entries], ['src/a.js'])
  t.assert.equal(parsed.modules.get('.').name, 'x')
  t.assert.equal(parsed.modules.get('.').version, '1.0.0')
  t.assert.equal(parsed.modules.get('.').files['src/a.js'], 'export const x = 1\n')
  t.assert.equal(parsed.modules.get('node_modules/w').name, 'w')
  t.assert.equal(parsed.modules.get('node_modules/w').version, '1.0.0')
  t.assert.equal(parsed.modules.get('node_modules/w').files['i.js'], 'export const y = 2\n')
  t.assert.equal(parsed.sources.get('src/a.js'), 'export const x = 1\n')
  t.assert.equal(parsed.sources.get('node_modules/w/i.js'), 'export const y = 2\n')
  t.assert.equal(parsed.formats.get('src/a.js'), 'module')
  t.assert.equal(parsed.imports.get('*').get('src/a.js').get('./b.js'), 'src/b.js')
})

test('Bundle round-trip carries code and resources side-by-side in one bundle', (t) => {
  // The core promise of the collapse: a single bundle holds code (raw UTF-8),
  // 'resource' (raw UTF-8, e.g. an SVG), and 'resource:base64' (base64-encoded
  // binary) -- distinguished per file by `formats`. All three round-trip through
  // serialize/parse with their content and format preserved, and the flat
  // `sources` view sees every file.
  const code = "import { greet } from './hello.js'\n"
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>\n'
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/entry.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: {
        'src/entry.js': code,
        'src/icon.svg': svg,
        'src/logo.png': png,
      } }],
    ]),
    formats: new Map([
      ['src/entry.js', 'module'],
      ['src/icon.svg', 'resource'],
      ['src/logo.png', 'resource:base64'],
    ]),
    imports: new Map(),
  })

  const text = bundle.serialize()
  const parsed = Bundle.parse(text)

  // Content preserved verbatim for all three categories.
  t.assert.equal(parsed.sources.get('src/entry.js'), code)
  t.assert.equal(parsed.sources.get('src/icon.svg'), svg)
  t.assert.equal(parsed.sources.get('src/logo.png'), png)
  // Format tags preserved -- this is the per-file fidelity the collapse provides.
  t.assert.equal(parsed.formats.get('src/entry.js'), 'module')
  t.assert.equal(parsed.formats.get('src/icon.svg'), 'resource')
  t.assert.equal(parsed.formats.get('src/logo.png'), 'resource:base64')
  // Code entry survives the entries-only-when-code invariant.
  t.assert.deepEqual([...parsed.entries], ['src/entry.js'])
})

test('serialize emits the resource:base64 content as-is (raw bytes never leak)', (t) => {
  // Defense-in-depth round-trip: a resource:base64 payload makes the trip
  // serialize -> parse with its base64 text intact and its format tag intact, so
  // a reader can unambiguously decode it back to the original bytes. (A tampered
  // bundle that dropped the format tag would route the base64 text through the
  // code path -- the lockfile cross-check + byte hash catch that; this test
  // covers the happy path so a future refactor can't drift it silently.)
  const raw = Buffer.from([0, 1, 2, 3, 255, 254, 253])
  const b64 = raw.toString('base64')
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/x', { name: 'x', version: '1.0.0', files: { 'b.bin': b64 } }],
    ]),
    formats: new Map([['node_modules/x/b.bin', 'resource:base64']]),
  })
  const json = JSON.parse(bundle.serialize())
  t.assert.equal(json.modules['node_modules/x'].files['b.bin'], b64,
    'base64 text travels verbatim; raw bytes never appear in the JSON')
  t.assert.equal(json.formats['node_modules/x/b.bin'], 'resource:base64')
  // Round-trip the decode path the reader uses (Buffer.from(content, 'base64'))
  // matches the original bytes.
  t.assert.deepEqual(Buffer.from(json.modules['node_modules/x'].files['b.bin'], 'base64'), raw)
})

test('Bundle round-trip carries resources alone with no entries', (t) => {
  // The "resources-only" relaxation: a bundle with no code carries no entries
  // (the entries invariant only applies when the bundle actually carries code).
  const b64 = Buffer.from('hello').toString('base64')
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/foo', { name: 'foo', version: '1.0.0', files: { 'asset.bin': b64 } }],
    ]),
    formats: new Map([['node_modules/foo/asset.bin', 'resource:base64']]),
  })

  const text = bundle.serialize()
  t.assert.equal(typeof text, 'string')
  const parsed = Bundle.parse(text)

  t.assert.equal(parsed.modules.get('node_modules/foo').files['asset.bin'], b64)
  t.assert.equal(parsed.sources.get('node_modules/foo/asset.bin'), b64)
  t.assert.equal(parsed.formats.get('node_modules/foo/asset.bin'), 'resource:base64')
})

test('Bundle.parse exposes the parsed version (v0 stays at 0 in memory)', (t) => {
  const v0 = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: { 'src/a.js': 'export const x = 1\n' },
  })
  const parsed = Bundle.parse(v0)
  t.assert.equal(parsed.version, 0)
  // Re-save promotes to v1; the in-memory v0 carries no entries/modules metadata,
  // so a downstream caller (State.addFile) has to fill them before serialize.
})

test('Bundle.parse regroups v0 flat sources by inferred module dir', (t) => {
  const v0 = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    formats: {},
    imports: {},
    sources: {
      'src/a.js': 'a',
      'src/lib/b.js': 'b',
      'node_modules/foo/index.js': 'foo',
      'node_modules/foo/lib/x.js': 'foox',
      'node_modules/@scope/pkg/index.js': 'scoped',
      'node_modules/foo/node_modules/bar/i.js': 'nested',
    },
  })
  const parsed = Bundle.parse(v0)

  t.assert.deepEqual([...parsed.modules.keys()].toSorted(), [
    '.',
    'node_modules/@scope/pkg',
    'node_modules/foo',
    'node_modules/foo/node_modules/bar',
  ])
  // workspace bucket keeps the full project-relative path as rel
  t.assert.equal(parsed.modules.get('.').files['src/a.js'], 'a')
  t.assert.equal(parsed.modules.get('.').files['src/lib/b.js'], 'b')
  // node_modules buckets keep package-relative paths
  t.assert.equal(parsed.modules.get('node_modules/foo').files['index.js'], 'foo')
  t.assert.equal(parsed.modules.get('node_modules/foo').files['lib/x.js'], 'foox')
  t.assert.equal(parsed.modules.get('node_modules/@scope/pkg').files['index.js'], 'scoped')
  t.assert.equal(parsed.modules.get('node_modules/foo/node_modules/bar').files['i.js'], 'nested')
  // node_modules buckets carry the inferred package name; the workspace "."
  // bucket has no inferable name. v0 records no version, so version stays null.
  t.assert.equal(parsed.modules.get('.').name, null)
  t.assert.equal(parsed.modules.get('node_modules/foo').name, 'foo')
  t.assert.equal(parsed.modules.get('node_modules/@scope/pkg').name, '@scope/pkg')
  t.assert.equal(parsed.modules.get('node_modules/foo/node_modules/bar').name, 'bar')
  for (const dir of parsed.modules.keys()) {
    t.assert.equal(parsed.modules.get(dir).version, null, `${dir} version`)
  }
  // sources getter still presents a flat project-relative view
  t.assert.equal(parsed.sources.get('node_modules/foo/index.js'), 'foo')
  t.assert.equal(parsed.sources.get('node_modules/foo/node_modules/bar/i.js'), 'nested')
})

test('Bundle.parse rejects a v1 full-scope bundle that has code but empty entries', (t) => {
  // A bundle carrying code in full scope must declare an entry (a resources-only
  // bundle may have none -- covered separately). Here there's a code file, so empty
  // entries must be rejected.
  const text = JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0', files: { 'src/a.js': 'export const x = 1\n' } } },
    modules: {},
    formats: { 'src/a.js': 'module' },
    imports: {},
  })
  t.assert.throws(() => Bundle.parse(text), /at least one entry/)
})

test('Lockfile.parse rejects a node_modules module missing name', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { version: '1.0.0', files: { 'i.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(text))
})

test('Lockfile.parse rejects a node_modules module missing version', (t) => {
  const text = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/w': { name: 'w', files: { 'i.js': 'sha512-x' } } },
  })
  t.assert.throws(() => Lockfile.parse(text))
})

test('Lockfile.serialize rejects a node_modules module missing name/version', (t) => {
  const lock = new Lockfile({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'i.js': 'sha512-x' } }],
    ]),
  })
  t.assert.throws(() => lock.serialize())
})

test('Bundle.serialize rejects a node_modules module missing name/version', (t) => {
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'i.js': 'x' } }],
    ]),
  })
  t.assert.throws(() => bundle.serialize())
})

test('Bundle.serialize rejects a node_modules module missing name/version (resources)', (t) => {
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/w', { name: null, version: null, files: { 'a.bin': 'eA==' } }],
    ]),
    formats: new Map([['node_modules/w/a.bin', 'resource:base64']]),
  })
  t.assert.throws(() => bundle.serialize())
})
