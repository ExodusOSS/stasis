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

test('withoutContents keeps every field and file list, only the contents go', (t) => {
  const full = Bundle.parse(sampleBundle().serialize())
  const bundle = full.withoutContents()
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
  const bundle = full.withoutContents()
  t.assert.equal(full.modules.get('.').files['bin/run.sh'], '#!/bin/sh\necho "hi"\n', 'the source Bundle is untouched')

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
  t.assert.throws(() => full.merge(bundle), /file contents are not retained/)

  // Metadata-only operations keep working, and keep the Bundle contents-free.
  const stamped = bundle.withReason('audit')
  t.assert.equal(stamped.hasContents, false)
  t.assert.deepStrictEqual(stamped.reason.audit, full.withReason('audit').reason.audit)
  t.assert.equal(bundle.withoutContents().hasContents, false)

  // The constructor option is the same lock.
  const constructed = new Bundle({ modules: new Map([['.', { name: 'app', files: { 'a.js': 'A' } }]]), contents: false })
  t.assert.deepStrictEqual(Object.keys(constructed.modules.get('.').files), ['a.js'])
  t.assert.throws(() => constructed.modules.get('.').files['a.js'], /not retained/)
  t.assert.throws(() => new Bundle({ contents: 'no' }))

  // Rebuilt from its public fields, it stays contents-free: its buckets still refuse reads.
  const rebuilt = new Bundle({ ...bundle })
  t.assert.equal(rebuilt.hasContents, false)
  t.assert.throws(() => rebuilt.serialize(), /file contents are not retained/)
  // A Bundle-like without hasContents (e.g. from another stasis-core copy) still merges.
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

  // File values are carried over uninspected, so a streaming reader can leave a placeholder.
  const placeholder = Symbol('streamed')
  const withPlaceholder = { ...json, sources: { '.': { ...json.sources['.'], files: { ...json.sources['.'].files, 'src/index.js': placeholder } } } }
  t.assert.equal(Bundle.fromJSON(withPlaceholder).modules.get('.').files['src/index.js'], placeholder)
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

  t.assert.equal(Bundle.fileKeyAt(['modules', 'node_modules/x', 'files', 'a.js']), 'node_modules/x/a.js')
  t.assert.equal(Bundle.fileKeyAt(['sources', '.', 'files', '']), '.')
  for (const path of [['entries', 0], ['formats', 'a.js'], ['sources', '.', 'name'], ['sources', 0, 'files', 'a.js'], ['reason', 'run', 0]]) {
    t.assert.equal(Bundle.fileKeyAt(path), undefined, JSON.stringify(path))
  }
  // A non-canonical key throws, as fromJSON does.
  t.assert.throws(() => Bundle.fileKeyAt(['sources', '.', 'files', '.']), /non-canonical file key "\."/)
  t.assert.throws(() => Bundle.fileKeyAt(['sources', 'src', 'files', '../x.js']), /non-canonical file key/)
  t.assert.throws(() => Bundle.fileKeyAt(['sources', 'a/node_modules/x/../../../b']), /non-canonical file key/)
})
