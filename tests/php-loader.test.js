import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildPhpTree,
  collectPhpFilesFromDisk,
  extractPhpImports,
  resolvePhpImport,
} from '../src/loaders/php.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'php-bundle')

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

test('extractPhpImports normalises a __DIR__-relative require to a ./ specifier', (t) => {
  t.assert.deepEqual(extractPhpImports("require_once __DIR__ . '/B.php';"), ['./B.php'])
  t.assert.deepEqual(extractPhpImports('require_once __DIR__ . "/B.php";'), ['./B.php'])
  // No spaces around the concatenation operator.
  t.assert.deepEqual(extractPhpImports("require __DIR__.'/lib/X.php';"), ['./lib/X.php'])
})

test('extractPhpImports handles the legacy dirname(__FILE__) form', (t) => {
  t.assert.deepEqual(extractPhpImports("include dirname(__FILE__) . '/Bar.php';"), ['./Bar.php'])
  t.assert.deepEqual(extractPhpImports('include dirname( __FILE__ )."/Bar.php";'), ['./Bar.php'])
})

test('extractPhpImports returns bare specifiers verbatim', (t) => {
  t.assert.deepEqual(extractPhpImports("require 'helpers.php';"), ['helpers.php'])
  t.assert.deepEqual(extractPhpImports("include_once 'lib/Util.php';"), ['lib/Util.php'])
})

test('extractPhpImports accepts the parenthesised call form', (t) => {
  t.assert.deepEqual(extractPhpImports("require(__DIR__ . '/B.php');"), ['./B.php'])
  t.assert.deepEqual(extractPhpImports("require('helpers.php');"), ['helpers.php'])
})

test('extractPhpImports finds every include in a file, in source order', (t) => {
  const src = "<?php\nrequire_once __DIR__ . '/A.php';\ninclude 'B.php';\nrequire __DIR__ . '/sub/C.php';\n"
  t.assert.deepEqual(extractPhpImports(src), ['./A.php', 'B.php', './sub/C.php'])
})

test('extractPhpImports ignores method calls and scope resolutions named like the keywords', (t) => {
  // `$loader->require(...)` and `Autoloader::include(...)` are ordinary calls,
  // not language constructs — the leading lookbehind must skip them.
  t.assert.deepEqual(extractPhpImports("$loader->require('x.php');"), [])
  t.assert.deepEqual(extractPhpImports("Autoloader::include('y.php');"), [])
})

test('extractPhpImports does not match a keyword embedded in a longer identifier', (t) => {
  t.assert.deepEqual(extractPhpImports("requireConfig('x.php');"), [])
  t.assert.deepEqual(extractPhpImports("$x = include_once_helper('y.php');"), [])
})

test('extractPhpImports reads __DIR__ includes from a real fixture file', (t) => {
  const src = readFileSync(join(fixtures, 'basic/src/A.php'), 'utf8')
  t.assert.deepEqual(extractPhpImports(src), ['./B.php'])
})

test('resolvePhpImport resolves ./ and ../ against the including file', (t) => {
  t.assert.equal(resolvePhpImport('./B.php', 'src/A.php'), 'src/B.php')
  t.assert.equal(resolvePhpImport('../lib/C.php', 'src/sub/A.php'), 'src/lib/C.php')
})

test('resolvePhpImport returns null when relative traversal escapes the root', (t) => {
  t.assert.equal(resolvePhpImport('../X.php', 'A.php'), null)
  t.assert.equal(resolvePhpImport('../../X.php', 'src/A.php'), null)
})

test('resolvePhpImport resolves a bare specifier file-relative when it exists on disk', (t) => {
  const baseDir = join(fixtures, 'basic')
  // `B.php` next to `src/A.php` exists at `src/B.php`.
  t.assert.equal(resolvePhpImport('B.php', 'src/A.php', { baseDir }), 'src/B.php')
})

test('resolvePhpImport falls back to project-relative for a bare specifier', (t) => {
  const baseDir = join(fixtures, 'basic')
  // `src/B.php` is not file-relative to `src/A.php` (would be `src/src/B.php`),
  // so it resolves project-relative instead.
  t.assert.equal(resolvePhpImport('src/B.php', 'src/A.php', { baseDir }), 'src/B.php')
})

test('resolvePhpImport returns null for a bare specifier that exists nowhere', (t) => {
  const baseDir = join(fixtures, 'basic')
  t.assert.equal(resolvePhpImport('nope.php', 'src/A.php', { baseDir }), null)
})

test('resolvePhpImport rejects absolute specifiers', (t) => {
  const baseDir = join(fixtures, 'basic')
  t.assert.equal(resolvePhpImport('/etc/passwd', 'src/A.php', { baseDir }), null)
})

test('resolvePhpImport rejects bare specifiers that escape baseDir via ..', (t) => {
  const baseDir = join(fixtures, 'basic')
  t.assert.equal(resolvePhpImport('foo/../../etc/passwd', 'src/A.php', { baseDir }), null)
})

test('resolvePhpImport returns null for bare specifiers without baseDir', (t) => {
  // Pure-function callers (no fs context) can only resolve relative specifiers.
  t.assert.equal(resolvePhpImport('B.php', 'src/A.php'), null)
  t.assert.equal(resolvePhpImport('src/B.php', 'src/A.php'), null)
})

test('collectPhpFilesFromDisk walks __DIR__ includes starting from entries', async (t) => {
  const baseDir = join(fixtures, 'basic')
  const sources = await collectPhpFilesFromDisk(baseDir, ['src/A.php'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.php', 'src/B.php'])
})

test('collectPhpFilesFromDisk follows ../ includes across subdirectories', async (t) => {
  const baseDir = join(fixtures, 'nested')
  const sources = await collectPhpFilesFromDisk(baseDir, ['src/A.php'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.php', 'src/C.php', 'src/sub/B.php'])
})

test('collectPhpFilesFromDisk loads each shared file once', async (t) => {
  const baseDir = join(fixtures, 'shared')
  const sources = await collectPhpFilesFromDisk(baseDir, ['src/A.php', 'src/B.php'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/A.php', 'src/B.php', 'src/Shared.php'])
})

test('collectPhpFilesFromDisk resolves bare includes file- and project-relative', async (t) => {
  const baseDir = join(fixtures, 'bare')
  const sources = await collectPhpFilesFromDisk(baseDir, ['index.php'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['helpers.php', 'index.php', 'lib/Util.php'])
})

test('collectPhpFilesFromDisk warns and skips a missing include', async (t) => {
  const baseDir = join(fixtures, 'missing')
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectPhpFilesFromDisk(baseDir, ['src/A.php']),
  )
  t.assert.deepEqual([...sources.keys()], ['src/A.php'])
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('src/Nope.php')))
})

test('buildPhpTree returns sources, resolutions, and a missing-imports list', async (t) => {
  const baseDir = join(fixtures, 'basic')
  const sources = await collectPhpFilesFromDisk(baseDir, ['src/A.php'])
  const tree = buildPhpTree(sources, { baseDir })
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources'])
  t.assert.equal(tree.resolutions.get('src/A.php').get('./B.php'), 'src/B.php')
  t.assert.equal(tree.resolutions.get('src/B.php').size, 0)
  t.assert.deepEqual(tree.missing, [])
})

test('buildPhpTree records unresolved includes in `missing`', async (t) => {
  const baseDir = join(fixtures, 'missing')
  const sources = await captureWarningsAsync(() =>
    collectPhpFilesFromDisk(baseDir, ['src/A.php']),
  ).then((r) => r.result)
  const { result: tree, warnings } = captureWarnings(() => buildPhpTree(sources, { baseDir }))
  t.assert.deepEqual(tree.missing, [{ spec: './Nope.php', from: 'src/A.php' }])
  t.assert.equal(tree.resolutions.get('src/A.php').size, 0)
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('./Nope.php')))
})
