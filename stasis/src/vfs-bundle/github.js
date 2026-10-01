import { posix } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle } from '../cmd/bundle.js'
import { checkPackageManager, lockfileOf, lockfileRoot } from './tree.js'

// As upstream's tree verification bounds a tarball's unpacked size.
const MAX_TAR_BYTES = 2 ** 30
// What a git tree holds (upstream's verification refuses anything else from GitHub).
const TREE_TYPES = new Set(['file', 'directory', 'symlink'])
// Lockfile references to a path above the lockfile's directory (conservatively: any importer's).
const LOCKFILE_ESCAPE = /(?:link:|file:|directory: )\.\.\//u
const TSCONFIG = /(?:^|\/)[jt]sconfig[^/]*\.json$/u

const escapes = (path) => path === '..' || path.startsWith('../') || path.startsWith('/')
// Whether `target`, a path relative to the file `from`, resolves outside the tree.
const resolvesOutside = (from, target) => target.startsWith('/') || escapes(posix.join(posix.dirname(from), target))

// A GitHub tarball's entries, its one top directory dropped.
async function treeEntries(tarball, where) {
  const entries = []
  for (const entry of unpack(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }))) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!TREE_TYPES.has(entry.type)) throw new Error(`${where}: unexpected ${entry.type} ${JSON.stringify(name)} in the tarball`)
    if (entry.name.includes('/')) entries.push({ ...entry, name })
  }
  return entries
}

// The first symlink pointing outside the tree, which would otherwise resolve within it.
const escapingLink = (entries) => entries.find((entry) => entry.type === 'symlink' && resolvesOutside(entry.name, entry.linkname))

// Whether a subtree's files refer to a path above it: a lockfile link or a [jt]sconfig path.
function refersAbove(entries, lockfile) {
  const text = (entry) => new TextDecoder().decode(entry.data)
  return entries.some((entry) => entry.type === 'file' && (entry.name === lockfile
    ? LOCKFILE_ESCAPE.test(text(entry))
    : TSCONFIG.test(entry.name) && [...text(entry).matchAll(/"(\.\.?\/[^"]*)"/gu)].some(([, path]) => resolvesOutside(entry.name, path))))
}

// The entries of `directory` alone, when it holds the lockfile and stands alone; else null.
async function subtreeEntries(client, { github, sha, directory, lockfile, where }) {
  let listing
  try {
    listing = await client.listRepoDir({ repo: github, sha, path: directory })
  } catch {
    return null // no plain directory in git (a symlink, or under one): the whole repo resolves it
  }
  if (!listing.some((entry) => entry.path === lockfile && entry.type === 'blob')) return null
  const tree = await client.getRepoTreeId({ repo: github, sha, path: directory })
  let entries
  try {
    entries = await treeEntries(await client.getRepoTreeTarball({ repo: github, tree }), where)
  } catch (error) {
    if (error instanceof ArchiveError) return null // e.g. a symlink out of the subtree
    throw error
  }
  return escapingLink(entries) || refersAbove(entries, lockfile) ? null : entries
}

// A GitHub repo at a full commit, as buildVfsBundle builds it. A `directory` holding the lockfile is
// downloaded alone if it stands alone, else the whole repo is. `repo` names the commit and where the
// lockfile is, which the bundle's paths are relative to. Nothing is read from disk: the tree's bytes
// come from GitHub, or from the cache setCacheDir names, held to the git tree id either way
// (@preventive/upstream), and are unpacked into a Vfs that buildVfsBundle reads alone.
export async function buildGitHubBundle({ github, sha, directory, client, packageManager, ...options } = {}) {
  checkPackageManager('buildGitHubBundle', packageManager)
  if (github === undefined || sha === undefined) throw new Error('buildGitHubBundle: github and sha are required')
  // Checked as the Bundle checks them, before anything is fetched.
  for (const [key, value] of Object.entries({ github, commit: sha, directory: directory || undefined })) {
    if (value !== undefined && !isValidRepoField(key, value)) throw new Error(`buildGitHubBundle: invalid ${key}: ${JSON.stringify(value)}`)
  }
  client ??= createClient({ token: null })
  const where = `buildGitHubBundle: ${github}@${sha}`
  const subtree = directory ? await subtreeEntries(client, { github, sha, directory, lockfile: lockfileOf(packageManager), where }) : null
  const entries = subtree ?? await treeEntries(await client.getRepoTarball({ repo: github, sha }), where)
  const link = subtree ? undefined : escapingLink(entries)
  if (link) throw new Error(`${where}: symlink ${JSON.stringify(link.name)} points outside the repo`)
  const vfs = vfsFromEntries(entries)
  const cwd = posix.resolve('/', subtree ? '.' : directory ?? '.')
  const root = lockfileRoot(vfs, packageManager, cwd)
  const at = subtree ? posix.join(directory, (root ?? '/').slice(1)) : (root ?? '/').slice(1)
  const location = at === '' ? { root: true } : isValidRepoField('directory', at) ? { directory: at } : {}
  return buildVfsBundle({ ...options, packageManager, vfs, cwd, repo: { github, commit: sha, ...location } })
}
