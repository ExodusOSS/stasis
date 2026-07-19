import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { buildShallowBundle, shallowBundleCommand } from '@exodus/stasis-core/bundle-cmd'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const stasisCli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')

const cleanEnv = (() => {
  const { EXODUS_STASIS_LOCK: _l, EXODUS_STASIS_SCOPE: _s, EXODUS_STASIS_BUNDLE: _b, EXODUS_STASIS_BUNDLE_FILE: _bf, EXODUS_STASIS_DEBUG: _d, ...rest } = process.env
  return rest
})()

const runCli = (cli, args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-shallow-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A small project: an ESM workspace with one node_modules dep and a couple of assets.
const seed = (tmp, { type = 'module' } = {}) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.2.3', ...(type ? { type } : {}) }))
  mkdirSync(join(tmp, 'src'), { recursive: true })
  mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(tmp, 'src', 'b.cjs'), 'module.exports = 2\n')
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg/>\n')
  writeFileSync(join(tmp, 'src', 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '4.5.6' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), 'module.exports = 3\n')
}

const decode = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))

// --- buildShallowBundle ------------------------------------------------------

test('buildShallowBundle packs exactly the listed files, inferring format from the path', withTmp(async (t, tmp) => {
  seed(tmp)
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['src/a.js', 'src/b.cjs', 'src/icon.svg'] })
  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual(bundle.config, { scope: 'full' })

  // Only the listed files, nothing walked in.
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs', 'src/icon.svg'])
  // Formats from extension + package.json type; nothing resolved -> empty imports.
  t.assert.equal(bundle.formats.get('src/a.js'), 'module') // package "type": "module"
  t.assert.equal(bundle.formats.get('src/b.cjs'), 'commonjs')
  t.assert.equal(bundle.formats.get('src/icon.svg'), 'resource')
  t.assert.equal(bundle.imports.size, 0)
  // Every non-resource file is its own entry; the resource is not.
  t.assert.deepEqual([...bundle.entries].toSorted(), ['src/a.js', 'src/b.cjs'])
  // The workspace bucket takes the root package.json identity.
  t.assert.equal(bundle.modules.get('.').name, 'app')
  t.assert.equal(bundle.modules.get('.').version, '1.2.3')
}))

test('buildShallowBundle buckets a node_modules file into its own npm package bucket', withTmp(async (t, tmp) => {
  seed(tmp)
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['src/a.js', 'node_modules/dep/index.js'] })
  t.assert.deepEqual([...bundle.modules.keys()].toSorted(), ['.', 'node_modules/dep'])
  const dep = bundle.modules.get('node_modules/dep')
  t.assert.equal(dep.name, 'dep')
  t.assert.equal(dep.version, '4.5.6')
  t.assert.equal(dep.ecosystem, 'npm')
  t.assert.deepEqual(Object.keys(dep.files), ['index.js'])
}))

test('buildShallowBundle base64-encodes a non-UTF-8 file as resource:base64', withTmp(async (t, tmp) => {
  seed(tmp)
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['src/blob.bin'] })
  t.assert.equal(bundle.formats.get('src/blob.bin'), 'resource:base64')
  t.assert.equal(bundle.modules.get('.').files['src/blob.bin'], Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]).toString('base64'))
  // Resources-only bundle: no entries.
  t.assert.equal(bundle.entries.size, 0)
}))

test('buildShallowBundle defaults a typeless-package .js/.ts to commonjs (no syntax detection)', withTmp(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' })) // no "type"
  writeFileSync(join(tmp, 'a.js'), 'export const a = 1\n') // ESM syntax, but shallow never parses
  writeFileSync(join(tmp, 'b.ts'), 'export const b: number = 2\n')
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['a.js', 'b.ts'] })
  t.assert.equal(bundle.formats.get('a.js'), 'commonjs')
  t.assert.equal(bundle.formats.get('b.ts'), 'commonjs-typescript')
}))

test('buildShallowBundle attributes files to the `bundle` consumer and dedups repeats', withTmp(async (t, tmp) => {
  seed(tmp)
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['src/a.js', 'src/a.js', 'src/b.cjs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual(bundle.reason, { bundle: ['src/a.js', 'src/b.cjs'] })
}))

test('buildShallowBundle round-trips through Bundle.parse', withTmp(async (t, tmp) => {
  seed(tmp)
  const bundle = buildShallowBundle({ cwd: tmp, entries: ['src/a.js', 'src/icon.svg', 'node_modules/dep/index.js'] })
  const reparsed = Bundle.parse(bundle.serialize())
  t.assert.deepEqual([...reparsed.entries].toSorted(), ['node_modules/dep/index.js', 'src/a.js'])
  t.assert.equal(reparsed.sources.get('src/icon.svg'), '<svg/>\n')
}))

test('buildShallowBundle rejects an empty list, a missing file, and an escaping path', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.throws(() => buildShallowBundle({ cwd: tmp, entries: [] }), /at least one file/)
  t.assert.throws(() => buildShallowBundle({ cwd: tmp, entries: ['src/nope.js'] }), /file not found: src\/nope\.js/)
  t.assert.throws(() => buildShallowBundle({ cwd: tmp, entries: ['../outside.js'] }), /Entry escapes baseDir/)
}))

test('buildShallowBundle refuses a symlink whose target escapes the project root', withTmp(async (t, tmp) => {
  seed(tmp)
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'secret.js'), 'export const s = 1\n')
    symlinkSync(join(outside, 'secret.js'), join(tmp, 'link.js'))
    t.assert.throws(() => buildShallowBundle({ cwd: tmp, entries: ['link.js'] }), /symlink escaping bundle root/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

// --- shallowBundleCommand ----------------------------------------------------

test('shallowBundleCommand writes a brotli bundle that round-trips', withTmp(async (t, tmp) => {
  seed(tmp)
  const out = join(tmp, 'out.br')
  shallowBundleCommand({ cwd: tmp, entries: ['src/a.js', 'src/b.cjs'], output: out })
  const buf = readFileSync(out)
  t.assert.notEqual(buf[0], 0x7b, 'must be brotli, not JSON')
  const parsed = decode(out)
  t.assert.deepEqual(Object.keys(parsed.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
}))

test('shallowBundleCommand --add merges into the existing bundle', withTmp(async (t, tmp) => {
  seed(tmp)
  const out = join(tmp, 'out.br')
  shallowBundleCommand({ cwd: tmp, entries: ['src/a.js'], output: out })
  shallowBundleCommand({ cwd: tmp, entries: ['src/b.cjs'], output: out, add: true })
  const parsed = decode(out)
  t.assert.deepEqual(Object.keys(parsed.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual([...parsed.entries].toSorted(), ['src/a.js', 'src/b.cjs'])
}))

test('shallowBundleCommand --add cannot target stdout', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.throws(
    () => shallowBundleCommand({ cwd: tmp, entries: ['src/a.js'], output: '-', add: true }),
    /--add cannot be combined with --output=-/,
  )
}))

test('a shallow bundle --adds into a deep bundle without conflict (matching formats)', withTmp(async (t, tmp) => {
  // Deep bundle of entry.mjs (which imports lib.mjs) -> {entry.mjs, lib.mjs}.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'entry.mjs'), "import { l } from './lib.mjs'\nexport const e = l\n")
  writeFileSync(join(tmp, 'lib.mjs'), 'export const l = 1\n')
  writeFileSync(join(tmp, 'extra.mjs'), 'export const x = 2\n')
  const out = join(tmp, 'out.br')
  await bundleCommand({ cwd: tmp, entries: ['entry.mjs'], output: out })

  // Shallow --add re-packs entry.mjs + lib.mjs (overlapping, identical bytes + format
  // 'module') plus a new extra.mjs. The overlap must not conflict.
  shallowBundleCommand({ cwd: tmp, entries: ['entry.mjs', 'lib.mjs', 'extra.mjs'], output: out, add: true })
  const parsed = decode(out)
  t.assert.deepEqual(Object.keys(parsed.modules.get('.').files).toSorted(), ['entry.mjs', 'extra.mjs', 'lib.mjs'])
  // The deep import edge from the original bundle survives the merge.
  t.assert.equal(parsed.imports.get('*').get('entry.mjs').get('./lib.mjs'), 'lib.mjs')
}))

// --- CLI: stasis-core --------------------------------------------------------

test('CLI (stasis-core): bundle --shallow packs the listed files', withTmp(async (t, tmp) => {
  seed(tmp)
  const out = join(tmp, 'out.br')
  const r = runCli(coreCli, ['bundle', '--shallow', '-o', out, 'src/a.js', 'src/icon.svg'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis-core\] Bundled 2 files in 1 package to .* \(shallow\)/)
  t.assert.deepEqual(Object.keys(decode(out).modules.get('.').files).toSorted(), ['src/a.js', 'src/icon.svg'])
}))

test('CLI (stasis-core): bundle without --shallow is refused', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(coreCli, ['bundle', 'src/a.js'], { cwd: tmp })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /only supports --shallow/)
}))

test('CLI (stasis-core): bundle --shallow --add reports the added count', withTmp(async (t, tmp) => {
  seed(tmp)
  const out = join(tmp, 'out.br')
  t.assert.equal(runCli(coreCli, ['bundle', '--shallow', '-o', out, 'src/a.js'], { cwd: tmp }).status, 0)
  const r = runCli(coreCli, ['bundle', '--shallow', '--add', '-o', out, 'src/b.cjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis-core\] Added 1 file \(2 total in 1 package\) to .* \(shallow\)/)
}))

// --- CLI: stasis -------------------------------------------------------------

test('CLI (stasis): bundle --shallow packs the listed files (any mix, no language check)', withTmp(async (t, tmp) => {
  seed(tmp)
  const out = join(tmp, 'out.br')
  // A .js and a .cjs together would be rejected by the deep bundler's one-language rule;
  // shallow just packs them.
  const r = runCli(stasisCli, ['bundle', '--shallow', '-o', out, 'src/a.js', 'src/b.cjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Bundled 2 files in 1 package to .* \(shallow\)/)
  t.assert.deepEqual(Object.keys(decode(out).modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
}))

test('CLI (stasis): bundle --shallow rejects the deep-only resolution knobs', withTmp(async (t, tmp) => {
  seed(tmp)
  for (const flag of [['--scope=full'], ['--conditions=react-native'], ['--mainFields=main'], ['--metro', '--platforms=ios'], ['--lockfile=x.json'], ['--mapping=r.txt']]) {
    const r = runCli(stasisCli, ['bundle', '--shallow', ...flag, 'src/a.js'], { cwd: tmp })
    t.assert.equal(r.status, 1, `${flag.join(' ')} should be rejected`)
    t.assert.match(r.stderr, /not supported with --shallow/)
  }
}))
