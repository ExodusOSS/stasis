import { posix } from 'node:path'

import { Bundle } from '@exodus/stasis-core/bundle'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { Vfs, vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle } from './cmd/bundle.js'
import { checkPackageManager, loadTree, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles from a project's lockfile alone, through the
// node_modules its package manager would install (`packageManager`: 'pnpm', pnpm 10 or 11, or
// 'yarn1', yarn 1.22), over the project held in a Vfs, which is only read. The tree is laid out by
// @preventive/deptree into a Vfs of its own, and nothing is read from disk or written there but
// the tarballs, fetched from registry.npmjs.org and cached only where setCacheDir says.

export { buildVfsBundle }
export { setCacheDir } from '@preventive/upstream/npm.js'
export { Vfs }

// A `host` (@exodus/stasis-core/host) over `vfs` alone, its `/` the filesystem's, reading it as it is
// at each call.
export const createVfsHost = (vfs) => vfsHost(vfs, { cache: false })

// -> { root, vfs, projects, host, stats, packageManager, packageManagerVersion }: the lockfile's
// directory in the project's Vfs; the Vfs the tree is laid out into, rooted there; the projects'
// directories from there; the host reading the project through the tree; deptree's counts; and the
// package manager reproduced, at `packageManagerVersion` if given, else the one the root
// package.json's packageManager pins, else pnpm 10.33.4 or yarn 1.22.22. The host reads the project
// as it was laid out from: a change to its Vfs after is not seen.
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion } = {}) {
  checkPackageManager('loadNodeModules', packageManager)
  if (!(vfs instanceof Vfs)) throw new TypeError('loadNodeModules: vfs must be a @preventive/vfs Vfs holding the project')
  return loadTree({ project: vfsHost(vfs), packageManager, cwd: posix.resolve('/', cwd), packageManagerVersion })
}

// Bounds the tar a tarball gunzips to (upstream bounds the tarball itself to 512 MiB).
const MAX_TAR_BYTES = 2 * 1024 * 1024 * 1024
const TREE_TYPES = new Set(['file', 'contiguous-file', 'directory', 'symlink', 'hardlink'])

// GitHub's tarball entries under its one top directory, as Vfs entries named from the repo root.
function repoEntries(tar, where) {
  const strip = (name) => name.slice(name.indexOf('/') + 1)
  const entries = []
  for (const entry of unpack(tar)) {
    if (!TREE_TYPES.has(entry.type)) throw new Error(`${where}: unexpected ${entry.type} ${JSON.stringify(strip(entry.name))} in the tarball`)
    if (!entry.name.includes('/')) continue // the top directory itself
    const { type, mode, mtime } = entry
    const name = strip(entry.name)
    if (type === 'hardlink') entries.push({ name, type, linkname: strip(entry.linkname) })
    else if (type === 'symlink') entries.push({ name, type, mode, mtime, linkname: entry.linkname })
    else if (type === 'directory') entries.push({ name, type, mode, mtime })
    else entries.push({ name, type: 'file', mode, mtime, data: entry.data })
  }
  return entries
}

const LOCKFILES = { pnpm: 'pnpm-lock.yaml', yarn1: 'yarn.lock' }

// A JS bundle of the GitHub repo `github` ('owner/name') at the full commit `sha`, rooted at its
// `directory` (the repo root without one), through `client` (a @preventive/upstream/github.js
// client, anonymous by default), every download checked against git's tree id. A `directory` with
// the lockfile in it is downloaded alone; else the whole repo is, for the lockfile above it. Built
// by buildVfsBundle, `repo` stamped from what was asked; other options are its, `packageManager` among them.
// -> { bundle: Bundle, lockfile: Lockfile, stats }
export async function buildGitHubBundle({ github, sha, directory, client, packageManager, ...options } = {}) {
  checkPackageManager('buildGitHubBundle', packageManager)
  // Checked as the Bundle checks it, before anything is fetched: a full sha, a URL-safe directory.
  const { repo } = new Bundle({ repo: { github, commit: sha, ...(directory ? { directory } : { root: true }) } })
  if (repo?.commit === undefined || repo.github === undefined) throw new Error('buildGitHubBundle: github and sha are required')
  client ??= createClient({ token: null })
  const where = `buildGitHubBundle: ${github}@${sha}`
  let tarball
  let cwd = `/${directory ?? ''}`
  if (directory) {
    const listing = await client.listRepoDir({ repo: github, sha, path: directory })
    if (listing.some((entry) => entry.path === LOCKFILES[packageManager] && entry.type === 'blob')) {
      tarball = await client.getRepoTreeTarball({ repo: github, tree: await client.getRepoTreeId({ repo: github, sha, path: directory }) })
      cwd = '/'
    }
  }
  tarball ??= await client.getRepoTarball({ repo: github, sha })
  const vfs = vfsFromEntries(repoEntries(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }), where))
  return buildVfsBundle({ ...options, packageManager, vfs, cwd, repo })
}
