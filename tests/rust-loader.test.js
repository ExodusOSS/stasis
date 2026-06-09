import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildModuleTree,
  buildRustTree,
  collectRustFilesFromDisk,
  extractCrateUses,
  extractModDecls,
  getModuleDir,
  loadRust,
  resolveModPath,
  resolveUsePath,
} from '../src/loaders/rust.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rust-bundle')

const captureWarnings = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

test('extractModDecls finds external mod declarations (incl. pub / pub(crate))', (t) => {
  t.assert.deepEqual(extractModDecls('mod foo;\npub mod bar;\npub(crate) mod baz;\n'), ['foo', 'bar', 'baz'])
})

test('extractModDecls ignores inline `mod foo { ... }`', (t) => {
  t.assert.deepEqual(extractModDecls('mod inline {\n    pub fn x() {}\n}\nmod real;\n'), ['real'])
})

test('extractCrateUses finds crate:: paths', (t) => {
  t.assert.deepEqual(
    extractCrateUses('use crate::foo::Greeter;\nlet _ = crate::bar::run();\n'),
    ['crate::foo::Greeter', 'crate::bar::run'],
  )
})

test('extractCrateUses ignores external/std use statements', (t) => {
  t.assert.deepEqual(extractCrateUses('use std::collections::HashMap;\nuse serde::Serialize;\n'), [])
})

test('getModuleDir places submodules of crate roots / mod.rs as siblings', (t) => {
  t.assert.equal(getModuleDir('src/main.rs'), 'src')
  t.assert.equal(getModuleDir('src/lib.rs'), 'src')
  t.assert.equal(getModuleDir('src/foo/mod.rs'), 'src/foo')
  t.assert.equal(getModuleDir('main.rs'), '')
})

test('getModuleDir places submodules of other files under a stem subdir', (t) => {
  t.assert.equal(getModuleDir('src/foo.rs'), 'src/foo')
  t.assert.equal(getModuleDir('src/a/b.rs'), 'src/a/b')
})

test('resolveModPath resolves to <dir>/<name>.rs then <dir>/<name>/mod.rs (knownSources)', (t) => {
  const known = new Map([['src/foo.rs', ''], ['src/bar/mod.rs', '']])
  t.assert.equal(resolveModPath('foo', 'src/main.rs', { knownSources: known }), 'src/foo.rs')
  t.assert.equal(resolveModPath('bar', 'src/main.rs', { knownSources: known }), 'src/bar/mod.rs')
  t.assert.equal(resolveModPath('absent', 'src/main.rs', { knownSources: known }), null)
})

test('resolveModPath resolves against the filesystem in walk mode', (t) => {
  const baseDir = join(fixtures, 'mod-rs')
  // src/foo.rs does not exist, but src/foo/mod.rs does.
  t.assert.equal(resolveModPath('foo', 'src/main.rs', { baseDir }), 'src/foo/mod.rs')
  t.assert.equal(resolveModPath('nope', 'src/main.rs', { baseDir }), null)
})

test('collectRustFilesFromDisk walks mod declarations from the entry', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'basic'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk follows nested mods into stem subdirectories', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'nested'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo.rs', 'src/foo/bar.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk follows mod.rs-style submodules', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'mod-rs'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo/bar.rs', 'src/foo/mod.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk does not follow inline mods or absent mods', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'inline-mod'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/main.rs', 'src/real.rs'])
})

test('collectRustFilesFromDisk does not pull in external crates', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'external-crate'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/local.rs', 'src/main.rs'])
})

test('buildModuleTree maps module paths to files from the crate root', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'nested'), ['src/main.rs'])
  const { resolutions } = buildRustTree(sources)
  const tree = buildModuleTree(sources, resolutions)
  t.assert.equal(tree.get('crate'), 'src/main.rs')
  t.assert.equal(tree.get('crate::foo'), 'src/foo.rs')
  t.assert.equal(tree.get('crate::foo::bar'), 'src/foo/bar.rs')
})

test('resolveUsePath resolves to the deepest matching module', (t) => {
  const tree = new Map([
    ['crate', 'src/main.rs'],
    ['crate::foo', 'src/foo.rs'],
  ])
  // crate::foo::Greeter -> the foo module (Greeter is an item, not a module)
  t.assert.equal(resolveUsePath('crate::foo::Greeter', tree), 'src/foo.rs')
  t.assert.equal(resolveUsePath('crate::missing::Thing', tree), 'src/main.rs')
})

test('buildRustTree records mod edges and crate:: use edges', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'use-crate'), ['src/main.rs'])
  const tree = buildRustTree(sources)
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources'])
  t.assert.deepEqual(tree.missing, [])

  const main = tree.resolutions.get('src/main.rs')
  t.assert.equal(main.get('mod foo'), 'src/foo.rs')
  t.assert.equal(main.get('mod bar'), 'src/bar.rs')
  t.assert.equal(main.get('crate::foo::Greeter'), 'src/foo.rs')

  // bar.rs uses crate::foo::Greeter -> foo.rs
  t.assert.equal(tree.resolutions.get('src/bar.rs').get('crate::foo::Greeter'), 'src/foo.rs')
  t.assert.equal(tree.resolutions.get('src/foo.rs').size, 0)
})

test('buildRustTree records an unresolvable mod declaration in `missing`', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'missing-mod'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/main.rs', 'src/real.rs'])
  const { result: tree, warnings } = captureWarnings(() => buildRustTree(sources))
  const main = tree.resolutions.get('src/main.rs')
  t.assert.equal(main.get('mod real'), 'src/real.rs')
  t.assert.ok(!main.has('mod gone'))
  t.assert.deepEqual(tree.missing, [{ spec: 'mod gone', from: 'src/main.rs' }])
  t.assert.ok(warnings.some((w) => w.includes('Missing module') && w.includes('gone')))
})

test('loadRust reads a .rs.txt listing and walks the crate', async (t) => {
  const tree = await loadRust(join(fixtures, 'listing/list.rs.txt'))
  t.assert.deepEqual([...tree.sources.keys()].toSorted(), ['src/foo.rs', 'src/main.rs'])
  t.assert.equal(tree.resolutions.get('src/main.rs').get('mod foo'), 'src/foo.rs')
})

test('loadRust rejects an empty listing', async (t) => {
  await t.assert.rejects(() => loadRust(join(fixtures, 'listing-empty/list.rs.txt')), /Empty Rust listing/)
})

test('loadRust rejects a listing with non-.rs lines', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-nonrust/list.rs.txt')),
    /must only contain \.rs files/,
  )
})

test('loadRust rejects an entry path that escapes the listing dir', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-escape/list.rs.txt')),
    /Entry path escapes baseDir/,
  )
})

test('loadRust rejects an absolute entry path in the listing', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-absolute/list.rs.txt')),
    /Entry path must not be absolute/,
  )
})
