import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-cjs')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-cjs-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Can THIS Node serve require.resolve() of an off-disk target from a bundle-served
// (load-hook) CommonJS module? Node 24.15–26.2 regressed here: the ESM->CJS
// translator's require.resolve ends in `cascadedLoader.resolveSync(url, request,
// /* shouldSkipSyncHooks */ true)` (lib/internal/modules/esm/translators.js), and
// with sync hooks skipped that final resolve runs default ESM resolution -> stats
// disk -> throws ERR_MODULE_NOT_FOUND for a target the bundle carries but disk does
// not. 24.14 (routes require.resolve through Module._resolveFilename -> our shim) and
// 26.3+ (the off-disk target observably resolves to the recorded bundled path) serve
// it from the bundle. require() is unaffected on every version. The resolution EDGE
// is recorded on every version
// regardless (asserted unconditionally below) -- only this bundle-only LOAD of a
// never-on-disk require.resolve target is Node-version-limited, so probe the real
// behavior once rather than hardcode a fragile version range.
const RESOLVE_RESOLVE_FROM_BUNDLE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-cjs-probe-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true }))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(join(dir, 'index.mjs'), "import './r.cjs'\n")
    writeFileSync(join(dir, 'r.cjs'), "require.resolve('pd')\nconsole.log('ok')\n") // resolve-only, never loaded
    const pd = join(dir, 'node_modules', 'pd')
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ name: 'pd', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(pd, 'index.js'), 'module.exports = 1\n')
    const bundlePath = join(dir, 'p.br')
    const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'], { cwd: dir })
    if (save.status !== 0) return false
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'], { cwd: dir })
    return load.status === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

test('run --lock=add records a CJS entry and its require()d files idempotently', (t) => {
  const lockPath = join(fixture, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf-8')

  const r = run(['run', '--lock=add', 'src/entry.cjs'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')

  const after = readFileSync(lockPath, 'utf-8')
  t.assert.equal(after, before)

  const parsed = JSON.parse(after)
  t.assert.deepEqual(parsed.entries, ['src/entry.cjs'])
  t.assert.ok(parsed.sources['.'].files['src/entry.cjs'].startsWith('sha512-'))
  t.assert.ok(parsed.sources['.'].files['src/hello.cjs'].startsWith('sha512-'))
})

test('run --lock=frozen replays a CJS program from the committed lockfile', (t) => {
  const r = run(['run', '--lock=frozen', 'src/entry.cjs'], { cwd: fixture })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
})

test('run --bundle=add records commonjs format for CJS files', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const r = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: fixture }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, 'hello, world\n')
  t.assert.ok(existsSync(bundlePath))

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.equal(decoded.formats['src/entry.cjs'], 'commonjs')
  t.assert.equal(decoded.formats['src/hello.cjs'], 'commonjs')
  t.assert.equal(decoded.sources['.'].files['src/entry.cjs'], readFileSync(join(fixture, 'src/entry.cjs'), 'utf-8'))
  t.assert.equal(decoded.sources['.'].files['src/hello.cjs'], readFileSync(join(fixture, 'src/hello.cjs'), 'utf-8'))
}))

test('run --bundle=load executes a CJS program from a saved bundle', withTmp((t, tmp) => {
  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: fixture }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: fixture }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

test('run --bundle=load executes a CJS program with the entry AND its require()d files missing on disk', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // The ESM->CJS translator resolves require() through Module._resolveFilename
  // (not our resolve hook); the CJS-loader shim in hooks.js serves the target
  // from the bundle, so the require()d sub-file need not be on disk either -- not
  // just the entry. (Regression guard: this previously failed for ./hello.cjs.)
  rmSync(join(tmp, 'src', 'entry.cjs'))
  rmSync(join(tmp, 'src', 'hello.cjs'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'hello, world\n')
}))

// The real-world report: `import chalk from 'chalk'` (chalk@1.1.3 is CommonJS
// with a transitive CJS dependency graph) loaded from a full-scope bundle with
// node_modules removed. The ESM->CJS translator runs chalk via Node's native
// CJS loader, whose require()s bypass module hooks and resolve against disk -- so
// `require('escape-string-regexp')` threw MODULE_NOT_FOUND before the bundle
// could serve it. The CJS-loader shim makes the bundle self-contained. This is
// the minimal reproduction: an ESM entry importing a CJS package that require()s
// another CJS package, run with NO node_modules on disk.
test('run --bundle=load serves an ESM->CJS->CJS node_modules graph with node_modules removed', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'cjs-graph', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import a from 'pkg-a'\nconsole.log(a)\n")

  const mk = (name, indexBody) => {
    const dir = join(tmp, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(dir, 'index.js'), indexBody)
  }
  // pkg-a is CJS and require()s the bare specifier 'pkg-b' (another CJS package);
  // pkg-b is a CJS leaf. Mirrors chalk -> escape-string-regexp.
  mk('pkg-a', "module.exports = 'a:' + require('pkg-b')\n")
  mk('pkg-b', "module.exports = 'b'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'a:b\n')

  // Ship the app + bundle only: no node_modules on disk.
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'a:b\n')
}))

// Regression for the fs-extra `Cannot find module '../mkdirs'` report. Node's module
// cache makes a sibling's require() of an already-loaded target skip resolution
// (Module._load's relativeResolveCache), which once left the edge recorded under only
// ONE importer. The Module._load capture shim now records the per-importer edge anyway,
// so at load b.js -- the first to require ./shared (a.js is skipped without WARM) --
// resolves via its OWN recorded edge. Without that capture shim the edge would be
// unrecorded and the load would fail (`Cannot find module './shared'`): there is no
// load-time fallback.
test('run --bundle=load resolves a cache-shared sibling require from the bundle', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'cache-graph', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import m from 'multi'\nconsole.log(m)\n")
  const dir = join(tmp, 'node_modules', 'multi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'multi', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), "module.exports = (process.env.WARM ? require('./a') : '') + require('./b')\n")
  writeFileSync(join(dir, 'a.js'), "module.exports = require('./shared') + 'a'\n")
  writeFileSync(join(dir, 'b.js'), "module.exports = require('./shared') + 'b'\n")
  writeFileSync(join(dir, 'shared.js'), "module.exports = 'S'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp, env: { ...cleanEnv, WARM: '1' } }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'SaSb\n')

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp } // no WARM: a.js is skipped, so b.js is the first to require ./shared
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'Sb\n')
}))

// Capture side of the under-recording: Node's Module._load fast path
// (relativeResolveCache, keyed by the parent DIRECTORY + request) returns an
// already-loaded module WITHOUT calling _resolveFilename, so a SECOND sibling
// importer's require() of the same target was never observed and its edge went
// unrecorded. index.js requires ./a then ./b; a.js loads ./shared (caching it), so
// b.js's require('./shared') hits the cache. The _load observe-shim records the true
// per-importer edge at capture, so BOTH a.js's and b.js's `./shared` edges land.
test('run --bundle=add records a sibling importer\'s require() edge (no under-recording)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'sib', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import 'pkg'\n")
  const pkg = join(tmp, 'node_modules', 'pkg')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(pkg, 'index.js'), "require('./a'); require('./b')\n") // a runs first -> caches shared
  writeFileSync(join(pkg, 'a.js'), "module.exports = require('./shared')\n")
  writeFileSync(join(pkg, 'b.js'), "module.exports = require('./shared')\n") // sibling: hits relativeResolveCache
  writeFileSync(join(pkg, 'shared.js'), "module.exports = 'S'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  const bundle = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  const hasEdge = (parent) => Object.values(bundle.imports).some((byParent) => byParent[parent]?.['./shared'] !== undefined)
  t.assert.ok(hasEdge('node_modules/pkg/a.js'), 'pkg/a.js -> ./shared recorded')
  t.assert.ok(hasEdge('node_modules/pkg/b.js'), 'pkg/b.js -> ./shared recorded (the previously under-recorded sibling edge)')
}))

// A cache-shared relative require of a directory whose package.json `main` != index.js
// must resolve to `main`, not index.js. The bundle carries no package.json, so the
// resolved target has to be the attested one. The Module._load capture shim records
// ./sub -> sub/real.js (main) under BOTH a.js and b.js (b.js's require hits the module
// cache), so at load b.js resolves to real.js via its recorded edge -- the captured
// resolution already baked in package.json `main`, so index.js is never guessed.
test('run --bundle=load honors package.json main for a cache-shared directory require', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'main-dir', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import m from 'pkg'\nconsole.log(m)\n")
  const pkg = join(tmp, 'node_modules', 'pkg')
  mkdirSync(join(pkg, 'sub'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(pkg, 'index.js'), "module.exports = (process.env.WARM ? require('./a') + require('./sub/index.js') : '') + require('./b')\n")
  writeFileSync(join(pkg, 'a.js'), "module.exports = require('./sub')\n")
  writeFileSync(join(pkg, 'b.js'), "module.exports = require('./sub')\n")
  writeFileSync(join(pkg, 'sub', 'package.json'), JSON.stringify({ main: 'real.js' }))
  writeFileSync(join(pkg, 'sub', 'real.js'), "module.exports = 'REAL'\n")
  writeFileSync(join(pkg, 'sub', 'index.js'), "module.exports = 'INDEX'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp, env: { ...cleanEnv, WARM: '1' } }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'REAL\n') // the package's main, NOT sub/index.js
}))

// A cache-shared BARE require of a multi-version dependency must resolve to the copy
// Node picked at capture (the NEAREST node_modules). pkgA/a.js and pkgA/b.js both
// require 'dep'; a.js loads pkgA's nested dep and b.js's require hits the cache. The
// Module._load capture shim records 'dep' -> pkgA's nested dep under BOTH, and pkgB
// records 'dep' -> the top-level dep -- so at load each resolves to its captured copy
// via its own recorded edge (no node_modules walk: the right copy is already attested).
test('run --bundle=load resolves a cache-shared multi-version bare require to its recorded copy', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'multi-ver', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import a from 'pkgA'\nimport b from 'pkgB'\nconsole.log(a + '|' + b)\n")
  const mkdep = (dir, val) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(dir, 'index.js'), `module.exports = '${val}'\n`)
  }
  mkdep(join(tmp, 'node_modules', 'dep'), 'TOP')
  mkdep(join(tmp, 'node_modules', 'pkgA', 'node_modules', 'dep'), 'NESTED')
  const pkgA = join(tmp, 'node_modules', 'pkgA')
  writeFileSync(join(pkgA, 'package.json'), JSON.stringify({ name: 'pkgA', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(pkgA, 'index.js'), "module.exports = (process.env.WARM ? require('./a') : '') + require('./b')\n")
  writeFileSync(join(pkgA, 'a.js'), "module.exports = require('dep')\n")
  writeFileSync(join(pkgA, 'b.js'), "module.exports = require('dep')\n")
  const pkgB = join(tmp, 'node_modules', 'pkgB')
  mkdirSync(pkgB, { recursive: true })
  writeFileSync(join(pkgB, 'package.json'), JSON.stringify({ name: 'pkgB', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(pkgB, 'index.js'), "module.exports = require('dep')\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp, env: { ...cleanEnv, WARM: '1' } }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'NESTED|TOP\n') // pkgA/b.js -> nested copy, pkgB -> top copy
}))

// A subpath import ('#name', a package's "imports" field) resolves within the
// importer's OWN package. Two packages share the '#impl' specifier mapping to their
// own impl.js; each package's y.js requires '#impl' after index.js already loaded it
// (cache-shared). The Module._load capture shim records '#impl' under each y.js to its
// own package's impl.js, so at load each resolves within its package via the recorded
// edge -- the captured resolution is inherently package-scoped, no '#name' walk needed.
test('run --bundle=load resolves a cache-shared #imports subpath within the importing package', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'imp', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import a from 'pkgA'\nimport b from 'pkgB'\nconsole.log(a + '|' + b)\n")
  for (const p of ['A', 'B']) {
    const dir = join(tmp, 'node_modules', `pkg${p}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `pkg${p}`, version: '1.0.0', main: 'index.js', imports: { '#impl': './impl.js' } }))
    writeFileSync(join(dir, 'index.js'), "module.exports = (process.env.WARM ? require('#impl') : '') + require('./y')\n")
    writeFileSync(join(dir, 'y.js'), "module.exports = require('#impl')\n")
    writeFileSync(join(dir, 'impl.js'), `module.exports = '${p}IMPL'\n`)
  }

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp, env: { ...cleanEnv, WARM: '1' } }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'AIMPL|BIMPL\n') // each #impl resolves within its own package
}))

// A workspace `#imports` subpath that is cache-shared at capture: main.cjs requires
// #local first (loading impl.cjs), so y.cjs's require('#local') hits Node's module cache.
// The Module._load capture shim still records y.cjs's edge, so at load -- where main.cjs
// (no WARM) reaches y.cjs first -- y.cjs's #local resolves via its OWN recorded edge.
test('run --bundle=load resolves a cache-shared workspace #imports subpath from the bundle', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ws-imp', version: '1.0.0', private: true, imports: { '#local': './impl.cjs' } }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import m from './main.cjs'\nconsole.log(m)\n")
  writeFileSync(join(tmp, 'main.cjs'), "module.exports = (process.env.WARM ? require('#local') : '') + require('./y.cjs')\n")
  writeFileSync(join(tmp, 'y.cjs'), "module.exports = require('#local')\n")
  writeFileSync(join(tmp, 'impl.cjs'), "module.exports = 'LOCAL'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp, env: { ...cleanEnv, WARM: '1' } }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // Remove the target from disk so the bundle is the only source: at load, y.cjs's
  // recorded #local edge resolves to impl.cjs, served from the bundle (not disk).
  rmSync(join(tmp, 'impl.cjs'))

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'LOCAL\n')
}))

// require.resolve() resolves through native Module._resolveFilename and, on Node
// versions where that bypasses the resolve hook (e.g. 24.x), addImport never sees
// it -- so the edge wasn't recorded and require.resolve() failed at load even when
// the target is in the bundle. write()'s backfill records it (for in-bundle
// targets), so require.resolve() returns the bundled path at load.
test('run --bundle=load records and resolves a require.resolve() edge', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'rr', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import './r.cjs'\n")
  writeFileSync(join(tmp, 'r.cjs'), "const p = require.resolve('dep')\nconsole.log(require('node:path').basename(p), require(p))\n")
  const dep = join(tmp, 'node_modules', 'dep')
  mkdirSync(dep, { recursive: true })
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dep, 'index.js'), "module.exports = 'DEP'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

  // the require.resolve('dep') edge is recorded (the regression: it was missing)
  const imports = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).imports
  const recorded = Object.values(imports).some((byParent) =>
    Object.values(byParent).some((specs) => specs.dep === 'node_modules/dep/index.js'))
  t.assert.ok(recorded, 'require.resolve("dep") edge recorded in the lockfile')

  // Bundle-only load (node_modules gone): require.resolve('dep') must return the
  // bundled path. Skip where Node can't serve an off-disk require.resolve target
  // from a bundle-served CJS module (see RESOLVE_RESOLVE_FROM_BUNDLE).
  if (!RESOLVE_RESOLVE_FROM_BUNDLE) {
    t.diagnostic(`skipping bundle-only require.resolve load on ${process.version} (Node loader limitation)`)
    return
  }

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'index.js DEP\n')
}))

// A resolve-only require.resolve() -- a module resolved but NEVER loaded in-process
// -- must (a) not crash capture and (b) keep its resolution edge so the same
// require.resolve() returns the same path at load, EVEN THOUGH the target's bytes
// are not in the bundle. This is the worker-farm shape: at import time it does
// require.resolve('./child') for a worker it forks into a separate process, so the
// child is never loaded by the parent and never bundled -- but if the edge is
// dropped, importing worker-farm throws at load when that require.resolve can't be
// satisfied. (On Node 26.x the edge routes through the resolve hook and previously
// tripped #backfillBeforeWrite's missing-file assertion, crashing capture.)
test('run --bundle=load keeps a resolve-only require.resolve() edge whose target is not bundled', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ro', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import wf from 'wf'\nimport { basename } from 'node:path'\nconsole.log(basename(wf))\n")
  const wf = join(tmp, 'node_modules', 'wf')
  mkdirSync(wf, { recursive: true })
  writeFileSync(join(wf, 'package.json'), JSON.stringify({ name: 'wf', version: '1.0.0', main: 'index.js' }))
  // index.js resolves ./child but never require()s it (a forked worker, in real life)
  writeFileSync(join(wf, 'index.js'), "module.exports = require.resolve('./child')\n")
  writeFileSync(join(wf, 'child.js'), "module.exports = 'CHILD never loaded in this process'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'child.js\n')

  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  // the resolve-only edge IS recorded ...
  const edgeRecorded = Object.values(lock.imports).some((byParent) =>
    Object.values(byParent).some((specs) => specs['./child'] === 'node_modules/wf/child.js'))
  t.assert.ok(edgeRecorded, 'resolve-only require.resolve("./child") edge recorded')
  // ... but the target's bytes are NOT bundled (it was never loaded)
  const wfFiles = lock.modules['node_modules/wf']?.files ?? {}
  t.assert.ok('index.js' in wfFiles, 'wf/index.js is captured')
  t.assert.ok(!('child.js' in wfFiles), 'wf/child.js is NOT captured (resolve-only)')

  // frozen load with node_modules gone: require.resolve('./child') still resolves to
  // the recorded path even though child.js exists neither on disk nor in bundle. Skip
  // where Node can't serve an off-disk require.resolve target from a bundle-served CJS
  // module (see RESOLVE_RESOLVE_FROM_BUNDLE); the edge-kept regression is covered by
  // the unconditional assertions above.
  if (!RESOLVE_RESOLVE_FROM_BUNDLE) {
    t.diagnostic(`skipping bundle-only require.resolve load on ${process.version} (Node loader limitation)`)
    return
  }

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'child.js\n')
}))

// require()/require.resolve() resolve under Node's REQUIRE conditions ([require, node,
// node-addons, module-sync], + any --conditions) -- they honor the `require` branch of
// conditional exports, so they are NOT condition-free. The recorded edge must be keyed
// under those conditions, never the wildcard '*' (which would claim condition-
// independence and let an import query fall back onto a require resolution). On newer
// Node the resolve hook keys it directly; on 24.14 require.resolve is native and gets
// backfilled, reusing the require-condition set observed from a require() (here,
// require('a')). Either way the key must carry 'require', not '*'.
test('run --lock=add keys require.resolve() edges under require conditions, not "*"', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'cond', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import './r.cjs'\n")
  // require('a') makes the resolve hook report the require-condition set on every
  // supported Node; require.resolve('b') (resolve-only) is the edge under test.
  writeFileSync(join(tmp, 'r.cjs'), "require('a')\nrequire.resolve('b')\nconsole.log('ok')\n")
  for (const name of ['a', 'b']) {
    const d = join(tmp, 'node_modules', name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(d, 'index.js'), `module.exports = '${name}'\n`)
  }

  const save = run(['run', '--lock=add', 'index.mjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'ok\n')

  const imports = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).imports
  // every condition bucket recording the require.resolve('b') edge must be a require-
  // condition set, never '*'
  const bKeys = Object.entries(imports)
    .filter(([, byParent]) => Object.values(byParent).some((s) => s.b === 'node_modules/b/index.js'))
    .map(([cond]) => cond)
  t.assert.ok(bKeys.length > 0, 'require.resolve("b") edge recorded')
  for (const cond of bKeys) {
    t.assert.notEqual(cond, '*', `require.resolve edge keyed '*' (buckets: ${JSON.stringify(bKeys)})`)
    t.assert.ok(cond.split(', ').includes('require'), `expected require conditions, got '${cond}'`)
  }
}))

// node:59666. When a load hook supplies `source` for a CommonJS module, Node's
// ESM->CJS translator (loadCJSModule) hands it a *re-invented* require() that sets
// only `.resolve`/`.main` -- `.cache` and `.extensions` are undefined, unlike the
// require a disk-loaded CJS module gets. bundle=load is the only mode that serves CJS
// via a source override, so the deficiency only shows there. The loader repairs the
// two properties from node:module before user code runs. This is the direct guard:
// a bundle-served (off-disk) entry must see require.cache/require.extensions that ARE
// the real Module._cache/_extensions.
test('run --bundle=load gives a bundle-served CJS module a require() with .cache and .extensions (node:59666)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'req-shape', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.cjs'),
    "const m = require('node:module')\n" +
    'console.log(JSON.stringify([typeof require.cache, typeof require.extensions, ' +
    'require.cache === m.Module._cache, require.extensions === m.Module._extensions]))\n')

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, `${JSON.stringify(['object', 'object', true, true])}\n`)

  // Serve the entry entirely from the bundle: this is the path that gets the
  // re-invented require. Before the repair, `typeof require.cache` was 'undefined'.
  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, `${JSON.stringify(['object', 'object', true, true])}\n`)
}))

// The import-fresh@3.3.1 interaction, in its mechanism: a module-invalidation
// helper does `delete require.cache[require.resolve(id)]; require(id)`. Under
// bundle=load this threw `Cannot read properties of undefined (reading '<path>')`
// at `require.cache[...]` before the node:59666 repair, because the entry's
// re-invented require() had no `.cache`. This is the regression guard: the pattern
// must complete (no crash), and the two plain require()s must agree.
//
// counter.cjs is kept ON DISK so require.resolve() is version-independent; only the
// ENTRY is served from the bundle (removed from disk), and the entry is the module
// that receives the re-invented require under test. We deliberately do NOT assert a
// fresh re-evaluation ([1,1,2,3]): a bundle-served module lives in the ESM loader's
// own CJS cache, not Module._cache, so this inline form returns the cached instance
// ([1,1,1,1]) even though the published import-fresh -- via resolve-from +
// parent.require -- does force a fresh eval. Asserting only the stable contract
// keeps the test independent of that Node-internal detail.
test('run --bundle=load survives import-fresh-style require.cache busting (node:59666)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'fresh', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'counter.cjs'),
    'globalThis.__n = (globalThis.__n || 0) + 1\nmodule.exports = globalThis.__n\n')
  writeFileSync(join(tmp, 'index.cjs'),
    "const fresh = (id) => { delete require.cache[require.resolve(id)]; return require(id) }\n" +
    "const a = require('./counter.cjs')\n" +
    "const b = require('./counter.cjs')\n" +
    "const c = fresh('./counter.cjs')\n" +
    "const d = fresh('./counter.cjs')\n" +
    'console.log(JSON.stringify([a, b, c, d]))\n')

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, '[1,1,2,3]\n') // on disk: ordinary Node require, genuine fresh re-eval

  // Serve the entry from the bundle (counter.cjs stays on disk so require.resolve is
  // version-independent). Before the repair this crashed at `require.cache[...]`.
  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  const parsed = JSON.parse(load.stdout)
  t.assert.equal(parsed.length, 4)
  t.assert.ok(parsed.every((n) => typeof n === 'number'), `expected 4 numbers, got ${load.stdout}`)
  t.assert.equal(parsed[0], parsed[1], 'the two plain require()s return a consistent value')
}))

// Regression for the node:59666 repair's directive handling: the require-repair
// prelude must be inserted AFTER the module's full Directive Prologue (shebang,
// comments, and string-literal directives), never before or fused onto it. Two
// realistic shapes broke a naive "match a bare leading 'use strict'" approach:
//   (a) a license/banner comment BEFORE `'use strict'` -> prelude inserted at
//       offset 0 -> the directive is demoted to an expression -> the module
//       silently runs in SLOPPY mode under bundle=load but strict on disk; and
//   (b) `'use strict'` followed by a comment with no semicolon -> the prelude's
//       `try{` fuses onto the directive -> SyntaxError, failing the load.
// The module below is strict on disk (a `with` statement would be a SyntaxError);
// its `f()` assigns to an undeclared name, which throws only in strict mode. We
// assert the served module still throws -> strict mode preserved, no demotion.
test('run --bundle=load preserves a strict-mode directive behind a leading comment (node:59666)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'banner', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.cjs'),
    '/*! license banner (c) */\n' +
    "'use strict'\n" +
    'module.exports = (() => { try { undeclaredStrictProbe = 1; return "sloppy" } catch { return "strict" } })()\n' +
    'console.log(module.exports)\n')

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'strict\n') // strict on disk

  // Served from the bundle, the directive must still take effect (not be demoted).
  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'strict\n', 'strict-mode directive must survive bundle=load (no demotion)')
}))

test('run --bundle=load handles a "use strict" directive trailed by a comment without crashing (node:59666)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'trail', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  // 'use strict' followed by a line comment, NO semicolon -> naive splicing produced
  // `'use strict'try{...` -> SyntaxError. The prologue-aware insertion avoids it.
  writeFileSync(join(tmp, 'index.cjs'),
    "'use strict'// directive comment, no semicolon\nconsole.log('ok')\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'ok\n')

  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'ok\n')
}))

// Regression for over-skip in the node:59666 repair: a module whose FIRST statement
// is an EXPRESSION beginning with a string literal (`'x'.toUpperCase()`, `'a' + b`,
// `'a', b`) must not be mistaken for a `'use strict'`-style directive. Mis-skipping
// the leading string splices the prelude mid-expression, which either fails to parse
// or -- worse -- silently changes the value. The repair only skips a string when a
// statement boundary follows it. This module opens with a string method call and a
// string-concatenation expression; both must survive bundle=load intact.
test('run --bundle=load leaves a leading string EXPRESSION intact (node:59666 over-skip)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'overskip', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.cjs'),
    "'HELLO'.toLowerCase()\n" +                    // string-method expression statement (not a directive)
    "module.exports = 'a' + 'b'\n" +               // string-concat: must stay 'ab', not be split
    "console.log(module.exports)\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'ab\n')

  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'ab\n', 'a leading string expression must not be split by the repair')
}))

// Regression for a subtler over-skip in the node:59666 repair: a module whose first
// statement is a MULTI-LINE expression beginning with a string -- e.g. `'a,b'` on one
// line, `.split(',')` on the next. JS ASI does NOT insert a semicolon before a leading
// `.` (or `[`, `+`, ...) on the following line, so this is a single expression, not a
// directive. A naive "string followed by a line break = directive" check splices the
// prelude between the string and the `.`, crashing the load. The repair peeks past the
// line break and treats it as a directive only when the next token can't continue the
// expression.
test('run --bundle=load leaves a multi-line leading string expression intact (node:59666 over-skip)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'nlcont', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  // The module's FIRST statement is a bare string whose expression continues on the next
  // line via `.split` -- not a directive, so the string must not be skipped/split.
  writeFileSync(join(tmp, 'index.cjs'),
    "'a,b'\n" +
    "  .split(',')\n" +
    "  .forEach((w) => console.log(w))\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'a\nb\n')

  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'a\nb\n', 'a multi-line leading string expression must not be split by the repair')
}))

// The keyword-operator tail of the same over-skip class: a leading string whose
// expression continues via the `in` / `instanceof` operator on the next line
// (`'k'\nin obj`). ASI does not break before those keywords, so the string is not a
// directive. The repair peeks past the line break for both punctuator and keyword
// continuations, so the module is left intact rather than split at `in`.
test('run --bundle=load leaves a leading string continued by `in`/`instanceof` intact (node:59666 over-skip)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'kwcont', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.cjs'),
    "'length'\n" +
    'in globalThis\n' +
    "console.log('ok')\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'ok\n')

  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'ok\n', 'a string continued by `in` must not be split by the repair')
}))

// A `'use strict'` directive trailed by a NEWLINE-SPANNING block comment (a multi-line
// banner) before the next statement. Per spec a block comment containing a line terminator
// acts as a line terminator for ASI, so `'use strict'` is a real directive here and the
// module is strict on disk. The repair must treat that comment as a line boundary (not skip
// past it and land on the next statement, which demoted the directive to sloppy mode).
test('run --bundle=load keeps strict mode across a multi-line block comment after the directive (node:59666)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'mlbanner', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  // The block comment's own line terminator is the only break; module.exports follows `*/`
  // on the same physical line -- so the trailer must not skip past the comment onto it.
  writeFileSync(join(tmp, 'index.cjs'),
    "'use strict' /* banner\n spanning lines */ module.exports = " +
    "(() => { try { undeclaredStrictProbe = 1; return 'sloppy' } catch { return 'strict' } })()\n" +
    'console.log(module.exports)\n')

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'strict\n')

  rmSync(join(tmp, 'index.cjs'))
  const load = run(['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.cjs'], { cwd: tmp })
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'strict\n', 'a directive before a multi-line block comment must stay strict under bundle=load')
}))
