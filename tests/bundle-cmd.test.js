import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '../src/bundle.js'
import { buildPhpBundle, buildSolidityBundle, bundleCommand, outermostDir } from '../src/cmd/bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures', 'solidity-bundle')
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
  t.assert.match(r.stderr, /must all be \.sol, all be \.php, or all be \.js\/\.cjs\/\.mjs/)
})

test('CLI: bundle rejects mixing .sol and .js entries', (t) => {
  const r = runCli(['bundle', 'a.sol', 'b.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /must all be \.sol, all be \.php, or all be \.js\/\.cjs\/\.mjs/)
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
  t.assert.match(r.stderr, /must all be \.sol, all be \.php, or all be \.js\/\.cjs\/\.mjs/)
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
