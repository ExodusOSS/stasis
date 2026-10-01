import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { collectComponents } from '../stasis/src/sbom.js'

// Both bucket kinds, a base64 resource, a platform import map, an executable and a reason map.
function sampleBundle() {
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', {
        name: 'app', version: '1.0.0',
        files: {
          'src/index.js': 'import dep from "dep"\nimport "./platform"\n',
          'src/ios.js': 'export const os = "ios"\n',
          'src/android.js': 'export const os = "android"\n',
          'assets/logo.png': Buffer.from([0, 1, 2, 250]).toString('base64'),
          'bin/run.sh': '#!/bin/sh\necho "hi"\n',
        },
      }],
      ['node_modules/dep', {
        name: 'dep', version: '2.0.0', ecosystem: 'npm',
        files: { 'index.js': 'module.exports = 1\n', 'package.json': '{"name":"dep","version":"2.0.0"}' },
      }],
    ]),
    formats: new Map([
      ['src/index.js', 'module'], ['src/ios.js', 'module'], ['src/android.js', 'module'],
      ['assets/logo.png', 'resource:base64'], ['bin/run.sh', 'shell'],
      ['node_modules/dep/index.js', 'commonjs'], ['node_modules/dep/package.json', 'json'],
    ]),
    imports: new Map([['*', new Map([['src/index.js', new Map([
      ['dep', 'node_modules/dep/index.js'],
      ['./platform', new Map([['ios', 'src/ios.js'], ['android', 'src/android.js']])],
    ])]])]]),
    executable: new Set(['bin/run.sh']),
    reason: { run: ['src/index.js', 'node_modules/dep/index.js'] },
  })
}

// What a streaming reader builds: the same bundle, contents-free.
const contentsFreeOf = (bundle) => Bundle.fromJSON(JSON.parse(bundle.serialize()), { contents: false })

test('a contents-free Bundle keeps every field and file list, only the contents go', (t) => {
  const full = Bundle.parse(sampleBundle().serialize())
  const bundle = contentsFreeOf(full)
  t.assert.equal(full.hasContents, true)
  t.assert.equal(bundle.hasContents, false)
  for (const field of ['version', 'config', 'entries', 'formats', 'imports', 'executable', 'reason']) {
    t.assert.deepStrictEqual(bundle[field], full[field], field)
  }
  t.assert.equal(bundle.hasCode, full.hasCode)
  t.assert.deepStrictEqual([...bundle.modules.keys()], [...full.modules.keys()])
  for (const [dir, info] of bundle.modules) {
    const { files: fullFiles, ...fullInfo } = full.modules.get(dir)
    const { files, ...rest } = info
    t.assert.deepStrictEqual(rest, fullInfo)
    t.assert.deepStrictEqual(Object.keys(files), Object.keys(fullFiles))
    t.assert.equal(Object.getPrototypeOf(files), null)
    t.assert.ok(Object.isFrozen(files))
  }
  // Enough for a metadata-only consumer: the SBOM components are the full Bundle's.
  t.assert.deepStrictEqual(collectComponents([bundle]), collectComponents([full]))
})

test('a contents-free Bundle locks out contents, serialize() and merge()', (t) => {
  const full = sampleBundle()
  const bundle = contentsFreeOf(full)

  const files = bundle.modules.get('.').files
  t.assert.ok(Object.hasOwn(files, 'src/index.js'))
  t.assert.ok('src/index.js' in files)
  t.assert.throws(() => files['src/index.js'], /file contents are not retained/)
  t.assert.throws(() => Object.entries(files), /file contents are not retained/)
  t.assert.throws(() => {
    files['src/index.js'] = 'swapped'
  }, TypeError)
  t.assert.throws(() => bundle.sources, /file contents are not retained/)
  t.assert.throws(() => bundle.serialize(), /file contents are not retained/)
  t.assert.throws(() => bundle.merge(full), /file contents are not retained/)
  t.assert.throws(() => full.merge(bundle), /the other Bundle is contents-free/)

  // Metadata-only operations keep working, and keep the Bundle contents-free.
  const stamped = bundle.withReason('audit')
  t.assert.equal(stamped.hasContents, false)
  t.assert.deepStrictEqual(stamped.reason.audit, full.withReason('audit').reason.audit)

  // The constructor option is the same lock.
  const constructed = new Bundle({ modules: new Map([['.', { name: 'app', files: { 'a.js': 'A' } }]]), contents: false })
  t.assert.deepStrictEqual(Object.keys(constructed.modules.get('.').files), ['a.js'])
  t.assert.throws(() => constructed.modules.get('.').files['a.js'], /not retained/)
  t.assert.throws(() => new Bundle({ contents: 'no' }))

  // A Bundle-like without hasContents still merges.
  const plain = { config: { scope: 'full' }, entries: new Set(), modules: new Map(), formats: new Map(), imports: new Map(), executable: new Set() }
  t.assert.equal(full.merge(plain).hasContents, true)
})

test('Bundle.fromJSON builds what Bundle.parse builds and rejects what it rejects', (t) => {
  const v1 = sampleBundle().serialize()
  const v0 = JSON.stringify({
    version: 0, config: { scope: 'full' }, formats: {}, imports: {},
    sources: { 'src/a.js': 'A', 'node_modules/x/index.js': 'X', 'node_modules/@s/y/lib/z.js': 'Z' },
  })
  for (const text of [v1, v0]) {
    const parsed = Bundle.parse(text)
    const built = Bundle.fromJSON(JSON.parse(text))
    for (const field of ['version', 'config', 'entries', 'modules', 'formats', 'imports', 'executable', 'reason']) {
      t.assert.deepStrictEqual(built[field], parsed[field], field)
    }
  }

  const json = JSON.parse(v1)
  const bad = [
    { ...json, version: 7 },
    { ...json, formats: { ...json.formats, 'src/index.js': 'bogus' } },
    { ...json, sources: { '.': { ...json.sources['.'], files: { '../evil.js': 'x' } } } },
  ]
  for (const value of bad) {
    let expected
    t.assert.throws(() => Bundle.parse(JSON.stringify(value)), (error) => (expected = error) !== undefined)
    t.assert.throws(() => Bundle.fromJSON(value), { name: expected.name, message: expected.message })
  }

  // A file value must be a string, or with `contents: false` a symbol placeholder (a streaming reader's).
  const withPlaceholder = { ...json, sources: { '.': { ...json.sources['.'], files: { ...json.sources['.'].files, 'src/index.js': Symbol('streamed') } } } }
  t.assert.throws(() => Bundle.fromJSON(withPlaceholder), /file 'src\/index\.js' has non-string contents/)
  const contentsFree = Bundle.fromJSON(withPlaceholder, { contents: false })
  t.assert.equal(contentsFree.hasContents, false)
  t.assert.deepStrictEqual(Object.keys(contentsFree.modules.get('.').files), Object.keys(json.sources['.'].files))
  t.assert.throws(() => contentsFree.serialize(), /file contents are not retained/)

  // The Bundle keeps no reference into the value it was built from.
  const value = JSON.parse(v1)
  const built = Bundle.fromJSON(value)
  value.config.scope = 'bogus'
  value.reason.run.push('src/ios.js')
  t.assert.deepStrictEqual(built.config, { scope: 'full' })
  t.assert.deepStrictEqual(built.reason, Bundle.parse(v1).reason)

  // `reason` is informational: a malformed one is kept as is, never a reason to reject the bundle.
  const reason = JSON.parse('{"run": [2, 1, null], "odd": "x", "__proto__": ["a.js"]}')
  t.assert.deepStrictEqual(Bundle.fromJSON({ ...JSON.parse(v1), reason }).reason, reason)
})

test('Bundle.fileKeyAt finds every file in the bundle JSON, keyed as sources keys it', (t) => {
  // Every string in the JSON, with its key path.
  const strings = (value, path = [], out = []) => {
    if (typeof value === 'string') out.push([[...path], value])
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) strings(child, [...path, Array.isArray(value) ? Number(key) : key], out)
    }
    return out
  }
  const v0 = JSON.stringify({
    version: 0, config: { scope: 'full' }, formats: { 'src/a.js': 'module' }, imports: {},
    sources: { 'src/a.js': 'A', 'node_modules/x/index.js': 'X', '': 'root' },
  })
  for (const text of [sampleBundle().serialize(), v0]) {
    const located = new Map()
    for (const [path, value] of strings(JSON.parse(text))) {
      const file = Bundle.fileKeyAt(path)
      if (file !== undefined) located.set(file, value)
    }
    t.assert.deepStrictEqual(located, Bundle.parse(text).sources)
  }

  // fromJSON rejects every shape whose files fileKeyAt would place differently.
  const v1 = (sources) => ({ version: 1, config: { scope: 'full' }, entries: [], sources, formats: {}, imports: {} })
  const v0Of = (extra) => ({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, ...extra })
  const disagreeing = {
    'v0 modules': v0Of({ sources: { 'node_modules/x/a.js': 'A' }, modules: { 'node_modules/x': { name: 'x', version: '1', files: { 'a.js': 'B' } } } }),
    'v0 sources array': v0Of({ sources: ['A'] }),
    'v0 nested contents': v0Of({ sources: { x: { files: { y: 'A' } } } }),
    'v1 sources array': v1([{ name: 'a', files: { 'x.js': 'X' } }]),
    'v1 files array': v1({ '.': { name: 'a', files: ['X'] } }),
    'v1 files string': v1({ '.': { name: 'a', files: 'XY' } }),
    'v1 nested contents': v1({ '.': { name: 'a', files: { 'x.js': { y: 'X' } } } }),
    'v1 number contents': v1({ '.': { name: 'a', files: { 'x.js': 42 } } }),
  }
  for (const [label, value] of Object.entries(disagreeing)) {
    t.assert.throws(() => Bundle.fromJSON(value), label)
    t.assert.throws(() => Bundle.fromJSON(value, { contents: false }), label)
  }

  t.assert.equal(Bundle.fileKeyAt(['modules', 'node_modules/x', 'files', 'a.js']), 'node_modules/x/a.js')
  t.assert.equal(Bundle.fileKeyAt(['sources', '.', 'files', '']), '.')
  for (const path of [['entries', 0], ['formats', 'a.js'], ['sources', '.', 'name'], ['sources', 0, 'files', 'a.js'], ['reason', 'run', 0]]) {
    t.assert.equal(Bundle.fileKeyAt(path), undefined, JSON.stringify(path))
  }
  // A non-canonical key throws, as fromJSON does.
  t.assert.throws(() => Bundle.fileKeyAt(['sources', '.', 'files', '.']), /non-canonical file key "\."/)
  t.assert.throws(() => Bundle.fileKeyAt(['sources', 'src', 'files', '../x.js']), /non-canonical file key/)
  // fromJSON keys files through the same check, so it fails with the same error.
  for (const path of ['a/node_modules/x/../../../b', '../x', '/etc/passwd']) {
    let expected
    t.assert.throws(() => Bundle.fileKeyAt(['sources', path]), (error) => (expected = error) !== undefined)
    t.assert.match(expected.message, /non-canonical file key/)
    t.assert.throws(() => Bundle.fromJSON(v0Of({ sources: { [path]: 'x' } })), { message: expected.message }, path)
  }
})
