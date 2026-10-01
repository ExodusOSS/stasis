import { Bundle } from '@exodus/stasis-core/bundle'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle } from '../cmd/bundle.js'
import { checkPackageManager, lockfileOf } from './tree.js'

// As upstream's tree verification bounds a tarball's unpacked size.
const MAX_TAR_BYTES = 2 ** 30
// What a git tree holds (upstream's verification refuses anything else from GitHub).
const TREE_TYPES = new Set(['file', 'directory', 'symlink'])

// A GitHub tarball's entries, its one top directory dropped.
function treeEntries(tar, where) {
  const entries = []
  for (const entry of unpack(tar)) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!TREE_TYPES.has(entry.type)) throw new Error(`${where}: unexpected ${entry.type} ${JSON.stringify(name)} in the tarball`)
    if (entry.name.includes('/')) entries.push({ ...entry, name })
  }
  return entries
}

// A GitHub repo at a full commit, as buildVfsBundle builds it, `repo` stamped from the request; a
// `directory` holding the lockfile is downloaded alone, else the whole repo, for a lockfile above it.
export async function buildGitHubBundle({ github, sha, directory, client, packageManager, ...options } = {}) {
  checkPackageManager('buildGitHubBundle', packageManager)
  if (github === undefined || sha === undefined) throw new Error('buildGitHubBundle: github and sha are required')
  // Checked before anything is fetched.
  const { repo } = new Bundle({ repo: { github, commit: sha, ...(directory ? { directory } : { root: true }) } })
  client ??= createClient({ token: null })
  const subtree = Boolean(directory) && (await client.listRepoDir({ repo: github, sha, path: directory }))
    .some((entry) => entry.path === lockfileOf(packageManager) && entry.type === 'blob')
  const tarball = subtree
    ? await client.getRepoTreeTarball({ repo: github, tree: await client.getRepoTreeId({ repo: github, sha, path: directory }) })
    : await client.getRepoTarball({ repo: github, sha })
  const tar = await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES })
  const vfs = vfsFromEntries(treeEntries(tar, `buildGitHubBundle: ${github}@${sha}`))
  return buildVfsBundle({ ...options, packageManager, vfs, cwd: subtree ? '/' : directory, repo })
}
