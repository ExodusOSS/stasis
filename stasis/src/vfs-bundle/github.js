import { posix } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle } from '../cmd/bundle.js'
import { KINDS, checkAhead } from './entries.js'
import { checkTarget, detectPackageManager, installedAlone, lockfileOf, lockfileRoot, lockfilesListed, noLockfile, packageManagerOf, vfsHost } from './tree.js'

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

// The directories above `directory`, the repo's root (undefined) last.
function ancestorsOf(directory) {
  const out = []
  for (let dir = posix.dirname(directory); dir !== '.'; dir = posix.dirname(dir)) out.push(dir)
  return [...out, undefined]
}

// The files of the subtree `tree`, or null where one is a symlink out of it.
async function treeFiles(client, { github, tree, where }) {
  let files
  try {
    files = await treeEntries(await client.getRepoTreeTarball({ repo: github, tree }), where)
  } catch (error) {
    if (error instanceof ArchiveError) return null // e.g. a symlink out of the subtree
    throw error
  }
  return escapingLink(files) ? null : files
}

// The whole repo's files at `sha`.
async function repoFiles(client, { github, sha, where }) {
  const files = await treeEntries(await client.getRepoTarball({ repo: github, sha }), where)
  const link = escapingLink(files)
  if (link) throw new Error(`${where}: symlink ${JSON.stringify(link.name)} points outside the repo`)
  return files
}

// Checked as the Bundle checks them, before anything is fetched.
function checkRepo(name, { github, sha, directory }) {
  if (github === undefined) throw new Error(`${name}: github is required`)
  for (const [key, value] of Object.entries({ github, commit: sha, directory: directory || undefined })) {
    if (value !== undefined && !isValidRepoField(key, value)) throw new Error(`${name}: invalid ${key}: ${JSON.stringify(value)}`)
  }
}

// listRepoDir's listing of a directory of the repo at `sha`, each listed once.
function lister(client, { github, sha }) {
  const listings = new Map()
  return (path) => {
    if (!listings.has(path)) listings.set(path, client.listRepoDir({ repo: github, sha, path }))
    return listings.get(path)
  }
}

// Of no package manager given, the one whose lockfile alone `directory` (or the repo's root) and
// the directories above it list, which is then the only one that may install it; refused where
// none does; undefined where more than one does, or the listings can't tell, for the tree to tell.
async function listedPackageManager(list, { directory, where }) {
  let listings
  try {
    listings = await Promise.all((directory ? [directory, ...ancestorsOf(directory)] : [undefined]).map(list))
  } catch {
    // No plain directory in git (a symlink, or under one); the root's failure is GitHub's.
    await list(undefined)
    return undefined
  }
  const listed = lockfilesListed(listings)
  if (listed.length === 0) throw noLockfile(where, posix.resolve('/', directory || '.'))
  return listed.length === 1 ? listed[0] : undefined
}

// The files of `directory` alone, when it holds the lockfile, is installed from itself and stands
// alone; else null.
async function subtreeEntries(client, list, { github, directory, packageManager, where }) {
  const names = async (path) => (await list(path)).map((entry) => entry.path)
  let listing
  try {
    listing = await list(directory)
  } catch {
    return null // no plain directory in git (a symlink, or under one): the whole repo resolves it
  }
  if (!lockfilesListed([listing]).includes(packageManager)) return null
  const above = ancestorsOf(directory)
  // Installed from a root above it (a workspace's), it is built from there.
  if (!(await installedAlone(packageManager, listing.map((entry) => entry.path), () => Promise.all(above.map(names))))) return null
  // Its tree id, as the listing above it holds it, held to that directory's own.
  const tree = (await list(above[0])).find((entry) => entry.path === posix.basename(directory) && entry.type === 'tree')?.sha
  const files = tree === undefined ? null : await treeFiles(client, { github, tree, where })
  return files === null || refersAbove(files, lockfileOf(packageManager)) ? null : files
}

// The repo as buildGitHubBundle downloads it, for `name`: at `sha`, else the default branch's head;
// `directory` alone where it stands alone for the package manager installing it, else the whole
// repo. That package manager is `packageManager` if given, else the one the listings tell, before
// the tree is fetched, else the tree; `options` are checked for it once it is known.
// -> { vfs, host, cwd, subtree, sha, where, packageManager, kind }
async function repoTree(name, { github, sha, directory, client, packageManager }, options) {
  checkAhead(name, packageManager, options)
  checkRepo(name, { github, sha, directory })
  client ??= createClient({ token: null })
  sha ??= (await client.getRepoHead({ repo: github })).oid
  const where = `${name}: ${github}@${sha}`
  const list = lister(client, { github, sha })
  let found = packageManager
  if (found === undefined) {
    found = await listedPackageManager(list, { directory, where })
    if (found !== undefined) checkAhead(name, found, options)
  }
  const subtree = directory && found !== undefined ? await subtreeEntries(client, list, { github, directory, packageManager: found, where }) : null
  const vfs = vfsFromEntries(subtree ?? await repoFiles(client, { github, sha, where }))
  const host = vfsHost(vfs)
  const cwd = posix.resolve('/', subtree ? '.' : directory ?? '.')
  if (packageManager === undefined) {
    const detected = detectPackageManager(where, host, cwd)
    if (detected !== found) checkAhead(name, detected, options)
    found = detected
  }
  return { vfs, host, cwd, subtree, sha, where, packageManager: found, kind: KINDS[packageManagerOf(name, found).kind] }
}

// A GitHub repo at a full commit, the default branch's head without one, as buildVfsBundle builds
// it: `directory` downloaded alone where it stands alone, else the whole repo, and without a
// `packageManager`, the one whose lockfile installs it, where only one's does (repoTree). Without
// `entries`, they are the ones suggestedEntries suggests. `repo` names the commit and where the
// lockfile is, which the bundle's paths are relative to. Nothing is read from disk: the tree's bytes
// come from GitHub, or from the cache setCacheDir names, held to the git tree id either way
// (@preventive/upstream), and are unpacked into a Vfs that buildVfsBundle reads alone.
export async function buildGitHubBundle({ github, sha, directory, client, packageManager, ...options } = {}) {
  checkTarget('buildGitHubBundle', options)
  const tree = await repoTree('buildGitHubBundle', { github, sha, directory, client, packageManager }, options)
  const root = lockfileRoot(tree.host, tree.packageManager, tree.cwd)
  const at = tree.subtree ? posix.join(directory, (root ?? '/').slice(1)) : (root ?? '/').slice(1)
  const location = at === '' ? { root: true } : isValidRepoField('directory', at) ? { directory: at } : {}
  let { entries } = options
  if (entries === undefined) {
    // As suggestedEntries suggests them, from the tree at hand.
    entries = tree.kind.entries(tree.host, tree.cwd, options)
    if (entries.length === 0) throw new Error(`${tree.where}: no entries given, and ${directory || 'the repo root'} ${tree.kind.none}`)
  }
  return buildVfsBundle({ ...options, entries, packageManager: tree.packageManager, vfs: tree.vfs, cwd: tree.cwd, repo: { github, commit: tree.sha, ...location } })
}

// suggestedEntries of a GitHub repo, `{ github, sha, directory, client, packageManager }`, as
// buildGitHubBundle downloads it.
export async function suggestedRepoEntries(repo, resolution) {
  const tree = await repoTree('suggestedEntries', repo, resolution)
  return tree.kind.entries(tree.host, tree.cwd, resolution)
}
