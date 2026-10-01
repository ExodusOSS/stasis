import { test } from 'node:test'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { buildGitHubBundle } from '../stasis/src/vfs-bundle.js'

// @exodus/stasis/vfs-bundle's buildGitHubBundle over a fake @preventive/upstream/github.js client
// serving a repo held in memory: nothing is fetched, and every lockfile here locks no registry package.

const GITHUB = 'ExodusOSS/example'
const SHA = 'a'.repeat(40)
const lockfile = (...importers) => ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', ...importers.map((id) => `  ${id}: {}`), ''].join('\n')
const json = (value) => `${JSON.stringify(value)}\n`
const encoder = new TextEncoder()

// A gzipped tarball of `files` under `dir`, as GitHub's: one top directory named for the tree.
const tarballOf = (files, dir = '') => {
  const prefix = dir ? `${dir}/` : ''
  const entries = [{ name: 'tree-id/', type: 'directory' }]
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith(prefix)) entries.push({ name: `tree-id/${path.slice(prefix.length)}`, data: encoder.encode(text) })
  }
  return compress(pack(entries), 'gzip')
}

const fakeClient = (files) => {
  const calls = []
  return {
    calls,
    async listRepoDir({ repo, sha, path }) {
      calls.push(['listRepoDir', repo, sha, path])
      const names = Object.keys(files).filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1))
      return names.map((name) => (name.includes('/') ? { path: name.split('/')[0], type: 'tree' } : { path: name, type: 'blob' }))
    },
    async getRepoTreeId({ repo, sha, path }) {
      calls.push(['getRepoTreeId', repo, sha, path])
      return `tree:${path}`
    },
    async getRepoTreeTarball({ repo, tree }) {
      calls.push(['getRepoTreeTarball', repo, tree])
      return tarballOf(files, tree.slice('tree:'.length))
    },
    async getRepoTarball({ repo, sha }) {
      calls.push(['getRepoTarball', repo, sha])
      return tarballOf(files)
    },
  }
}

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
  t.assert.deepEqual({ ...bundle.repo }, { github: GITHUB, directory: 'packages/p', commit: SHA })
  t.assert.deepEqual(client.calls.map(([method]) => method), ['listRepoDir', 'getRepoTarball'])
})

test('buildGitHubBundle checks its arguments before anything is fetched', async (t) => {
  const client = fakeClient({})
  await t.assert.rejects(build({ client, sha: 'abc123', entries: ['a.js'] }), /invalid bundle repo\.commit/u)
  await t.assert.rejects(build({ client, github: 'not a repo', entries: ['a.js'] }), /invalid bundle repo\.github/u)
  await t.assert.rejects(build({ client, directory: 'a b', entries: ['a.js'] }), /invalid bundle repo\.directory/u)
  await t.assert.rejects(build({ client, directory: '../up', entries: ['a.js'] }), /invalid bundle repo\.directory/u)
  await t.assert.rejects(build({ client, github: undefined, entries: ['a.js'] }), /github and sha are required/u)
  await t.assert.rejects(build({ client, packageManager: 'npm', entries: ['a.js'] }), /packageManager must be one of/u)
  t.assert.deepEqual(client.calls, [])
})

test('buildGitHubBundle refuses a tarball entry no tree holds', async (t) => {
  const client = { getRepoTarball: async () => compress(pack([{ name: 'tree-id/', type: 'directory' }, { name: 'tree-id/fifo', type: 'fifo' }]), 'gzip') }
  await t.assert.rejects(build({ client, entries: ['a.js'] }), /unexpected fifo "fifo" in the tarball/u)
})
