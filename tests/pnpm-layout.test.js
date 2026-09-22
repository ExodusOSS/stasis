import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  createBase32Hash,
  createShortHash,
  depPathToFilename,
  parseDepPath,
  refToDepPath,
  registryTarballUrl,
  stripPeerSuffix,
} from '../stasis/src/pnpm/dep-path.js'
import { readPackageTarball } from '../stasis/src/pnpm/tar.js'
import { MemoryTree, createOverlayHost, diskHost } from '../stasis/src/pnpm/vfs.js'
import { authHeadersFor, loadPnpmSettings, parseNpmrc, registryFor } from '../stasis/src/pnpm/settings.js'
import { parsePnpmLockfile } from '../stasis/src/pnpm/lockfile.js'
import { assertTarballUrl, buildLayout, computeHoisted, computeSkipped, createHoistMatcher, packageIsInstallable, planTarballs } from '../stasis/src/pnpm/layout.js'
import { cachePathFor, fetchTarballs, integrityOf, parseIntegrity } from '../stasis/src/pnpm/fetch.js'
import { createNodeResolver } from '../stasis/src/resolve-node.js'

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-pnpm-layout-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- dep paths ---

test('parseDepPath splits name / version / peer suffix the way pnpm keys its lockfile', (t) => {
  t.assert.deepEqual(parseDepPath('axios@1.7.7'), { name: 'axios', version: '1.7.7', peersSuffix: '' })
  t.assert.deepEqual(parseDepPath('axios@1.7.7(debug@4.3.6)'), { name: 'axios', version: '1.7.7', peersSuffix: '(debug@4.3.6)' })
  t.assert.deepEqual(parseDepPath('@babel/core@7.29.7(supports-color@9.0.0)(x@1)'), { name: '@babel/core', version: '7.29.7', peersSuffix: '(supports-color@9.0.0)(x@1)' })
  t.assert.deepEqual(parseDepPath('foo@file:../foo'), { name: 'foo', version: 'file:../foo', peersSuffix: '' })
  t.assert.equal(stripPeerSuffix('@vitejs/plugin-react@4.0.0(vite@5.0.0(@types/node@20.0.0))'), '@vitejs/plugin-react@4.0.0')
  t.assert.throws(() => parseDepPath('noversion'), /Malformed/u)
})

test('refToDepPath prefixes bare versions with the alias, keeps aliased name@version refs, and drops link: refs', (t) => {
  t.assert.equal(refToDepPath('ms', '2.1.2'), 'ms@2.1.2')
  t.assert.equal(refToDepPath('axios', '1.7.7(debug@4.3.6)'), 'axios@1.7.7(debug@4.3.6)')
  t.assert.equal(refToDepPath('string-width-cjs', 'string-width@4.2.3'), 'string-width@4.2.3')
  t.assert.equal(refToDepPath('types', '@types/node@20.0.0'), '@types/node@20.0.0')
  t.assert.equal(refToDepPath('foo', 'file:../foo'), 'foo@file:../foo')
  t.assert.equal(refToDepPath('foo', 'link:../foo'), null)
})

test('depPathToFilename reproduces pnpm 10\'s virtual store directory names, hashed fallback included', (t) => {
  t.assert.equal(depPathToFilename('axios@1.7.7(debug@4.3.6)'), 'axios@1.7.7_debug@4.3.6')
  t.assert.equal(depPathToFilename('@babel/code-frame@7.29.7'), '@babel+code-frame@7.29.7')
  t.assert.equal(depPathToFilename('@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7)'), '@babel+helper-module-transforms@7.29.7_@babel+core@7.29.7')
  // Nested peer parentheses leave pnpm's trailing underscore.
  t.assert.equal(depPathToFilename('@vitejs/plugin-react@4.0.0(vite@5.0.0(@types/node@20.0.0))'), '@vitejs+plugin-react@4.0.0_vite@5.0.0_@types+node@20.0.0_')
  t.assert.equal(depPathToFilename('foo@file:../foo'), 'foo@file+..+foo')
  // Observed from a real `pnpm install` with virtual-store-dir-max-length=45 (pnpm 10.33):
  t.assert.equal(depPathToFilename('@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7)', 45), '@babel+helpe_78db9f247d2d1db891b47f0d057506f9')
  t.assert.equal(createShortHash('@babel+helper-module-transforms@7.29.7_@babel+core@7.29.7'), '78db9f247d2d1db891b47f0d057506f9')
  // Uppercase names are hashed too (case-insensitive filesystems); a bare `file+` path is exempt.
  t.assert.match(depPathToFilename('Foo@1.0.0'), /^Foo@1\.0\.0_[0-9a-f]{32}$/u)
  t.assert.equal(depPathToFilename('file:../Foo'), 'file+..+Foo')
  t.assert.match(depPathToFilename('foo@file:../Foo'), /^foo@file\+\.\.\+Foo_[0-9a-f]{32}$/u)
  // pnpm 9's scheme is kept available: 26 base32 chars of md5.
  t.assert.match(depPathToFilename('@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7)', 45, { hashScheme: 'md5-base32' }), /^@babel\+helper-modu_[a-z2-7]{26}$/u)
  t.assert.equal(createBase32Hash('').length, 26)
})

test('registryTarballUrl follows the npm registry layout for plain and scoped names', (t) => {
  t.assert.equal(registryTarballUrl('ms', '2.1.3'), 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz')
  t.assert.equal(registryTarballUrl('@babel/core', '7.29.7', 'https://npm.example.com'), 'https://npm.example.com/@babel/core/-/core-7.29.7.tgz')
})

// --- tarballs ---

// A minimal ustar writer (plus GNU long-name entries) for the reader's tests.
function tarEntry(name, content, { mode = 0o644, type = '0' } = {}) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(mode.toString(8).padStart(7, '0'), 100, 8)
  header.write('0000000', 108, 8)
  header.write('0000000', 116, 8)
  header.write(content.length.toString(8).padStart(11, '0'), 124, 12)
  header.write('00000000000', 136, 12)
  header.write(type, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  header.fill(0x20, 148, 156)
  for (const b of header) sum += b
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded])
}
function makeTgz(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

test('readPackageTarball keeps regular files with their modes, strips the top-level dir, and drops links', (t) => {
  const long = `package/${'d'.repeat(120)}/deep.js`
  const files = readPackageTarball(makeTgz([
    tarEntry('package/', Buffer.alloc(0), { type: '5', mode: 0o755 }),
    tarEntry('package/index.js', Buffer.from('module.exports = 1\n')),
    tarEntry('package/bin/cli.js', Buffer.from('#!/usr/bin/env node\n'), { mode: 0o755 }),
    tarEntry('package/link', Buffer.alloc(0), { type: '2' }),
    tarEntry('././@LongLink', Buffer.from(`${long}\0`), { type: 'L' }),
    tarEntry('package/truncated-name-ignored', Buffer.from('deep')),
    tarEntry('package/package.json', Buffer.from('{"name":"x"}')),
  ]), { label: 'x' })
  t.assert.deepEqual([...files.keys()].toSorted(), ['bin/cli.js', `${'d'.repeat(120)}/deep.js`, 'index.js', 'package.json'])
  t.assert.equal(files.get('index.js').content.toString(), 'module.exports = 1\n')
  t.assert.equal(files.get('index.js').mode, 0o644)
  t.assert.equal(files.get('bin/cli.js').mode, 0o755)
  t.assert.equal(files.get(`${'d'.repeat(120)}/deep.js`).content.toString(), 'deep')
})

test('readPackageTarball refuses entries that escape the package', (t) => {
  t.assert.throws(() => readPackageTarball(makeTgz([tarEntry('package/../evil.js', Buffer.from('x'))]), { label: 'x' }), /escapes the package/u)
  t.assert.throws(() => readPackageTarball(makeTgz([tarEntry('/abs/evil.js', Buffer.from('x'))]), { label: 'x' }), /absolute path|escapes/u)
  t.assert.throws(() => readPackageTarball(gzipSync(tarEntry('package/a.js', Buffer.alloc(1000, 0x61)).subarray(0, 600)), { label: 'x' }), /truncated/u)
})

test('fetchTarballs serves a cached tarball only when it still matches its integrity, and never fetches without one', withTmp(async (t, tmp) => {
  const bytes = makeTgz([tarEntry('package/index.js', Buffer.from('ok'))])
  const integrity = integrityOf(bytes, 'sha512')
  let downloads = 0
  const fetchImpl = async () => { downloads++; return bytes }
  const entry = { key: 'x', url: 'https://example.invalid/x.tgz', integrity, label: 'x@1.0.0' }
  const first = await fetchTarballs([entry], { cacheDir: tmp, fetchImpl })
  t.assert.equal(downloads, 1)
  t.assert.deepEqual([first.downloaded, first.cached], [1, 0])
  t.assert.deepEqual(first.tarballs.get('x'), bytes)
  const second = await fetchTarballs([entry], { cacheDir: tmp, fetchImpl })
  t.assert.equal(downloads, 1, 'a verified cache hit downloads nothing')
  t.assert.deepEqual([second.downloaded, second.cached], [0, 1])
  // Tampered cache: evicted and re-fetched.
  writeFileSync(cachePathFor(tmp, parseIntegrity(integrity)), Buffer.from('garbage'))
  const third = await fetchTarballs([entry], { cacheDir: tmp, fetchImpl })
  t.assert.equal(downloads, 2)
  t.assert.deepEqual(third.tarballs.get('x'), bytes)
  // Offline with a cold cache refuses; a download that doesn't match its integrity refuses.
  await t.assert.rejects(fetchTarballs([{ ...entry, key: 'y', integrity: integrityOf(Buffer.from('other'), 'sha512') }], { cacheDir: tmp, fetchImpl, offline: true }), /pnpm-offline forbids/u)
  await t.assert.rejects(fetchTarballs([{ ...entry, key: 'z', integrity: integrityOf(Buffer.from('other'), 'sha512') }], { cacheDir: tmp, fetchImpl }), /integrity mismatch/u)
  await t.assert.rejects(fetchTarballs([{ ...entry, key: 'w', integrity: undefined }], { cacheDir: tmp, fetchImpl }), /no usable integrity/u)
}))

// --- the virtual filesystem ---

test('overlay host masks the on-disk node_modules, follows virtual symlinks (into the store and out to disk), and resolves through it', withTmp((t, tmp) => {
  const root = join(tmp, 'proj')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'onDisk'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'onDisk', 'index.js'), 'disk')
  writeFileSync(join(root, 'package.json'), '{"name":"proj","version":"1.0.0"}')
  writeFileSync(join(root, 'src', 'entry.js'), 'require("dep")')
  mkdirSync(join(root, 'packages', 'ws'), { recursive: true })
  writeFileSync(join(root, 'packages', 'ws', 'package.json'), '{"name":"ws","version":"1.0.0","main":"lib.js"}')
  writeFileSync(join(root, 'packages', 'ws', 'lib.js'), 'ws')

  const tree = new MemoryTree()
  const store = join(root, 'node_modules', '.pnpm')
  tree.addFile(join(store, 'dep@1.0.0/node_modules/dep/package.json'), Buffer.from('{"name":"dep","version":"1.0.0","exports":{"require":"./r.js","import":"./i.mjs"}}'))
  tree.addFile(join(store, 'dep@1.0.0/node_modules/dep/r.js'), Buffer.from('r'), 0o755)
  tree.addFile(join(store, 'dep@1.0.0/node_modules/dep/i.mjs'), Buffer.from('i'))
  tree.addSymlink(join(store, 'dep@1.0.0/node_modules/ws'), '../../../../packages/ws')
  tree.addSymlink(join(root, 'node_modules', 'dep'), '.pnpm/dep@1.0.0/node_modules/dep')
  tree.addSymlink(join(root, 'node_modules', 'loop'), 'loop2')
  tree.addSymlink(join(root, 'node_modules', 'loop2'), 'loop')
  t.assert.throws(() => tree.addFile(join(root, 'node_modules', 'dep'), Buffer.from('x')), /already exists/u)

  const host = createOverlayHost({ root, tree, makeResolver: createNodeResolver })
  t.assert.equal(host.exists(join(root, 'node_modules', 'onDisk', 'index.js')), false, 'the real install is invisible')
  t.assert.equal(host.exists(join(root, 'src', 'entry.js')), true, 'workspace sources come from disk')
  t.assert.equal(host.realpath(join(root, 'node_modules', 'dep', 'r.js')), join(store, 'dep@1.0.0/node_modules/dep/r.js'))
  t.assert.equal(host.realpath(join(store, 'dep@1.0.0/node_modules/ws/lib.js')), join(root, 'packages', 'ws', 'lib.js'), 'a link: target lands on disk')
  t.assert.equal(host.readFile(join(store, 'dep@1.0.0/node_modules/ws/lib.js')).toString(), 'ws')
  t.assert.equal(host.readFile(join(root, 'node_modules', 'dep', 'r.js')).toString(), 'r')
  t.assert.equal(host.stat(join(root, 'node_modules', 'dep', 'r.js')).mode & 0o111, 0o111)
  t.assert.equal(host.stat(join(root, 'node_modules', 'dep')).isDirectory(), true)
  t.assert.equal(host.lstat(join(root, 'node_modules', 'dep')).isSymbolicLink(), true)
  t.assert.equal(host.stat(join(root, 'node_modules', 'missing')), null)
  t.assert.throws(() => host.realpath(join(root, 'node_modules', 'loop', 'x')), /ELOOP/u)
  t.assert.deepEqual(host.readdir(join(root, 'node_modules')).map((d) => `${d.name}${d.isSymbolicLink() ? '@' : '/'}`), ['.pnpm/', 'dep@', 'loop@', 'loop2@'])
  t.assert.deepEqual(host.readdir(root).map((d) => d.name), ['node_modules', 'package.json', 'packages', 'src'], 'a disk dir lists the virtual node_modules')
  t.assert.throws(() => host.readFile(join(root, 'node_modules', 'dep')), /EISDIR/u)

  // Resolution through the overlay honours exports conditions and realpaths into the store.
  const entry = join(root, 'src', 'entry.js')
  t.assert.equal(host.resolve(entry, 'dep', new Set(['require', 'node'])), join(store, 'dep@1.0.0/node_modules/dep/r.js'))
  t.assert.equal(host.resolve(entry, 'dep', new Set(['import', 'node'])), join(store, 'dep@1.0.0/node_modules/dep/i.mjs'))
  t.assert.equal(host.resolve(join(store, 'dep@1.0.0/node_modules/dep/r.js'), 'ws', new Set(['require'])), join(root, 'packages', 'ws', 'lib.js'))
  t.assert.throws(() => host.resolve(entry, 'onDisk', new Set(['require'])), { code: 'MODULE_NOT_FOUND' })
  // The disk host is the plain path's view.
  t.assert.equal(diskHost.exists(join(root, 'node_modules', 'onDisk', 'index.js')), true)
}))

// --- settings ---

test('loadPnpmSettings layers ~/.npmrc, pnpm-workspace.yaml and the project .npmrc with pnpm 10 defaults', withTmp((t, tmp) => {
  const home = join(tmp, 'home')
  const root = join(tmp, 'proj')
  mkdirSync(home)
  mkdirSync(root)
  writeFileSync(join(home, '.npmrc'), '//npm.example.com/:_authToken=${TOKEN}\n@acme:registry=https://npm.example.com/\nvirtual-store-dir-max-length=80\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'publicHoistPattern:\n  - "*eslint*"\nvirtualStoreDirMaxLength: 100\n')
  writeFileSync(join(root, '.npmrc'), 'hoist-pattern[]=*\nhoist-pattern[]=!@types/*\nregistry=https://mirror.example.com\n')
  const s = loadPnpmSettings({ root, home, env: { TOKEN: 'secret' } })
  t.assert.equal(s.nodeLinker, 'isolated')
  t.assert.equal(s.virtualStoreDir, 'node_modules/.pnpm')
  t.assert.equal(s.virtualStoreDirMaxLength, 100, 'the workspace yaml overrides the user npmrc')
  t.assert.deepEqual(s.hoistPattern, ['*', '!@types/*'])
  t.assert.deepEqual(s.publicHoistPattern, ['*eslint*'])
  t.assert.equal(registryFor(s, 'ms'), 'https://mirror.example.com')
  t.assert.equal(registryFor(s, '@acme/x'), 'https://npm.example.com/')
  t.assert.deepEqual(authHeadersFor(s, 'https://npm.example.com/@acme/x/-/x-1.0.0.tgz'), { authorization: 'Bearer secret' })
  t.assert.equal(authHeadersFor(s, 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'), undefined)

  writeFileSync(join(root, '.npmrc'), 'shamefully-hoist=true\nnode-linker=hoisted\n')
  const s2 = loadPnpmSettings({ root, home: null })
  t.assert.deepEqual(s2.publicHoistPattern, ['*'])
  t.assert.equal(s2.nodeLinker, 'hoisted')
  writeFileSync(join(root, '.npmrc'), 'hoist=false\n')
  t.assert.deepEqual(loadPnpmSettings({ root, home: null }).hoistPattern, [])
  writeFileSync(join(root, '.npmrc'), 'lockfile-include-tarball-url=true\n')
  t.assert.equal(loadPnpmSettings({ root, home: null }).lockfileIncludeTarballUrl, true)
  writeFileSync(join(root, '.npmrc'), '')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'lockfileIncludeTarballUrl: true\n')
  t.assert.equal(loadPnpmSettings({ root, home: null }).lockfileIncludeTarballUrl, true)
  const defaults = loadPnpmSettings({ root: join(tmp, 'nowhere'), home: null })
  t.assert.deepEqual(defaults.publicHoistPattern, [])
  t.assert.deepEqual(defaults.hoistPattern, ['*'])
  t.assert.equal(defaults.lockfileIncludeTarballUrl, false)
  t.assert.deepEqual([...parseNpmrc('a=1\n; c\n# d\nb[]=x\nb[]=y\nq="quoted"\n')], [['a', '1'], ['b', ['x', 'y']], ['q', 'quoted']])
}))

test('createHoistMatcher matches pnpm-style glob lists with negations', (t) => {
  const m = createHoistMatcher(['*', '!@types/*'])
  t.assert.equal(m('ms'), true)
  t.assert.equal(m('@babel/core'), true)
  t.assert.equal(m('@types/node'), false)
  const eslint = createHoistMatcher(['*eslint*', '*prettier*'])
  t.assert.equal(eslint('eslint-visitor-keys'), true)
  t.assert.equal(eslint('@typescript-eslint/types'), true)
  t.assert.equal(eslint('ms'), false)
  t.assert.equal(createHoistMatcher([])('ms'), false)
})

// --- the layout ---

const SYNTHETIC_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      debug:
        specifier: 4.3.6
        version: 4.3.6
      ms-alias:
        specifier: npm:ms@2.0.0
        version: ms@2.0.0
    devDependencies:
      '@scope/tool':
        specifier: 1.0.0
        version: 1.0.0(debug@4.3.6)

  packages/app:
    dependencies:
      express-like:
        specifier: 1.0.0
        version: 1.0.0
      root-pkg:
        specifier: workspace:*
        version: link:../..
    optionalDependencies:
      native-other-os:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@scope/tool@1.0.0':
    resolution: {integrity: sha512-tool}
    peerDependencies:
      debug: '*'

  debug@4.3.6:
    resolution: {integrity: sha512-debug}

  express-like@1.0.0:
    resolution: {integrity: sha512-express}

  ms@2.0.0:
    resolution: {integrity: sha512-ms200}

  ms@2.1.2:
    resolution: {integrity: sha512-ms212}

  native-other-os@1.0.0:
    resolution: {integrity: sha512-native}
    os: [nonexistent-os]
    cpu: [x64, arm64]

  native-dep@1.0.0:
    resolution: {integrity: sha512-nativedep}

snapshots:

  '@scope/tool@1.0.0(debug@4.3.6)':
    dependencies:
      debug: 4.3.6

  debug@4.3.6:
    dependencies:
      ms: 2.1.2

  express-like@1.0.0:
    dependencies:
      ms: 2.0.0

  ms@2.0.0: {}

  ms@2.1.2: {}

  native-other-os@1.0.0:
    dependencies:
      native-dep: 1.0.0
    optional: true

  native-dep@1.0.0:
    optional: true
`

const syntheticFiles = (key) => new Map([
  ['package.json', { content: Buffer.from(JSON.stringify({ name: parseDepPath(key).name, version: parseDepPath(key).version })), mode: 0o644 }],
  ['index.js', { content: Buffer.from(`// ${key}\n`), mode: 0o644 }],
])

test('computeSkipped drops optional packages this platform cannot install, and only those', (t) => {
  const lock = parsePnpmLockfile(SYNTHETIC_LOCKFILE)
  const platform = { os: 'linux', cpu: 'x64', libc: 'glibc', node: '24.0.0' }
  t.assert.deepEqual([...computeSkipped(lock, platform)].toSorted(), ['native-dep@1.0.0', 'native-other-os@1.0.0'])
  t.assert.equal(packageIsInstallable({ os: ['!linux'] }, platform), false)
  t.assert.equal(packageIsInstallable({ os: ['darwin', 'linux'], cpu: ['x64'] }, platform), true)
  t.assert.equal(packageIsInstallable({ libc: ['musl'] }, platform), false)
  t.assert.equal(packageIsInstallable({ engines: { node: '>=99' } }, platform, { checkEngines: true }), false)
  t.assert.equal(packageIsInstallable({ engines: { node: '>=99' } }, platform), true, 'engines gate optional packages only')
  // Everything installs on the platform the optional package names.
  t.assert.equal(computeSkipped(lock, { ...platform, os: 'nonexistent-os' }).size, 0)
})

test('planTarballs lists one fetch per package a non-skipped snapshot needs, with registry URLs and auth', (t) => {
  const lock = parsePnpmLockfile(SYNTHETIC_LOCKFILE)
  const settings = loadPnpmSettings({ root: '/nonexistent', home: null })
  settings.scopedRegistries.set('@scope', 'https://npm.example.com/')
  settings.auth.set('//npm.example.com/', { _authToken: 't' })
  const skipped = new Set(['native-dep@1.0.0', 'native-other-os@1.0.0'])
  const plan = planTarballs(lock, { skipped, settings, root: '/proj' })
  t.assert.deepEqual(plan.map((p) => p.key).toSorted(), ['@scope/tool@1.0.0', 'debug@4.3.6', 'express-like@1.0.0', 'ms@2.0.0', 'ms@2.1.2'])
  const tool = plan.find((p) => p.key === '@scope/tool@1.0.0')
  t.assert.equal(tool.url, 'https://npm.example.com/@scope/tool/-/tool-1.0.0.tgz')
  t.assert.deepEqual(tool.headers, { authorization: 'Bearer t' })
  t.assert.equal(tool.integrity, 'sha512-tool')
  t.assert.equal(plan.find((p) => p.key === 'ms@2.0.0').url, 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz')
  t.assert.equal(plan.find((p) => p.key === 'ms@2.0.0').headers, undefined)
})

test('buildLayout lays out pnpm\'s isolated tree: store dirs, dependency links, importer links, link: deps and hoisting', (t) => {
  const lock = parsePnpmLockfile(SYNTHETIC_LOCKFILE)
  const settings = loadPnpmSettings({ root: '/nonexistent', home: null })
  const skipped = new Set(['native-dep@1.0.0', 'native-other-os@1.0.0'])
  const root = '/proj'
  const workspaceDirs = new Map([['app', '/proj/packages/app']])
  const { tree, hoisted } = buildLayout({ root, lockfile: lock, settings, skipped, filesFor: syntheticFiles, workspaceDirs })
  const store = '/proj/node_modules/.pnpm'
  const link = (p) => {
    const node = tree.get(p)
    t.assert.ok(node, `missing ${p}`)
    t.assert.equal(node.kind, 'symlink', `${p} is a ${node.kind}`)
    return node.target
  }
  // Store dirs named by depPathToFilename, holding the tarball's files.
  t.assert.equal(tree.get(`${store}/@scope+tool@1.0.0_debug@4.3.6/node_modules/@scope/tool/index.js`).content.toString(), '// @scope/tool@1.0.0\n')
  t.assert.equal(tree.get(`${store}/debug@4.3.6/node_modules/debug/index.js`).kind, 'file')
  // Dependency links beside each package, relative like pnpm's.
  t.assert.equal(link(`${store}/@scope+tool@1.0.0_debug@4.3.6/node_modules/debug`), '../../debug@4.3.6/node_modules/debug')
  t.assert.equal(link(`${store}/debug@4.3.6/node_modules/ms`), '../../ms@2.1.2/node_modules/ms')
  t.assert.equal(link(`${store}/express-like@1.0.0/node_modules/ms`), '../../ms@2.0.0/node_modules/ms')
  // Importers: root direct deps (dev included, aliases point at the real package), the app's deps, link: to the workspace root.
  t.assert.equal(link('/proj/node_modules/debug'), '.pnpm/debug@4.3.6/node_modules/debug')
  t.assert.equal(link('/proj/node_modules/ms-alias'), '.pnpm/ms@2.0.0/node_modules/ms')
  t.assert.equal(link('/proj/node_modules/@scope/tool'), '../.pnpm/@scope+tool@1.0.0_debug@4.3.6/node_modules/@scope/tool')
  t.assert.equal(link('/proj/packages/app/node_modules/express-like'), '../../../node_modules/.pnpm/express-like@1.0.0/node_modules/express-like')
  t.assert.equal(link('/proj/packages/app/node_modules/root-pkg'), '../../..')
  // A skipped optional dep is neither unpacked nor linked.
  t.assert.equal(tree.has('/proj/packages/app/node_modules/native-other-os'), false)
  t.assert.equal(tree.paths().some((p) => p.includes('native')), false)
  // Hoisting: the app's direct deps and the workspace package go to .pnpm/node_modules; root
  // direct-dep aliases never do; `ms` hoists to the version met first in breadth-first order.
  t.assert.equal(link(`${store}/node_modules/express-like`), '../express-like@1.0.0/node_modules/express-like')
  t.assert.equal(link(`${store}/node_modules/app`), '../../../packages/app')
  t.assert.equal(link(`${store}/node_modules/ms`), '../ms@2.1.2/node_modules/ms', 'debug (depth 0, first importer) brings ms@2.1.2 before express-like\'s ms@2.0.0')
  t.assert.equal(tree.has(`${store}/node_modules/debug`), false, 'a root direct dependency is not privately hoisted')
  t.assert.equal(tree.has(`${store}/node_modules/ms-alias`), false)
  t.assert.deepEqual([...hoisted.keys()].toSorted(), ['app', 'express-like', 'ms'])
  // Public hoisting via pattern lands in the root node_modules instead.
  const pub = { ...settings, publicHoistPattern: ['ms'] }
  const { tree: tree2 } = buildLayout({ root, lockfile: lock, settings: pub, skipped, filesFor: syntheticFiles, workspaceDirs })
  t.assert.equal(tree2.get('/proj/node_modules/ms').target, '.pnpm/ms@2.1.2/node_modules/ms')
  t.assert.equal(tree2.has(`${store}/node_modules/ms`), false)
  t.assert.deepEqual([...computeHoisted(lock, { skipped, settings: { ...settings, hoistPattern: [] }, workspaceDirs }).keys()], [])
})

test('planTarballs asserts recorded tarball URLs (lockfileIncludeTarballUrl) and requires them when the setting is on', (t) => {
  const settings = loadPnpmSettings({ root: '/nonexistent', home: null })
  const pkg = { name: 'ms', version: '2.1.3' }
  // The canonical registry layout on the configured registry passes; a registry with its own
  // download layout passes when the path names the package and version.
  assertTarballUrl('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', pkg, 'ms@2.1.3', settings)
  const scoped = { ...settings, scopedRegistries: new Map([['@acme', 'https://npm.pkg.github.com/']]) }
  assertTarballUrl('https://npm.pkg.github.com/@acme/x/-/x-1.0.0.tgz', { name: '@acme/x', version: '1.0.0' }, '@acme/x@1.0.0', scoped)
  assertTarballUrl('https://npm.pkg.github.com/download/@acme/x/1.0.0/abcdef', { name: '@acme/x', version: '1.0.0' }, '@acme/x@1.0.0', scoped)
  // Everything else fails closed.
  t.assert.throws(() => assertTarballUrl('https://evil.example/ms/-/ms-2.1.3.tgz', pkg, 'ms@2.1.3', settings), /tarball URL outside its registry/u)
  t.assert.throws(() => assertTarballUrl('http://registry.npmjs.org/ms/-/ms-2.1.3.tgz', pkg, 'ms@2.1.3', settings), /outside its registry/u)
  t.assert.throws(() => assertTarballUrl('https://registry.npmjs.org/ms/-/ms-2.1.2.tgz', pkg, 'ms@2.1.3', settings), /does not name ms@2\.1\.3/u)
  t.assert.throws(() => assertTarballUrl('https://registry.npmjs.org/lodash/-/lodash-2.1.3.tgz', pkg, 'ms@2.1.3', settings), /does not name ms@2\.1\.3/u)
  t.assert.throws(() => assertTarballUrl('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', { name: '@acme/x', version: '1.0.0' }, '@acme/x@1.0.0', scoped), /outside its registry/u)
  t.assert.throws(() => assertTarballUrl('ftp://registry.npmjs.org/ms/-/ms-2.1.3.tgz', pkg, 'ms@2.1.3', settings), /unsupported scheme/u)
  t.assert.throws(() => assertTarballUrl('ms/-/ms-2.1.3.tgz', pkg, 'ms@2.1.3', settings), /invalid tarball URL/u)

  const base = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\npackages:\n  ms@2.1.3:\n    resolution: RESOLUTION\nsnapshots:\n  ms@2.1.3: {}\n"
  const plan = (resolution, s = settings) => planTarballs(parsePnpmLockfile(base.replace('RESOLUTION', resolution)), { skipped: new Set(), settings: s, root: '/p' })
  // Recorded and vetted: used as-is, flagged as recorded.
  const recorded = plan('{integrity: sha512-x, tarball: https://registry.npmjs.org/ms/-/ms-2.1.3.tgz}')
  t.assert.equal(recorded[0].url, 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz')
  t.assert.equal(recorded[0].recorded, true)
  // None recorded: derived from the registry layout -- unless the setting promises one.
  const derived = plan('{integrity: sha512-x}')
  t.assert.equal(derived[0].url, 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz')
  t.assert.equal(derived[0].recorded, false)
  t.assert.throws(() => plan('{integrity: sha512-x}', { ...settings, lockfileIncludeTarballUrl: true }), /lockfileIncludeTarballUrl is enabled but 'ms@2\.1\.3' records no tarball URL/u)
  t.assert.throws(() => plan('{integrity: sha512-x, tarball: https://mirror.example/ms/-/ms-2.1.3.tgz}'), /outside its registry/u)
  // A mirror the settings designate is fine.
  t.assert.equal(plan('{integrity: sha512-x, tarball: https://mirror.example/npm/ms/-/ms-2.1.3.tgz}', { ...settings, registry: 'https://mirror.example/npm' })[0].recorded, true)
})

test('planTarballs refuses git, directory and patched dependencies rather than guessing their bytes', (t) => {
  // PKGVERSION keys `packages`, SNAPVERSION the snapshot (they differ only by a patch hash suffix).
  const base = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      foo:\n        specifier: x\n        version: SNAPVERSION\npackages:\n  'foo@PKGVERSION':\n    resolution: RESOLUTION\n    name: foo\n    version: 1.0.0\nsnapshots:\n  'foo@SNAPVERSION': {}\n"
  const settings = loadPnpmSettings({ root: '/nonexistent', home: null })
  const make = (version, resolution, snapVersion = version) => parsePnpmLockfile(base.replaceAll('PKGVERSION', version).replaceAll('SNAPVERSION', snapVersion).replace('RESOLUTION', resolution))
  t.assert.throws(() => planTarballs(make('https://codeload.github.com/x/y/tar.gz/abc', '{type: git, repo: https://github.com/x/y, commit: abc}'), { skipped: new Set(), settings, root: '/p' }), /git dependencies/u)
  t.assert.throws(() => planTarballs(make('file:../foo', '{type: directory, directory: ../foo}'), { skipped: new Set(), settings, root: '/p' }), /directory dependencies/u)
  t.assert.throws(() => planTarballs(make('1.0.0', '{integrity: sha512-x}', '1.0.0(patch_hash=abc)'), { skipped: new Set(), settings, root: '/p' }), /patched dependency/u)
  // A local tarball is read from disk (relative to the lockfile dir) and verified like any other.
  const local = planTarballs(make('file:../foo.tgz', '{integrity: sha512-x, tarball: file:../foo.tgz}'), { skipped: new Set(), settings, root: '/p' })
  t.assert.equal(local[0].local, '/foo.tgz')
})

// --- the disk host stays Node's own resolver ---

test('the disk host resolves exactly like require.resolve, including through symlinks', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'real'))
  writeFileSync(join(tmp, 'real', 'z.js'), '')
  symlinkSync(join(tmp, 'real'), join(tmp, 'link'))
  writeFileSync(join(tmp, 'main.cjs'), '')
  t.assert.equal(diskHost.resolve(join(tmp, 'main.cjs'), './link/z', new Set(['require'])), join(tmp, 'real', 'z.js'))
  t.assert.equal(createNodeResolver(diskHost).resolve(join(tmp, 'main.cjs'), './link/z', new Set(['require'])), join(tmp, 'real', 'z.js'))
}))
