import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '../src/bundle.js'
import {
  buildBashBundle,
  buildPhpBundle,
  buildRustBundle,
  buildSolidityBundle,
  bundleCommand,
  outermostDir,
} from '../src/cmd/bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures', 'solidity-bundle')
const bashFixtures = join(here, 'fixtures', 'bash-bundle')
const rustFixtures = join(here, 'fixtures', 'rust-bundle')
const phpFixtures = join(here, 'fixtures', 'php-bundle')

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
  t.assert.match(r.stderr, new RegExp(`\\[stasis\\] Bundled 2 files in 1 package from src to ${outPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
}))

test('CLI: bundle summary falls back to <stdout> when no -o is given', (t) => {
  const r = spawnSync(process.execPath, [cli, 'bundle', 'src/A.sol'], {
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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

test('bundleCommand writes a brotli-compressed PHP Bundle that round-trips through Bundle.parseCode', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(phpFixtures, 'basic'), entries: ['src/A.php'], output: outPath })
  const buf = readFileSync(outPath)
  t.assert.notEqual(buf[0], 0x7b)
  const parsed = Bundle.parseCode(brotliDecompressSync(buf).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(bundlePath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(bundlePath)).toString('utf8'))
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

test('bundleCommand writes a bash Bundle that round-trips through Bundle.parseCode', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(bashFixtures, 'basic'), entries: ['main.sh'], output: outPath })
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(buf).toString('utf8'))
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

test('buildRustBundle does not bundle external crates', async (t) => {
  const bundle = await buildRustBundle({ cwd: join(rustFixtures, 'external-crate'), entries: ['src/main.rs'] })
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/local.rs', 'src/main.rs'])
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

test('bundleCommand writes a rust Bundle that round-trips through Bundle.parseCode', withTmp(async (t, tmp) => {
  const outPath = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: join(rustFixtures, 'use-crate'), entries: ['src/main.rs'], output: outPath })
  const parsed = Bundle.parseCode(brotliDecompressSync(readFileSync(outPath)).toString('utf8'))
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
  const parsed = Bundle.parseCode(brotliDecompressSync(buf).toString('utf8'))
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
