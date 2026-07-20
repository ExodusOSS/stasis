// Characterization tests for resolution differences between `stasis run` (runtime-observed
// graph: Node's real resolvers, recorded via hooks) and `stasis bundle` (static graph:
// scan.js resolving every edge through createRequire(file).resolve(spec, { conditions }),
// i.e. the CommonJS algorithm with a per-FILE condition set).
//
// Verified identical on Node 24.18.0 and 26.5.0. Divergence classes (see per-test comments):
//
//   A. Silent wrong-file: both artifacts build and plain node runs fine, but the static
//      graph attests a DIFFERENT file than the one Node loads, and --bundle=load executes
//      that wrong file. Causes: the condition set is picked per file, not per edge kind
//      (a createRequire() require() inside ESM gets `import` conditions; a literal
//      import() inside CJS gets `require` conditions), and CJS path-string resolution vs
//      ESM URL semantics (percent-decoding).
//   B. Over-resolution: CJS-only features (extension probing, directory index, nested
//      package.json main, subpath probing) leak into ESM import edges, so the bundle
//      builds -- and --bundle=load runs -- graphs plain node refuses to load.
//   C. Over-inclusion: a shadowed `require` identifier in never-executed code adds
//      spurious files/edges to the attested artifact; frozen verify tolerates them.
//   D. Under-inclusion: resolution-only or aliased edges (const r = require;
//      require.resolve(), import.meta.resolve()) exist only in the runtime capture;
//      --bundle=load fails closed on them, and frozen verify flags them as unattested.
//   E. URL-flavored specifiers (?query / #fragment on relative imports): plain node runs
//      them, `stasis run` dies on a State.absolute round-trip assert, and `stasis bundle`
//      fails closed.
//
// Class A is the dangerous one: the only mode that catches it is a real (disk) execution
// under --lock=frozen / --bundle=frozen against the static artifact -- which these tests
// also assert. --bundle=load alone executes the misresolution silently.
//
// These tests pin CURRENT behavior. If you fix scan.js (e.g. per-edge-kind condition
// sets, ESM-semantics validation for module parents), the DIVERGENCE assertions below
// are supposed to fail -- update them to the new, converged expectations.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
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

const exec = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf-8', env: cleanEnv })
const plainNode = (dir, entry) => exec([entry], dir)
const stasisRun = (dir, entry) => exec([cli, 'run', '--lock=add', entry], dir)
const stasisBundle = (dir, entry) =>
  exec([cli, 'bundle', '--lockfile=static.lock.json', '--output=static.code.br', entry], dir)
const bundleLoad = (dir, entry) =>
  exec([cli, 'run', '--lock=none', '--bundle=load', '--bundle-file=static.code.br', entry], dir)
// Real (disk) execution verified against the STATIC artifact's lockfile: the safety net
// that must catch class-A misresolutions and class-D unattested edges.
const frozenRun = (dir, entry) => exec([cli, 'run', '--lock=frozen', entry], dir)

// Flatten a lockfile: edges as "parent :: spec" -> { conditionsKey: target }, plus the
// full attested file set.
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
  // The canonical import/require conditional-exports package.
  w('node_modules/dual/package.json', json({
    name: 'dual', version: '1.0.0',
    exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } },
  }))
  w('node_modules/dual/esm.mjs', 'export const which = "dual:ESM"\n')
  w('node_modules/dual/cjs.cjs', 'exports.which = "dual:CJS"\n')
  // No exports; main points at a directory that has its own package.json main.
  w('node_modules/nested-main/package.json', json({ name: 'nested-main', version: '1.0.0', main: './lib' }))
  w('node_modules/nested-main/lib/package.json', json({ main: './real.js' }))
  w('node_modules/nested-main/lib/real.js', 'exports.which = "nested-main:REAL"\n')
  w('node_modules/nested-main/lib/index.js', 'exports.which = "nested-main:INDEX"\n')
  // No exports; subpath consumed without extension.
  w('node_modules/noexp/package.json', json({ name: 'noexp', version: '1.0.0', main: './lib/main.js' }))
  w('node_modules/noexp/lib/main.js', 'exports.main = "noexp:MAIN"\n')
  w('node_modules/noexp/lib/util.js', 'export const u = "noexp:UTIL"\n')
  // Babelified ESM->CJS package consuming `dual`; `module` field must be ignored by Node.
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
  // Conditional exports + conditional #imports (+ an imports target that is itself a bare
  // specifier with conditional exports).
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
  // App-level helper files.
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

// Three sibling dirs per scenario so artifacts never cross-contaminate: `run` gets
// stasis.lock.json from the capture, `bundle` gets the static artifacts (+ load runs
// there), `frozen` gets a fresh tree with the STATIC lockfile installed as stasis.lock.json.
function scenario(tmp, entry, source) {
  const dirs = { run: join(tmp, 'run'), bundle: join(tmp, 'bundle'), frozen: join(tmp, 'frozen') }
  for (const d of Object.values(dirs)) makeApp(d)(entry, source)
  return dirs
}
const installStaticLock = (dirs) =>
  cpSync(join(dirs.bundle, 'static.lock.json'), join(dirs.frozen, 'stasis.lock.json'))

// --- Class A: silent wrong-file misresolutions ---

test('DIVERGENCE A1: require() via createRequire inside ESM statically resolves to the import branch', withTmp((t, tmp) => {
  // Runtime: the createRequire()d require() resolves `dual` with the REQUIRE condition set
  // (cjs.cjs). Static scan picks ONE condition set per file (parent is ESM -> import
  // conditions), so it records esm.mjs for that edge and never reaches cjs.cjs at all.
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `import { createRequire } from 'node:module'
import { which as viaImport } from 'dual'
const require = createRequire(import.meta.url)
console.log('import', viaImport)
console.log('require', require('dual').which)
`)

  const plain = plainNode(dirs.run, entry)
  t.assert.equal(plain.status, 0)
  t.assert.equal(plain.stdout, 'import dual:ESM\nrequire dual:CJS\n')

  const run = stasisRun(dirs.run, entry)
  t.assert.equal(run.status, 0, run.stderr)
  t.assert.equal(run.stdout, plain.stdout, 'the observing loader must not change behavior')
  const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
  // Runtime records BOTH branches for the same (parent, spec), keyed by conditions.
  t.assert.deepEqual(
    new Set(Object.values(runLock.edges.get('main.mjs :: dual'))),
    new Set(['node_modules/dual/esm.mjs', 'node_modules/dual/cjs.cjs']),
  )

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  // DIVERGENCE: static graph has only the import branch; the file Node actually require()s
  // is absent from the attested artifact.
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: dual'), 'node_modules/dual/esm.mjs')
  t.assert.ok(!staticLock.files.has('node_modules/dual/cjs.cjs'), 'cjs branch missing from static artifact')

  // DIVERGENCE: --bundle=load serves the recorded edge, silently executing the WRONG branch.
  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, 'import dual:ESM\nrequire dual:ESM\n')

  // Safety net: a real execution against the static lockfile fails closed.
  installStaticLock(dirs)
  const frozen = frozenRun(dirs.frozen, entry)
  t.assert.notEqual(frozen.status, 0)
  t.assert.match(frozen.stderr, /not attested|mismatches the lockfile/u)
}))

test('DIVERGENCE A2: literal import() inside CJS statically resolves to the require branch', withTmp((t, tmp) => {
  // The dynamic-import OPERATOR with a static specifier: runtime resolves it with the
  // IMPORT condition set; scan resolves every spec in a commonjs file with require
  // conditions. (Filed under dynamic import, but the specifier itself is static.)
  const entry = 'main.cjs'
  const dirs = scenario(tmp, entry, `const viaRequire = require('dual').which
import('dual').then((m) => {
  console.log('require', viaRequire)
  console.log('import()', m.which)
})
`)

  const plain = plainNode(dirs.run, entry)
  t.assert.equal(plain.status, 0)
  t.assert.equal(plain.stdout, 'require dual:CJS\nimport() dual:ESM\n')

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  // DIVERGENCE: one target for both consumers; the import() branch file is absent.
  t.assert.equal(soleTarget(t, staticLock, 'main.cjs :: dual'), 'node_modules/dual/cjs.cjs')
  t.assert.ok(!staticLock.files.has('node_modules/dual/esm.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  // DIVERGENCE: import() falls back to the '*' edge and executes the require branch.
  t.assert.equal(load.stdout, 'require dual:CJS\nimport() dual:CJS\n')

  installStaticLock(dirs)
  t.assert.notEqual(frozenRun(dirs.frozen, entry).status, 0)
}))

test('DIVERGENCE A3: percent-encoded relative import resolves literally in the static scan, decoded by Node', withTmp((t, tmp) => {
  // ESM specifiers are URLs: './enc/a%20b.mjs' decodes to 'enc/a b.mjs'. The CJS algorithm
  // treats the specifier as a literal path. With BOTH spellings on disk the two resolvers
  // silently pick different files.
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `import { which } from './enc/a%20b.mjs'
console.log(which)
`)

  const plain = plainNode(dirs.run, entry)
  t.assert.equal(plain.status, 0)
  t.assert.equal(plain.stdout, 'enc:DECODED\n')

  const run = stasisRun(dirs.run, entry)
  t.assert.equal(run.status, 0, run.stderr)
  const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
  t.assert.equal(soleTarget(t, runLock, 'main.mjs :: ./enc/a%20b.mjs'), 'enc/a b.mjs')

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  // DIVERGENCE: the literal-spelling file is attested; the file Node loads is not.
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: ./enc/a%20b.mjs'), 'enc/a%20b.mjs')
  t.assert.ok(!staticLock.files.has('enc/a b.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, 'enc:LITERAL\n') // wrong file executes

  installStaticLock(dirs)
  t.assert.notEqual(frozenRun(dirs.frozen, entry).status, 0)

  // Control: from a CJS parent the literal path IS what Node loads -- no divergence.
  const cjs = scenario(join(tmp, 'cjs'), 'main.cjs', `console.log(require('./enc/a%20b.mjs').which)
`)
  t.assert.equal(plainNode(cjs.run, 'main.cjs').stdout, 'enc:LITERAL\n')
  t.assert.equal(stasisBundle(cjs.bundle, 'main.cjs').status, 0)
  t.assert.equal(bundleLoad(cjs.bundle, 'main.cjs').stdout, 'enc:LITERAL\n')
}))

// --- Class B: CJS-only resolution features leak into ESM import edges ---

test('DIVERGENCE B: static bundles build and load graphs plain node refuses (extensionless/dir/subpath imports)', withTmp((t, tmp) => {
  const cases = [
    // [entry, spec, source, plain-node error, target scan invents, output under --bundle=load]
    ['extless.mjs', './helpers/util', `import { u } from './helpers/util'\nconsole.log(u)\n`,
      /ERR_MODULE_NOT_FOUND/u, 'helpers/util.js', 'helpers:UTIL\n'],
    ['dir.mjs', './helpers', `import h from './helpers'\nconsole.log(h.h)\n`,
      /ERR_UNSUPPORTED_DIR_IMPORT/u, 'helpers/index.js', 'helpers:INDEX\n'],
    ['subpath.mjs', 'noexp/lib/util', `import { u } from 'noexp/lib/util'\nconsole.log(u)\n`,
      /ERR_MODULE_NOT_FOUND/u, 'node_modules/noexp/lib/util.js', 'noexp:UTIL\n'],
    // Directory subpath whose nested package.json main redirects: require()-only behavior
    // (LOAD_AS_DIRECTORY) applied to an import edge.
    ['dirsub.mjs', 'nested-main/lib', `import nm from 'nested-main/lib'\nconsole.log(nm.which)\n`,
      /ERR_UNSUPPORTED_DIR_IMPORT/u, 'node_modules/nested-main/lib/real.js', 'nested-main:REAL\n'],
  ]
  for (const [entry, spec, source, plainErr, invented, loadOut] of cases) {
    const dirs = scenario(join(tmp, entry), entry, source)
    const plain = plainNode(dirs.run, entry)
    t.assert.notEqual(plain.status, 0, `${entry}: plain node must refuse`)
    t.assert.match(plain.stderr, plainErr, entry)

    // DIVERGENCE: the static build succeeds and attests an edge Node would never resolve...
    t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0, entry)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    t.assert.equal(soleTarget(t, staticLock, `${entry} :: ${spec}`), invented, entry)

    // ...and --bundle=load executes what plain node refuses to run.
    const load = bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, `${entry}: ${load.stderr}`)
    t.assert.equal(load.stdout, loadOut, entry)

    // The frozen (disk) execution reproduces the plain-node refusal.
    installStaticLock(dirs)
    t.assert.notEqual(frozenRun(dirs.frozen, entry).status, 0, entry)
  }
}))

test('DIVERGENCE B2: JSON import without attribute -- bundle accepts a graph plain node refuses to load', withTmp((t, tmp) => {
  // Resolution itself agrees; the runtime dies at load (ERR_IMPORT_ATTRIBUTE_MISSING),
  // which the static scan cannot see -- and the bundle loader doesn't enforce.
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `import data from './data.json'
console.log(data.k)
`)
  const plain = plainNode(dirs.run, entry)
  t.assert.notEqual(plain.status, 0)
  t.assert.match(plain.stderr, /ERR_IMPORT_ATTRIBUTE_MISSING/u)

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, 'json:VALUE\n')

  // Control: with the attribute everything agrees end to end.
  const ok = scenario(join(tmp, 'ok'), 'main.mjs', `import data from './data.json' with { type: 'json' }
console.log(data.k)
`)
  t.assert.equal(plainNode(ok.run, 'main.mjs').stdout, 'json:VALUE\n')
  t.assert.equal(stasisBundle(ok.bundle, 'main.mjs').status, 0)
  t.assert.equal(bundleLoad(ok.bundle, 'main.mjs').stdout, 'json:VALUE\n')
}))

// --- Class C: spurious static edges ---

test('DIVERGENCE C: a shadowed `require` identifier adds files/edges the runtime never resolves', withTmp((t, tmp) => {
  // scan matches every `require(<literal>)` CallExpression by identifier name, including a
  // shadowed parameter in dead code -- ESM files have no `require` at all. The artifact
  // gains a file (potentially a whole package graph) the app can never load; frozen verify
  // tolerates extra attested edges, so nothing downstream flags it.
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `export function f(require) { if (globalThis.__never) require('./phantom.cjs') }
console.log('ok')
`)
  const run = stasisRun(dirs.run, entry)
  t.assert.equal(run.status, 0, run.stderr)
  const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
  t.assert.ok(!runLock.files.has('phantom.cjs'))
  t.assert.ok(!runLock.edges.has('main.mjs :: ./phantom.cjs'))

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: ./phantom.cjs'), 'phantom.cjs') // DIVERGENCE
  t.assert.ok(staticLock.files.has('phantom.cjs'))

  installStaticLock(dirs)
  t.assert.equal(frozenRun(dirs.frozen, entry).status, 0, 'frozen tolerates over-attestation')
}))

// --- Class D: runtime-only resolution edges ---

test('DIVERGENCE D: aliased require / require.resolve / import.meta.resolve edges exist only in the runtime capture', withTmp((t, tmp) => {
  const cases = [
    // [entry, source, spec, plain stdout]
    ['alias.cjs', `const r = require\nconsole.log(r('./hidden.cjs').h)\n`, './hidden.cjs', 'HIDDEN\n'],
    ['resolveonly.cjs', `console.log(require.resolve('./hidden.cjs').split('/').pop())\n`, './hidden.cjs', 'hidden.cjs\n'],
    ['metaresolve.mjs', `console.log(import.meta.resolve('dual').split('/').pop())\n`, 'dual', 'esm.mjs\n'],
  ]
  for (const [entry, source, spec, out] of cases) {
    const dirs = scenario(join(tmp, entry), entry, source)
    t.assert.equal(plainNode(dirs.run, entry).stdout, out, entry)

    const run = stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, `${entry}: ${run.stderr}`)
    const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
    t.assert.ok(runLock.edges.has(`${entry} :: ${spec}`), `${entry}: runtime capture records the edge`)

    t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0, entry)
    const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
    t.assert.ok(!staticLock.edges.has(`${entry} :: ${spec}`), `${entry}: static scan misses the edge`) // DIVERGENCE

    // --bundle=load fails closed on the unrecorded edge (plain node would run this).
    const load = bundleLoad(dirs.bundle, entry)
    t.assert.notEqual(load.status, 0, entry)
    t.assert.match(load.stderr, /Cannot find module/u, entry)

    // ...and frozen verify flags it as unattested.
    installStaticLock(dirs)
    const frozen = frozenRun(dirs.frozen, entry)
    t.assert.notEqual(frozen.status, 0, entry)
    t.assert.match(frozen.stderr, /not attested/u, entry)
  }
}))

// --- Class E: URL-flavored relative specifiers ---

test('DIVERGENCE E: ?query and #fragment relative imports run under plain node; stasis run asserts, stasis bundle fails closed', withTmp((t, tmp) => {
  const cases = [
    ['query.mjs', `import { q } from './q/mod.mjs?v=1'\nconsole.log(q)\n`, 'query:MOD\n'],
    ['fragment.mjs', `import { q } from './q/mod.mjs#frag'\nconsole.log(q)\n`, 'query:MOD\n'],
  ]
  for (const [entry, source, out] of cases) {
    const dirs = scenario(join(tmp, entry), entry, source)
    t.assert.equal(plainNode(dirs.run, entry).stdout, out, entry)

    // DIVERGENCE (capture-side): the observing loader crashes on the URL round-trip
    // (State.absolute asserts fileURLToPath/pathToFileURL is lossless; ?/# make it lossy).
    const run = stasisRun(dirs.run, entry)
    t.assert.notEqual(run.status, 0, entry)
    t.assert.match(run.stderr, /ERR_ASSERTION/u, entry)

    // Static build fails closed: the resolved-with-suffix path isn't a bundleable file.
    const build = stasisBundle(dirs.bundle, entry)
    t.assert.notEqual(build.status, 0, entry)
    t.assert.match(build.stderr, /JS bundle would be broken at load time/u, entry)
  }
}))

// --- Controls: the per-file condition steering IS correct for whole-file formats ---

test('CONTROL: babelified CJS dep and direct ESM import pick their own branches of a dual package, identically at run and bundle', withTmp((t, tmp) => {
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `import { report } from 'babel-dep'
import { which } from 'dual'
console.log('app', which)
console.log('dep', report())
`)
  const expected = 'app dual:ESM\ndep babel-dep saw dual:CJS\n'
  t.assert.equal(plainNode(dirs.run, entry).stdout, expected)

  const run = stasisRun(dirs.run, entry)
  t.assert.equal(run.status, 0, run.stderr)
  t.assert.equal(run.stdout, expected)

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  // Both branches present, each under its consumer's edge; the bundler-only `module`
  // field (untranspiled ESM source) must NOT be followed.
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: dual'), 'node_modules/dual/esm.mjs')
  t.assert.equal(soleTarget(t, staticLock, 'node_modules/babel-dep/lib/index.js :: dual'), 'node_modules/dual/cjs.cjs')
  t.assert.ok(!staticLock.files.has('node_modules/babel-dep/src/index.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, expected)

  installStaticLock(dirs)
  t.assert.equal(frozenRun(dirs.frozen, entry).status, 0)
}))

test('CONTROL: conditional exports + conditional #imports agree between run and bundle for both parent formats', withTmp((t, tmp) => {
  const cases = [
    ['main.mjs', `import { via } from 'imports-pkg'\nconsole.log(via)\n`, 'esm-entry:impl:ESM:dual:ESM\n'],
    ['main.cjs', `console.log(require('imports-pkg').via)\n`, 'cjs-entry:impl:CJS:dual:CJS\n'],
  ]
  for (const [entry, source, expected] of cases) {
    const dirs = scenario(join(tmp, entry), entry, source)
    t.assert.equal(plainNode(dirs.run, entry).stdout, expected, entry)
    const run = stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, `${entry}: ${run.stderr}`)
    t.assert.equal(run.stdout, expected, entry)
    t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0, entry)
    const load = bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, `${entry}: ${load.stderr}`)
    t.assert.equal(load.stdout, expected, entry)
    installStaticLock(dirs)
    t.assert.equal(frozenRun(dirs.frozen, entry).status, 0, entry)
  }
}))

test('CONTROL: package main chains use LOAD_INDEX, not recursive LOAD_AS_DIRECTORY -- import and require agree', withTmp((t, tmp) => {
  // main "./lib" with lib/package.json { main: "./real.js" } present: BOTH loaders ignore
  // the nested package.json for the package-level lookup and land on lib/index.js. (The
  // nested main only applies to a directory SUBPATH require -- covered as divergence B.)
  for (const [entry, source] of [
    ['main.mjs', `import nm from 'nested-main'\nconsole.log(nm.which)\n`],
    ['main.cjs', `console.log(require('nested-main').which)\n`],
  ]) {
    const dirs = scenario(join(tmp, entry), entry, source)
    t.assert.equal(plainNode(dirs.run, entry).stdout, 'nested-main:INDEX\n', entry)
    t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0, entry)
    const load = bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.stdout, 'nested-main:INDEX\n', entry)
    installStaticLock(dirs)
    t.assert.equal(frozenRun(dirs.frozen, entry).status, 0, entry)
  }
}))
