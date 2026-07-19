import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// --- Bundle.merge -----------------------------------------------------------

const jsBundle = ({ scope = 'full', entries, modules, formats, imports, reason } = {}) =>
  new Bundle({
    config: { scope },
    entries: new Set(entries),
    modules: new Map(modules),
    formats: new Map(formats),
    imports: new Map(imports),
    reason,
  })

test('Bundle.merge unions entries, files, formats, and imports', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A', 'src/shared.js': 'S' } }]],
    formats: [['src/a.js', 'module'], ['src/shared.js', 'module']],
    imports: [['*', new Map([['src/a.js', new Map([['./shared.js', 'src/shared.js']])]])]],
  })
  const b = jsBundle({
    entries: ['src/b.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/b.js': 'B', 'src/shared.js': 'S' } }]],
    formats: [['src/b.js', 'module'], ['src/shared.js', 'module']],
    imports: [['*', new Map([['src/b.js', new Map([['./shared.js', 'src/shared.js']])]])]],
  })

  const merged = a.merge(b)
  // Neither input is mutated.
  t.assert.deepEqual([...a.entries], ['src/a.js'])
  t.assert.deepEqual([...b.entries], ['src/b.js'])

  t.assert.deepEqual([...merged.entries].toSorted(), ['src/a.js', 'src/b.js'])
  t.assert.deepEqual(
    Object.keys(merged.modules.get('.').files).toSorted(),
    ['src/a.js', 'src/b.js', 'src/shared.js'],
  )
  // The identical shared file collapses to one entry (dedup, no conflict).
  t.assert.equal(merged.modules.get('.').files['src/shared.js'], 'S')
  t.assert.equal(merged.formats.get('src/b.js'), 'module')
  t.assert.equal(merged.imports.get('*').get('src/a.js').get('./shared.js'), 'src/shared.js')
  t.assert.equal(merged.imports.get('*').get('src/b.js').get('./shared.js'), 'src/shared.js')

  // And the merged bundle is a valid, round-trippable artifact.
  const parsed = Bundle.parse(merged.serialize())
  t.assert.deepEqual([...parsed.entries].toSorted(), ['src/a.js', 'src/b.js'])
})

test('Bundle.merge unions node_modules buckets alongside the workspace bucket', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [
      ['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }],
      ['node_modules/dep', { name: 'dep', version: '2.0.0', ecosystem: 'npm', files: { 'index.js': 'D' } }],
    ],
    formats: [['src/a.js', 'module'], ['node_modules/dep/index.js', 'commonjs']],
  })
  const b = jsBundle({
    entries: ['src/b.js'],
    modules: [
      ['.', { name: 'app', version: '1.0.0', files: { 'src/b.js': 'B' } }],
      ['node_modules/other', { name: 'other', version: '3.1.0', ecosystem: 'npm', files: { 'i.js': 'O' } }],
    ],
    formats: [['src/b.js', 'module'], ['node_modules/other/i.js', 'commonjs']],
  })

  const merged = a.merge(b)
  t.assert.deepEqual(
    [...merged.modules.keys()].toSorted(),
    ['.', 'node_modules/dep', 'node_modules/other'],
  )
  t.assert.equal(merged.modules.get('node_modules/dep').ecosystem, 'npm')
  t.assert.equal(merged.modules.get('node_modules/dep').version, '2.0.0')
  t.assert.equal(merged.modules.get('node_modules/other').name, 'other')
})

test('Bundle.merge is a no-op for a re-added identical file', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
  })
  const merged = a.merge(a)
  t.assert.deepEqual([...merged.entries], ['src/a.js'])
  t.assert.deepEqual(Object.keys(merged.modules.get('.').files), ['src/a.js'])
})

test('Bundle.merge preserves and unions per-platform (metro) edge targets', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    imports: [['*', new Map([['src/a.js', new Map([
      ['./p', new Map([['ios', 'src/p.ios.js'], ['android', 'src/p.android.js']])],
    ])]])]],
  })
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    imports: [['*', new Map([['src/a.js', new Map([
      ['./q', 'src/q.js'],
    ])]])]],
  })
  const merged = a.merge(b)
  const edges = merged.imports.get('*').get('src/a.js')
  t.assert.deepEqual([...edges.get('./p')], [['ios', 'src/p.ios.js'], ['android', 'src/p.android.js']])
  t.assert.equal(edges.get('./q'), 'src/q.js')
})

test('Bundle.merge unions the informational reason provenance per consumer', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    reason: { run: ['src/a.js'] },
  })
  const b = jsBundle({
    entries: ['src/b.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/b.js': 'B' } }]],
    formats: [['src/b.js', 'module']],
    reason: { run: ['src/b.js'], webpack: ['src/b.js'] },
  })
  const merged = a.merge(b)
  t.assert.deepEqual(merged.reason.run, ['src/a.js', 'src/b.js'])
  t.assert.deepEqual(merged.reason.webpack, ['src/b.js'])
})

test('Bundle.merge throws on a scope mismatch', (t) => {
  const full = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
  })
  const nm = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([['node_modules/x', { name: 'x', version: '1.0.0', files: { 'i.js': 'X' } }]]),
    formats: new Map([['node_modules/x/i.js', 'commonjs']]),
  })
  t.assert.throws(() => full.merge(nm), /scope mismatch/)
})

test('Bundle.merge throws on module identity conflicts (name / version / ecosystem)', (t) => {
  const base = (mod) => jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }], mod],
    formats: [['src/a.js', 'module']],
  })
  const a = base(['node_modules/dep', { name: 'dep', version: '1.0.0', ecosystem: 'npm', files: { 'i.js': 'D' } }])
  t.assert.throws(
    () => a.merge(base(['node_modules/dep', { name: 'other', version: '1.0.0', ecosystem: 'npm', files: { 'i.js': 'D' } }])),
    /name mismatch/,
  )
  t.assert.throws(
    () => a.merge(base(['node_modules/dep', { name: 'dep', version: '9.9.9', ecosystem: 'npm', files: { 'i.js': 'D' } }])),
    /version mismatch/,
  )
  t.assert.throws(
    () => a.merge(base(['node_modules/dep', { name: 'dep', version: '1.0.0', ecosystem: 'soldeer', files: { 'i.js': 'D' } }])),
    /ecosystem mismatch/,
  )
})

test('Bundle.merge throws when the same file has different bytes', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/shared.js': 'ONE' } }]],
    formats: [['src/shared.js', 'module']],
  })
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/shared.js': 'TWO' } }]],
    formats: [['src/shared.js', 'module']],
  })
  t.assert.throws(() => a.merge(b), /content mismatch for 'src\/shared\.js'/)
})

test('Bundle.merge throws when the same file has a different format', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
  })
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'commonjs']],
  })
  t.assert.throws(() => a.merge(b), /format conflict for 'src\/a\.js'/)
})

// --- payload-free stat records reconcile against real formats (reconcileFormat) -------------

test('Bundle.merge lets a real format supersede a payload-free stat:file (either order)', (t) => {
  const statOnly = jsBundle({ formats: [['src/a.js', 'stat:file']] }) // a --fs stat record, no bytes
  const real = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
  })
  // The weak stat record yields to the real format whichever side it merges from.
  t.assert.equal(real.merge(statOnly).formats.get('src/a.js'), 'module', 'incoming stat yields')
  t.assert.equal(statOnly.merge(real).formats.get('src/a.js'), 'module', 'real overrides the stat record')
})

test('Bundle.merge lets a real directory listing supersede a stat:directory (either order)', (t) => {
  const statDir = jsBundle({ formats: [['src/d', 'stat:directory']] })
  const realDir = jsBundle({ formats: [['src/d', 'directory']] })
  t.assert.equal(statDir.merge(realDir).formats.get('src/d'), 'directory')
  t.assert.equal(realDir.merge(statDir).formats.get('src/d'), 'directory')
})

test('Bundle.merge keeps a stat record vs a real format of the OTHER kind fatal', (t) => {
  // stat:file (a file) vs a real 'directory' listing -- a genuine kind conflict, not an upgrade.
  const statFile = jsBundle({ formats: [['src/x', 'stat:file']] })
  const realDir = jsBundle({ formats: [['src/x', 'directory']] })
  t.assert.throws(() => statFile.merge(realDir), /format conflict for 'src\/x'/)
  t.assert.throws(() => realDir.merge(statFile), /format conflict for 'src\/x'/)

  // stat:directory (a directory) vs a real file format.
  const statDir = jsBundle({ formats: [['src/y', 'stat:directory']] })
  const realFile = jsBundle({
    entries: ['src/y'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/y': 'Y' } }]],
    formats: [['src/y', 'module']],
  })
  t.assert.throws(() => statDir.merge(realFile), /format conflict for 'src\/y'/)
})

test('Bundle.merge keeps a stat:file vs stat:directory kind flip fatal', (t) => {
  const a = jsBundle({ formats: [['src/z', 'stat:file']] })
  const b = jsBundle({ formats: [['src/z', 'stat:directory']] })
  t.assert.throws(() => a.merge(b), /format conflict for 'src\/z'/)
})

test('Bundle.merge throws when an edge resolves to a different target', (t) => {
  const a = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    imports: [['*', new Map([['src/a.js', new Map([['./x', 'src/x1.js']])]])]],
  })
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    imports: [['*', new Map([['src/a.js', new Map([['./x', 'src/x2.js']])]])]],
  })
  t.assert.throws(() => a.merge(b), /import '\.\/x' from 'src\/a\.js' resolves differently/)
})

// --- Bundle.withReason ------------------------------------------------------

test('Bundle.withReason attributes every file to the consumer in the reason map', (t) => {
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A', 'src/b.js': 'B' } }]],
    formats: [['src/a.js', 'module'], ['src/b.js', 'module']],
  })
  const stamped = b.withReason('bundle')
  t.assert.deepEqual(stamped.reason, { bundle: ['src/a.js', 'src/b.js'] })
  // The original is untouched, and the file set / structure is preserved.
  t.assert.equal(b.reason, undefined)
  t.assert.deepEqual([...stamped.sources.keys()].toSorted(), ['src/a.js', 'src/b.js'])
  // It round-trips through serialize/parse with the reason intact.
  t.assert.deepEqual(Bundle.parse(stamped.serialize()).reason, { bundle: ['src/a.js', 'src/b.js'] })
})

test('Bundle.withReason unions with an existing attribution instead of replacing it', (t) => {
  const b = jsBundle({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A' } }]],
    formats: [['src/a.js', 'module']],
    reason: { run: ['src/a.js'] },
  })
  const stamped = b.withReason('bundle')
  t.assert.deepEqual(stamped.reason, { run: ['src/a.js'], bundle: ['src/a.js'] })
})

// --- Lockfile.merge ---------------------------------------------------------

const lock = ({ scope = 'full', entries, modules, imports = null, formats = null } = {}) =>
  new Lockfile({
    config: { scope },
    entries: new Set(entries),
    modules: new Map(modules),
    imports,
    formats,
  })

test('Lockfile.merge unions entries, modules, imports, and formats', (t) => {
  const a = lock({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'sha512-a', 'src/shared.js': 'sha512-s' } }]],
    imports: new Map([['*', new Map([['src/a.js', new Map([['./shared.js', 'src/shared.js']])]])]]),
    formats: new Map([['src/a.js', 'module'], ['src/shared.js', 'module']]),
  })
  const b = lock({
    entries: ['src/b.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/b.js': 'sha512-b', 'src/shared.js': 'sha512-s' } }]],
    imports: new Map([['*', new Map([['src/b.js', new Map([['./shared.js', 'src/shared.js']])]])]]),
    formats: new Map([['src/b.js', 'module'], ['src/shared.js', 'module']]),
  })

  const merged = a.merge(b)
  t.assert.deepEqual([...merged.entries].toSorted(), ['src/a.js', 'src/b.js'])
  t.assert.deepEqual(
    Object.keys(merged.modules.get('.').files).toSorted(),
    ['src/a.js', 'src/b.js', 'src/shared.js'],
  )
  t.assert.equal(merged.imports.get('*').get('src/b.js').get('./shared.js'), 'src/shared.js')
  t.assert.equal(merged.formats.get('src/b.js'), 'module')

  // Round-trips.
  const reparsed = Lockfile.parse(merged.serialize())
  t.assert.deepEqual([...reparsed.entries].toSorted(), ['src/a.js', 'src/b.js'])
})

test('Lockfile.merge throws when the same file has a different integrity hash', (t) => {
  const a = lock({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/shared.js': 'sha512-one' } }]],
  })
  const b = lock({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/shared.js': 'sha512-two' } }]],
  })
  t.assert.throws(() => a.merge(b), /content mismatch for 'src\/shared\.js'/)
})

test('Lockfile.merge throws on a scope mismatch', (t) => {
  const full = lock({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'sha512-a' } }]],
  })
  const nm = lock({
    scope: 'node_modules',
    modules: [['node_modules/x', { name: 'x', version: '1.0.0', files: { 'i.js': 'sha512-x' } }]],
  })
  t.assert.throws(() => full.merge(nm), /scope mismatch/)
})

test('Lockfile.merge keeps both-null imports/formats null, but rejects a one-sided null', (t) => {
  const legacy = lock({
    entries: ['src/a.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'sha512-a' } }]],
  })
  const legacy2 = lock({
    entries: ['src/b.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/b.js': 'sha512-b' } }]],
  })
  // Two legacy lockfiles (imports/formats === null) merge into a legacy lockfile.
  const merged = legacy.merge(legacy2)
  t.assert.equal(merged.imports, null)
  t.assert.equal(merged.formats, null)

  // A legacy lockfile can't merge with one that attests imports/formats: that
  // would silently drop the attestation the other side carries.
  const attesting = lock({
    entries: ['src/c.js'],
    modules: [['.', { name: 'app', version: '1.0.0', files: { 'src/c.js': 'sha512-c' } }]],
    imports: new Map([['*', new Map()]]),
    formats: new Map([['src/c.js', 'module']]),
  })
  t.assert.throws(() => legacy.merge(attesting), /cannot merge imports/)
})
