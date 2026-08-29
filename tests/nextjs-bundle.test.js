// Static `stasis bundle --nextjs` coverage: convention-entry discovery, the server/client
// resolution passes (per-pass mainFields + browser condition, divergent edges keyed
// { client, server }), 'use client' boundary promotion, tsconfig/jsconfig paths, and the CLI
// flag surface. The fixture is a miniature Next-shaped app (pages/ + app/ + middleware) with a
// dual `exports`-conditions package and a browser-field package, so each pass's resolution is
// observable in the recorded edges.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Lockfile } from '@exodus/stasis-core/lockfile'
import { buildBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'
import { discoverNextEntries, hasUseClientDirective } from '../stasis/src/nextjs-entries.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'nextjs-app')

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

const runCli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-nextjs-bundle-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FIXTURE_ENTRIES = [
  'app/data/route.js',
  'app/layout.jsx',
  'app/page.jsx',
  'instrumentation-client.js',
  'middleware.js',
  'pages/_document.jsx',
  'pages/about.tsx',
  'pages/api/hello.js',
  'pages/index.jsx',
]

test('buildBundle --nextjs discovers the convention entries and walks both passes', async (t) => {
  const bundle = await buildBundle({ cwd: fixture, nextjs: true })

  t.assert.deepEqual(bundle.config, { scope: 'full' })
  // Discovered entries: pages/** (api + _document included), app/ special files, middleware --
  // and NOT app/_private/page.jsx (private folder) or components/widget.jsx (reached, not a root).
  t.assert.deepEqual([...bundle.entries].toSorted(), FIXTURE_ENTRIES)

  const files = new Set(bundle.sources.keys())
  t.assert.ok(files.has('components/widget.jsx'), 'reached client component is carried')
  t.assert.ok(files.has('lib/format.ts'), 'tsconfig-paths alias target is carried')
  t.assert.ok(!files.has('app/_private/page.jsx'), 'private app folders are not walked as entries')
  t.assert.ok(files.has('node_modules/dual-pkg/browser.js') && files.has('node_modules/dual-pkg/node.js'),
    'both halves of a divergent exports package are carried')
  t.assert.ok(files.has('node_modules/browser-field-pkg/browser.js') && files.has('node_modules/browser-field-pkg/index.js'),
    'both halves of a browser-field package are carried')

  const star = bundle.imports.get('*')
  // The `browser` exports condition only holds in the client pass, so the edge diverges per pass key.
  const dual = star.get('pages/index.jsx').get('dual-pkg')
  t.assert.ok(dual instanceof Map, 'divergent edge is a per-pass map')
  t.assert.equal(dual.get('client'), 'node_modules/dual-pkg/browser.js')
  t.assert.equal(dual.get('server'), 'node_modules/dual-pkg/node.js')

  // A node-FIRST exports map ({ node, browser }) must still land on its browser half in the
  // client pass -- the pass drops the `node` base condition like webpack's web target does.
  const nodeFirst = star.get('pages/index.jsx').get('node-first-pkg')
  t.assert.ok(nodeFirst instanceof Map, 'node-first exports diverge per pass')
  t.assert.equal(nodeFirst.get('client'), 'node_modules/node-first-pkg/client.js')
  t.assert.equal(nodeFirst.get('server'), 'node_modules/node-first-pkg/server.js')
  t.assert.ok(files.has('node_modules/node-first-pkg/client.js') && files.has('node_modules/node-first-pkg/server.js'))

  // Next's resolve.extensions: an extensionless import lands on a lone .mjs, and .tsx beats .jsx
  // when both twins exist -- the attested file is the one Next compiles.
  t.assert.equal(star.get('pages/index.jsx').get('../lib/env'), 'lib/env.mjs')
  t.assert.equal(star.get('app/page.jsx').get('../components/pick'), 'components/pick.tsx')
  t.assert.ok(files.has('components/pick.tsx') && !files.has('components/pick.jsx'))

  // instrumentation-client runs in the browser, so it seeds the client pass: its exports edge
  // diverges instead of resolving server-only.
  const instr = star.get('instrumentation-client.js').get('dual-pkg')
  t.assert.ok(instr instanceof Map, 'instrumentation-client resolves under both passes')
  t.assert.equal(instr.get('client'), 'node_modules/dual-pkg/browser.js')
  t.assert.equal(instr.get('server'), 'node_modules/dual-pkg/node.js')

  // components/widget.jsx is only in the client pass because its 'use client' directive promoted
  // it (nothing under pages/ imports it) -- the divergent browser-field edge proves the client
  // pass actually walked it.
  const label = star.get('components/widget.jsx').get('browser-field-pkg')
  t.assert.ok(label instanceof Map)
  t.assert.equal(label.get('client'), 'node_modules/browser-field-pkg/browser.js')
  t.assert.equal(label.get('server'), 'node_modules/browser-field-pkg/index.js')

  // tsconfig compilerOptions.paths alias, resolved without an explicit --typescript (implied).
  t.assert.equal(star.get('pages/about.tsx').get('@lib/format'), 'lib/format.ts')

  // Same-target edges stay flat.
  t.assert.equal(star.get('pages/index.jsx').get('../lib/greet.js'), 'lib/greet.js')

  t.assert.equal(bundle.formats.get('pages/about.tsx'), 'module')
  t.assert.equal(bundle.formats.get('pages/api/hello.js'), 'commonjs')
})

test('buildBundle --nextjs accepts explicit extra entries (a custom server)', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  writeFileSync(join(tmp, 'server.js'), 'require("./lib/secret.js")\n')

  const bundle = await buildBundle({ cwd: tmp, nextjs: true, entries: ['server.js'] })
  t.assert.deepEqual([...bundle.entries].toSorted(), [...FIXTURE_ENTRIES, 'server.js'].toSorted())
  t.assert.equal(bundle.imports.get('*').get('server.js').get('./lib/secret.js'), 'lib/secret.js')
}))

test('an app-router-only app with no client boundary skips the client pass (flat server edges)', withTmp(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app-only', version: '0.0.0' }))
  mkdirSync(join(tmp, 'app'))
  writeFileSync(join(tmp, 'app', 'page.jsx'), 'import { pick } from "dual-pkg"\nexport default function P() { return <p>{pick()}</p> }\n')
  cpSync(join(fixture, 'node_modules'), join(tmp, 'node_modules'), { recursive: true })

  const bundle = await buildBundle({ cwd: tmp, nextjs: true })
  t.assert.deepEqual([...bundle.entries], ['app/page.jsx'])
  // No pages/ routes and no 'use client' file: only the server pass ran, so the exports-package
  // edge is flat (single pass key collapses) and the browser half is never reached.
  t.assert.equal(bundle.imports.get('*').get('app/page.jsx').get('dual-pkg'), 'node_modules/dual-pkg/node.js')
  t.assert.ok(!bundle.sources.has('node_modules/dual-pkg/browser.js'))
}))

test('jsconfig.json paths back a JS-only app (Next honours either config)', withTmp(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'js-only', version: '0.0.0' }))
  writeFileSync(join(tmp, 'jsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@util/*': ['./util/*'] } } }))
  mkdirSync(join(tmp, 'pages'))
  mkdirSync(join(tmp, 'util'))
  writeFileSync(join(tmp, 'pages', 'index.js'), 'const { u } = require("@util/x.js")\nmodule.exports = () => u\n')
  writeFileSync(join(tmp, 'util', 'x.js'), 'exports.u = 1\n')

  const bundle = await buildBundle({ cwd: tmp, nextjs: true })
  t.assert.equal(bundle.imports.get('*').get('pages/index.js').get('@util/x.js'), 'util/x.js')
}))

test('buildBundle --nextjs with no Next layout and no entries fails with the lookup list', async (t) => {
  await t.assert.rejects(
    () => buildBundle({ cwd: join(here, 'fixtures', 'webpack-full'), nextjs: true }),
    /no Next\.js entries found under .* \(looked for pages\/, app\/, src\/pages\/, src\/app\/, middleware, instrumentation\)/
  )
})

test('buildBundle --nextjs conflicts: metro, conditions, mainFields, platforms, scope', async (t) => {
  const cwd = fixture
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, metro: true, platforms: ['ios'] }), /--nextjs can't be combined with --metro/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, metroResolver: true }), /--nextjs can't be combined with --metro/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, conditions: ['browser'] }), /--conditions can't be combined with --nextjs/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, mainFields: ['main'] }), /--mainFields can't be combined with --nextjs/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, platforms: ['web'] }), /--platforms is only valid with --metro/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, scope: 'node_modules' }), /--scope is not supported with --mainFields, --metro, or --nextjs/)
  await t.assert.rejects(() => buildBundle({ cwd, nextjs: true, entries: ['icon.png'] }), /not a JS\/TS\/JSX file: icon\.png/)
})

test('bundleCommand --nextjs writes the bundle and a companion lockfile attesting the same set', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const out = join(tmp, 'app.code.br')
  const lockOut = join(tmp, 'app.lock.json')
  await bundleCommand({ cwd: tmp, nextjs: true, output: out, lockfile: lockOut })

  const bundle = JSON.parse(brotliDecompressSync(readFileSync(out)))
  const lock = Lockfile.parse(readFileSync(lockOut, 'utf-8'))
  t.assert.deepEqual(bundle.entries.toSorted(), FIXTURE_ENTRIES)
  // Same file set, content vs integrity.
  const bundleFiles = Object.keys(bundle.sources['.'].files).toSorted()
  const lockFiles = Object.keys(JSON.parse(lock.serialize()).sources['.'].files).toSorted()
  t.assert.deepEqual(lockFiles, bundleFiles)
  for (const integrity of Object.values(JSON.parse(lock.serialize()).sources['.'].files)) {
    t.assert.ok(integrity.startsWith('sha512-'))
  }
  // The per-pass edge shape round-trips the artifact parsers.
  t.assert.deepEqual(bundle.imports['*']['pages/index.jsx']['dual-pkg'], {
    client: 'node_modules/dual-pkg/browser.js',
    server: 'node_modules/dual-pkg/node.js',
  })
}))

test('CLI: stasis bundle --nextjs builds from the fixture with no entry positionals', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const r = runCli(['bundle', '--nextjs', '--output=app.code.br'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /Bundled 21 files in 4 packages/)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(join(tmp, 'app.code.br'))))
  t.assert.deepEqual(decoded.entries.toSorted(), FIXTURE_ENTRIES)
}))

test('CLI: --nextjs flag conflicts and entry validation', async (t) => {
  const cases = [
    [['bundle', '--nextjs', '--metro', '--platforms=ios'], /--nextjs can't be combined with --metro/],
    [['bundle', '--nextjs', '--metro-resolver'], /--nextjs can't be combined with --metro/],
    [['bundle', '--nextjs', '--conditions=browser'], /--conditions can't be combined with --nextjs/],
    [['bundle', '--nextjs', '--mainFields=main'], /--mainFields can't be combined with --nextjs/],
    [['bundle', '--nextjs', '--platforms=web'], /--platforms is only valid with --metro/],
    [['bundle', '--nextjs', '--scope=full'], /--scope is not supported with --mainFields, --metro, or --nextjs/],
    [['bundle', '--nextjs', 'style.css'], /--nextjs entries must be \.js\/\.cjs\/\.mjs\/\.ts\/\.cts\/\.mts\/\.jsx\/\.tsx files/],
    [['bundle'], /Nothing to bundle: no entry file given/],
  ]
  for (const [args, expected] of cases) {
    const r = runCli(args, { cwd: fixture })
    t.assert.notEqual(r.status, 0, args.join(' '))
    t.assert.match(r.stderr, expected, args.join(' '))
  }
})

test('CLI: --nextjs accepts .tsx extras and --tsconfig without --typescript (both implied)', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const r = runCli(['bundle', '--nextjs', '--tsconfig=tsconfig.json', '--output=out.br', 'pages/about.tsx'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
}))

test('discoverNextEntries: src/ variants, root precedence, and client-entry classification', withTmp(async (t, tmp) => {
  // src/pages + src/app layout, middleware at BOTH root and src/ (root must win).
  mkdirSync(join(tmp, 'src', 'pages', 'api'), { recursive: true })
  mkdirSync(join(tmp, 'src', 'app', '_lib'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'pages', 'index.tsx'), '')
  writeFileSync(join(tmp, 'src', 'pages', '_app.tsx'), '')
  writeFileSync(join(tmp, 'src', 'pages', '_document.tsx'), '')
  writeFileSync(join(tmp, 'src', 'pages', 'types.d.ts'), '')
  writeFileSync(join(tmp, 'src', 'pages', 'api', 'ping.ts'), '')
  writeFileSync(join(tmp, 'src', 'app', 'page.tsx'), '')
  writeFileSync(join(tmp, 'src', 'app', 'helper.ts'), '')
  writeFileSync(join(tmp, 'src', 'app', 'icon2.tsx'), '')
  writeFileSync(join(tmp, 'src', 'app', 'icon22.tsx'), '') // two digits: not a metadata variant
  writeFileSync(join(tmp, 'src', 'app', 'global-not-found.tsx'), '')
  writeFileSync(join(tmp, 'src', 'app', '_lib', 'page.tsx'), '')
  writeFileSync(join(tmp, 'middleware.ts'), '')
  writeFileSync(join(tmp, 'src', 'middleware.ts'), '')
  writeFileSync(join(tmp, 'src', 'instrumentation.js'), '')
  writeFileSync(join(tmp, 'instrumentation-client.tsx'), '')
  writeFileSync(join(tmp, 'proxy.mjs'), '') // Next matches root files against pageExtensions -- no .mjs

  const { entries, clientEntries } = discoverNextEntries(tmp)
  t.assert.deepEqual(entries, [
    'instrumentation-client.tsx', // pageExtensions apply to the root files too
    'middleware.ts', // root wins over src/middleware.ts
    'src/app/global-not-found.tsx',
    'src/app/icon2.tsx', // one-digit metadata variant; icon22 (two digits) is not one
    'src/app/page.tsx', // helper.ts is not a special file; _lib/ is private
    'src/instrumentation.js',
    'src/pages/_app.tsx',
    'src/pages/_document.tsx',
    'src/pages/api/ping.ts', // .d.ts excluded
    'src/pages/index.tsx',
  ])
  // Client seeds: pages minus api/** and _document, plus browser-run instrumentation-client
  // (middleware/instrumentation/app never seed).
  t.assert.deepEqual(clientEntries, ['instrumentation-client.tsx', 'src/pages/_app.tsx', 'src/pages/index.tsx'])
}))

test('hasUseClientDirective: directive prologue forms', (t) => {
  const yes = [
    "'use client'\nexport const x = 1\n",
    '"use client";\nexport const x = 1\n',
    "  \t\n'use client'\n",
    "'use strict';\n'use client'\nexport {}\n",
    "// leading comment\n/* block\ncomment */ 'use client'\n",
    "#!/usr/bin/env node\n'use client'\n",
    "﻿'use client'\n",
    "'use strict'\r\n'use client'\r\nlet a\n",
    // a comment (or even a line break) may sit between a directive and ITS terminating ';'
    "'use strict' /* legacy */;\n'use client'\n",
    "'use strict'\n;\n'use client'\n",
  ]
  for (const src of yes) {
    t.assert.equal(hasUseClientDirective(src), true, JSON.stringify(src))
  }
  const no = [
    '',
    'export const x = 1\n',
    "import 'x'\n'use client'\n", // prologue over at `import`
    "function f() { 'use client' }\n",
    "const s = 'use client'\n",
    '`use client`\n', // template literals are never directives
    "'use strict'\nexport {}\n",
    "'use client", // unterminated
    "'use\\x20client'\n", // escaped spelling is not a directive match
    "'use strict';;'use client'\n", // the second ';' is an EmptyStatement -- prologue over
    ";'use client'\n", // a leading EmptyStatement ends the prologue before any directive
  ]
  for (const src of no) {
    t.assert.equal(hasUseClientDirective(src), false, JSON.stringify(src))
  }
  t.assert.equal(hasUseClientDirective(Buffer.from("'use client'\n")), true, 'Buffer input')
})
