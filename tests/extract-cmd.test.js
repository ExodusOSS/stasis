import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { State } from '@exodus/stasis-core/state'
import { buildSolidityBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'
import { extractCommand, lockfileFromBundle } from '@exodus/stasis-core/extract'
import { prune } from '@exodus/stasis-core/prune'
import { sha512integrity } from '@exodus/stasis-core/state-util'

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
    EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
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
  return Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
}

// Hand-craft an on-disk bundle from raw JSON, bypassing Bundle.serialize --
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
  // output dir via mid-path "..". Bundle.parse rejects root-escaping paths at
  // the schema boundary (posixPathEscapes) since it validates dirs like
  // Lockfile.parse, so extract's wrapped parse error fires first; extract's own
  // containment check stays behind it as defense-in-depth.
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
    /not a valid stasis bundle/,
  )
  t.assert.ok(!existsSync('/tmp-stasis-escape/pwned.js'), 'must not write outside the output dir')
}))

test('extractCommand rejects a sibling dir that merely shares the output dir name as a prefix', withTmp((t, tmp) => {
  // Resolves to `<tmp>/out-evil/pwned.js`, a sibling of the `<tmp>/out` output
  // dir. The mid-path `..` needed to reach a sibling escapes the project root,
  // so Bundle.parse rejects it at the schema boundary; extract's own
  // trailing-separator containment check stays behind it as defense-in-depth.
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
    /not a valid stasis bundle/,
  )
  t.assert.ok(!existsSync(join(tmp, 'out-evil', 'pwned.js')), 'must not write into a sibling dir')
}))

test('extractCommand accepts paths whose first segment begins with ".." (a real name, not a traversal)', withTmp((t, tmp) => {
  // `..foo.js` / `..cache/x.js` are legitimate names: resolve() keeps them safely inside outDir,
  // and Bundle.parse accepts them (posixPathEscapes is `../`-aware). A bare startsWith('..')
  // containment test wrongly flagged them as escaping -- rejecting a valid bundle -- even though the
  // lexical `<outDir>/` prefix check and the canonical-path check both pass. The fix aligns extract's
  // own `..`-relative test with posixPathEscapes. Note `src/..bar.js` was never affected (the `..` is
  // not the first segment), which is exactly the asymmetry that made the bare check a bug, not a policy.
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/entry.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: {
        'src/entry.js': 'export const x = 1\n',
        '..foo.js': 'leading dotdot in a filename\n',
        '..cache/x.js': 'leading dotdot in a dir name\n',
      } }],
    ]),
    formats: new Map([
      ['src/entry.js', 'module'],
      ['..foo.js', 'resource'],
      ['..cache/x.js', 'resource'],
    ]),
    imports: new Map([['*', new Map([['src/entry.js', new Map()]])]]),
  })
  const bundlePath = join(tmp, 'dotdot.br')
  writeFileSync(bundlePath, brotliCompressSync(bundle.serialize()))

  const outDir = join(tmp, 'out')
  let res
  t.assert.doesNotThrow(() => { res = extractCommand({ bundleFile: bundlePath, output: outDir }) })
  t.assert.equal(res.files, 3)

  // The files land INSIDE outDir with byte fidelity...
  t.assert.equal(readFileSync(join(outDir, '..foo.js'), 'utf8'), 'leading dotdot in a filename\n')
  t.assert.ok(statSync(join(outDir, '..foo.js')).isFile())
  t.assert.equal(readFileSync(join(outDir, '..cache', 'x.js'), 'utf8'), 'leading dotdot in a dir name\n')
  // ...and nothing escaped to a sibling/parent of outDir.
  t.assert.ok(!existsSync(join(tmp, '..foo.js')), 'must not write above the output dir')

  // The derived lockfile records the dotdot-named files by their exact keys, hashed over the on-disk bytes.
  const lock = Lockfile.parse(readFileSync(join(outDir, 'stasis.lock.json'), 'utf8'))
  t.assert.equal(lock.modules.get('.').files['..foo.js'], sha512integrity(readFileSync(join(outDir, '..foo.js'))))
  t.assert.equal(lock.modules.get('.').files['..cache/x.js'], sha512integrity(readFileSync(join(outDir, '..cache', 'x.js'))))
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
  // Two buckets that collapse to the same project-relative path: the flattening `sources` getter
  // would silently last-win, writing one file while the lockfile records two buckets with different
  // hashes for it. Bundle.parse now rejects the collision at the schema boundary (protecting every
  // consumer, not just extract), so extractCommand surfaces it as an invalid-bundle parse failure.
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
    (err) => /extract: not a valid stasis bundle/.test(err.message) &&
      /duplicate file key 'node_modules\/foo\/bar\/x\.js' across bundle buckets/.test(err.cause?.message),
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

test('extractCommand reports a clear error for a file that is not a valid stasis bundle', withTmp((t, tmp) => {
  // A v1 bundle missing the required `formats`/`imports` fields trips Bundle.parse
  // with a message-less assert; extract must wrap it with context (which file).
  const malformed = {
    version: 1,
    config: { scope: 'full' },
    entries: ['src/a.js'],
    sources: { '.': { name: 'app', version: '0.0.0', files: { 'src/a.js': 'export const x = 1\n' } } },
    modules: {},
    // formats + imports deliberately omitted -- Bundle.parse asserts they are present
  }
  const bundlePath = join(tmp, 'malformed.br')
  writeRawBundle(bundlePath, malformed)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /not a valid stasis bundle/,
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

test('extractCommand rejects a non-canonical base64 resource (tamper layer below the format tag)', withTmp((t, tmp) => {
  // The format tag says resource:base64, but the content has non-canonical padding
  // (or invalid characters Buffer.from would silently drop). assertCanonicalBase64
  // catches it -- otherwise a tampered bundle could ship an "asset" whose decoded
  // bytes are attacker-chosen and self-consistently round-trip through extract +
  // a derived lockfile, even though no honest producer would ever emit them.
  const malformed = {
    version: 1,
    config: { scope: 'full' },
    entries: ['src/entry.js'],
    sources: { '.': { name: 'app', version: '0.0.0', files: {
      'src/entry.js': 'console.log("ok")\n',
      'src/blob.bin': '!!!not_base64!!!',  // non-canonical: invalid characters
    } } },
    modules: {},
    formats: {
      'src/entry.js': 'commonjs',
      'src/blob.bin': 'resource:base64',
    },
    imports: {},
  }
  const bundlePath = join(tmp, 'lying.br')
  writeRawBundle(bundlePath, malformed)
  t.assert.throws(
    () => extractCommand({ bundleFile: bundlePath, output: join(tmp, 'out') }),
    /non-canonical base64.*src\/blob\.bin/,
  )
}))

test('lockfileFromBundle accepts canonical base64 and produces a hash matching the raw bytes', (t) => {
  // The honest-producer path: a base64 string that is its own canonical encoding
  // (no garbage characters, correct padding) round-trips through the assertion
  // and yields a hash over the DECODED bytes -- the same digest `stasis run`
  // would have recorded for the raw on-disk file.
  const raw = Buffer.from([0, 1, 2, 3, 0xff])
  const b64 = raw.toString('base64')
  const bundle = new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([
      ['node_modules/foo', { name: 'foo', version: '1.0.0', files: { 'asset.bin': b64 } }],
    ]),
    formats: new Map([['node_modules/foo/asset.bin', 'resource:base64']]),
  })
  const lock = lockfileFromBundle(bundle)
  t.assert.equal(lock.modules.get('node_modules/foo').files['asset.bin'], sha512integrity(raw))
})

// --- `stasis run --fs` directory captures (the `directory` format) ---

test('extractCommand skips a directory-listing entry on disk but keeps it in the lockfile', withTmp((t, tmp) => {
  // A `--fs` bundle keys a readdir listing at the directory's OWN path
  // ('src/assets'), alongside the files under it. extract must NOT write a file at
  // that path (the children recreate the directory; a file there would collide with
  // them at the file-vs-directory guard) -- but the derived lockfile still attests
  // the listing by hash.
  const bundle = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/entry.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: {
        'src/entry.js': 'export const x = 1\n',
        'src/assets/a.txt': 'A',
        'src/assets': '["a.txt"]', // a workspace SUB-directory listing (rel='src/assets')
      } }],
      // a directory captured at a node_modules package ROOT keys the listing at the
      // bucket itself (rel === '') -- the case that needs moduleFileKey, not a
      // trailing-slash join, in the skip check.
      ['node_modules/dep', { name: 'dep', version: '2.0.0', ecosystem: 'npm', files: {
        '': '["index.js"]',
        'index.js': 'module.exports = 1\n',
      } }],
    ]),
    formats: new Map([
      ['src/entry.js', 'module'],
      ['src/assets/a.txt', 'resource'],
      ['src/assets', 'directory'],
      ['node_modules/dep', 'directory'],
      ['node_modules/dep/index.js', 'commonjs'],
    ]),
    imports: new Map([['*', new Map([['src/entry.js', new Map()]])]]),
  })
  const bundlePath = join(tmp, 'snap.br')
  writeFileSync(bundlePath, brotliCompressSync(bundle.serialize()))

  const outDir = join(tmp, 'out')
  t.assert.doesNotThrow(() => extractCommand({ bundleFile: bundlePath, output: outDir }))
  // workspace sub-directory listing: not written as a file, path is a real dir
  t.assert.equal(readFileSync(join(outDir, 'src', 'assets', 'a.txt'), 'utf8'), 'A')
  t.assert.ok(statSync(join(outDir, 'src', 'assets')).isDirectory(), 'the path is a real directory, not a file')
  // node_modules package-ROOT listing (rel=''): same, and the child still written
  t.assert.equal(readFileSync(join(outDir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1\n')
  t.assert.ok(statSync(join(outDir, 'node_modules', 'dep')).isDirectory())
  const lock = JSON.parse(readFileSync(join(outDir, 'stasis.lock.json'), 'utf8'))
  t.assert.equal(lock.formats['src/assets'], 'directory')
  t.assert.equal(lock.formats['node_modules/dep'], 'directory')
  t.assert.equal(lock.sources['.'].files['src/assets'], sha512integrity('["a.txt"]'))
}))

test('prune tolerates a --fs directory capture under node_modules', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  mkdirSync(join(tmp, 'node_modules', 'dep', 'locales'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(tmp, 'node_modules', 'dep', 'locales', 'en.json'), '{}\n')

  const u = (p) => pathToFileURL(join(tmp, p)).toString()
  const cap = new State(tmp, { scope: 'full', lock: 'add', bundle: 'none' })
  cap.addFile(u('node_modules/dep/index.js'))
  cap.addFile(u('node_modules/dep/locales/en.json'))
  cap.addFsDir(u('node_modules/dep/locales'), ['en.json']) // a SUB-directory (rel='locales')
  cap.addFsDir(u('node_modules/dep'), ['index.js', 'locales', 'package.json']) // the package ROOT (rel='')
  cap.write() // lockfile tags both node_modules/dep and .../locales as 'directory'

  // Without the fix, prune adds the directory path to its expected-FILE set, then
  // walkFiles (real files only) never yields it -> "missing on disk" throw. The
  // package-ROOT case (rel='') additionally needs moduleFileKey, not a trailing-slash
  // join, or the skip lookup misses 'node_modules/dep' and demands 'node_modules/dep/'.
  let res
  t.assert.doesNotThrow(() => { res = prune({ root: tmp }) })
  t.assert.ok(res.validated.includes('node_modules/dep/index.js'))
  t.assert.ok(res.validated.includes('node_modules/dep/locales/en.json'))
}))

test('prune still removes a file named in a recorded directory listing if its content is not recorded', withTmp((t, tmp) => {
  // A `directory` capture attests only the set of NAMES (a hashed JSON blob), not
  // the files' contents. So a file whose name appears in a recorded listing but
  // whose bytes were never recorded (not readFileSync'd / imported) is NOT trusted
  // and must still be pruned -- only content-hash-attested files survive.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  mkdirSync(join(tmp, 'node_modules', 'dep', 'locales'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(tmp, 'node_modules', 'dep', 'locales', 'a.json'), '{"a":1}\n')
  writeFileSync(join(tmp, 'node_modules', 'dep', 'locales', 'b.json'), '{"b":2}\n')

  const u = (p) => pathToFileURL(join(tmp, p)).toString()
  const cap = new State(tmp, { scope: 'full', lock: 'add', bundle: 'none' })
  cap.addFile(u('node_modules/dep/index.js'))
  cap.addFile(u('node_modules/dep/locales/a.json')) // a.json CONTENT recorded
  cap.addFsDir(u('node_modules/dep/locales'), ['a.json', 'b.json']) // listing names BOTH; b.json content NOT recorded
  cap.write()

  const res = prune({ root: tmp })
  t.assert.ok(res.validated.includes('node_modules/dep/locales/a.json'), 'content-recorded file kept')
  t.assert.ok(res.removed.includes('node_modules/dep/locales/b.json'), 'listed-but-content-unrecorded file removed')
  t.assert.ok(!existsSync(join(tmp, 'node_modules', 'dep', 'locales', 'b.json')))
  t.assert.ok(existsSync(join(tmp, 'node_modules', 'dep', 'locales', 'a.json')))
}))
