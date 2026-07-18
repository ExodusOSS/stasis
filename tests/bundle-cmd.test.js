import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import {
  buildBashBundle,
  buildBundle,
  buildPhpBundle,
  buildRustBundle,
  buildSolidityBundle,
  bundleCommand,
  outermostDir,
} from '../stasis/src/cmd/bundle.js'
import { diffCommand } from '../stasis/src/cmd/diff.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures', 'solidity-bundle')
const bashFixtures = join(here, 'fixtures', 'bash-bundle')
const rustFixtures = join(here, 'fixtures', 'rust-bundle')
const phpFixtures = join(here, 'fixtures', 'php-bundle')
const conditionsFixture = join(here, 'fixtures', 'bundle-conditions')
const fieldsFixture = join(here, 'fixtures', 'resolve-fields')

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

  // Workspace bucket: name+version from the project's own package.json, and
  // no `ecosystem` — it's the top-level code, not a dependency.
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'my-app')
  t.assert.equal(workspace.version, '0.1.0')
  t.assert.equal(workspace.ecosystem, undefined)
  t.assert.deepEqual(Object.keys(workspace.files), ['src/A.sol'])

  // Unscoped node_modules package: a dependency. It resolves out of
  // node_modules — npm's install layout — so its ecosystem is `npm`, not anything
  // Solidity-specific.
  const foo = bundle.modules.get('node_modules/foo')
  t.assert.equal(foo.name, 'foo')
  t.assert.equal(foo.version, '1.2.3')
  t.assert.equal(foo.ecosystem, 'npm')
  t.assert.deepEqual(Object.keys(foo.files), ['X.sol'])

  // Scoped node_modules package; rel path preserves the deep subdir.
  const oz = bundle.modules.get('node_modules/@oz/contracts')
  t.assert.equal(oz.name, '@oz/contracts')
  t.assert.equal(oz.version, '5.0.0')
  t.assert.equal(oz.ecosystem, 'npm')
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

test('buildSolidityBundle attributes Soldeer deps as `soldeer` and github-submodule libs as `github`', async (t) => {
  const cwd = join(fixtures, 'with-deps-ecosystems')
  const bundle = await buildSolidityBundle({
    cwd,
    entries: ['src/A.sol'],
    mappingFile: 'remappings.txt',
  })

  // Each non-npm dependency lands in its own install-dir bucket, alongside the
  // workspace "." bucket — none folds into the workspace anymore.
  t.assert.deepEqual(
    [...bundle.modules.keys()].toSorted(),
    ['.', 'dependencies/solmate-6.8.0', 'lib/openzeppelin-contracts'],
  )

  // Workspace: the entry, no ecosystem.
  t.assert.equal(bundle.modules.get('.').ecosystem, undefined)
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files), ['src/A.sol'])

  // Soldeer: name/version parsed from the `dependencies/<name>-<version>` dir.
  const soldeer = bundle.modules.get('dependencies/solmate-6.8.0')
  t.assert.equal(soldeer.name, 'solmate')
  t.assert.equal(soldeer.version, '6.8.0')
  t.assert.equal(soldeer.ecosystem, 'soldeer')
  t.assert.deepEqual(Object.keys(soldeer.files), ['src/Token.sol'])

  // forge git submodule with a github.com URL in .gitmodules → ecosystem
  // `github`, named with the Package-URL `owner/repo` slug. No package.json or
  // branch here, so the version falls back to 0.0.0.
  const oz = bundle.modules.get('lib/openzeppelin-contracts')
  t.assert.equal(oz.name, 'OpenZeppelin/openzeppelin-contracts')
  t.assert.equal(oz.version, '0.0.0')
  t.assert.equal(oz.ecosystem, 'github')
  t.assert.deepEqual(Object.keys(oz.files), ['contracts/utils/Math.sol'])
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

test('bundleCommand writes a brotli-compressed stasis Bundle that round-trips through Bundle.parse', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(fixtures, 'basic'), entries: ['src/A.sol'], output: outPath })
  const buf = readFileSync(outPath)
  // First byte of plain JSON is '{' (0x7b); brotli output must not start with that.
  t.assert.notEqual(buf[0], 0x7b)
  const text = brotliDecompressSync(buf).toString('utf8')
  const parsed = Bundle.parse(text)
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
  t.assert.match(r.stderr, /bundle entries must all be \.sol/)
})

test('CLI: bundle rejects mixing .sol and .js entries', (t) => {
  const r = runCli(['bundle', 'a.sol', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /bundle entries must all be \.sol/)
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

test('CLI: bundle writes a brotli-compressed Bundle to stasis.code.br by default when no -o is given', withTmp((t, tmp) => {
  // Copy the fixture into a temp dir so the default-named artifact lands there
  // (and never pollutes the repo's fixtures).
  cpSync(join(fixtures, 'basic'), tmp, { recursive: true })
  const r = runCli(['bundle', 'src/A.sol'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const buf = readFileSync(join(tmp, 'stasis.code.br'))
  t.assert.notEqual(buf[0], 0x7b, 'output must be brotli, not JSON')
  const parsed = Bundle.parse(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.sol'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol'],
  )
}))

test('CLI: bundle writes a brotli-compressed Bundle to stdout with --output=-', (t) => {
  // Capture stdout as binary; spawnSync's encoding option here is 'buffer'.
  // --output=- writes nothing to disk, so running in the read-only fixture is safe.
  const r = spawnSync(process.execPath, [cli, 'bundle', '--output=-', 'src/A.sol'], {
    cwd: join(fixtures, 'basic'),
    env: cleanEnv,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr.toString('utf8')}`)
  t.assert.notEqual(r.stdout[0], 0x7b, 'stdout must be brotli, not JSON')
  t.assert.ok(!existsSync(join(fixtures, 'basic', 'stasis.code.br')), '--output=- must not write a file')
  const parsed = Bundle.parse(brotliDecompressSync(r.stdout).toString('utf8'))
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
  const parsed = Bundle.parse(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.sol'])
}))

test('CLI: bundle --mapping=remappings.txt resolves @-prefixed imports', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=remappings.txt', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-remappings-txt') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  t.assert.match(r.stderr, new RegExp(`\\[stasis\\] Bundled 2 files in 1 package from src to ${outPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
}))

test('CLI: bundle summary names stasis.code.br as the destination when no -o is given', withTmp((t, tmp) => {
  cpSync(join(fixtures, 'basic'), tmp, { recursive: true })
  const r = runCli(['bundle', 'src/A.sol'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Bundled 2 files in 1 package from src to stasis\.code\.br/)
}))

test('CLI: bundle summary falls back to <stdout> with --output=-', (t) => {
  const r = spawnSync(process.execPath, [cli, 'bundle', '--output=-', 'src/A.sol'], {
    cwd: join(fixtures, 'basic'),
    env: cleanEnv,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr.toString('utf8')}`)
  t.assert.match(r.stderr.toString('utf8'), /\[stasis\] Bundled 2 files in 1 package from src to <stdout>/)
})

test('CLI: bundle summary shows "." as outermost dir when files share no common parent', withTmp((t, tmp) => {
  // with-remappings-txt has files under both src/ and lib/, so the common parent is "."
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '--mapping=remappings.txt', '-o', outPath, 'src/A.sol'],
    { cwd: join(fixtures, 'with-remappings-txt') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Bundled 2 files in 1 package from \. to /)
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
  t.assert.match(r.stderr, /\[stasis\] Bundled 3 files in 3 packages from \. to /)
}))

test('CLI: bundle accepts multiple .sol entries', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(
    ['bundle', '-o', outPath, 'src/A.sol', 'src/B.sol'],
    { cwd: join(fixtures, 'shared') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries].toSorted(), ['src/A.sol', 'src/B.sol'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.sol', 'src/B.sol', 'src/Shared.sol'],
  )
}))

// --- PHP bundles ---

test('buildPhpBundle produces a Bundle with sources, formats, imports, entries', async (t) => {
  const cwd = join(phpFixtures, 'basic')
  const bundle = await buildPhpBundle({ cwd, entries: ['src/A.php'] })

  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual(bundle.config, { scope: 'full' })
  t.assert.deepEqual([...bundle.entries], ['src/A.php'])

  // No package.json anywhere in the basic fixture → fallback bucket "."
  t.assert.deepEqual([...bundle.modules.keys()], ['.'])
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'php-bundle')
  t.assert.equal(workspace.version, '0.0.0')
  t.assert.deepEqual(Object.keys(workspace.files).toSorted(), ['src/A.php', 'src/B.php'])
  t.assert.equal(workspace.files['src/A.php'], readFileSync(join(cwd, 'src/A.php'), 'utf8'))

  // Every loaded file gets a 'php' format tag.
  t.assert.equal(bundle.formats.get('src/A.php'), 'php')
  t.assert.equal(bundle.formats.get('src/B.php'), 'php')

  // Includes live under the "php" condition key (not the JS-bundle "*").
  t.assert.deepEqual([...bundle.imports.keys()], ['php'])
  t.assert.equal(bundle.imports.get('php').get('src/A.php').get('./B.php'), 'src/B.php')
})

test('buildPhpBundle takes the workspace name+version from the nearest composer.json', async (t) => {
  const cwd = join(phpFixtures, 'with-composer-json')
  const bundle = await buildPhpBundle({ cwd, entries: ['src/A.php'] })
  t.assert.deepEqual([...bundle.modules.keys()], ['.'])
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'my-php-app')
  t.assert.equal(workspace.version, '2.1.0')
  t.assert.deepEqual(Object.keys(workspace.files).toSorted(), ['src/A.php', 'src/B.php'])
})

test('buildPhpBundle resolves bare includes file- and project-relative', async (t) => {
  const cwd = join(phpFixtures, 'bare')
  const bundle = await buildPhpBundle({ cwd, entries: ['index.php'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['helpers.php', 'index.php', 'lib/Util.php'],
  )
  const resolutions = bundle.imports.get('php').get('index.php')
  t.assert.equal(resolutions.get('helpers.php'), 'helpers.php')
  t.assert.equal(resolutions.get('lib/Util.php'), 'lib/Util.php')
})

test('buildPhpBundle follows nested ../ includes across subdirectories', async (t) => {
  const cwd = join(phpFixtures, 'nested')
  const bundle = await buildPhpBundle({ cwd, entries: ['src/A.php'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/A.php', 'src/C.php', 'src/sub/B.php'],
  )
  t.assert.equal(bundle.imports.get('php').get('src/A.php').get('./sub/B.php'), 'src/sub/B.php')
  t.assert.equal(bundle.imports.get('php').get('src/sub/B.php').get('../C.php'), 'src/C.php')
})

test('buildPhpBundle follows the Composer autoload graph and bundles only referenced classes', async (t) => {
  const cwd = join(phpFixtures, 'composer')
  const bundle = await buildPhpBundle({ cwd, entries: ['index.php'] })
  const files = [...bundle.sources.keys()].toSorted()

  // Explicit includes (vendor/autoload.php + the composer machinery it requires)
  // AND autoloaded classes reachable from index.php's references.
  t.assert.deepEqual(files, [
    'index.php',
    'src/Helper.php', // same-namespace reference, no `use`
    'src/Legacy/Thing.php', // resolved via the classmap
    'src/Repo/UserRepo.php', // PSR-4 (root)
    'src/Service.php', // `use App\Service` + `new Service()`
    'src/helpers.php', // `files` autoload (unconditional)
    'vendor/acme/lib/src/Client.php', // PSR-4 (vendor)
    'vendor/autoload.php',
    'vendor/composer/autoload_classmap.php',
    'vendor/composer/autoload_files.php',
    'vendor/composer/autoload_psr4.php',
    'vendor/composer/autoload_real.php',
  ])

  // Vendor dependencies are grouped into their own per-package bucket with
  // name+version (name from composer.json, version from installed.json), not
  // dumped under "."; the workspace bucket takes the root composer.json's name.
  t.assert.equal(bundle.modules.get('.').name, 'acme/app')
  const lib = bundle.modules.get('vendor/acme/lib')
  t.assert.equal(lib.name, 'acme/lib')
  t.assert.equal(lib.version, '1.4.2')
  t.assert.deepEqual(Object.keys(lib.files), ['src/Client.php'])
  t.assert.ok(!Object.keys(bundle.modules.get('.').files).includes('vendor/acme/lib/src/Client.php'))

  // The two classes that exist + are resolvable via the autoload maps but are
  // never referenced must NOT be bundled: an unused `use` import (Ghost) and a
  // class present in both the PSR-4 tree and the classmap (Orphan).
  t.assert.ok(!files.includes('src/Unused/Ghost.php'), 'unused `use` import must not be bundled')
  t.assert.ok(!files.includes('src/Orphan.php'), 'unreferenced classmap/PSR-4 class must not be bundled')

  // Autoloaded classes are tagged `php` and recorded as edges keyed by FQCN.
  t.assert.equal(bundle.formats.get('vendor/acme/lib/src/Client.php'), 'php')
  const edges = bundle.imports.get('php').get('src/Service.php')
  t.assert.equal(edges.get('Vendor\\Acme\\Client'), 'vendor/acme/lib/src/Client.php')
  t.assert.equal(edges.get('App\\Helper'), 'src/Helper.php')
  t.assert.equal(edges.get('Legacy\\Thing'), 'src/Legacy/Thing.php')
  t.assert.ok(!edges.has('App\\Unused\\Ghost'))
})

test('buildPhpBundle bundles the static directory of a dynamic include', async (t) => {
  // index.php has a static `require __DIR__ . '/bootstrap.php'` and a dynamic
  // `require __DIR__ . '/modules/' . $name . '.php'`. The dynamic target is only
  // known at runtime, so every modules/*.php is bundled as a candidate (the
  // non-.php modules/notes.txt is not), and the bundle succeeds.
  const cwd = join(phpFixtures, 'dynamic-include')
  const bundle = await buildPhpBundle({ cwd, entries: ['index.php'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['bootstrap.php', 'index.php', 'modules/admin.php', 'modules/default.php'],
  )
})

test('buildPhpBundle bundles dir-anchored .php paths passed as arguments (Laravel routes)', async (t) => {
  // bootstrap/app.php passes route files to the framework via `web:`/`api:` args
  // (no `require` keyword). They must still be bundled; the static `require` of
  // providers.php is too, while `dirname(__DIR__)` (a dir) and `'/up'` are not.
  const cwd = join(phpFixtures, 'path-refs')
  const bundle = await buildPhpBundle({ cwd, entries: ['bootstrap/app.php'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['bootstrap/app.php', 'bootstrap/providers.php', 'routes/api.php', 'routes/web.php'],
  )
})

test('buildPhpBundle bundles files referenced via Laravel path helpers (base_path, config_path)', async (t) => {
  // BroadcastServiceProvider does `require base_path('routes/channels.php')` and
  // `require config_path('broadcasting.php')` -- root-relative paths the
  // framework loads. Both must be bundled.
  const cwd = join(phpFixtures, 'path-helpers')
  const bundle = await buildPhpBundle({ cwd, entries: ['app/Providers/BroadcastServiceProvider.php'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['app/Providers/BroadcastServiceProvider.php', 'config/broadcasting.php', 'routes/channels.php'],
  )
})

test('buildPhpBundle follows auto-discovered Laravel providers and the files they reference', async (t) => {
  // The entry (public/index.php) references no providers; they are discovered
  // from vendor/composer/installed.json (extra.laravel.providers) and
  // bootstrap/providers.php. The config files those providers publish via
  // config_path(...) -- which previously went unbundled -- are now included.
  const cwd = join(phpFixtures, 'laravel-providers')
  const bundle = await buildPhpBundle({ cwd, entries: ['public/index.php'] })
  const files = new Set(bundle.sources.keys())
  t.assert.deepEqual([...bundle.entries], ['public/index.php'])
  // Auto-discovered providers (vendor + app) are reached.
  t.assert.ok(files.has('vendor/spatie/laravel-ignition/src/IgnitionServiceProvider.php'))
  t.assert.ok(files.has('app/Providers/AppServiceProvider.php'))
  // The top-level config files referenced via config_path() are bundled.
  t.assert.ok(files.has('config/ignition.php'))
  t.assert.ok(files.has('config/flare.php'))
  // The vendor package is grouped under its own bucket.
  t.assert.equal(bundle.modules.get('vendor/spatie/laravel-ignition').name, 'spatie/laravel-ignition')
})

test('buildPhpBundle deduplicates files included by multiple entries', async (t) => {
  const cwd = join(phpFixtures, 'shared')
  const bundle = await buildPhpBundle({ cwd, entries: ['src/A.php', 'src/B.php'] })
  t.assert.deepEqual([...bundle.entries].toSorted(), ['src/A.php', 'src/B.php'])
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/A.php', 'src/B.php', 'src/Shared.php'],
  )
})

test('buildPhpBundle normalises ./src/A.php-style entries', async (t) => {
  const bundle = await buildPhpBundle({ cwd: join(phpFixtures, 'basic'), entries: ['./src/A.php'] })
  t.assert.deepEqual([...bundle.entries], ['src/A.php'])
})

test('buildPhpBundle rejects an empty entry list', async (t) => {
  await t.assert.rejects(() => buildPhpBundle({ cwd: join(phpFixtures, 'basic'), entries: [] }), /at least one entry/)
})

test('buildPhpBundle rejects non-.php entries', async (t) => {
  await t.assert.rejects(
    () => buildPhpBundle({ cwd: join(phpFixtures, 'basic'), entries: ['src/A.txt'] }),
    /not a \.php file/,
  )
})

test('buildPhpBundle rejects entries that escape baseDir', async (t) => {
  await t.assert.rejects(
    () => buildPhpBundle({ cwd: join(phpFixtures, 'basic'), entries: ['../missing/src/A.php'] }),
    /Entry escapes baseDir/,
  )
})

test('buildPhpBundle throws on an unresolved include', async (t) => {
  await t.assert.rejects(
    () => buildPhpBundle({ cwd: join(phpFixtures, 'missing'), entries: ['src/A.php'] }),
    /PHP bundle has unresolved imports[\s\S]*Nope\.php/u,
  )
})

test('buildPhpBundle throws when an entry file is missing on disk', async (t) => {
  await t.assert.rejects(
    () => buildPhpBundle({ cwd: join(phpFixtures, 'basic'), entries: ['src/DoesNotExist.php'] }),
    /Missing entry: src\/DoesNotExist\.php/,
  )
})

test('bundleCommand writes a brotli-compressed PHP Bundle that round-trips through Bundle.parse', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(phpFixtures, 'basic'), entries: ['src/A.php'], output: outPath })
  const buf = readFileSync(outPath)
  t.assert.notEqual(buf[0], 0x7b)
  const parsed = Bundle.parse(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.php'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.php', 'src/B.php'],
  )
  t.assert.equal(parsed.formats.get('src/A.php'), 'php')
  t.assert.equal(parsed.imports.get('php').get('src/A.php').get('./B.php'), 'src/B.php')
}))

// CLI integration (PHP)

test('CLI: bundle accepts .php entries and writes a Bundle', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.php'], { cwd: join(phpFixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/A.php'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/A.php', 'src/B.php'],
  )
}))

test('CLI: bundle rejects mixing .php and .js entries', (t) => {
  const r = runCli(['bundle', 'a.php', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /bundle entries must all be \.sol/)
})

test('CLI: bundle rejects --mapping when entries are PHP', (t) => {
  const r = runCli(['bundle', '--mapping=remappings.txt', 'a.php'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--mapping is only valid for \.sol bundles/)
})

test('CLI: bundle rejects --scope when entries are .php', (t) => {
  const r = runCli(['bundle', '--scope=full', 'a.php'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--scope is only valid for JS bundles/)
})

test('CLI: bundle rejects --lockfile when entries are .php', (t) => {
  const r = runCli(['bundle', '--lockfile=stasis.lock.json', 'a.php'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--lockfile is only valid for JS bundles/)
})

test('CLI: bundle (php) exits non-zero and writes no output when there are unresolved includes', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.php'], { cwd: join(phpFixtures, 'missing') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /PHP bundle has unresolved imports/)
  t.assert.match(r.stderr, /Nope\.php/)
  t.assert.ok(!existsSync(outPath), 'output file must not be written when bundling fails')
}))

test('CLI: bundle (php) prints a summary line with the file count, outermost dir, and destination', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/A.php'], { cwd: join(phpFixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, new RegExp(`\\[stasis\\] Bundled 2 files in 1 package from src to ${outPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
}))

// --- TypeScript entries: *.ts/.cts/.mts behave like JS files ---

const tsFixture = join(here, 'fixtures', 'cli-run-ts')

test('CLI: bundle accepts a .ts entry and records type-stripping formats', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/entry.ts'], { cwd: tsFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] Bundled 2 files in 1 package from src to /)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/entry.ts'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['src/entry.ts', 'src/hello.ts'],
  )
  // Sources are stored verbatim (types intact); Node strips them at load time.
  t.assert.equal(
    parsed.modules.get('.').files['src/hello.ts'],
    readFileSync(join(tsFixture, 'src/hello.ts'), 'utf8'),
  )
  t.assert.equal(parsed.formats.get('src/entry.ts'), 'module-typescript')
  t.assert.equal(parsed.formats.get('src/hello.ts'), 'module-typescript')
  t.assert.equal(parsed.imports.get('*').get('src/entry.ts').get('./hello.ts'), 'src/hello.ts')
}))

test('CLI: bundle allows mixing .ts and .js entries (both are JS-family)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-js-mix', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'a.ts'), 'export const a: number = 1\n')
  writeFileSync(join(tmp, 'b.js'), 'export const b = 2\n')
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'a.ts', 'b.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries].toSorted(), ['a.ts', 'b.js'])
  t.assert.equal(parsed.formats.get('a.ts'), 'module-typescript')
  t.assert.equal(parsed.formats.get('b.js'), 'module')
}))

test('CLI: bundle rejects mixing .sol and .ts entries', (t) => {
  const r = runCli(['bundle', 'a.sol', 'b.ts'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /must all be \.sol, all be \.php, all be \.js\/\.cjs\/\.mjs\/\.ts\/\.cts\/\.mts/)
})

test('CLI: a bundled .ts entry runs via --bundle=load, serving ESM TS sources from the bundle', withTmp((t, tmp) => {
  cpSync(tsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snap.br')
  const build = runCli(['bundle', `--output=${bundlePath}`, 'src/entry.ts'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)

  // ESM resolution goes fully through the hooks, so the imported file can be
  // served from the bundle even when it no longer exists on disk.
  rmSync(join(tmp, 'src', 'hello.ts'))
  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.ts'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('CLI: a .ts entry with ESM syntax in a typeless package bundles with the detected format and runs via --bundle=load', withTmp((t, tmp) => {
  // No `type` field: Node decides by module-syntax detection. The bundle must
  // record module-typescript (matching Node), not commonjs-typescript derived
  // from the package default — the CJS-TS translator would throw
  // "Cannot use import statement outside a module" on these sources.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-detect', version: '0.0.0' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'entry.ts'), 'import { greet } from "./hello.ts"\nconsole.log(greet("detected"))\n')
  writeFileSync(join(tmp, 'hello.ts'), 'export const greet = (name: string): string => `hello, ${name}`\n')

  const bundlePath = join(tmp, 'snap.br')
  const build = runCli(['bundle', `--output=${bundlePath}`, 'entry.ts'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(bundlePath)).toString('utf8'))
  t.assert.equal(parsed.formats.get('entry.ts'), 'module-typescript')
  t.assert.equal(parsed.formats.get('hello.ts'), 'module-typescript')

  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'entry.ts'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, detected\n')
}))

test('CLI: a commonjs-typescript bundle (.ts requiring .cts) runs via --bundle=load', withTmp((t, tmp) => {
  // No `type` in package.json → .ts is commonjs-typescript, like .js → commonjs.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-cjs', version: '0.0.0' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  writeFileSync(join(tmp, 'entry.ts'), 'const { greet }: { greet: (n: string) => string } = require("./hello.cts")\nconsole.log(greet("cjs"))\n')
  writeFileSync(join(tmp, 'hello.cts'), 'exports.greet = (name: string): string => `hello, ${name}`\n')

  const bundlePath = join(tmp, 'snap.br')
  const build = runCli(['bundle', `--output=${bundlePath}`, 'entry.ts'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(bundlePath)).toString('utf8'))
  t.assert.equal(parsed.formats.get('entry.ts'), 'commonjs-typescript')
  t.assert.equal(parsed.formats.get('hello.cts'), 'commonjs-typescript')

  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'entry.ts'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, cjs\n')
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

// --- Conditions-aware JS bundling (`--conditions`) ---
//
// `--conditions` adds resolution conditions on top of the base set Node always
// asserts, so a package whose `exports` gate on them resolves to a different file
// -- and a different file lands in the bundle. The bundle-conditions fixture's
// `rnpkg` exports { react-native, browser, default }; with no extra conditions the
// scan falls through to `default`, matching plain Node. (Conditions alone don't
// honour legacy package mainFields or platform-specific file suffixes.)
const rnpkgFiles = (bundle) => [...bundle.sources.keys()].filter((f) => f.includes('rnpkg'))

test('buildBundle (JS) follows the default exports branch when no conditions are given', async (t) => {
  const bundle = await buildBundle({ cwd: conditionsFixture, entries: ['src/entry.js'] })
  t.assert.deepEqual(rnpkgFiles(bundle), ['node_modules/rnpkg/default.js'],
    'no extra conditions -> resolves like plain Node (default branch)')
})

test('buildBundle (JS) follows the react-native exports branch under conditions=[react-native]', async (t) => {
  const bundle = await buildBundle({ cwd: conditionsFixture, entries: ['src/entry.js'], conditions: ['react-native'] })
  t.assert.deepEqual(rnpkgFiles(bundle), ['node_modules/rnpkg/rn.js'],
    'the react-native condition selects the react-native export, not default')
})

test('buildBundle (JS) follows the browser exports branch under conditions=[browser]', async (t) => {
  const bundle = await buildBundle({ cwd: conditionsFixture, entries: ['src/entry.js'], conditions: ['browser'] })
  t.assert.deepEqual(rnpkgFiles(bundle), ['node_modules/rnpkg/browser.js'])
})

test('buildBundle rejects conditions for non-JS entries', async (t) => {
  await t.assert.rejects(
    () => buildBundle({ cwd: join(fixtures, 'basic'), entries: ['src/A.sol'], conditions: ['react-native'] }),
    /--conditions is only valid for JS bundles/,
  )
})

test('CLI: bundle --conditions selects the matching exports branch', withTmp((t, tmp) => {
  const out = join(tmp, 'snap.br')
  const r = runCli(['bundle', '--conditions=react-native,browser', `--output=${out}`, 'src/entry.js'], { cwd: conditionsFixture })
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  const files = [...parsed.sources.keys()].filter((f) => f.includes('rnpkg'))
  // react-native is listed before browser in rnpkg's exports, so it wins.
  t.assert.deepEqual(files, ['node_modules/rnpkg/rn.js'])
}))

test('CLI: bundle without --conditions resolves like plain Node (default branch)', withTmp((t, tmp) => {
  const out = join(tmp, 'snap.br')
  const r = runCli(['bundle', `--output=${out}`, 'src/entry.js'], { cwd: conditionsFixture })
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  const files = [...parsed.sources.keys()].filter((f) => f.includes('rnpkg'))
  t.assert.deepEqual(files, ['node_modules/rnpkg/default.js'])
}))

test('CLI: bundle rejects --conditions for .sol entries', (t) => {
  const r = runCli(['bundle', '--conditions=react-native', 'a.sol'])
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /--conditions is only valid for JS bundles/)
})

test('CLI: bundle rejects an empty --conditions value', (t) => {
  const r = runCli(['bundle', '--conditions=', 'src/entry.js'], { cwd: conditionsFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /--conditions must list at least one condition name/)
})

test('CLI: a --conditions bundle round-trips through --bundle=load with the selected file', withTmp((t, tmp) => {
  // Build under react-native, then delete the branches it did NOT select; the bundle
  // must still load and run from its own bytes. This is exactly the wildcard-`*` keying
  // guarantee -- plain node at load never passes the react-native condition, so load
  // depends on getImport's `*` fallback resolving to the conditions-selected file.
  cpSync(conditionsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  const build = runCli(['bundle', '--conditions=react-native', `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)
  rmSync(join(tmp, 'node_modules', 'rnpkg', 'default.js'))
  rmSync(join(tmp, 'node_modules', 'rnpkg', 'browser.js'))
  const load = runCli(['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'RN\n')
}))

test('CLI: bundle --conditions --lockfile attests the conditions-selected resolution', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snap.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  const r = runCli(['bundle', '--conditions=react-native', `--lockfile=${lockPath}`, `--output=${bundlePath}`, 'src/entry.js'], { cwd: conditionsFixture })
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  // The companion lockfile records the react-native target, not the default branch.
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  t.assert.equal(lock.imports['*']['src/entry.js'].rnpkg, 'node_modules/rnpkg/rn.js')
}))

// --- Legacy-field / Metro resolution (`--mainFields`, `--metro --platforms`) ---
//
// These drive the legacy-field resolver (tests/resolve-fields.test.js covers it in
// isolation). The relevant fixtures live under tests/fixtures/resolve-fields:
// `entryfields` (mainFields entry), `redir` (browser object map incl. false->empty),
// `exportswins` (exports beats a browser main field), and platform-suffixed Button.*.
// A `--mainFields` edge is always flat; a `--metro` edge unflattens to a
// `{ platform: target }` map where the requested platforms diverge.
const importTarget = (bundle, parent, spec) => {
  const t = bundle.imports.get('*').get(parent).get(spec)
  return t instanceof Map ? Object.fromEntries(t) : t
}

test('buildBundle --mainFields resolves entry fields, browser redirects, and empty stubs (flat edges)', async (t) => {
  const bundle = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], mainFields: ['react-native', 'browser', 'main'] })
  const files = new Set(bundle.sources.keys())
  // entryfields picks its react-native entry; exportswins' exports beats its browser field.
  t.assert.ok(files.has('node_modules/entryfields/rn.js'))
  t.assert.ok(files.has('node_modules/exportswins/def.js'), 'no react-native condition here -> exports default')
  // browser object map: ./node-only.js -> browser-only.js; ./gone.js (relative) and the
  // bare `leftpad` (false) -> the synthetic empty module.
  t.assert.equal(importTarget(bundle, 'node_modules/redir/index.js', './node-only.js'), 'node_modules/redir/browser-only.js')
  t.assert.equal(importTarget(bundle, 'node_modules/redir/index.js', './gone.js'), '.stasis/empty-module.js')
  t.assert.equal(importTarget(bundle, 'node_modules/redir/index.js', 'leftpad'), '.stasis/empty-module.js')
  // The empty module is carried as a real, empty CJS file (attestable bytes).
  t.assert.equal(bundle.sources.get('.stasis/empty-module.js'), '')
  t.assert.equal(bundle.formats.get('.stasis/empty-module.js'), 'commonjs')
})

test('buildBundle --metro bundles every platform at once: union files, divergent edges unflatten', async (t) => {
  const bundle = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], metro: true, platforms: ['ios', 'android'] })
  const files = new Set(bundle.sources.keys())
  // Both platform variants are carried (the file set is the union across platforms).
  t.assert.ok(files.has('src/Button.ios.js') && files.has('src/Button.android.js'))
  // The divergent edge unflattens to a { platform: file } map keyed by the supplied platforms.
  t.assert.deepEqual(importTarget(bundle, 'src/entry.js', './Button'), {
    android: 'src/Button.android.js',
    ios: 'src/Button.ios.js',
  })
  // An edge every platform agrees on stays flat. (--metro asserts react-native, so exports wins -> rn.js.)
  t.assert.equal(importTarget(bundle, 'src/entry.js', 'exportswins'), 'node_modules/exportswins/rn.js')
})

test('buildBundle --metro with a single platform never unflattens (stays flat)', async (t) => {
  const bundle = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], metro: true, platforms: ['ios'] })
  t.assert.equal(importTarget(bundle, 'src/entry.js', './Button'), 'src/Button.ios.js')
})

test('buildBundle --metro: a base .js can appear when one platform resolves to it', async (t) => {
  // ios resolves Button.ios.js; web has no Button.web.js and excludes .native, so it
  // resolves the base Button.js -- the edge unflattens and the base file is carried.
  const bundle = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], metro: true, platforms: ['ios', 'web'] })
  t.assert.deepEqual(importTarget(bundle, 'src/entry.js', './Button'), {
    ios: 'src/Button.ios.js',
    web: 'src/Button.js',
  })
  t.assert.ok([...bundle.sources.keys()].includes('src/Button.js'))
})

test('CLI: bundle --metro --platforms writes a bundle + lockfile that round-trip with the platform map', withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  const lock = join(tmp, 'metro.lock.json')
  const r = runCli(
    ['bundle', '--metro', '--platforms=ios,android', `--lockfile=${lock}`, `--output=${out}`, 'src/entry.js'],
    { cwd: fieldsFixture },
  )
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  t.assert.deepEqual(Object.fromEntries(bundle.imports.get('*').get('src/entry.js').get('./Button')), {
    android: 'src/Button.android.js',
    ios: 'src/Button.ios.js',
  })
  // The companion lockfile attests the same per-platform edge (by integrity).
  const lockfile = Lockfile.parse(readFileSync(lock, 'utf8'))
  const lt = lockfile.imports.get('*').get('src/entry.js').get('./Button')
  t.assert.ok(lt instanceof Map)
  t.assert.deepEqual(Object.fromEntries(lt), { android: 'src/Button.android.js', ios: 'src/Button.ios.js' })
}))

test('CLI: --platforms accepts repeats and comma lists, unioned', withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  const r = runCli(
    ['bundle', '--metro', '--platforms=ios', '--platforms=ios,android', `--output=${out}`, 'src/entry.js'],
    { cwd: fieldsFixture },
  )
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  // Both platforms took effect (the edge unflattened across ios+android).
  t.assert.deepEqual(Object.keys(Object.fromEntries(bundle.imports.get('*').get('src/entry.js').get('./Button'))), ['android', 'ios'])
}))

test('CLI: a --metro multi-platform bundle fails closed under plain --bundle=load', withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,android', `--output=${out}`, 'src/entry.js'], { cwd: fieldsFixture }).status, 0)
  // Plain node has no platform context to pick a per-platform edge -> clear error, not a crash.
  const load = runCli(['run', '--lock=none', '--bundle=load', `--bundle-file=${out}`, 'src/entry.js'], { cwd: fieldsFixture })
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /platform-specific|ERR_STASIS_PLATFORM_SPECIFIC/)
}))

test('CLI: a --metro bundle verifies clean against its own companion lockfile at load (no ERR_ASSERTION)', withTmp((t, tmp) => {
  cpSync(fieldsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,android', `--lockfile=${lockPath}`, `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp }).status, 0)
  // `--lock=frozen` loads the bundle AND verifies it against the companion lockfile, so
  // the constructor cross-checks every edge; a per-platform edge is a Map on BOTH sides
  // and must compare STRUCTURALLY -- not throw ERR_ASSERTION on identical-but-distinct
  // Maps. The verification passes clean, then it fails closed at getImport (no platform
  // context) with the clean platform-specific error -- never an assertion mismatch.
  const load = runCli(['run', '--bundle=load', '--lock=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /platform-specific|ERR_STASIS_PLATFORM_SPECIFIC/)
  t.assert.doesNotMatch(load.stderr, /ERR_ASSERTION|mismatches the lockfile/)
}))

test('CLI: --metro requires --platforms; --platforms requires --metro; --metro forbids --conditions/--mainFields', (t) => {
  t.assert.match(runCli(['bundle', '--metro', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /--metro requires --platforms/)
  t.assert.match(runCli(['bundle', '--platforms=ios', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /--platforms is only valid with --metro/)
  t.assert.match(runCli(['bundle', '--metro', '--platforms=ios', '--conditions=x', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /--conditions can't be combined with --metro/)
  t.assert.match(runCli(['bundle', '--metro', '--platforms=ios', '--mainFields=browser', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /--mainFields can't be combined with --metro/)
  t.assert.match(runCli(['bundle', '--metro', '--platforms=ios', 'a.sol']).stderr, /--metro is only valid for JS bundles/)
})

test('--platforms rejects a name containing / or * (the parsers would refuse the edge key)', async (t) => {
  // A platform name becomes an edge key; Bundle/Lockfile parse reject '/', and '*' is the
  // reserved placeholder. The writer must reject both rather than emit an unreadable bundle.
  t.assert.match(runCli(['bundle', '--metro', '--platforms=ios,x/y', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /invalid --platforms value 'x\/y'/)
  t.assert.match(runCli(['bundle', '--metro', '--platforms=*', 'src/entry.js'], { cwd: fieldsFixture }).stderr, /invalid --platforms value '\*'/)
  await t.assert.rejects(
    () => buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], metro: true, platforms: ['ios', 'x/y'] }),
    /invalid platform 'x\/y'/,
  )
})

test('CLI: diff folds per-platform edges to the resolved-file set (detects a divergent target)', withTmp((t, tmp) => {
  const iosAndroid = join(tmp, 'ios-android.br')
  const iosWeb = join(tmp, 'ios-web.br')
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,android', `--output=${iosAndroid}`, 'src/entry.js'], { cwd: fieldsFixture }).status, 0)
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,web', `--output=${iosWeb}`, 'src/entry.js'], { cwd: fieldsFixture }).status, 0)
  // ./Button is a per-platform Map on BOTH sides (ios+android vs ios+web); the FOLD is
  // what surfaces the divergence -- folded target sets {Button.ios.js, Button.android.js}
  // vs {Button.ios.js, Button.js} differ. Without the fold both Maps contribute nothing
  // and the edge would read unchanged, so assert it IS reported as a changed import.
  const stub = { write() {} }
  const { diff } = diffCommand({ left: iosAndroid, right: iosWeb, stat: true, imports: true, out: stub })
  const buttonChange = diff.imports.changed.find((c) => c.parent === 'src/entry.js' && c.specifier === './Button')
  t.assert.ok(buttonChange, './Button must be reported as a changed import')
  // The FOLD reduces each side's per-platform Map to its resolved-file SET; assert those
  // exact sets, so the test fails if the fold is removed (the targets would be raw Maps).
  t.assert.deepEqual(new Set(buttonChange.from), new Set(['src/Button.android.js', 'src/Button.ios.js']))
  t.assert.deepEqual(new Set(buttonChange.to), new Set(['src/Button.ios.js', 'src/Button.js']))
  // A --metro bundle still diffs clean against an identical copy (no false positives).
  const copy = join(tmp, 'copy.br')
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,android', `--output=${copy}`, 'src/entry.js'], { cwd: fieldsFixture }).status, 0)
  t.assert.equal(diffCommand({ left: iosAndroid, right: copy, stat: true, imports: true, out: stub }).differences, false)
}))

test('CLI: extract unpacks a --metro multi-platform bundle (both variants + a platform-keyed lockfile)', withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  t.assert.equal(runCli(['bundle', '--metro', '--platforms=ios,android', `--output=${out}`, 'src/entry.js'], { cwd: fieldsFixture }).status, 0)
  const dir = join(tmp, 'ex')
  t.assert.equal(runCli(['extract', `--output=${dir}`, out]).status, 0)
  t.assert.ok(existsSync(join(dir, 'src', 'Button.ios.js')) && existsSync(join(dir, 'src', 'Button.android.js')))
  const lock = JSON.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual(lock.imports['*']['src/entry.js']['./Button'], { android: 'src/Button.android.js', ios: 'src/Button.ios.js' })
}))

// --- Metro async-import helper injection (`--metro` + dynamic import()) --------------
//
// Metro's transform rewrites every dynamic `import()` callsite into
// `require(<transformer.asyncRequireModulePath>)(...)` -- default
// metro-runtime/src/modules/asyncRequire -- so the helper is a real dependency of every
// async-importing module and ships in the bundle WITHOUT any source file naming it.
// `--metro` mirrors that injection (see injectMetroAsyncRequire); these fixtures carry a
// hoisted metro-runtime stub plus a NESTED copy under lazydep, so the per-parent
// resolution (exactly how Metro resolves the injected dependency) is observable.
const ASYNC_REQUIRE = 'metro-runtime/src/modules/asyncRequire'

test("buildBundle --metro: a dynamic import() pulls in Metro's async-import helper, resolved per parent", async (t) => {
  const bundle = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry-async.js'], metro: true, platforms: ['ios', 'android'] })
  const files = new Set(bundle.sources.keys())
  // Both copies ship: the helper resolves from each async-importing module (as Metro
  // resolves the injected dependency), so workspace code lands on the hoisted copy and
  // lazydep's own dynamic import lands on its nested one.
  t.assert.ok(files.has('node_modules/metro-runtime/src/modules/asyncRequire.js'))
  t.assert.ok(files.has('node_modules/lazydep/node_modules/metro-runtime/src/modules/asyncRequire.js'))
  // The injected edges mirror what a runtime StasisMetro capture of the real Metro
  // graph records: (parent, <asyncRequireModulePath>) -> resolved helper. Same target
  // on every platform -> flat edge.
  t.assert.equal(importTarget(bundle, 'src/entry-async.js', ASYNC_REQUIRE), 'node_modules/metro-runtime/src/modules/asyncRequire.js')
  t.assert.equal(importTarget(bundle, 'node_modules/lazydep/index.js', ASYNC_REQUIRE), 'node_modules/lazydep/node_modules/metro-runtime/src/modules/asyncRequire.js')
  // The dynamic-import targets themselves keep their ordinary edges and files.
  t.assert.equal(importTarget(bundle, 'src/entry-async.js', './lazy.js'), 'src/lazy.js')
  t.assert.ok(files.has('src/lazy.js') && files.has('node_modules/lazydep/inner.js'))
  // The helper copies bucketize as ordinary npm packages, each under its own dir.
  t.assert.equal(bundle.modules.get('node_modules/metro-runtime').version, '0.80.0')
  t.assert.equal(bundle.modules.get('node_modules/lazydep/node_modules/metro-runtime').version, '0.79.0')
})

test('buildBundle --metro: no dynamic import() -> no helper injected; --mainFields never injects', async (t) => {
  // src/entry.js has no dynamic import anywhere in its graph.
  const noAsync = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], metro: true, platforms: ['ios', 'android'] })
  t.assert.ok(![...noAsync.sources.keys()].some((f) => f.includes('metro-runtime')))
  // --mainFields models plain legacy-field resolution, not Metro's transform: the same
  // async-importing entry gets no injection there.
  const mf = await buildBundle({ cwd: fieldsFixture, entries: ['src/entry-async.js'], mainFields: ['react-native', 'browser', 'main'] })
  t.assert.ok(![...mf.sources.keys()].some((f) => f.includes('metro-runtime')))
  t.assert.equal(mf.imports.get('*').get('src/entry-async.js').get(ASYNC_REQUIRE), undefined)
})

test('buildBundle --metro --asyncRequireModulePath overrides the helper; injection runs to a fixpoint', async (t) => {
  // Mirrors a Metro config that swaps `transformer.asyncRequireModulePath` (as Expo
  // does). asyncshim itself dynamic-imports ./extra.js, so it must get its OWN injected
  // edge -- onto itself -- and pull extra.js in: the fixpoint case.
  const bundle = await buildBundle({
    cwd: fieldsFixture, entries: ['src/entry-async.js'], metro: true, platforms: ['ios'],
    asyncRequireModulePath: 'asyncshim',
  })
  const files = new Set(bundle.sources.keys())
  t.assert.ok(files.has('node_modules/asyncshim/index.js') && files.has('node_modules/asyncshim/extra.js'))
  t.assert.ok(![...files].some((f) => f.includes('metro-runtime')), 'the default helper must not also be injected')
  t.assert.equal(importTarget(bundle, 'src/entry-async.js', 'asyncshim'), 'node_modules/asyncshim/index.js')
  t.assert.equal(importTarget(bundle, 'node_modules/asyncshim/index.js', 'asyncshim'), 'node_modules/asyncshim/index.js')
  t.assert.equal(importTarget(bundle, 'node_modules/asyncshim/index.js', './extra.js'), 'node_modules/asyncshim/extra.js')
})

test('buildBundle --metro fails closed when the async-import helper is not installed', withTmp(async (t, tmp) => {
  // A dynamic import() means Metro WOULD ship the helper; a bundle silently missing it
  // would leave shipped code unattested, so the build must refuse instead.
  writeFileSync(join(tmp, 'package.json'), '{ "name": "no-mr", "version": "0.0.0", "type": "module", "private": true }\n')
  mkdirSync(join(tmp, 'src'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'entry.js'), 'export const p = import("./lazy.js")\n')
  writeFileSync(join(tmp, 'src', 'lazy.js'), 'export default 1\n')
  await t.assert.rejects(
    () => buildBundle({ cwd: tmp, entries: ['src/entry.js'], metro: true, platforms: ['ios'] }),
    /Can't resolve Metro's async-import helper 'metro-runtime\/src\/modules\/asyncRequire'/u,
  )
}))

test('CLI: bundle --metro --lockfile attests the injected async-import helper and its edge', withTmp((t, tmp) => {
  const out = join(tmp, 'metro.br')
  const lock = join(tmp, 'metro.lock.json')
  const r = runCli(
    ['bundle', '--metro', '--platforms=ios,android', `--lockfile=${lock}`, `--output=${out}`, 'src/entry-async.js'],
    { cwd: fieldsFixture },
  )
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  t.assert.equal(bundle.imports.get('*').get('src/entry-async.js').get(ASYNC_REQUIRE), 'node_modules/metro-runtime/src/modules/asyncRequire.js')
  t.assert.equal(bundle.sources.get('node_modules/metro-runtime/src/modules/asyncRequire.js'), readFileSync(join(fieldsFixture, 'node_modules/metro-runtime/src/modules/asyncRequire.js'), 'utf8'))
  // The companion lockfile attests the same edge and the helper's integrity.
  const lockfile = Lockfile.parse(readFileSync(lock, 'utf8'))
  t.assert.equal(lockfile.imports.get('*').get('src/entry-async.js').get(ASYNC_REQUIRE), 'node_modules/metro-runtime/src/modules/asyncRequire.js')
  t.assert.match(lockfile.modules.get('node_modules/metro-runtime').files['src/modules/asyncRequire.js'], /^sha512-/u)
}))

test('CLI: --asyncRequireModulePath requires --metro and a non-empty specifier', async (t) => {
  t.assert.match(
    runCli(['bundle', '--asyncRequireModulePath=asyncshim', 'src/entry-async.js'], { cwd: fieldsFixture }).stderr,
    /--asyncRequireModulePath is only valid with --metro/u,
  )
  t.assert.match(
    runCli(['bundle', '--metro', '--platforms=ios', '--asyncRequireModulePath=', 'src/entry-async.js'], { cwd: fieldsFixture }).stderr,
    /--asyncRequireModulePath must name a module specifier/u,
  )
  await t.assert.rejects(
    () => buildBundle({ cwd: fieldsFixture, entries: ['src/entry-async.js'], mainFields: ['main'], asyncRequireModulePath: 'asyncshim' }),
    /--asyncRequireModulePath is only valid with --metro/u,
  )
})

test('CLI: bundle --mainFields rejects a non-JS bundle and an empty value', (t) => {
  t.assert.match(runCli(['bundle', '--mainFields=browser', 'a.sol']).stderr, /--mainFields is only valid for JS bundles/)
  const empty = runCli(['bundle', '--mainFields=', 'src/entry.js'], { cwd: fieldsFixture })
  t.assert.notEqual(empty.status, 0)
  t.assert.match(empty.stderr, /--mainFields must list at least one field/)
})

test('--mainFields rejects --scope (the field resolver always builds a full-scope bundle)', async (t) => {
  const r = runCli(['bundle', '--scope=node_modules', '--mainFields=browser', 'src/entry.js'], { cwd: fieldsFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /--scope is not supported with --mainFields/)
  await t.assert.rejects(
    () => buildBundle({ cwd: fieldsFixture, entries: ['src/entry.js'], mainFields: ['browser'], scope: 'node_modules' }),
    /--scope is not supported with --mainFields/,
  )
})

test('CLI: bundle --mainFields --lockfile attests the resolved (incl. empty-stub) edges', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snap.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  const r = runCli(['bundle', '--mainFields=react-native,browser,main', `--lockfile=${lockPath}`, `--output=${bundlePath}`, 'src/entry.js'], { cwd: fieldsFixture })
  t.assert.equal(r.status, 0, `bundle stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const redir = lock.imports['*']['node_modules/redir/index.js']
  t.assert.equal(redir['./node-only.js'], 'node_modules/redir/browser-only.js')
  t.assert.equal(redir['./gone.js'], '.stasis/empty-module.js')
  t.assert.equal(redir['leftpad'], '.stasis/empty-module.js')
  // The empty module is attested as a real (empty) file in the workspace bucket.
  t.assert.ok(lock.sources['.'].files['.stasis/empty-module.js'], 'empty module carries an integrity')
}))

test('CLI: a --mainFields bundle round-trips through --bundle=load (empty module + redirects from bundle)', withTmp((t, tmp) => {
  cpSync(fieldsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  const build = runCli(['bundle', '--mainFields=react-native,browser,main', `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)
  // Prove the browser redirect and the synthetic empty module come from the bundle, not
  // disk: drop the redirected-away file (its target browser-only.js stays), and note
  // `leftpad` was never installed -- its `false` redirect can only resolve to the
  // bundle's empty module.
  rmSync(join(tmp, 'node_modules', 'redir', 'node-only.js'))
  const load = runCli(['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'ok\n')
}))

test('--mainFields fails closed on a node_modules symlink whose target escapes the project root', withTmp((t, tmp) => {
  // A dependency symlinked to a real file OUTSIDE the project root must not pull
  // out-of-tree bytes into the bundle: the resolved path is realpath'd and rejected,
  // the same way the State-based JS path and the non-JS loaders do.
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'evil.js'), 'module.exports = "external"\n')
    mkdirSync(join(tmp, 'node_modules', 'extdep'), { recursive: true })
    writeFileSync(join(tmp, 'node_modules', 'extdep', 'package.json'), JSON.stringify({ name: 'extdep', version: '1.0.0', main: './index.js' }))
    symlinkSync(join(outside, 'evil.js'), join(tmp, 'node_modules', 'extdep', 'index.js'))
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }))
    writeFileSync(join(tmp, 'app.js'), "require('extdep')\n")
    const r = runCli(['bundle', '--mainFields=browser,main', '--output=out.br', 'app.js'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /escaping bundle root/)
    t.assert.ok(!existsSync(join(tmp, 'out.br')), 'no bundle is written when a source escapes the root')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('--mainFields bundles a dependency whose main is a directory or a broken path (no silent hole)', withTmp(async (t, tmp) => {
  // Node's LOAD_AS_DIRECTORY: main "./inner/" -> inner/index.js, and a main pointing at a
  // missing file falls back to the package index. A require() of such a package must be
  // BUNDLED -- not dropped with only a warning, which would ship a silently-incomplete bundle.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }))
  writeFileSync(join(tmp, 'app.js'), "require('./local')\nrequire('barebad')\n")
  mkdirSync(join(tmp, 'local', 'inner'), { recursive: true })
  writeFileSync(join(tmp, 'local', 'package.json'), JSON.stringify({ main: './inner/' }))
  writeFileSync(join(tmp, 'local', 'inner', 'index.js'), "module.exports = 'local'\n")
  mkdirSync(join(tmp, 'node_modules', 'barebad'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'barebad', 'package.json'), JSON.stringify({ name: 'barebad', version: '1.0.0', main: './build/index.js' }))
  writeFileSync(join(tmp, 'node_modules', 'barebad', 'index.js'), "module.exports = 'barebad'\n")
  const bundle = await buildBundle({ cwd: tmp, entries: ['app.js'], mainFields: ['browser', 'main'] })
  const files = new Set(bundle.sources.keys())
  t.assert.ok(files.has('local/inner/index.js'), 'directory-main dependency is bundled')
  t.assert.ok(files.has('node_modules/barebad/index.js'), 'broken-main dependency falls back to index and is bundled')
}))

test('--mainFields fails closed when a real reached file occupies the reserved empty-module path', withTmp((t, tmp) => {
  // A `false` browser redirect materialises a synthetic .stasis/empty-module.js; if the
  // project already has a real file there AND it is reached, the bundle must refuse rather
  // than clobber the real bytes with an empty module.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', browser: { leftpad: false } }))
  mkdirSync(join(tmp, '.stasis'), { recursive: true })
  writeFileSync(join(tmp, '.stasis', 'empty-module.js'), "module.exports = 'REAL'\n")
  writeFileSync(join(tmp, 'app.js'), "require('./.stasis/empty-module.js')\nrequire('leftpad')\n")
  const r = runCli(['bundle', '--mainFields=browser,main', '--output=out.br', 'app.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /reserved empty-module path/)
}))

test('--mainFields fails closed on a malformed package.json (does not resolve past it)', withTmp((t, tmp) => {
  // Node throws ERR_INVALID_PACKAGE_CONFIG on a malformed manifest; the field resolver
  // must fail closed too, not silently fall back to index.js (which would resolve where
  // real Node rejects).
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }))
  writeFileSync(join(tmp, 'app.js'), "require('broken')\n")
  mkdirSync(join(tmp, 'node_modules', 'broken'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'broken', 'package.json'), '{ not valid json')
  writeFileSync(join(tmp, 'node_modules', 'broken', 'index.js'), "module.exports = 'broken'\n")
  const r = runCli(['bundle', '--mainFields=browser,main', '--output=out.br', 'app.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Invalid package\.json/)
  t.assert.ok(!existsSync(join(tmp, 'out.br')), 'no bundle written on a malformed manifest')
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

test('CLI: bundle (JS) fails loudly when the oxc-parser dependency is missing', withTmp((t, tmp) => {
  // The original bug report's root cause: stasis installed without oxc-parser.
  // getParser()'s throw was caught by the per-file parse handler, so every file
  // scanned as a silent zero-edge leaf -- the CLI bundled just the entry and
  // exited 0 with no warning at all. The setup error must propagate with its
  // install hint instead. Exercised against a copy of stasis whose node_modules
  // carries only the zero-dep @exodus/stasis-core (so the moved-module shims
  // resolve and the bundle command loads) but no oxc-parser, so the lazy lookup
  // (createRequire from src/scan.js) genuinely misses.
  const stasisCopy = join(tmp, 'stasis')
  mkdirSync(stasisCopy)
  for (const entry of ['bin', 'src']) cpSync(join(here, '..', 'stasis', entry), join(stasisCopy, entry), { recursive: true })
  cpSync(join(here, '..', 'stasis', 'package.json'), join(stasisCopy, 'package.json'))
  // Vendor the zero-dep core so the `@exodus/stasis-core/*` shims resolve;
  // oxc-parser is deliberately left out of this tree.
  const coreDest = join(stasisCopy, 'node_modules', '@exodus', 'stasis-core')
  mkdirSync(coreDest, { recursive: true })
  for (const entry of ['bin', 'src']) cpSync(join(here, '..', 'stasis-core', entry), join(coreDest, entry), { recursive: true })
  cpSync(join(here, '..', 'stasis-core', 'package.json'), join(coreDest, 'package.json'))
  const proj = join(tmp, 'proj')
  mkdirSync(proj)
  jsProject(proj, { 'file.mjs': 'export * from "@noble/ciphers/_arx.js"\n' })

  const outPath = join(proj, 'out.br')
  const r = spawnSync(
    process.execPath,
    [join(stasisCopy, 'bin', 'stasis.js'), 'bundle', `--output=${outPath}`, 'file.mjs'],
    // NODE_PATH could expose an oxc-parser from elsewhere; blank it so the
    // lazy lookup genuinely misses regardless of the host environment.
    { encoding: 'utf-8', env: { ...cleanEnv, NODE_PATH: '' }, cwd: proj },
  )
  t.assert.notEqual(r.status, 0, 'must exit non-zero when the parser is missing')
  // getParser() no longer wraps the failure in a custom message (oxc-parser is a
  // regular dep now); a missing parser surfaces as Node's MODULE_NOT_FOUND, which
  // still names oxc-parser. The point of the test stands: it must fail loudly, not
  // silently bundle just the entry.
  t.assert.match(r.stderr, /oxc-parser/)
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

test('CLI: bundle (JS) detects module via top-level await in ambiguous .js and the bundle loads', withTmp((t, tmp) => {
  // Node's detector counts top-level await as module syntax; oxc's
  // hasModuleSyntax does not. This lazy-load entry runs as ESM in plain node
  // but used to be bundled as format=commonjs -- a parse-error warning, exit
  // 0, then SyntaxError at load: the exact fail-open this branch removes.
  jsProject(tmp, {
    'entry.js': "const lazy = await import('./lazy.js')\nconsole.log('lazy', lazy.v)\n",
    'lazy.js': 'export const v = 42\n',
  }, { name: 'tla', version: '0.0.0' })
  const outPath = join(tmp, 'out.br')
  const r = runCli(['bundle', `--output=${outPath}`, 'entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.doesNotMatch(r.stderr, /parse error/, 'a clean module re-parse must not surface as a parse error')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf-8'))
  t.assert.equal(decoded.formats['entry.js'], 'module',
    'TLA-only ambiguous .js must be recorded as ESM, matching plain node')

  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${outPath}`, 'entry.js'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'lazy 42\n')
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

// --- Bash bundles ---

test('buildBashBundle produces a Bundle with sources, formats, imports, entries', async (t) => {
  const cwd = join(bashFixtures, 'basic')
  const bundle = await buildBashBundle({ cwd, entries: ['main.sh'] })

  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual(bundle.config, { scope: 'full' })
  t.assert.deepEqual([...bundle.entries], ['main.sh'])

  // No package.json → fallback "." bucket with placeholder identity.
  t.assert.deepEqual([...bundle.modules.keys()], ['.'])
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'bash-bundle')
  t.assert.equal(workspace.version, '0.0.0')
  t.assert.deepEqual(Object.keys(workspace.files).toSorted(), ['lib.sh', 'main.sh'])
  t.assert.equal(workspace.files['main.sh'], readFileSync(join(cwd, 'main.sh'), 'utf8'))

  // Every loaded file gets a 'bash' format tag.
  t.assert.equal(bundle.formats.get('main.sh'), 'bash')
  t.assert.equal(bundle.formats.get('lib.sh'), 'bash')

  // Imports live under the "bash" condition key.
  t.assert.deepEqual([...bundle.imports.keys()], ['bash'])
  t.assert.equal(bundle.imports.get('bash').get('main.sh').get('./lib.sh'), 'lib.sh')
})

test('buildBashBundle takes the workspace bucket name/version from package.json', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'with-package-json'), entries: ['main.sh'] })
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'my-scripts')
  t.assert.equal(workspace.version, '2.1.0')
})

test('buildBashBundle follows a multi-level source chain', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'nested'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['a.sh', 'b.sh', 'main.sh'])
  t.assert.equal(bundle.imports.get('bash').get('main.sh').get('./a.sh'), 'a.sh')
  t.assert.equal(bundle.imports.get('bash').get('a.sh').get('./b.sh'), 'b.sh')
})

test('buildBashBundle deduplicates a file sourced by multiple entries', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'shared'), entries: ['a.sh', 'b.sh'] })
  t.assert.deepEqual([...bundle.entries].toSorted(), ['a.sh', 'b.sh'])
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['a.sh', 'b.sh', 'shared.sh'])
})

test('buildBashBundle resolves bash/sh exec references', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'exec'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['helper.sh', 'main.sh', 'worker.sh'])
  const edges = bundle.imports.get('bash').get('main.sh')
  t.assert.equal(edges.get('./worker.sh'), 'worker.sh')
  t.assert.equal(edges.get('helper.sh'), 'helper.sh')
})

test('buildBashBundle resolves direct ./script.sh invocations', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'direct'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['main.sh', 'worker.sh'])
  t.assert.equal(bundle.imports.get('bash').get('main.sh').get('./worker.sh'), 'worker.sh')
})

test('buildBashBundle resolves `# Depends on:` comment hints', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'comment'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['helper.sh', 'main.sh'])
  t.assert.equal(bundle.imports.get('bash').get('main.sh').get('helper.sh'), 'helper.sh')
})

test('buildBashBundle resolves a `${VAR}` source via its `# shellcheck source=` directive', async (t) => {
  // `source "${LIB_DIR}/config.sh"` can't be resolved statically; the
  // `# shellcheck source=../lib/config.sh` directive pins the real location.
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'shellcheck'), entries: ['bin/main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['bin/main.sh', 'lib/config.sh'])
  t.assert.equal(bundle.imports.get('bash').get('bin/main.sh').get('../lib/config.sh'), 'lib/config.sh')
})

test('buildBashBundle resolves ../ references across subdirectories', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'subdir'), entries: ['bin/main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['bin/main.sh', 'lib/helper.sh'])
  t.assert.equal(bundle.imports.get('bash').get('bin/main.sh').get('../lib/helper.sh'), 'lib/helper.sh')
})

test('buildBashBundle bundles local sources but tolerates commands and absolute system paths', async (t) => {
  // main.sh sources ./lib.sh (bundled) plus an absolute /opt/legacy/system.sh and
  // grep/curl/node — none of those is bundled, and none is treated as a missing script.
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'external'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['lib.sh', 'main.sh'])
})

test('buildBashBundle tolerates a ../ source that escapes the bundle root', async (t) => {
  // main.sh sources ./lib.sh (bundled) and ../shared/common.sh (escapes cwd →
  // unbundlable → tolerated as external, not a fatal missing script).
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'escaping'), entries: ['main.sh'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['lib.sh', 'main.sh'])
})

test('buildBashBundle accepts .bash entries', async (t) => {
  const bundle = await buildBashBundle({ cwd: join(bashFixtures, 'dotbash'), entries: ['main.bash'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['lib.sh', 'main.bash'])
  t.assert.equal(bundle.formats.get('main.bash'), 'bash')
})

test('buildBashBundle rejects an empty entry list', async (t) => {
  await t.assert.rejects(() => buildBashBundle({ cwd: join(bashFixtures, 'basic'), entries: [] }), /at least one entry/)
})

test('buildBashBundle rejects non-.sh/.bash entries', async (t) => {
  await t.assert.rejects(
    () => buildBashBundle({ cwd: join(bashFixtures, 'basic'), entries: ['main.js'] }),
    /not a \.sh\/\.bash file/,
  )
})

test('buildBashBundle rejects entries that escape baseDir', async (t) => {
  await t.assert.rejects(
    () => buildBashBundle({ cwd: join(bashFixtures, 'basic'), entries: ['../nested/main.sh'] }),
    /Entry escapes baseDir/,
  )
})

test('buildBashBundle throws when an entry is missing on disk', async (t) => {
  await t.assert.rejects(
    () => buildBashBundle({ cwd: join(bashFixtures, 'basic'), entries: ['nope.sh'] }),
    /Bash bundle has unresolved scripts[\s\S]*nope\.sh/u,
  )
})

test('buildBashBundle throws on an unresolved relative .sh reference (dangling source)', async (t) => {
  await t.assert.rejects(
    () => buildBashBundle({ cwd: join(bashFixtures, 'missing-dep'), entries: ['main.sh'] }),
    /Bash bundle has unresolved scripts[\s\S]*Unresolved script: \.\/gone\.sh from main\.sh/u,
  )
})

test('CLI: bundle (bash) exits non-zero and writes no output on an unresolved script', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'main.sh'], { cwd: join(bashFixtures, 'missing-dep') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Bash bundle has unresolved scripts/)
  t.assert.match(r.stderr, /gone\.sh/)
  t.assert.ok(!existsSync(outPath), 'output must not be written when bundling fails')
}))

test('bundleCommand writes a bash Bundle that round-trips through Bundle.parse', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(bashFixtures, 'basic'), entries: ['main.sh'], output: outPath })
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['main.sh'])
  t.assert.deepEqual(Object.keys(parsed.modules.get('.').files).toSorted(), ['lib.sh', 'main.sh'])
  t.assert.equal(parsed.formats.get('main.sh'), 'bash')
  t.assert.equal(parsed.imports.get('bash').get('main.sh').get('./lib.sh'), 'lib.sh')
}))

test('CLI: bundle writes a brotli-compressed Bundle for a .sh entry', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'main.sh'], { cwd: join(bashFixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const buf = readFileSync(outPath)
  t.assert.notEqual(buf[0], 0x7b)
  const parsed = Bundle.parse(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['main.sh'])
  t.assert.equal(parsed.imports.get('bash').get('main.sh').get('./lib.sh'), 'lib.sh')
}))

test('CLI: bundle rejects mixing .sh and .js entries', (t) => {
  const r = runCli(['bundle', 'a.sh', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /bundle entries must all be \.sol/)
})

test('CLI: bundle rejects --scope for a .sh bundle', (t) => {
  const r = runCli(['bundle', '--scope=full', 'main.sh'], { cwd: join(bashFixtures, 'basic') })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--scope is only valid for JS bundles/)
})

// --- Rust bundles ---

test('buildRustBundle produces a Bundle with sources, formats, imports, entries', async (t) => {
  const cwd = join(rustFixtures, 'basic')
  const bundle = await buildRustBundle({ cwd, entries: ['src/main.rs'] })

  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual(bundle.config, { scope: 'full' })
  t.assert.deepEqual([...bundle.entries], ['src/main.rs'])

  t.assert.deepEqual([...bundle.modules.keys()], ['.'])
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'rust-bundle')
  t.assert.equal(workspace.version, '0.0.0')
  t.assert.deepEqual(Object.keys(workspace.files).toSorted(), ['src/foo.rs', 'src/main.rs'])

  t.assert.equal(bundle.formats.get('src/main.rs'), 'rust')
  t.assert.equal(bundle.formats.get('src/foo.rs'), 'rust')

  t.assert.deepEqual([...bundle.imports.keys()], ['rust'])
  t.assert.equal(bundle.imports.get('rust').get('src/main.rs').get('mod foo'), 'src/foo.rs')
})

test('buildRustBundle records mod edges and crate:: use edges', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'use-crate'), entries: ['src/main.rs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/bar.rs', 'src/foo.rs', 'src/main.rs'])
  const main = bundle.imports.get('rust').get('src/main.rs')
  t.assert.equal(main.get('mod foo'), 'src/foo.rs')
  t.assert.equal(main.get('mod bar'), 'src/bar.rs')
  t.assert.equal(main.get('crate::foo::Greeter'), 'src/foo.rs')
  t.assert.equal(bundle.imports.get('rust').get('src/bar.rs').get('crate::foo::Greeter'), 'src/foo.rs')
})

test('buildRustBundle follows nested mods into stem subdirectories', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'nested'), entries: ['src/main.rs'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/foo.rs', 'src/foo/bar.rs', 'src/main.rs'],
  )
  t.assert.equal(bundle.imports.get('rust').get('src/foo.rs').get('mod bar'), 'src/foo/bar.rs')
})

test('buildRustBundle follows mod.rs-style submodules', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'mod-rs'), entries: ['src/main.rs'] })
  t.assert.deepEqual(
    Object.keys(bundle.modules.get('.').files).toSorted(),
    ['src/foo/bar.rs', 'src/foo/mod.rs', 'src/main.rs'],
  )
})

test('buildRustBundle bundles from a lib.rs crate root', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'lib'), entries: ['src/lib.rs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/bar.rs', 'src/foo.rs', 'src/lib.rs'])
  t.assert.equal(bundle.imports.get('rust').get('src/lib.rs').get('mod foo'), 'src/foo.rs')
  t.assert.equal(bundle.imports.get('rust').get('src/lib.rs').get('mod bar'), 'src/bar.rs')
})

test('buildRustBundle does not follow inline mods', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'inline-mod'), entries: ['src/main.rs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/main.rs', 'src/real.rs'])
})

test('buildRustBundle does not bundle external crates that are not vendored', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'external-crate'), entries: ['src/main.rs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/local.rs', 'src/main.rs'])
})

test('buildRustBundle collects a `cargo vendor` crate into its own bucket tagged `cargo`', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'with-vendored-crate'), entries: ['src/main.rs'] })

  t.assert.deepEqual([...bundle.modules.keys()].toSorted(), ['.', 'vendor/cool-lib'])

  // Workspace: the project's own code, no ecosystem.
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.ecosystem, undefined)
  t.assert.deepEqual(Object.keys(workspace.files).toSorted(), ['src/main.rs', 'src/util.rs'])

  // Vendored crate: reached via `use cool_lib::…` (the on-disk package dir
  // hyphenates the crate's snake_case lib name), bucketed with name/version from
  // its Cargo.toml [package], and tagged `cargo`.
  const crate = bundle.modules.get('vendor/cool-lib')
  t.assert.equal(crate.name, 'cool-lib')
  t.assert.equal(crate.version, '0.4.2')
  t.assert.equal(crate.ecosystem, 'cargo')
  t.assert.deepEqual(Object.keys(crate.files).toSorted(), ['src/inner.rs', 'src/lib.rs'])

  // The cross-crate dependency is recorded as a `use <crate>` edge to its root.
  t.assert.equal(
    bundle.imports.get('rust').get('src/main.rs').get('use cool_lib'),
    'vendor/cool-lib/src/lib.rs',
  )
})

test('buildRustBundle takes the workspace bucket name/version from package.json', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'with-package-json'), entries: ['src/main.rs'] })
  const workspace = bundle.modules.get('.')
  t.assert.equal(workspace.name, 'rusty')
  t.assert.equal(workspace.version, '3.0.0')
})

test('buildRustBundle rejects an empty entry list', async (t) => {
  await t.assert.rejects(() => buildRustBundle({ cwd: join(rustFixtures, 'basic'), entries: [] }), /at least one entry/)
})

test('buildRustBundle rejects non-.rs entries', async (t) => {
  await t.assert.rejects(
    () => buildRustBundle({ cwd: join(rustFixtures, 'basic'), entries: ['src/main.js'] }),
    /not a \.rs file/,
  )
})

test('buildRustBundle throws when an entry is missing on disk', async (t) => {
  await t.assert.rejects(
    () => buildRustBundle({ cwd: join(rustFixtures, 'basic'), entries: ['src/nope.rs'] }),
    /Rust bundle has unresolved modules[\s\S]*nope\.rs/u,
  )
})

test('buildRustBundle throws on an unresolvable mod declaration', async (t) => {
  await t.assert.rejects(
    () => buildRustBundle({ cwd: join(rustFixtures, 'missing-mod'), entries: ['src/main.rs'] }),
    /Rust bundle has unresolved modules[\s\S]*Unresolved module: mod gone from src\/main\.rs/u,
  )
})

test('CLI: bundle (rust) exits non-zero and writes no output on an unresolvable mod', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/main.rs'], { cwd: join(rustFixtures, 'missing-mod') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Rust bundle has unresolved modules/)
  t.assert.match(r.stderr, /mod gone/)
  t.assert.ok(!existsSync(outPath), 'output must not be written when bundling fails')
}))

test('bundleCommand writes a rust Bundle that round-trips through Bundle.parse', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(rustFixtures, 'use-crate'), entries: ['src/main.rs'], output: outPath })
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/main.rs'])
  t.assert.deepEqual(Object.keys(parsed.modules.get('.').files).toSorted(), ['src/bar.rs', 'src/foo.rs', 'src/main.rs'])
  t.assert.equal(parsed.formats.get('src/main.rs'), 'rust')
  t.assert.equal(parsed.imports.get('rust').get('src/main.rs').get('mod foo'), 'src/foo.rs')
}))

test('CLI: bundle writes a brotli-compressed Bundle for a .rs entry', withTmp((t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  const r = runCli(['bundle', '-o', outPath, 'src/main.rs'], { cwd: join(rustFixtures, 'basic') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const buf = readFileSync(outPath)
  t.assert.notEqual(buf[0], 0x7b)
  const parsed = Bundle.parse(brotliDecompressSync(buf).toString('utf8'))
  t.assert.deepEqual([...parsed.entries], ['src/main.rs'])
  t.assert.equal(parsed.imports.get('rust').get('src/main.rs').get('mod foo'), 'src/foo.rs')
}))

test('CLI: bundle rejects mixing .rs and .js entries', (t) => {
  const r = runCli(['bundle', 'a.rs', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /bundle entries must all be \.sol/)
})

// --- Symlink containment (security) ---
// A symlink whose name stays in-tree but whose real target escapes the bundle
// root must be refused, not silently followed and embedded under the in-tree key.

test('buildBashBundle refuses a symlink whose target escapes the bundle root', withTmp(async (t, tmp) => {
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'secret.sh'), 'echo secret\n')
    writeFileSync(join(tmp, 'main.sh'), 'source ./link.sh\n')
    symlinkSync(join(outside, 'secret.sh'), join(tmp, 'link.sh'))
    await t.assert.rejects(
      () => buildBashBundle({ cwd: tmp, entries: ['main.sh'] }),
      /symlink escaping bundle root/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('buildRustBundle refuses a symlink whose target escapes the crate root', withTmp(async (t, tmp) => {
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'secret.rs'), 'pub fn s() {}\n')
    mkdirSync(join(tmp, 'src'))
    writeFileSync(join(tmp, 'src', 'main.rs'), 'mod foo;\n')
    symlinkSync(join(outside, 'secret.rs'), join(tmp, 'src', 'foo.rs'))
    await t.assert.rejects(
      () => buildRustBundle({ cwd: tmp, entries: ['src/main.rs'] }),
      /symlink escaping bundle root/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('buildSolidityBundle refuses a symlink whose target escapes the bundle root', withTmp(async (t, tmp) => {
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'Secret.sol'), '// SPDX-License-Identifier: MIT\n')
    writeFileSync(join(tmp, 'A.sol'), 'import "./link.sol";\n')
    symlinkSync(join(outside, 'Secret.sol'), join(tmp, 'link.sol'))
    await t.assert.rejects(
      () => buildSolidityBundle({ cwd: tmp, entries: ['A.sol'] }),
      /symlink escaping bundle root/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('buildPhpBundle refuses a symlink whose target escapes the bundle root', withTmp(async (t, tmp) => {
  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'secret.php'), '<?php echo "secret";\n')
    writeFileSync(join(tmp, 'entry.php'), '<?php require __DIR__ . "/link.php";\n')
    symlinkSync(join(outside, 'secret.php'), join(tmp, 'link.php'))
    await t.assert.rejects(
      () => buildPhpBundle({ cwd: tmp, entries: ['entry.php'] }),
      /symlink escaping bundle root/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('buildBundle dispatches .sol entries to the Solidity builder and returns an in-memory Bundle', async (t) => {
  const cwd = join(fixtures, 'basic')
  const bundle = await buildBundle({ cwd, entries: ['src/A.sol'] })
  t.assert.ok(bundle instanceof Bundle)
  const expected = await buildSolidityBundle({ cwd, entries: ['src/A.sol'] })
  t.assert.equal(bundle.serialize(), expected.serialize())
})

test('buildBundle passes the mapping file through to the Solidity builder', async (t) => {
  const cwd = join(fixtures, 'with-remappings-txt')
  const bundle = await buildBundle({ cwd, entries: ['src/A.sol'], mappingFile: 'remappings.txt' })
  t.assert.equal(
    bundle.imports.get('solidity').get('src/A.sol').get('@openzeppelin/contracts/utils/Math.sol'),
    'lib/openzeppelin-contracts/contracts/utils/Math.sol',
  )
  // mapping file itself must NOT appear in the bundle's files
  t.assert.ok(!Object.hasOwn(bundle.modules.get('.').files, 'remappings.txt'))
})

test('buildBundle dispatches .php, .sh, and .rs entries to their builders', async (t) => {
  const php = await buildBundle({ cwd: join(phpFixtures, 'basic'), entries: ['src/A.php'] })
  t.assert.ok(php instanceof Bundle)
  t.assert.equal(php.formats.get('src/A.php'), 'php')

  const bash = await buildBundle({ cwd: join(bashFixtures, 'basic'), entries: ['main.sh'] })
  t.assert.ok(bash instanceof Bundle)
  t.assert.equal(bash.formats.get('main.sh'), 'bash')

  const rust = await buildBundle({ cwd: join(rustFixtures, 'basic'), entries: ['src/main.rs'] })
  t.assert.ok(rust instanceof Bundle)
  t.assert.equal(rust.formats.get('src/main.rs'), 'rust')
})

test('buildBundle builds a JS Bundle identical to what bundleCommand writes, without touching disk', withTmp(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'js-api', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'a.js'), "import { b } from './b.js'\nexport const a = b + 1\n")
  writeFileSync(join(tmp, 'b.js'), 'export const b = 2\n')

  const bundle = await buildBundle({ cwd: tmp, entries: ['a.js'] })
  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepEqual([...bundle.entries], ['a.js'])
  t.assert.deepEqual([...bundle.sources.keys()].toSorted(), ['a.js', 'b.js'])
  t.assert.equal(bundle.formats.get('a.js'), 'module')
  // Static JS bundles store edges under the wildcard '*' condition key
  t.assert.equal(bundle.imports.get('*').get('a.js').get('./b.js'), 'b.js')
  // In-memory only: no bundle/lockfile artifacts were written
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))

  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: tmp, entries: ['a.js'], output: outPath })
  const written = brotliDecompressSync(readFileSync(outPath)).toString('utf8')
  t.assert.equal(bundle.serialize(), written)
}))

test('buildBundle rejects an empty entry list', async (t) => {
  await t.assert.rejects(() => buildBundle({ cwd: fixtures, entries: [] }), /at least one entry/)
})

test('buildBundle rejects mixed-language entries', async (t) => {
  await t.assert.rejects(
    () => buildBundle({ cwd: fixtures, entries: ['a.sol', 'b.js'] }),
    /must all be \.sol, all be \.php, all be \.js\/\.cjs\/\.mjs\/\.ts\/\.cts\/\.mts, all be \.sh\/\.bash, or all be \.rs/,
  )
})

test('buildBundle rejects a mapping file for non-.sol entries', async (t) => {
  await t.assert.rejects(
    () => buildBundle({ cwd: fixtures, entries: ['a.js'], mappingFile: 'remappings.txt' }),
    /--mapping is only valid for \.sol bundles/,
  )
})

test('buildBundle rejects scope for non-JS entries', async (t) => {
  await t.assert.rejects(
    () => buildBundle({ cwd: join(fixtures, 'basic'), entries: ['src/A.sol'], scope: 'full' }),
    /--scope is only valid for JS bundles/,
  )
})
