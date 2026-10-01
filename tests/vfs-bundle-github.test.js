import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { buildGitHubBundle } from '../stasis/src/vfs-bundle.js'
import { fakeClient, json, lockfile } from './vfs-bundle-github.helper.js'

// @exodus/stasis/vfs-bundle's buildGitHubBundle over a fake @preventive/upstream/github.js client
// serving a repo held in memory: nothing is fetched, and every lockfile here locks no registry package.

const GITHUB = 'ExodusOSS/example'
const SHA = 'a'.repeat(40)
const here = dirname(fileURLToPath(import.meta.url))

const build = (options) => buildGitHubBundle({ github: GITHUB, sha: SHA, packageManager: 'pnpm', ...options })

test('buildGitHubBundle builds a repo at a commit and stamps `repo` itself', async (t) => {
  const client = fakeClient({ 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' })
  const { bundle, lockfile: lock } = await build({ client, entries: ['src/a.js'] })
  t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js'])
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, root: true, commit: SHA })
  t.assert.doesNotMatch(lock.serialize(), /ExodusOSS/u)
  t.assert.deepEqual(client.calls, [['getRepoTarball', GITHUB, SHA]])
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
  t.assert.deepEqual(client.calls.map(([method]) => method), ['listRepoDir', 'getRepoTreeId', 'getRepoTreeTarball'])
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
  await t.assert.rejects(build({ client, github: undefined, entries: ['a.js'] }), /github and sha are required/u)
  await t.assert.rejects(build({ client, packageManager: 'npm', entries: ['a.js'] }), /packageManager must be one of/u)
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
const methods = (client) => client.calls.map(([method]) => method)

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
    t.assert.deepEqual(methods(client), ['listRepoDir', 'getRepoTreeId', 'getRepoTreeTarball', 'getRepoTarball'], what)
    t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js', 'src/b.js'], what)
    t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, directory: 'apps/p', commit: SHA }, what)
  }))
  // A tsconfig path within the subtree keeps it alone.
  const client = fakeClient(appWithLockfile({ 'apps/p/tsconfig.json': json({ extends: './tsconfig.base.json', include: ['./src'] }) }))
  await build({ client, directory: 'apps/p', entries: ['src/a.js'] })
  t.assert.deepEqual(methods(client), ['listRepoDir', 'getRepoTreeId', 'getRepoTreeTarball'])
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
  for (const entry of otherLanguages) t.assert.match(refused[entry] ?? '', /only JS bundles are built from a lockfile/u, entry)
})
