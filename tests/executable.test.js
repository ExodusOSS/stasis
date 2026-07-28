import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { State } from '@exodus/stasis-core/state'
import { addCommand } from '@exodus/stasis-core/add'
import { extractCommand, lockfileFromBundle } from '@exodus/stasis-core/extract'
import { buildBashBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundleFromLockfile } from '../stasis/src/bundle-from-lockfile.js'
import { diffArtifacts, formatDiffStat, hasDifferences } from '../stasis/src/diff.js'

// The `executable` array records which of an artifact's files carried a POSIX execute bit when they
// were captured, so `stasis extract` can put the bit back. It sits at the top level of both the
// lockfile and the bundle, holds files only (never a `directory` capture), and is omitted when
// empty. These tests pin the on-disk shape, the capture paths that populate it, and the chmod.

const withTmp = (prefix) => (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `stasis-${prefix}-`))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Everything that chmods or reads a mode is POSIX-only: Windows exposes no execute bits (see
// canObserveExecuteBits), so the seeding chmods are no-ops and the assertions become vacuous there.
const posixOnly = { skip: process.platform === 'win32' && 'POSIX execute bits' }

const isExec = (path) => (statSync(path).mode & 0o111) !== 0
const perms = (path) => statSync(path).mode & 0o777
const decode = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))

// ── serialized shape ─────────────────────────────────────────────────────────

test('Lockfile omits `executable` when nothing is executable and emits a sorted array when something is', (t) => {
  const modules = () => new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'sha512-a', 'run.sh': 'sha512-b' } }],
  ])
  const plain = new Lockfile({ config: { scope: 'full' }, entries: new Set(), modules: modules(), imports: new Map(), formats: new Map() })
  t.assert.ok(!Object.hasOwn(JSON.parse(plain.serialize()), 'executable'))
  t.assert.deepEqual([...plain.executable], [])

  const marked = new Lockfile({
    config: { scope: 'full' },
    entries: new Set(),
    modules: modules(),
    imports: new Map(),
    formats: new Map(),
    // Deliberately out of order: serialize sorts by the project's sortPaths rule.
    executable: new Set(['src/index.js', 'run.sh']),
  })
  const json = JSON.parse(marked.serialize())
  t.assert.deepEqual(json.executable, ['run.sh', 'src/index.js'])
  // Last key, after the attestation maps.
  t.assert.equal(Object.keys(json).at(-1), 'executable')

  t.assert.deepEqual([...Lockfile.parse(marked.serialize()).executable].toSorted(), ['run.sh', 'src/index.js'])
})

test('Bundle omits `executable` when empty and round-trips it when set', (t) => {
  const modules = () => new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'export const x = 1\n', 'run.sh': '#!/bin/sh\n' } }],
  ])
  const plain = new Bundle({ config: { scope: 'full' }, entries: new Set(['src/index.js']), modules: modules() })
  t.assert.ok(!Object.hasOwn(JSON.parse(plain.serialize()), 'executable'))

  const marked = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: modules(),
    executable: new Set(['run.sh']),
  })
  t.assert.deepEqual(JSON.parse(marked.serialize()).executable, ['run.sh'])
  t.assert.deepEqual([...Bundle.parse(marked.serialize()).executable], ['run.sh'])
})

// ── parse: fail closed on an entry that names no file ────────────────────────

const rawBundle = (executable, extra = {}) => JSON.stringify({
  version: 1,
  config: { scope: 'full' },
  entries: ['src/index.js'],
  sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/index.js': 'export const x = 1\n' } } },
  modules: {},
  formats: { 'src/index.js': 'module' },
  imports: {},
  executable,
  ...extra,
})

test('Bundle.parse refuses an `executable` entry that names no file it carries', (t) => {
  t.assert.throws(() => Bundle.parse(rawBundle(['src/nope.js'])), /names no file the bundle records/)
  // A path that escapes the root is refused before the membership check.
  t.assert.throws(() => Bundle.parse(rawBundle(['../outside.sh'])), /escapes the root/)
  t.assert.throws(() => Bundle.parse(rawBundle(['src/../../outside.sh'])), /escapes the root/)
  // Shape guards.
  t.assert.throws(() => Bundle.parse(rawBundle('src/index.js')), /executable must be an array/)
  t.assert.throws(() => Bundle.parse(rawBundle([42])), /must be a non-empty string/)
  t.assert.throws(() => Bundle.parse(rawBundle([''])), /must be a non-empty string/)
})

test('Bundle.parse refuses an `executable` entry naming a `directory` capture', (t) => {
  const raw = JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src': '["a.js"]' } } },
    modules: {},
    formats: { 'src': 'directory' },
    imports: {},
    executable: ['src'],
  })
  t.assert.throws(() => Bundle.parse(raw), /is a directory capture, not a file/)
})

test('Lockfile.parse refuses an `executable` entry that names no attested file', (t) => {
  const raw = (executable) => JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'run.sh': 'sha512-a' } } },
    modules: {},
    imports: {},
    // A payload-free stat record has no `files` entry, so it is not a file that can be executable.
    formats: { 'run.sh': 'shell', 'probed.sh': 'stat:file' },
    executable,
  })
  t.assert.deepEqual([...Lockfile.parse(raw(['run.sh'])).executable], ['run.sh'])
  t.assert.throws(() => Lockfile.parse(raw(['probed.sh'])), /names no file the lockfile records/)
  t.assert.throws(() => Lockfile.parse(raw(['/etc/passwd'])), /escapes the root/)
  // Duplicates fail closed like every sibling parse rule, rather than silently collapsing and
  // round-tripping to different bytes than the input.
  t.assert.throws(() => Lockfile.parse(raw(['run.sh', 'run.sh'])), /is listed twice/)
})

// A stat record is payload-free -- there is nothing to chmod. It normally can't appear because it
// has no `files` entry, but a hand-built artifact can supply one, so the format is checked directly.
test('parse refuses an `executable` entry naming a payload-free stat record', (t) => {
  const raw = (version, extra) => JSON.stringify({
    version,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'probed.sh': version === 0 ? 'sha512-a' : '#!/bin/sh\n' } } },
    modules: {},
    formats: { 'probed.sh': 'stat:file' },
    imports: {},
    executable: ['probed.sh'],
    ...extra,
  })
  t.assert.throws(() => Bundle.parse(raw(1)), /is a payload-free 'stat:file' record, not a file/)
  t.assert.throws(() => Lockfile.parse(raw(0)), /is a payload-free 'stat:file' record, not a file/)
})

test('Bundle.parse ignores an `executable` list on a legacy v0 bundle', (t) => {
  // v0 carries no per-file `formats`, so the directory/stat guards can't run; honoring the list
  // would let a legacy-shaped untrusted bundle pick a path for `extract` to chmod +x.
  const raw = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    sources: { 'run.sh': '#!/bin/sh\n' },
    formats: {},
    imports: {},
    executable: ['run.sh'],
  })
  t.assert.deepEqual([...Bundle.parse(raw).executable], [])
})

// ── the two invariants, enforced on BOTH sides ───────────────────────────────

// `executable` is a subset of the artifact's files, and a non-full-scope artifact records only its
// node_modules tree so it may list only node_modules files. Both rules are checked at serialize --
// the single choke point every producer goes through -- so a write site that forgets to narrow fails
// there, naming the path, instead of emitting an artifact its own parser refuses on the next read.
test('serialize refuses an `executable` entry that is not among the files it emits', (t) => {
  const bundle = (executable) => new Bundle({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'run.sh': '#!/bin/sh\n' } }]]),
    formats: new Map([['run.sh', 'shell']]),
    executable: new Set(executable),
  })
  t.assert.doesNotThrow(() => bundle(['run.sh']).serialize())
  t.assert.throws(() => bundle(['ghost.sh']).serialize(), /names no file the bundle records/)

  const lock = (executable) => new Lockfile({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'run.sh': 'sha512-a' } }]]),
    imports: new Map(),
    formats: new Map([['run.sh', 'shell']]),
    executable: new Set(executable),
  })
  t.assert.doesNotThrow(() => lock(['run.sh']).serialize())
  t.assert.throws(() => lock(['ghost.sh']).serialize(), /names no file the lockfile records/)
})

// serialize applies the SAME four rules parse does. Regression: it enforced only membership and
// scope, so an artifact naming a `directory` capture or a payload-free `stat:*` record serialized
// cleanly and then failed its own parse -- the corrupt-on-next-read failure the check exists to stop.
test('serialize applies every rule parse does, so an artifact always round-trips', (t) => {
  const cases = [
    ['directory', '["a.js"]', 'sha512-d', /is a directory capture, not a file/u],
    ['stat:file', '#!/bin/sh\n', 'sha512-s', /is a payload-free 'stat:file' record, not a file/u],
  ]
  for (const [format, content, digest, message] of cases) {
    const bundle = new Bundle({
      config: { scope: 'full' },
      entries: new Set(),
      modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'x': content } }]]),
      formats: new Map([['x', format]]),
      executable: new Set(['x']),
    })
    t.assert.throws(() => bundle.serialize(), message, `bundle rejects '${format}' at serialize`)

    const lock = new Lockfile({
      config: { scope: 'full' },
      entries: new Set(),
      modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'x': digest } }]]),
      imports: new Map(),
      formats: new Map([['x', format]]),
      executable: new Set(['x']),
    })
    t.assert.throws(() => lock.serialize(), message, `lockfile rejects '${format}' at serialize`)
  }
})

test('a non-full-scope artifact may list only node_modules executables', (t) => {
  // Both buckets are held in memory, but serialize writes only the node_modules half -- so listing
  // the workspace script would emit a path the written artifact does not record.
  const modules = () => new Map([
    ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'cli.js': 'sha512-a' } }],
    ['.', { name: 'app', version: '1.0.0', files: { 'run.sh': 'sha512-b' } }],
  ])
  const lock = (executable) => new Lockfile({
    config: { scope: 'node_modules' },
    modules: modules(),
    imports: new Map(),
    formats: new Map(),
    executable: new Set(executable),
  })
  t.assert.throws(() => lock(['run.sh']).serialize(),
    /is outside node_modules, which a 'node_modules'-scope lockfile does not record/)
  const ok = lock(['node_modules/dep/cli.js']).serialize()
  t.assert.deepEqual(JSON.parse(ok).executable, ['node_modules/dep/cli.js'])
  t.assert.deepEqual([...Lockfile.parse(ok).executable], ['node_modules/dep/cli.js'])

  // The read side states the same rule directly, so a hand-edited artifact gets the same diagnosis
  // rather than a bare "names no file" (which is also true, but says less).
  const raw = JSON.stringify({
    version: 0,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'cli.js': 'sha512-a' } } },
    imports: {},
    formats: {},
    executable: ['run.sh'],
  })
  t.assert.throws(() => Lockfile.parse(raw),
    /is outside node_modules, which a 'node_modules'-scope lockfile does not record/)
})

// ── merge ────────────────────────────────────────────────────────────────────

test('merge lets the incoming artifact clear a bit for a file it records', (t) => {
  const bundle = (executable) => new Bundle({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'run.sh': '#!/bin/sh\n' } }]]),
    formats: new Map([['run.sh', 'shell']]),
    executable: new Set(executable),
  })
  // `stasis add` / `stasis bundle --add` re-read the file and put the fresh build on the RIGHT. A
  // plain union would resurrect the stale bit and `extract` would keep granting +x forever.
  t.assert.deepEqual([...bundle(['run.sh']).merge(bundle([])).executable], [])
  // ...and the reverse still grants it.
  t.assert.deepEqual([...bundle([]).merge(bundle(['run.sh'])).executable], ['run.sh'])

  const lock = (executable) => new Lockfile({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'run.sh': 'sha512-x' } }]]),
    imports: new Map(),
    formats: new Map([['run.sh', 'shell']]),
    executable: new Set(executable),
  })
  t.assert.deepEqual([...lock(['run.sh']).merge(lock([])).executable], [])
})

test('merge unions the executable lists of both artifacts', (t) => {
  const bundle = (rel, content, executable) => new Bundle({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { [rel]: content } }]]),
    formats: new Map([[rel, 'shell']]),
    executable: new Set(executable),
  })
  const merged = bundle('a.sh', '#!/bin/sh\n', ['a.sh']).merge(bundle('b.sh', '#!/bin/sh\n', []))
  t.assert.deepEqual([...merged.executable], ['a.sh'])
  // And the merged artifact still parses -- both files are carried, so the entry stays valid.
  t.assert.deepEqual([...Bundle.parse(merged.serialize()).executable], ['a.sh'])

  const lock = (rel, executable) => new Lockfile({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { [rel]: 'sha512-x' } }]]),
    imports: new Map(),
    formats: new Map([[rel, 'shell']]),
    executable: new Set(executable),
  })
  t.assert.deepEqual([...lock('a.sh', ['a.sh']).merge(lock('b.sh', ['b.sh'])).executable].toSorted(), ['a.sh', 'b.sh'])
})

// ── State capture ────────────────────────────────────────────────────────────

// A tiny project with one executable script and one plain source.
const seedProject = (tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  writeFileSync(join(tmp, 'plain.cjs'), 'module.exports = 1\n')
  writeFileSync(join(tmp, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(tmp, 'run.sh'), 0o755)
}

test('State records the execute bit of a captured file into both the bundle and the lockfile', posixOnly, withTmp('exec-state')((t, tmp) => {
  seedProject(tmp)
  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  state.addFile(pathToFileURL(join(tmp, 'plain.cjs')).toString(), { format: 'commonjs', isEntry: true })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell' })

  t.assert.deepEqual([...state.executable], ['run.sh'])
  t.assert.deepEqual([...state.sourceBundle.executable], ['run.sh'])
  t.assert.deepEqual(JSON.parse(state.lockData).executable, ['run.sh'])
}))

test('State drops a stale execute bit once the file loses it on disk', posixOnly, withTmp('exec-restat')((t, tmp) => {
  seedProject(tmp)

  // Capture once with the bit set, and persist both artifacts.
  const first = new State(tmp, { scope: 'full', bundle: 'add' })
  first.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  first.write()
  t.assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).executable, ['run.sh'])
  t.assert.deepEqual(decode(join(tmp, 'stasis.code.br')).executable, new Set(['run.sh']))

  // chmod -x, then re-capture with lock=add: the bytes are unchanged, so this is not a conflict --
  // disk simply wins, and the stale entry is gone from both artifacts.
  chmodSync(join(tmp, 'run.sh'), 0o644)
  const second = new State(tmp, { scope: 'full', bundle: 'add' })
  t.assert.deepEqual([...second.executable], ['run.sh'], 'seeded from the artifacts on disk')
  second.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  t.assert.deepEqual([...second.executable], [])
  t.assert.ok(!Object.hasOwn(JSON.parse(second.lockData), 'executable'))
  t.assert.ok(!Object.hasOwn(JSON.parse(second.sourceData), 'executable'))
}))

test('a bundle=load State serves the executable list it absorbed', posixOnly, withTmp('exec-load')((t, tmp) => {
  seedProject(tmp)
  const cap = new State(tmp, { scope: 'full', bundle: 'add' })
  cap.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  cap.write()

  // lock:'ignore', NOT 'frozen': a loaded lockfile would seed `executable` on its own, so the
  // assertion would pass even if the bundle-absorb path recorded nothing. This isolates the bundle.
  rmSync(join(tmp, 'stasis.lock.json'))
  const load = new State(tmp, { scope: 'full', bundle: 'load', lock: 'ignore' })
  t.assert.deepEqual([...load.executable], ['run.sh'])
}))

test('a split bundle layout lists only its own executables in each half', posixOnly, withTmp('exec-split')((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  writeFileSync(join(tmp, 'run.sh'), '#!/bin/sh\n')
  writeFileSync(join(tmp, 'tool.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))
  writeFileSync(join(tmp, 'plain.cjs'), 'module.exports = 1\n')
  chmodSync(join(tmp, 'run.sh'), 0o755)
  chmodSync(join(tmp, 'tool.bin'), 0o755)

  const state = new State(tmp, {
    scope: 'full',
    bundle: 'add',
    bundleFile: join(tmp, 'code.br'),
    resourcesBundleFile: join(tmp, 'res.br'),
  })
  state.addFile(pathToFileURL(join(tmp, 'plain.cjs')).toString(), { format: 'commonjs', isEntry: true })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell' })
  state.addFile(pathToFileURL(join(tmp, 'tool.bin')).toString(), { resource: true })

  // The code half claims only the script, the resources half only the binary -- neither lists a
  // file it doesn't carry (which Bundle.parse would refuse).
  t.assert.deepEqual([...state.codeBundle.executable], ['run.sh'])
  t.assert.deepEqual([...state.resourcesBundle.executable], ['tool.bin'])
  // The single lockfile attests both.
  t.assert.deepEqual(JSON.parse(state.lockData).executable, ['run.sh', 'tool.bin'])

  state.write()
  t.assert.deepEqual([...decode(join(tmp, 'code.br')).executable], ['run.sh'])
  t.assert.deepEqual([...decode(join(tmp, 'res.br')).executable], ['tool.bin'])
}))

test('a `directory` capture drops an execute bit a prior content record left on that path', posixOnly, withTmp('exec-dir')((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 1\n')
  // Directories carry the execute bit as "searchable" -- it must not leak into the list.
  chmodSync(join(tmp, 'src'), 0o755)

  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  // Seed the path as executable the way a prior run's artifact would (when `src` was still a file),
  // so the delete in addFsDir has something to remove -- otherwise this test can't fail.
  state.executable.add('src')
  state.addFsDir(pathToFileURL(join(tmp, 'src')).toString(), ['a.js'])
  t.assert.equal(state.formats.get('src'), 'directory')
  t.assert.deepEqual([...state.executable], [])
  t.assert.deepEqual([...state.sourceBundle.executable], [])

  // Belt and braces: even if a stale entry survived on the live set, the narrowing that feeds both
  // artifacts drops a `directory`-format path, so neither can emit one its own parser would refuse.
  state.executable.add('src')
  t.assert.deepEqual([...state.sourceBundle.executable], [])
  t.assert.ok(!Object.hasOwn(JSON.parse(state.lockData), 'executable'))
}))

// A non-full-scope artifact drops its workspace buckets at serialize time, so an executable
// workspace file must not survive into the emitted list -- it would name a file the written
// artifact no longer records, and both parsers refuse that. Regression: the pair used to write a
// lockfile AND bundle that the very next run could not read, bricking the project.
test('scope=node_modules never emits an executable the serialized artifact drops', posixOnly, withTmp('exec-scope')((t, tmp) => {
  seedProject(tmp)
  mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'cli.js'), 'module.exports = 1\n')
  chmodSync(join(tmp, 'node_modules', 'dep', 'cli.js'), 0o755)

  const state = new State(tmp, { scope: 'node_modules', lock: 'add', bundle: 'add' })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell' })
  state.addFile(pathToFileURL(join(tmp, 'node_modules', 'dep', 'cli.js')).toString(), { format: 'commonjs' })

  // The workspace script is dropped with its bucket; the dependency's CLI survives in both.
  t.assert.deepEqual(JSON.parse(state.lockData).executable, ['node_modules/dep/cli.js'])
  t.assert.deepEqual(JSON.parse(state.sourceData).executable, ['node_modules/dep/cli.js'])
  // Both artifacts round-trip through their own parsers -- the property the bug violated.
  t.assert.doesNotThrow(() => Lockfile.parse(state.lockData))
  t.assert.doesNotThrow(() => Bundle.parse(state.sourceData))

  // And a second run over what the first wrote constructs cleanly.
  state.write()
  t.assert.doesNotThrow(() => new State(tmp, { scope: 'node_modules', lock: 'add', bundle: 'add' }))
}))

// A write-mode sidecar (the bundler-plugin shape) is the State that re-reads the file, but the
// PARENT owns the lockfile and seeded the bit from it. Without the parent-side clear, the union in
// #mergedExecutable resurrects a bit the sidecar just refuted -- forever, on every run.
test('a sidecar re-read clears the execute bit the parent seeded from the lockfile', posixOnly, withTmp('exec-sidecar')((t, tmp) => {
  seedProject(tmp)
  // A distinct sidecar path per pass: the write-target claim registry is process-wide and the first
  // pass's States stay live for the whole test. The bit under test rides the parent's LOCKFILE seed,
  // not the sidecar bundle, so this doesn't weaken what's being exercised.
  const capture = (name) => {
    const parent = new State(tmp, { scope: 'full', lock: 'add', bundle: 'ignore' })
    const sidecar = new State(tmp, { parent, bundle: 'add', bundleFile: join(tmp, name) })
    sidecar.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
    return { parent, sidecar }
  }

  const first = capture('side-1.br')
  t.assert.deepEqual(JSON.parse(first.parent.lockData).executable, ['run.sh'])
  first.parent.write()
  first.sidecar.write()

  // The bytes are unchanged, so nothing else about the re-capture differs.
  chmodSync(join(tmp, 'run.sh'), 0o644)
  const second = capture('side-2.br')
  t.assert.deepEqual([...second.sidecar.executable], [], 'the sidecar that re-read it drops the bit')
  t.assert.ok(!Object.hasOwn(JSON.parse(second.parent.lockData), 'executable'),
    'and the lockfile the parent writes drops it too')
}))

// The clear has to reach the whole family, not just the State that made the observation: the
// parent's lockfile unions every sidecar's set, so a sibling's -- or the parent's own -- seeded entry
// would resurrect a bit this run just refuted. Both directions, since only child->parent was covered.
test('a re-read clears the execute bit across the whole sidecar family', posixOnly, withTmp('exec-family')((t, tmp) => {
  seedProject(tmp)
  const url = pathToFileURL(join(tmp, 'run.sh')).toString()
  const parent = new State(tmp, { scope: 'full', lock: 'add', bundle: 'ignore' })
  const a = new State(tmp, { parent, bundle: 'add', bundleFile: join(tmp, 'a.br') })
  const b = new State(tmp, { parent, bundle: 'add', bundleFile: join(tmp, 'b.br') })

  // Everyone holds the bit, as a seed from their own artifact on disk would leave them.
  for (const state of [parent, a, b]) state.executable.add('run.sh')

  // The PARENT is the one that re-reads it (a loader import, or an --fs read) -- the direction the
  // child->parent clear alone could not handle.
  chmodSync(join(tmp, 'run.sh'), 0o644)
  parent.addFile(url, { format: 'shell', isEntry: true })
  t.assert.deepEqual([...parent.executable], [])
  t.assert.deepEqual([...a.executable], [], 'sidecar A drops it too')
  t.assert.deepEqual([...b.executable], [], 'and so does sibling B')
  t.assert.ok(!Object.hasOwn(JSON.parse(parent.lockData), 'executable'))
}))

// A forked child refutes a bit by OMISSION -- it records the file but leaves it off `executable`.
// The root's file replay fast-paths past anything it already attests, so without walking the shard's
// recorded files the root would never look, and a bit could be granted but never revoked.
test('mergeShard revokes a bit the child observed as gone, not just grants', posixOnly, withTmp('exec-shard')((t, tmp) => {
  seedProject(tmp)
  const url = pathToFileURL(join(tmp, 'run.sh')).toString()

  // Root captures it executable and persists, so the next root starts from that lockfile baseline.
  const first = new State(tmp, { scope: 'full', lock: 'add', bundle: 'ignore', childProcess: true })
  first.addFile(url, { format: 'shell', isEntry: true })
  first.write()
  t.assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).executable, ['run.sh'])

  chmodSync(join(tmp, 'run.sh'), 0o644)
  // The child re-reads it and correctly records no bit.
  const child = new State(tmp, { scope: 'full', lock: 'add', bundle: 'ignore', childProcess: true })
  child.addFile(url, { format: 'shell', isEntry: true })
  const shard = child.shardSnapshot()
  t.assert.ok(!Object.hasOwn(JSON.parse(shard), 'executable'), 'the shard refutes by omission')

  // The root never touches run.sh itself; only the merge can carry the refutation.
  const root = new State(tmp, { scope: 'full', lock: 'add', bundle: 'ignore', childProcess: true })
  t.assert.deepEqual([...root.executable], ['run.sh'], 'seeded from the lockfile')
  root.mergeShard(shard)
  t.assert.deepEqual([...root.executable], [])
  t.assert.ok(!Object.hasOwn(JSON.parse(root.lockData), 'executable'))
}))

// ── static builders ──────────────────────────────────────────────────────────

test('the bash bundler records the execute bit of every script it walks', posixOnly, withTmp('exec-bash')(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'scripts', version: '1.0.0' }))
  writeFileSync(join(tmp, 'main.sh'), '#!/bin/bash\nsource ./lib.sh\n')
  writeFileSync(join(tmp, 'lib.sh'), '#!/bin/bash\necho lib\n')
  chmodSync(join(tmp, 'main.sh'), 0o755) // the entry is runnable, the sourced library is not

  const bundle = await buildBashBundle({ cwd: tmp, entries: ['main.sh'] })
  t.assert.deepEqual([...bundle.executable], ['main.sh'])
  t.assert.deepEqual([...Bundle.parse(bundle.serialize()).executable], ['main.sh'])
}))

test('`stasis bundle --lockfile` writes the same executable list to both artifacts', posixOnly, withTmp('exec-cmd')(async (t, tmp) => {
  const src = join(tmp, 'src')
  mkdirSync(src)
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  writeFileSync(join(src, 'cli.mjs'), "#!/usr/bin/env node\nimport './lib.mjs'\n")
  writeFileSync(join(src, 'lib.mjs'), 'export const x = 1\n')
  chmodSync(join(src, 'cli.mjs'), 0o755)

  await bundleCommand({
    cwd: src,
    entries: ['cli.mjs'],
    output: join(tmp, 'out.br'),
    lockfile: join(tmp, 'out.lock.json'),
  })
  const bundle = decode(join(tmp, 'out.br'))
  const lock = Lockfile.parse(readFileSync(join(tmp, 'out.lock.json'), 'utf8'))
  t.assert.deepEqual([...bundle.executable], ['cli.mjs'])
  t.assert.deepEqual([...lock.executable], ['cli.mjs'])
  // Every listed file is one the artifacts actually carry (the parses above already enforce it).
  for (const file of bundle.executable) t.assert.ok(bundle.sources.has(file), `${file} is carried`)
}))

test('bundleFromLockfile carries the lockfile executable list into the rebuilt bundle', posixOnly, withTmp('exec-from-lock')((t, tmp) => {
  seedProject(tmp)
  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  state.write()

  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual([...bundleFromLockfile(lock, { root: tmp }).executable], ['run.sh'])
}))

// ── stasis add ───────────────────────────────────────────────────────────────

test('`stasis add` records the execute bit into the bundle and the companion lockfile', posixOnly, withTmp('exec-add')((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ bundleFile: 'code.br' }))
  writeFileSync(join(tmp, 'run.sh'), '#!/bin/sh\n')
  writeFileSync(join(tmp, 'lib.sh'), '#!/bin/sh\n')
  chmodSync(join(tmp, 'run.sh'), 0o755)
  // An existing lockfile is updated in place by `add`.
  writeFileSync(join(tmp, 'stasis.lock.json'), new Lockfile({
    config: { scope: 'full' }, entries: new Set(), modules: new Map(), imports: new Map(), formats: new Map(),
  }).serialize())

  addCommand({ cwd: tmp, entries: ['run.sh', 'lib.sh'] })

  t.assert.deepEqual([...decode(join(tmp, 'code.br')).executable], ['run.sh'])
  t.assert.deepEqual([...Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).executable], ['run.sh'])
}))

test('a `stasis add` re-run clears a bit the file lost on disk', posixOnly, withTmp('exec-add-clear')((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ bundleFile: 'code.br' }))
  writeFileSync(join(tmp, 'run.sh'), '#!/bin/sh\n')
  chmodSync(join(tmp, 'run.sh'), 0o755)
  writeFileSync(join(tmp, 'stasis.lock.json'), new Lockfile({
    config: { scope: 'full' }, entries: new Set(), modules: new Map(), imports: new Map(), formats: new Map(),
  }).serialize())

  addCommand({ cwd: tmp, entries: ['run.sh'] })
  t.assert.deepEqual([...decode(join(tmp, 'code.br')).executable], ['run.sh'])

  // Bytes unchanged, so the merge into the on-disk artifact raises no conflict -- the stale bit has
  // to lose to the fresh observation, or `add` could only ever grant +x and never revoke it.
  chmodSync(join(tmp, 'run.sh'), 0o644)
  addCommand({ cwd: tmp, entries: ['run.sh'] })
  t.assert.deepEqual([...decode(join(tmp, 'code.br')).executable], [])
  t.assert.deepEqual([...Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).executable], [])
}))

// ── diff ─────────────────────────────────────────────────────────────────────

test('stasis diff reports an execute-bit change between otherwise identical artifacts', (t) => {
  const lock = (executable) => new Lockfile({
    config: { scope: 'full' },
    entries: new Set(),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'run.sh': 'sha512-x' } }]]),
    imports: new Map(),
    formats: new Map([['run.sh', 'shell']]),
    executable: new Set(executable),
  })
  const diff = diffArtifacts({ artifact: lock([]), kind: 'lockfile' }, { artifact: lock(['run.sh']), kind: 'lockfile' })
  // Every digest matches, so without the executable facet this reads as "no differences" -- yet the
  // two artifacts extract to trees that differ in whether run.sh is runnable.
  t.assert.deepEqual(diff.files, { added: [], removed: [], differing: [] })
  t.assert.deepEqual(diff.executable, { added: ['run.sh'], removed: [] })
  t.assert.ok(hasDifferences(diff))
  t.assert.match(formatDiffStat(diff), /Executable: 1 added, 0 removed/u)

  const reverse = diffArtifacts({ artifact: lock(['run.sh']), kind: 'lockfile' }, { artifact: lock([]), kind: 'lockfile' })
  t.assert.deepEqual(reverse.executable, { added: [], removed: ['run.sh'] })
  t.assert.ok(hasDifferences(reverse))

  // Identical artifacts stay clean, and the section is omitted rather than printing a zero row.
  const same = diffArtifacts({ artifact: lock(['run.sh']), kind: 'lockfile' }, { artifact: lock(['run.sh']), kind: 'lockfile' })
  t.assert.ok(!hasDifferences(same))
  t.assert.doesNotMatch(formatDiffStat(same), /Executable:/u)
})

// ── extract ──────────────────────────────────────────────────────────────────

test('extract chmods the files the bundle marks executable and leaves the rest alone', posixOnly, withTmp('exec-extract')(async (t, tmp) => {
  const src = join(tmp, 'src')
  mkdirSync(src)
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'scripts', version: '1.0.0' }))
  writeFileSync(join(src, 'main.sh'), '#!/bin/bash\nsource ./lib.sh\n')
  writeFileSync(join(src, 'lib.sh'), '#!/bin/bash\necho lib\n')
  chmodSync(join(src, 'main.sh'), 0o755)

  const bundlePath = join(tmp, 'out.br')
  await bundleCommand({ cwd: src, entries: ['main.sh'], output: bundlePath })

  const out = join(tmp, 'out')
  const result = extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.equal(result.executable, 1)

  t.assert.ok(isExec(join(out, 'main.sh')), 'the executable script comes back runnable')
  t.assert.ok(!isExec(join(out, 'lib.sh')), 'a plain file is not made executable')
  // Contents are untouched by the chmod.
  t.assert.equal(readFileSync(join(out, 'main.sh'), 'utf8'), readFileSync(join(src, 'main.sh'), 'utf8'))
  // Read/write bits come from the write (umask-derived for a fresh file); extract adds execute
  // wherever the file is readable. Asserted as concrete octals so a hard-coded 0o755 would fail
  // under a non-default umask -- `mode & 0o111 === (mode & 0o444) >> 2` would NOT catch that.
  const plain = 0o666 & ~process.umask()
  t.assert.equal(perms(join(out, 'lib.sh')), plain)
  t.assert.equal(perms(join(out, 'main.sh')), plain | ((plain & 0o444) >> 2) | 0o100)

  // The derived lockfile beside the tree agrees with the bundle.
  const lock = Lockfile.parse(readFileSync(join(out, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual([...lock.executable], ['main.sh'])
  t.assert.deepEqual([...lockfileFromBundle(decode(bundlePath)).executable], ['main.sh'])
}))

test('extract of a bundle with nothing executable chmods nothing', posixOnly, withTmp('exec-extract-none')(async (t, tmp) => {
  const src = join(tmp, 'src')
  mkdirSync(src)
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'scripts', version: '1.0.0' }))
  writeFileSync(join(src, 'main.sh'), '#!/bin/bash\necho hi\n')

  const bundlePath = join(tmp, 'out.br')
  await bundleCommand({ cwd: src, entries: ['main.sh'], output: bundlePath })
  t.assert.deepEqual([...decode(bundlePath).executable], [])

  const out = join(tmp, 'out')
  t.assert.equal(extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out }).executable, 0)
  t.assert.ok(!isExec(join(out, 'main.sh')))
}))

// Extract is authoritative over the modes of the files it writes, so re-extracting over an older
// tree brings it back in line with the artifact instead of leaving whatever was there.
test('extract into a non-empty directory clears a stale execute bit', posixOnly, withTmp('exec-extract-stale')((t, tmp) => {
  const out = join(tmp, 'out')
  mkdirSync(out)
  writeFileSync(join(out, 'lib.sh'), 'stale\n')
  chmodSync(join(out, 'lib.sh'), 0o755) // an earlier extract, when the bundle still marked it executable

  const bundlePath = join(tmp, 'b.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0.0', files: { 'lib.sh': '#!/bin/sh\n' } } },
    modules: {},
    formats: { 'lib.sh': 'shell' },
    imports: {},
  })))
  extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.ok(!isExec(join(out, 'lib.sh')), 'the bundle no longer attests the bit, so the tree loses it')
  t.assert.equal(perms(join(out, 'lib.sh')), 0o666 & ~process.umask() & 0o777)
}))

// extract attests only executability, so it must not touch read/write bits. Regression: normalizing
// the whole mode turned a deliberately restricted pre-existing target into a world-readable one.
test('extract leaves the read/write bits of a restricted pre-existing file alone', posixOnly, withTmp('exec-nowiden')((t, tmp) => {
  const out = join(tmp, 'out')
  mkdirSync(out)
  writeFileSync(join(out, 'secret.json'), '{"old":1}')
  chmodSync(join(out, 'secret.json'), 0o600) // owner-only, e.g. it holds a token

  const bundlePath = join(tmp, 'b.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0.0', files: { 'secret.json': '{"new":1}' } } },
    modules: {},
    formats: { 'secret.json': 'json' },
    imports: {},
  })))
  extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.equal(readFileSync(join(out, 'secret.json'), 'utf8'), '{"new":1}', 'content is replaced')
  t.assert.equal(perms(join(out, 'secret.json')), 0o600, 'but the mode is not widened')
}))

// A v0 bundle attests nothing about modes, so there is no list to honour and clearing execute bits
// off the tree would destroy information rather than restore it.
test('extract leaves modes untouched for a legacy v0 bundle', posixOnly, withTmp('exec-v0-modes')((t, tmp) => {
  const out = join(tmp, 'out')
  mkdirSync(out)
  writeFileSync(join(out, 'run.sh'), 'old\n')
  chmodSync(join(out, 'run.sh'), 0o755)

  const bundlePath = join(tmp, 'v0.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 0, config: { scope: 'full' }, sources: { 'run.sh': '#!/bin/sh\n' }, formats: {}, imports: {},
  })))
  extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.equal(perms(join(out, 'run.sh')), 0o755)
}))

// The write deliberately follows a symlink inside outDir (a pnpm node_modules), but granting +x to
// a link's target would let an untrusted bundle make a file OUTSIDE the tree runnable, which an
// overwrite alone cannot do.
test('extract never chmods through a symlink', posixOnly, withTmp('exec-symlink')((t, tmp) => {
  const out = join(tmp, 'out')
  mkdirSync(out)
  mkdirSync(join(tmp, 'elsewhere'))
  const victim = join(tmp, 'elsewhere', 'cron.sh')
  writeFileSync(victim, 'benign data\n')
  chmodSync(victim, 0o644)
  symlinkSync(victim, join(out, 'hook.sh'))

  const bundlePath = join(tmp, 'b.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 1,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '1.0.0', files: { 'hook.sh': '#!/bin/sh\nid\n' } } },
    modules: {},
    formats: { 'hook.sh': 'shell' },
    imports: {},
    executable: ['hook.sh'],
  })))
  extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.equal(perms(victim), 0o644, 'the link target is not made executable')
}))

// A v0 bundle carries no per-file `formats`, so the directory/stat guards that make an `executable`
// entry trustworthy can't run -- and extract is the untrusted-input path. The list is ignored.
test('extract ignores an `executable` list on a legacy v0 bundle', posixOnly, withTmp('exec-v0-exec')((t, tmp) => {
  const bundlePath = join(tmp, 'v0.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    sources: { 'run.sh': '#!/bin/sh\n' },
    formats: {},
    imports: {},
    executable: ['run.sh'],
  })))
  t.assert.deepEqual([...decode(bundlePath).executable], [])
  const out = join(tmp, 'out')
  t.assert.equal(extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out }).executable, 0)
  t.assert.ok(!isExec(join(out, 'run.sh')))
}))

test('extract of a legacy v0 bundle (no executable list) still writes its sources', posixOnly, withTmp('exec-extract-v0')((t, tmp) => {
  const bundlePath = join(tmp, 'v0.br')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    sources: { 'run.sh': '#!/bin/sh\n' },
    formats: {},
    imports: {},
  })))
  const out = join(tmp, 'out')
  const result = extractCommand({ cwd: tmp, bundleFile: bundlePath, output: out })
  t.assert.equal(result.files, 1)
  t.assert.equal(result.executable, 0)
  t.assert.ok(!isExec(join(out, 'run.sh')))
}))
