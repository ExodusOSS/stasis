import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildPhpTree,
  collectPhpFilesFromDisk,
  extractPhpImports,
  loadComposerAutoload,
  phpClassDependencies,
  resolveClassFile,
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

test('extractPhpImports ignores require/include keywords that are string values (method blacklists)', (t) => {
  // Regression: Mockery's MockConfigurationBuilder lists 'require'/'include'
  // etc. as blacklisted method names. The keyword sits inside a string literal
  // and must not be read as an include (it used to capture the `, ` gap to the
  // next array element as a bogus specifier).
  const src = [
    '<?php',
    '$blackListed = array(',
    "    '__construct',",
    "    'require', 'require_once', 'include', 'include_once',",
    ');',
    "require __DIR__ . '/Real.php';",
  ].join('\n')
  t.assert.deepEqual(extractPhpImports(src), ['./Real.php'])
})

test('extractPhpImports ignores include keywords inside comments and strings', (t) => {
  const src = [
    '<?php',
    "// require 'commented.php';",
    '$msg = "you must require \'embedded.php\' first";',
    "/* include 'block.php' */",
    "include 'real.php';",
  ].join('\n')
  t.assert.deepEqual(extractPhpImports(src), ['real.php'])
})

test('extractPhpImports skips dynamic includes built by concatenation', (t) => {
  // Regression: voku/portable-ascii does `require __DIR__ . '/data/' . $x . '.php'`.
  // Partially extracting the first string yields a bogus directory path; a path
  // concatenated with anything (a variable, or another string) is dynamic and
  // must be skipped entirely.
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/data/' . $lang . '.php';"), [])
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/a' . '/b.php';"), [])
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '' . '/x.php';"), [])
  t.assert.deepEqual(extractPhpImports('<?php require $base . "/x.php";'), [])
  t.assert.deepEqual(extractPhpImports('<?php require $path;'), [])
  // ...but a single complete string literal is still resolved.
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/data/ascii.php';"), ['./data/ascii.php'])
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

test('collectPhpFilesFromDisk skips a directory-valued include without crashing (EISDIR)', async (t) => {
  const baseDir = join(fixtures, 'eisdir')
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectPhpFilesFromDisk(baseDir, ['index.php']),
  )
  t.assert.deepEqual([...sources.keys()], ['index.php'])
  t.assert.ok(warnings.some((w) => w.includes('Missing import') && w.includes('lib')))
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

// --- Composer autoload ---

const composer = join(fixtures, 'composer')

test('loadComposerAutoload returns null for a project with no Composer config', (t) => {
  t.assert.equal(loadComposerAutoload(join(fixtures, 'basic')), null)
})

test('loadComposerAutoload merges composer.json and generated maps into baseDir-relative paths', (t) => {
  const a = loadComposerAutoload(composer)
  // PSR-4: App\ from composer.json + generated; Vendor\Acme\ from generated only.
  t.assert.ok(a.psr4.get('App\\').includes('src'))
  t.assert.deepEqual(a.psr4.get('Vendor\\Acme\\'), ['vendor/acme/lib/src'])
  // classmap: exact FQCN -> file, with the doubled backslashes unescaped.
  t.assert.equal(a.classmap.get('Legacy\\Thing'), 'src/Legacy/Thing.php')
  t.assert.equal(a.classmap.get('App\\Orphan'), 'src/Orphan.php')
  // files: unconditional autoload entry.
  t.assert.ok(a.files.includes('src/helpers.php'))
})

test('resolveClassFile resolves via PSR-4 (root and vendor prefixes)', (t) => {
  const a = loadComposerAutoload(composer)
  t.assert.equal(resolveClassFile('App\\Repo\\UserRepo', a, composer), 'src/Repo/UserRepo.php')
  t.assert.equal(resolveClassFile('Vendor\\Acme\\Client', a, composer), 'vendor/acme/lib/src/Client.php')
})

test('resolveClassFile resolves via the classmap', (t) => {
  const a = loadComposerAutoload(composer)
  t.assert.equal(resolveClassFile('Legacy\\Thing', a, composer), 'src/Legacy/Thing.php')
})

test('resolveClassFile resolves via PSR-0 (namespace and underscores map to directories)', (t) => {
  // Synthetic PSR-0 prefix pointing at src/: `Legacy_Thing` -> src/Legacy/Thing.php.
  const a = { psr4: new Map(), psr0: new Map([['Legacy_', ['src']]]), classmap: new Map(), files: [] }
  t.assert.equal(resolveClassFile('Legacy_Thing', a, composer), 'src/Legacy/Thing.php')
})

test('resolveClassFile returns null when a PSR-4 prefix matches but the file is absent', (t) => {
  const a = loadComposerAutoload(composer)
  t.assert.equal(resolveClassFile('App\\DoesNotExist', a, composer), null)
})

test('resolveClassFile returns null for a class in no autoload map', (t) => {
  const a = loadComposerAutoload(composer)
  t.assert.equal(resolveClassFile('Totally\\Unknown', a, composer), null)
})

test('phpClassDependencies resolves references but not unused `use` imports', (t) => {
  const src = [
    '<?php',
    'namespace App;',
    'use App\\Repo\\UserRepo;',
    'use App\\Unused\\Ghost;', // imported, never referenced below
    'class Service {',
    '  public function run() {',
    '    $r = new UserRepo();',
    '    return Helper::greet();', // same-namespace, no `use`
    '  }',
    '}',
  ].join('\n')
  const deps = phpClassDependencies(src)
  t.assert.ok(deps.has('App\\Repo\\UserRepo'))
  t.assert.ok(deps.has('App\\Helper'))
  t.assert.ok(!deps.has('App\\Unused\\Ghost'), 'an unused `use` import must not be a dependency')
})

test('phpClassDependencies resolves fully-qualified names and skips self/static/parent', (t) => {
  const src = [
    '<?php',
    'namespace App;',
    'function f() {',
    '  $x = new \\Vendor\\Thing();',
    '  $y = new self();',
    '  return static::make();',
    '}',
  ].join('\n')
  const deps = phpClassDependencies(src)
  t.assert.ok(deps.has('Vendor\\Thing'))
  t.assert.ok(!deps.has('self'))
  t.assert.ok(!deps.has('App\\self'))
  t.assert.ok(!deps.has('static'))
})

test('phpClassDependencies treats an in-class trait `use` as a reference', (t) => {
  const src = [
    '<?php',
    'namespace App;',
    'use App\\Concerns\\Sluggable;', // top-level import (alias only)
    'class Post {',
    '  use Sluggable;', // trait use -> reference, resolved via the alias
    '  use \\App\\Concerns\\Timestamped;', // fully-qualified trait use
    '}',
  ].join('\n')
  const deps = phpClassDependencies(src)
  t.assert.ok(deps.has('App\\Concerns\\Sluggable'))
  t.assert.ok(deps.has('App\\Concerns\\Timestamped'))
})

test('phpClassDependencies ignores class-like tokens inside strings, comments and heredocs', (t) => {
  const src = [
    '<?php',
    'namespace App;',
    'class X {',
    '  public function f() {',
    '    $a = "new App\\\\Bar";', // inside a string
    '    // new App\\Baz();', // inside a comment',
    '    $sql = <<<SQL',
    '      new App\\Qux()',
    'SQL;',
    '    return new Real();',
    '  }',
    '}',
  ].join('\n')
  const deps = phpClassDependencies(src)
  t.assert.ok(deps.has('App\\Real'))
  t.assert.ok(!deps.has('App\\Bar'))
  t.assert.ok(!deps.has('App\\Baz'))
  t.assert.ok(!deps.has('App\\Qux'))
})
