import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import { createNodeResolver } from '../stasis/src/resolve-node.js'
import { diskHost } from '../stasis/src/host.js'

// The host-based reimplementation of Node's CJS resolver (used by `stasis bundle --pnpm` over an
// in-memory node_modules) checked against `require.resolve` itself on a real tree covering every
// rule it mirrors: lookup paths, extension probing, directory main/index, exports (conditions,
// patterns, arrays, null, sugar), imports, self-reference, symlinks and the error codes.

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-resolve-node-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeTree(d) {
  const w = (rel, content = '') => {
    mkdirSync(dirname(join(d, rel)), { recursive: true })
    writeFileSync(join(d, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
  w('package.json', { name: 'self', version: '1.0.0', exports: { '.': './main.cjs', './feat': { import: './feat.mjs', default: './feat.cjs' } }, imports: { '#a': './a.ts', '#dep/*': 'pkg/lib/*.js', '#miss': './nope.js', '#cond': { node: './cond-node.js', default: './cond.js' }, '#builtin': 'node:fs', '#bare': 'pkg', '#arr': ['./nope.js', './arr.js'] } })
  for (const f of ['main.cjs', 'feat.mjs', 'feat.cjs', 'a.ts', 'cond-node.js', 'cond.js', 'arr.js', 'dir2/index.js', 'm.mjs', 'file.js', 'file.json', 'both.js', 'both.json', 'sub/lib/index.js', 'real/z.js', 'deep/node_modules/x/index.js', 'deep/a.js', 'nm/node_modules/foo/index.js']) w(f)
  w('dir/index.json', '{}')
  w('sub/package.json', { main: './lib/' })
  symlinkSync(join(d, 'real'), join(d, 'link'))
  mkdirSync(join(d, 'emptydir'))
  w('node_modules/pkg/package.json', { name: 'pkg', main: './lib/' }); w('node_modules/pkg/lib/index.js'); w('node_modules/pkg/lib/q.js')
  w('node_modules/e/package.json', { name: 'e', exports: { '.': { import: './lib/i.mjs', require: './lib/r.cjs' }, './sub/*': './lib/*.js', './x': null, './deep/*.js': './lib/deep/*.js', './trail/': './lib/' } })
  for (const f of ['node_modules/e/lib/i.mjs', 'node_modules/e/lib/r.cjs', 'node_modules/e/lib/q.js', 'node_modules/e/lib/deep/a.js']) w(f)
  w('node_modules/arr/package.json', { name: 'arr', exports: ['./nope.js', './ok.js'] }); w('node_modules/arr/ok.js')
  w('node_modules/bm/package.json', { name: 'bm', main: './missing.js' }); w('node_modules/bm/index.js')
  w('node_modules/bm2/package.json', { name: 'bm2', main: './missing.js' })
  w('node_modules/nest/package.json', { name: 'nest', exports: { node: { import: './n-i.mjs', require: './n-r.cjs' }, default: './d.js' } })
  for (const f of ['node_modules/nest/n-i.mjs', 'node_modules/nest/n-r.cjs', 'node_modules/nest/d.js']) w(f)
  w('node_modules/@s/p/package.json', { name: '@s/p' }); w('node_modules/@s/p/index.js'); w('node_modules/@s/p/node_modules/inner/index.js')
  w('node_modules/@s/p/node_modules/inner2/package.json', { name: 'inner2', exports: './x.js' }); w('node_modules/@s/p/node_modules/inner2/x.js')
  w('node_modules/noname/index.js')
  w('node_modules/bad/package.json', '{bad'); w('node_modules/bad/index.js')
  w('node_modules/esc/package.json', { name: 'esc', exports: '../a.ts' })
  w('node_modules/esc2/package.json', { name: 'esc2', exports: './lib/../../a.ts' })
  w('node_modules/pat/package.json', { name: 'pat', exports: { './*.js': './dist/*.js', './feat/*': './dist/feat/*.js', './feat/private/*': null, './n/*': { node: './dist/n/*.node.js', default: './dist/n/*.js' } } })
  for (const f of ['node_modules/pat/dist/a.js', 'node_modules/pat/dist/feat/x.js', 'node_modules/pat/dist/feat/private/y.js', 'node_modules/pat/dist/n/k.node.js', 'node_modules/pat/dist/n/k.js']) w(f)
  w('node_modules/sugar/package.json', { name: 'sugar', exports: './s.js' }); w('node_modules/sugar/s.js')
  w('node_modules/sugarc/package.json', { name: 'sugarc', exports: { require: './r.js', import: './i.js' } }); w('node_modules/sugarc/r.js'); w('node_modules/sugarc/i.js')
  w('node_modules/mixed/package.json', { name: 'mixed', exports: { '.': './a.js', require: './b.js' } }); w('node_modules/mixed/a.js')
  w('node_modules/numkey/package.json', { name: 'numkey', exports: { '.': { 0: './a.js', default: './a.js' } } }); w('node_modules/numkey/a.js')
  w('node_modules/selfref/package.json', { name: 'selfref', exports: { '.': './idx.js', './util': './u.js' } }); w('node_modules/selfref/idx.js'); w('node_modules/selfref/u.js'); w('node_modules/selfref/deep/x.js')
  w('node_modules/imp/package.json', { name: 'imp', imports: { '#x': './x.js', '#y': 'e/sub/q', '#z': 'nest' } }); w('node_modules/imp/x.js'); w('node_modules/imp/idx.js')
  w('node_modules/typeless/package.json', { name: 'typeless', main: 'lib' }); w('node_modules/typeless/lib.js')
  w('node_modules/mainidx/package.json', { name: 'mainidx', main: 'lib' }); w('node_modules/mainidx/lib/index.js')
  w('node_modules/dotmain/package.json', { name: 'dotmain', main: '.' }); w('node_modules/dotmain/index.js')
  w('node_modules/exptrail/package.json', { name: 'exptrail', exports: { './': './lib/' } }); w('node_modules/exptrail/lib/a.js')
  w('node_modules/space pkg/package.json', { name: 'space pkg', exports: './my file.js' }); w('node_modules/space pkg/my file.js')
  w('node_modules/pct/package.json', { name: 'pct', exports: './a%20b.js' }); w('node_modules/pct/a b.js'); w('node_modules/pct/a%20b.js')
  w('node_modules/hash/package.json', { name: 'hash', exports: './a#b.js' }); w('node_modules/hash/a#b.js')
  w('node_modules/idxnode/index.node'); w('node_modules/idxjson/index.json', '{}')
}

const CONDITIONS = {
  req: new Set(['require', 'node', 'node-addons']),
  imp: new Set(['node', 'import', 'module-sync', 'node-addons']),
  browser: new Set(['browser', 'require']),
}

const ROOT_SPECS = ['./a', './a.ts', './dir', './dir2', './m.mjs', './m', './file', './both', './sub', './link/z', './link', './real/z.js', '.', '..', './dir/', './dir/.', './missing', './emptydir', '/etc/passwd', 'pkg', 'pkg/lib/q', 'pkg/lib/q.js', 'pkg/missing', 'e', 'e/sub/q', 'e/x', 'e/lib/q.js', 'e/sub/missing', 'e/deep/a.js', 'e/deep/a', 'e/trail/q.js', 'arr', 'bm', 'bm2', 'nest', 'nest/d.js', '@s/p', '@s/p/index', '@s/p/index.js', '@s', '@s/', 'noname', 'bad', 'esc', 'esc2', 'pat/a.js', 'pat/feat/x', 'pat/feat/private/y', 'pat/n/k', 'pat/b.js', 'pat', 'sugar', 'sugar/s.js', 'sugarc', 'mixed', 'numkey', 'selfref', 'selfref/util', 'selfref/deep/x.js', 'imp', 'typeless', 'mainidx', 'dotmain', 'exptrail/a.js', 'space pkg', 'pct', 'hash', 'idxnode', 'idxjson', 'self', 'self/feat', 'self/missing', '#a', '#dep/index', '#dep/q', '#miss', '#zzz', '#cond', '#builtin', '#bare', '#arr', '#', '#/x', 'fs', 'node:fs', 'nonexistent', '.foo', './', '', 'e/sub/../q', 'pkg/./lib/q', 'pkg/lib/../lib/q', './node_modules/pkg', 'x']

test('createNodeResolver(diskHost) agrees with require.resolve on every case, hits and error codes alike', withTmp((t, d) => {
  writeTree(d)
  const mine = createNodeResolver(diskHost)
  const cases = []
  const add = (parent, spec, c = 'req') => cases.push([join(d, parent), spec, c])
  for (const spec of ROOT_SPECS) for (const c of ['req', 'imp']) add('main.cjs', spec, c)
  add('main.cjs', join(d, 'file'))
  for (const spec of ['inner', 'inner2', 'pkg', 'e', '@s/p', 'selfref', '.', './index', '../inner', 'nonexistent', '#x']) add('node_modules/@s/p/index.js', spec)
  for (const spec of ['#x', '#y', '#z', 'imp', 'imp/x.js', '#nope']) add('node_modules/imp/idx.js', spec)
  for (const spec of ['selfref', 'selfref/util', 'selfref/deep/x.js', 'selfref/nope', './idx']) add('node_modules/selfref/deep/x.js', spec)
  for (const spec of ['x', 'pkg', 'foo', 'e']) add('deep/a.js', spec)
  for (const spec of ['foo', 'pkg']) add('nm/node_modules/foo/index.js', spec)
  for (const spec of ['nest', 'sugarc', 'pat/n/k', 'e']) add('main.cjs', spec, 'browser')

  const mismatches = []
  const outcome = (fn) => {
    try {
      return fn()
    } catch (e) {
      return `ERR:${e.code}`
    }
  }
  for (const [parent, spec, c] of cases) {
    const conditions = CONDITIONS[c]
    const expected = outcome(() => createRequire(parent).resolve(spec, { conditions }))
    const actual = outcome(() => mine.resolve(parent, spec, conditions))
    if (expected !== actual) mismatches.push({ parent: parent.slice(d.length), spec, conditions: c, expected, actual })
  }
  t.assert.ok(cases.length > 200)
  t.assert.deepEqual(mismatches, [])
}))
