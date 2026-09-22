import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePnpmLockfile, resolveDepRef } from '@exodus/stasis-deps/lockfile'

const here = dirname(fileURLToPath(import.meta.url))
const rootLockfile = join(here, '..', 'pnpm-lock.yaml')
const fixtureLockfile = join(here, 'fixtures', 'pnpm-bundle', 'pnpm-lock.yaml')

test('parsePnpmLockfile reads this workspace\'s pnpm-lock.yaml (tarball URLs, peers, deprecations) and the fixture\'s', (t) => {
  for (const file of [rootLockfile, fixtureLockfile]) {
    const lock = parsePnpmLockfile(readFileSync(file, 'utf8'))
    t.assert.equal(lock.version, '9.0')
    t.assert.deepEqual(lock.settings, { autoInstallPeers: true, excludeLinksFromLockfile: false })
    t.assert.ok(lock.importers.has('.'))
    t.assert.equal(lock.packages.size, lock.snapshots.size)
    for (const [key, pkg] of lock.packages) {
      t.assert.match(pkg.resolution.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, key)
    }
  }
  // lockfileIncludeTarballUrl is on in this workspace: every resolution records its tarball.
  const root = parsePnpmLockfile(readFileSync(rootLockfile, 'utf8'))
  t.assert.equal(root.packages.get('@babel/code-frame@7.29.7').resolution.tarball, 'https://registry.npmjs.org/@babel/code-frame/-/code-frame-7.29.7.tgz')
  t.assert.ok([...root.packages.values()].every((pkg) => typeof pkg.resolution.tarball === 'string'))
  const fixture = parsePnpmLockfile(readFileSync(fixtureLockfile, 'utf8'))
  t.assert.equal(fixture.snapshots.get('axios@1.7.7(debug@4.3.6)').dependencies.get('follow-redirects'), '1.16.0(debug@4.3.6)')
  t.assert.deepEqual(fixture.snapshots.get('axios@1.7.7(debug@4.3.6)').transitivePeerDependencies, ['debug'])
  t.assert.deepEqual(fixture.packages.get('debug@4.3.6').peerDependenciesMeta, { 'supports-color': { optional: true } })
  t.assert.deepEqual(fixture.packages.get('debug@4.3.6').peerDependencies, { 'supports-color': '*' })
  t.assert.match(fixture.packages.get('uuid@10.0.0').deprecated, /no longer supported/u)
  t.assert.equal(fixture.packages.get('uuid@10.0.0').hasBin, true)
  t.assert.deepEqual(fixture.packages.get('body-parser@1.20.2').engines, { node: '>= 0.8', npm: '1.2.8000 || >= 1.4.16' })
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

test('parsePnpmLockfile reads the PROJECT lockfile out of a pnpm 12 two-document stream', (t) => {
  // A project that pins its package manager gets the manager's own lockfile as the first document.
  const stream = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      pnpm:',
    '        specifier: 12.0.0',
    '        version: 12.0.0',
    'packages:',
    '  pnpm@12.0.0:',
    '    resolution: {integrity: sha512-manager}',
    'snapshots:',
    '  pnpm@12.0.0: {}',
    '---',
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      ms:',
    '        specifier: 2.1.3',
    '        version: 2.1.3',
    'packages:',
    '  ms@2.1.3:',
    '    resolution: {integrity: sha512-project}',
    'snapshots:',
    '  ms@2.1.3: {}',
    '',
  ].join('\n')
  const lock = parsePnpmLockfile(stream)
  t.assert.deepEqual([...lock.packages.keys()], ['ms@2.1.3'])
  t.assert.equal(lock.packages.get('ms@2.1.3').resolution.integrity, 'sha512-project')
})

test('parsePnpmLockfile refuses lockfiles it cannot lay out faithfully, and malformed YAML', (t) => {
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '6.0'\nimporters:\n  .: {}\n"), /unsupported lockfileVersion "6\.0"/u)
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\n"), /no importers/u)
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\nimporters:\n  .: {}\nsnapshots:\n  foo@1.0.0: {}\n"), /no packages entry 'foo@1\.0\.0'/u)
  // The strict parser fails closed on what pnpm never writes: duplicate keys, anchors, tabs.
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n"), { name: 'YamlError' })
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: &v '9.0'\nimporters: *v\n"), { name: 'YamlError' })
  t.assert.throws(() => parsePnpmLockfile("lockfileVersion: '9.0'\nimporters:\n\t.: {}\n"), { name: 'YamlError' })
  t.assert.throws(() => parsePnpmLockfile(''), { name: 'YamlError' })
})
