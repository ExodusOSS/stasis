import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseYaml } from '@exodus/stasis-deps/yaml'
import { parsePnpmLockfile, resolveDepRef } from '@exodus/stasis-deps/lockfile'

const here = dirname(fileURLToPath(import.meta.url))
const rootLockfile = join(here, '..', 'pnpm-lock.yaml')
const fixtureLockfile = join(here, 'fixtures', 'pnpm-bundle', 'pnpm-lock.yaml')

test('parseYaml reads block mappings, sequences, flow collections and every scalar form pnpm emits', (t) => {
  const doc = parseYaml(`
a: 'it''s'
b: "x\\ny\\u0041"
c: [1, two, 'th ree', {k: v}]
d:
  - x
  - y: 1
    z: 2
  - [a, b]
e: |
  line1
  line2
f: >-
  fold
  ed
g: ~
h: # comment
  i: 'a # not comment'
j: https://x/y#frag
k: 007
l: 12.5
m: -3
n: 'yes'
o:
- s1
- s2
p: {}
q: []
r: {a: 1,
  b: 2}
'@scope/name@1.0.0(peer@2.0.0)':
  resolution: {integrity: sha512-abc==, tarball: https://registry.npmjs.org/@scope/name/-/name-1.0.0.tgz}
  engines: {node: '>= 0.6'}
`)
  t.assert.deepEqual(doc, {
    a: "it's",
    b: 'x\nyA',
    c: [1, 'two', 'th ree', { k: 'v' }],
    d: ['x', { y: 1, z: 2 }, ['a', 'b']],
    e: 'line1\nline2\n',
    f: 'fold ed',
    g: null,
    h: { i: 'a # not comment' },
    j: 'https://x/y#frag',
    k: '007',
    l: 12.5,
    m: -3,
    n: 'yes',
    o: ['s1', 's2'],
    p: {},
    q: [],
    r: { a: 1, b: 2 },
    '@scope/name@1.0.0(peer@2.0.0)': {
      resolution: { integrity: 'sha512-abc==', tarball: 'https://registry.npmjs.org/@scope/name/-/name-1.0.0.tgz' },
      engines: { node: '>= 0.6' },
    },
  })
  // Mappings are null-prototype: a `__proto__` key can't poison anything.
  t.assert.equal(Object.getPrototypeOf(doc), null)
})

test('parseYaml rejects the YAML features a machine-written lockfile never contains', (t) => {
  t.assert.throws(() => parseYaml('a: &anchor 1\nb: *anchor\n'), /Unsupported YAML feature/u)
  t.assert.throws(() => parseYaml('a: !!str 1\n'), /Unsupported YAML feature/u)
  t.assert.throws(() => parseYaml('a:\n\tb: 1\n'), /Tabs/u)
  t.assert.throws(() => parseYaml('a: [1, 2\n'), /Unterminated flow/u)
  t.assert.throws(() => parseYaml('a: 1\na: 2\n'), /Duplicate key/u)
  t.assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\n'), /indentation/u)
  t.assert.equal(parseYaml('# only a comment\n'), null)
})

test('parseYaml reads this workspace\'s pnpm-lock.yaml (tarball URLs, peers, deprecations) and the fixture\'s', (t) => {
  for (const file of [rootLockfile, fixtureLockfile]) {
    const doc = parseYaml(readFileSync(file, 'utf8'))
    t.assert.equal(doc.lockfileVersion, '9.0')
    t.assert.deepEqual(doc.settings, { autoInstallPeers: true, excludeLinksFromLockfile: false })
    t.assert.ok(Object.keys(doc.importers).includes('.'))
    t.assert.equal(Object.keys(doc.packages).length, Object.keys(doc.snapshots).length)
    for (const [key, pkg] of Object.entries(doc.packages)) {
      t.assert.match(pkg.resolution.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, key)
    }
  }
  const root = parseYaml(readFileSync(rootLockfile, 'utf8'))
  t.assert.equal(root.packages['@babel/code-frame@7.29.7'].resolution.tarball, 'https://registry.npmjs.org/@babel/code-frame/-/code-frame-7.29.7.tgz')
  const fixture = parseYaml(readFileSync(fixtureLockfile, 'utf8'))
  t.assert.deepEqual(fixture.snapshots['axios@1.7.7(debug@4.3.6)'].dependencies['follow-redirects'], '1.16.0(debug@4.3.6)')
  t.assert.deepEqual(fixture.packages['debug@4.3.6'].peerDependenciesMeta, { 'supports-color': { optional: true } })
  t.assert.match(fixture.packages['uuid@10.0.0'].deprecated, /no longer supported/u)
})

test('parsePnpmLockfile types the fixture lockfile and resolves dependency references to snapshot keys', (t) => {
  const lock = parsePnpmLockfile(readFileSync(fixtureLockfile, 'utf8'))
  t.assert.equal(lock.version, '9.0')
  t.assert.equal(lock.importers.size, 1)
  const root = lock.importers.get('.')
  t.assert.deepEqual(root.dependencies.get('axios'), { specifier: '1.7.7', version: '1.7.7(debug@4.3.6)' })
  t.assert.equal(lock.packages.get('axios@1.7.7').name, 'axios')
  t.assert.equal(lock.packages.get('axios@1.7.7').version, '1.7.7')
  t.assert.equal(lock.snapshots.get('axios@1.7.7(debug@4.3.6)').packageKey, 'axios@1.7.7')
  t.assert.equal(resolveDepRef(lock, 'axios', '1.7.7(debug@4.3.6)', 'test'), 'axios@1.7.7(debug@4.3.6)')
  t.assert.equal(resolveDepRef(lock, 'ms', '2.1.2', 'test'), 'ms@2.1.2')
  t.assert.equal(resolveDepRef(lock, 'anything', 'link:../x', 'test'), null)
  t.assert.throws(() => resolveDepRef(lock, 'ms', '9.9.9', 'importer x'), /snapshot 'ms@9\.9\.9' is not recorded/u)
})

test('parsePnpmLockfile refuses lockfiles it cannot lay out faithfully', (t) => {
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '6.0'\nimporters:\n  .: {}\n"), /unsupported lockfileVersion "6\.0"/u)
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\n"), /no importers/u)
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\nimporters:\n  .: {}\nsnapshots:\n  foo@1.0.0: {}\n"), /no packages entry 'foo@1\.0\.0'/u)
})
