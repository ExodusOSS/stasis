import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const isExec = (path) => (statSync(path).mode & 0o111) !== 0
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
})

// ── merge ────────────────────────────────────────────────────────────────────

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

test('State records the execute bit of a captured file into both the bundle and the lockfile', withTmp('exec-state')((t, tmp) => {
  seedProject(tmp)
  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  state.addFile(pathToFileURL(join(tmp, 'plain.cjs')).toString(), { format: 'commonjs', isEntry: true })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell' })

  t.assert.deepEqual([...state.executable], ['run.sh'])
  t.assert.deepEqual([...state.sourceBundle.executable], ['run.sh'])
  t.assert.deepEqual(JSON.parse(state.lockData).executable, ['run.sh'])
}))

test('State drops a stale execute bit once the file loses it on disk', withTmp('exec-restat')((t, tmp) => {
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

test('a bundle=load State serves the executable list it absorbed', withTmp('exec-load')((t, tmp) => {
  seedProject(tmp)
  const cap = new State(tmp, { scope: 'full', bundle: 'add' })
  cap.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  cap.write()

  // bundle=load can't compose with a writing lock mode, so read the lockfile frozen alongside it.
  const load = new State(tmp, { scope: 'full', bundle: 'load', lock: 'frozen' })
  t.assert.deepEqual([...load.executable], ['run.sh'])
}))

test('a split bundle layout lists only its own executables in each half', withTmp('exec-split')((t, tmp) => {
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

test('a `directory` capture is never listed executable', withTmp('exec-dir')((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 1\n')
  // Directories carry the execute bit as "searchable" -- it must not leak into the list.
  chmodSync(join(tmp, 'src'), 0o755)

  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  state.addFsDir(pathToFileURL(join(tmp, 'src')).toString(), ['a.js'])
  t.assert.equal(state.formats.get('src'), 'directory')
  t.assert.deepEqual([...state.executable], [])
  t.assert.deepEqual([...state.sourceBundle.executable], [])
}))

// ── static builders ──────────────────────────────────────────────────────────

test('the bash bundler records the execute bit of every script it walks', withTmp('exec-bash')(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'scripts', version: '1.0.0' }))
  writeFileSync(join(tmp, 'main.sh'), '#!/bin/bash\nsource ./lib.sh\n')
  writeFileSync(join(tmp, 'lib.sh'), '#!/bin/bash\necho lib\n')
  chmodSync(join(tmp, 'main.sh'), 0o755) // the entry is runnable, the sourced library is not

  const bundle = await buildBashBundle({ cwd: tmp, entries: ['main.sh'] })
  t.assert.deepEqual([...bundle.executable], ['main.sh'])
  t.assert.deepEqual([...Bundle.parse(bundle.serialize()).executable], ['main.sh'])
}))

test('`stasis bundle --lockfile` writes the same executable list to both artifacts', withTmp('exec-cmd')(async (t, tmp) => {
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

test('bundleFromLockfile carries the lockfile executable list into the rebuilt bundle', withTmp('exec-from-lock')((t, tmp) => {
  seedProject(tmp)
  const state = new State(tmp, { scope: 'full', bundle: 'add' })
  state.addFile(pathToFileURL(join(tmp, 'run.sh')).toString(), { format: 'shell', isEntry: true })
  state.write()

  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual([...bundleFromLockfile(lock, { root: tmp }).executable], ['run.sh'])
}))

// ── stasis add ───────────────────────────────────────────────────────────────

test('`stasis add` records the execute bit into the bundle and the companion lockfile', withTmp('exec-add')((t, tmp) => {
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

// ── extract ──────────────────────────────────────────────────────────────────

test('extract chmods the files the bundle marks executable and leaves the rest alone', withTmp('exec-extract')(async (t, tmp) => {
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
  // The restored mode follows the umask (execute added where readable), not a hard-coded 0o755.
  const { mode } = statSync(join(out, 'main.sh'))
  t.assert.equal(mode & 0o111, (mode & 0o444) >> 2)

  // The derived lockfile beside the tree agrees with the bundle.
  const lock = Lockfile.parse(readFileSync(join(out, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual([...lock.executable], ['main.sh'])
  t.assert.deepEqual([...lockfileFromBundle(decode(bundlePath)).executable], ['main.sh'])
}))

test('extract of a bundle with nothing executable chmods nothing', withTmp('exec-extract-none')(async (t, tmp) => {
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

test('extract of a legacy v0 bundle (no executable list) still writes its sources', withTmp('exec-extract-v0')((t, tmp) => {
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
