import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bucketizePhpSources,
  buildPhpTree,
  collectPhpFilesFromDisk,
  extractPhpImportDirs,
  extractPhpImports,
  extractPhpPathRefs,
  loadComposerAutoload,
  loadLaravelProviderFiles,
  phpClassDependencies,
  resolveClassFile,
  resolvePhpDir,
  resolvePhpImport,
} from '../stasis/src/loaders/php.js'

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

test('extractPhpImports ignores require keywords inside a heredoc', (t) => {
  const src = [
    '<?php',
    '$sql = <<<SQL',
    "require 'not-an-include.php';",
    'SQL;',
    "require __DIR__ . '/real.php';",
  ].join('\n')
  t.assert.deepEqual(extractPhpImports(src), ['./real.php'])
})

test('the non-code lexer is linear on adversarial unterminated input (ReDoS guard)', (t) => {
  // A backtracking regex over unterminated heredocs/strings hangs here (O(n^2));
  // the hand-written linear scanner returns immediately. If this ever starts
  // timing out, a catastrophic-backtracking regex has been reintroduced.
  const heredoc = `<?php ${'<<<X\n'.repeat(80000)}` // ~400 KB
  const dquote = `<?php ${'"a\\"'.repeat(80000)}`
  t.assert.deepEqual(extractPhpImports(heredoc), [])
  t.assert.deepEqual(extractPhpImports(dquote), [])
})

test('phpClassDependencies is linear on a token before a long blanked run (ReDoS guard)', (t) => {
  // After stripPhp blanks comments/heredocs/strings to whitespace, a code token
  // followed by a long blank span with no `$var`/`)`/`:` after it used to make
  // the type-hint and catch regexes backtrack cubically. These must return
  // promptly; a timeout means a backtracking-prone regex has come back.
  t.assert.deepEqual([...phpClassDependencies(`<?php foo ${' '.repeat(50000)}`)], [])
  t.assert.deepEqual([...phpClassDependencies(`<?php try {} catch (${' '.repeat(50000)})`)], [])
  t.assert.deepEqual([...phpClassDependencies(`<?php ${'<<<X\n'.repeat(50000)}`)], [])
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

test('extractPhpImports does not extract a file from a dynamic include', (t) => {
  // A path with a variable or `"…$interp…"` is dynamic -> no concrete file
  // (it is offered as a directory instead; see extractPhpImportDirs).
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/data/' . $lang . '.php';"), [])
  t.assert.deepEqual(extractPhpImports('<?php require __DIR__ . "/views/$view.php";'), [])
  t.assert.deepEqual(extractPhpImports('<?php require $base . "/x.php";'), [])
  t.assert.deepEqual(extractPhpImports('<?php require $path;'), [])
})

test('extractPhpImports concatenates consecutive static string literals', (t) => {
  // A path split across static literals is still fully static and resolvable.
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/a' . '/b.php';"), ['./a/b.php'])
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '' . '/x.php';"), ['./x.php'])
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/data/ascii.php';"), ['./data/ascii.php'])
  // Single quotes never interpolate, so a literal `$` stays part of the path.
  t.assert.deepEqual(extractPhpImports("<?php require __DIR__ . '/v/$x.php';"), ['./v/$x.php'])
})

test('extractPhpImportDirs offers the static directory of a dynamic include', (t) => {
  // Laravel: require __DIR__ . "/.../components/$view.php" -> bundle that dir.
  t.assert.deepEqual(
    extractPhpImportDirs('<?php require __DIR__ . "/../../resources/views/components/$view.php";'),
    ['../../resources/views/components'],
  )
  // Interpolation with braces, and concatenation with a variable.
  t.assert.deepEqual(extractPhpImportDirs('<?php require __DIR__ . "/views/{$view}.php";'), ['./views'])
  t.assert.deepEqual(extractPhpImportDirs("<?php require __DIR__ . '/data/' . $lang . '.php';"), ['./data'])
  // No static directory to fall back on (path starts with a variable) -> nothing.
  t.assert.deepEqual(extractPhpImportDirs('<?php require $base . "/views/$v.php";'), [])
  // A fully-static include is a file, not a directory.
  t.assert.deepEqual(extractPhpImportDirs("<?php require __DIR__ . '/data/ascii.php';"), [])
})

test('extractPhpImports resolves dirname(__DIR__) and dirname(__DIR__, N) includes', (t) => {
  t.assert.deepEqual(extractPhpImports("<?php require dirname(__DIR__) . '/bootstrap.php';"), ['../bootstrap.php'])
  t.assert.deepEqual(extractPhpImports("<?php require dirname(__DIR__, 2) . '/config/app.php';"), ['../../config/app.php'])
})

test('extractPhpPathRefs finds dir-anchored .php paths used outside a require', (t) => {
  // Laravel bootstrap/app.php passes route files as arguments; they are real
  // PHP files even though there is no `require` keyword.
  const app = [
    '<?php',
    'return Application::configure(basePath: dirname(__DIR__))',
    "  ->withRouting(",
    "    web: __DIR__ . '/../routes/web.php',",
    "    api: __DIR__ . '/../routes/api.php',",
    "    health: '/up',", // bare string, not a path
    '  );',
  ].join('\n')
  t.assert.deepEqual(extractPhpPathRefs(app), [
    { spec: '../routes/web.php', anchor: 'file' },
    { spec: '../routes/api.php', anchor: 'file' },
  ])
  // A bare (non-dir-anchored) string is not treated as a path reference.
  t.assert.deepEqual(extractPhpPathRefs("<?php $x = 'config/app.php';"), [])
})

test('extractPhpPathRefs resolves Laravel path helpers against the project root', (t) => {
  // Laravel's BroadcastServiceProvider does `require base_path('routes/channels.php')`.
  t.assert.deepEqual(extractPhpPathRefs("<?php require base_path('routes/channels.php');"), [
    { spec: 'routes/channels.php', anchor: 'root' },
  ])
  // Other helpers prepend their fixed subdirectory.
  t.assert.deepEqual(extractPhpPathRefs("<?php $c = config_path('app.php');"), [
    { spec: 'config/app.php', anchor: 'root' },
  ])
  t.assert.deepEqual(extractPhpPathRefs("<?php require app_path('Helpers.php');"), [
    { spec: 'app/Helpers.php', anchor: 'root' },
  ])
  // A dynamic helper argument (concatenation) is not a static path -> skipped.
  t.assert.deepEqual(extractPhpPathRefs("<?php require base_path('routes/' . $f);"), [])
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

test('resolvePhpDir resolves an existing directory and rejects a missing one', (t) => {
  const baseDir = join(fixtures, 'composer')
  t.assert.equal(resolvePhpDir('./src', 'index.php', baseDir), 'src')
  t.assert.equal(resolvePhpDir('./vendor/acme', 'index.php', baseDir), 'vendor/acme')
  t.assert.equal(resolvePhpDir('./Repo', 'src/Service.php', baseDir), 'src/Repo')
  t.assert.equal(resolvePhpDir('./nope', 'index.php', baseDir), null)
  // A file (not a directory) is rejected.
  t.assert.equal(resolvePhpDir('./src/Service.php', 'index.php', baseDir), null)
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

test('collectPhpFilesFromDisk bundles every .php in the static dir of a dynamic include', async (t) => {
  // index.php does `require __DIR__ . '/modules/' . $name . '.php'` -- a dynamic
  // include whose static directory is modules/. All modules/*.php are pulled in
  // (non-.php files are not).
  const baseDir = join(fixtures, 'dynamic-include')
  const sources = await collectPhpFilesFromDisk(baseDir, ['index.php'])
  t.assert.deepEqual(
    [...sources.keys()].toSorted(),
    ['bootstrap.php', 'index.php', 'modules/admin.php', 'modules/default.php'],
  )
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

test('bucketizePhpSources groups vendor packages with name+version from composer.json/installed.json', (t) => {
  const sources = new Map([
    ['index.php', '<?php'],
    ['src/Service.php', '<?php'],
    ['vendor/acme/lib/src/Client.php', '<?php'],
    ['vendor/autoload.php', '<?php'], // no package composer.json -> workspace
  ])
  const modules = bucketizePhpSources(composer, sources, 'php-bundle', '0.0.0')

  // Vendor package: own bucket, name from composer.json, version from
  // installed.json, and the `composer` ecosystem marking it as a dependency.
  const lib = modules.get('vendor/acme/lib')
  t.assert.equal(lib.name, 'acme/lib')
  t.assert.equal(lib.version, '1.4.2')
  t.assert.equal(lib.ecosystem, 'composer')
  t.assert.deepEqual(Object.keys(lib.files), ['src/Client.php']) // package-relative

  // Workspace bucket: root composer.json name; carries everything without a
  // nearer package (incl. the autoloader glue), keyed project-relative. No
  // `ecosystem` — it's the top-level code, not a dependency.
  const root = modules.get('.')
  t.assert.equal(root.name, 'acme/app')
  t.assert.equal(root.ecosystem, undefined)
  t.assert.deepEqual(
    Object.keys(root.files).toSorted(),
    ['index.php', 'src/Service.php', 'vendor/autoload.php'],
  )
})

test('bucketizePhpSources falls back to the placeholder identity with no composer.json', (t) => {
  const modules = bucketizePhpSources(join(fixtures, 'basic'), new Map([['src/A.php', '<?php']]), 'php-bundle', '0.0.0')
  t.assert.deepEqual([...modules.keys()], ['.'])
  t.assert.equal(modules.get('.').name, 'php-bundle')
  t.assert.equal(modules.get('.').version, '0.0.0')
})

test('loadLaravelProviderFiles discovers vendor (installed.json) and app (bootstrap) providers', (t) => {
  const baseDir = join(fixtures, 'laravel-providers')
  const files = loadLaravelProviderFiles(baseDir, loadComposerAutoload(baseDir)).toSorted()
  t.assert.deepEqual(files, [
    'bootstrap/providers.php', // Laravel 11 app provider list
    'vendor/spatie/laravel-ignition/src/IgnitionServiceProvider.php', // auto-discovered vendor provider
  ])
})

test('loadLaravelProviderFiles returns no provider classes without an autoload config', (t) => {
  // bootstrap/providers.php is still seeded if present, but vendor providers
  // can't be resolved without the autoload maps.
  t.assert.deepEqual(loadLaravelProviderFiles(join(fixtures, 'basic'), null), [])
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
  // PSR-4 dir lists are de-duplicated (App\ is in both composer.json and the
  // generated map).
  t.assert.deepEqual(a.psr4.get('App\\'), ['src'])
})

test('loadComposerAutoload drops autoload paths that escape the project root', (t) => {
  // composer.json autoload entries with interior `..` (e.g. `src/../../../etc`)
  // must not let the bundler read files outside the project.
  const a = loadComposerAutoload(join(fixtures, 'escape'))
  t.assert.deepEqual(a.psr4.get('App\\'), ['src'])
  t.assert.deepEqual(a.psr4.get('Bad\\'), []) // escaping dir rejected
  t.assert.ok(a.files.includes('src/helpers.php'))
  t.assert.ok(!a.files.some((f) => f.includes('etc') || f.includes('..'))) // escaping file rejected
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

test('resolveClassFile falls back from a longer PSR-4 prefix to a shorter one', (t) => {
  // Composer tries prefixes longest-first but continues to a shorter prefix
  // when the file isn't under the longer one's directories.
  const a = {
    psr4: new Map([['App\\Repo\\', ['nonexistent']], ['App\\', ['src']]]),
    psr0: new Map(),
    classmap: new Map(),
    files: [],
  }
  t.assert.equal(resolveClassFile('App\\Repo\\UserRepo', a, composer), 'src/Repo/UserRepo.php')
})

test('phpClassDependencies captures every member of a union/intersection type', (t) => {
  const t1 = phpClassDependencies('<?php namespace App; class X { function f(Foo|Bar $a) {} }')
  t.assert.ok(t1.has('App\\Foo') && t1.has('App\\Bar'))
  const t2 = phpClassDependencies('<?php namespace App; class X { function f(): R1|R2 { return new R1(); } }')
  t.assert.ok(t2.has('App\\R1') && t2.has('App\\R2'))
  const t3 = phpClassDependencies('<?php namespace App; class X { function f(A&B $a) {} }')
  t.assert.ok(t3.has('App\\A') && t3.has('App\\B'))
  const t4 = phpClassDependencies('<?php namespace App; class X { function f(): ?Foo {} }')
  t.assert.ok(t4.has('App\\Foo')) // nullable marker stripped
})

test('phpClassDependencies does not emit bogus refs for keywords before a $var or after new', (t) => {
  const deps = phpClassDependencies('<?php namespace App; class X { function f($xs) { foreach ($xs as $x) {} return new class extends Base {}; } }')
  t.assert.ok(deps.has('App\\Base'))
  t.assert.ok(!deps.has('App\\as'))
  t.assert.ok(!deps.has('App\\class'))
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
