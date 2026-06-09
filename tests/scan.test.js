import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Scan, scan } from '../src/scan.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')
const cjsFixture = join(here, 'fixtures', 'cli-run-cjs')
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
    ['--input-type=module', '-e', probe, join(here, '..', 'src/scan.js'), join(cjsFixture, 'src/entry.cjs')],
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
