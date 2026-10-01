import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { Vfs, buildVfsBundle, loadNodeModules } from '../stasis/src/vfs-bundle.js'

// @exodus/stasis/vfs-bundle with pnpm, over a project held in a Vfs, which @preventive/deptree reads the
// lockfile, the package.json of every project, the workspace's settings files and the patches and
// local directories they name from, for the pnpm to reproduce. Every lockfile here locks no registry
// package, so nothing is fetched.

const load = (options) => loadNodeModules({ packageManager: 'pnpm', ...options })
const build = (options) => buildVfsBundle({ packageManager: 'pnpm', ...options })

const write = (vfs, files) => {
  for (const [rel, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${rel}`), { recursive: true })
    vfs.writeFile(`/${rel}`, typeof text === 'string' ? text : `${JSON.stringify(text)}\n`)
  }
  return vfs
}
const project = (files) => write(new Vfs(), files)

const lockfile = (...importers) => ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', ...importers.map((id) => `  ${id}: {}`), ''].join('\n')

const overrideLockfile = (spec, version) => ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'overrides:', `  foo: ${spec}`, '', 'importers:', '', '  .:', '    dependencies:', '      foo:', `        specifier: ${version}`, `        version: ${version}`, ''].join('\n')
const FILE_OVERRIDE = `${overrideLockfile('file:./vendor/foo', 'file:vendor/foo')}\npackages:\n\n  foo@file:vendor/foo:\n    resolution: {directory: vendor/foo, type: directory}\n\nsnapshots:\n\n  foo@file:vendor/foo: {}\n`

test('pnpm: lays out, into a Vfs of its own, the lockfile of cwd or the nearest parent, as the pnpm packageManager pins, pnpm 10 without one', async (t) => {
  const files = { 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.'), 'src/deep/a.js': '' }
  const vfs = project(files)
  const tree = await load({ vfs, cwd: '/src/deep' })
  t.assert.equal(tree.root, '/')
  t.assert.notEqual(tree.vfs, vfs)
  t.assert.equal(tree.vfs.isDirectory('/node_modules/.pnpm'), true)
  t.assert.equal(vfs.isDirectory('/node_modules'), false, 'the project\'s Vfs is only read')
  t.assert.equal(tree.host.stat('/src/deep/a.js').isFile(), true)
  t.assert.equal(tree.host.stat('/node_modules/.pnpm').isDirectory(), true)
  t.assert.equal((await load({ vfs })).stats.projects, 1, 'so it can be laid out from again')
  t.assert.equal(tree.packageManagerVersion, '10.33.4')
  t.assert.deepEqual({ projects: tree.stats.projects, snapshots: tree.stats.snapshots, tarballs: tree.stats.tarballs }, { projects: 1, snapshots: 0, tarballs: 0 })

  files['package.json'] = { name: 'p', version: '1.0.0', packageManager: 'pnpm@11.28.2+sha512.abc' }
  t.assert.equal((await load({ vfs: project(files) })).packageManagerVersion, '11.28.2')
  t.assert.equal((await load({ vfs: project(files), packageManagerVersion: '11.28.2' })).packageManagerVersion, '11.28.2')
  // A pnpm other than the one it pins is what deptree refuses, as pnpm would switch to that one.
  await t.assert.rejects(load({ vfs: project(files), packageManagerVersion: '10.33.4' }), /packageManager: the project is installed by pnpm 11\.28\.2/u)
  files['package.json'] = { name: 'p', version: '1.0.0', packageManager: 'pnpm@9.15.0' }
  await t.assert.rejects(load({ vfs: project(files) }), /host\.pnpm: pnpm "9\.15\.0" is not supported: only pnpm 10, 11 and 12 are/u)
  // pnpm 12 from 12.8.1 on, the one installed where the project pins none.
  files['package.json'] = { name: 'p', version: '1.0.0' }
  t.assert.equal((await load({ vfs: project(files), packageManagerVersion: '12.8.1' })).packageManagerVersion, '12.8.1')
  await t.assert.rejects(load({ vfs: project(files), packageManagerVersion: '12.0.0' }), /host\.pnpm: pnpm "12\.0\.0" is not supported: pnpm 12 is from 12\.8\.1 on/u)
})

test('pnpm: reads every project pnpm finds and every one the lockfile has, and the workspace settings', async (t) => {
  const files = { 'package.json': { name: 'root', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.', 'pkg'), 'pkg/package.json': { name: 'pkg', version: '1.0.0' } }
  // Without pnpm-workspace.yaml's packages, pkg is no project pnpm would install.
  await t.assert.rejects(load({ vfs: project(files) }), /importers\["pkg"\]: pnpm-workspace\.yaml's packages are not set/u)
  files['pnpm-workspace.yaml'] = 'packages:\n  - pkg\n  - new\n'
  t.assert.equal((await load({ vfs: project(files) })).stats.projects, 2)
  // A project the lockfile does not have yet: with no dependencies pnpm installs it, with any the
  // lockfile is not up to date.
  t.assert.equal((await load({ vfs: project({ ...files, 'new/package.json': { name: 'new', version: '1.0.0' } }) })).stats.projects, 3)
  await t.assert.rejects(load({ vfs: project({ ...files, 'new/package.json': { name: 'new', version: '1.0.0', dependencies: { pkg: 'workspace:*' } } }) }), /manifests\["new"\]: the lockfile is not up to date with this package\.json/u)
  const { 'pkg/package.json': _, ...withoutPkg } = files
  await t.assert.rejects(load({ vfs: project(withoutPkg) }), /importers\["pkg"\]: the package\.json of this project is not given/u)
  await t.assert.rejects(load({ vfs: project({ ...files, '.npmrc': 'node-linker=hoisted\n' }) }), /\.npmrc:1: node-linker: "hoisted" is not supported/u)
  // cwd may be in any project pnpm finds, or below a package.json that is only a `type` marker.
  t.assert.equal((await load({ vfs: project({ ...files, 'new/package.json': { name: 'new', version: '1.0.0' } }), cwd: '/new' })).stats.projects, 3)
  t.assert.equal((await load({ vfs: project({ ...files, 'src/package.json': { type: 'module' } }), cwd: '/src' })).stats.projects, 2)
  // A project pnpm finds through a link would have its node_modules laid out where the link leads.
  const linked = project(files)
  write(linked, { 'elsewhere/new/package.json': { name: 'new', version: '1.0.0' } })
  linked.symlink('elsewhere/new', '/new')
  await t.assert.rejects(load({ vfs: linked }), /pnpm finds a project through this link/u)
})

test('pnpm: hands deptree the patch files the settings name', async (t) => {
  const files = { 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.'), 'pnpm-workspace.yaml': 'patchedDependencies:\n  ms@2.1.3: patches/ms.patch\n' }
  // Unreadable, it is not given, and deptree says so; read, it is held to the lockfile, which names none.
  await t.assert.rejects(load({ vfs: project(files) }), /patchedDependencies\["ms@2\.1\.3"\]: the patch "patches\/ms\.patch" is not given/u)
  await t.assert.rejects(load({ vfs: project({ ...files, 'patches/ms.patch': 'diff --git a/index.js b/index.js\n' }) }), /patchedDependencies: the patches differ/u)
  // With pnpm 10, the root package.json's pnpm.patchedDependencies replaces the workspace's, whose
  // patch is then no setting's; pnpm 11 reads the workspace's alone.
  const both = { ...files, 'package.json': { name: 'p', version: '1.0.0', pnpm: { patchedDependencies: { 'ms@2.1.3': 'patches/own.patch' } } }, 'patches/ms.patch': 'diff --git a/a b/a\n', 'patches/own.patch': 'diff --git a/b b/b\n' }
  await t.assert.rejects(load({ vfs: project(both) }), /the patches differ: .* patches\/own\.patch" in the settings/u)
  const hash = createHash('sha256').update(both['patches/ms.patch']).digest('hex')
  await t.assert.rejects(load({ vfs: project(both), packageManagerVersion: '11.28.2' }), new RegExp(`the patches differ: .* "${hash}" in the settings`, 'u'))
})

test('pnpm: refuses what is no lockfile for the project, naming the file', async (t) => {
  await t.assert.rejects(load({ vfs: project({ 'package.json': { name: 'p', version: '1.0.0' } }) }), /^Error: no pnpm-lock\.yaml found in \/ or any parent directory/u)
  const deeper = await load({ vfs: project({ 'p/package.json': { name: 'p', version: '1.0.0' }, 'p/pnpm-lock.yaml': lockfile('.') }), cwd: '/p' })
  t.assert.equal(deeper.root, '/p', 'the lockfile need not be at the root of the Vfs')
  t.assert.equal(deeper.host.stat('/p/node_modules/.pnpm').isDirectory(), true)
  await t.assert.rejects(load({ vfs: project({ 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n" }) }), (err) => err.message.startsWith('/pnpm-lock.yaml: lockfileVersion: unsupported version') && err.cause?.name === 'LockfileError')
  // pnpm 11's env document, with nothing installed yet.
  const env = ['---', "lockfileVersion: '9.0'", 'importers:', '  .:', '    configDependencies: {}', '---', ''].join('\n')
  await t.assert.rejects(load({ vfs: project({ 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': env }) }), (err) => err.message === "/pnpm-lock.yaml holds pnpm's env document alone and no lockfile for the project; run `pnpm install` first")
  // The project cwd is in has to be one the lockfile installs.
  const nested = project({ 'package.json': { name: 'outer', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.'), 'nested/package.json': { name: 'nested', version: '1.0.0' }, 'nested/src/a.js': '' })
  await t.assert.rejects(load({ vfs: nested, cwd: '/nested/src' }), (err) => err.message === "/pnpm-lock.yaml does not install /nested: it is none of the lockfile's projects")
  await t.assert.rejects(load({ vfs: new Map() }), /^TypeError: loadNodeModules: vfs must be a @preventive\/vfs Vfs holding the project/u)
})

test('pnpm: links a directory a `link:` override names, and installs one a `file:` override names', async (t) => {
  const link = { 'package.json': { name: 'p', version: '1.0.0', dependencies: { foo: '^1.0.0' }, pnpm: { overrides: { foo: 'link:./vendor/foo' } } }, 'pnpm-lock.yaml': overrideLockfile('link:./vendor/foo', 'link:vendor/foo') }
  await t.assert.rejects(load({ vfs: project(link) }), /overrides\["foo"\]: "vendor\/foo" holds no package\.json in the project given/u)
  const foo = { 'vendor/foo/package.json': { name: 'foo', version: '1.0.0', main: 'index.js' }, 'vendor/foo/index.js': 'module.exports = 1\n', 'vendor/foo/node_modules/x/i.js': '' }
  t.assert.equal((await load({ vfs: project({ ...link, ...foo }) })).vfs.readlink('/node_modules/foo'), '../vendor/foo')
  const file = { ...link, ...foo, 'package.json': { ...link['package.json'], pnpm: { overrides: { foo: 'file:./vendor/foo' } } }, 'pnpm-lock.yaml': FILE_OVERRIDE }
  const { vfs } = await load({ vfs: project(file) })
  t.assert.deepEqual(vfs.readdir('/node_modules/.pnpm/foo@file+vendor+foo/node_modules/foo'), ['index.js', 'package.json'], 'its node_modules left out, as pnpm leaves it out')
  t.assert.deepEqual(vfs.readdir('/'), ['node_modules'], 'the tree alone')
})

test('buildVfsBundle checks its entries first, reads no EXODUS_STASIS_* setting and keeps no State', async (t) => {
  const bogus = `sha512-${'A'.repeat(86)}==`
  const files = {
    'package.json': { name: 'p', version: '1.0.0', dependencies: { ms: '2.1.3' } },
    'pnpm-lock.yaml': ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', '  .:', '    dependencies:', '      ms:', '        specifier: 2.1.3', '        version: 2.1.3', '', 'packages:', '', '  ms@2.1.3:', `    resolution: {integrity: ${bogus}}`, '', 'snapshots:', '', '  ms@2.1.3: {}', ''].join('\n'),
  }
  // Refused before the tree, whose tarball would not match, is laid out.
  await t.assert.rejects(build({ vfs: project(files), entries: ['src/typo.js'] }), /^Error: entry not found: \/src\/typo\.js/u)
  await t.assert.rejects(build({ vfs: project({ ...files, 'src/a.js': '' }), entries: ['src/a.js'], repo: { github: 'ExodusOSS/stasis', commit: 'abc' } }), /invalid bundle repo\.commit: "abc"/u)

  // A bundleFile the project's stasis.config.json names is no write target of a build, which writes
  // nothing; and no `env` a caller passes brings EXODUS_STASIS_* back.
  const vfs = project({ 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.'), 'stasis.config.json': { bundleFile: 'out.br' }, 'src/a.js': 'module.exports = 1\n', 'src/b.js': 'module.exports = 2\n' })
  const states = globalThis[Symbol.for('@exodus/stasis-core/states')]?.size ?? 0
  const env = process.env.EXODUS_STASIS_BUNDLE
  process.env.EXODUS_STASIS_BUNDLE = 'add'
  try {
    t.assert.deepEqual([...(await build({ vfs, entries: ['src/a.js'] })).bundle.entries], ['src/a.js'])
    t.assert.deepEqual([...(await build({ vfs, entries: ['src/b.js'] })).bundle.entries], ['src/b.js'], 'one project Vfs, built from twice')
    t.assert.deepEqual([...(await build({ vfs, entries: ['src/a.js'], env: undefined })).bundle.entries], ['src/a.js'])
    t.assert.deepEqual([...(await build({ vfs, entries: ['src/a.js'], env: process.env })).bundle.entries], ['src/a.js'])
  } finally {
    if (env === undefined) delete process.env.EXODUS_STASIS_BUNDLE
    else process.env.EXODUS_STASIS_BUNDLE = env
  }
  t.assert.equal(globalThis[Symbol.for('@exodus/stasis-core/states')]?.size ?? 0, states)
})

test('buildVfsBundle builds from a cwd named through a link, and for a project under a node_modules directory', async (t) => {
  const files = { 'p/package.json': { name: 'p', version: '1.0.0' }, 'p/pnpm-lock.yaml': lockfile('.'), 'p/src/a.js': 'module.exports = 1\n' }
  const aliased = project(files)
  aliased.symlink('p', '/alias')
  t.assert.deepEqual([...(await build({ vfs: aliased, cwd: '/alias', entries: ['src/a.js'] })).bundle.entries], ['src/a.js'])

  const vendored = project(Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel.replace(/^p\//u, 'vendor/node_modules/app/'), text])))
  write(vendored, { 'vendor/node_modules/other/index.js': '' })
  t.assert.deepEqual([...(await build({ vfs: vendored, cwd: '/vendor/node_modules/app', entries: ['src/a.js'] })).bundle.entries], ['src/a.js'])
  const { host } = await load({ vfs: vendored, cwd: '/vendor/node_modules/app' })
  t.assert.equal(host.stat('/vendor/node_modules/app/src/a.js').isFile(), true)
  t.assert.equal(host.stat('/vendor/node_modules/other/index.js'), null, 'what else that node_modules holds is above the root')
  t.assert.deepEqual(host.readdir('/vendor/node_modules').map((d) => d.name), ['app'])
})

test('buildVfsBundle puts `repo` on the Bundle, never on its lockfile, over what it detects', async (t) => {
  const vfs = project({ 'package.json': { name: 'p', version: '1.0.0' }, 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
  const repo = { commit: 'a'.repeat(40), directory: 'packages/p', github: 'ExodusOSS/stasis' }
  const built = await build({ vfs, entries: ['src/a.js'], repo })
  t.assert.deepEqual(built.bundle.repo, { github: 'ExodusOSS/stasis', directory: 'packages/p', commit: 'a'.repeat(40) })
  t.assert.deepEqual(JSON.parse(built.bundle.serialize()).repo, built.bundle.repo)
  t.assert.doesNotMatch(built.lockfile.serialize(), /ExodusOSS/u)
  t.assert.deepEqual(built.bundle.reason, { bundle: ['src/a.js'] })
  const resolved = await build({ vfs, entries: ['src/a.js'], mainFields: ['main'], repo })
  t.assert.deepEqual(resolved.bundle.repo, built.bundle.repo, 'with mainFields too')
  t.assert.equal((await build({ vfs, entries: ['src/a.js'] })).bundle.repo, undefined)

  // Detected in the Vfs, as `stasis bundle` detects it on disk, under what is given.
  const declared = project({ 'package.json': { name: 'p', version: '1.0.0', repository: 'github:ExodusOSS/stasis' }, 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
  t.assert.deepEqual((await build({ vfs: declared, entries: ['src/a.js'] })).bundle.repo, { github: 'ExodusOSS/stasis', directory: '' })
  t.assert.deepEqual((await build({ vfs: declared, entries: ['src/a.js'], mainFields: ['main'] })).bundle.repo, { github: 'ExodusOSS/stasis', directory: '' })
  t.assert.deepEqual((await build({ vfs: declared, entries: ['src/a.js'], repo })).bundle.repo, built.bundle.repo)
})
