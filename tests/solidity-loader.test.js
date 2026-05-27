import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  extractSolImports,
  loadSolidity,
  parseRemappings,
  parseRemappingsFromToml,
  readRemappingsFile,
  resolveNodeModulesSpec,
  resolveSolImport,
} from '../src/loaders/solidity.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'solidity-bundle')

const captureWarnings = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const result = fn()
    return { result, warnings }
  } finally {
    console.warn = original
  }
}

const captureWarningsAsync = async (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const result = await fn()
    return { result, warnings }
  } finally {
    console.warn = original
  }
}

test('extractSolImports finds plain double-quote imports', (t) => {
  const src = readFileSync(join(fixtures, 'basic/src/A.sol'), 'utf8')
  t.assert.deepEqual(extractSolImports(src), ['./B.sol'])
})

test('extractSolImports finds remapped imports', (t) => {
  const src = readFileSync(join(fixtures, 'with-remappings-txt/src/A.sol'), 'utf8')
  t.assert.deepEqual(extractSolImports(src), ['@openzeppelin/contracts/utils/Math.sol'])
})

test('parseRemappings handles one-per-line entries and ignores invalid lines', (t) => {
  const out = parseRemappings('@a/=lib/a/\n@b/=lib/b/\ngarbage line\n')
  t.assert.deepEqual(out, [
    { prefix: '@a/', target: 'lib/a/' },
    { prefix: '@b/', target: 'lib/b/' },
  ])
})

test('parseRemappingsFromToml extracts entries from a remappings array', (t) => {
  const toml = readFileSync(join(fixtures, 'with-foundry-toml/foundry.toml'), 'utf8')
  t.assert.deepEqual(parseRemappingsFromToml(toml), [
    { prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' },
  ])
})

test('parseRemappingsFromToml returns [] when no remappings key present', (t) => {
  t.assert.deepEqual(parseRemappingsFromToml('[profile.default]\nsrc = "src"\n'), [])
})

test('resolveSolImport resolves relative imports against the source file', (t) => {
  t.assert.equal(resolveSolImport('./B.sol', 'src/A.sol', []), 'src/B.sol')
  t.assert.equal(resolveSolImport('../lib/C.sol', 'src/sub/A.sol', []), 'src/lib/C.sol')
})

test('resolveSolImport picks the longest remapping prefix', (t) => {
  const remappings = [
    { prefix: '@oz/', target: 'lib/oz/' },
    { prefix: '@oz/contracts/', target: 'lib/oz-c/' },
  ]
  t.assert.equal(
    resolveSolImport('@oz/contracts/utils/Math.sol', 'src/A.sol', remappings),
    'lib/oz-c/utils/Math.sol',
  )
  t.assert.equal(resolveSolImport('@oz/other.sol', 'src/A.sol', remappings), 'lib/oz/other.sol')
})

test('resolveSolImport returns null for non-relative, non-remapped imports (no disk lookup)', (t) => {
  // The pure resolver doesn't know about disk; the caller layers a
  // resolveNodeModulesSpec fallback on top when baseDir is available.
  t.assert.equal(resolveSolImport('@unknown/Foo.sol', 'src/A.sol', []), null)
  t.assert.equal(resolveSolImport('foo/X.sol', 'src/A.sol', []), null)
})

test('resolveNodeModulesSpec finds a scoped package at baseDir/node_modules and returns the subpath', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(
    resolveNodeModulesSpec(baseDir, 'src/A.sol', '@oz/contracts/utils/Math.sol'),
    'node_modules/@oz/contracts/utils/Math.sol',
  )
})

test('resolveNodeModulesSpec returns null for unscoped specifiers (only `@scope/pkg/...` is supported)', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(resolveNodeModulesSpec(baseDir, 'src/A.sol', 'foo/X.sol'), null)
  t.assert.equal(resolveNodeModulesSpec(baseDir, 'src/A.sol', 'X.sol'), null)
})

test('resolveNodeModulesSpec returns null for `@scope/pkg` with no file subpath', (t) => {
  t.assert.equal(
    resolveNodeModulesSpec(join(fixtures, 'nm-fallback'), 'src/A.sol', '@oz/contracts'),
    null,
  )
})

test('resolveNodeModulesSpec rejects `..` in the subpath (path-traversal guard)', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(resolveNodeModulesSpec(baseDir, 'src/A.sol', '@oz/contracts/../../etc/passwd'), null)
  t.assert.equal(resolveNodeModulesSpec(baseDir, 'src/A.sol', '@oz/contracts/utils/../Math.sol'), null)
})

test('resolveNodeModulesSpec returns null when the package is not installed under baseDir', (t) => {
  t.assert.equal(
    resolveNodeModulesSpec(join(fixtures, 'nm-fallback'), 'src/A.sol', '@absent/nope/X.sol'),
    null,
  )
})

test('resolveSolImport returns null when relative traversal escapes the root', (t) => {
  // Going above the project root must not silently clamp to root — that
  // would change the import target into a different file altogether.
  t.assert.equal(resolveSolImport('../X.sol', 'A.sol', []), null)
  t.assert.equal(resolveSolImport('../../X.sol', 'src/A.sol', []), null)
})

test('collectSolidityFilesFromDisk walks imports starting from entries', async (t) => {
  const baseDir = join(fixtures, 'basic')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], [])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.sol', 'src/B.sol'])
})

test('collectSolidityFilesFromDisk follows remappings', async (t) => {
  const baseDir = join(fixtures, 'with-remappings-txt')
  const remappings = await readRemappingsFile(join(baseDir, 'remappings.txt'))
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], remappings)
  t.assert.deepEqual(
    [...sources.keys()].toSorted(),
    ['lib/openzeppelin-contracts/contracts/utils/Math.sol', 'src/A.sol'],
  )
})

test('collectSolidityFilesFromDisk loads each shared file once', async (t) => {
  const baseDir = join(fixtures, 'shared')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol', 'src/B.sol'], [])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.sol', 'src/B.sol', 'src/Shared.sol'])
})

test('collectSolidityFilesFromDisk accepts a non-relative import matching a caller-listed entry', async (t) => {
  const baseDir = join(fixtures, 'non-relative-entry')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol', 'src/B.sol'], [])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.sol', 'src/B.sol'])
})

test('collectSolidityFilesFromDisk warns and skips a missing import', async (t) => {
  const baseDir = join(fixtures, 'missing')
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], []),
  )
  t.assert.deepEqual([...sources.keys()], ['src/A.sol'])
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('@missing/Nope.sol')))
})

test('collectSolidityFilesFromDisk warns and skips when a resolved file is missing on disk', async (t) => {
  // A.sol imports @oz/X.sol; the remapping resolves to lib/oz/X.sol but
  // that file doesn't exist. The walk must warn and continue, not crash.
  const baseDir = join(fixtures, 'missing-on-disk')
  const remappings = await readRemappingsFile(join(baseDir, 'remappings.txt'))
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], remappings),
  )
  t.assert.deepEqual([...sources.keys()], ['src/A.sol'])
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('lib/oz/X.sol')))
})

test('buildSolidityTree returns sources, resolutions, and a missing-imports list (no exports)', async (t) => {
  const baseDir = join(fixtures, 'basic')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], [])
  const tree = buildSolidityTree(sources, { remappings: [] })
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources'])
  t.assert.equal(tree.sources.get('src/A.sol'), sources.get('src/A.sol'))
  t.assert.equal(tree.resolutions.get('src/A.sol').get('./B.sol'), 'src/B.sol')
  t.assert.equal(tree.resolutions.get('src/B.sol').size, 0)
  t.assert.deepEqual(tree.missing, [])
})

test('buildSolidityTree records unresolved imports in `missing`', async (t) => {
  const baseDir = join(fixtures, 'missing')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], [])
  const { warnings, result: tree } = captureWarnings(() => buildSolidityTree(sources, { remappings: [] }))
  t.assert.deepEqual(tree.missing, [{ spec: '@missing/Nope.sol', from: 'src/A.sol' }])
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('@missing/Nope.sol')))
})

test('buildSolidityTree warns and produces an empty resolution for a missing import', async (t) => {
  const baseDir = join(fixtures, 'missing')
  const sources = await captureWarningsAsync(() =>
    collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], []),
  ).then((r) => r.result)
  const { result: tree, warnings } = captureWarnings(() => buildSolidityTree(sources, { remappings: [] }))
  t.assert.equal(tree.resolutions.get('src/A.sol').size, 0)
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('@missing/Nope.sol')))
})

test('readRemappingsFile reads a remappings.txt', async (t) => {
  const r = await readRemappingsFile(join(fixtures, 'with-remappings-txt/remappings.txt'))
  t.assert.deepEqual(r, [{ prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' }])
})

test('readRemappingsFile reads a foundry.toml', async (t) => {
  const r = await readRemappingsFile(join(fixtures, 'with-foundry-toml/foundry.toml'))
  t.assert.deepEqual(r, [{ prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' }])
})

test('loadSolidity reads a .sol.txt listing with a remappings.txt header', async (t) => {
  const tree = await loadSolidity(join(fixtures, 'listing-txt/list.sol.txt'))
  t.assert.deepEqual([...tree.sources.keys()].toSorted(), ['lib/oz/X.sol', 'src/A.sol'])
  // mapping file itself must NOT appear in sources
  t.assert.ok(!tree.sources.has('remappings.txt'))
  t.assert.equal(tree.resolutions.get('src/A.sol').get('@oz/X.sol'), 'lib/oz/X.sol')
})

test('loadSolidity reads a .sol.txt listing with a foundry.toml header', async (t) => {
  const tree = await loadSolidity(join(fixtures, 'listing-toml/list.sol.txt'))
  t.assert.deepEqual([...tree.sources.keys()].toSorted(), ['lib/oz/X.sol', 'src/A.sol'])
  t.assert.ok(!tree.sources.has('foundry.toml'))
})

test('loadSolidity rejects an empty listing', async (t) => {
  await t.assert.rejects(
    () => loadSolidity(join(fixtures, 'listing-empty/list.sol.txt')),
    /Empty Solidity listing/,
  )
})

test('loadSolidity rejects a listing with non-.sol lines', async (t) => {
  await t.assert.rejects(
    () => loadSolidity(join(fixtures, 'listing-nonsol/list.sol.txt')),
    /must only contain \.sol files/,
  )
})

test('loadSolidity rejects an entry path that escapes the listing dir', async (t) => {
  await t.assert.rejects(
    () => loadSolidity(join(fixtures, 'listing-escape/list.sol.txt')),
    /Entry path escapes baseDir/,
  )
})

test('loadSolidity rejects an absolute entry path in the listing', async (t) => {
  await t.assert.rejects(
    () => loadSolidity(join(fixtures, 'listing-absolute/list.sol.txt')),
    /Entry path must not be absolute/,
  )
})
