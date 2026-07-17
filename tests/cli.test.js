import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const runFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run')
const nmFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm')
const nmCjsFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-nm-cjs')
const jsonAttrFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-json-attr')
const forkFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-fork')
const forkShardFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-fork-shard')

// strip any inherited stasis env vars so the CLI's env-conflict guard doesn't trip
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_RESOURCES_BUNDLE_FILE: _rbf,
  EXODUS_STASIS_RESOURCES: _r,
  EXODUS_STASIS_FS: _fs,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
  EXODUS_STASIS_CHILD_PROCESS: _cp,
  EXODUS_STASIS_SHARD_DIR: _sd,
  EXODUS_STASIS_SHARD_KEY: _sk,
  ...cleanEnv
} = process.env

// util.inspect colorises strings when stderr supports colours (e.g. pnpm/npm running
// scripts in a TTY, or FORCE_COLOR set), so strip ANSI before matching.
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-bundle-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('no command prints usage and exits 1', (t) => {
  const r = run([])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
  t.assert.match(r.stderr, /stasis run/)
})

test('unknown command prints usage and exits 1', (t) => {
  const r = run(['nope'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Usage:/)
})

test('run with no path prints "Nothing to run"', (t) => {
  const r = run(['run', '--lock=add'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Nothing to run/)
})

test('run with no flags defaults --lock=none and hits the bundle-required constraint', (t) => {
  const r = run(['run', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /needs a lockfile or a bundle/)
})

test('run rejects an invalid --lock value', (t) => {
  const r = run(['run', '--lock=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --lock value/)
})

test('run rejects an invalid --bundle value', (t) => {
  const r = run(['run', '--lock=add', '--bundle=bogus', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /invalid --bundle value/)
})

test('run rejects --bundle-file without a non-none --bundle', (t) => {
  const r = run(['run', '--lock=add', '--bundle-file=/tmp/nope.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle-file requires --bundle/)
})

test('run rejects --resources-bundle-file without a non-none --bundle', (t) => {
  const r = run(['run', '--lock=add', '--resources-bundle-file=/tmp/r.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--resources-bundle-file requires --bundle/)
})

test('run rejects --resources-bundle-file with --bundle=ignore (it needs an active bundle)', (t) => {
  // Config rejects resourcesBundleFile under bundle=ignore; the bin must front-run that with a
  // clean usage error. Regression: the guard previously only caught `none` (letting `ignore`
  // through to an ugly child RangeError) and the message wrongly advertised `ignore` as valid.
  // The `frozen)` anchor below would not match the old `frozen|ignore)` message.
  const r = run(['run', '--lock=add', '--bundle=ignore', '--resources-bundle-file=/tmp/r.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Error: --resources-bundle-file requires --bundle=\(add\|replace\|load\|frozen\)/)
})

test('run rejects --bundle=load with --lock=add', (t) => {
  const r = run(['run', '--lock=add', '--bundle=load', '--bundle-file=/tmp/x.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle=load is incompatible with --lock=\(add\|replace\)/)
})

test('run rejects --bundle=load with --lock=replace', (t) => {
  const r = run(['run', '--lock=replace', '--bundle=load', '--bundle-file=/tmp/x.br', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--bundle=load is incompatible with --lock=\(add\|replace\)/)
})

test('run rejects --lock=none without a bundle', (t) => {
  const r = run(['run', '--lock=none', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /stasis needs a lockfile or a bundle: set --lock or --bundle/)
})

test('run --lock=add executes the entry and rewrites the lockfile idempotently', (t) => {
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /\[stasis\] Running stasis with config:/)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.equal(after, before)

  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.config, { scope: 'full' })
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  t.assert.ok(parsed.sources['.'].files['src/entry.js'].startsWith('sha512-'))
  t.assert.ok(parsed.sources['.'].files['src/hello.js'].startsWith('sha512-'))
})

test('run --lock=frozen executes the entry using the committed lockfile', (t) => {
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
})

test('run --lock=add rejects a changed source file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // change a tracked file: hashes must no longer match the committed lockfile
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=frozen rejects a changed source file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=frozen rejects a brand new entry not listed in the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")
  const r = run(['run', '--lock=frozen', 'src/fresh.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=add rejects a changed package.json version', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.version = '99.99.99'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=frozen --bundle=load detects a tampered source in the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // tamper with the bundle: swap hello.js source for an attacker-controlled payload
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  // remove on-disk sources so bundle=load is the only source of code
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'tampered payload must not be executed')
}))

test('run honors a bundleFile set only in stasis.config.json (capture + load round-trip)', withTmp((t, tmp) => {
  // Regression: state.js root-discovery resolved the bundle path from config.bundleFile BEFORE
  // loadConfig() applied stasis.config.json, so a config-only bundleFile (no --bundle-file flag,
  // no env) was ignored on load -- the bundle silently failed to load (or, with a stale default
  // stasis.code.br present, loaded the wrong file). The write side already ran post-loadConfig.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // lock=none must not meet an existing lockfile
  const configPath = join(tmp, 'stasis.config.json')
  const writeConfig = (bundle) =>
    writeFileSync(configPath, JSON.stringify({ scope: 'full', lock: 'none', bundle, bundleFile: 'custom.code.br' }))

  // capture: bundleFile comes ONLY from stasis.config.json
  writeConfig('add')
  const save = run(['run', '--lock=none', '--bundle=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(join(tmp, 'custom.code.br')), 'bundle written to the config-specified path')
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')), 'nothing written to the default path')

  // load: remove on-disk sources so the bundle is the ONLY source of code
  writeConfig('load')
  rmSync(join(tmp, 'src'), { recursive: true })
  const r = run(['run', '--lock=none', '--bundle=load', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `load stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /hello, world/, 'code must have been served from the config-specified bundle')
}))

test('run honors a config-only bundleFile in a nested-package (monorepo) layout', withTmp((t, tmp) => {
  // Regression: the discovery loop did not break after committing to the inner package, so the
  // OUTER repo root re-detected the same (rootDir-independent) bundleFile at its own probe and
  // threw 'Stasis config already loaded' on bundle=load/frozen. Layout below yields
  // potentialRoots = [packages/foo, <tmp>] (the .git at <tmp> stops the upward walk there).
  mkdirSync(join(tmp, '.git'))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }))
  const foo = join(tmp, 'packages', 'foo')
  mkdirSync(join(foo, 'src'), { recursive: true })
  writeFileSync(join(foo, 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0', type: 'module' }))
  writeFileSync(join(foo, 'src', 'entry.js'), "import { hello } from './hello.js'\nconsole.log(hello)\n")
  writeFileSync(join(foo, 'src', 'hello.js'), "export const hello = 'HELLO-MONO'\n")
  const configPath = join(foo, 'stasis.config.json')
  const writeConfig = (bundle) =>
    writeFileSync(configPath, JSON.stringify({ scope: 'full', lock: 'none', bundle, bundleFile: 'custom.code.br' }))

  writeConfig('add')
  const save = run(['run', '--lock=none', '--bundle=add', 'src/entry.js'], { cwd: foo })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(join(foo, 'custom.code.br')), 'bundle written under the leaf package')

  writeConfig('load')
  rmSync(join(foo, 'src'), { recursive: true })
  const r = run(['run', '--lock=none', '--bundle=load', 'src/entry.js'], { cwd: foo })
  t.assert.equal(r.status, 0, `load stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /HELLO-MONO/, 'code served from the config-specified bundle under the leaf package')
  t.assert.doesNotMatch(r.stderr, /Stasis config already loaded/, 'outer root must not re-detect the bundle')
}))

test('run --bundle=load with an explicit --bundle-file resolves the root consistently in a monorepo', withTmp((t, tmp) => {
  // Regression: an explicit --bundle-file (or EXODUS_STASIS_BUNDLE_FILE) is a rootDir-INDEPENDENT
  // path -- it reads the same file at every candidate root. As a root-detection signal it therefore
  // matched the INNERMOST package.json (packages/app) and committed that as the root at load time,
  // even though capture -- run before the bundle existed, so with no such signal -- committed the
  // OUTER repo root. Bundle keys are stored relative to the capture root, so a dependency hoisted to
  // <repo>/node_modules then landed OUTSIDE the (leaf) load root: the load hook could not serve it,
  // and Node's ESM->CJS translator re-resolved it through Module._load(absPath, /* no parent */),
  // which fell through hooks.js's `typeof parent?.filename === 'string'` guard to native disk
  // resolution -- `Cannot find module '<abs>/node_modules/dep/index.js'` once node_modules was
  // pruned/not shipped, or (on Node versions whose translator takes the served-source path) a
  // SILENT read of the on-disk copy instead of a crash. The load assertions below cover both
  // symptoms: `status === 0` catches the crash, `doesNotMatch(/TAMPERED/)` the silent disk read.
  // Choosing the root without the explicit bundleFile biasing it keeps capture
  // and load agreed, so the hoisted dep stays in-root and is served from the bundle.
  //
  // Layout yields potentialRoots = [packages/app, <tmp>] (the .git at <tmp> stops the upward walk).
  mkdirSync(join(tmp, '.git'))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0', private: true }))
  // A CJS dependency hoisted to the repo-root node_modules (the npm/pnpm dedup shape).
  const dep = join(tmp, 'node_modules', 'dep')
  mkdirSync(dep, { recursive: true })
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dep, 'index.js'), "module.exports = 'DEP-FROM-BUNDLE'\n")
  // Leaf package with NO stasis.config.json; its ESM entry imports the hoisted CJS dep (an
  // ESM->CJS edge, so Node's translator drives the resolution that tripped the guard).
  const app = join(tmp, 'packages', 'app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }))
  writeFileSync(join(app, 'index.mjs'), "import dep from 'dep'\nconsole.log(dep)\n")
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(['run', '--lock=none', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'], { cwd: app })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /DEP-FROM-BUNDLE/)
  // Pin the capture side too: stdout alone would pass even if the dep never landed in the
  // bundle (disk still holds the original bytes here), and the load step would then fail with
  // an opaque "not attested" instead of pointing at the capture. The key must be relative to
  // the OUTER (monorepo) root -- that is the very thing the root fix pins down.
  t.assert.ok(existsSync(bundlePath), 'bundle written at the explicit path')
  const bundled = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(bundled.modules['node_modules/dep']?.files['index.js'], "module.exports = 'DEP-FROM-BUNDLE'\n",
    'hoisted dep captured under its monorepo-root-relative key')

  // Tamper the dep's on-disk bytes: the node_modules layout stays on disk (node_modules scope
  // resolves the bare specifier through it), but the CONTENT must come from the bundle. Pre-fix,
  // the leaf-root misclassification served (or failed to find) the on-disk copy instead.
  writeFileSync(join(dep, 'index.js'), "module.exports = 'DEP-FROM-DISK-TAMPERED'\n")

  const load = run(['run', '--lock=none', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'], { cwd: app })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.doesNotMatch(load.stdout, /TAMPERED/, 'the hoisted dep must be served from the bundle, not the on-disk copy')
  t.assert.match(load.stdout, /DEP-FROM-BUNDLE/, 'bundle bytes win for a dependency resolved above the leaf package')
}))

// Shared fixture for the two tests below: the graph shape whose CJS leaf Node links via the
// 'commonjs-sync' translator. entry (ESM) --createRequire--> bridge-cjs (natively-executed
// CJS) --require(esm)--> esm-pkg (ESM) --import--> cjs-dep (CJS). At evaluation, translators.js
// re-enters the monkey-patchable CJS loader for cjs-dep as
//   Module._load('<abs>/node_modules/cjs-dep/index.js', /* parent */ undefined, isMain,
//                kShouldSkipModuleHooks)
// -- an ALREADY-RESOLVED absolute path, NO parent module, and the registerHooks hooks SKIPPED,
// so the resolve hook never sees the call and Module._resolveFilename is the only interception
// point. Pre-fix the request fell through the shim's `typeof parent?.filename === 'string'`
// guard to native disk resolution: `Cannot find module '<abs>/node_modules/cjs-dep/index.js'`
// for a file only the bundle carries (thrown from hooks.js's original.call). This is the
// cosmiconfig/import-fresh config-loading shape (a required config pulling in an ESM graph
// with CJS deps). Node >=24.18 forwards pre-resolved context for hook-resolved modules and
// masks the common case; on 24.14-24.17 every commonjs-sync evaluation re-resolves this way.
const writeRequireEsmCjsFixture = (tmp) => {
  const write = (rel, content) => {
    mkdirSync(join(tmp, dirname(rel)), { recursive: true })
    writeFileSync(join(tmp, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', private: true }))
  write('entry.mjs', [
    "import { createRequire } from 'node:module'",
    'const require = createRequire(import.meta.url)',
    "console.log(require('bridge-cjs').bridged)",
    '',
  ].join('\n'))
  write('node_modules/bridge-cjs/package.json', JSON.stringify({ name: 'bridge-cjs', version: '1.0.0', main: 'index.js' }))
  write('node_modules/bridge-cjs/index.js', "module.exports = { bridged: require('esm-pkg').ok }\n")
  write('node_modules/esm-pkg/package.json', JSON.stringify({ name: 'esm-pkg', version: '1.0.0', type: 'module', main: 'index.js' }))
  write('node_modules/esm-pkg/index.js', "import tag from 'cjs-dep'\nexport const ok = tag('LOADED')\n")
  write('node_modules/cjs-dep/package.json', JSON.stringify({ name: 'cjs-dep', version: '1.0.0', main: 'index.js' }))
  write('node_modules/cjs-dep/index.js', 'module.exports = (v) => `CJS-DEP-${v}`\n')
}

test('run --bundle=load serves a require(esm)-linked CJS dep with node_modules removed', withTmp((t, tmp) => {
  writeRequireEsmCjsFixture(tmp)

  const save = run(['run', '--lock=add', '--bundle=add', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /CJS-DEP-LOADED/)

  // A full-scope bundle is self-contained: ship it without node_modules entirely. The
  // commonjs-sync re-load of cjs-dep must then resolve from the bundle (the shim's
  // parentless identity resolution), never from disk.
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(['run', '--lock=frozen', '--bundle=load', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.match(load.stdout, /CJS-DEP-LOADED/, 'the require(esm)-linked CJS dep must be served from the bundle')
}))

test('run --dependencies --bundle=load serves a require(esm)-linked CJS dep absent from disk', withTmp((t, tmp) => {
  // Same graph under node_modules scope: bridge-cjs stays on disk (the workspace entry's
  // bare specifier resolves through the on-disk layout by design), but esm-pkg and cjs-dep
  // are resolved from the bundle's import map (node_modules parents), so their trees can be
  // absent -- including cjs-dep's, whose commonjs-sync re-load takes the parentless path.
  writeRequireEsmCjsFixture(tmp)

  const save = run(['run', '--lock=add', '--dependencies', '--bundle=add', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /CJS-DEP-LOADED/)

  rmSync(join(tmp, 'node_modules', 'esm-pkg'), { recursive: true, force: true })
  rmSync(join(tmp, 'node_modules', 'cjs-dep'), { recursive: true, force: true })

  const load = run(['run', '--lock=frozen', '--dependencies', '--bundle=load', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.match(load.stdout, /CJS-DEP-LOADED/, 'node_modules-scope deps resolved via the bundle map must survive a pruned tree')
}))

test('run --bundle=add records a resolution edge first observed during exit handlers', withTmp((t, tmp) => {
  // Regression for the lazy-require-at-exit shape: Babel lazy interop (e.g.
  // @react-native-community/cli-tools' logger) defers require('chalk') to the first log
  // call, and CLIs commonly first log in an exit-time summary. stasis's save() handlers
  // were registered at initState -- before user code -- so they fire FIRST on
  // beforeExit/exit, and a one-shot save wrote the artifacts BEFORE a later handler's
  // require resolved: the edge (its target already bundled via other importers, so only
  // the EDGE was missing) silently never landed, and `--bundle=load` then died with
  // `Cannot find module 'chalk'` out of the CJS shim's native fall-through. save() now
  // re-flushes on every beforeExit/exit firing (unchanged artifacts are compare-skipped),
  // so the exit firing persists what handlers after the beforeExit firing resolved.
  const write = (rel, content) => {
    mkdirSync(join(tmp, dirname(rel)), { recursive: true })
    writeFileSync(join(tmp, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', private: true }))
  // The entry loads dep itself (bundling its bytes) and registers an exit-time logger
  // call; toolpkg's OWN require('dep') therefore resolves only inside the beforeExit
  // handler, after stasis's first write of the run.
  write('entry.mjs', [
    "import { createRequire } from 'node:module'",
    'const require = createRequire(import.meta.url)',
    "require('dep')",
    "const tool = require('toolpkg')",
    "process.on('beforeExit', () => { console.log('late log:', tool.log()) })",
    '',
  ].join('\n'))
  write('node_modules/toolpkg/package.json', JSON.stringify({ name: 'toolpkg', version: '1.0.0', main: 'index.js' }))
  write('node_modules/toolpkg/index.js', "exports.log = () => require('dep').tag\n")
  write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
  write('node_modules/dep/index.js', "exports.tag = 'DEP-OK'\n")

  const save = run(['run', '--lock=add', '--bundle=add', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.match(save.stdout, /late log: DEP-OK/)

  // The artifact must attest the exit-time edge itself -- not just happen to run.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const edgeRecorded = Object.values(lock.imports ?? {}).some(
    (parents) => Object.entries(parents).some(
      ([parent, specs]) => parent === 'node_modules/toolpkg/index.js' && 'dep' in specs))
  t.assert.ok(edgeRecorded, 'the beforeExit-time toolpkg->dep resolution must be recorded')

  // And the bundle is then self-contained for it: same run shape with node_modules gone.
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(['run', '--lock=frozen', '--bundle=load', 'entry.mjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.match(load.stdout, /late log: DEP-OK/, 'the exit-time edge must be served from the bundle')
}))

test('run --lock=replace --bundle=add rejects when disk disagrees with the pre-loaded bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // seed the bundle with the original sources
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // change disk: even though the lockfile is being replaced, --bundle=add pre-loads
  // the bundle's sources and addFile must noupsert the on-disk bytes against them
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=replace', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --lock=add --bundle=replace still enforces the lockfile when rebuilding the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // change disk: lockfile is preserved (lock=add). bundle is being rebuilt (bundle=replace).
  // The lockfile's hash for hello.js no longer matches disk -- addFile must reject this.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=add', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
}))

test('run --lock=replace rewrites the lockfile from scratch when a source file changed', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(['run', '--lock=replace', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'bonjour, world\n')
  t.assert.match(r.stderr, /lock: 'replace'/)

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.notEqual(after, before, 'lockfile must be rewritten with new hashes')
  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.entries, ['src/entry.js'])
  // hash for hello.js must reflect the new bytes, not the stale committed value
  const beforeHash = JSON.parse(before).sources['.'].files['src/hello.js']
  const afterHash = parsed.sources['.'].files['src/hello.js']
  t.assert.notEqual(afterHash, beforeHash)
  t.assert.ok(afterHash.startsWith('sha512-'))
}))

test('run --lock=replace ignores stale entries from the previous lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  // forge a stale entry into the committed lockfile; replace mode must drop it
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.sources['.'].files['src/stale.js'] = 'sha512-deadbeef'
  lock.entries.push('src/stale.js')
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=replace', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(after.sources['.'].files['src/stale.js'], undefined, 'stale file must be dropped')
  t.assert.ok(!after.entries.includes('src/stale.js'), 'stale entry must be dropped')
}))

test('run --bundle=add rejects a changed source file when bundle exists', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // create the bundle with the original content
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // now change a source file -- re-running --bundle=add must refuse to overwrite
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(
    ['run', '--lock=replace', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
}))

test('run --bundle=replace rewrites the bundle from scratch when a source file changed', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const beforeBundle = readFileSync(bundlePath)
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'bonjour, world\n')
  t.assert.match(r.stderr, /bundle: 'replace'/)

  const afterBundle = readFileSync(bundlePath)
  t.assert.notEqual(afterBundle.toString('base64'), beforeBundle.toString('base64'))
  const decoded = JSON.parse(brotliDecompressSync(afterBundle))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], 'export const greet = (n) => `bonjour, ${n}`\n')
}))

test('run --bundle=replace ignores stale sources in the existing bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // forge a stale entry by re-saving a tampered bundle
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/orphan.js'] = 'export const x = 0\n'
  decoded.formats['src/orphan.js'] = 'module'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const after = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(after.sources['.'].files['src/orphan.js'], undefined, 'orphan source must be dropped')
}))

test('run --lock=frozen fails when scope conflicts with the committed lockfile', (t) => {
  // lockfile in the fixture was generated with scope=full; running with --dependencies
  // sets EXODUS_STASIS_SCOPE=node_modules, which can't override stasis.config.json
  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json/)
})

test('run --debug emits the debug warning on stderr', (t) => {
  const r = run(['run', '--lock=add', '--debug', 'src/entry.js'], { cwd: runFixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /stasis debug mode active/)
})

test('run --bundle=add --bundle-file writes the bundle at the chosen path/filename', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundleFile:/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].name, 'stasis-cli-run')
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
}))

test('run --bundle=load --bundle-file round-trips through a save', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lock: 'frozen'/)
  t.assert.match(load.stderr, /bundle: 'load'/)
}))

test('run --bundle=load fails when --bundle-file does not exist', withTmp((t, tmp) => {
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.notEqual(r.status, 0)
}))

test('run --lock=frozen --bundle=add writes the bundle without rewriting the lockfile', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const lockPath = join(runFixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(
    ['run', '--lock=frozen', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
  t.assert.match(r.stderr, /bundle: 'add'/)

  t.assert.ok(existsSync(bundlePath), 'bundle should be at the configured path')
  t.assert.ok(!existsSync(join(runFixture, 'stasis.code.br')), 'bundle should not pollute the fixture')
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=frozen must not rewrite the lockfile')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.version, 1)
  t.assert.deepEqual(decoded.config, { scope: 'full' })
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(runFixture, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(runFixture, 'src/hello.js'), 'utf-8'))
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
}))

test('run --lock=frozen --bundle=add round-trips through --bundle=load', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=frozen', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

// --- bundle=frozen: the bundle as a read-only attestation that operates like a
// lockfile. It needs no sibling lockfile (lock=none here): each file is read from
// disk and verified against the bundle's own recorded bytes/resolutions/formats,
// the bundle is never rewritten, and any drift fails closed. seedFrozenBundle
// builds a bundle into tmp and removes the committed lockfile so lock=none holds.
const seedFrozenBundle = (t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // bundle=frozen is self-sufficient; lock=none
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  return bundlePath
}

test('run --lock=none --bundle=frozen runs the entry, verifying disk against the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /bundle: 'frozen'/)
}))

test('run --bundle=frozen does not rewrite the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  const before = readFileSync(bundlePath)
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.deepEqual(readFileSync(bundlePath), before, 'bundle=frozen must not rewrite the bundle')
}))

test('run --bundle=frozen rejects a source file changed on disk', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // change a tracked file: its bytes no longer match the frozen bundle
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /bonjour/, 'the changed code must not run')
}))

test('run --bundle=frozen rejects a brand new file the bundle never recorded', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/fresh.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /not attested by the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /fresh/, 'an unattested entry must not run')
}))

test('run --bundle=frozen rejects an on-disk format flip (tampered package.json type)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // entry.js is attested as `module` in the bundle's formats. Flipping the
  // workspace package.json `type` makes Node treat the same hash-valid bytes as
  // commonjs -- `type` is not itself hash-attested, so only the format
  // cross-check against the frozen bundle can catch this.
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.type = 'commonjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed format for .* mismatches the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no code may run when a format is rejected')
}))

test('run --bundle=frozen rejects a tampered bundle whose recorded bytes diverge from disk', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // Tamper the bundle (not disk): swap hello.js's recorded source. The on-disk
  // file still holds the original bytes, so the noupsert against the bundle-seeded
  // sources must reject the divergence -- the frozen bundle is not trusted blindly.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'tampered bundle bytes must not run')
}))

test('run --bundle=frozen fails with a clear error when the bundle file is missing', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // stasis.config.json is still present, so discovery runs and the existence check fires early
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No bundle, but attempting to run in frozen bundle mode/)
}))

test('run --lock=frozen --bundle=frozen verifies against both, without rewriting either', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build the bundle while keeping the committed lockfile (lock=add round-trips it).
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
  const bundleBefore = readFileSync(bundlePath)

  const r = run(
    ['run', '--lock=frozen', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'frozen'/)
  t.assert.match(r.stderr, /bundle: 'frozen'/)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'lock=frozen must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --lock=replace --bundle=frozen writes the lockfile but leaves the frozen bundle untouched', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundleBefore = readFileSync(bundlePath)

  // A writing lock mode composes with a frozen bundle: lock=replace builds a fresh
  // lockfile from the run while bundle=frozen verifies disk against the bundle and
  // never rewrites it.
  const r = run(
    ['run', '--lock=replace', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'lock=replace must write a lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --lock=add --bundle=frozen bootstraps a lockfile from the verified run, without a pre-existing one', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp) // removes the committed lockfile
  const bundleBefore = readFileSync(bundlePath)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'precondition: no lockfile on disk')

  // A self-attesting frozen bundle needs no sibling lockfile, so lock=add can write a
  // fresh one from the run (verified against the bundle) instead of demanding one exist.
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'lock=add must bootstrap a lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=frozen must not rewrite the bundle')
}))

test('run --bundle=frozen fails closed with no stasis files at all (no silent skip)', withTmp((t, tmp) => {
  // Regression: the bundle-existence check must fire even when the project has no
  // stasis.config.json/lock/etc. In node_modules scope the workspace entry is outside
  // the attested zone, so a missing bundle here once let it run unverified.
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  rmSync(join(tmp, 'stasis.config.json'))
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${join(tmp, 'missing.br')}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No bundle, but attempting to run in frozen bundle mode/)
  t.assert.equal(r.stdout, '', 'nothing may run when the frozen bundle is absent')
}))

// node_modules-scope frozen bundle: only node_modules sources are attested; the
// workspace is deliberately outside the attested zone (same carve-out as lock=frozen).
const seedFrozenNmBundle = (t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json')) // self-attesting; lock=none
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')
  return bundlePath
}

test('run --dependencies --bundle=frozen verifies node_modules against the bundle', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /scope: 'node_modules'/)
  t.assert.match(r.stderr, /bundle: 'frozen'/)
}))

test('run --dependencies --bundle=frozen rejects a tampered node_modules file (attested zone)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  writeFileSync(join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'), 'export const greet = (w) => `pwned, ${w}`\n')
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
  t.assert.doesNotMatch(r.stdout, /pwned/, 'a tampered dependency must not run')
}))

test('run --dependencies --bundle=frozen tolerates a changed workspace file (unattested zone)', withTmp((t, tmp) => {
  const bundlePath = seedFrozenNmBundle(t, tmp)
  // In node_modules scope the workspace is not attested by the bundle, so editing a
  // workspace file is allowed -- only node_modules drift is frozen. Mirrors lock=frozen.
  writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'frozen'\n")
  const r = run(
    ['run', '--lock=none', '--dependencies', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, frozen\n', 'the edited workspace file runs; only node_modules is frozen')
}))

test('run --lock=add --bundle=frozen does not persist a lockfile when a tamper is detected', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp) // removes the committed lockfile, seeds the bundle
  // Tamper a tracked file. The frozen run must reject it (fail-closed execution) AND must
  // not write a lockfile baking in the tampered hash -- otherwise a later lock=frozen run
  // would trust the poisoned lockfile and execute the very drift this run refused. The
  // write is suppressed because addFile's frozen check throws (not because the exit code
  // is non-zero), so the suppression is on the verification, not the exit status.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'an aborted frozen run must not persist a (poisoned) lockfile')
}))

test('run --lock=replace --bundle=frozen does not persist a lockfile when a tamper is detected', withTmp((t, tmp) => {
  // lock=replace always rewrites and needs no pre-existing lockfile, so it hits the
  // poisoning path independently of the lock=add bootstrap above.
  const bundlePath = seedFrozenBundle(t, tmp)
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=replace', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'lock=replace must not write a poisoned lockfile on a detected tamper')
}))

test('run --lock=add --bundle=frozen persists nothing when a frozen rejection is swallowed and the run exits clean', withTmp((t, tmp) => {
  // The suppression is keyed on the verification, not the exit code: even if user code
  // catches the frozen rejection and the process exits 0, the captured (tampered) state
  // must not be written -- otherwise a swallowed mismatch poisons a later lock=frozen run.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  // Entry dynamically imports hello.js and swallows any failure; build the bundle from it.
  writeFileSync(join(tmp, 'src', 'entry.js'), "try { await import('./hello.js') } catch {}\nconsole.log('survived')\n")
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  // Tamper hello.js: the dynamic import's frozen byte-check throws, the entry swallows it, exit 0.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=add', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`) // the import error was swallowed
  t.assert.match(r.stdout, /survived/)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'a swallowed frozen rejection must not persist a poisoned lockfile')
}))

test('run --lock=add --bundle=add still writes the capture when the program exits non-zero', withTmp((t, tmp) => {
  // A clean capture that exits non-zero for its own reasons (a server's SIGINT shutdown, a
  // CLI reporting failures) must still persist what it captured -- the write is gated on
  // stasis's own verification, not the program's exit code.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  const bundlePath = join(tmp, 'snapshot.br')
  writeFileSync(join(tmp, 'src', 'entry.js'), "import { greet } from './hello.js'\nconsole.log(greet('world'))\nprocess.exit(3)\n")
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 3, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(bundlePath), 'a non-zero exit must not block the bundle write')
  t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'a non-zero exit must not block the lockfile write')
}))

test('run --lock=add persists the clean capture when the run aborts for a non-verification reason', withTmp((t, tmp) => {
  // Boundary of the verification-based gate: an abort that does NOT originate in a stasis
  // check (here an uncaught module-not-found, thrown by Node's resolver before addImport)
  // does not taint, so the cleanly captured files are still written. This is the deliberate
  // trade-off of gating on the verification rather than the exit code; a partial lockfile
  // here is harmless (its recorded hashes are accurate, and a later lock=frozen run fails
  // closed on anything missing). Pinned so exit-code gating can't be silently reinstated.
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(join(tmp, 'src', 'entry.js'), "import { greet } from './hello.js'\nconsole.log(greet('world'))\nawait import('./does-not-exist.js')\n")
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0) // the missing import aborts the run
  t.assert.equal(r.stdout, 'hello, world\n')
  const lockPath = join(tmp, 'stasis.lock.json')
  t.assert.ok(existsSync(lockPath), 'a non-verification abort still persists the clean capture')
  const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.ok(parsed.sources['.'].files['src/hello.js'], 'cleanly-captured files are recorded')
}))

// Ctrl-C on a long-running server: a server installs its own SIGINT handler and exits
// (cleanly or non-zero) on shutdown -- that abort is the program's choice, not a
// lockfile/frozen verification failure, so the captured bundle/lockfile must still be
// persisted. Driven as a real subprocess that we signal once it's up. We drive the run-time
// loader directly (`node --import @exodus/stasis-core/loader` -- exactly what `stasis run`
// spawns) rather than through the CLI, so the signalled process IS the one that writes:
// `close` fires only after its own SIGINT handler exited and the loader's save() ran, with
// no parent/child process-group race.
const captureSigintServer = async (t, exitCode) => {
  const loader = fileURLToPath(import.meta.resolve('@exodus/stasis-core/loader'))
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-sigint-'))
  try {
    cpSync(runFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'snapshot.br')
    // A "server": imports a dep (captured at startup), installs its own SIGINT handler that
    // exits with the given code, signals readiness, then stays alive on a timer.
    writeFileSync(join(tmp, 'src', 'entry.js'),
      "import { greet } from './hello.js'\n" +
      `process.on('SIGINT', () => process.exit(${exitCode}))\n` +
      "void greet('world')\n" +
      "console.error('SERVER_READY')\n" +
      "setInterval(() => {}, 1e6)\n"
    )
    const env = {
      ...cleanEnv,
      EXODUS_STASIS_LOCK: 'add',
      EXODUS_STASIS_BUNDLE: 'add',
      EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      EXODUS_STASIS_SCOPE: 'full',
    }
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, 'src/entry.js'], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      let signalled = false
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server never became ready; stderr: ${err}`)) }, 20000)
      child.stderr.on('data', (d) => {
        err += d
        if (!signalled && err.includes('SERVER_READY')) { signalled = true; child.kill('SIGINT') } // Ctrl-C
      })
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', (c) => { clearTimeout(timer); resolve(c) })
    })
    t.assert.equal(code, exitCode, "the server's own SIGINT handler controls the exit code")
    t.assert.ok(existsSync(bundlePath), 'a SIGINT-ed server must still persist its captured bundle')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.ok(decoded.sources['.'].files['src/hello.js'], 'the dep imported before shutdown is captured')
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')), 'the lockfile is persisted too')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('run: a server SIGINT-ed to exit 0 still persists its captured bundle', (t) => captureSigintServer(t, 0))
test('run: a server SIGINT-ed to exit non-zero still persists its captured bundle', (t) => captureSigintServer(t, 130))

test('run --lock=ignore --bundle=frozen ignores the lockfile and verifies against the bundle', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true }) // keeps the committed stasis.lock.json
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

  const r = run(
    ['run', '--lock=ignore', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'ignore'/)
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'lock=ignore must not rewrite the lockfile')
}))

test('run --bundle=frozen rejects an observed resolution the bundle never recorded', withTmp((t, tmp) => {
  const bundlePath = seedFrozenBundle(t, tmp)
  // Strip the bundle's recorded resolutions. The resolver still observes entry->hello.js
  // from disk, but it is no longer attested -> fatal in full scope (the unknown-edge branch,
  // distinct from a redirect that mismatches a recorded edge).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports = {}
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  const r = run(
    ['run', '--lock=none', '--bundle=frozen', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /is not attested by the frozen bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may run when an edge is unattested')
}))

test('run --lock=frozen fails closed with no stasis files at all (no silent skip)', withTmp((t, tmp) => {
  // Mirror of the bundle=frozen regression: the lock=frozen existence check now lives
  // after the discovery loop, so it fires even with no stasis files on disk. In
  // node_modules scope the workspace entry is outside the attested zone, so a missing
  // lockfile here once let it run unverified.
  cpSync(nmFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))
  rmSync(join(tmp, 'stasis.config.json'))
  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /No lockfile, but attempting to run in frozen mode/)
  t.assert.equal(r.stdout, '', 'nothing may run when the lockfile is absent')
}))

test('run --bundle=add creates intermediate directories for --bundle-file', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'nested', 'deeper', 'out.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: runFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(bundlePath))
}))

test('run --bundle=load serves the entry from the bundle when its source is absent on disk', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove every source file -- bundle=load must run entirely from the bundle.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=load serves the entry from the bundle when only the entry is missing', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Keep the imported hello.js on disk, but make the entry missing.
  rmSync(join(tmp, 'src', 'entry.js'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --lock=frozen --bundle=load works in node_modules scope with non-tracked sources', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: nmFixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: nmFixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /scope: 'node_modules'/)
  t.assert.match(load.stderr, /bundle: 'load'/)
}))

// Regression: in node_modules scope, the resolve hook delegates non-nm parents to Node's
// default resolver, so the load hook receives `context.format` set by Node rather than by
// our own shortCircuit. This exercises that path with a CJS dep, which is the case most
// at risk of a format mismatch (commonjs vs module) between our recorded value and Node's.
test('run --lock=frozen --bundle=load roundtrips a CJS node_modules dep under node_modules scope', withTmp((t, tmp) => {
  cpSync(nmCjsFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'hello, world\n')

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

// Pins format='json' through bundle=load: a `with { type: 'json' }` import resolves to
// format='json', which the load hook used to reject (only module/commonjs were allowed).
test('run --lock=frozen --bundle=load roundtrips a JSON import with type:json attribute', withTmp((t, tmp) => {
  cpSync(jsonAttrFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'world\n')

  // Remove the json so the bundle is the only source.
  rmSync(join(tmp, 'src/data.json'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'world\n')
}))

test('run --lock=frozen --bundle=load reads non-node_modules sources from disk in node_modules scope', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Modify the on-disk helper. The bundle still has the original. Load must pick up the
  // on-disk version because non-node_modules sources are served from disk in nm scope.
  writeFileSync(join(tmp, 'src/helper.js'), `export const who = 'from disk'\n`)

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, from disk\n')
}))

test('run --lock=frozen --bundle=load fails in node_modules scope when a non-tracked source is missing on disk', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove the non-tracked helper. The bundle has it, but in nm scope we read non-nm files
  // from disk -- so load must fail rather than silently serving the bundled copy.
  rmSync(join(tmp, 'src/helper.js'))

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_MODULE_NOT_FOUND/)
}))

test('run --lock=none --bundle=add writes the bundle without touching the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  rmSync(lockPath)

  const r = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'none'/)
  t.assert.ok(existsSync(bundlePath), 'bundle should be written')
  t.assert.ok(!existsSync(lockPath), 'lockfile must not be created')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
}))

test('run --lock=none --bundle=load runs from a bundle with no lockfile on disk', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  rmSync(join(tmp, 'stasis.lock.json'))

  const save = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove all sources so the bundle is the only thing left.
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lock: 'none'/)
}))

test('run --lock=none rejects an existing lockfile (footgun guard)', (t) => {
  // lock=none is the implicit default; the rejection forces the user to make an
  // explicit choice (add/replace/frozen/ignore) when a lockfile is present.
  const r = run(['run', '--lock=none', '--bundle=add', '--bundle-file=/tmp/nope.br', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.lock\.json/)
})

test('run with no flags rejects an existing lockfile (default lock=none footgun guard)', (t) => {
  const r = run(['run', '--bundle=add', '--bundle-file=/tmp/nope.br', 'src/entry.js'], { cwd: runFixture })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.lock\.json/)
})

test('run --lock=ignore tolerates an existing lockfile and does not touch it', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(
    ['run', '--lock=ignore', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lock: 'ignore'/)
  t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
}))

test('run --lock=ignore --bundle=load serves from bundle without lockfile interaction', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=none rejects an existing bundle file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  // Seed a bundle in the project root (default bundle path)
  const save = run(['run', '--lock=add', '--bundle=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.ok(existsSync(bundlePath))

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unexpected .*stasis\.code\.br/)
}))

test('run --bundle=ignore tolerates an existing bundle file and does not touch it', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'stasis.code.br')
  const save = run(['run', '--lock=add', '--bundle=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const bundleBefore = readFileSync(bundlePath)

  const r = run(['run', '--lock=frozen', '--bundle=ignore', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBefore, 'bundle=ignore must not touch the bundle')
}))

test('run --lock=frozen --bundle=load rejects a bundle with mismatching scope', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  // create a bundle in full scope
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // forge a mismatching scope in the bundle metadata
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.config.scope = 'node_modules'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|at assert \(file:/)
}))

test('run --lock=add --bundle=add rejects a bundle with mismatching scope (not only frozen)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.config.scope = 'node_modules'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|at assert \(file:/)
}))

test('run --bundle=load rejects a v0 bundle whose path-inferred module name disagrees with the lockfile', withTmp((t, tmp) => {
  // The v0 bundle's name comes from the path (`node_modules/fake-esm-pkg` →
  // `fake-esm-pkg`); cross-check against the lockfile must fail if the
  // lockfile attests a different name for that dir (e.g. an aliased install).
  cpSync(nmFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Tamper the lockfile: same dir, different declared name.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.modules['node_modules/fake-esm-pkg'].name = 'aliased-name'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  // Downgrade the bundle to v0 flat shape so the loader hits the path-inference path.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  const flatSources = {}
  for (const dir of Object.keys(decoded.modules)) {
    for (const [rel, src] of Object.entries(decoded.modules[dir].files)) {
      flatSources[`${dir}/${rel}`] = src
    }
  }
  const v0 = { version: 0, config: decoded.config, formats: decoded.formats, imports: decoded.imports, sources: flatSources }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(v0)))

  const load = run(
    ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_ASSERTION/)
}))

test('run refuses a v0 legacy bundle (parse still accepts it for offline tools)', withTmp((t, tmp) => {
  // stasis run requires a v1 bundle: v0 carries no per-file `formats` (so resources
  // can't be distinguished from code and the loader can't pick module/commonjs) and
  // no import map (so resolutions go unchecked). Offline tooling (extract / diff /
  // audit / sbom) still parses v0 -- it has the metadata those commands need -- but
  // the runtime path refuses it with a message pointing at the upgrade path.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build a fresh v1 bundle, then downgrade it to the v0 legacy shape on disk
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  const flatSources = {}
  for (const dir of Object.keys(decoded.sources)) {
    for (const [rel, src] of Object.entries(decoded.sources[dir].files)) {
      flatSources[dir === '.' ? rel : `${dir}/${rel}`] = src
    }
  }
  const v0 = { version: 0, config: decoded.config, formats: decoded.formats, imports: decoded.imports, sources: flatSources }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(v0)))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0, `expected refusal; stdout=${load.stdout} stderr=${load.stderr}`)
  t.assert.match(load.stderr, /stasis run requires a v1 bundle/)
  // bundle=replace is the documented upgrade path -- starts fresh, writes v1.
  const upgrade = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(upgrade.status, 0, `upgrade stderr: ${upgrade.stderr}`)
  t.assert.equal(JSON.parse(brotliDecompressSync(readFileSync(bundlePath))).version, 1)
}))

test('run --bundle=load rejects a bundle whose entries disagree with the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.entries = ['src/hello.js'] // disagrees with lockfile entry "src/entry.js"
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION|entries mismatch/)
}))

test('run --bundle=load rejects a bundle whose module name disagrees with the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.sources['.'].name = 'someone-else'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /ERR_ASSERTION/)
}))

test('run --bundle=load rejects an entry not listed in the bundle entries', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'stasis.lock.json'))

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/hello.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /ERR_ASSERTION|Unknown entry/)
}))

test('run --lock=add records resolutions in the lockfile imports map', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.ok(lock.imports, 'lockfile must record imports')
  const buckets = Object.values(lock.imports)
  t.assert.equal(buckets.length, 1)
  t.assert.deepEqual(buckets[0], { 'src/entry.js': { './hello.js': 'src/hello.js' } })
}))

test('run --lock=add records loader formats in the lockfile formats map', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  t.assert.deepEqual(lock.formats, { 'src/entry.js': 'module', 'src/hello.js': 'module' })
}))

test('run --lock=frozen rejects an on-disk format flip (tampered package.json type)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // entry.js is attested as `module`. Flipping the workspace package.json's
  // `type` makes Node resolve the same hash-valid .js bytes as commonjs --
  // package.json `type` is not itself hash-attested, so only the format
  // cross-check can catch this. The same bytes would run under a different
  // module system (this `.js` would lose ESM semantics).
  const pkgPath = join(tmp, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.type = 'commonjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed format for .* mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may execute when a format is rejected')
}))

test('run --lock=frozen --bundle=load rejects a bundle that flips a hash-valid file format', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Flip hello.js's format module -> commonjs in the bundle. Bytes still match
  // the lockfile hash; only the loader format the file runs under changes.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
  decoded.formats['src/hello.js'] = 'commonjs'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle format for src\/hello\.js mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered-format file must not execute')
}))

test('run --lock=frozen --bundle=load rejects a bundle that flips a .js file to module-typescript', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // The scariest flip: module -> module-typescript makes Node strip
  // type-shaped syntax from the SAME bytes (`f<string>('x')` becomes a call,
  // not two comparisons), changing how the file parses -- not just which
  // module system runs it. Must be rejected, like any other format mismatch.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'module-typescript'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle format for src\/hello\.js mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered-format file must not execute')
}))

test('run --lock=frozen --dependencies does not enforce a workspace file format (unattested zone)', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // In node_modules scope the workspace is deliberately unattested (its bytes
  // aren't frozen-checked either), so the format check must be gated out for
  // workspace files. Make the lockfile disagree with disk on the workspace
  // entry's format; disk still loads it correctly, and the run must succeed --
  // a regression that over-enforced the workspace zone would fail here.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(lock.formats['src/entry.js'], 'module')
  lock.formats['src/entry.js'] = 'commonjs'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
}))

test('run --lock=frozen warns but proceeds when a legacy lockfile lacks formats', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // A lockfile with imports but no formats (predating format attestation):
  // the formats check is skipped, with a warning, and the run still works.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.formats
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lockfile does not attest formats/)
}))

test('run --lock=frozen --bundle=load rejects a bundle resolution redirected to another attested file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Redirect './hello.js' to the entry itself: every served byte still matches
  // a lockfile hash, only the resolution differs -- the hash checks alone
  // would let this through.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  let redirected = false
  for (const byParent of Object.values(decoded.imports)) {
    if (byParent['src/entry.js']?.['./hello.js']) {
      byParent['src/entry.js']['./hello.js'] = 'src/entry.js'
      redirected = true
    }
  }
  t.assert.ok(redirected, 'bundle must contain the edge to tamper with')
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /mismatches the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'tampered resolution must not execute')
}))

test('run --lock=frozen --bundle=load rejects a bundle resolution not attested by the lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Inject an edge for a (parent, specifier) the lockfile has never seen.
  // Even an edge the run never follows must be attested.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports['attacker-conditions'] = { 'src/entry.js': { './shadow.js': 'src/hello.js' } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /not attested by the lockfile/)
}))

test('run --lock=frozen --bundle=load rejects a redirected resolution under a foreign conditions key', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Same (parent, specifier) the lockfile attests, but redirected AND moved to
  // a conditions key the lockfile doesn't have: the cross-key fallback must
  // still compare the final resolution, so relabeling the bucket is no escape.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports['attacker-conditions'] = { 'src/entry.js': { './hello.js': 'src/entry.js' } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /mismatches the lockfile/)
}))

test('run --lock=frozen --bundle=load accepts a static bundle (wildcard conditions) against a runtime lockfile', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'static.br')

  // `stasis bundle` keys edges under '*'; the committed lockfile records the
  // precise runtime condition set. The final resolutions agree, so the pair
  // must validate -- it's the resolved file that's attested, not the key.
  const b = run(['bundle', `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(b.status, 0, `bundle stderr: ${b.stderr}`)

  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --lock=frozen --bundle=load rejects a wildcard resolution over a condition-divergent attestation', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Lockfile attests two different targets for the same (parent, specifier)
  // under different condition sets (dual-package style). A wildcard edge
  // over-claims there: either target would be served under conditions where
  // the other is the attested resolution, so the cross-key fallback must
  // refuse to pick one.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.imports['other, conditions'] = { 'src/entry.js': { './hello.js': 'src/entry.js' } }
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.imports = { '*': { 'src/entry.js': { './hello.js': 'src/hello.js' } } }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /attested inconsistently/)
}))

test('run --lock=frozen --dependencies rejects a node_modules resolution redirected to a workspace file', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // node_modules scope pins dependency bytes, but package.json (which drives
  // resolution) is not hash-attested: point fake-esm-pkg's legacy `main` at a
  // workspace file. The lockfile-attested edge for 'fake-esm-pkg' must win.
  const pkgPath = join(tmp, 'node_modules', 'fake-esm-pkg', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.main = '../../src/helper.js'
  writeFileSync(pkgPath, JSON.stringify(pkg) + '\n')

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* mismatches the lockfile/)
}))

test('run --lock=frozen --dependencies tolerates new workspace imports of pinned dependencies', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  // The workspace is unattested in node_modules scope: a refactor may route
  // the same pinned dependency through a new workspace file. New (unattested)
  // edges from workspace parents must be tolerated; the attested
  // './helper.js' edge still has to resolve to the recorded file.
  writeFileSync(join(tmp, 'src', 'extra.js'), "export { greet } from 'fake-esm-pkg'\n")
  writeFileSync(
    join(tmp, 'src', 'entry.js'),
    "import { greet } from './extra.js'\nimport { who } from './helper.js'\n\nconsole.log(greet(who))\n"
  )

  const r = run(['run', '--lock=frozen', '--dependencies', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
}))

test('run --lock=frozen (full scope) rejects an observed edge the lockfile does not attest', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  // Drop the entry -> hello.js edge from the lockfile's imports but keep every
  // file hash intact. entry.js loads (its bytes still match), then resolving
  // './hello.js' produces an edge the lockfile no longer attests. In full
  // scope unknown edges are fatal (the attested file set is closed), so this
  // must abort -- distinct from a byte-hash failure.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.imports = {}
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /observed resolution .* is not attested by the lockfile/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'no module code may execute when an edge is unattested')
}))

test('run --lock=frozen warns but proceeds when a legacy lockfile lacks imports (disk run)', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.imports
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.match(r.stderr, /lockfile does not attest resolutions/)
}))

test('run --lock=frozen --bundle=load tolerates a legacy lockfile without imports, with a warning', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Strip `imports` to simulate a lockfile that predates resolution attestation.
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  delete lock.imports
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')
  rmSync(join(tmp, 'src'), { recursive: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
  t.assert.match(load.stderr, /lockfile does not attest resolutions/)
}))

test('Bundle.parse rejects a bundle with an import edge escaping the project root', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  for (const byParent of Object.values(decoded.imports)) {
    if (byParent['src/entry.js']) byParent['src/entry.js']['./hello.js'] = '../outside.js'
  }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
}))

test('Bundle.parse rejects a v1 full-scope bundle with empty entries', withTmp((t, tmp) => {
  // A tampered bundle with entries=[] would otherwise let assertEntry skip (it
  // short-circuits on empty for v0+no-lockfile compat). Reject at parse time.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  rmSync(join(tmp, 'stasis.lock.json'))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.entries = []
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const load = run(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(load.status, 0)
  t.assert.match(load.stderr, /at least one entry|ERR_ASSERTION/)
}))

// ── runtime loader executable-format allowlist ─────────────────────────────────
// stasis run will only ever serve files whose attested format Node's loader can
// actually execute. Resource assets, source-language bundles, and any unknown
// format string a tampered/forward-incompatible bundle might smuggle in are
// refused at load time with a contextual message instead of a bare assertion.

test('run --bundle=load refuses to serve a resource-tagged file as code', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Tamper hello.js's format to a resource tag. Bytes still match the lockfile
  // hash; the loader must refuse to execute it as JavaScript.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'resource'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    // lock=ignore: skip the lockfile-format cross-check so the run reaches the
    // loader gate cleanly (the lockfile cross-check would otherwise win first).
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot import a resource file/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'resource-tagged file must not execute')
}))

test('run --bundle=load refuses to serve a solidity-tagged file', withTmp((t, tmp) => {
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'solidity'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot execute a 'solidity' bundle/)
}))

test('run --bundle=load refuses a bundle that drops a lockfile-attested resource tag (inverse cross-check)', withTmp((t, tmp) => {
  // The forward direction (bundle declares format X, lockfile attests Y) is the
  // classic format-flip and is well covered. The INVERSE -- lockfile attests a
  // file as a resource, bundle just doesn't tag it -- would otherwise route the
  // base64 payload through State.sources (the code path). #mergeBundleMetadata's
  // resource-direction inverse loop catches it as a clean schema-level mismatch.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Build a fresh v1 lockfile + bundle pair.
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Lockfile: rewrite hello.js's format to 'resource:base64' (its hash is bytes-
  // over-raw which we don't touch -- the cross-check fires before any hash work).
  const lockPath = join(tmp, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.formats['src/hello.js'] = 'resource:base64'
  writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')
  // Bundle: drop hello.js's format entry entirely (the forward loop iterates
  // bundle.formats, so without an entry there's nothing to cross-check via that
  // path; only the inverse loop can catch this).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  delete decoded.formats['src/hello.js']
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /bundle file src\/hello\.js must declare format='resource:base64'/)
}))

test('run --bundle=load refuses every NON_NODE_SOURCE_LANGUAGE tag (php parallel)', withTmp((t, tmp) => {
  // The runtime loader's NON_NODE_SOURCE_LANGUAGES set covers solidity / php / bash
  // / rust as one category, all routed to the same "produced for external analysis"
  // refusal. The solidity case above exercises one tag; this test exercises a sibling
  // (php) to catch a regression that drops a tag from the set.
  cpSync(runFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'php'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })

  const r = run(
    ['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot execute a 'php' bundle/)
  t.assert.doesNotMatch(r.stdout, /hello/, 'php-tagged file must not execute')
}))

// --- child processes under stasis (no child_process interception, no flag) ----------
//
// EXODUS_STASIS_PID records the root's pid. A child that runs the loader -- fork() inherits
// it via process.execArgv automatically; a `spawn(node, ['--import', loader, ...])` does so
// explicitly -- also inherits EXODUS_STASIS_PID but runs under a different pid. On that
// mismatch the loader suppresses the child's bundle/lockfile write (ANY child, fork or not),
// and additionally relaxes the entry check for a FORKED child (mismatch + an IPC channel,
// which only fork creates). The fixture's entry.js forks src/worker.js when RUN_WORKER is
// set and spawns it (with --import) when SPAWN_WORKER is set, so the capture step (no child)
// and the enforced step share one entry. worker.js prints the modes it sees.

const seedFork = (t, tmp) => {
  cpSync(forkFixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `seed stderr: ${save.stderr}`)
  return bundlePath
}

test('run capture: a forked child does not write the lockfile/bundle (no race)', withTmp((t, tmp) => {
  // Capture once without forking to get the baseline artifacts...
  const bundlePath = seedFork(t, tmp)
  const lockBaseline = readFileSync(join(tmp, 'stasis.lock.json'))
  const bundleBaseline = readFileSync(bundlePath)
  // ...then capture again WITH the fork happening. The child re-runs the loader (lock=add,
  // bundle=add inherited) but must persist nothing -- so the artifacts are byte-identical.
  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER hello, child/, 'the forked child ran')
  t.assert.deepEqual(readFileSync(join(tmp, 'stasis.lock.json')), lockBaseline, 'child must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBaseline, 'child must not rewrite the bundle')
}))

test('run --bundle=load: a forked child is served from the bundle (entry need not be declared)', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  // Remove every source: the bundle is the only place the entry, worker, and hello can come
  // from. worker.js is an attested file but NOT a declared entry -- allowed for a fork target.
  rmSync(join(tmp, 'src'), { recursive: true })
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /^WORKER hello, child lock=frozen bundle=load$/m)
  t.assert.match(r.stdout, /PARENT child-exit=0/)
}))

test('run --bundle=load: the ROOT entry stays strict (a non-declared entry is rejected)', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  // Running worker.js directly as the root entry: it is attested but not a declared entry,
  // and the root (pid match, no fork) must still enforce the entries list.
  const r = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/worker.js'],
    { cwd: tmp }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Unknown entry point/)
}))

test('run --lock=frozen: a forked child fails closed on a tampered import', withTmp((t, tmp) => {
  seedFork(t, tmp)
  // hello.js is imported by the forked worker; tampering it must be caught (the child runs
  // the same enforcement) and the tampered code must not run.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `PWNED ${n}`\n')
  const r = run(
    ['run', '--lock=frozen', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, RUN_WORKER: '1' } }
  )
  t.assert.notEqual(r.status, 0)
  t.assert.doesNotMatch(r.stdout, /PWNED/, 'the tampered code must not run')
}))

test('run capture: a non-fork child that inherits the loader is also blocked from writing', withTmp((t, tmp) => {
  const bundlePath = seedFork(t, tmp)
  const lockBaseline = readFileSync(join(tmp, 'stasis.lock.json'))
  const bundleBaseline = readFileSync(bundlePath)
  // entry.js spawns `node --import <loader> worker.js` (a NON-fork child: no IPC channel). It
  // still inherits EXODUS_STASIS_PID, so the pid mismatch must suppress its write too -- the
  // safeguard covers any child, not just fork(). Artifacts stay byte-identical to the baseline.
  const loader = fileURLToPath(import.meta.resolve('@exodus/stasis-core/loader'))
  const r = run(
    ['run', '--lock=replace', '--bundle=replace', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, SPAWN_WORKER: '1', STASIS_LOADER: loader } }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER hello, child/, 'the spawned child ran')
  t.assert.deepEqual(readFileSync(join(tmp, 'stasis.lock.json')), lockBaseline, 'a non-fork child must not rewrite the lockfile')
  t.assert.deepEqual(readFileSync(bundlePath), bundleBaseline, 'a non-fork child must not rewrite the bundle')
}))

// --- child→root capture forwarding (shards, --child-process) -------------------------
//
// A forked child captures into its own State but can't write (the root owns the artifact).
// Without forwarding, files only the child loads -- a Metro transform worker's babel.config.js
// + babel preset/plugins -- are never attested, so a later frozen/load run rejects them. The
// cli-run-fork-shard fixture reproduces that minimally: the parent forks worker.js by path and
// never imports it, so worker.js and its childdep.js import are loaded ONLY in the child.
// Forwarding is OPT-IN via --child-process (it stands up a process-coordination channel).

test('run --child-process: a forked child contributes its child-only modules to the lockfile', withTmp((t, tmp) => {
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER extra=child-only-dep/, 'the forked child ran')
  t.assert.match(r.stdout, /PARENT child-exit=0/)

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const files = Object.keys(lock.sources['.'].files)
  // Neither is reachable from the root process -- only the forked child loaded them.
  t.assert.ok(files.includes('src/worker.js'), 'child-only worker.js attested via the shard merge')
  t.assert.ok(files.includes('src/childdep.js'), 'child-only childdep.js attested via the shard merge')
  t.assert.ok(lock.sources['.'].files['src/childdep.js'].startsWith('sha512-'))
  // The child loaded these as ESM (Node syntax detection -- the fixture has no package "type"),
  // and the ROOT never loaded them, so their format is known ONLY from the child's shard.
  // mergeShard must carry it; without that they'd default to commonjs and the frozen run below
  // would reject the format flip.
  t.assert.equal(lock.formats['src/worker.js'], 'module', 'child-only worker.js attested as module')
  t.assert.equal(lock.formats['src/childdep.js'], 'module', 'child-only childdep.js attested as module')
}))

test('run --child-process: the shard dir is minted in tmpdir and removed on exit (clean AND aborted)', withTmp((t, tmp) => {
  // Two properties: (1) the dir lives in the OS tmpdir, not under the project/write-target tree (so
  // it can't pollute an `--fs` readdir of the root or litter the repo); (2) it is removed on every
  // exit path. Point TMPDIR at a fresh dir so we can assert it's empty of `stasis-shard-*` after --
  // a regressed rmSync, or a re-introduced under-project mint, would leave one behind.
  cpSync(forkShardFixture, tmp, { recursive: true })
  const tmpHome = mkdtempSync(join(tmpdir(), 'stasis-shard-home-'))
  const shardDirs = () => readdirSync(tmpHome).filter((n) => n.startsWith('stasis-shard-'))
  try {
    // Clean capture: channel exercised, dir gone afterward, and never minted under the project.
    const ok = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, TMPDIR: tmpHome } })
    t.assert.equal(ok.status, 0, `stderr: ${ok.stderr}`)
    t.assert.match(ok.stdout, /WORKER extra=child-only-dep/, 'the shard channel was exercised')
    t.assert.deepEqual(shardDirs(), [], 'shard dir removed after a clean run')
    t.assert.deepEqual(readdirSync(tmp).filter((n) => n.includes('stasis-shard')), [], 'never minted under the project')

    // Aborted capture: drifting a recorded file makes the re-run's lock=add conflict (addFile throws
    // -> aborted) AFTER the dir is minted. Cleanup lives in save()'s finally (not gated on a clean
    // write), so the dir must STILL be gone -- and the aborted run must not rewrite the lockfile.
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
    writeFileSync(join(tmp, 'src', 'entry.js'), `${readFileSync(join(tmp, 'src', 'entry.js'), 'utf-8')}\n// drift\n`)
    const aborted = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, TMPDIR: tmpHome } })
    t.assert.notEqual(aborted.status, 0, 'the drifted re-run must abort (lock=add conflict on the entry)')
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore, 'aborted run must not rewrite the lockfile')
    t.assert.deepEqual(shardDirs(), [], 'shard dir removed even after an aborted run')
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
}))

test('run --child-process: a worker pool (2 forks) -- both contribute without conflict on shared modules', withTmp((t, tmp) => {
  // Two concurrent children each write a pid-named shard into the root's dir; the root merges both
  // and the module they BOTH loaded is attested without a noupsert conflict. (The merge-skip dedups
  // the second copy, but that's a perf optimization with no observable output -- equal bytes noupsert
  // cleanly either way -- so this pins "both contribute, no conflict", NOT the skip itself.)
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, WORKER_COUNT: '2' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal((r.stdout.match(/WORKER extra=child-only-dep/g) ?? []).length, 2, 'both forked workers ran')
  const files = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).sources['.'].files
  t.assert.ok(files['src/worker.js'] && files['src/childdep.js'], 'child-only modules from both worker shards attested, no conflict')
}))

test('run --child-process: a subprocess that spawns a subprocess -- grandchild observations recorded', withTmp((t, tmp) => {
  // The shard channel (dir+key) rides process.env, so it propagates to the WHOLE descendant tree: a
  // forked worker that itself forks a grandchild passes the channel onward, and the grandchild's
  // depth-2 child-only module is merged into the root's lockfile. (This is exactly why the bins must
  // NOT scrub the inherited shard vars -- that would sever capture for legitimately-spawned subtrees.)
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, SPAWN_GRANDCHILD: '1' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /GRANDCHILD deep=grandchild-only-dep/, 'the grandchild ran')
  const files = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).sources['.'].files
  t.assert.ok(files['src/grandchilddep.js'], 'depth-2 grandchild-only module attested in the root lockfile')
}))

test('run --child-process: a forged shard (signed with a foreign key) is rejected', withTmp((t, tmp) => {
  // The channel authenticates each shard with the root's per-build ed25519 key. The PUBLIC key
  // names every shard file (a peer enumerating the dir can read it), but only the PRIVATE key --
  // env-passed to descendants, never written to the dir -- can sign. src/forge.js plays the peer:
  // it drops a file with the right public-key prefix but a FOREIGN signature, claiming decoy.js.
  // The signature check (against the root's own public key) must reject it.
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, FORGE_SHARD: '1' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /FORGE wrote a forged shard/, 'the attacker actually dropped a forged shard')
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const files = Object.keys(lock.sources['.'].files)
  t.assert.ok(!files.includes('src/decoy.js'), 'forged shard rejected: decoy.js must NOT be attested')
  // The genuine child's real (root-signed) shard is still accepted alongside it.
  t.assert.ok(files.includes('src/childdep.js'), 'the genuine child shard still merged')
}))

test('run --child-process: an unsigned shard is rejected', withTmp((t, tmp) => {
  // A shard with no `signature` field at all -- the typeof-string guard drops it before verify.
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, FORGE_SHARD: 'unsigned' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /FORGE wrote a forged shard/, 'the attacker dropped a forged shard under the root pubId prefix (so it passes the pre-filter and reaches the signature gate)')
  const files = Object.keys(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).sources['.'].files)
  t.assert.ok(!files.includes('src/decoy.js'), 'unsigned shard rejected: decoy.js must NOT be attested')
  t.assert.ok(files.includes('src/childdep.js'), 'the genuine child shard still merged')
}))

test('run --child-process: a shard tampered after a valid signature is rejected', withTmp((t, tmp) => {
  // A genuine root signature over a decoy-FREE payload, reused over a decoy-bearing one. Proves
  // verify() covers the shard bytes, not merely that the signer held the key.
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp, env: { ...cleanEnv, FORGE_SHARD: 'tampered' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /FORGE wrote a forged shard/, 'the attacker dropped a forged shard under the root pubId prefix (so it passes the pre-filter and reaches the signature gate)')
  const files = Object.keys(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).sources['.'].files)
  t.assert.ok(!files.includes('src/decoy.js'), 'tampered shard rejected: decoy.js must NOT be attested')
  t.assert.ok(files.includes('src/childdep.js'), 'the genuine child shard still merged')
}))

test('run capture: WITHOUT --child-process a child-only module is NOT captured (opt-in gate)', withTmp((t, tmp) => {
  cpSync(forkShardFixture, tmp, { recursive: true })
  const r = run(['run', '--lock=add', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER extra=child-only-dep/, 'the forked child still ran')

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const files = Object.keys(lock.sources['.'].files)
  // Default off: the child's observations are not forwarded, so its modules stay unattested.
  t.assert.ok(!files.includes('src/worker.js'), 'child-only worker.js NOT captured without the flag')
  t.assert.ok(!files.includes('src/childdep.js'), 'child-only childdep.js NOT captured without the flag')
}))

test('run --child-process: an inherited shard DIR+KEY is ignored -- a shard valid under them is not merged, dir untouched', withTmp((t, tmp) => {
  // Hardening: the root must ALWAYS mint its OWN dir+key and never honor an inherited
  // EXODUS_STASIS_SHARD_DIR/_KEY (which would let a peer feed forged shards and make the root rm an
  // external path). Hand it an attacker dir AND key, and plant a shard that is genuinely VALID under
  // that key (signed by it, named with its public prefix) claiming src/decoy.js with decoy's REAL
  // hash -- so if the root honored the inherited channel it WOULD verify + merge it. It must not:
  // decoy.js stays unattested, the genuine child-only module is still captured (own channel), and
  // the attacker dir + sentinel are left intact (no confused-deputy rm).
  cpSync(forkShardFixture, tmp, { recursive: true })
  const attackerDir = mkdtempSync(join(tmpdir(), 'stasis-attacker-'))
  const sentinel = join(attackerDir, 'sentinel')
  writeFileSync(sentinel, 'do not touch')
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pubId = publicKey.export({ format: 'jwk' }).x
    const realHash = `sha512-${createHash('sha512').update(readFileSync(join(tmp, 'src', 'decoy.js'))).digest('base64')}`
    const shard = JSON.stringify({
      version: 0, config: { scope: 'full' }, entries: [],
      sources: { '.': { name: 'stasis-cli-run-fork-shard', version: '0.0.0', files: { 'src/decoy.js': realHash } } },
      modules: {},
    })
    const signature = sign(null, Buffer.from(shard), privateKey).toString('base64url')
    writeFileSync(join(attackerDir, `${pubId}-12345.json`), JSON.stringify({ shard, signature }))
    const keyB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')

    const r = run(['run', '--lock=add', '--child-process', 'src/entry.js'], {
      cwd: tmp,
      env: { ...cleanEnv, EXODUS_STASIS_SHARD_DIR: attackerDir, EXODUS_STASIS_SHARD_KEY: keyB64 },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const files = Object.keys(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).sources['.'].files)
    t.assert.ok(!files.includes('src/decoy.js'), 'a shard valid under the INHERITED key is not merged (inherited channel ignored)')
    t.assert.ok(files.includes('src/childdep.js'), 'the genuine child-only module is still captured via the root-minted channel')
    t.assert.ok(existsSync(sentinel), 'inherited shard dir must not be removed (no confused-deputy rm)')
  } finally {
    rmSync(attackerDir, { recursive: true, force: true })
  }
}))

test('run --lock=frozen: a child-only dependency verifies after a --child-process capture', withTmp((t, tmp) => {
  cpSync(forkShardFixture, tmp, { recursive: true })
  // Capture first WITH --child-process so the lockfile includes the child-only modules.
  const cap = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
  // Frozen re-run (no flag needed): the forked child re-loads worker.js + childdep.js and
  // verifies them against the now-complete lockfile -- per-process verification, independent of
  // the shard channel. Before forwarding this rejected childdep.js (the babel-toolchain symptom).
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(r.status, 0, `frozen stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /WORKER extra=child-only-dep/)
}))

test('run --lock=frozen: a tampered child-only dependency is still rejected (fail-closed preserved)', withTmp((t, tmp) => {
  cpSync(forkShardFixture, tmp, { recursive: true })
  const cap = run(['run', '--lock=add', '--child-process', 'src/entry.js'], { cwd: tmp })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
  // The child verifies its own observations against the lockfile regardless of shards, so a
  // tampered child-only file must fail the frozen run.
  writeFileSync(join(tmp, 'src', 'childdep.js'), "export const extra = 'TAMPERED'\n")
  const r = run(['run', '--lock=frozen', 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0, 'frozen must reject a tampered child-only dependency')
  // Pin the rejection reason so this can't pass on an unrelated failure: the child-only file's
  // bytes no longer match the lockfile-attested hash.
  t.assert.match(r.stderr, /childdep|Conflict|integrity|mismatch/i, 'must fail on the tampered child file specifically')
}))
