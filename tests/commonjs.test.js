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

// Regression for the fs-extra `Cannot find module '../mkdirs'` report. Node's
// module cache makes the resolve hook miss a require() whose target another module
// already loaded, so the edge is recorded under only ONE importer. When a
// different importer is the first to need it at load time, the per-parent edge is
// absent -- resolveBundled must recover the target from the bundle's own file set
// (here a relative require, resolved by path + index). Capture warms a.js first
// (recording ./shared under a.js); at load a.js is skipped, so b.js is the first
// to require ./shared, where the edge was never recorded. Fails without the
// file-set fallback (bare `Cannot find module './shared'`).
test('run --bundle=load resolves an under-recorded (module-cached) require from the bundle', withTmp((t, tmp) => {
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

// Review finding: an under-recorded relative require of a directory whose
// package.json `main` != index.js must resolve to `main`, not index.js. The bundle
// carries no package.json, so structural resolution alone picks the wrong file;
// resolveBundled reuses the attested target a sibling importer recorded for the
// same location. Warm-up records ./sub -> sub/real.js (main) under a.js AND pulls
// sub/index.js into the bundle; at load b.js's under-recorded ./sub must still hit
// real.js. Without the attested-target reuse this silently runs sub/index.js.
test('run --bundle=load honors package.json main for an under-recorded directory require', withTmp((t, tmp) => {
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

// Review finding: an under-recorded BARE require of a multi-version dependency
// must resolve to the NEAREST node_modules copy. With several versions bundled the
// cross-parent reuse can't pick by uniqueness, so resolveBundled walks node_modules
// from the importer. pkgA/a.js records 'dep' -> pkgA's nested dep; pkgA/b.js is
// under-recorded; pkgB records 'dep' -> the top-level dep.
test('run --bundle=load resolves an under-recorded bare require to the nearest node_modules copy', withTmp((t, tmp) => {
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

// Review finding: a subpath import ('#name', a package's "imports" field) is
// bare-looking but resolves within the importer's OWN package, not via a
// node_modules walk. When two packages share a '#' specifier and both edges are
// under-recorded, the bare walk would look for a package literally named '#name'
// and crash; resolveBundled scopes '#' specifiers to the importer's package.
test('run --bundle=load scopes an under-recorded #imports subpath to the importing package', withTmp((t, tmp) => {
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

  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, 'index.js DEP\n')
}))

// The optional-dependency probe `try { require.resolve('x') } catch {}`, where the
// target is NEVER require()d, must not crash capture. On Node 26.x require.resolve
// routes through the resolve hook and records an edge to the unloaded target;
// write() prunes such resolve-only edges (the file isn't bundled, so recording it
// is useless and previously tripped #backfillBeforeWrite's missing-file check,
// crashing capture on Node 26).
test('run --bundle=add does not crash on a resolve-only require.resolve (optional-dep probe)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ro', version: '1.0.0', private: true }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(tmp, 'index.mjs'), "import './r.cjs'\n")
  writeFileSync(join(tmp, 'r.cjs'), "let ok = false\ntry { require.resolve('opt'); ok = true } catch {}\nconsole.log('probe', ok)\n")
  const opt = join(tmp, 'node_modules', 'opt')
  mkdirSync(opt, { recursive: true })
  writeFileSync(join(opt, 'package.json'), JSON.stringify({ name: 'opt', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(opt, 'index.js'), "module.exports = 'OPT'\n")

  const bundlePath = join(tmp, 'snapshot.br')
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'index.mjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, 'probe true\n')
  // opt is resolve-only (never require()d): not bundled, so the edge is pruned.
  const imports = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')).imports
  const hasOpt = Object.values(imports).some((byParent) => Object.values(byParent).some((s) => 'opt' in s))
  t.assert.ok(!hasOpt, 'resolve-only require.resolve target is not recorded')
}))
