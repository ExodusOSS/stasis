import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { buildSolidityBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'
import { extractCommand, lockfileFromBundle } from '../stasis/src/cmd/extract.js'
import { prune } from '@exodus/stasis-core/prune'
import { sha512integrity } from '@exodus/stasis-core/state.util'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures')
const solFixtures = join(fixtures, 'solidity-bundle')

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-extract-cmd-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cleanEnv = (() => {
  const {
    EXODUS_STASIS_LOCK: _l,
    EXODUS_STASIS_SCOPE: _s,
    EXODUS_STASIS_BUNDLE: _b,
    EXODUS_STASIS_BUNDLE_FILE: _bf,
    EXODUS_STASIS_DEBUG: _d,
    ...rest
  } = process.env
  return rest
})()

const runCli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// Build a real brotli code bundle at `out` from the given fixture + entries.
// Uses the Solidity bundler (no JS scan involved).
const buildBundle = async (cwd, entries, out, extra = {}) => {
  await bundleCommand({ cwd, entries, output: out, ...extra })
  return Bundle.parseCode(brotliDecompressSync(readFileSync(out)).toString('utf8'))
}

// Hand-craft an on-disk bundle from raw JSON, bypassing Bundle.serializeCode --
// for malformed/adversarial shapes a real builder would never produce.
const writeRawBundle = (path, json) => writeFileSync(path, brotliCompressSync(JSON.stringify(json)))

test('lockfileFromBundle hashes every source and carries entries/config/metadata across', async (t) => {
  const bundle = await buildSolidityBundle({ cwd: join(solFixtures, 'basic'), entries: ['src/A.sol'] })
  const lock = lockfileFromBundle(bundle)
  t.assert.ok(lock instanceof Lockfile)
  t.assert.deepEqual(lock.config, bundle.config)
  t.assert.deepEqual([...lock.entries], [...bundle.entries])

  // Same bucket dirs, and each file's recorded value is the SRI digest of the
  // bundle's source bytes (not the bytes themselves).
  t.assert.deepEqual([...lock.modules.keys()].toSorted(), [...bundle.modules.keys()].toSorted())
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      t.assert.equal(lock.modules.get(dir).files[rel], sha512integrity(content))
    }
  }
})

test('extractCommand writes every bundled source to disk with byte-for-byte fidelity', withTmp(async (t, tmp) => {
  const bundlePath = join(tmp, 'out.code.br')
  const bundle = await buildBundle(join(solFixtures, 'basic'), ['src/A.sol'], bundlePath)

  const outDir = join(tmp, 'extracted')
  const { dir, files } = extractCommand({ bundleFile: bundlePath, output: outDir })

  t.assert.equal(dir, outDir)
  t.assert.equal(files, bundle.sources.size)
  for (const [file, content] of bundle.sources) {
    t.assert.equal(readFileSync(join(outDir, file), 'utf8'), content)
  }
}))

test('extractCommand writes a stasis.lock.json that is consistent with the extracted files', withTmp(async (t, tmp) => {
  const bundlePath = join(tmp, 'out.code.br')
  const bundle = await buildBundle(join(solFixtures, 'basic'), ['src/A.sol'], bundlePath)

  const outDir = join(tmp, 'extracted')
  extractCommand({ bundleFile: bundlePath, output: outDir })

  const lockPath = join(outDir, 'stasis.lock.json')
  t.assert.ok(existsSync(lockPath), 'lockfile must be written into the output dir')
  const lock = Lockfile.parse(readFileSync(lockPath, 'utf8'))

  t.assert.deepEqual([...lock.entries].toSorted(), [...bundle.entries].toSorted())
  // Every hash in the lockfile matches the on-disk file we just extracted.
  for (const [dir, { files }] of lock.modules) {
    for (const [rel, hash] of Object.entries(files)) {
      const file = dir === '.' ? rel : `${dir}/${rel}`
      t.assert.equal(hash, sha512integrity(readFileSync(join(outDir, file))))
    }
  }
  // The bundle's resolution + format maps are carried across, so the derived
  // lockfile attests resolutions and formats, not just bytes.
  t.assert.deepEqual(lock.imports, bundle.imports)
  t.assert.ok(lock.imports.size > 0, 'fixture bundle must have resolution edges to make this meaningful')
  t.assert.deepEqual(lock.formats, bundle.formats)
  t.assert.ok(lock.formats.size > 0, 'fixture bundle must have formats to make this meaningful')
}))

test('extractCommand round-trips a scope=full bundle with workspace sources + node_modules buckets', withTmp(async (t, tmp) => {
  const cwd = join(solFixtures, 'with-node-modules')
  const bundlePath = join(tmp, 'nm.code.br')
  const bundle = await buildBundle(cwd, ['src/A.sol'], bundlePath, { mappingFile: 'remappings.txt' })

  const outDir = join(tmp, 'extracted')
  const { files } = extractCommand({ bundleFile: bundlePath, output: outDir })

  // Workspace source + both dependency files land at their project-relative paths.
  t.assert.equal(files, bundle.sources.size)
  for (const [file, content] of bundle.sources) {
    t.assert.equal(readFileSync(join(outDir, file), 'utf8'), content)
  }

  // node_modules buckets carry their package identity through to the lockfile.
  const lock = Lockfile.parse(readFileSync(join(outDir, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual([...lock.entries], ['src/A.sol'])
  t.assert.equal(lock.modules.get('node_modules/foo')?.name, 'foo')
  t.assert.equal(lock.modules.get('node_modules/foo')?.version, '1.2.3')
  t.assert.equal(lock.modules.get('node_modules/@oz/contracts')?.name, '@oz/contracts')
  t.assert.equal(lock.modules.get('node_modules/@oz/contracts')?.version, '5.0.0')
}))

test('an extracted tree validates cleanly under stasis prune', withTmp(async (t, tmp) => {
  const cwd = join(solFixtures, 'with-node-modules')
  const bundlePath = join(tmp, 'nm.code.br')
  await buildBundle(cwd, ['src/A.sol'], bundlePath, { mappingFile: 'remappings.txt' })

  const outDir = join(tmp, 'extracted')
  extractCommand({ bundleFile: bundlePath, output: outDir })

  // prune is a separate code path: it reads the extracted lockfile and re-hashes
  // the extracted node_modules files from disk. A consistent extract validates
  // every dependency file and removes none.
  const { removed, validated } = prune({ root: outDir })
  t.assert.deepEqual(removed, [])
  t.assert.deepEqual(
    validated.toSorted(),
    ['node_modules/@oz/contracts/utils/Math.sol', 'node_modules/foo/X.sol'],
  )
}))

test('extractCommand defaults the output dir to cwd', withTmp(async (t, tmp) => {
  const bundlePath = join(tmp, 'out.code.br')
  await buildBundle(join(solFixtures, 'basic'), ['src/A.sol'], bundlePath)

  const { dir } = extractCommand({ cwd: tmp, bundleFile: bundlePath })
  t.assert.equal(dir, tmp)
  t.assert.ok(existsSync(join(tmp, 'src', 'A.sol')))
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
}))

test('extractCommand throws when the bundle file does not exist', withTmp((t, tmp) => {
  t.assert.throws(
    () => extractCommand({ bundleFile: join(tmp, 'nope.code.br'), output: tmp }),
    /bundle file not found/,
  )
}))

test('extractCommand refuses a bundle whose path escapes the output dir', withTmp((t, tmp) => {
  // Hand-craft a v1 code bundle whose source bucket dir climbs out of the
  // output dir via mid-path "..". Bundle.parseCode only rejects paths that
  // *start* with "..", so this passes parsing; extract must catch it.
  const evil = {
    version: 1,
    config: { scope: 'full' },
    entries: ['evil.js'],
    sources: {
      'x/../../../../../../../../tmp-stasis-escape': {
        name: 'evil',
        version: '0.0.0',
        files: { 'pwned.js': 'boom\n' },
      },
    },
    modules: {},
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'evil.code.br')
  writeRawBundle(bundlePath, evil)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /escapes output dir/,
  )
  t.assert.ok(!existsSync('/tmp-stasis-escape/pwned.js'), 'must not write outside the output dir')
}))

test('extractCommand rejects a sibling dir that merely shares the output dir name as a prefix', withTmp((t, tmp) => {
  // Resolves to `<tmp>/out-evil/pwned.js`, a sibling of the `<tmp>/out` output
  // dir. A naive `startsWith(outDir)` (no separator) would wrongly accept it;
  // the containment check requires the trailing separator (and a non-'..'
  // relative path) to reject it.
  const evil = {
    version: 1,
    config: { scope: 'full' },
    entries: ['evil.js'],
    sources: {
      'z/../../out-evil': { name: 'evil', version: '0.0.0', files: { 'pwned.js': 'boom\n' } },
    },
    modules: {},
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'evil.code.br')
  writeRawBundle(bundlePath, evil)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /escapes output dir/,
  )
  t.assert.ok(!existsSync(join(tmp, 'out-evil', 'pwned.js')), 'must not write into a sibling dir')
}))

test('extractCommand extracts a legacy v0 bundle but skips the lockfile', withTmp((t, tmp) => {
  // v0 buckets carry no package name/version; a lockfile must attest both for
  // every node_modules bucket, so none can be restored. The sources are still
  // extracted. (Deriving one used to crash inside Lockfile.serialize with an
  // empty error message.)
  const v0 = {
    version: 0,
    config: { scope: 'full' },
    sources: { 'src/a.js': 'x\n', 'node_modules/foo/index.js': 'y\n' },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'v0.code.br')
  writeRawBundle(bundlePath, v0)
  const outDir = join(tmp, 'out')
  const { files } = extractCommand({ bundleFile: bundlePath, output: outDir })
  t.assert.equal(files, 2)
  t.assert.equal(readFileSync(join(outDir, 'src/a.js'), 'utf8'), 'x\n')
  t.assert.equal(readFileSync(join(outDir, 'node_modules/foo/index.js'), 'utf8'), 'y\n')
  t.assert.ok(!existsSync(join(outDir, 'stasis.lock.json')), 'no lockfile may be written for a v0 bundle')
}))

test('CLI: extract on a v0 bundle warns that the lockfile was not written', withTmp((t, tmp) => {
  const v0 = {
    version: 0,
    config: { scope: 'full' },
    sources: { 'src/a.js': 'x\n' },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'v0.code.br')
  writeRawBundle(bundlePath, v0)
  const outDir = join(tmp, 'out')
  const r = runCli(['extract', '-o', outDir, bundlePath])
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Extracted 1 file\(s\) to /)
  t.assert.match(r.stderr, /legacy v0 bundle records no package name\/version, so stasis\.lock\.json can not be restored/)
  t.assert.ok(!existsSync(join(outDir, 'stasis.lock.json')))
}))

test('extractCommand extracts a scope=node_modules bundle and its lockfile validates under prune', withTmp((t, tmp) => {
  // node_modules-scope bundles carry no entries/sources blocks; the derived
  // lockfile must omit them too (Lockfile.serialize branches on scope).
  const nm = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.2.3', files: { 'index.js': 'module.exports = 1\n' } },
    },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'nm.code.br')
  writeRawBundle(bundlePath, nm)
  const outDir = join(tmp, 'out')
  const { files } = extractCommand({ bundleFile: bundlePath, output: outDir })
  t.assert.equal(files, 1)
  t.assert.equal(readFileSync(join(outDir, 'node_modules/foo/index.js'), 'utf8'), 'module.exports = 1\n')

  const lockJson = JSON.parse(readFileSync(join(outDir, 'stasis.lock.json'), 'utf8'))
  t.assert.ok(!('entries' in lockJson) && !('sources' in lockJson), 'node_modules scope must omit entries/sources')
  const lock = Lockfile.parse(JSON.stringify(lockJson))
  t.assert.equal(lock.modules.get('node_modules/foo')?.version, '1.2.3')

  const { removed, validated } = prune({ root: outDir })
  t.assert.deepEqual(removed, [])
  t.assert.deepEqual(validated, ['node_modules/foo/index.js'])
}))

test('extractCommand extracts an empty bundle to just a lockfile', withTmp((t, tmp) => {
  const empty = { version: 1, config: { scope: 'node_modules' }, modules: {}, formats: {}, imports: {} }
  const bundlePath = join(tmp, 'empty.code.br')
  writeRawBundle(bundlePath, empty)
  const outDir = join(tmp, 'out')
  const { files } = extractCommand({ bundleFile: bundlePath, output: outDir })
  t.assert.equal(files, 0)
  t.assert.ok(Lockfile.parse(readFileSync(join(outDir, 'stasis.lock.json'), 'utf8')) instanceof Lockfile)
}))

test('extractCommand refuses duplicate paths from overlapping buckets', withTmp((t, tmp) => {
  // Two buckets that collapse to the same project-relative path: the
  // flattening `sources` getter would silently last-win, writing one file
  // while the lockfile records two buckets with different hashes for it.
  const evil = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'bar/x.js': 'one\n' } },
      'node_modules/foo/bar': { name: 'bar', version: '1.0.0', files: { 'x.js': 'two\n' } },
    },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'dup.code.br')
  writeRawBundle(bundlePath, evil)
  const outDir = join(tmp, 'out')
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: outDir }),
    /duplicate bundle path: node_modules\/foo\/bar\/x\.js/,
  )
  t.assert.ok(!existsSync(outDir), 'nothing may be written for a refused bundle')
}))

test('extractCommand refuses a bundle path used as both file and directory', withTmp((t, tmp) => {
  // `node_modules/foo/bar` is a file in one bucket and a directory implied by
  // another bucket's file -- writing both would throw halfway through (EEXIST
  // on the mkdir), leaving a partial tree. The plan phase must reject it.
  const evil = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { bar: 'I am a file\n' } },
      'node_modules/foo/bar': { name: 'bar', version: '1.0.0', files: { 'x.js': 'nested\n' } },
    },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'conflict.code.br')
  writeRawBundle(bundlePath, evil)
  const outDir = join(tmp, 'out')
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: outDir }),
    /used as both file and directory: node_modules\/foo\/bar/,
  )
  t.assert.ok(!existsSync(outDir), 'nothing may be written for a refused bundle')
}))

test('extractCommand refuses non-canonical bundle paths (empty file name)', withTmp((t, tmp) => {
  // files: { '': ... } resolves to the bucket dir itself; writing file content
  // AT node_modules/foo would break the next write into that dir.
  const evil = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { '': 'boom\n', 'x.js': 'ok\n' } },
    },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'noncanon.code.br')
  writeRawBundle(bundlePath, evil)
  const outDir = join(tmp, 'out')
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: outDir }),
    /non-canonical bundle path/,
  )
  t.assert.ok(!existsSync(outDir), 'nothing may be written for a refused bundle')
}))

test('extractCommand refuses non-string file content', withTmp((t, tmp) => {
  const evil = {
    version: 1,
    config: { scope: 'node_modules' },
    modules: {
      'node_modules/foo': { name: 'foo', version: '1.0.0', files: { 'x.js': 42 } },
    },
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'nonstring.code.br')
  writeRawBundle(bundlePath, evil)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /content is not a string: node_modules\/foo\/x\.js/,
  )
}))

test('extractCommand refuses a bundle that contains stasis.lock.json', withTmp((t, tmp) => {
  // The bundled file would first be written, then clobbered by the derived
  // lockfile -- which itself records a hash for it that no longer matches disk.
  const evil = {
    version: 1,
    config: { scope: 'full' },
    entries: ['a.js'],
    sources: {
      '.': { name: 'app', version: '0.0.0', files: { 'a.js': 'x\n', 'stasis.lock.json': '{"fake":true}\n' } },
    },
    modules: {},
    formats: {},
    imports: {},
  }
  const bundlePath = join(tmp, 'lockclash.code.br')
  writeRawBundle(bundlePath, evil)
  const outDir = join(tmp, 'out')
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: outDir }),
    /bundle contains stasis\.lock\.json/,
  )
  t.assert.ok(!existsSync(outDir), 'nothing may be written for a refused bundle')
}))

test('extractCommand reports a clear error for a file that is not a code bundle', withTmp((t, tmp) => {
  // A resources bundle has no formats/imports; Bundle.parseCode rejects it via
  // a message-less assert, which extract must wrap with context.
  const resources = {
    version: 1,
    config: { scope: 'full' },
    sources: { '.': { name: 'app', version: '0.0.0', files: { 'asset.bin': 'AAAA' } } },
    modules: {},
  }
  const bundlePath = join(tmp, 'resources.br')
  writeRawBundle(bundlePath, resources)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /not a valid stasis code bundle/,
  )
}))

// --- CLI integration ---

test('CLI: extract with no bundle file prints usage', (t) => {
  const r = runCli(['extract'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to extract/)
})

test('CLI: extract with more than one bundle file prints usage', (t) => {
  const r = runCli(['extract', 'a.code.br', 'b.code.br'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /extract takes exactly one bundle file/)
})

test('CLI: extract writes sources + lockfile and prints a summary', withTmp(async (t, tmp) => {
  const bundlePath = join(tmp, 'out.code.br')
  await buildBundle(join(solFixtures, 'basic'), ['src/A.sol'], bundlePath)

  const outDir = join(tmp, 'extracted')
  const r = runCli(['extract', '-o', outDir, bundlePath])
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(
    r.stderr,
    new RegExp(`\\[stasis\\] Extracted 2 file\\(s\\) and stasis\\.lock\\.json to ${outDir.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
  )
  t.assert.ok(existsSync(join(outDir, 'src', 'A.sol')))
  t.assert.ok(existsSync(join(outDir, 'src', 'B.sol')))
  t.assert.ok(existsSync(join(outDir, 'stasis.lock.json')))
}))

test('CLI: extract accepts the --output= long form', withTmp(async (t, tmp) => {
  const bundlePath = join(tmp, 'out.code.br')
  await buildBundle(join(solFixtures, 'basic'), ['src/A.sol'], bundlePath)
  const outDir = join(tmp, 'extracted')
  const r = runCli(['extract', `--output=${outDir}`, bundlePath])
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.ok(existsSync(join(outDir, 'src', 'A.sol')))
  t.assert.ok(existsSync(join(outDir, 'stasis.lock.json')))
}))
