import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { Vfs, buildGitHubBundle, suggestedEntries } from '../stasis/src/vfs-bundle.js'
import { HEAD, fakeClient, json, lockfile } from './vfs-bundle-github.helper.js'

// @exodus/stasis/vfs-bundle's buildGitHubBundle over a fake @preventive/upstream/github.js client
// serving a repo held in memory: nothing is fetched, and every lockfile here locks no registry package.

const GITHUB = 'ExodusOSS/example'
const SHA = 'a'.repeat(40)
const here = dirname(fileURLToPath(import.meta.url))

const build = (options) => buildGitHubBundle({ github: GITHUB, sha: SHA, packageManager: 'pnpm', ...options })
const methods = (client) => client.calls.map(([method]) => method)

test('buildGitHubBundle builds a repo at a commit and stamps `repo` itself', async (t) => {
  const client = fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
  const { bundle, lockfile: lock } = await build({ client, entries: ['src/a.js'] })
  t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js'])
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: SHA })
  t.assert.doesNotMatch(lock.serialize(), /ExodusOSS/u)
  t.assert.deepEqual(client.calls, [['getRepoTarball', GITHUB, SHA]])
})

test("buildGitHubBundle builds the default branch's head without a commit", async (t) => {
  const client = fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
  const { bundle } = await build({ client, sha: undefined, entries: ['src/a.js'] })
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: HEAD })
  t.assert.deepEqual(client.calls, [['getRepoHead', GITHUB, undefined], ['getRepoTarball', GITHUB, HEAD]])
})

// A package whose package.json names entry points in every way it can, and some it can't be built from.
const namingEntries = {
  'package.json': json({
    name: 'p',
    version: '1.0.0',
    main: 'lib/index.js',
    exports: {
      '.': { import: './esm/index.mjs', require: './lib/index.js' },
      './util': { custom: './lib/custom.js', default: './lib/util.js' },
      './feature/*': './lib/feature/*.js',
      './dir/': './lib/dir/',
      './data': './data.json',
      './gone': './lib/gone.js',
      './package.json': './package.json',
    },
    bin: { p: 'bin/p.js', q: 'bin/q' },
  }),
  'pnpm-lock.yaml': lockfile('.'),
  'lib/index.js': 'module.exports = 1\n',
  'esm/index.mjs': 'export default 1\n',
  'lib/util.js': 'module.exports = 2\n',
  'lib/custom.js': 'module.exports = 3\n',
  'lib/feature/x.js': '',
  'lib/dir/y.js': '',
  'data.json': '{}\n',
  'bin/p.js': "require('../lib/index.js')\n",
  'bin/q': '#!/bin/sh\n',
}

test('buildGitHubBundle takes the JS entry points the package.json names without entries', async (t) => {
  const { bundle } = await build({ client: fakeClient(namingEntries) })
  t.assert.deepEqual([...bundle.entries], ['lib/index.js', 'esm/index.mjs', 'lib/util.js', 'bin/p.js'], 'main, each exports subpath for require() and import, and each bin')
  const { bundle: custom } = await build({ client: fakeClient(namingEntries), conditions: ['custom'] })
  t.assert.deepEqual([...custom.entries], ['lib/index.js', 'esm/index.mjs', 'lib/custom.js', 'bin/p.js'], 'as the conditions resolve them')
  const { bundle: index } = await build({ client: fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'index.js': '' }) })
  t.assert.deepEqual([...index.entries], ['index.js'], "index.js, as require('./') takes it")
})

test("buildGitHubBundle takes the entry points of the directory's package.json, and only there", async (t) => {
  const client = fakeClient({
    'package.json': json({ name: 'root', version: '1.0.0', private: true, main: 'root.js' }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': lockfile('.', 'packages/p'),
    'root.js': '',
    'shared.js': '',
    'packages/p/package.json': json({ name: 'p', version: '1.0.0', main: '../../shared.js', bin: { p: './cli.js' } }),
    'packages/p/cli.js': '',
  })
  const { bundle } = await build({ client, directory: 'packages/p' })
  t.assert.deepEqual([...bundle.entries], ['packages/p/cli.js'])
})

// A Vfs holding `files` as fakeClient serves them.
const vfsOf = (files) => {
  const vfs = new Vfs()
  for (const [path, value] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${path}`), { recursive: true })
    if (typeof value === 'string') vfs.writeFile(`/${path}`, value)
    else vfs.symlink(value.symlink, `/${path}`)
  }
  return vfs
}

test('suggestedEntries suggests the entries buildGitHubBundle takes without any, of a repo or a Vfs', async (t) => {
  const named = ['lib/index.js', 'esm/index.mjs', 'lib/util.js', 'bin/p.js']
  const client = fakeClient(namingEntries)
  t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, client }), named)
  t.assert.deepEqual(client.calls, [['getRepoTarball', GITHUB, SHA]])
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(namingEntries) }), named)
  const custom = ['lib/index.js', 'esm/index.mjs', 'lib/custom.js', 'bin/p.js']
  t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, client, conditions: ['custom'] }), custom)
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(namingEntries), conditions: ['custom'] }), custom)
  // At the default branch's head without a commit.
  const head = fakeClient(namingEntries)
  t.assert.deepEqual(await suggestedEntries({ github: GITHUB, client: head }), named)
  t.assert.deepEqual(head.calls, [['getRepoHead', GITHUB, undefined], ['getRepoTarball', GITHUB, HEAD]])
  // None without a package.json.
  t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, client: fakeClient({ 'a.js': '' }) }), [])
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf({ 'a.js': '' }) }), [])
})

// A React Native package: its own entry by each main field, with a platform's file, and `exports`
// by the RN and browser conditions, the browser one first.
const reactNative = {
  'package.json': json({
    name: 'lib',
    version: '1.0.0',
    'react-native': 'rn',
    browser: 'browser.js',
    main: 'main.js',
    exports: { '.': { browser: './exp-browser.js', 'react-native': './exp-rn.js', default: './exp.js' } },
  }),
  'pnpm-lock.yaml': lockfile('.'),
  'rn.ios.js': '',
  'rn.js': '',
  'browser.js': '',
  'main.js': '',
  'exp-browser.js': '',
  'exp-rn.js': '',
  'exp.js': '',
}

test('suggestedEntries resolves the entries as the build does with metro, platforms and mainFields', async (t) => {
  const cases = [
    [{}, ['main.js', 'exp.js']],
    [{ conditions: ['browser'] }, ['main.js', 'exp-browser.js']],
    [{ metro: true, platforms: ['ios', 'android'] }, ['rn.ios.js', 'rn.js', 'exp-rn.js']],
    [{ metro: true, platforms: ['web'] }, ['rn.js', 'exp-browser.js']],
    [{ mainFields: ['browser', 'main'] }, ['browser.js', 'exp.js']],
  ]
  await Promise.all(cases.map(async ([options, expected]) => {
    const what = JSON.stringify(options)
    t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, client: fakeClient(reactNative), ...options }), expected, what)
    t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(reactNative), ...options }), expected, `${what} in a Vfs`)
    const { bundle } = await build({ client: fakeClient(reactNative), ...options })
    t.assert.deepEqual([...bundle.entries], expected, `${what}: buildGitHubBundle's default`)
  }))
  // An index by platform, as an RN app's.
  const app = { 'package.json': json({ name: 'app', version: '1.0.0' }), 'index.ios.js': '', 'index.android.js': '', 'index.js': '' }
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(app), metro: true, platforms: ['ios', 'android', 'web'] }), ['index.ios.js', 'index.android.js', 'index.js'])
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(app) }), ['index.js'])
  // Checked as the build checks them.
  await t.assert.rejects(suggestedEntries({ vfs: vfsOf(app), metro: true }), /^Error: suggestedEntries: --metro requires --platforms \(e\.g\. --platforms=ios,android\)$/u)
  await t.assert.rejects(suggestedEntries({ vfs: vfsOf(app), platforms: ['ios'] }), /^Error: suggestedEntries: --platforms is only valid with --metro$/u)
  await t.assert.rejects(suggestedEntries({ vfs: vfsOf(app), metro: true, platforms: ['ios'], conditions: ['x'] }), /^Error: suggestedEntries: --conditions can't be combined with --metro/u)
  await t.assert.rejects(suggestedEntries({ github: GITHUB, sha: SHA, client: fakeClient(app), metro: true, platforms: ['a/b'] }), /^Error: suggestedEntries: invalid platform 'a\/b'/u)
})

test('suggestedEntries maps what resolution misses to its TS source under typescript, as the build does', async (t) => {
  // Entry points named by their compiled outputs, of which only the TS sources are in the tree.
  const named = {
    'package.json': json({ name: 'ts', version: '1.0.0', main: 'lib/index.js', exports: { '.': './lib/index.js', './util': { import: './lib/util.mjs', default: './lib/util.js' } } }),
    'pnpm-lock.yaml': lockfile('.'),
    'lib/index.ts': 'export const x: number = 1\n',
    'lib/util.ts': 'export const y: number = 2\n',
    'lib/util.mts': 'export const z: number = 3\n',
  }
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(named) }), [])
  const mapped = ['lib/index.ts', 'lib/util.ts', 'lib/util.mts']
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(named), typescript: true }), mapped)
  t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, client: fakeClient(named), typescript: true }), mapped)
  const { bundle } = await build({ client: fakeClient(named), typescript: true })
  t.assert.deepEqual([...bundle.entries], mapped, "buildGitHubBundle's default")
  // An extensionless main, completed; a compiled file on disk wins over its source.
  const completed = { 'package.json': json({ name: 'c', version: '1.0.0', main: 'src/index' }), 'src/index.ts': '', 'src/index.d.ts': '' }
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(completed), typescript: true }), ['src/index.ts'])
  const both = { 'package.json': json({ name: 'b', version: '1.0.0', main: 'index.js' }), 'index.js': '', 'index.ts': '' }
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(both), typescript: true }), ['index.js'])
  // Through the field resolver, as under metro.
  const app = { 'package.json': json({ name: 'app', version: '1.0.0', main: 'lib/index.js' }), 'lib/index.ts': '' }
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(app), metro: true, platforms: ['ios'] }), [])
  t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(app), metro: true, platforms: ['ios'], typescript: true }), ['lib/index.ts'])
})

test("suggestedEntries downloads a directory alone where it stands alone, and names nothing out of it", async (t) => {
  const files = {
    'README.md': 'x\n',
    'apps/x.js': '',
    'apps/shared.js': '',
    // Its bin out of it would be its own x.js were the subtree's root taken for the filesystem's.
    'apps/p/package.json': json({ name: 'p', version: '1.0.0', bin: { x: '../x.js', p: 'index.js' } }),
    'apps/p/index.js': '',
    'apps/p/x.js': '',
    'apps/q/package.json': json({ name: 'q', version: '1.0.0', main: '../x.js', 'react-native': '../x.js' }),
    'apps/q/index.js': '',
    'apps/q/x.js': '',
    'apps/r/package.json': json({ name: 'r', version: '1.0.0', main: 'lib.js', bin: 'cli.js' }),
    'apps/r/lib.js': { symlink: '../shared.js' },
    'apps/r/cli.js': '',
    'pkg': { symlink: 'apps/p' },
  }
  const cases = [
    ['apps/p', ['index.js'], ['getRepoTreeId', 'getRepoTreeTarball']],
    ['apps/q', [], ['getRepoTreeId', 'getRepoTreeTarball']],
    // A symlink out of it: the whole repo, where it resolves out of the directory.
    ['apps/r', ['cli.js'], ['getRepoTreeId', 'getRepoTreeTarball', 'getRepoTarball']],
    // No directory in git: the whole repo, through the symlink.
    ['pkg', ['index.js'], ['getRepoTreeId', 'getRepoTarball']],
  ]
  await Promise.all(cases.map(async ([directory, expected, called]) => {
    const client = fakeClient(files)
    t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, directory, client }), expected, directory)
    t.assert.deepEqual(methods(client), called, directory)
    t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(files), cwd: directory }), expected, `${directory} in a Vfs`)
    // Through the main fields too.
    const metro = { metro: true, platforms: ['ios'] }
    t.assert.deepEqual(await suggestedEntries({ github: GITHUB, sha: SHA, directory, client: fakeClient(files), ...metro }), expected, `${directory} with metro`)
    t.assert.deepEqual(await suggestedEntries({ vfs: vfsOf(files), cwd: directory, ...metro }), expected, `${directory} in a Vfs with metro`)
  }))
})

test('suggestedEntries checks its arguments before anything is fetched', async (t) => {
  const client = fakeClient({})
  await t.assert.rejects(suggestedEntries({}), /^Error: suggestedEntries: a vfs or a github repo is required$/u)
  await t.assert.rejects(suggestedEntries({ vfs: new Vfs(), github: GITHUB }), /^Error: suggestedEntries: takes a vfs or a github repo, not both$/u)
  await t.assert.rejects(suggestedEntries({ vfs: {} }), /suggestedEntries/u)
  await t.assert.rejects(suggestedEntries({ github: GITHUB, sha: 'abc123', client }), /^Error: suggestedEntries: invalid commit: "abc123"$/u)
  await t.assert.rejects(suggestedEntries({ github: GITHUB, directory: '../up', client }), /^Error: suggestedEntries: invalid directory: "\.\.\/up"$/u)
  t.assert.deepEqual(client.calls, [])
})

test('buildGitHubBundle refuses to build without entries where no package.json names one', async (t) => {
  const cases = {
    'no package.json': {},
    'a package.json naming none': { 'package.json': json({ name: 'p', version: '1.0.0' }) },
    'a package.json naming no JS file': { 'package.json': json({ name: 'p', version: '1.0.0', main: 'data.json' }), 'data.json': '{}\n' },
  }
  await Promise.all(Object.entries(cases).map(async ([what, files]) => {
    const client = fakeClient({ 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': '', ...files })
    await t.assert.rejects(build({ client }), new RegExp(`^Error: buildGitHubBundle: ${GITHUB}@${SHA}: no entries given, and the repo root has no package\\.json naming a JS entry point there$`, 'u'), what)
  }))
  const client = fakeClient({ 'apps/p/pnpm-lock.yaml': lockfile('.'), 'apps/p/src/a.js': '' })
  await t.assert.rejects(build({ client, directory: 'apps/p' }), /: no entries given, and apps\/p has no package\.json naming a JS entry point there$/u)
})

test('buildGitHubBundle downloads a directory alone when its lockfile is there', async (t) => {
  const client = fakeClient({
    'README.md': 'x\n',
    'apps/p/package.json': json({ name: 'p', version: '1.0.0' }),
    'apps/p/pnpm-lock.yaml': lockfile('.'),
    'apps/p/src/a.js': 'module.exports = 1\n',
  })
  const { bundle } = await build({ client, directory: 'apps/p', entries: ['src/a.js'] })
  t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js'], 'built from the subtree alone')
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, directory: 'apps/p', commit: SHA })
  t.assert.deepEqual(client.calls.map(([method, , , path]) => (method === 'listRepoDir' ? `${method} ${path}` : method)), ['listRepoDir apps/p', 'listRepoDir apps', 'listRepoDir undefined', 'getRepoTreeId', 'getRepoTreeTarball'])
})

test('buildGitHubBundle builds a workspace member from the workspace, whatever lockfile it holds', async (t) => {
  const client = fakeClient({
    'package.json': json({ name: 'root', version: '1.0.0', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': lockfile('.', 'packages/p'),
    'packages/p/package.json': json({ name: 'p', version: '1.0.0' }),
    'packages/p/pnpm-lock.yaml': lockfile('.'),
    'packages/p/src/a.js': 'module.exports = 1\n',
  })
  const { bundle } = await build({ client, directory: 'packages/p', entries: ['src/a.js'] })
  t.assert.deepEqual([...bundle.sources.keys()], ['packages/p/src/a.js'])
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: SHA })
  t.assert.deepEqual(client.calls.map(([method]) => method), ['listRepoDir', 'listRepoDir', 'listRepoDir', 'getRepoTarball'])
})

test('buildGitHubBundle downloads the whole repo for a lockfile above the directory', async (t) => {
  const client = fakeClient({
    'package.json': json({ name: 'root', version: '1.0.0', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': lockfile('.', 'packages/p'),
    'packages/p/package.json': json({ name: 'p', version: '1.0.0' }),
    'packages/p/src/a.js': 'module.exports = 1\n',
  })
  const { bundle } = await build({ client, directory: 'packages/p', entries: ['src/a.js'] })
  t.assert.deepEqual([...bundle.sources.keys()], ['packages/p/src/a.js'])
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: SHA }, 'where the lockfile is, which the paths are relative to')
  t.assert.deepEqual(client.calls.map(([method]) => method), ['listRepoDir', 'getRepoTarball'])
})

test('buildGitHubBundle checks its arguments before anything is fetched', async (t) => {
  const client = fakeClient({})
  await t.assert.rejects(build({ client, sha: 'abc123', entries: ['a.js'] }), /invalid commit: "abc123"/u)
  await t.assert.rejects(build({ client, github: 'not a repo', entries: ['a.js'] }), /invalid github: "not a repo"/u)
  await t.assert.rejects(build({ client, directory: 'a b', entries: ['a.js'] }), /invalid directory: "a b"/u)
  await t.assert.rejects(build({ client, directory: '../up', entries: ['a.js'] }), /invalid directory: "\.\.\/up"/u)
  await t.assert.rejects(build({ client, github: undefined, entries: ['a.js'] }), /github is required/u)
  await t.assert.rejects(build({ client, packageManager: 'soldeer' }), /entries are required with soldeer/u)
  await t.assert.rejects(build({ client, packageManager: 'npm', entries: ['a.js'] }), /packageManager must be one of/u)
  await t.assert.rejects(build({ client, libc: 'bionic', entries: ['a.js'] }), /^TypeError: buildGitHubBundle: libc must be one of/u)
  await t.assert.rejects(build({ client, os: '', entries: ['a.js'] }), /^TypeError: buildGitHubBundle: os must be a non-empty string/u)
  await t.assert.rejects(build({ client, entries: ['a.sol'] }), /^Error: buildGitHubBundle: only JS bundles are built with pnpm/u)
  await t.assert.rejects(build({ client, entries: ['a.js'], metro: true, metroResolver: true, platforms: ['ios'] }), /^Error: buildGitHubBundle: metroResolver is not supported/u)
  await t.assert.rejects(build({ client, entries: [] }), /^Error: buildGitHubBundle: at least one entry file is required/u)
  await t.assert.rejects(build({ client, entries: ['a.js'], scope: 'node_modules', metro: true, platforms: ['ios'] }), /^Error: buildGitHubBundle: --scope is not supported with --mainFields or --metro/u)
  // Without entries, as for the JS ones suggested.
  await t.assert.rejects(build({ client, mappingFile: 'remappings.txt' }), /^Error: buildGitHubBundle: --mapping is only valid for \.sol bundles$/u)
  await t.assert.rejects(build({ client, metro: true, metroResolver: true, platforms: ['ios'] }), /^Error: buildGitHubBundle: metroResolver is not supported$/u)
  t.assert.deepEqual(client.calls, [])
})

test('buildGitHubBundle refuses a tarball entry no tree holds', async (t) => {
  const client = { getRepoTarball: async () => compress(pack([{ name: 'tree-id/', type: 'directory' }, { name: 'tree-id/fifo', type: 'fifo' }]), 'gzip') }
  await t.assert.rejects(build({ client, entries: ['a.js'] }), /unexpected fifo "fifo" in the tarball/u)
})

// A workspace whose package `apps/p` has a lockfile of its own, plus `extra` files.
const appWithLockfile = (extra = {}) => ({
  'apps/p/package.json': json({ name: 'p', version: '1.0.0' }),
  'apps/p/pnpm-lock.yaml': lockfile('.'),
  'apps/p/src/a.js': "module.exports = require('./b.js')\n",
  'apps/p/src/b.js': 'module.exports = 1\n',
  ...extra,
})

test('buildGitHubBundle falls back to the whole repo when the subtree does not stand alone', async (t) => {
  const cases = {
    'a symlink one level out of it': { 'apps/p/src/up.js': { symlink: '../../shared.js' }, 'apps/shared.js': '' },
    'a symlink further out of it': { 'apps/p/src/up.js': { symlink: '../../../shared.js' }, 'shared.js': '' },
    'its lockfile linking above it': { 'apps/p/pnpm-lock.yaml': `${lockfile('.')}# link:../shared\n` },
    'a tsconfig extending above it': { 'apps/p/tsconfig.json': json({ extends: '../../tsconfig.base.json' }), 'tsconfig.base.json': json({}) },
  }
  await Promise.all(Object.entries(cases).map(async ([what, extra]) => {
    const client = fakeClient(appWithLockfile(extra))
    const { bundle } = await build({ client, directory: 'apps/p', entries: ['src/a.js'] })
    t.assert.deepEqual(methods(client), ['listRepoDir', 'listRepoDir', 'listRepoDir', 'getRepoTreeId', 'getRepoTreeTarball', 'getRepoTarball'], what)
    t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js', 'src/b.js'], what)
    t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, directory: 'apps/p', commit: SHA }, what)
  }))
  // A tsconfig path within the subtree keeps it alone.
  const client = fakeClient(appWithLockfile({ 'apps/p/tsconfig.json': json({ extends: './tsconfig.base.json', include: ['./src'] }) }))
  await build({ client, directory: 'apps/p', entries: ['src/a.js'] })
  t.assert.deepEqual(methods(client), ['listRepoDir', 'listRepoDir', 'listRepoDir', 'getRepoTreeId', 'getRepoTreeTarball'])
})

test('buildGitHubBundle resolves a directory that is a symlink in the repo through the whole repo', async (t) => {
  const client = fakeClient({ ...appWithLockfile(), 'pkg': { symlink: 'apps/p' } })
  const { bundle } = await build({ client, directory: 'pkg', entries: ['src/a.js'] })
  t.assert.deepEqual(methods(client), ['listRepoDir', 'getRepoTarball'])
  t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js', 'src/b.js'])
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, directory: 'apps/p', commit: SHA }, 'the real directory, not the symlink')
})

test('buildGitHubBundle refuses a symlink out of the repo rather than resolving it inside', async (t) => {
  const files = { 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': '', 'up.js': { symlink: '../outside.js' } }
  await t.assert.rejects(build({ client: fakeClient(files), entries: ['src/a.js'] }), /symlink "up\.js" points outside the repo/u)
})

// A pnpm workspace as pnpm writes its lockfile: `packages/app` depends on its sibling `packages/p`
// through a `link:`, which the tree lays out as node_modules/p -> ../../p. The lockfile locks no
// registry package, so no tarball is fetched or read from a cache. Besides what the builds reach,
// it holds what `stasis bundle` would read off a checkout: a `.git` pointer, a tsconfig chain, and
// entries for every other language stasis bundles.
const workspaceRepo = {
  '.git': 'gitdir: ../elsewhere/.git\n',
  'package.json': json({ name: 'root', version: '1.0.0', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .: {}',
    '',
    '  packages/app:',
    '    dependencies:',
    '      p:',
    '        specifier: workspace:*',
    '        version: link:../p',
    '',
    '  packages/p: {}',
    '',
  ].join('\n'),
  'tsconfig.base.json': json({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['packages/p/*'] } } }),
  'packages/p/package.json': json({ name: 'p', version: '1.0.0', main: 'index.js' }),
  'packages/p/index.js': 'export const x = 1\n',
  'packages/p/util.ts': 'export const y: number = 2\n',
  'packages/p/other.js': 'module.exports = 3\n',
  'packages/app/package.json': json({ name: 'app', version: '1.0.0', dependencies: { p: 'workspace:*' } }),
  'packages/app/tsconfig.json': json({ extends: '../../tsconfig.base.json' }),
  'packages/app/src/entry.ts': "import { x } from 'p'\nimport { y } from '@lib/util.js'\nimport z from './lib.js'\nexport const sum: number = x + y + z\n",
  'packages/app/src/lib.js': { symlink: '../../p/other.js' },
  'packages/app/src/main.js': "const { x } = require('p')\nmodule.exports = x\n",
  'packages/app/src/a.sol': 'pragma solidity ^0.8.0;\n',
  'packages/app/src/a.rs': 'fn main() {}\n',
  'packages/app/src/a.php': '<?php\n',
  'packages/app/src/a.sh': 'echo hi\n',
}

// What the child builds from workspaceRepo: the State path (the Node resolver, tsc's mapping through
// the tsconfig chain, every bucket's package.json) and the field-resolver path, each of them
// reading the project and its tree through the Vfs host alone.
const workspaceBuilds = {
  typescript: { directory: 'packages/app', entries: ['src/entry.ts'], typescript: true, packageJSON: true },
  mainFields: { entries: ['packages/app/src/main.js'], mainFields: ['main'], packageJSON: true },
  defaults: { directory: 'packages/p' },
  metroDefaults: { directory: 'packages/p', metro: true, platforms: ['ios', 'android'] },
}
// Entries of every other language `stasis bundle` takes, and a directory (Solidity's), refused.
const otherLanguages = ['src/a.sol', 'src/a.rs', 'src/a.php', 'src/a.sh', 'src']

test('buildGitHubBundle reads nothing from disk: the repo, its tree and every file come from memory', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-github-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  // node:fs is wrapped before stasis is loaded, so every read through it is seen; a first round
  // loads every module the builds do (oxc-parser among them), so what the second reads is data.
  const script = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const read = new Set()
    const spy = (obj, name) => {
      const real = obj[name]
      obj[name] = Object.assign(function (p, ...rest) {
        read.add(String(p))
        return real.call(this, p, ...rest)
      }, real)
    }
    for (const name of ['accessSync', 'existsSync', 'lstatSync', 'openSync', 'opendirSync', 'readFileSync', 'readdirSync', 'readlinkSync', 'realpathSync', 'statSync']) spy(fs, name)
    for (const name of ['access', 'lstat', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'stat']) spy(fs.promises, name)
    syncBuiltinESMExports()
    // The watch sees a read: a control, so an empty result below means none, not a blind watch.
    fs.statSync(process.cwd())
    const watching = read.has(process.cwd())
    read.clear()
    const { buildGitHubBundle } = await import(${JSON.stringify(pathToFileURL(join(here, '..', 'stasis', 'src', 'vfs-bundle.js')).href)})
    const { fakeClient } = await import(${JSON.stringify(pathToFileURL(join(here, 'vfs-bundle-github.helper.js')).href)})
    const files = ${JSON.stringify(workspaceRepo)}
    const build = (options) => buildGitHubBundle({ github: ${JSON.stringify(GITHUB)}, sha: ${JSON.stringify(SHA)}, packageManager: 'pnpm', client: fakeClient(files), ...options })
    const round = async () => {
      const built = {}
      for (const [name, options] of Object.entries(${JSON.stringify(workspaceBuilds)})) {
        const { bundle } = await build(options)
        built[name] = { sources: [...bundle.sources.keys()], repo: { ...bundle.repo } }
      }
      const refused = {}
      for (const entry of ${JSON.stringify(otherLanguages)}) {
        refused[entry] = await build({ directory: 'packages/app', entries: [entry] }).then(() => null, (error) => error.message)
      }
      return { built, refused }
    }
    await round()
    read.clear()
    const results = await round()
    fs.writeFileSync(${JSON.stringify(join(tmp, 'out.json'))}, JSON.stringify({ ...results, watching, read: [...read] }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const [status] = await once(child, 'close')
  t.assert.equal(status, 0, `stderr: ${Buffer.concat(stderr).toString('utf8')}`)
  const { built, refused, watching, read } = JSON.parse(await readFile(join(tmp, 'out.json'), 'utf8'))
  t.assert.equal(watching, true, 'the watch on node:fs sees reads')
  t.assert.deepEqual(read, [], 'nothing on disk is read')
  t.assert.deepEqual(built.typescript.sources.toSorted(), ['packages/app/package.json', 'packages/app/src/entry.ts', 'packages/p/index.js', 'packages/p/other.js', 'packages/p/package.json', 'packages/p/util.ts'], 'the link, the symlink and tsc\'s mapping resolve in the Vfs')
  t.assert.deepEqual(built.typescript.repo, { github: GITHUB, root: true, commit: SHA })
  t.assert.deepEqual(built.mainFields.sources.toSorted(), ['packages/app/node_modules/p/index.js', 'packages/app/node_modules/p/package.json', 'packages/app/package.json', 'packages/app/src/main.js'], 'the tree is read in place')
  t.assert.deepEqual(built.mainFields.repo, { github: GITHUB, root: true, commit: SHA })
  t.assert.deepEqual(built.defaults.sources, ['packages/p/index.js'], "the entries the package.json names")
  t.assert.deepEqual(built.metroDefaults.sources, ['index.js'], 'as the field resolver resolves them, from the directory')
  for (const entry of otherLanguages) t.assert.match(refused[entry] ?? '', /only JS bundles are built with pnpm$/u, entry)
})

test('stasis github-bundle writes the bundle and lockfile of the repo at the commit', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-github-cli-'))
  try {
    const client = fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
    await githubBundleCommand({ cwd: tmp, github: GITHUB, sha: SHA, packageManager: 'pnpm', client, entries: ['src/a.js'], output: 'out/b.br', lockfile: 'out/b.lock.json' })
    const bundle = Bundle.parse(brotliDecompressSync(await readFile(join(tmp, 'out', 'b.br'))).toString('utf8'))
    t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js'])
    t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: SHA })
    t.assert.deepEqual([...Lockfile.parse(await readFile(join(tmp, 'out', 'b.lock.json'), 'utf8')).entries], ['src/a.js'])
    // A Solidity bundle has no lockfile, which is said before anything is fetched.
    const none = fakeClient({})
    await t.assert.rejects(githubBundleCommand({ cwd: tmp, github: GITHUB, sha: SHA, packageManager: 'soldeer', client: none, entries: ['src'], lockfile: 'x.json' }), /^Error: github-bundle: --lockfile is only valid for JS bundles$/u)
    t.assert.deepEqual(none.calls, [])
    // Without a commit or entries, the default branch's head and what its package.json names.
    const warn = t.mock.method(console, 'warn', () => {})
    await githubBundleCommand({ cwd: tmp, github: GITHUB, packageManager: 'pnpm', client: fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0', main: 'src/a.js' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': '' }), output: 'out/c.br' })
    const head = Bundle.parse(brotliDecompressSync(await readFile(join(tmp, 'out', 'c.br'))).toString('utf8'))
    t.assert.deepEqual([...head.entries], ['src/a.js'])
    t.assert.equal(head.repo.commit, HEAD)
    t.assert.match(warn.mock.calls.at(-1).arguments[0], new RegExp(`from ${GITHUB}@${HEAD} to out/c\\.br$`, 'u'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('stasis github-bundle requires --github and --package-manager', async (t) => {
  const usage = async (args) => {
    const child = spawn(process.execPath, [join(here, '..', 'stasis', 'bin', 'stasis.js'), 'github-bundle', ...args, 'a.js'])
    const stderr = []
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const [status] = await once(child, 'close')
    return { status, error: Buffer.concat(stderr).toString('utf8').split('\n')[0] }
  }
  const cases = [
    [[`--sha=${SHA}`, '--package-manager=pnpm'], 'Error: github-bundle requires --github=owner/name, the repo to bundle'],
    [[`--github=${GITHUB}`, `--sha=${SHA}`], 'Error: github-bundle requires --package-manager=(pnpm|yarn1|soldeer)'],
  ]
  const results = await Promise.all(cases.map(([args]) => usage(args)))
  t.assert.deepEqual(results, cases.map(([, error]) => ({ status: 1, error })))
})
