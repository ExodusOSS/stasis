import { test } from 'node:test'
import { hash } from 'node:crypto'
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prune } from '@exodus/stasis-core/prune'

const sri = (buf) => `sha512-${hash('sha512', buf, 'base64')}`
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

// Build a throwaway project from a module spec. For each module dir, `tracked`
// files are written AND recorded (with their real hash) in the lockfile, so
// prune keeps+validates them; `untracked` files are written but not recorded,
// so prune prunes or (for package.json) rewrites them.
function buildProject(t, modules) {
  const root = mkdtempSync(join(tmpdir(), 'stasis-prune-min-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lockModules = {}
  for (const [dir, { name, version, tracked = {}, untracked = {} }] of Object.entries(modules)) {
    const files = {}
    for (const [rel, content] of [...Object.entries(tracked), ...Object.entries(untracked)]) {
      const abs = join(root, dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    for (const [rel, content] of Object.entries(tracked)) files[rel] = sri(Buffer.from(content))
    lockModules[dir] = { name, version, files }
  }
  const lock = { version: 0, config: { scope: 'node_modules' }, modules: lockModules }
  writeFileSync(join(root, 'stasis.lock.json'), `${JSON.stringify(lock, undefined, 2)}\n`)
  return root
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PRUNE_FIXTURE = join(fixtures, 'prune')
const EMPTY_FIXTURE = join(fixtures, 'prune-empty')

function stage(t, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'stasis-prune-'))
  cpSync(fixture, root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function withEnv(t, name, value) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  t.after(() => {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  })
}

test('keeps lockfile files, validates hashes, removes others, cleans empty dirs', (t) => {
  const root = stage(t, PRUNE_FIXTURE)

  const { validated, removed, kept, minimized } = prune({ root })

  // listed in the lockfile -> validated against the recorded hash, kept in full
  t.assert.ok(validated.includes('node_modules/widget/index.js'))
  t.assert.ok(validated.includes('node_modules/widget/package.json'))
  t.assert.ok(validated.includes('node_modules/loose/index.js'))

  // package.json under a module dir that the lockfile lists, but not in its
  // `files` map -> kept (minimised to the lockfile-derived fields), not validated
  t.assert.ok(kept.includes('node_modules/loose/package.json'))
  t.assert.ok(!validated.includes('node_modules/loose/package.json'))
  t.assert.ok(minimized.includes('node_modules/loose/package.json'))
  t.assert.deepStrictEqual(readJson(root, 'node_modules/loose/package.json'), {
    name: 'loose',
    version: '0.1.0',
  })

  // package.json under a module dir the lockfile does NOT list -> pruned
  t.assert.ok(removed.includes('node_modules/extra/package.json'))

  // untracked files everywhere -> pruned
  t.assert.ok(removed.includes('node_modules/widget/extra.js'))
  t.assert.ok(removed.includes('node_modules/extra/index.js'))
  t.assert.ok(removed.includes('node_modules/orphan/nested/file.txt'))

  t.assert.ok(existsSync(join(root, 'node_modules/widget/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/widget/package.json')))
  t.assert.ok(existsSync(join(root, 'node_modules/loose/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/loose/package.json')))
  t.assert.ok(!existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(!existsSync(join(root, 'node_modules/extra')))
  t.assert.ok(!existsSync(join(root, 'node_modules/orphan')))
})

test('throws when a tracked file has a wrong hash', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  writeFileSync(join(root, 'node_modules/widget/index.js'), 'export const x = 2\n')
  t.assert.throws(
    () => prune({ root }),
    /hash mismatch for 1 file\(s\):\n {2}node_modules\/widget\/index\.js: expected sha512-/u,
  )
})

test('does not touch the tree when validation fails', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  const looseBefore = readFileSync(join(root, 'node_modules/loose/package.json'), 'utf8')
  writeFileSync(join(root, 'node_modules/widget/index.js'), 'export const x = 2\n')
  t.assert.throws(() => prune({ root }))

  // Untracked files that would have been pruned must still exist.
  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/orphan/nested/file.txt')))
  // The package.json rewrite is deferred to after validation too: a minimizable
  // manifest (loose/package.json, which a successful prune rewrites) is left
  // byte-for-byte untouched when prune aborts.
  t.assert.strictEqual(readFileSync(join(root, 'node_modules/loose/package.json'), 'utf8'), looseBefore)
})

test('throws when a lockfile file is missing on disk', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  rmSync(join(root, 'node_modules/widget/index.js'))
  t.assert.throws(() => prune({ root }), /missing on disk/u)
})

test('does not touch the tree when a tracked file is missing on disk', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  const looseBefore = readFileSync(join(root, 'node_modules/loose/package.json'), 'utf8')
  rmSync(join(root, 'node_modules/widget/index.js'))
  t.assert.throws(() => prune({ root }))

  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/orphan/nested/file.txt')))
  t.assert.strictEqual(readFileSync(join(root, 'node_modules/loose/package.json'), 'utf8'), looseBefore)
})

test('throws when stasis.lock.json is missing', (t) => {
  const root = stage(t, EMPTY_FIXTURE)
  t.assert.throws(() => prune({ root }), /stasis\.lock\.json not found/u)
})

test('throws when pnpm enableGlobalVirtualStore is enabled', (t) => {
  withEnv(t, 'npm_config_enable_global_virtual_store', 'true')
  const root = stage(t, PRUNE_FIXTURE)
  t.assert.throws(() => prune({ root }), /enableGlobalVirtualStore must be false/u)

  // Nothing on disk should have been touched.
  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
})

test('accepts pnpm enableGlobalVirtualStore explicitly set to false', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  withEnv(t, 'npm_config_enable_global_virtual_store', 'false')
  t.assert.doesNotThrow(() => prune({ root }))
})

test('accepts pnpm enableGlobalVirtualStore explicitly set to empty string', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  withEnv(t, 'npm_config_enable_global_virtual_store', '')
  t.assert.doesNotThrow(() => prune({ root }))
})

test('rewrites a dependency package.json to the minimal, lockfile-derived fields', (t) => {
  const bloated = {
    name: 'on-disk-name', // overridden by the lockfile's authoritative name
    version: '9.9.9', // overridden by the lockfile's authoritative version
    license: 'MIT',
    type: 'module',
    main: './index.js',
    module: './esm.js',
    browser: { './index.js': './browser.js', 'node:fs': false, './gone.js': './also-gone.js' },
    'react-native': './rn.js',
    bin: { pkg: './cli.js', gone: './missing.js' },
    sideEffects: ['./effect.js', '*.css', './missing.js'],
    exports: {
      '.': { import: './index.js', require: './missing.cjs' },
      './sub': './sub.js',
      './gone': './missing.js',
    },
    imports: { '#dep': 'other-pkg', '#util': './util.js', '#gone': './missing.js' },
    scripts: { postinstall: 'node evil.js' },
    dependencies: { lodash: '^4' },
    engines: { node: '>=18' },
    funding: 'https://example.com',
  }

  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: {
        'index.js': 'export default 1\n',
        'esm.js': 'export default 9\n',
        'browser.js': 'export default 2\n',
        'rn.js': 'export default 3\n',
        'cli.js': '#!/usr/bin/env node\n',
        'sub.js': 'export default 4\n',
        'effect.js': 'globalThis.x = 1\n',
        'util.js': 'export const u = 1\n',
      },
      untracked: { 'package.json': JSON.stringify(bloated), 'secret.js': 'export const s = 1\n' },
    },
  })

  const { minimized, removed } = prune({ root })
  t.assert.ok(minimized.includes('node_modules/pkg/package.json'))
  t.assert.ok(removed.includes('node_modules/pkg/secret.js'))

  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), {
    name: 'pkg',
    version: '1.0.0',
    license: 'MIT',
    type: 'module',
    main: './index.js',
    module: './esm.js',
    browser: { './index.js': './browser.js', 'node:fs': false },
    'react-native': './rn.js',
    bin: { pkg: './cli.js' },
    sideEffects: ['./effect.js', '*.css'],
    exports: { '.': { import: './index.js' }, './sub': './sub.js' },
    imports: { '#dep': 'other-pkg', '#util': './util.js' },
  })
})

test('drops a license that is non-ASCII, control-bearing, or >= 64 bytes, and a non module/commonjs type', (t) => {
  const root = buildProject(t, {
    'node_modules/a': {
      name: 'a',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ license: 'See LICENSE © 2020', type: 'commonjs-typescript' }) },
    },
    'node_modules/b': {
      name: 'b',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ license: 'x'.repeat(64), type: 'module' }) },
    },
    'node_modules/c': {
      name: 'c',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ license: 'MIT\u0007', type: 'commonjs' }) },
    },
    'node_modules/d': {
      name: 'd',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ license: '(MIT OR Apache-2.0)' }) },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/a/package.json'), { name: 'a', version: '1.0.0' })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/b/package.json'), { name: 'b', version: '1.0.0', type: 'module' })
  // a C0 control char (BEL) disqualifies the license, but `type` is still kept
  t.assert.deepStrictEqual(readJson(root, 'node_modules/c/package.json'), { name: 'c', version: '1.0.0', type: 'commonjs' })
  // a normal SPDX expression (spaces, parens) is printable ASCII -> kept
  t.assert.deepStrictEqual(readJson(root, 'node_modules/d/package.json'), { name: 'd', version: '1.0.0', license: '(MIT OR Apache-2.0)' })
})

test('keeps nested package.json markers (type + filtered exports/imports), instead of pruning them', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: {
        'dist/cjs/index.js': 'module.exports = 1\n',
        'dist/cjs/extra.js': 'module.exports = 2\n',
        'dist/cjs/util.js': 'module.exports = 3\n',
        'dist/esm/index.js': 'export default 1\n',
      },
      untracked: {
        'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module' }),
        'dist/cjs/package.json': JSON.stringify({
          type: 'commonjs',
          name: 'junk',
          sideEffects: false,
          main: './index.js',
          module: './extra.js',
          source: './util.js', // present (re-based) -> kept
          'jsnext:main': './gone.js', // missing -> dropped
          browser: { './index.js': './extra.js', './gone.js': './missing.js', 'node:fs': false },
          'react-native': './util.js',
          exports: { '.': './index.js', './extra': './extra.js', './gone': './missing.js' },
          imports: { '#u': './util.js', '#dep': 'lodash', '#gone': './missing.js' },
        }),
        'dist/esm/package.json': JSON.stringify({ type: 'weird' }),
      },
    },
  })

  const { minimized } = prune({ root })

  // The CJS marker must survive (or .js files in dist/cjs revert to the package
  // root's ESM type). The subtree resolution fields are kept, filtered to
  // present files (paths resolved relative to dist/cjs); identity and
  // package-level fields (name/sideEffects) are dropped.
  t.assert.ok(existsSync(join(root, 'node_modules/pkg/dist/cjs/package.json')))
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/dist/cjs/package.json'), {
    type: 'commonjs',
    main: './index.js',
    module: './extra.js',
    source: './util.js',
    browser: { './index.js': './extra.js', 'node:fs': false },
    'react-native': './util.js',
    exports: { '.': './index.js', './extra': './extra.js' },
    imports: { '#u': './util.js', '#dep': 'lodash' },
  })
  t.assert.ok(minimized.includes('node_modules/pkg/dist/cjs/package.json'))
  // An invalid type with no exports/imports drops to an (empty) object; kept.
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/dist/esm/package.json'), {})
})

test('keeps a directly-imported package.json verbatim (hash-validated, not minimised)', (t) => {
  const pkgJson = JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { x: 'y' } }, undefined, 2)
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n', 'package.json': pkgJson },
    },
  })

  const { validated, minimized } = prune({ root })
  t.assert.ok(validated.includes('node_modules/pkg/package.json'))
  t.assert.ok(!minimized.includes('node_modules/pkg/package.json'))
  // Untouched: the recorded bytes (scripts and all) are the attested content.
  t.assert.strictEqual(readFileSync(join(root, 'node_modules/pkg/package.json'), 'utf8'), pkgJson)
})

test('prunes a stray package.json under a dir the lockfile does not list', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': { name: 'pkg', version: '1.0.0', tracked: { 'index.js': '1\n' } },
  })
  mkdirSync(join(root, 'node_modules/stray'), { recursive: true })
  writeFileSync(join(root, 'node_modules/stray/package.json'), JSON.stringify({ name: 'stray', version: '1.0.0' }))

  const { removed } = prune({ root })
  t.assert.ok(removed.includes('node_modules/stray/package.json'))
  t.assert.ok(!existsSync(join(root, 'node_modules/stray')))
})

test('is idempotent: a second prune rewrites nothing', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', scripts: {} }) },
    },
  })

  const first = prune({ root })
  t.assert.ok(first.minimized.includes('node_modules/pkg/package.json'))
  const before = readFileSync(join(root, 'node_modules/pkg/package.json'), 'utf8')

  const second = prune({ root })
  t.assert.deepStrictEqual(second.minimized, [])
  t.assert.strictEqual(readFileSync(join(root, 'node_modules/pkg/package.json'), 'utf8'), before)
})

test('filters exports fallback arrays and bare targets, keeps null block targets', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n', 'sub.js': '2\n' },
      untracked: {
        'package.json': JSON.stringify({
          name: 'pkg',
          version: '1.0.0',
          exports: {
            '.': ['./missing.js', './index.js'], // fallback array: drop absent, keep present
            './all-gone': ['./gone1.js', './gone2.js'], // every fallback absent -> key dropped
            './blocked': null, // explicit subpath block -> kept verbatim
            './bare': 'some-pkg', // bare target is invalid in exports -> dropped
            './sub': './sub.js',
          },
        }),
      },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), {
    name: 'pkg',
    version: '1.0.0',
    exports: {
      '.': ['./index.js'],
      './blocked': null,
      './sub': './sub.js',
    },
  })
})

test('classifies scoped packages and nested node_modules (root vs nested marker)', (t) => {
  const root = buildProject(t, {
    'node_modules/@scope/pkg': {
      name: '@scope/pkg',
      version: '2.0.0',
      tracked: { 'index.js': '1\n', 'dist/cjs/index.js': '2\n' },
      untracked: {
        // root: identity comes from the lockfile, not these on-disk values
        'package.json': JSON.stringify({ name: 'wrong', version: '0', type: 'module', scripts: {} }),
        // nested marker under a scoped package: identity dropped, type/main re-based to dist/cjs
        'dist/cjs/package.json': JSON.stringify({ type: 'commonjs', name: 'junk', main: './index.js' }),
      },
    },
    // a dependency of a dependency: the innermost node_modules is the owner
    'node_modules/a/node_modules/b': {
      name: 'b',
      version: '3.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ name: 'wrong', version: '0', scripts: {} }) },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/@scope/pkg/package.json'), {
    name: '@scope/pkg',
    version: '2.0.0',
    type: 'module',
  })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/@scope/pkg/dist/cjs/package.json'), {
    type: 'commonjs',
    main: './index.js',
  })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/a/node_modules/b/package.json'), {
    name: 'b',
    version: '3.0.0',
  })
})

test('matches exports/imports targets verbatim and drops escaping ones', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'real.js': '1\n', 'lib/index.js': '2\n' },
      untracked: {
        'package.json': JSON.stringify({
          name: 'pkg',
          version: '1.0.0',
          exports: {
            '.': './real.js', // exact present -> kept
            './dir': './lib', // Node does NOT extension/index-resolve exports targets -> dropped
            './glob': './lib/*', // within-package pattern -> kept
            './escape': '../../elsewhere/*.js', // escapes the module -> dropped
          },
          imports: {
            '#ok': './real.js', // kept
            '#esc': '../../secret.js', // escapes -> dropped
          },
        }),
      },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), {
    name: 'pkg',
    version: '1.0.0',
    exports: { '.': './real.js', './glob': './lib/*' },
    imports: { '#ok': './real.js' },
  })
})

test('drops an over-deep exports tree instead of crashing, and still prunes', (t) => {
  let deep = './index.js'
  for (let i = 0; i < 500; i++) deep = { default: deep } // far beyond the recursion cap
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: {
        'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', exports: { '.': deep } }),
        'secret.js': 'export const s = 1\n',
      },
    },
  })

  let result
  t.assert.doesNotThrow(() => {
    result = prune({ root })
  })
  // the unresolvable deep tree is dropped, and prune still completed its cleanup
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), { name: 'pkg', version: '1.0.0' })
  t.assert.ok(result.removed.includes('node_modules/pkg/secret.js'))
})

test('drops bin and module entirely when nothing points at a present file', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: {
        'package.json': JSON.stringify({
          name: 'pkg',
          version: '1.0.0',
          module: './gone.js', // missing -> dropped
          bin: { a: './gone1.js', b: './gone2.js' }, // every target missing -> bin dropped
        }),
      },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), { name: 'pkg', version: '1.0.0' })
})

test('keeps jsnext:main/jsnext/source entry fields, filtered to present files', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'esm.js': '1\n', 'src.js': '2\n' },
      untracked: {
        'package.json': JSON.stringify({
          name: 'pkg',
          version: '1.0.0',
          'jsnext:main': './esm.js', // present -> kept
          jsnext: './gone.js', // missing -> dropped
          source: './src.js', // present -> kept
        }),
      },
    },
  })

  prune({ root })
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), {
    name: 'pkg',
    version: '1.0.0',
    'jsnext:main': './esm.js',
    source: './src.js',
  })
})

test('leaves an internal (pnpm-style) symlink in place and prunes unreferenced store files', (t) => {
  const root = buildProject(t, {
    'node_modules/.pnpm/pkg@1.0.0/node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
    },
  })
  // pnpm's public entry is a relative symlink into the store
  symlinkSync('.pnpm/pkg@1.0.0/node_modules/pkg', join(root, 'node_modules/pkg'), 'dir')
  // an unreferenced package sitting in the store (recorded for no lockfile module)
  mkdirSync(join(root, 'node_modules/.pnpm/junk@1.0.0/node_modules/junk'), { recursive: true })
  writeFileSync(join(root, 'node_modules/.pnpm/junk@1.0.0/node_modules/junk/index.js'), 'junk\n')

  const { removed } = prune({ root })
  // the internal link itself is left alone -- not validated, not pruned, not materialised
  t.assert.ok(!removed.includes('node_modules/pkg'))
  t.assert.ok(lstatSync(join(root, 'node_modules/pkg')).isSymbolicLink())
  // ...and its (attested) target survives, resolvable through the link
  t.assert.strictEqual(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf8'), '1\n')
  // the unreferenced store file is pruned
  t.assert.ok(removed.includes('node_modules/.pnpm/junk@1.0.0/node_modules/junk/index.js'))
})

test('fails on a symlink to a workspace package outside node_modules (target unattested)', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': { name: 'pkg', version: '1.0.0', tracked: { 'index.js': '1\n' } },
  })
  // A workspace package inside the project root but OUTSIDE node_modules: prune
  // never walks or attests it, so a link reaching it can't be left in place
  // without making unattested bytes reachable from the pruned tree.
  mkdirSync(join(root, 'packages/wsp'), { recursive: true })
  writeFileSync(join(root, 'packages/wsp/index.js'), 'unattested\n')
  symlinkSync('../packages/wsp', join(root, 'node_modules/wsp'), 'dir')

  t.assert.throws(() => prune({ root }), /symlink escapes node_modules/u)
})

test('leaves a dangling symlink in place (points at nothing, cannot leak)', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': { name: 'pkg', version: '1.0.0', tracked: { 'index.js': '1\n' } },
  })
  symlinkSync('./does-not-exist', join(root, 'node_modules/dangling'), 'file')

  t.assert.doesNotThrow(() => prune({ root }))
  t.assert.ok(lstatSync(join(root, 'node_modules/dangling')).isSymbolicLink())
})

test('fails (before touching disk) on a symlink whose target escapes node_modules', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'stray.js': 'export const s = 1\n' },
    },
  })
  const external = mkdtempSync(join(tmpdir(), 'stasis-external-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  writeFileSync(join(external, 'secret.txt'), 'secret\n')
  symlinkSync(join(external, 'secret.txt'), join(root, 'node_modules/leak'), 'file')

  t.assert.throws(() => prune({ root }), /symlink escapes node_modules/u)
  // failed closed: the external target survives and no untracked file was pruned
  t.assert.ok(existsSync(join(external, 'secret.txt')))
  t.assert.ok(existsSync(join(root, 'node_modules/pkg/stray.js')))
})

test('fails on a directory symlink that escapes node_modules', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': { name: 'pkg', version: '1.0.0', tracked: { 'index.js': '1\n' } },
  })
  const external = mkdtempSync(join(tmpdir(), 'stasis-external-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  symlinkSync(external, join(root, 'node_modules/leakdir'), 'dir')

  t.assert.throws(() => prune({ root }), /symlink escapes node_modules/u)
})

test('prunes a stale .tmp left behind by a crashed prior run', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': { name: 'pkg', version: '1.0.0', tracked: { 'index.js': '1\n' } },
  })
  const stale = join(root, 'node_modules/pkg/package.json.stasis-99999-0.tmp')
  writeFileSync(stale, '{}\n')

  const { removed } = prune({ root })
  t.assert.ok(removed.includes('node_modules/pkg/package.json.stasis-99999-0.tmp'))
  t.assert.ok(!existsSync(stale))
})

test('rewrites a package.json by replacing it, leaving hardlinked store copies untouched', (t) => {
  const root = buildProject(t, {
    'node_modules/pkg': {
      name: 'pkg',
      version: '1.0.0',
      tracked: { 'index.js': '1\n' },
      untracked: { 'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { evil: 'x' } }) },
    },
  })
  // model pnpm's store: the installed package.json shares an inode with a store copy
  const store = join(root, 'store-copy.json')
  linkSync(join(root, 'node_modules/pkg/package.json'), store)
  const storeBefore = readFileSync(store, 'utf8')

  prune({ root })
  // the installed copy is minimised...
  t.assert.deepStrictEqual(readJson(root, 'node_modules/pkg/package.json'), { name: 'pkg', version: '1.0.0' })
  // ...but the other hardlink (store inode) is byte-for-byte untouched: replace, not modify
  t.assert.strictEqual(readFileSync(store, 'utf8'), storeBefore)
})
