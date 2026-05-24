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

test('resolveSolImport returns null for non-relative, non-remapped imports', (t) => {
  t.assert.equal(resolveSolImport('@unknown/Foo.sol', 'src/A.sol', []), null)
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

test('buildSolidityTree returns sources + resolutions only (no exports)', async (t) => {
  const baseDir = join(fixtures, 'basic')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/A.sol'], [])
  const tree = buildSolidityTree(sources, { remappings: [] })
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['resolutions', 'sources'])
  t.assert.equal(tree.sources.get('src/A.sol'), sources.get('src/A.sol'))
  t.assert.equal(tree.resolutions.get('src/A.sol').get('./B.sol'), 'src/B.sol')
  t.assert.equal(tree.resolutions.get('src/B.sol').size, 0)
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
