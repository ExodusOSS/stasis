import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Scan, scan } from '../stasis/src/scan.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const cjsFixture = join(here, 'fixtures', 'cli-run-cjs')
const tsFixture = join(here, 'fixtures', 'cli-run-ts')
const nmCjsFixture = join(here, 'fixtures', 'cli-run-nm-cjs')
const esmConditionsFixture = join(here, 'fixtures', 'scan-esm-conditions')
const moduleSyncFixture = join(here, 'fixtures', 'scan-module-sync')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const runCli = (args, opts = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-scan-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Collapse imports across condition keys into a flat parent->spec->file table. The runtime
// loader records whatever condition set Node reports for each edge (which can differ between
// CJS and ESM resolutions in the same run), while the static scan records the single
// condition set it was invoked with -- so we compare edges, not condition keys.
function flattenImports(imports) {
  const flat = new Map()
  const each = imports instanceof Map ? imports.values() : Object.values(imports)
  for (const byParent of each) {
    const entries = byParent instanceof Map ? byParent : Object.entries(byParent)
    for (const [parent, specs] of entries) {
      if (!flat.has(parent)) flat.set(parent, new Map())
      const dest = flat.get(parent)
      const specEntries = specs instanceof Map ? specs : Object.entries(specs)
      for (const [spec, file] of specEntries) dest.set(spec, file)
    }
  }
  return flat
}

function captureRuntimeBundle(fixture, entry, tmp, { full = false } = {}) {
  const bundlePath = join(tmp, 'snapshot.br')
  const args = ['run', '--lock=add', '--bundle=add', `--bundle-file=${bundlePath}`]
  // ed41d6f flipped `stasis run`'s default to scope=full; --dependencies is the
  // node_modules-only opt-in. The two fixtures have explicit scope in their
  // stasis.config.json (cli-run-cjs: full, cli-run-nm-cjs: node_modules), so
  // pass --dependencies for the nm-scoped one to avoid env-vs-file conflict.
  if (!full) args.push('--dependencies')
  args.push(entry)
  const r = runCli(args, { cwd: fixture })
  if (r.status !== 0) throw new Error(`stasis run failed: ${r.stderr}`)
  return JSON.parse(brotliDecompressSync(readFileSync(bundlePath)).toString('utf-8'))
}

test('scan walks a relative CJS require chain without executing it', (t) => {
  const result = scan([join(cjsFixture, 'src/entry.cjs')]).toRelative(cjsFixture)
  t.assert.deepEqual([...result.entries], ['src/entry.cjs'])
  t.assert.deepEqual([...result.files.keys()].toSorted(), ['src/entry.cjs', 'src/hello.cjs'])
  t.assert.equal(result.files.get('src/entry.cjs').format, 'commonjs')
  t.assert.equal(result.files.get('src/hello.cjs').format, 'commonjs')
  t.assert.deepEqual(result.unresolved, [])

  const edges = result.files.get('src/entry.cjs').edges
  t.assert.equal(edges.length, 1)
  t.assert.deepEqual(edges[0], { kind: 'require', spec: './hello.cjs', child: 'src/hello.cjs' })
})

test('scan resolves bare specifiers through node_modules without executing them', (t) => {
  const result = scan([join(nmCjsFixture, 'src/entry.js')]).toRelative(nmCjsFixture)
  t.assert.deepEqual([...result.files.keys()].toSorted(), [
    'node_modules/fake-cjs-nm/index.js',
    'src/entry.js',
  ])
  const entry = result.files.get('src/entry.js')
  t.assert.equal(entry.format, 'module')
  t.assert.equal(entry.edges.length, 1)
  t.assert.deepEqual(entry.edges[0], {
    kind: 'import',
    spec: 'fake-cjs-nm',
    child: 'node_modules/fake-cjs-nm/index.js',
  })
})

test('scan does not load the target file (top-level side effects never fire)', (t) => {
  // entry.cjs prints "hello, world\n" if executed; scan should not produce any output.
  // Run in a child process so the assertion is bulletproof against in-process buffering.
  const probe = `const { scan } = await import(process.argv[1]); scan([process.argv[2]])`
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probe, join(here, '..', 'stasis', 'src/scan.js'), join(cjsFixture, 'src/entry.cjs')],
    { encoding: 'utf-8' }
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.equal(r.stdout, '', 'scan must not emit anything entry.cjs would log')
  t.assert.equal(r.stderr, '')
})

test('scan records module files that fail to parse in parseErrors with no edges', withTmp((t, tmp) => {
  // oxc-parser recovers from syntax errors instead of throwing, so scan must
  // read parsed.errors itself -- otherwise a broken file silently scans as a
  // leaf and any imports inside it vanish from the graph. For module files the
  // partial records are discarded: a missed static edge is an invisible hole.
  const entry = join(tmp, 'entry.mjs')
  const broken = join(tmp, 'broken.mjs')
  writeFileSync(entry, "import './broken.mjs'\n")
  writeFileSync(broken, 'export const x = {\nimport "./hidden.mjs"\n')
  const result = scan([entry])
  t.assert.equal(result.parseErrors.length, 1)
  t.assert.ok(result.parseErrors[0].url.endsWith('/broken.mjs'))
  t.assert.ok(result.parseErrors[0].message.length > 0)
  t.assert.equal(result.parseErrors[0].format, 'module')
  t.assert.equal(result.parseErrors[0].recovered, true)
  const info = [...result.files].find(([url]) => url.endsWith('/broken.mjs'))[1]
  t.assert.ok(info.parseError, 'files entry must carry the parseError flag')
  t.assert.deepEqual(info.edges, [], 'a module file we could not parse must not contribute edges')

  // toRelative carries parseErrors through, root-relative.
  const rel = scan([entry]).toRelative(tmp)
  t.assert.equal(rel.parseErrors.length, 1)
  t.assert.equal(rel.parseErrors[0].file, 'broken.mjs')
}))

test('scan salvages edges from a script (CJS) file with a parse error (top-level return)', withTmp((t, tmp) => {
  // Node's CJS module wrapper accepts a top-level `return`; oxc reports it as
  // an error but error-recovers a complete AST. The require() edge must
  // survive, with the parse error recorded alongside it.
  const entry = join(tmp, 'entry.cjs')
  writeFileSync(entry, "require('./guard.cjs')\n")
  writeFileSync(join(tmp, 'guard.cjs'), "if (!process.env.NEVER) return\nmodule.exports = require('./extra.cjs')\n")
  writeFileSync(join(tmp, 'extra.cjs'), 'module.exports = 1\n')
  const result = scan([entry])
  t.assert.equal(result.parseErrors.length, 1)
  t.assert.ok(result.parseErrors[0].url.endsWith('/guard.cjs'))
  t.assert.equal(result.parseErrors[0].format, 'commonjs')
  t.assert.equal(result.parseErrors[0].recovered, true)
  const info = [...result.files].find(([url]) => url.endsWith('/guard.cjs'))[1]
  t.assert.ok(info.parseError, 'files entry must carry the parseError flag')
  t.assert.equal(info.edges.length, 1, 'the require edge must be salvaged from the recovered AST')
  t.assert.ok([...result.files.keys()].some((u) => u.endsWith('/extra.cjs')), 'salvaged edges must be walked')
}))

test('scan applies Node module-syntax detection to ambiguous .js (no "type" in scope)', withTmp((t, tmp) => {
  // package.json without "type": plain node runs ESM-syntax .js as ESM
  // (detect-module). scan must record format=module and resolve the file's
  // own edges under import conditions, or the bundle silently records the
  // wrong format and dies at load while plain node runs fine.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'detect', version: '0.0.0' }))
  const dep = join(tmp, 'dep.js')
  writeFileSync(dep, "export { y } from './leaf.js'\n")
  writeFileSync(join(tmp, 'leaf.js'), 'export const y = 1\n')
  const result = scan([dep])
  const depInfo = [...result.files].find(([url]) => url.endsWith('/dep.js'))[1]
  t.assert.equal(depInfo.format, 'module')
  t.assert.equal(depInfo.edges.length, 1)
  t.assert.deepEqual(result.unresolved, [])
  // dynamic import() alone must NOT flip a CJS file to module (matches Node).
  const plain = join(tmp, 'plain.js')
  writeFileSync(plain, "import('./leaf.js').catch(() => {})\nmodule.exports = 1\n")
  const r2 = scan([plain])
  t.assert.equal([...r2.files].find(([url]) => url.endsWith('/plain.js'))[1].format, 'commonjs')
  // Top-level await alone MUST flip (Node counts TLA as module syntax, oxc's
  // hasModuleSyntax does not -- scan retries the failed script parse as a
  // module and adopts it when clean). Not a parse error.
  const tla = join(tmp, 'tla.js')
  writeFileSync(tla, 'const one = await Promise.resolve(1)\n')
  const r3 = scan([tla])
  t.assert.equal([...r3.files].find(([url]) => url.endsWith('/tla.js'))[1].format, 'module')
  t.assert.deepEqual(r3.parseErrors, [])
}))

test('scan records a parse error for JSX in a .js file, and js:true parses past it', withTmp((t, tmp) => {
  // oxc (like tsc) only auto-enables JSX for .jsx/.tsx by extension, so JSX in a .js file is an
  // "Unexpected token" parse error by default. `jsx: true` opts the .js family into JSX parsing.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'jsx', version: '0.0.0', type: 'module' }))
  const entry = join(tmp, 'App.js')
  writeFileSync(entry, "import { greet } from './greet.js'\nexport const App = () => <Text>{greet}</Text>\n")
  writeFileSync(join(tmp, 'greet.js'), "export const greet = 'hi'\n")

  const def = scan([entry])
  t.assert.equal(def.parseErrors.length, 1, 'JSX in .js is a parse error by default')
  t.assert.ok(def.parseErrors[0].url.endsWith('/App.js'))
  // The parse failed, so the module edge to greet.js was never enumerated.
  t.assert.ok(![...def.files].some(([url]) => url.endsWith('/greet.js')), 'edge behind the JSX is unreachable by default')

  const withJsx = scan([entry], { jsx: true })
  t.assert.deepEqual(withJsx.parseErrors, [], 'jsx:true parses the JSX cleanly')
  t.assert.ok([...withJsx.files].some(([url]) => url.endsWith('/greet.js')), 'the import past the JSX is now walked')
}))

test('scan jsx:true parses JSX in a typeless package and still detects module vs commonjs (RN convention)', withTmp((t, tmp) => {
  // React Native's package.json usually has no "type", so .js files hit oxc's `unambiguous`
  // sourceType (declared === null) -- the primary jsx path. JSX must parse AND syntax detection
  // must still pick the right format: ESM syntax -> module, require/module.exports -> commonjs.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'rn-typeless', version: '0.0.0' })) // no "type"

  const esm = join(tmp, 'esm.js')
  writeFileSync(esm, "import { greet } from './greet.js'\nexport const App = () => <Text>{greet}</Text>\n")
  writeFileSync(join(tmp, 'greet.js'), "export const greet = 'hi'\n")
  const esmScan = scan([esm], { jsx: true })
  t.assert.deepEqual(esmScan.parseErrors, [], 'JSX in a typeless .js must parse under jsx:true')
  t.assert.equal([...esmScan.files].find(([url]) => url.endsWith('/esm.js'))[1].format, 'module',
    'import/export syntax must still be detected as module even with JSX enabled')
  t.assert.ok([...esmScan.files].some(([url]) => url.endsWith('/greet.js')), 'the edge behind the JSX is walked')

  const cjs = join(tmp, 'cjs.js')
  writeFileSync(cjs, "const { Row } = require('./greet.js')\nmodule.exports = () => <Row/>\n")
  const cjsScan = scan([cjs], { jsx: true })
  t.assert.deepEqual(cjsScan.parseErrors, [], 'JSX in a typeless CJS .js must parse under jsx:true')
  t.assert.equal([...cjsScan.files].find(([url]) => url.endsWith('/cjs.js'))[1].format, 'commonjs',
    'require/module.exports must still be detected as commonjs even with JSX enabled')
}))

test('scan jsx:true does not enable JSX for the .ts family (its <T> generics collide with JSX)', withTmp((t, tmp) => {
  // TypeScript reserves JSX for .tsx; a .ts file uses `<T>` for generics. jsx:true leaves .ts
  // JSX-free: a generic .ts still parses, and JSX in a .ts is still a parse error.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'jsxts', version: '0.0.0', type: 'module' }))
  const generic = join(tmp, 'ok.ts')
  writeFileSync(generic, 'export function id<T>(x: T): T {\n  return x\n}\n')
  t.assert.deepEqual(scan([generic], { jsx: true }).parseErrors, [], 'a generic .ts still parses under jsx:true')

  const jsxTs = join(tmp, 'bad.ts')
  writeFileSync(jsxTs, 'export const App = () => <Text>hi</Text>\n')
  t.assert.equal(scan([jsxTs], { jsx: true }).parseErrors.length, 1, 'JSX in a .ts stays a parse error even with jsx:true')
}))

test('scan reports dynamic require() as unresolved', withTmp((t, tmp) => {
  const file = join(tmp, 'dyn.cjs')
  writeFileSync(file, `const name = process.env.MOD\nmodule.exports = require(name)\n`)
  const result = scan([file])
  t.assert.equal(result.unresolved.length, 1)
  t.assert.equal(result.unresolved[0].kind, 'require')
  t.assert.equal(result.unresolved[0].reason, 'dynamic')
  t.assert.ok(result.unresolved[0].parentURL.endsWith('/dyn.cjs'))
}))

// Set of `parent -> child` file edges. We compare on edges rather than full triples
// because Node's CJS->ESM bridge rewrites a `require('./hello.cjs')` specifier into a
// `file:` URL before our resolve hook sees it, while the static scan keeps the source
// spec -- so the runtime and static specifiers disagree on those edges by construction.
// Specifier preservation is verified directly against `Scan` output in scan-only tests.
function edgeSet(flat) {
  const edges = new Set()
  for (const [parent, specs] of flat) for (const child of specs.values()) edges.add(`${parent} -> ${child}`)
  return edges
}

// Two-directional: every runtime edge must appear in the static graph (no missing
// edges) AND every static edge must appear in the runtime graph (no spurious edges).
// The reverse direction is what catches false positives like shadowed-`require`
// resolutions, dual-package wrong-branch picks, etc.
function assertGraphAgrees(t, runtime, staticGraph) {
  const staticEdges = edgeSet(flattenImports(staticGraph.imports))
  const runtimeEdges = edgeSet(flattenImports(runtime.imports))
  for (const e of runtimeEdges) t.assert.ok(staticEdges.has(e), `static graph missing edge: ${e}`)
  for (const e of staticEdges) t.assert.ok(runtimeEdges.has(e), `static graph has spurious edge: ${e}`)
}

// Copy the fixture into tmp before invoking the runtime CLI, since --lock=add writes
// stasis.lock.json next to package.json and we don't want to mutate the source tree.
test('static scan agrees with runtime loader on the CJS fixture', withTmp((t, tmp) => {
  cpSync(cjsFixture, tmp, { recursive: true })
  const runtime = captureRuntimeBundle(tmp, 'src/entry.cjs', tmp, { full: true })
  const staticGraph = scan([join(tmp, 'src/entry.cjs')]).toRelative(tmp)

  t.assert.deepEqual([...staticGraph.entries], runtime.entries)

  const runtimeFiles = new Set(Object.keys(runtime.sources['.'].files))
  const staticFiles = new Set(staticGraph.files.keys())
  for (const f of runtimeFiles) t.assert.ok(staticFiles.has(f), `static graph missing ${f}`)

  assertGraphAgrees(t, runtime, staticGraph)
}))

test('static scan agrees with runtime loader on the node_modules CJS fixture', withTmp((t, tmp) => {
  cpSync(nmCjsFixture, tmp, { recursive: true })
  const runtime = captureRuntimeBundle(tmp, 'src/entry.js', tmp)
  const staticGraph = scan([join(tmp, 'src/entry.js')]).toRelative(tmp)
  assertGraphAgrees(t, runtime, staticGraph)
}))

// --- TypeScript: .ts/.cts/.mts behave like their JS counterparts. ---

test('scan walks a TS import chain and records Node\'s type-stripping formats', (t) => {
  const result = scan([join(tsFixture, 'src/entry.ts')]).toRelative(tsFixture)
  t.assert.deepEqual([...result.entries], ['src/entry.ts'])
  t.assert.deepEqual([...result.files.keys()].toSorted(), ['src/entry.ts', 'src/hello.ts'])
  // type: module package → .ts files are module-typescript, mirroring .js → module
  t.assert.equal(result.files.get('src/entry.ts').format, 'module-typescript')
  t.assert.equal(result.files.get('src/hello.ts').format, 'module-typescript')
  t.assert.deepEqual(result.unresolved, [])

  const edges = result.files.get('src/entry.ts').edges
  t.assert.deepEqual(edges, [{ kind: 'import', spec: './hello.ts', child: 'src/hello.ts' }])
})

test('scan derives commonjs-typescript for .ts in a CJS package and per-extension for .cts/.mts', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-formats', version: '0.0.0' }))
  writeFileSync(join(tmp, 'entry.ts'), 'require("./a.cts")\n')
  writeFileSync(join(tmp, 'a.cts'), 'exports.x = 1 as number\n')
  writeFileSync(join(tmp, 'b.mts'), 'export const y: number = 2\n')
  const result = scan([join(tmp, 'entry.ts'), join(tmp, 'b.mts')]).toRelative(tmp)
  t.assert.equal(result.files.get('entry.ts').format, 'commonjs-typescript')
  t.assert.equal(result.files.get('a.cts').format, 'commonjs-typescript')
  t.assert.equal(result.files.get('b.mts').format, 'module-typescript')
}))

test('scan matches Node\'s module-syntax detection for typeless packages', withTmp((t, tmp) => {
  // No `type` in package.json: Node detects the module system from syntax.
  // Deriving commonjs(-typescript) here would record a format the CJS
  // translator can't execute under --bundle=load.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'detect', version: '0.0.0' }))
  writeFileSync(join(tmp, 'esm.ts'), 'export const x: number = 1\n')
  writeFileSync(join(tmp, 'cjs.ts'), 'exports.x = 1 as number\n')
  writeFileSync(join(tmp, 'esm.js'), 'export const y = 2\n')
  writeFileSync(join(tmp, 'cjs.js'), 'exports.y = 2\n')
  const result = scan([join(tmp, 'esm.ts'), join(tmp, 'cjs.ts'), join(tmp, 'esm.js'), join(tmp, 'cjs.js')]).toRelative(tmp)
  t.assert.equal(result.files.get('esm.ts').format, 'module-typescript')
  t.assert.equal(result.files.get('cjs.ts').format, 'commonjs-typescript')
  t.assert.equal(result.files.get('esm.js').format, 'module')
  t.assert.equal(result.files.get('cjs.js').format, 'commonjs')
}))

test('scan records `import x = require(...)` edges (TS-only CJS import form)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-import-eq', version: '0.0.0' }))
  writeFileSync(join(tmp, 'entry.cts'), 'import lib = require("./dep.cts")\nlib.x()\n')
  writeFileSync(join(tmp, 'dep.cts'), 'exports.x = (): void => {}\n')
  const result = scan([join(tmp, 'entry.cts')]).toRelative(tmp)
  t.assert.ok(result.files.has('dep.cts'), 'import = require() target must be walked into the bundle')
  t.assert.deepEqual(result.files.get('entry.cts').edges, [
    { kind: 'require', spec: './dep.cts', child: 'dep.cts' },
  ])
  t.assert.deepEqual(result.unresolved, [])
}))

test('scan skips type-only imports/re-exports (erased before runtime, never loaded by Node)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-type-only', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.ts'),
    'import type { A } from "./types-only.ts"\n' +
    'export type { B } from "./types-only.ts"\n' +
    'import { type C, real } from "./mixed.ts"\n' +
    'export const a: A | null = null\nreal()\n')
  writeFileSync(join(tmp, 'types-only.ts'), 'export interface A {}\nexport interface B {}\n')
  writeFileSync(join(tmp, 'mixed.ts'), 'export interface C {}\nexport const real = (): void => {}\n')
  const result = scan([join(tmp, 'entry.ts')]).toRelative(tmp)
  t.assert.ok(!result.files.has('types-only.ts'), 'type-only target must not be bundled')
  t.assert.ok(result.files.has('mixed.ts'), 'mixed type+value import still loads at runtime')
  t.assert.deepEqual(result.unresolved, [])
}))

test('scan files TS ESM-parent edges under the full ESM condition key Node uses', (t) => {
  // module-typescript parents must resolve with the `import` condition set,
  // exactly like module parents -- not the `require` fallback.
  const result = scan([join(tsFixture, 'src/entry.ts')]).toRelative(tsFixture)
  t.assert.deepEqual([...result.imports.keys()], ['node, import, module-sync, node-addons'])
})

test('scan without --flow cannot parse a Flow-typed file (edges vanish, parse error recorded)', withTmp((t, tmp) => {
  // oxc parses JS/TS, not Flow: a Flow-annotated module fails to parse, and (being an
  // eagerly-linked module file) its partial records are discarded, so its import edges vanish.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'flow', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.js'),
    '// @flow\nimport { dep } from "./dep.js"\nfunction f(x: number): string { return String(x) }\nexport const v: string = f(1)\n')
  writeFileSync(join(tmp, 'dep.js'), 'export const dep = 1\n')
  const result = scan([join(tmp, 'entry.js')]).toRelative(tmp)
  t.assert.equal(result.parseErrors.length, 1)
  t.assert.equal(result.parseErrors[0].file, 'entry.js')
  t.assert.deepEqual(result.files.get('entry.js').edges, [], 'a Flow file oxc cannot parse contributes no edges')
  t.assert.ok(!result.files.has('dep.js'), 'the unparsed edge means dep.js is never walked')
}))

test('scan --flow still surfaces a genuine (non-Flow) parse error instead of masking it', withTmp((t, tmp) => {
  // The Flow strip is a fallback that only fires when oxc fails; on a broken-but-not-Flow file the
  // re-parse also fails, so oxc's original parse error must still be recorded (not swallowed).
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.mjs'), 'export const x = {\nimport "./hidden.mjs"\n')
  const result = scan([join(tmp, 'entry.mjs')], { flow: true }).toRelative(tmp)
  t.assert.equal(result.parseErrors.length, 1)
  t.assert.equal(result.parseErrors[0].file, 'entry.mjs')
}))

test('scan --flow strips Flow type syntax before oxc so the real import graph resolves', withTmp((t, tmp) => {
  // flow-remove-types blanks the annotations to whitespace; oxc then parses clean JS and the
  // value import survives, while the type-only import is erased (never loaded at runtime).
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'flow', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.js'),
    '// @flow\n' +
    'import type { T } from "./types.js"\n' +
    'import { dep } from "./dep.js"\n' +
    'type Local = { a: number }\n' +
    'function f(x: number): string { return String(x) }\n' +
    'export const v: Local = { a: f(dep).length }\n')
  writeFileSync(join(tmp, 'dep.js'), 'export const dep = 1\n')
  writeFileSync(join(tmp, 'types.js'), 'export const T = 1\n')
  const result = scan([join(tmp, 'entry.js')], { flow: true }).toRelative(tmp)
  t.assert.deepEqual(result.parseErrors, [])
  t.assert.deepEqual(result.unresolved, [])
  const edges = result.files.get('entry.js').edges
  t.assert.deepEqual(edges, [{ kind: 'import', spec: './dep.js', child: 'dep.js' }])
  t.assert.ok(result.files.has('dep.js'), 'the value import is walked')
  t.assert.ok(!result.files.has('types.js'), 'the Flow type-only import is erased, so types.js is never walked')
}))

test('scan --flow works on Flow files with no @flow pragma (all:true ignores the pragma)', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'flow', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.js'), 'import { dep } from "./dep.js"\nexport const v: number = dep\n')
  writeFileSync(join(tmp, 'dep.js'), 'export const dep = 1\n')
  const result = scan([join(tmp, 'entry.js')], { flow: true }).toRelative(tmp)
  t.assert.deepEqual(result.parseErrors, [])
  t.assert.ok(result.files.has('dep.js'))
}))

test('scan --flow leaves .ts sources to oxc (does not run flow-remove-types on TS constructs)', withTmp((t, tmp) => {
  // TS-only syntax (enum) must still bundle under --flow: .ts is excluded from Flow stripping
  // and handed straight to oxc's TS parser.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts', version: '0.0.0', type: 'module' }))
  writeFileSync(join(tmp, 'entry.ts'),
    'import { dep } from "./dep.ts"\nexport enum E { A, B }\nexport const v: E = dep\n')
  writeFileSync(join(tmp, 'dep.ts'), 'export const dep = 0\n')
  const result = scan([join(tmp, 'entry.ts')], { flow: true }).toRelative(tmp)
  t.assert.deepEqual(result.parseErrors, [])
  t.assert.equal(result.files.get('entry.ts').format, 'module-typescript')
  t.assert.ok(result.files.has('dep.ts'), 'the TS import graph is unaffected by --flow')
}))

test('scan instance is reusable via the Scan class', (t) => {
  const s = new Scan().walk([join(cjsFixture, 'src/entry.cjs')])
  t.assert.ok(s.files.size > 0)
  t.assert.ok(s.entries.size > 0)
})

// --- Conditions-aware resolution (the dual-package and ESM-only cases). ---
//
// Before passing { conditions: Set } to createRequire().resolve(), scan picked the CJS
// branch of dual-package exports regardless of the parent's format (wrong file for ESM
// parents) and rejected ESM-only packages with ERR_PACKAGE_PATH_NOT_EXPORTED. Both
// modes are now exercised by tests/fixtures/scan-esm-conditions.

test('scan picks the import branch of dual-package exports for ESM parents', (t) => {
  const result = scan([join(esmConditionsFixture, 'src/entry.js')]).toRelative(esmConditionsFixture)
  const edges = result.files.get('src/entry.js').edges
  const dual = edges.find((e) => e.spec === 'dualpkg')
  t.assert.equal(dual.child, 'node_modules/dualpkg/esm.mjs', 'ESM parent must resolve to the import target')
  t.assert.ok(result.files.has('node_modules/dualpkg/esm.mjs'))
  // The CJS sibling must NOT appear -- the import resolver never visits it.
  t.assert.ok(!result.files.has('node_modules/dualpkg/cjs.cjs'), 'CJS branch must not be reached from an ESM parent')
})

test('scan resolves ESM-only packages (the previous ERR_PACKAGE_PATH_NOT_EXPORTED case)', (t) => {
  const result = scan([join(esmConditionsFixture, 'src/entry.js')]).toRelative(esmConditionsFixture)
  const edges = result.files.get('src/entry.js').edges
  const esmOnly = edges.find((e) => e.spec === 'esmonly')
  t.assert.equal(esmOnly.child, 'node_modules/esmonly/idx.js')
  t.assert.equal(result.unresolved.length, 0, 'no specifier should be unresolved')
})

test('scan files ESM-parent edges under the full ESM condition key Node uses', (t) => {
  const result = scan([join(esmConditionsFixture, 'src/entry.js')]).toRelative(esmConditionsFixture)
  // The condition key must match what Node's resolve hook passes at runtime
  // (`node, import, module-sync, node-addons` on Node 22); a shorter key meant
  // packages whose `exports` map gated on `module-sync` resolved to a
  // different file under static scan than under plain Node.
  const ESM_KEY = 'node, import, module-sync, node-addons'
  t.assert.deepEqual([...result.imports.keys()], [ESM_KEY])
  const specs = result.imports.get(ESM_KEY).get('src/entry.js')
  t.assert.deepEqual(Object.fromEntries(specs), {
    dualpkg: 'node_modules/dualpkg/esm.mjs',
    esmonly: 'node_modules/esmonly/idx.js',
  })
})

test('static scan agrees with runtime loader on the ESM-conditions fixture (two-directional)', withTmp(async (t, tmp) => {
  cpSync(esmConditionsFixture, tmp, { recursive: true })
  const runtime = captureRuntimeBundle(tmp, 'src/entry.js', tmp, { full: true })
  const staticGraph = scan([join(tmp, 'src/entry.js')]).toRelative(tmp)
  assertGraphAgrees(t, runtime, staticGraph)
}))

// Regression: Node 22.10+ passes `module-sync` and `node-addons` in its
// resolve hook's condition set. If scan omits them, a package whose `exports`
// map gates on `module-sync` -- e.g. `{ "module-sync": "./sync.js", "import":
// "./async.js" }` -- resolves to async.js under static scan but to sync.js
// under plain Node. The bundle then silently runs different code than the
// same entry would when launched directly. Verified before the fix:
//   plain node:   prints "MODULE-SYNC"
//   static bundle: printed "IMPORT" -- silent wrong-file execution.
test('scan picks the same file as plain Node when exports gate on module-sync', (t) => {
  const result = scan([join(moduleSyncFixture, 'src/entry.js')]).toRelative(moduleSyncFixture)
  const edge = result.files.get('src/entry.js').edges.find((e) => e.spec === 'mspkg')
  t.assert.equal(edge.child, 'node_modules/mspkg/sync.js',
    'static scan must pick the module-sync branch when present (matches Node\'s resolver)')
  t.assert.ok(result.files.has('node_modules/mspkg/sync.js'))
  t.assert.ok(!result.files.has('node_modules/mspkg/async.js'),
    'the import branch must not be reached when module-sync is present')
})

test('stasis bundle of module-sync package executes the same code as plain Node', withTmp(async (t, tmp) => {
  cpSync(moduleSyncFixture, tmp, { recursive: true })
  // Plain node first: source of truth for which branch should execute.
  const plain = spawnSync(process.execPath, ['src/entry.js'], { cwd: tmp, encoding: 'utf-8' })
  t.assert.equal(plain.status, 0)
  t.assert.equal(plain.stdout, 'MODULE-SYNC\n')

  // Then via static bundle -- must match.
  const bundlePath = join(tmp, 'snap.br')
  const build = runCli(['bundle', `--scope=full`, `--output=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(build.status, 0, `bundle stderr: ${build.stderr}`)
  // ed41d6f made scope=full the default; no flag needed.
  const load = runCli(
    ['run', '--lock=none', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
    { cwd: tmp },
  )
  t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
  t.assert.equal(load.stdout, plain.stdout,
    'static bundle must execute the same branch as plain Node; module-sync mismatch would print "IMPORT"')
}))
