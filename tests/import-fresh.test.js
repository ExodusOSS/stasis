import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

// End-to-end regression for the node:59666 fix, using the REAL import-fresh@3.3.1
// package (vendored under the fixture's node_modules, with its resolve-from /
// parent-module / callsites deps). import-fresh invalidates Node's module cache with
// `delete require.cache[require.resolve(id)]` and re-require()s -- which threw
// `Cannot read properties of undefined` under bundle=load before the loader restored
// the `require.cache` that Node's ESM->CJS translator omits for loader-supplied CJS.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'import-fresh')

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
  const dir = mkdtempSync(join(tmpdir(), 'stasis-import-fresh-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Can THIS Node resolve a bundle-served module's require from a bundle with node_modules
// removed? import-fresh reaches its target via resolve-from + parent-module (callsites /
// Error-stack introspection). Under a bundle-served module's re-invented require, Node
// 24.15-26.2 changed the stack/off-disk-resolution behavior resolve-from depends on, so
// parent-module returns the wrong caller directory and the re-require can't be found.
// 24.14 and 26.3+ resolve it. This is the same limitation the CJS suite probes for
// require.resolve; probe the real behavior once rather than hardcode a version range.
const RESOLVE_RESOLVE_FROM_BUNDLE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-import-fresh-probe-'))
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

test('run --bundle=load runs the real import-fresh package from a bundle (node:59666)', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')

  // Capture: on disk this is ordinary Node, so import-fresh genuinely re-evaluates
  // counter.cjs -> [1,1,2,3] (two cached requires, then two fresh ones).
  const save = run(
    ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: tmp }
  )
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  t.assert.equal(save.stdout, '[1,1,2,3]\n')
  t.assert.ok(existsSync(bundlePath))

  // import-fresh and its dependency graph are captured in the bundle.
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)).toString('utf-8'))
  const names = new Set(Object.values(decoded.modules).map((m) => m.name))
  for (const pkg of ['import-fresh', 'resolve-from', 'parent-module', 'callsites']) {
    t.assert.ok(names.has(pkg), `bundle should capture ${pkg}; got ${[...names].join(', ')}`)
  }

  // Bundle-only load: import-fresh (and its deps) are served from the bundle, so their
  // re-invented require() is the one the loader repairs -- the require.cache access no
  // longer throws (the node:59666 fix). Reaching the fresh-required target additionally
  // relies on resolve-from + parent-module, which Node 24.15-26.2 can't satisfy from a
  // bundle-served module (see RESOLVE_RESOLVE_FROM_BUNDLE); skip the end-to-end load
  // there. The capture + bundle-contents assertions above run on every version, and the
  // hermetic require.cache tests in commonjs.test.js cover the repair itself unconditionally.
  if (!RESOLVE_RESOLVE_FROM_BUNDLE) {
    t.diagnostic(`skipping bundle-only import-fresh load on ${process.version} (Node loader limitation)`)
    return
  }
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true })

  const load = run(
    ['run', '--lock=frozen', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.cjs'],
    { cwd: tmp }
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, '[1,1,2,3]\n')
}))
