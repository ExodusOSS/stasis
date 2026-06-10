import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '../src/bundle.js'
import { buildSolidityBundle, bundleCommand, outermostDir } from '../src/cmd/bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures', 'solidity-bundle')

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-bundle-cmd-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Strip ANSI for stderr comparisons that travel through util.inspect.
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

test('buildSolidityBundle produces a Bundle with sources, formats, imports, entries', async (t) => {
  const cwd = join(fixtures, 'basic')
  const bundle = await buildSolidityBundle({ cwd, entries: ['src/A.sol'] })

  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual(bundle.config, { scope: 'full' })
  t.assert.deepEqual([...bundle.entries], ['src/A.sol'])

  // No package.json anywhere in the basic fixture → fallback bucket "."
  t.assert.deepEqual([...bundle.modules.keys()], ['.'])
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'solidity-bundle')
  t.assert.equal(workspace.version, '0.0.0')
  t.assert.deepEqual(
    Object.keys(workspace.files).toSorted(),
    ['src/A.sol', 'src/B.sol'],
  )
  t.assert.equal(workspace.files['src/A.sol'], readFileSync(join(cwd, 'src/A.sol'), 'utf8'))

  // Every loaded file gets a 'solidity' format tag
  t.assert.equal(bundle.formats.get('src/A.sol'), 'solidity')
  t.assert.equal(bundle.formats.get('src/B.sol'), 'solidity')

  // Imports live under the "solidity" condition key (not the JS-bundle "*")
  t.assert.deepEqual([...bundle.imports.keys()], ['solidity'])
  t.assert.equal(bundle.imports.get('solidity').get('src/A.sol').get('./B.sol'), 'src/B.sol')
})

test('buildSolidityBundle reads remappings from a remappings.txt mapping file', async (t) => {
  const cwd = join(fixtures, 'with-remappings-txt')
  const bundle = await buildSolidityBundle({
    cwd,
    entries: ['src/A.sol'],
    mappingFile: 'remappings.txt',
  })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['lib/openzeppelin-contracts/contracts/utils/Math.sol', 'src/A.sol'],
  )
  // mapping file itself must NOT appear in the bundle's files
  t.assert.ok(!Object.hasOwn(bundle.modules.get('.').files, 'remappings.txt'))
  t.assert.equal(
    bundle.imports.get('solidity').get('src/A.sol').get('@openzeppelin/contracts/utils/Math.sol'),
    'lib/openzeppelin-contracts/contracts/utils/Math.sol',
  )
})

test('buildSolidityBundle places node_modules files in per-package modules buckets with name+version from package.json', async (t) => {
  const cwd = join(fixtures, 'with-node-modules')
  const bundle = await buildSolidityBundle({
    cwd,
    entries: ['src/A.sol'],
    mappingFile: 'remappings.txt',
  })
  t.assert.deepEqual(
    [...bundle.modules.keys()].toSorted(),
    ['.', 'node_modules/@oz/contracts', 'node_modules/foo'],
  )

  // Workspace bucket: name+version from the project's own package.json.
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'my-app')
  t.assert.equal(workspace.version, '0.1.0')
  t.assert.deepEqual(Object.keys(workspace.files), ['src/A.sol'])

  // Unscoped node_modules package.
  const foo = bundle.modules.get('node_modules/foo')
  t.assert.equal(foo.name, 'foo')
  t.assert.equal(foo.version, '1.2.3')
  t.assert.deepEqual(Object.keys(foo.files), ['X.sol'])

  // Scoped node_modules package; rel path preserves the deep subdir.
  const oz = bundle.modules.get('node_modules/@oz/contracts')
  t.assert.equal(oz.name, '@oz/contracts')
  t.assert.equal(oz.version, '5.0.0')
  t.assert.deepEqual(Object.keys(oz.files), ['utils/Math.sol'])

  // Resolutions still use the full project-relative paths, regardless
  // of which bucket the target ended up in.
  const resolutions = bundle.imports.get('solidity').get('src/A.sol')
  t.assert.equal(resolutions.get('foo/X.sol'), 'node_modules/foo/X.sol')
  t.assert.equal(
    resolutions.get('@oz/contracts/utils/Math.sol'),
    'node_modules/@oz/contracts/utils/Math.sol',
  )
})

test('buildSolidityBundle resolves @-scoped imports via node_modules with no mapping file', async (t) => {
  // No --mapping passed: @oz/contracts/utils/Math.sol must fall back to
  // node_modules/@oz/contracts/utils/Math.sol on disk.
  const cwd = join(fixtures, 'nm-fallback')
  const bundle = await buildSolidityBundle({ cwd, entries: ['src/A.sol'] })
  t.assert.deepEqual(
    [...bundle.modules.keys()].toSorted(),
    ['.', 'node_modules/@oz/contracts'],
  )
  t.assert.equal(bundle.modules.get('node_modules/@oz/contracts').name, '@oz/contracts')
  t.assert.equal(bundle.modules.get('node_modules/@oz/contracts').version, '5.0.0')
  t.assert.equal(
    bundle.imports.get('solidity').get('src/A.sol').get('@oz/contracts/utils/Math.sol'),
    'node_modules/@oz/contracts/utils/Math.sol',
  )
})

test('buildSolidityBundle resolves nested node_modules from the importing source (Node-style walk)', async (t) => {
  // src/A.sol imports @dep/x/Y.sol → resolves to node_modules/@dep/x/Y.sol.
  // Y.sol then imports @inner/z/Z.sol — resolution anchored at Y.sol must
  // find the nested node_modules/@dep/x/node_modules/@inner/z/Z.sol, not
  // walk back to a sibling at node_modules/@inner/z (which doesn't exist).
  const cwd = join(fixtures, 'nm-nested')
  const bundle = await buildSolidityBundle({ cwd, entries: ['src/A.sol'] })
  t.assert.deepEqual(
    [...bundle.modules.keys()].toSorted(),
    ['.', 'node_modules/@dep/x', 'node_modules/@dep/x/node_modules/@inner/z'],
  )
  t.assert.equal(bundle.modules.get('node_modules/@dep/x/node_modules/@inner/z').name, '@inner/z')
  t.assert.equal(bundle.modules.get('node_modules/@dep/x/node_modules/@inner/z').version, '2.0.0')
  t.assert.equal(
    bundle.imports.get('solidity').get('node_modules/@dep/x/Y.sol').get('@inner/z/Z.sol'),
    'node_modules/@dep/x/node_modules/@inner/z/Z.sol',
  )
})

test('buildSolidityBundle throws when a node_modules file has no resolvable package.json', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({
      cwd: join(fixtures, 'nm-no-pkg'),
      entries: ['src/A.sol'],
      mappingFile: 'remappings.txt',
    }),
    /No package\.json with name\+version found for node_modules\/foo\/X\.sol/,
  )
})

test('buildSolidityBundle reads remappings from a foundry.toml mapping file', async (t) => {
  const cwd = join(fixtures, 'with-foundry-toml')
  const bundle = await buildSolidityBundle({
    cwd,
    entries: ['src/A.sol'],
    mappingFile: 'foundry.toml',
  })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['lib/openzeppelin-contracts/contracts/utils/Math.sol', 'src/A.sol'],
  )
  // foundry.toml itself must NOT appear in the bundle's files
  t.assert.ok(!Object.hasOwn(bundle.modules.get('.').files, 'foundry.toml'))
})

test('buildSolidityBundle resolves Foundry-style project-relative imports without a virtual src/= remapping', async (t) => {
  // src/B.sol imports `src/A.sol` (no `./`, no remapping). The bundle
  // must still pull in A.sol via the project-relative fallback —
  // previously the user had to add a no-op `src/=src/` remapping to
  // make this work.
  const cwd = join(fixtures, 'non-relative-entry')
  const bundle = await buildSolidityBundle({ cwd, entries: ['src/B.sol'] })
  t.assert.deepEqual([...bundle.entries], ['src/B.sol'])
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol'],
  )
  t.assert.equal(
    bundle.imports.get('solidity').get('src/B.sol').get('src/A.sol'),
    'src/A.sol',
  )
})

test('buildSolidityBundle deduplicates files imported by multiple entries', async (t) => {
  const cwd = join(fixtures, 'shared')
  const bundle = await buildSolidityBundle({ cwd, entries: ['src/A.sol', 'src/B.sol'] })
  t.assert.deepEqual([...bundle.entries].toSorted(), ['src/A.sol', 'src/B.sol'])
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol', 'src/Shared.sol'],
  )
})

test('buildSolidityBundle normalises ./src/A.sol-style entries', async (t) => {
  const cwd = join(fixtures, 'basic')
  const bundle = await buildSolidityBundle({ cwd, entries: ['./src/A.sol'] })
  t.assert.deepEqual([...bundle.entries], ['src/A.sol'])
})

test('buildSolidityBundle rejects an empty entry list', async (t) => {
  await t.assert.rejects(() => buildSolidityBundle({ cwd: join(fixtures, 'basic'), entries: [] }), /at least one entry/)
})

test('buildSolidityBundle rejects non-.sol entries', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({ cwd: join(fixtures, 'basic'), entries: ['src/A.txt'] }),
    /not a \.sol file/,
  )
})

test('buildSolidityBundle rejects entries that escape baseDir', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({ cwd: join(fixtures, 'basic'), entries: ['../missing/src/A.sol'] }),
    /Entry escapes baseDir/,
  )
})

test('buildSolidityBundle throws on an unresolved import (spec has no remapping or relative match)', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({ cwd: join(fixtures, 'missing'), entries: ['src/A.sol'] }),
    /Solidity bundle has unresolved imports[\s\S]*@missing\/Nope\.sol/u,
  )
})

test('buildSolidityBundle throws when a remapped target is missing on disk', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({
      cwd: join(fixtures, 'missing-on-disk'),
      entries: ['src/A.sol'],
      mappingFile: 'remappings.txt',
    }),
    /Solidity bundle has unresolved imports[\s\S]*@oz\/X\.sol/u,
  )
})

test('buildSolidityBundle throws when an entry file is missing on disk', async (t) => {
  await t.assert.rejects(
    () => buildSolidityBundle({ cwd: join(fixtures, 'basic'), entries: ['src/DoesNotExist.sol'] }),
    /Missing entry: src\/DoesNotExist\.sol/,
  )
})

test('outermostDir returns the longest common parent directory, relative to cwd', (t) => {
  const cwd = '/cwd'
  t.assert.equal(outermostDir(['src/A.sol', 'src/B.sol'], cwd), 'src')
  t.assert.equal(outermostDir(['src/a/A.sol', 'src/a/b/B.sol'], cwd), 'src/a')
  t.assert.equal(outermostDir(['src/A.sol', 'lib/B.sol'], cwd), '.')
  t.assert.equal(outermostDir(['A.sol', 'B.sol'], cwd), '.')
  t.assert.equal(outermostDir(['src/A.sol'], cwd), 'src')
  t.assert.equal(outermostDir([], cwd), '.')
})

test('outermostDir handles paths that escape cwd (e.g. via a remapping with ../)', (t) => {
  // src/A.sol stays inside cwd; ../deps/B.sol goes one level above cwd.
  // Their common ancestor is one level above cwd → ".." relative to cwd.
  t.assert.equal(outermostDir(['src/A.sol', '../deps/B.sol'], '/cwd'), '..')
  // Two files both above cwd at distinct grandparents → fall back to '/'.
  t.assert.equal(outermostDir(['../../A.sol', '../../B.sol'], '/cwd/sub'), '../..')
  // Single file above cwd: outermost is that file's directory.
  t.assert.equal(outermostDir(['../deps/B.sol'], '/cwd'), '../deps')
})

test('bundleCommand writes a brotli-compressed stasis Bundle that round-trips through Bundle.parseCode', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(fixtures, 'basic'), entries: ['src/A.sol'], output: outPath })
  const buf = readFileSync(outPath)
  // First byte of plain JSON is '{' (0x7b); brotli output must not start with that.
  t.assert.notEqual(buf[0], 0x7b)
  const text = brotliDecompressSync(buf).toString('utf8')
  const parsed = Bundle.parseCode(text)
  t.assert.deepEqual([...parsed.entries], ['src/A.sol'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol'],
  )
  t.assert.equal(parsed.imports.get('solidity').get('src/A.sol').get('./B.sol'), 'src/B.sol')
}))

test('bundleCommand creates intermediate directories for the output path', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'nested', 'deeper', 'out.stasis.code.br')
  await bundleCommand({ cwd: join(fixtures, 'basic'), entries: ['src/A.sol'], output: outPath })
  const text = brotliDecompressSync(readFileSync(outPath)).toString('utf8')
  t.assert.ok(text.includes('"src/A.sol"'))
}))

test('bundleCommand does not write the output file when bundling fails on unresolved imports', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await t.assert.rejects(
    () => bundleCommand({ cwd: join(fixtures, 'missing'), entries: ['src/A.sol'], output: outPath }),
    /Solidity bundle has unresolved imports/,
  )
  t.assert.ok(!existsSync(outPath), 'no output should be written when bundling fails')
}))

// CLI integration

test('CLI: bundle with no files prints usage', (t) => {
  const r = runCli(['bundle'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to bundle/)
})

test('CLI: bundle rejects an arg with an unsupported extension', (t) => {
  const r = runCli(['bundle', 'foo.txt'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /must all be \.sol or all be \.js\/\.cjs\/\.mjs/)
})

test('CLI: bundle rejects mixing .sol and .js entries', (t) => {
  const r = runCli(['bundle', 'a.sol', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /must all be \.sol or all be \.js\/\.cjs\/\.mjs/)
})

test('CLI: bundle rejects --mapping when entries are JS', (t) => {
  const r = runCli(['bundle', '--mapping=remappings.txt', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--mapping is only valid for \.sol bundles/)
})

test('CLI: bundle rejects --scope when entries are .sol', (t) => {
  const r = runCli(['bundle', '--scope=full', 'a.sol'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--scope is only valid for JS bundles/)
})

test('CLI: bundle exits non-zero and writes no output when there are unresolved imports', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.sol'], { cwd: join(fixtures, 'missing') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Solidity bundle has unresolved imports/)
  t.assert.match(r.stderr, /@missing\/Nope\.sol/)
  t.assert.ok(!existsSync(outPath), 'output file must not be written when bundling fails')
}))

test('CLI: bundle writes a brotli-compressed Bundle to stdout when no -o is given', (t) => {
  // Capture stdout as binary; spawnSync's encoding option here is 'buffer'.
  const r = spawnSync(process.execPath, [cli, 'bundle', 'src/A.sol'], {
    cwd: join(fixtures, 'basic'),
    env: cleanEnv,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr.toString('utf8')}`)
  t.assert.notEqual(r.stdout[0], 0x7b, 'stdout must be brotli, not JSON')
  const parsed = Bundle.parseCode(brotliDecompressSync(r.stdout).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.sol'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol'],
  )
})

test('CLI: bundle -o writes a brotli-compressed Bundle to the given path', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.sol'], { cwd: join(fixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const buf = readFileSync(outPath)
  t.assert.notEqual(buf[0], 0x7b)
  const parsed = Bundle.parseCode(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.sol'])
}))

test('CLI: bundle --mapping=remappings.txt resolves @-prefixed imports', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=remappings.txt', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-remappings-txt') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['lib/openzeppelin-contracts/contracts/utils/Math.sol', 'src/A.sol'],
  )
  t.assert.ok(!Object.hasOwn(parsed.modules.get('.').files, 'remappings.txt'))
}))

test('CLI: bundle --mapping=foundry.toml resolves @-prefixed imports', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=foundry.toml', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-foundry-toml') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['lib/openzeppelin-contracts/contracts/utils/Math.sol', 'src/A.sol'],
  )
  t.assert.ok(!Object.hasOwn(parsed.modules.get('.').files, 'foundry.toml'))
}))

test('CLI: bundle prints a summary line to stderr with the file count, outermost dir, and destination', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.sol'], { cwd: join(fixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, new RegExp(`\\[stasis\\] Bundled 2 files from src to ${outPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
}))

test('CLI: bundle summary falls back to <stdout> when no -o is given', (t) => {
  const r = spawnSync(process.execPath, [cli, 'bundle', 'src/A.sol'], {
    cwd: join(fixtures, 'basic'),
    env: cleanEnv,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr.toString('utf8')}`)
  t.assert.match(r.stderr.toString('utf8'), /\[stasis\] Bundled 2 files from src to <stdout>/)
})

test('CLI: bundle summary shows "." as outermost dir when files share no common parent', withTmp((t, tmp) => {
  // with-remappings-txt has files under both src/ and lib/, so the common parent is "."
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=remappings.txt', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-remappings-txt') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Bundled 2 files from \. to /)
}))

test('CLI: bundle summary counts files across workspace AND node_modules buckets', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=remappings.txt', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-node-modules') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  // 3 files total: src/A.sol + node_modules/foo/X.sol + node_modules/@oz/contracts/utils/Math.sol
  // Outermost shared parent is the project root ".".
  t.assert.match(r.stderr, /\[stasis\] Bundled 3 files from \. to /)
}))

test('CLI: bundle accepts multiple .sol entries', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '-o', outPath, 'src/A.sol', 'src/B.sol'],
    { cwd: join(fixtures, 'shared') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries].toSorted(), ['src/A.sol', 'src/B.sol'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol', 'src/Shared.sol'],
  )
}))

// --- Regression: JS bundle correctness fixes ---

const cjsFixture = join(here, 'fixtures', 'cli-run-cjs')

// Regression: `stasis bundle` for JS used to construct State with bundle='add',
// which made the State constructor MERGE any pre-existing stasis.code.br on
// disk. The merged-in formats/imports entries leaked into the new bundle,
// silently attributing the previous build's files and edges to the new one.
// Fix: build with bundle='replace' to skip the on-disk merge entirely.
test('CLI: bundle (JS) does not inherit stale formats/imports from a pre-existing stasis.code.br', withTmp((t, tmp) => {
  // Set up a tiny scope=full fixture so we can build two distinct bundles in the
  // same directory and observe the second's contents.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'stale-test', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  const srcDir = join(tmp, 'src')
  mkdtempSync(srcDir + '_') // ensure mkdir helper works
  rmSync(srcDir + '_', { recursive: true, force: true })
  writeFileSync(join(tmp, 'seed.js'), "import './seedlib.js'\n")
  writeFileSync(join(tmp, 'seedlib.js'), 'export const x = 1\n')
  writeFileSync(join(tmp, 'entry.js'), 'export const y = 2\n')

  // First bundle: writes stasis.code.br with seed.js + seedlib.js.
  const bundlePath = join(tmp, 'stasis.code.br')
  const r1 = runCli(['bundle', `--output=${bundlePath}`, 'seed.js'], { cwd: tmp })
  t.assert.equal(r1.status, 0, `first bundle stderr: ${r1.stderr}`)

  // Second bundle: same dir, different entry (entry.js, no seedlib dependency).
  const r2 = runCli(['bundle', `--output=${bundlePath}`, 'entry.js'], { cwd: tmp })
  t.assert.equal(r2.status, 0, `second bundle stderr: ${r2.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)).toString('utf-8'))
  t.assert.deepEqual([...decoded.entries].toSorted(), ['entry.js'],
    'second bundle must not carry the first bundle\'s entries')
  // formats and imports must NOT mention seed.js / seedlib.js
  t.assert.ok(!Object.keys(decoded.formats).includes('seed.js'),
    `stale formats leaked: ${Object.keys(decoded.formats).join(', ')}`)
  t.assert.ok(!Object.keys(decoded.formats).includes('seedlib.js'),
    `stale formats leaked: ${Object.keys(decoded.formats).join(', ')}`)
  for (const byParent of Object.values(decoded.imports)) {
    t.assert.ok(!Object.keys(byParent).includes('seed.js'),
      `stale imports leaked: ${Object.keys(byParent).join(', ')}`)
  }
}))

// Regression: passing `--scope=full` to `stasis bundle` against a project
// whose stasis.config.json said `{"scope":"node_modules"}` used to be SILENTLY
// IGNORED. Config.loadConfig overwrote the constructor option but only
// asserted env-vs-file conflicts. Fix: also assert constructor-option-vs-file
// conflict (symmetric with the env check).
test('CLI: bundle --scope conflicting with stasis.config.json errors instead of silently winning', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'scope-test', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'node_modules' }))
  writeFileSync(join(tmp, 'entry.js'), 'console.log(1)\n')

  const r = runCli(['bundle', '--scope=full', '--output=snap.br', 'entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'should error on --scope vs config disagreement')
  t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json|node_modules.*full|full.*node_modules/,
    `expected conflict error in stderr, got: ${r.stderr}`)
}))

// Regression: state.getImport used to `assert.ok(file)` on a missing edge,
// producing `code: 'ERR_ASSERTION'`. Plain Node throws `ERR_MODULE_NOT_FOUND`
// for the same failure. ESM dynamic-import callers commonly do
//   try { await import(x) } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e }
// and that guard would re-throw on the bundle's ERR_ASSERTION.
test('CLI: bundle load surfaces ERR_MODULE_NOT_FOUND for dynamic import of a missing module', withTmp((t, tmp) => {
  cpSync(cjsFixture, tmp, { recursive: true })
  // Replace the entry with one that catches ERR_MODULE_NOT_FOUND specifically.
  const entry = join(tmp, 'src', 'entry.cjs')
  writeFileSync(entry,
    "(async () => {\n" +
    "  try { await import('not-installed') }\n" +
    "  catch (e) { console.log(JSON.stringify({ code: e.code })) }\n" +
    "})()\n",
  )

  const bundlePath = join(tmp, 'snap.br')
  const build = runCli(['bundle', `--output=${bundlePath}`, 'src/entry.cjs'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)

  // cjsFixture ships a stasis.lock.json; use lock=ignore so `stasis run` tolerates it.
  // The fixture's stasis.config.json declares scope=full, which is now the CLI default
  // since ed41d6f flipped --full into the implicit default. No scope flag needed.
  const load = runCli(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  const printed = JSON.parse(load.stdout.trim())
  t.assert.equal(printed.code, 'ERR_MODULE_NOT_FOUND',
    `expected ERR_MODULE_NOT_FOUND, got ${printed.code} -- the previous ERR_ASSERTION re-threw out of common guards`)
}))

// --- Regression: JS bundle must fail closed on holes in the static ESM graph ---
//
// `stasis bundle file.mjs` where file.mjs is `export * from "@noble/ciphers/_arx.js"`
// and the dep can't be resolved used to warn on stderr but still exit 0 and write
// a bundle containing just file.mjs. A static ESM `import`/`export ... from` edge
// links before any user code runs, so nothing can catch the failure at load time:
// the bundle was guaranteed broken. require()/dynamic import() edges stay
// warn-only -- those failures are catchable at runtime (see the test above).

const jsProject = (tmp, files, pkg = { name: 'fail-closed', version: '0.0.0', type: 'module' }) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(tmp, name), content)
}

test('CLI: bundle (JS) fails closed when an export-from edge cannot be resolved', withTmp((t, tmp) => {
  jsProject(tmp, { 'file.mjs': 'export * from "@noble/ciphers/_arx.js"\n' })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'file.mjs'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'must exit non-zero on an unresolved static export-from')
  t.assert.match(r.stderr, /JS bundle would be broken at load time/)
  t.assert.match(r.stderr, /unresolved export-from @noble\/ciphers\/_arx\.js from .*file\.mjs \(MODULE_NOT_FOUND\)/)
  t.assert.ok(!existsSync(outPath), 'output file must not be written when bundling fails')
}))

test('CLI: bundle (JS) fails closed when a static import edge cannot be resolved', withTmp((t, tmp) => {
  jsProject(tmp, { 'entry.mjs': "import './missing.mjs'\n" })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.mjs'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'must exit non-zero on an unresolved static import')
  t.assert.match(r.stderr, /JS bundle would be broken at load time/)
  t.assert.match(r.stderr, /unresolved import \.\/missing\.mjs from .*entry\.mjs/)
  t.assert.ok(!existsSync(outPath))
}))

test('CLI: bundle (JS) fails closed when a statically-imported module file does not parse', withTmp((t, tmp) => {
  // broken.mjs resolves fine (the file exists), but oxc can't parse it -- its
  // static edges are unknown, so the graph may have holes we can't enumerate.
  // oxc recovers from syntax errors instead of throwing, so this used to be
  // COMPLETELY silent (no warning at all, unlike the unresolved-edge case).
  jsProject(tmp, {
    'entry.mjs': "import './broken.mjs'\n",
    'broken.mjs': 'export const x = {\n',
  })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.mjs'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'must exit non-zero when a statically-linked module file fails to parse')
  t.assert.match(r.stderr, /JS bundle would be broken at load time/)
  t.assert.match(r.stderr, /parse error in .*broken\.mjs/)
  t.assert.ok(!existsSync(outPath))
}))

test('CLI: bundle (JS) salvages edges from a CJS file with a top-level return (valid in Node, parse error in oxc)', withTmp((t, tmp) => {
  // Node's module wrapper makes a top-level `return` legal in CJS; oxc reports
  // it as an error but its recovered AST keeps the require() calls. The bundle
  // must include the whole chain and only warn -- a hard failure here would
  // reject code that runs (and previously bundled) fine.
  jsProject(tmp, {
    'entry.cjs': "require('./guard.cjs')\n",
    'guard.cjs': "if (!process.env.NEVER) return\nmodule.exports = require('./extra.cjs')\n",
    'extra.cjs': 'module.exports = 1\n',
  })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.cjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /file\(s\) with parse errors; their recorded imports may be incomplete/)
  t.assert.match(r.stderr, /guard\.cjs/)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf-8'))
  t.assert.deepEqual(Object.keys(decoded.sources['.'].files).toSorted(), ['entry.cjs', 'extra.cjs', 'guard.cjs'],
    'the require edge inside the parse-error file must be salvaged and walked')
}))

test('CLI: bundle (JS) tolerates a missing static import behind a dynamic import() boundary', withTmp((t, tmp) => {
  // The optional-adapter pattern: a statically-broken subtree entered via
  // `await import()` surfaces as the dynamic import's rejection -- catchable,
  // and plain node takes the fallback branch. Only static-ESM-only paths from
  // an entry are uncatchable; this one must warn and keep bundling.
  jsProject(tmp, {
    'entry.mjs': "let impl\ntry { impl = await import('./optional.mjs') } catch { impl = { name: 'fallback' } }\nconsole.log(impl.name)\n",
    'optional.mjs': "import 'not-installed-pkg'\nexport const name = 'optional'\n",
  })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.mjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /unresolved import\(s\); they will fall through at load time/)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf-8'))
  t.assert.deepEqual(Object.keys(decoded.sources['.'].files).toSorted(), ['entry.mjs', 'optional.mjs'])
}))

test('CLI: bundle (JS) fails closed when an edge resolves to a file a source bundle cannot carry', withTmp((t, tmp) => {
  // require('./tool') of an extensionless file works in plain node, but scan
  // records the edge without ever bundling the target (not a RESOLVABLE ext).
  // This used to exit 0 with NO warning at all -- the import map pointed at a
  // file with no source behind it, dead at load via state.getFile's assert.
  jsProject(tmp, {
    'entry.cjs': "require('./tool')\n",
    'tool': 'console.log("tool")\n',
  })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.cjs'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'must exit non-zero on an edge the bundle cannot carry')
  t.assert.match(r.stderr, /JS bundle would be broken at load time/)
  t.assert.match(r.stderr, /\.\/tool from .*entry\.cjs resolves to .*tool, which a source bundle can't carry/)
  t.assert.ok(!existsSync(outPath))
}))

test('CLI: bundle (JS) fails loudly when the oxc-parser peer dependency is missing', withTmp((t, tmp) => {
  // The original bug report's root cause: stasis installed without its
  // optional oxc-parser peer. getParser()'s throw was caught by the per-file
  // parse handler, so every file scanned as a silent zero-edge leaf -- the CLI
  // bundled just the entry and exited 0 with no warning at all. The setup
  // error must propagate with its install hint instead. Exercised against a
  // copy of stasis with no node_modules in scope, so the lazy peer lookup
  // (createRequire from src/scan.js) genuinely misses.
  const stasisCopy = join(tmp, 'stasis')
  mkdirSync(stasisCopy)
  for (const entry of ['bin', 'src']) cpSync(join(here, '..', entry), join(stasisCopy, entry), { recursive: true })
  cpSync(join(here, '..', 'package.json'), join(stasisCopy, 'package.json'))
  const proj = join(tmp, 'proj')
  mkdirSync(proj)
  jsProject(proj, { 'file.mjs': 'export * from "@noble/ciphers/_arx.js"\n' })

  const outPath = join(proj, 'out.br')
  const r = spawnSync(
    process.execPath,
    [join(stasisCopy, 'bin', 'stasis.js'), 'bundle', `--output=${outPath}`, 'file.mjs'],
    { encoding: 'utf-8', env: cleanEnv, cwd: proj },
  )
  t.assert.notEqual(r.status, 0, 'must exit non-zero when the parser peer is missing')
  t.assert.match(r.stderr, /oxc-parser peer dependency/)
  t.assert.doesNotMatch(r.stderr, /Bundled \d+ files/, 'must not pretend a bundle was produced')
  t.assert.ok(!existsSync(outPath), 'no bundle must be written without a parser')
}))

test('CLI: bundle (JS) honors Node module-syntax detection for ambiguous .js and the bundle loads', withTmp((t, tmp) => {
  // No "type" in package.json: plain node (detect-module) runs ESM-syntax .js
  // as ESM. The bundle used to record format=commonjs for dep.js, so loading
  // it died with "does not provide an export named ..." while plain node ran
  // the same entry fine.
  jsProject(tmp, {
    'entry.mjs': "import { x } from './dep.js'\nconsole.log(x)\n",
    'dep.js': 'export const x = 42\n',
  }, { name: 'detect-module', version: '0.0.0' })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.mjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf-8'))
  t.assert.equal(decoded.formats['dep.js'], 'module',
    'ambiguous .js with module syntax must be recorded as ESM, matching plain node')

  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${outPath}`, 'entry.mjs'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, '42\n')
}))

test('CLI: bundle (JS) still warns and writes the bundle for an unresolved require()', withTmp((t, tmp) => {
  // try/catch-able at runtime: the runtime loader never records this edge
  // either, and the user's catch handles the miss at load time exactly as it
  // handles MODULE_NOT_FOUND without a bundle. Must stay warn-only.
  jsProject(tmp, { 'entry.cjs': "try { require('not-installed-pkg') } catch {}\n" })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.cjs'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /unresolved import\(s\); they will fall through at load time/)
  t.assert.match(r.stderr, /require not-installed-pkg from .*entry\.cjs \(MODULE_NOT_FOUND\)/)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf-8'))
  t.assert.deepEqual(Object.keys(decoded.sources['.'].files), ['entry.cjs'])
}))
