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

// Every string in the JSON, with its key path.
const strings = (value, path = [], out = []) => {
  if (typeof value === 'string') out.push([[...path], value])
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) strings(child, [...path, Array.isArray(value) ? Number(key) : key], out)
  }
  return out
}

// What a streaming reader hands fromJSON: each string at a file position replaced by a placeholder.
const takeOut = (json) => {
  for (const [path] of strings(json)) {
    if (Bundle.fileKeyAt(path) !== undefined) path.slice(0, -1).reduce((node, key) => node[key], json)[path.at(-1)] = Symbol('streamed')
  }
  return json
}

const v1Of = (sources) => ({ version: 1, config: { scope: 'full' }, entries: [], sources, formats: {}, imports: {} })
const v0Of = (extra) => ({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, ...extra })

test('fromJSON with contents: false keeps every field and file list, and locks contents out', (t) => {
  const text = sampleBundle().serialize()
  const full = Bundle.parse(text)
  const bundle = Bundle.fromJSON(takeOut(JSON.parse(text)), { contents: false })
  for (const field of ['version', 'config', 'entries', 'formats', 'imports', 'executable', 'reason']) {
    t.assert.deepStrictEqual(bundle[field], full[field], field)
  }
  t.assert.equal(bundle.hasCode, full.hasCode)
  t.assert.deepStrictEqual([...bundle.modules.keys()], [...full.modules.keys()])
  for (const [dir, { files, ...info }] of bundle.modules) {
    const { files: fullFiles, ...fullInfo } = full.modules.get(dir)
    t.assert.deepStrictEqual(info, fullInfo)
    t.assert.deepStrictEqual(Object.keys(files), Object.keys(fullFiles))
    t.assert.equal(Object.getPrototypeOf(files), null)
    t.assert.ok(Object.isFrozen(files))
  }
  // Enough for a metadata-only consumer: the SBOM components are the full Bundle's.
  t.assert.deepStrictEqual(collectComponents([bundle]), collectComponents([full]))

  // Reading contents throws, so nothing can serve, write or merge them.
  const files = bundle.modules.get('.').files
  t.assert.ok(Object.hasOwn(files, 'src/index.js'))
  t.assert.throws(() => files['src/index.js'], /file contents are not retained/)
  t.assert.throws(() => Object.entries(files), /file contents are not retained/)
  t.assert.throws(() => {
    files['src/index.js'] = 'swapped'
  }, TypeError)
  t.assert.throws(() => bundle.sources, /file contents are not retained/)
  t.assert.throws(() => bundle.serialize(), /file contents are not retained/)
  t.assert.throws(() => bundle.merge(full), /file contents are not retained/)
  t.assert.throws(() => full.merge(bundle), /file contents are not retained/)
})

test('fromJSON with contents: false rejects any file the reader did not take out', (t) => {
  t.assert.throws(() => Bundle.fromJSON(JSON.parse(sampleBundle().serialize()), { contents: false }), /is not a placeholder/)
  // Shapes where fileKeyAt and fromJSON disagree on which strings are files.
  const cases = {
    'v0 modules': v0Of({ sources: { 'node_modules/x/a.js': 42 }, modules: { 'node_modules/x': { name: 'x', version: '1', files: { 'a.js': 'B' } } } }),
    'v0 sources array': v0Of({ sources: ['A'] }),
    'v0 nested contents': v0Of({ sources: { x: { files: { y: 'A' } } } }),
    'v1 sources array': v1Of([{ name: 'a', files: { 'x.js': 'X' } }]),
    'v1 files array': v1Of({ '.': { name: 'a', files: ['X'] } }),
    'v1 files string': v1Of({ '.': { name: 'a', files: 'XY' } }),
    'v1 nested contents': v1Of({ '.': { name: 'a', files: { 'x.js': { y: 'X' } } } }),
    'v1 number contents': v1Of({ '.': { name: 'a', files: { 'x.js': 42 } } }),
  }
  for (const [label, json] of Object.entries(cases)) {
    t.assert.throws(() => Bundle.fromJSON(takeOut(json), { contents: false }), /is not a placeholder/, label)
  }
})

test('Bundle.fileKeyAt finds every file in the bundle JSON, keyed as sources keys it', (t) => {
  const v0 = JSON.stringify(v0Of({ formats: { 'src/a.js': 'module' }, sources: { 'src/a.js': 'A', 'node_modules/x/index.js': 'X', '': 'root' } }))
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
