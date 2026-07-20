// Characterization tests for resolution differences between `stasis run` (Node's real
// resolvers, observed via hooks) and `stasis bundle` (scan.js: import()-context edges by ESM
// rules, require()-context by the CJS algorithm). Identical on Node 24.14/24.18/26.0/26.5.
//
//   A. Silent wrong-file: the static graph once attested a different file than Node loads,
//      and --bundle=load executed it. FIXED: scan resolves per edge kind (A1 createRequire()d
//      require() in ESM, A2 literal import() in CJS -- divergent targets keep their real
//      condition keys) and per ESM URL semantics (A3 percent-decoding, vs CJS literal paths).
//   B. Over-resolution: CJS-only probing (extensionless, directory index, nested dir main,
//      subpaths) once leaked into ESM import edges, so bundles built and --bundle=load ran
//      graphs plain node refuses. FIXED for resolution: an ESM import edge resolves by ESM
//      rules, so these fail closed at build like plain node. B2 (JSON import missing the
//      `type` attribute) is a load-time gate, not a resolution difference, and still diverges.
//   C. Over-inclusion: a shadowed `require` identifier in dead code once attested files/edges
//      the runtime can never resolve. FIXED: a require() call whose `require` is bound by a
//      function/catch parameter is not a real module edge (the value comes from the caller),
//      so the scan skips it; createRequire() variable bindings stay real.
//   D. Under-inclusion: aliased require, require.resolve(), import.meta.resolve() edges exist
//      only in the runtime capture. Not pinned (how --bundle=load reacts varies across the
//      Node floor); see the git history for the removed test.
//   E. ?query/#fragment relative imports: plain node runs them. FIXED: scan resolves them by
//      URL, and State strips the suffix for the file identity (it once crashed the run capture).
//
// DIVERGENCE assertions pin still-open behavior; FIXED/CONTROL pin the converged behavior a
// real run must match. Class A's silent wrong-file was caught only by a frozen disk run.

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

test('FIXED A1: require() via createRequire inside ESM resolves with require conditions', withTmp((t, tmp) => {
  // The require() edge takes the require branch, the import edge of the SAME (parent,
  // specifier) the import branch; divergent targets are keyed by real conditions.
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
  t.assert.deepEqual(
    new Set(Object.values(runLock.edges.get('main.mjs :: dual'))),
    new Set(['node_modules/dual/esm.mjs', 'node_modules/dual/cjs.cjs']),
  )

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  t.assert.deepEqual(staticLock.edges.get('main.mjs :: dual'), {
    [IMPORT_KEY]: 'node_modules/dual/esm.mjs',
    [REQUIRE_KEY]: 'node_modules/dual/cjs.cjs',
  })
  t.assert.ok(staticLock.files.has('node_modules/dual/cjs.cjs'))
  t.assert.ok(staticLock.files.has('node_modules/dual/esm.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, plain.stdout)

  installStaticLock(dirs)
  const frozen = frozenRun(dirs.frozen, entry)
  t.assert.equal(frozen.status, 0, frozen.stderr)
  t.assert.equal(frozen.stdout, plain.stdout)
}))

test('FIXED A2: literal import() inside CJS resolves with import conditions', withTmp((t, tmp) => {
  // The dynamic-import OPERATOR with a static specifier resolves under IMPORT conditions
  // even from a CJS parent; the require edge keeps the require branch.
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
  t.assert.deepEqual(staticLock.edges.get('main.cjs :: dual'), {
    [IMPORT_KEY]: 'node_modules/dual/esm.mjs',
    [REQUIRE_KEY]: 'node_modules/dual/cjs.cjs',
  })
  t.assert.ok(staticLock.files.has('node_modules/dual/esm.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, plain.stdout)

  installStaticLock(dirs)
  const frozen = frozenRun(dirs.frozen, entry)
  t.assert.equal(frozen.status, 0, frozen.stderr)
  t.assert.equal(frozen.stdout, plain.stdout)
}))

test('FIXED A3: percent-encoded relative import resolves by ESM URL semantics, matching Node', withTmp((t, tmp) => {
  // ESM specifiers are URLs ('./enc/a%20b.mjs' loads 'enc/a b.mjs'); the CJS algorithm takes
  // the literal path. With both spellings on disk the scan now resolves the import edge as a
  // URL (fileURLToPath decodes the %20), so it picks the same file Node does.
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
  // The decoded file is attested (matching the run); the literal-spelling file is not reached.
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: ./enc/a%20b.mjs'), 'enc/a b.mjs')
  t.assert.ok(!staticLock.files.has('enc/a%20b.mjs'))

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, 'enc:DECODED\n')

  installStaticLock(dirs)
  const frozen = frozenRun(dirs.frozen, entry)
  t.assert.equal(frozen.status, 0, frozen.stderr)

  // Control: a CJS parent takes the literal path in every mode (require is not URL-flavored).
  const cjs = scenario(join(tmp, 'cjs'), 'main.cjs', `console.log(require('./enc/a%20b.mjs').which)
`)
  t.assert.equal(plainNode(cjs.run, 'main.cjs').stdout, 'enc:LITERAL\n')
  t.assert.equal(stasisBundle(cjs.bundle, 'main.cjs').status, 0)
  t.assert.equal(bundleLoad(cjs.bundle, 'main.cjs').stdout, 'enc:LITERAL\n')
}))

// --- Class B: CJS-only resolution features must not leak into ESM import edges ---

test('FIXED B: ESM import edges resolve by ESM rules, so the static build fails closed like plain node (extensionless/dir/subpath)', withTmp((t, tmp) => {
  const cases = [
    // [entry, source, plain-node error] -- ESM refuses each; the static build must too.
    ['extless.mjs', `import { u } from './helpers/util'\nconsole.log(u)\n`, /ERR_MODULE_NOT_FOUND/u],
    ['dir.mjs', `import h from './helpers'\nconsole.log(h.h)\n`, /ERR_UNSUPPORTED_DIR_IMPORT/u],
    ['subpath.mjs', `import { u } from 'noexp/lib/util'\nconsole.log(u)\n`, /ERR_MODULE_NOT_FOUND/u],
    // dir subpath honoring nested package.json main -- require()-only (LOAD_AS_DIRECTORY) behavior
    ['dirsub.mjs', `import nm from 'nested-main/lib'\nconsole.log(nm.which)\n`, /ERR_UNSUPPORTED_DIR_IMPORT/u],
  ]
  for (const [entry, source, plainErr] of cases) {
    const dirs = scenario(join(tmp, entry), entry, source)
    const plain = plainNode(dirs.run, entry)
    t.assert.notEqual(plain.status, 0, `${entry}: plain node must refuse`)
    t.assert.match(plain.stderr, plainErr, entry)

    // The static build fails closed (the unresolved static import is broken at load), rather
    // than inventing a CJS-probed target and letting --bundle=load run what plain node won't.
    const build = stasisBundle(dirs.bundle, entry)
    t.assert.notEqual(build.status, 0, entry)
    t.assert.match(build.stderr, /JS bundle would be broken at load time/u, entry)
  }

  // Control: with the exact extension, the same imports resolve and agree everywhere.
  const ok = scenario(join(tmp, 'ok'), 'ok.mjs', `import { u } from './helpers/util.js'\nconsole.log(u)\n`)
  t.assert.equal(plainNode(ok.run, 'ok.mjs').stdout, 'helpers:UTIL\n')
  t.assert.equal(stasisBundle(ok.bundle, 'ok.mjs').status, 0)
  t.assert.equal(bundleLoad(ok.bundle, 'ok.mjs').stdout, 'helpers:UTIL\n')
}))

test('DIVERGENCE B2: JSON import without attribute -- bundle accepts a graph plain node refuses to load', withTmp((t, tmp) => {
  // Still open, and distinct from B: resolution AGREES (data.json is found); the runtime dies
  // at load on the missing `type: 'json'` attribute (ERR_IMPORT_ATTRIBUTE_MISSING) -- a load
  // gate, not a resolution difference. The scan doesn't see it and the bundle loader doesn't
  // enforce it, so --bundle=load runs what plain node refuses. Fixing it means threading import
  // attributes through scan + loader, not the resolution mechanism A3/B/E share.
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

test('FIXED C: a `require` bound by a parameter is not recorded as an edge; createRequire bindings still are', withTmp((t, tmp) => {
  // A `require(<literal>)` whose `require` is a function parameter (here, dead shadowed code)
  // is not the CommonJS require -- the scan skips it, matching the run (which records nothing).
  // A createRequire() binding inside the same file must still resolve.
  const entry = 'main.mjs'
  const dirs = scenario(tmp, entry, `import { createRequire } from 'node:module'
export function shadow(require) { if (globalThis.__never) require('./phantom.cjs') }
function load() { const require = createRequire(import.meta.url); return require('dual').which }
console.log(load())
`)
  const run = stasisRun(dirs.run, entry)
  t.assert.equal(run.status, 0, run.stderr)
  t.assert.equal(run.stdout, 'dual:CJS\n')
  const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
  t.assert.ok(!runLock.files.has('phantom.cjs'))
  t.assert.ok(!runLock.edges.has('main.mjs :: ./phantom.cjs'))

  t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0)
  const staticLock = flattenLock(join(dirs.bundle, 'static.lock.json'))
  // The parameter-shadowed require is gone (matching the run); the createRequire edge remains.
  t.assert.ok(!staticLock.edges.has('main.mjs :: ./phantom.cjs'), 'shadowed-param require must not be recorded')
  t.assert.ok(!staticLock.files.has('phantom.cjs'))
  t.assert.equal(soleTarget(t, staticLock, 'main.mjs :: dual'), 'node_modules/dual/cjs.cjs')

  const load = bundleLoad(dirs.bundle, entry)
  t.assert.equal(load.status, 0, load.stderr)
  t.assert.equal(load.stdout, 'dual:CJS\n')

  installStaticLock(dirs)
  t.assert.equal(frozenRun(dirs.frozen, entry).status, 0, frozenRun(dirs.frozen, entry).stderr)
}))

// --- Class E: URL-flavored relative specifiers ---

test('FIXED E: ?query and #fragment relative imports agree across plain node, run, bundle, and load', withTmp((t, tmp) => {
  // ESM specifiers are URLs: './q/mod.mjs?v=1' loads q/mod.mjs (the ?query/#fragment key the
  // module, not the file). The scan resolves them by URL, and State strips the suffix for the
  // file identity -- which previously crashed the run capture on a lossless round-trip assert.
  for (const [entry, source] of [
    ['query.mjs', `import { q } from './q/mod.mjs?v=1'\nconsole.log(q)\n`],
    ['fragment.mjs', `import { q } from './q/mod.mjs#frag'\nconsole.log(q)\n`],
  ]) {
    const dirs = scenario(join(tmp, entry), entry, source)
    t.assert.equal(plainNode(dirs.run, entry).stdout, 'query:MOD\n', entry)

    const run = stasisRun(dirs.run, entry)
    t.assert.equal(run.status, 0, `${entry}: ${run.stderr}`)
    t.assert.equal(run.stdout, 'query:MOD\n', entry)
    // The edge keeps the raw suffixed specifier; the file identity drops the suffix.
    const runLock = flattenLock(join(dirs.run, 'stasis.lock.json'))
    t.assert.equal(soleTarget(t, runLock, `${entry} :: ${source.match(/'([^']+)'/u)[1]}`), 'q/mod.mjs', entry)

    t.assert.equal(stasisBundle(dirs.bundle, entry).status, 0, entry)
    const load = bundleLoad(dirs.bundle, entry)
    t.assert.equal(load.status, 0, `${entry}: ${load.stderr}`)
    t.assert.equal(load.stdout, 'query:MOD\n', entry)

    installStaticLock(dirs)
    t.assert.equal(frozenRun(dirs.frozen, entry).status, 0, entry)
  }
}))

// --- Controls: per-file condition steering IS correct for whole-file formats ---

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
  // Both branches, each under its consumer's edge; the bundler-only `module` field is not followed.
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
  // main "./lib" with lib/package.json { main: "./real.js" }: both loaders skip the nested
  // package.json at package level and land on lib/index.js (subpath require = divergence B).
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
