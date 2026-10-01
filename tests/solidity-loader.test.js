import { test } from 'node:test'
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyRemappings,
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  discoverSolidityConfig,
  expandSolidityEntries,
  extractSolImports,
  loadSolidity,
  parseRemappings,
  parseRemappingsFromToml,
  readRemappingsFile,
  resolveSolImport,
} from '../stasis/src/loaders/solidity.js'
import { findRemappingsWithContext, foundryProject, foundryTomlRemappings } from '../stasis/src/loaders/foundry.js'
import { readGitmodules, solidityOwnership } from '../stasis/src/loaders/solidity-ownership.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'solidity-bundle')

// A throwaway project: `files` maps project-relative paths to contents (a `/`-terminated key is an
// empty dir). Removed when `fn` settles.
const withProject = (files, fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-sol-'))
  try {
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      if (p.endsWith('/')) mkdirSync(join(dir, p), { recursive: true })
      else writeFileSync(join(dir, p), content)
    }
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const show = (r) => `${r.context === null ? '' : `${r.context}:`}${r.prefix}=${r.target}`
const forgeRemappings = (dir, env = {}) => foundryProject(dir, { env }).remappings.map(show)

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

test('parseRemappings handles one-per-line entries and refuses an invalid line, naming it', (t) => {
  const out = parseRemappings('@a/=lib/a/\n  @b/=lib/b/\r\n\n')
  t.assert.deepEqual(out, [
    { context: null, prefix: '@a/', target: 'lib/a/' },
    { context: null, prefix: '@b/', target: 'lib/b/' },
  ])
  t.assert.throws(() => parseRemappings('@a/=lib/a/\ngarbage line\n'), { message: 'remappings:2: invalid remapping "garbage line"' })
  // Lines are trimmed as Rust trims them: a byte-order mark isn't whitespace, and stays.
  t.assert.deepEqual(parseRemappings('\uFEFFx/=a/\n'), [{ context: null, prefix: '\uFEFFx/', target: 'a/' }])
  t.assert.throws(() => parseRemappings('\n=empty-prefix\n'), { message: 'remappings:2: invalid remapping "=empty-prefix"' })
})

test('parseRemappings reads a `context:` before the prefix', (t) => {
  t.assert.deepEqual(parseRemappings('lib/a/:ds-test/=lib/a/lib/ds-test/src/\n:@b/=lib/b/\n'), [
    { context: 'lib/a/', prefix: 'ds-test/', target: 'lib/a/lib/ds-test/src/' },
    { context: null, prefix: '@b/', target: 'lib/b/' },
  ])
})

test('parseRemappingsFromToml extracts entries from a remappings array', (t) => {
  const toml = readFileSync(join(fixtures, 'with-foundry-toml/foundry.toml'), 'utf8')
  t.assert.deepEqual(parseRemappingsFromToml(toml), [
    { context: null, prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' },
  ])
})

test('parseRemappingsFromToml reads [profile.default], not the first `remappings` in the file', (t) => {
  const toml = '[profile.ci]\nremappings = ["@x/=lib/ci/"]\n\n[profile.default]\nremappings = [\n  # comment\n  "@x/=lib/default/", # trailing\n]\n'
  t.assert.deepEqual(parseRemappingsFromToml(toml, { env: {} }), [{ context: null, prefix: '@x/', target: 'lib/default/' }])
  // FOUNDRY_PROFILE overlays the selected profile's keys on the default's.
  t.assert.deepEqual(parseRemappingsFromToml(toml, { env: { FOUNDRY_PROFILE: 'ci' } }), [{ context: null, prefix: '@x/', target: 'lib/ci/' }])
  t.assert.deepEqual(parseRemappingsFromToml('[profile.default]\nremappings = ["@x/=lib/d/"]\n[profile.ci]\nsrc = "s"\n', { env: { FOUNDRY_PROFILE: 'ci' } }), [{ context: null, prefix: '@x/', target: 'lib/d/' }])
})

test('parseRemappingsFromToml returns [] when no remappings key present', (t) => {
  t.assert.deepEqual(parseRemappingsFromToml('[profile.default]\nsrc = "src"\n'), [])
})

test('resolveSolImport resolves relative imports against the source file', (t) => {
  t.assert.equal(resolveSolImport('./B.sol', 'src/A.sol'), 'src/B.sol')
  t.assert.equal(resolveSolImport('../lib/C.sol', 'src/sub/A.sol'), 'src/lib/C.sol')
})

test('resolveSolImport picks the longest remapping prefix', (t) => {
  const remappings = [
    { prefix: '@oz/', target: 'lib/oz/' },
    { prefix: '@oz/contracts/', target: 'lib/oz-c/' },
  ]
  t.assert.equal(
    resolveSolImport('@oz/contracts/utils/Math.sol', 'src/A.sol', { remappings }),
    'lib/oz-c/utils/Math.sol',
  )
  t.assert.equal(
    resolveSolImport('@oz/other.sol', 'src/A.sol', { remappings }),
    'lib/oz/other.sol',
  )
})

test('resolveSolImport returns null for non-relative, non-remapped imports without baseDir', (t) => {
  // Without baseDir the Node-style strategy is disabled, so anything
  // not covered by remappings or relative paths is null.
  t.assert.equal(resolveSolImport('@unknown/Foo.sol', 'src/A.sol'), null)
  t.assert.equal(resolveSolImport('foo/X.sol', 'src/A.sol'), null)
})

test('resolveSolImport returns null when relative traversal escapes the root', (t) => {
  // Going above the project root must not silently clamp to root — that
  // would change the import target into a different file altogether.
  t.assert.equal(resolveSolImport('../X.sol', 'A.sol'), null)
  t.assert.equal(resolveSolImport('../../X.sol', 'src/A.sol'), null)
})

test('resolveSolImport uses Node-style resolution for @-scoped imports when baseDir is given', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(
    resolveSolImport('@oz/contracts/utils/Math.sol', 'src/A.sol', { baseDir }),
    'node_modules/@oz/contracts/utils/Math.sol',
  )
})

test('resolveSolImport does not invoke Node-style resolution for unscoped specifiers', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(resolveSolImport('foo/X.sol', 'src/A.sol', { baseDir }), null)
  t.assert.equal(resolveSolImport('X.sol', 'src/A.sol', { baseDir }), null)
})

test('resolveSolImport returns null for `@scope/pkg` with no file subpath', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(resolveSolImport('@oz/contracts', 'src/A.sol', { baseDir }), null)
})

test('resolveSolImport rejects `..` in a node-resolved subpath (path-traversal guard)', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(
    resolveSolImport('@oz/contracts/../../etc/passwd', 'src/A.sol', { baseDir }),
    null,
  )
  t.assert.equal(
    resolveSolImport('@oz/contracts/utils/../Math.sol', 'src/A.sol', { baseDir }),
    null,
  )
})

test('resolveSolImport returns null when the node-resolved package is not installed', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(resolveSolImport('@absent/nope/X.sol', 'src/A.sol', { baseDir }), null)
})

test('resolveSolImport prefers a matching remapping over the Node-style fallback', (t) => {
  const baseDir = join(fixtures, 'nm-fallback')
  t.assert.equal(
    resolveSolImport('@oz/contracts/utils/Math.sol', 'src/A.sol', {
      baseDir,
      remappings: [{ prefix: '@oz/', target: 'lib/oz/' }],
    }),
    'lib/oz/contracts/utils/Math.sol',
  )
})

test('resolveSolImport falls back to project-relative for non-relative specs that exist on disk', (t) => {
  // Foundry-style `import "src/A.sol"` — no remapping, no `./`, no
  // `@scope/`. The fallback accepts it because `src/A.sol` is a real
  // file at the project root.
  const baseDir = join(fixtures, 'non-relative-entry')
  t.assert.equal(resolveSolImport('src/A.sol', 'src/B.sol', { baseDir }), 'src/A.sol')
})

test('resolveSolImport project-relative fallback returns null when the file is absent', (t) => {
  const baseDir = join(fixtures, 'non-relative-entry')
  t.assert.equal(resolveSolImport('src/DoesNotExist.sol', 'src/B.sol', { baseDir }), null)
})

test('resolveSolImport project-relative fallback rejects path traversal that escapes baseDir', (t) => {
  const baseDir = join(fixtures, 'non-relative-entry')
  t.assert.equal(resolveSolImport('foo/../../etc/passwd', 'src/B.sol', { baseDir }), null)
})

test('resolveSolImport project-relative fallback rejects absolute specifiers', (t) => {
  const baseDir = join(fixtures, 'non-relative-entry')
  t.assert.equal(resolveSolImport('/etc/passwd', 'src/B.sol', { baseDir }), null)
})

test('resolveSolImport project-relative fallback rejects directory matches', (t) => {
  // `src/` is a directory in the fixture — fallback must not accept it
  // (readFile would later fail with EISDIR mid-walk).
  const baseDir = join(fixtures, 'non-relative-entry')
  t.assert.equal(resolveSolImport('src', 'src/B.sol', { baseDir }), null)
})

test('resolveSolImport project-relative fallback is disabled without baseDir', (t) => {
  // Pure-function callers (no fs context) must still get null for bare specs.
  t.assert.equal(resolveSolImport('src/A.sol', 'src/B.sol'), null)
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

test('collectSolidityFilesFromDisk walks project-relative imports even when the target is not a listed entry', async (t) => {
  // B.sol imports `src/A.sol` (Foundry-style, no remapping). With only
  // B.sol as a caller-listed entry, the walk must still pick up A.sol
  // via the project-relative fallback in resolveSolImport.
  const baseDir = join(fixtures, 'non-relative-entry')
  const sources = await collectSolidityFilesFromDisk(baseDir, ['src/B.sol'], [])
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
  t.assert.deepEqual(r, [{ context: null, prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' }])
})

test('readRemappingsFile reads a foundry.toml', async (t) => {
  const r = await readRemappingsFile(join(fixtures, 'with-foundry-toml/foundry.toml'), { env: {} })
  t.assert.deepEqual(r, [{ context: null, prefix: '@openzeppelin/', target: 'lib/openzeppelin-contracts/' }])
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

// --- Import scan ------------------------------------------------------------------------------

test('extractSolImports skips imports inside // and /* */ comments', (t) => {
  const src = [
    '// import "./Old.sol";',
    '/* import "./Gone.sol";',
    '   import "./AlsoGone.sol"; */',
    '/// @dev see import "./Doc.sol"',
    'import "./Real.sol"; // import "./Trailing.sol";',
  ].join('\n')
  t.assert.deepEqual(extractSolImports(src), ['./Real.sol'])
})

test('extractSolImports ignores the word import and paths inside string literals', (t) => {
  const src = [
    'contract C {',
    '  string s = "import x"; string t = "./Str.sol";',
    "  string u = 'import \\'y\\''; bytes h = hex\"00\"; string w = unicode\"import 🙂\";",
    '  function f() public { revert("cannot import"); require(true, "./A.sol"); }',
    '  uint importer = 0x1f; uint _import = 1e18;',
    '}',
  ].join('\n')
  t.assert.deepEqual(extractSolImports(src), [])
})

test('extractSolImports reads every import form, over several lines', (t) => {
  const src = [
    'import "./A.sol";',
    "import './B.sol' as B;",
    'import * as C from "./C.sol";',
    'import {',
    '  D,',
    '  E as F',
    '} from "@scope/pkg/D.sol";',
    'import {G} from "lib/\\x47.sol";',
  ].join('\n')
  t.assert.deepEqual(extractSolImports(src), ['./A.sol', './B.sol', './C.sol', '@scope/pkg/D.sol', 'lib/G.sol'])
})

// --- solc's remapping rules -------------------------------------------------------------------

test('applyRemappings: longest context wins, then longest prefix, then the one listed last', (t) => {
  const r = (context, prefix, target) => ({ context, prefix, target })
  const remappings = [
    r(null, '@oz/', 'lib/oz/'),
    r(null, '@oz/contracts/', 'lib/ozc/'),
    r('lib/dep/', '@oz/', 'lib/dep/lib/oz/'),
    r(null, 'dup/', 'lib/first/'),
    r(null, 'dup/', 'lib/last/'),
  ]
  t.assert.equal(applyRemappings('@oz/contracts/A.sol', 'src/X.sol', remappings), 'lib/ozc/A.sol')
  // A matching context beats a longer global prefix.
  t.assert.equal(applyRemappings('@oz/contracts/A.sol', 'lib/dep/src/Y.sol', remappings), 'lib/dep/lib/oz/contracts/A.sol')
  t.assert.equal(applyRemappings('dup/A.sol', 'src/X.sol', remappings), 'lib/last/A.sol')
  t.assert.equal(applyRemappings('other/A.sol', 'src/X.sol', remappings), null)
})

test('resolveSolImport applies remappings to a relative import after resolving it, as solc does', (t) => {
  const remappings = [{ context: null, prefix: 'lib/old/', target: 'lib/new/' }]
  t.assert.equal(resolveSolImport('./B.sol', 'lib/old/A.sol', { remappings }), 'lib/new/B.sol')
  // `.hidden/` is a directory name, not a relative import.
  t.assert.equal(resolveSolImport('.hidden/X.sol', 'src/A.sol', { remappings: [{ context: null, prefix: '.hidden/', target: 'lib/h/' }] }), 'lib/h/X.sol')
})

// --- Foundry discovery --------------------------------------------------------------------------

// Layouts from foundry-compilers' own remapping tests (artifacts/solc/src/remappings/find.rs),
// with the remappings forge derives for them.
test('findRemappingsWithContext matches forge on its geb/recursive/hardhat layouts', withProject({
  'geb/lib/ds-token/src/test/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-test/src/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-test/aux/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-stop/lib/ds-test/src/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-stop/lib/ds-note/src/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-math/src/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-stop/src/Contract.sol': '',
  'geb/lib/ds-token/src/Contract.sol': '',
  'geb/lib/ds-token/lib/erc20/src/Contract.sol': '',
  'geb/lib/ds-token/lib/ds-stop/lib/ds-auth/src/Contract.sol': '',
  'rec/lib/repo1/src/contract.sol': '',
  'rec/lib/repo1/lib/ds-test/src/test.sol': '',
  'rec/lib/repo1/lib/solmate/src/auth/contract.sol': '',
  'rec/lib/repo1/lib/solmate/src/tokens/contract.sol': '',
  'rec/lib/repo1/lib/solmate/lib/ds-test/demo/demo.sol': '',
  'rec/lib/repo1/lib/openzeppelin-contracts/contracts/access/AccessControl.sol': '',
  'rec/lib/repo1/lib/ds-token/lib/ds-stop/lib/ds-note/src/contract.sol': '',
  'hh/node_modules/@aave/aave-token/contracts/token/AaveToken.sol': '',
  'hh/node_modules/@aave/governance-v2/contracts/governance/Executor.sol': '',
  'hh/node_modules/@openzeppelin/contracts/tokens/contract.sol': '',
  'hh/node_modules/@openzeppelin/contracts/access/contract.sol': '',
  'hh/node_modules/prettier-plugin-solidity/tests/format/Modifier.sol': '',
  'hh/node_modules/eth-gas-reporter/mock/contracts/ConvertLib.sol': '',
}, (t, dir) => {
  const global = (lib) => findRemappingsWithContext(join(dir, lib)).global.map((r) => `${r.name}=${r.path.slice(dir.length + 1)}`).toSorted()
  t.assert.deepEqual(global('geb/lib'), [
    'ds-auth/=geb/lib/ds-token/lib/ds-stop/lib/ds-auth/src/',
    'ds-math/=geb/lib/ds-token/lib/ds-math/src/',
    'ds-note/=geb/lib/ds-token/lib/ds-stop/lib/ds-note/src/',
    'ds-stop/=geb/lib/ds-token/lib/ds-stop/src/',
    'ds-test/=geb/lib/ds-token/lib/ds-test/src/',
    'ds-token/=geb/lib/ds-token/src/',
    'erc20/=geb/lib/ds-token/lib/erc20/src/',
  ])
  t.assert.deepEqual(global('rec/lib'), [
    'ds-note/=rec/lib/repo1/lib/ds-token/lib/ds-stop/lib/ds-note/src/',
    'ds-test/=rec/lib/repo1/lib/ds-test/src/',
    'openzeppelin-contracts/=rec/lib/repo1/lib/openzeppelin-contracts/contracts/',
    'repo1/=rec/lib/repo1/src/',
    'solmate/=rec/lib/repo1/lib/solmate/src/',
  ])
  t.assert.deepEqual(global('hh/node_modules'), [
    '@aave/=hh/node_modules/@aave/',
    '@openzeppelin/=hh/node_modules/@openzeppelin/',
    'eth-gas-reporter/=hh/node_modules/eth-gas-reporter/',
  ])
}))

test('foundryProject auto-detects lib/ remappings with no remappings.txt, and a dependency\'s own config', withProject({
  'foundry.toml': '[profile.default]\n',
  'src/A.sol': '',
  'lib/forge-std/src/Test.sol': '',
  'lib/forge-std/lib/ds-test/src/test.sol': '',
  'lib/openzeppelin-contracts/contracts/token/ERC20.sol': '',
  'lib/openzeppelin-contracts/foundry.toml': '[profile.default]\nsrc = "contracts"\n',
  'lib/openzeppelin-contracts/remappings.txt': '@openzeppelin/contracts/=contracts/\n',
  'lib/openzeppelin-contracts/lib/forge-std/src/Test.sol': '',
}, (t, dir) => {
  // Also what `forge remappings` prints for this tree (foundry v1.8.3): the dependency's
  // remappings.txt, relativised onto it, and its own forge-std copy scoped to it.
  t.assert.deepEqual(forgeRemappings(dir), [
    'lib/openzeppelin-contracts/:forge-std/=lib/openzeppelin-contracts/lib/forge-std/src/',
    '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/',
    'ds-test/=lib/forge-std/lib/ds-test/src/',
    'forge-std/=lib/forge-std/src/',
    'openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/',
  ])
  const { files } = foundryProject(dir, { env: {} })
  t.assert.deepEqual(files.toSorted(), ['foundry.toml', 'lib/openzeppelin-contracts/foundry.toml', 'lib/openzeppelin-contracts/remappings.txt'])
}))

test('foundryProject orders user remappings like forge and drops aliases of src/test/script', withProject({
  'foundry.toml': '[profile.ci]\nremappings = ["@ci/=lib/ci/"]\n\n[profile.default]\nremappings = ["src/=lib/other/src/", "@oz/=lib/oz/", "x=lib/x"]\n',
  'remappings.txt': '@a/=lib/a/\n@a/b/=lib/ab/\n',
  'lib/forge-std/src/Test.sol': '',
}, (t, dir) => {
  // `@a/b/` is shadowed by the `@a/` listed before it; unslashed ones get their `/`.
  t.assert.deepEqual(forgeRemappings(dir), ['@a/=lib/a/', '@oz/=lib/oz/', 'x/=lib/x/', 'forge-std/=lib/forge-std/src/'])
  t.assert.deepEqual(forgeRemappings(dir, { FOUNDRY_PROFILE: 'ci' }), ['@a/=lib/a/', '@ci/=lib/ci/', 'forge-std/=lib/forge-std/src/'])
  t.assert.deepEqual(forgeRemappings(dir, { FOUNDRY_REMAPPINGS: '@env/=lib/env/' }), ['@env/=lib/env/', '@a/=lib/a/', '@oz/=lib/oz/', 'x/=lib/x/', 'forge-std/=lib/forge-std/src/'])
}))

test('foundryProject honours auto_detect_remappings = false and `extends`', withProject({
  'foundry.toml': '[profile.default]\nextends = "base.toml"\nauto-detect-remappings = false\nremappings = ["@local/=lib/local/"]\n',
  'base.toml': '[profile.default]\nremappings = ["@base/=lib/base/"]\n',
  'lib/forge-std/src/Test.sol': '',
}, (t, dir) => {
  t.assert.deepEqual(forgeRemappings(dir), ['@base/=lib/base/', '@local/=lib/local/'])
  t.assert.deepEqual(foundryProject(dir, { env: {} }).files.toSorted(), ['base.toml', 'foundry.toml'])
}))

test('foundryProject reads a profile\'s sub-tables however they are spelled: `extends` as a table, a `no-collision` over `fuzz`', withProject({
  'foundry.toml': '[profile.default]\nremappings = ["@local/=lib/local/"]\n\n[profile.default.extends]\npath = "base.toml"\nstrategy = "no-collision"\n\n[profile.default.fuzz]\nruns = 1\n',
  'base.toml': '[profile.default]\nfuzz = { runs = 2 }\n',
  'lib/forge-std/src/Test.sol': '',
}, (t, dir) => {
  // forge compares the profile's keys, sub-tables included: `fuzz` is set on both sides.
  t.assert.throws(() => foundryProject(dir, { env: {} }), { message: /key collision in profile 'default' when extending base\.toml: fuzz$/u })
}))

test('discoverSolidityConfig: --mapping takes exactly that file\'s remappings; no foundry.toml falls back to remappings.txt', withProject({
  'foundry.toml': '[profile.default]\n',
  'mapping.txt': '@m/=lib/m/\nforge-std=lib/forge-std/src\nconsole.sol=lib/forge-std/src/console.sol\n',
  'lib/forge-std/src/Test.sol': '',
  'plain/remappings.txt': '@p/=lib/p/\n',
}, async (t, dir) => {
  const pinned = await discoverSolidityConfig(dir, { mappingFile: 'mapping.txt', env: {} })
  // Slash-terminated as forge reads a remappings file.
  t.assert.deepEqual(pinned.remappings.map(show), ['@m/=lib/m/', 'forge-std/=lib/forge-std/src/', 'console.sol=lib/forge-std/src/console.sol'])
  // ...and the root foundry.toml, read for its lib dirs.
  t.assert.deepEqual(pinned.files, ['mapping.txt', 'foundry.toml'])
  t.assert.deepEqual((await discoverSolidityConfig(dir, { env: {} })).remappings.map(show), ['forge-std/=lib/forge-std/src/'])
  const plain = await discoverSolidityConfig(join(dir, 'plain'), { env: {} })
  t.assert.deepEqual(plain.remappings.map(show), ['@p/=lib/p/'])
  t.assert.deepEqual(plain.libs, [])
}))

// --- Lookups past the remappings -------------------------------------------------------------

test('resolveSolImport finds unscoped and scoped packages in node_modules by file path, ignoring `exports`', withProject({
  'contracts/A.sol': '',
  'node_modules/hardhat/console.sol': '',
  'node_modules/hardhat/package.json': '{"name":"hardhat","version":"2.22.0"}',
  'node_modules/solmate/src/tokens/ERC20.sol': '',
  'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg","version":"1.0.0","exports":{".":"./index.js"}}',
  'node_modules/@scope/pkg/contracts/X.sol': '',
}, (t, dir) => {
  t.assert.equal(resolveSolImport('hardhat/console.sol', 'contracts/A.sol', { baseDir: dir }), 'node_modules/hardhat/console.sol')
  t.assert.equal(resolveSolImport('solmate/src/tokens/ERC20.sol', 'contracts/A.sol', { baseDir: dir }), 'node_modules/solmate/src/tokens/ERC20.sol')
  t.assert.equal(resolveSolImport('@scope/pkg/contracts/X.sol', 'contracts/A.sol', { baseDir: dir }), 'node_modules/@scope/pkg/contracts/X.sol')
  t.assert.equal(resolveSolImport('solmate/../../etc/passwd', 'contracts/A.sol', { baseDir: dir }), null)
  t.assert.equal(resolveSolImport('solmate', 'contracts/A.sol', { baseDir: dir }), null)
}))

test('resolveSolImport resolves an absolute import inside a Foundry library against that library', withProject({
  'lib/dep/src/A.sol': '',
  'lib/dep/src/B.sol': '',
  'lib/dep/src/utils/C.sol': '',
  'src/Own.sol': '',
}, (t, dir) => {
  const opts = { baseDir: dir, libs: ['lib'] }
  t.assert.equal(resolveSolImport('src/B.sol', 'lib/dep/src/utils/C.sol', opts), 'lib/dep/src/B.sol')
  // The project root (solc's base path) comes first.
  t.assert.equal(resolveSolImport('src/Own.sol', 'lib/dep/src/A.sol', opts), 'src/Own.sol')
  // Only inside a lib dir, and only with forge's libs known.
  t.assert.equal(resolveSolImport('src/B.sol', 'lib/dep/src/utils/C.sol', { baseDir: dir }), null)
}))

// --- Directory entries --------------------------------------------------------------------------

test('expandSolidityEntries replaces a directory with the .sol files under it', withProject({
  'src/A.sol': '',
  'src/nested/B.sol': '',
  'src/notes.md': '',
  'test/A.t.sol': '',
  'docs/': null,
}, (t, dir) => {
  symlinkSync(join(dir, 'src'), join(dir, 'test/linked'))
  t.assert.deepEqual(expandSolidityEntries(dir, ['src', 'test', 'src/A.sol']), [
    'src/A.sol', 'src/nested/B.sol', 'test/A.t.sol', 'test/linked/A.sol', 'test/linked/nested/B.sol',
  ])
  t.assert.throws(() => expandSolidityEntries(dir, ['docs']), /No \.sol files under docs\//u)
}))

// --- Post-merge review ------------------------------------------------------------------------

test('extractSolImports ends a // comment at \r and reads escapes as UTF-8 bytes, as solc does', (t) => {
  // solc-js 0.8.30: the import after a CR-only line break is live; `\xc3\xa9` is `é`.
  t.assert.deepEqual(extractSolImports('// comment\rimport "./A.sol";'), ['./A.sol'])
  t.assert.deepEqual(extractSolImports('import "./\\xc3\\xa9.sol";\nimport "./\\u00e9x.sol";'), ['./é.sol', './éx.sol'])
  // An unterminated literal (solc rejects the file) ends the import instead of taking a later string.
  t.assert.deepEqual(extractSolImports('import "./a\rb.sol"; string s = "x";'), [])
})

test('foundry.toml profiles: legacy [<name>] tables, case-insensitive names, quoted dotted names, escapes', (t) => {
  // `[default]` is still read (forge warns), and `[profile.<name>]` wins key by key.
  t.assert.deepEqual(foundryTomlRemappings('[default]\nremappings = ["@legacy/=lib/legacy/"]\n').map((r) => r.name), ['@legacy/'])
  t.assert.deepEqual(foundryTomlRemappings('[default]\nremappings = ["@old/=a/"]\n[profile.default]\nremappings = ["@new/=b/"]\n').map((r) => r.name), ['@new/'])
  t.assert.deepEqual(parseRemappingsFromToml('[profile.CI]\nremappings = ["@ci/=lib/ci/"]\n', { env: { FOUNDRY_PROFILE: 'ci' } }).map((r) => r.prefix), ['@ci/'])
  t.assert.deepEqual(parseRemappingsFromToml('[profile."ci.fast"]\nremappings = ["@f/=lib/\\u0066/"]\n', { env: { FOUNDRY_PROFILE: 'ci.fast' } }), [{ context: null, prefix: '@f/', target: 'lib/f/' }])
  // Standalone sections are not profiles; a top-level `remappings` is a mapping file's fallback.
  t.assert.deepEqual(foundryTomlRemappings('[fmt]\nremappings = ["@x/=x/"]\n'), [])
  t.assert.deepEqual(foundryTomlRemappings('remappings = ["@top/=lib/top/"]\n').map((r) => r.name), ['@top/'])
})

test('foundryTomlRemappings names the line of a foundry.toml that isn\'t TOML', (t) => {
  t.assert.throws(() => foundryTomlRemappings('[profile.default]\nremappings = ["a/=b/"\n'), { name: 'TomlError', message: 'expected "," or "]", found the end of the text at line 3' })
})

test('resolveSolImport refuses a non-.sol target, one outside the root, and a dependency reaching the project', withProject({
  '.env': 'K=1\n',
  'secret.sol': 'contract S {}\n',
  'lib/dep/src/A.sol': '',
  'lib/other/src/B.sol': '',
  'node_modules/pkg/C.sol': '',
}, (t, dir) => {
  t.assert.equal(resolveSolImport('../../.env', 'lib/dep/src/A.sol', { baseDir: dir }), null)
  t.assert.equal(resolveSolImport('x/Y.sol', 'src/A.sol', { baseDir: dir, remappings: [{ context: null, prefix: 'x/', target: '/abs/' }] }), null)
  const opts = { baseDir: dir, libs: ['lib'], ownership: solidityOwnership(dir, { dirs: ['lib'] }) }
  t.assert.equal(resolveSolImport('secret.sol', 'lib/dep/src/A.sol', opts), null)
  t.assert.equal(resolveSolImport('secret.sol', 'src/Main.sol', opts), 'secret.sol')
  t.assert.equal(resolveSolImport('../../other/src/B.sol', 'lib/dep/src/A.sol', opts), 'lib/other/src/B.sol')
  t.assert.equal(resolveSolImport('../../../node_modules/pkg/C.sol', 'lib/dep/src/A.sol', opts), 'node_modules/pkg/C.sol')
}))

test('solidityOwnership decides a path\'s owner from where it really is, and catches a dependency\'s link out of itself', withProject({
  '.env': 'K=1\n',
  'secrets/Keys.sol': '',
  'lib/dep/src/A.sol': '',
  'lib/forge-std/src/Test.sol': '',
  'vendor/linked/src/L.sol': '',
  'packages/ws/W.sol': '',
  'node_modules/.pnpm/foo@1/node_modules/foo/F.sol': '',
  'node_modules/.pnpm/bar@1/node_modules/bar/B.sol': '',
}, (t, dir) => {
  const link = (target, at) => {
    mkdirSync(dirname(join(dir, at)), { recursive: true })
    symlinkSync(target, join(dir, at))
  }
  link('../../../.env', 'lib/dep/src/Evil.sol') // planted by the dependency: out of it
  link('../../forge-std/src', 'lib/dep/src/fs') // into another dependency: fine
  link('../../../secrets', 'lib/dep/node_modules/x') // a package slot inside the dependency is still its own
  link('../lib/dep/src', 'src/vendor') // the project's link into the dependency
  link('../vendor/linked', 'lib/linked') // a linked lib entry: the dependency is where it points
  link('../../packages/ws', 'node_modules/@org/ws') // a workspace package: the project's own
  link('.pnpm/foo@1/node_modules/foo', 'node_modules/foo')
  link('../../bar@1/node_modules/bar', 'node_modules/.pnpm/foo@1/node_modules/bar')
  const { of } = solidityOwnership(dir, { dirs: ['lib'] })
  const owner = (p) => {
    const o = of(p)
    return o.escape ? `escape ${o.escape.link} (${o.escape.root})` : o.dependency ? 'dependency' : 'project'
  }
  t.assert.equal(owner('lib/dep/src/A.sol'), 'dependency')
  t.assert.equal(owner('lib/dep/src/Evil.sol'), 'escape lib/dep/src/Evil.sol (lib/dep)')
  t.assert.equal(owner('lib/dep/src/fs/Test.sol'), 'dependency')
  t.assert.equal(owner('lib/dep/node_modules/x/Keys.sol'), 'escape lib/dep/node_modules/x (lib/dep)')
  t.assert.equal(owner('src/vendor/A.sol'), 'dependency')
  // Reached through the project's own link, the dependency's link out is still caught.
  t.assert.equal(owner('src/vendor/Evil.sol'), 'escape lib/dep/src/Evil.sol (lib/dep)')
  t.assert.equal(owner('lib/linked/src/L.sol'), 'dependency')
  t.assert.equal(owner('vendor/linked/src/L.sol'), 'dependency')
  t.assert.equal(owner('node_modules/@org/ws/W.sol'), 'project')
  t.assert.equal(owner('node_modules/foo/F.sol'), 'dependency')
  t.assert.equal(owner('node_modules/.pnpm/foo@1/node_modules/bar/B.sol'), 'dependency')
  t.assert.equal(owner('secrets/Keys.sol'), 'project')
  t.assert.deepEqual(of('lib/dep/src/Nope.sol'), { real: null, outside: false, dependency: false, escape: null, reason: null })
}))

test('solidityOwnership: a link from outside the root back into it is untrusted, unless the root was named through it', async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-sol-')))
  try {
    const proj = join(tmp, 'proj')
    mkdirSync(join(proj, 'lib'), { recursive: true })
    mkdirSync(join(tmp, 'shared/evil/src'), { recursive: true })
    writeFileSync(join(proj, '.env'), 'K=1\n')
    writeFileSync(join(proj, 'Own.sol'), '')
    symlinkSync('../../shared/evil', join(proj, 'lib/evil')) // the project's link to a dependency elsewhere
    symlinkSync('../../../proj/.env', join(tmp, 'shared/evil/src/Evil.sol')) // ...which links back in
    t.assert.deepEqual(solidityOwnership(proj, { dirs: ['lib'] }).of('lib/evil/src/Evil.sol').escape, { link: '../shared/evil/src/Evil.sol', root: null })
    // Named through a link (a symlinked checkout), an absolute link through that name is fine.
    symlinkSync(proj, join(tmp, 'named'))
    symlinkSync(join(tmp, 'named/Own.sol'), join(proj, 'Abs.sol'))
    t.assert.deepEqual(solidityOwnership(join(tmp, 'named')).of('Abs.sol'), { real: 'Own.sol', outside: false, dependency: false, escape: null, reason: null })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('solidityOwnership judges the path as the filesystem spells it (a case-insensitive one)', async (t) => {
  // Emulate a case-insensitive filesystem under `tmp`, whose names are lowercase on disk.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-sol-')))
  const lower = (p) => (typeof p === 'string' && p.startsWith(tmp) ? tmp + p.slice(tmp.length).toLowerCase() : p)
  const saved = {}
  for (const name of ['lstatSync', 'statSync', 'readlinkSync', 'readdirSync']) {
    saved[name] = fs[name]
    fs[name] = (p, ...rest) => saved[name](lower(p), ...rest)
  }
  saved.native = fs.realpathSync.native
  fs.realpathSync.native = (p, ...rest) => saved.native(lower(p), ...rest)
  syncBuiltinESMExports()
  try {
    mkdirSync(join(tmp, 'lib/evil/src'), { recursive: true })
    writeFileSync(join(tmp, '.env'), 'K=1\n')
    symlinkSync('../../../.env', join(tmp, 'lib/evil/src/test.sol'))
    const { of } = solidityOwnership(tmp, { dirs: ['lib'] })
    // A dependency's remapping to `../../LIB/evil/src/` names the same link.
    for (const p of ['lib/evil/src/test.sol', 'LIB/evil/src/Test.sol', 'Lib/Evil/SRC/TEST.sol']) t.assert.equal(of(p).escape?.root, 'lib/evil', p)
  } finally {
    for (const name of ['lstatSync', 'statSync', 'readlinkSync', 'readdirSync']) fs[name] = saved[name]
    fs.realpathSync.native = saved.native
    syncBuiltinESMExports()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('readGitmodules reads .gitmodules as git does: quotes, escapes, comments, key case, continuations', withProject({
  '.gitmodules': [
    '[submodule "a"]',
    '\tpath = "vendor/a" ; a comment',
    '\tURL = https://github.com/o/a',
    '\tbranch = "v1"',
    '[submodule "b"]',
    '\tpath = lib/b\\',
    'x',
    '\turl = "git@github.com:o/b.git" # comment',
    // A key may follow its section header on the line.
    '[submodule "d"] path = vendor/d',
    '\turl = https://github.com/o/d',
    '',
  ].join('\n'),
}, (t, dir) => {
  t.assert.deepEqual(readGitmodules(dir), [
    { path: 'vendor/a', url: 'https://github.com/o/a', branch: 'v1' },
    { path: 'lib/bx', url: 'git@github.com:o/b.git', branch: undefined },
    { path: 'vendor/d', url: 'https://github.com/o/d', branch: undefined },
  ])
  t.assert.deepEqual(readGitmodules(join(dir, 'none')), [])
}))

test('readGitmodules refuses what git reads two ways, a path out of normal form, and a url that is not a host\'s', withProject({}, (t, dir) => {
  const url = '\turl = https://github.com/o/x\n'
  for (const [text, message] of [
    // git's submodule commands read the first `path`, git config the last.
    [`[submodule "x"]\n\tpath = lib/x\n\tpath = lib/y\n${url}`, 'x.path: twice, of which git\'s submodule commands read the first and git config the last, at line 3'],
    [`[submodule "x"]\n\tpath = lib/x\n[submodule "x"]\n${url}`, 'x: a second section, at line 3, where git writes one'],
    [`[submodule.x]\n\tpath = lib/x\n${url}`, 'a section of the form [submodule.name], whose name git lowercases, where .gitmodules has [submodule "name"] alone, at line 1'],
    [`[submodule "x"]\n\tpath = ./lib/x\n${url}`, 'x.path: "./lib/x" is not a relative path in normal form'],
    [`[submodule "x"]\n\tpath = ../x\n${url}`, 'x.path: "../x" is outside the repository, where git writes no submodule'],
    ['[submodule "x"]\n\tpath = lib/x\n\turl = ../x.git\n', 'x.url: "../x.git" is relative to the superproject\'s remote, which only a clone of it knows'],
    ['[submodule "x"]\n\tpath = lib/x\n', 'x.url: expected a url, without which git cannot clone the submodule'],
  ]) {
    writeFileSync(join(dir, '.gitmodules'), text)
    t.assert.throws(() => readGitmodules(dir), { message: `.gitmodules: ${message}` })
  }
}))

test('a remappings.txt taken as written (solc) may map a prefix to nothing', (t) => {
  const remappings = parseRemappings('x/=\nctx:y/=\n')
  t.assert.deepEqual(remappings, [{ context: null, prefix: 'x/', target: '' }, { context: 'ctx', prefix: 'y/', target: '' }])
  t.assert.equal(resolveSolImport('x/A.sol', 'src/B.sol', { remappings }), 'A.sol')
})

test('an invalid remapping in a foundry.toml or remappings variable is an error, naming where it is', withProject({
  'foundry.toml': '[profile.default]\nremappings = ["a/=b/", "nope"]\n',
  'list/foundry.toml': '[profile.default]\nremappings = "a/=b/"\n',
  'num/foundry.toml': '[profile.default]\nremappings = [1]\n',
  'ok/foundry.toml': '[profile.default]\n',
}, (t, dir) => {
  t.assert.throws(() => foundryProject(dir, { env: {} }), { message: 'foundry.toml: `remappings`: invalid remapping "nope"' })
  t.assert.throws(() => foundryProject(join(dir, 'list'), { env: {} }), { message: 'foundry.toml: `remappings` is not an array of strings' })
  t.assert.throws(() => foundryProject(join(dir, 'num'), { env: {} }), { message: 'foundry.toml: `remappings`: invalid remapping 1' })
  t.assert.throws(() => foundryProject(join(dir, 'ok'), { env: { FOUNDRY_REMAPPINGS: 'x/=y/\nbad' } }), { message: 'FOUNDRY_REMAPPINGS:2: invalid remapping "bad"' })
  t.assert.throws(() => foundryTomlRemappings('[profile.default]\nremappings = ["=x/"]\n'), { message: '`remappings`: invalid remapping "=x/"' })
}))

test('a legacy [default] table\'s `extends` is ignored, as forge ignores it', withProject({
  'foundry.toml': '[default]\nextends = "base.toml"\n',
  'base.toml': '[profile.default]\nremappings = ["x/=lib/elsewhere/"]\n',
}, (t, dir) => {
  const { remappings, files } = foundryProject(dir, { env: {} })
  t.assert.deepEqual(files, ['foundry.toml'])
  t.assert.deepEqual(remappings, [])
}))

test('discoverSolidityConfig with a mapping file: a foundry.toml forge rejects still gives lib dirs, and FOUNDRY_PROFILE is reported when it picks them', withProject({
  'foundry.toml': '[profile.default]\nextends = "missing.toml"\n',
  'remappings.txt': 'x/=lib/x/\n',
  'ci/foundry.toml': '[profile.default]\n[profile.ci]\nlibs = ["deps"]\n',
  'ci/remappings.txt': 'x/=deps/x/\n',
}, async (t, dir) => {
  const warn = console.warn
  const lines = []
  console.warn = (...a) => lines.push(a.join(' '))
  const discover = (sub, env) => discoverSolidityConfig(join(dir, sub), { mappingFile: 'remappings.txt', env })
  try {
    const root = await discover('.', {})
    t.assert.deepEqual([root.libs, root.envUsed], [['lib'], []])
    t.assert.ok(lines.some((l) => l.includes('Using the default lib dirs') && l.includes('missing.toml')))
    const ci = await discover('ci', { FOUNDRY_PROFILE: 'ci' })
    t.assert.deepEqual([ci.libs, ci.envUsed], [['deps'], ['FOUNDRY_PROFILE=ci']])
    // A profile foundry.toml doesn't have picks nothing: said, and not reported as shaping the result.
    lines.length = 0
    const nope = await discover('ci', { FOUNDRY_PROFILE: 'nope' })
    t.assert.deepEqual([nope.libs, nope.envUsed], [['lib'], []])
    t.assert.deepEqual(lines, ['[loader.solidity] FOUNDRY_PROFILE=nope is not a profile in foundry.toml; using [profile.default]'])
  } finally {
    console.warn = warn
  }
}))

test('resolveSolImport starts a library lookup at the importer directory\'s parent, as foundry-compilers does', withProject({
  'lib/dep/src/utils/C.sol': '',
  'lib/dep/src/utils/src/B.sol': '',
  'lib/dep/src/B.sol': '',
}, (t, dir) => {
  // `resolve_absolute_library` never tries the importer's own dir (lib/dep/src/utils/src/B.sol).
  t.assert.equal(resolveSolImport('src/B.sol', 'lib/dep/src/utils/C.sol', { baseDir: dir, libs: ['lib'] }), 'lib/dep/src/B.sol')
}))

test('expandSolidityEntries follows symlinks the way walkdir does', withProject({
  'src/A.sol': '',
  'src/sub/B.sol': '',
  'shared/S.sol': '',
  'lib/x/X.sol': '',
}, (t, dir) => {
  symlinkSync(join(dir, 'src'), join(dir, 'src/sub/back')) // to the walk root: a loop, skipped
  symlinkSync(join(dir, 'shared'), join(dir, 'src/l1'))
  symlinkSync(join(dir, 'shared'), join(dir, 'src/l2')) // two links to one dir: both walked
  symlinkSync(dir, join(dir, 'src/up')) // above the walk: walked, up to its link back into src
  t.assert.deepEqual(expandSolidityEntries(dir, ['src']), [
    'src/A.sol', 'src/l1/S.sol', 'src/l2/S.sol', 'src/sub/B.sol',
    'src/up/lib/x/X.sol', 'src/up/shared/S.sol', 'src/up/src/A.sol', 'src/up/src/l1/S.sol', 'src/up/src/l2/S.sol', 'src/up/src/sub/B.sol',
  ])
}))
