// Characterization tests for resolution differences between `stasis run` (Node's real
// resolvers, observed via hooks) and `stasis bundle` (scan.js: the CJS algorithm via
// createRequire(file).resolve with steered conditions). Identical on Node 24.18 / 26.5.
//
//   A. Silent wrong-file: everything builds and runs, but the static graph attests a
//      different file than Node loads, and --bundle=load executes it. A1 (createRequire()d
//      require() in ESM) and A2 (literal import() in CJS) are FIXED: scan resolves per edge
//      kind, and divergent targets keep their real condition keys instead of one '*' entry.
//      A3 (ESM percent-decoding vs CJS literal paths) remains.
//   B. Over-resolution: CJS-only probing (extensionless, directory index, nested dir main,
//      subpaths) leaks into ESM import edges -- bundles build, and --bundle=load runs,
//      graphs plain node refuses.
//   C. Over-inclusion: a shadowed `require` identifier in dead code attests files/edges the
//      runtime can never resolve; frozen verify tolerates them.
//   D. Under-inclusion: aliased require, require.resolve(), import.meta.resolve() edges
//      exist only in the runtime capture. Not pinned yet: how --bundle=load reacts (resolve
//      error, unattested-load error, or even success for resolve-only edges) varies across
//      the supported Node floor (24.14/26.0 vs latest).
//   E. ?query/#fragment relative imports: plain node runs them; `stasis run` dies on a
//      State.absolute round-trip assert, `stasis bundle` fails closed.
//
// Only a real (disk) run under --lock=frozen / --bundle=frozen catches class A;
// --bundle=load alone executes it silently. DIVERGENCE assertions pin current behavior --
// when a class is fixed, update them to the converged expectations (see A1/A2).

/* eslint-disable no-await-in-loop -- several tests iterate a small set of independent
   resolution scenarios and run each scenario's (bundle -> load -> frozen) subprocess
   chain sequentially by design. Parallelism comes from the describe-level `concurrency`
   below (across tests); awaiting per scenario keeps each test's live subprocess count at
   one, rather than fanning out and oversubscribing the box. */
import { test, describe } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-run-vs-bundle-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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

// Async runner (see the other spawning test files): spawn() + once('close') yields
// so the describe-level `concurrency` below actually overlaps the subprocesses.
const exec = async (args, cwd) => {
  const child = spawn(process.execPath, args, { cwd, env: cleanEnv })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return { status, stdout: Buffer.concat(stdoutChunks).toString('utf-8'), stderr: Buffer.concat(stderrChunks).toString('utf-8') }
}
const plainNode = (dir, entry) => exec([entry], dir)
const stasisRun = (dir, entry) => exec([cli, 'run', '--lock=add', entry], dir)
const stasisBundle = (dir, entry) =>
  exec([cli, 'bundle', '--lockfile=static.lock.json', '--output=static.code.br', entry], dir)
const bundleLoad = (dir, entry) =>
  exec([cli, 'run', '--lock=none', '--bundle=load', '--bundle-file=static.code.br', entry], dir)
// Real (disk) execution verified against the STATIC lockfile -- must catch class A.
const frozenRun = (dir, entry) => exec([cli, 'run', '--lock=frozen', entry], dir)

// Lockfile edges as "parent :: spec" -> { conditionKey: target }, plus the attested file set.
function flattenLock(path) {
  const lock = JSON.parse(readFileSync(path, 'utf-8'))
  const edges = new Map()
  for (const [cond, byParent] of Object.entries(lock.imports ?? {})) {
    for (const [parent, specs] of Object.entries(byParent)) {
      for (const [spec, target] of Object.entries(specs)) {
        const key = `${parent} :: ${spec}`
        if (!edges.has(key)) edges.set(key, {})
        edges.get(key)[cond] = target
      }
    }
  }
  const files = new Set()
  for (const [dir, bucket] of Object.entries({ ...lock.sources, ...lock.modules })) {
    for (const f of Object.keys(bucket.files ?? {})) files.add(dir === '.' ? f : `${dir}/${f}`)
  }
  return { edges, files }
}

// The single distinct target of an edge across condition keys (asserts it IS single).
function soleTarget(t, { edges }, key) {
  const byCond = edges.get(key)
  t.assert.ok(byCond, `edge missing: ${key}`)
  const targets = [...new Set(Object.values(byCond))]
  t.assert.equal(targets.length, 1, `edge ${key} has divergent targets: ${JSON.stringify(byCond)}`)
  return targets[0]
}

const put = (base) => (rel, content) => {
  const p = join(base, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
const json = (o) => `${JSON.stringify(o, null, 2)}\n`

// Fixture app: typeless root package + the packages/files the scenarios below need.
function makeApp(base) {
  const w = put(base)
  w('package.json', json({ name: 'matrix-app', version: '1.0.0' }))
  // Conditional import/require exports.
  w('node_modules/dual/package.json', json({
    name: 'dual', version: '1.0.0',
    exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } },
  }))
  w('node_modules/dual/esm.mjs', 'export const which = "dual:ESM"\n')
  w('node_modules/dual/cjs.cjs', 'exports.which = "dual:CJS"\n')
  // No exports; main is a directory with its own package.json main.
  w('node_modules/nested-main/package.json', json({ name: 'nested-main', version: '1.0.0', main: './lib' }))
  w('node_modules/nested-main/lib/package.json', json({ main: './real.js' }))
  w('node_modules/nested-main/lib/real.js', 'exports.which = "nested-main:REAL"\n')
  w('node_modules/nested-main/lib/index.js', 'exports.which = "nested-main:INDEX"\n')
  // No exports; subpath consumed without extension.
  w('node_modules/noexp/package.json', json({ name: 'noexp', version: '1.0.0', main: './lib/main.js' }))
  w('node_modules/noexp/lib/main.js', 'exports.main = "noexp:MAIN"\n')
  w('node_modules/noexp/lib/util.js', 'export const u = "noexp:UTIL"\n')
  // Babelified ESM->CJS dep consuming `dual`; Node must ignore the `module` field.
  w('node_modules/babel-dep/package.json', json({
    name: 'babel-dep', version: '1.0.0', main: 'lib/index.js', module: 'src/index.mjs',
  }))
  w('node_modules/babel-dep/src/index.mjs',
    'import dual from "dual"\nexport const report = () => `babel-dep(src!) saw ${dual.which}`\n')
  w('node_modules/babel-dep/lib/index.js', '"use strict";\n' +
    'Object.defineProperty(exports, "__esModule", { value: true });\n' +
    'exports.report = void 0;\n' +
    'var _dual = _interopRequireWildcard(require("dual"));\n' +
    'function _interopRequireWildcard(e) { return e && e.__esModule ? e : { default: e, ...e }; }\n' +
    'const report = () => `babel-dep saw ${_dual.which}`;\n' +
    'exports.report = report;\n')
  // Conditional exports + conditional #imports; '#ext' is itself a bare conditional-exports target.
  w('node_modules/imports-pkg/package.json', json({
    name: 'imports-pkg', version: '1.0.0',
    exports: { '.': { import: './entry.mjs', require: './entry.cjs' } },
    imports: { '#impl': { import: './impl.mjs', require: './impl.cjs' }, '#ext': 'dual' },
  }))
  w('node_modules/imports-pkg/entry.mjs',
    'import { which } from "#impl"\nimport { which as ext } from "#ext"\nexport const via = `esm-entry:${which}:${ext}`\n')
  w('node_modules/imports-pkg/entry.cjs',
    'const { which } = require("#impl")\nconst { which: ext } = require("#ext")\nexports.via = `cjs-entry:${which}:${ext}`\n')
  w('node_modules/imports-pkg/impl.mjs', 'export const which = "impl:ESM"\n')
  w('node_modules/imports-pkg/impl.cjs', 'exports.which = "impl:CJS"\n')
  w('helpers/util.js', 'export const u = "helpers:UTIL"\n')
  w('helpers/index.js', 'exports.h = "helpers:INDEX"\n')
  w('enc/a b.mjs', 'export const which = "enc:DECODED"\n')
  w('enc/a%20b.mjs', 'export const which = "enc:LITERAL"\n')
  w('data.json', json({ k: 'json:VALUE' }))
  w('phantom.cjs', 'exports.p = "PHANTOM"\n')
  w('hidden.cjs', 'exports.h = "HIDDEN"\n')
  w('q/mod.mjs', 'export const q = "query:MOD"\n')
  return w
}

// Sibling dirs so artifacts never cross-contaminate: capture in `run`, static build + load
// in `bundle`, disk run against the static lockfile in `frozen`.
function scenario(tmp, entry, source) {
  const dirs = { run: join(tmp, 'run'), bundle: join(tmp, 'bundle'), frozen: join(tmp, 'frozen') }
  for (const d of Object.values(dirs)) makeApp(d)(entry, source)
  return dirs
}
const installStaticLock = (dirs) =>
  cpSync(join(dirs.bundle, 'static.lock.json'), join(dirs.frozen, 'stasis.lock.json'))

// --- Class A: silent wrong-file misresolutions (A1/A2 fixed, now pinned as controls) ---

// Exact condition keys Node's runtime hooks report (24/26); scan emits the same strings.
const IMPORT_KEY = 'node, import, module-sync, node-addons'
const REQUIRE_KEY = 'require, node, node-addons, module-sync'

// node --test runs test files in parallel; each test here spawns several stasis /
// node subprocesses. A small per-file cap bounds total concurrent subprocesses.
const CONCURRENCY = 4 // matches CI runner cores

describe('run vs bundle resolution (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('FIXED A1: require() via createRequire inside ESM resolves with require conditions', withTmp(async (t, tmp) => {
    // The require() edge takes the require branch, the import edge of the SAME (parent,
    // specifier) the import branch; divergent targets are keyed by real conditions.
    const entry = 'main.mjs'
    const dirs = scenario(tmp, entry, `import { createRequire } from 'node:module'
import { which as viaImport } from 'dual'
const require = createRequire(import.meta.url)
console.log('import', viaImport)
console.log('require', require('dual').which)
`)

    const plain = await plainNode(dirs.run, entry)
    t.assert.equal(plain.status, 0)
    t.assert.equal(plain.stdout, 'import dual:ESM\nrequire dual:CJS\n')

    const run = await stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, run.stderr)
    t.assert.equal(run.stdout, plain.stdout, 'the observing loader must not change behavior')
    const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
    t.assert.deepEqual(
      new Set(Object.values(runLock.edges.get('main.mjs :: dual'))),
      new Set(['node_modules/dual/esm.mjs', 'node_modules/dual/cjs.cjs']),
    )

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    t.assert.deepEqual(staticLock.edges.get('main.mjs :: dual'), {
      [IMPORT_KEY]: 'node_modules/dual/esm.mjs',
      [REQUIRE_KEY]: 'node_modules/dual/cjs.cjs',
    })
    t.assert.ok(staticLock.files.has('node_modules/dual/cjs.cjs'))
    t.assert.ok(staticLock.files.has('node_modules/dual/esm.mjs'))

    const load = await bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, load.stderr)
    t.assert.equal(load.stdout, plain.stdout)

    installStaticLock(dirs)
    const frozen = await frozenRun(dirs.frozen, entry)
    t.assert.equal(frozen.status, 0, frozen.stderr)
    t.assert.equal(frozen.stdout, plain.stdout)
  }))

  test('FIXED A2: literal import() inside CJS resolves with import conditions', withTmp(async (t, tmp) => {
    // The dynamic-import OPERATOR with a static specifier resolves under IMPORT conditions
    // even from a CJS parent; the require edge keeps the require branch.
    const entry = 'main.cjs'
    const dirs = scenario(tmp, entry, `const viaRequire = require('dual').which
import('dual').then((m) => {
  console.log('require', viaRequire)
  console.log('import()', m.which)
})
`)

    const plain = await plainNode(dirs.run, entry)
    t.assert.equal(plain.status, 0)
    t.assert.equal(plain.stdout, 'require dual:CJS\nimport() dual:ESM\n')

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    t.assert.deepEqual(staticLock.edges.get('main.cjs :: dual'), {
      [IMPORT_KEY]: 'node_modules/dual/esm.mjs',
      [REQUIRE_KEY]: 'node_modules/dual/cjs.cjs',
    })
    t.assert.ok(staticLock.files.has('node_modules/dual/esm.mjs'))

    const load = await bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, load.stderr)
    t.assert.equal(load.stdout, plain.stdout)

    installStaticLock(dirs)
    const frozen = await frozenRun(dirs.frozen, entry)
    t.assert.equal(frozen.status, 0, frozen.stderr)
    t.assert.equal(frozen.stdout, plain.stdout)
  }))

  test('DIVERGENCE A3: percent-encoded relative import resolves literally in the static scan, decoded by Node', withTmp(async (t, tmp) => {
    // ESM specifiers are URLs ('./enc/a%20b.mjs' loads 'enc/a b.mjs'); the CJS algorithm takes
    // the literal path. With both spellings on disk the resolvers silently pick different files.
    const entry = 'main.mjs'
    const dirs = scenario(tmp, entry, `import { which } from './enc/a%20b.mjs'
console.log(which)
`)

    const plain = await plainNode(dirs.run, entry)
    t.assert.equal(plain.status, 0)
    t.assert.equal(plain.stdout, 'enc:DECODED\n')

    const run = await stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, run.stderr)
    const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
    t.assert.equal(soleTarget(t, runLock, 'main.mjs :: ./enc/a%20b.mjs'), 'enc/a b.mjs')

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    // DIVERGENCE: the literal-spelling file is attested; the file Node loads is not.
    t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: ./enc/a%20b.mjs'), 'enc/a%20b.mjs')
    t.assert.ok(!staticLock.files.has('enc/a b.mjs'))

    const load = await bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, load.stderr)
    t.assert.equal(load.stdout, 'enc:LITERAL\n') // wrong file executes

    installStaticLock(dirs)
    t.assert.notEqual((await frozenRun(dirs.frozen, entry)).status, 0)

    // Control: a CJS parent loads the literal path -- no divergence.
    const cjs = scenario(join(tmp, 'cjs'), 'main.cjs', `console.log(require('./enc/a%20b.mjs').which)
`)
    t.assert.equal((await plainNode(cjs.run, 'main.cjs')).stdout, 'enc:LITERAL\n')
    t.assert.equal((await stasisBundle(cjs.bundle, 'main.cjs')).status, 0)
    t.assert.equal((await bundleLoad(cjs.bundle, 'main.cjs')).stdout, 'enc:LITERAL\n')
  }))

  // --- Class B: CJS-only resolution features leak into ESM import edges ---

  test('DIVERGENCE B: static bundles build and load graphs plain node refuses (extensionless/dir/subpath imports)', withTmp(async (t, tmp) => {
    const cases = [
      // [entry, spec, source, plain-node error, target scan invents, output under --bundle=load]
      ['extless.mjs', './helpers/util', `import { u } from './helpers/util'\nconsole.log(u)\n`,
        /ERR_MODULE_NOT_FOUND/u, 'helpers/util.js', 'helpers:UTIL\n'],
      ['dir.mjs', './helpers', `import h from './helpers'\nconsole.log(h.h)\n`,
        /ERR_UNSUPPORTED_DIR_IMPORT/u, 'helpers/index.js', 'helpers:INDEX\n'],
      ['subpath.mjs', 'noexp/lib/util', `import { u } from 'noexp/lib/util'\nconsole.log(u)\n`,
        /ERR_MODULE_NOT_FOUND/u, 'node_modules/noexp/lib/util.js', 'noexp:UTIL\n'],
      // dir subpath honoring nested package.json main (LOAD_AS_DIRECTORY): require()-only behavior
      ['dirsub.mjs', 'nested-main/lib', `import nm from 'nested-main/lib'\nconsole.log(nm.which)\n`,
        /ERR_UNSUPPORTED_DIR_IMPORT/u, 'node_modules/nested-main/lib/real.js', 'nested-main:REAL\n'],
    ]
    for (const [entry, spec, source, plainErr, invented, loadOut] of cases) {
      const dirs = scenario(join(tmp, entry), entry, source)
      const plain = await plainNode(dirs.run, entry)
      t.assert.notEqual(plain.status, 0, `${entry}: plain node must refuse`)
      t.assert.match(plain.stderr, plainErr, entry)

      // DIVERGENCE: builds, attesting an edge Node would never resolve...
      t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0, entry)
      const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
      t.assert.equal(soleTarget(t, staticLock, `${entry} :: ${spec}`), invented, entry)

      // ...and --bundle=load executes what plain node refuses to run.
      const load = await bundleLoad(dirs.bundle, entry)
      t.assert.equal(load.status, 0, `${entry}: ${load.stderr}`)
      t.assert.equal(load.stdout, loadOut, entry)

      installStaticLock(dirs)
      t.assert.notEqual((await frozenRun(dirs.frozen, entry)).status, 0, entry)
    }
  }))

  test('DIVERGENCE B2: JSON import without attribute -- bundle accepts a graph plain node refuses to load', withTmp(async (t, tmp) => {
    // Resolution agrees; the runtime dies at load (ERR_IMPORT_ATTRIBUTE_MISSING) -- invisible
    // to the scan, unenforced by the bundle loader.
    const entry = 'main.mjs'
    const dirs = scenario(tmp, entry, `import data from './data.json'
console.log(data.k)
`)
    const plain = await plainNode(dirs.run, entry)
    t.assert.notEqual(plain.status, 0)
    t.assert.match(plain.stderr, /ERR_IMPORT_ATTRIBUTE_MISSING/u)

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const load = await bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, load.stderr)
    t.assert.equal(load.stdout, 'json:VALUE\n')

    // Control: with the attribute everything agrees end to end.
    const ok = scenario(join(tmp, 'ok'), 'main.mjs', `import data from './data.json' with { type: 'json' }
console.log(data.k)
`)
    t.assert.equal((await plainNode(ok.run, 'main.mjs')).stdout, 'json:VALUE\n')
    t.assert.equal((await stasisBundle(ok.bundle, 'main.mjs')).status, 0)
    t.assert.equal((await bundleLoad(ok.bundle, 'main.mjs')).stdout, 'json:VALUE\n')
  }))

  // --- Class C: spurious static edges ---

  test('DIVERGENCE C: a shadowed `require` identifier adds files/edges the runtime never resolves', withTmp(async (t, tmp) => {
    // scan matches `require(<literal>)` by identifier name -- even a shadowed parameter in
    // dead ESM code. The artifact gains files the app can never load; frozen verify tolerates
    // over-attestation.
    const entry = 'main.mjs'
    const dirs = scenario(tmp, entry, `export function f(require) { if (globalThis.__never) require('./phantom.cjs') }
console.log('ok')
`)
    const run = await stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, run.stderr)
    const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
    t.assert.ok(!runLock.files.has('phantom.cjs'))
    t.assert.ok(!runLock.edges.has('main.mjs :: ./phantom.cjs'))

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: ./phantom.cjs'), 'phantom.cjs') // DIVERGENCE
    t.assert.ok(staticLock.files.has('phantom.cjs'))

    installStaticLock(dirs)
    t.assert.equal((await frozenRun(dirs.frozen, entry)).status, 0, 'frozen tolerates over-attestation')
  }))

  // --- Class E: URL-flavored relative specifiers ---

  test('DIVERGENCE E: ?query and #fragment relative imports run under plain node; stasis run asserts, stasis bundle fails closed', withTmp(async (t, tmp) => {
    const cases = [
      ['query.mjs', `import { q } from './q/mod.mjs?v=1'\nconsole.log(q)\n`, 'query:MOD\n'],
      ['fragment.mjs', `import { q } from './q/mod.mjs#frag'\nconsole.log(q)\n`, 'query:MOD\n'],
    ]
    for (const [entry, source, out] of cases) {
      const dirs = scenario(join(tmp, entry), entry, source)
      t.assert.equal((await plainNode(dirs.run, entry)).stdout, out, entry)

      // Capture-side: the observing loader dies on State.absolute's lossless URL round-trip
      // assert (?/# make it lossy).
      const run = await stasisRun(dirs.run, entry)
      t.assert.notEqual(run.status, 0, entry)
      t.assert.match(run.stderr, /ERR_ASSERTION/u, entry)

      // Static build fails closed.
      const build = await stasisBundle(dirs.bundle, entry)
      t.assert.notEqual(build.status, 0, entry)
      t.assert.match(build.stderr, /JS bundle would be broken at load time/u, entry)
    }
  }))

  // --- Controls: per-file condition steering IS correct for whole-file formats ---

  test('CONTROL: babelified CJS dep and direct ESM import pick their own branches of a dual package, identically at run and bundle', withTmp(async (t, tmp) => {
    const entry = 'main.mjs'
    const dirs = scenario(tmp, entry, `import { report } from 'babel-dep'
import { which } from 'dual'
console.log('app', which)
console.log('dep', report())
`)
    const expected = 'app dual:ESM\ndep babel-dep saw dual:CJS\n'
    t.assert.equal((await plainNode(dirs.run, entry)).stdout, expected)

    const run = await stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, run.stderr)
    t.assert.equal(run.stdout, expected)

    t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    // Both branches, each under its consumer's edge; the bundler-only `module` field is not followed.
    t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: dual'), 'node_modules/dual/esm.mjs')
    t.assert.equal(soleTarget(t, staticLock, 'node_modules/babel-dep/lib/index.js :: dual'), 'node_modules/dual/cjs.cjs')
    t.assert.ok(!staticLock.files.has('node_modules/babel-dep/src/index.mjs'))

    const load = await bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, load.stderr)
    t.assert.equal(load.stdout, expected)

    installStaticLock(dirs)
    t.assert.equal((await frozenRun(dirs.frozen, entry)).status, 0)
  }))

  test('CONTROL: conditional exports + conditional #imports agree between run and bundle for both parent formats', withTmp(async (t, tmp) => {
    const cases = [
      ['main.mjs', `import { via } from 'imports-pkg'\nconsole.log(via)\n`, 'esm-entry:impl:ESM:dual:ESM\n'],
      ['main.cjs', `console.log(require('imports-pkg').via)\n`, 'cjs-entry:impl:CJS:dual:CJS\n'],
    ]
    for (const [entry, source, expected] of cases) {
      const dirs = scenario(join(tmp, entry), entry, source)
      t.assert.equal((await plainNode(dirs.run, entry)).stdout, expected, entry)
      const run = await stasisRun(dirs.run, entry)
      t.assert.equal(run.status, 0, `${entry}: ${run.stderr}`)
      t.assert.equal(run.stdout, expected, entry)
      t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0, entry)
      const load = await bundleLoad(dirs.bundle, entry)
      t.assert.equal(load.status, 0, `${entry}: ${load.stderr}`)
      t.assert.equal(load.stdout, expected, entry)
      installStaticLock(dirs)
      t.assert.equal((await frozenRun(dirs.frozen, entry)).status, 0, entry)
    }
  }))

  test('CONTROL: package main chains use LOAD_INDEX, not recursive LOAD_AS_DIRECTORY -- import and require agree', withTmp(async (t, tmp) => {
    // main "./lib" with lib/package.json { main: "./real.js" }: both loaders skip the nested
    // package.json at package level and land on lib/index.js (subpath require = divergence B).
    for (const [entry, source] of [
      ['main.mjs', `import nm from 'nested-main'\nconsole.log(nm.which)\n`],
      ['main.cjs', `console.log(require('nested-main').which)\n`],
    ]) {
      const dirs = scenario(join(tmp, entry), entry, source)
      t.assert.equal((await plainNode(dirs.run, entry)).stdout, 'nested-main:INDEX\n', entry)
      t.assert.equal((await stasisBundle(dirs.bundle, entry)).status, 0, entry)
      const load = await bundleLoad(dirs.bundle, entry)
      t.assert.equal(load.stdout, 'nested-main:INDEX\n', entry)
      installStaticLock(dirs)
      t.assert.equal((await frozenRun(dirs.frozen, entry)).status, 0, entry)
    }
  }))
})
