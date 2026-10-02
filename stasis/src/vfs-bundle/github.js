import { posix } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { Vfs, vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle, checkVfsOptions } from '../cmd/bundle.js'
import { packageEntries } from './entries.js'
import { checkTarget, installedAlone, lockfileOf, lockfileRoot, packageManagerOf, vfsHost } from './tree.js'

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

// The files of `directory` alone, when it holds the lockfile, is installed from itself and stands
// alone; else null.
async function subtreeEntries(client, { github, sha, directory, packageManager, where }) {
  const list = async (path) => (await client.listRepoDir({ repo: github, sha, path })).map((entry) => entry.path)
  let listing
  try {
    listing = await client.listRepoDir({ repo: github, sha, path: directory })
  } catch {
    return null // no plain directory in git (a symlink, or under one): the whole repo resolves it
  }
  const lockfile = lockfileOf(packageManager)
  if (!listing.some((entry) => entry.path === lockfile && entry.type === 'blob')) return null
  // Installed from a root above it (a workspace's), it is built from there.
  if (!(await installedAlone(packageManager, listing.map((entry) => entry.path), () => Promise.all(ancestorsOf(directory).map(list))))) return null
  const files = await treeFiles(client, { github, tree: await client.getRepoTreeId({ repo: github, sha, path: directory }), where })
  return files === null || refersAbove(files, lockfile) ? null : files
}

// A GitHub repo at a full commit, the default branch's head without one, as buildVfsBundle builds
// it. A `directory` holding the lockfile is downloaded alone if it stands alone, else the whole repo
// is. Without `entries`, they are the ones suggestedEntries suggests. `repo` names the commit and
// where the lockfile is, which the bundle's paths are relative to. Nothing is read from disk: the
// tree's bytes come from GitHub, or from the cache setCacheDir names, held to the git tree id
// either way (@preventive/upstream), and are unpacked into a Vfs that buildVfsBundle reads alone.
export async function buildGitHubBundle({ github, sha, directory, client, packageManager, ...options } = {}) {
  const pm = packageManagerOf('buildGitHubBundle', packageManager)
  checkTarget('buildGitHubBundle', options)
  if (options.entries === undefined && pm.kind !== 'js') throw new Error(`buildGitHubBundle: entries are required with ${packageManager}`)
  // buildVfsBundle's checks, over an empty tree: what the tree is never decides them. Without
  // entries, over a JS one, as each suggested one is.
  checkVfsOptions('buildGitHubBundle', pm, packageManager, { ...options, entries: options.entries ?? ['index.js'], cwd: '/', host: vfsHost(new Vfs()), fetched: false })
  checkRepo('buildGitHubBundle', { github, sha, directory })
  client ??= createClient({ token: null })
  sha ??= (await client.getRepoHead({ repo: github })).oid
  const where = `buildGitHubBundle: ${github}@${sha}`
  const subtree = directory ? await subtreeEntries(client, { github, sha, directory, packageManager, where }) : null
  const vfs = vfsFromEntries(subtree ?? await repoFiles(client, { github, sha, where }))
  const cwd = posix.resolve('/', subtree ? '.' : directory ?? '.')
  const root = lockfileRoot(vfs, packageManager, cwd)
  const at = subtree ? posix.join(directory, (root ?? '/').slice(1)) : (root ?? '/').slice(1)
  const location = at === '' ? { root: true } : isValidRepoField('directory', at) ? { directory: at } : {}
  let { entries } = options
  if (entries === undefined) {
    // As suggestedEntries suggests them, from the tree at hand.
    entries = packageEntries(vfsHost(vfs), cwd, options)
    if (entries.length === 0) throw new Error(`${where}: no entries given, and ${directory || 'the repo root'} has no package.json naming a JS entry point there`)
  }
  return buildVfsBundle({ ...options, entries, packageManager, vfs, cwd, repo: { github, commit: sha, ...location } })
}

// suggestedEntries of a GitHub repo at a full commit, the default branch's head without one: those
// the package.json in `directory` (or the repo's root) names, resolved as `resolution` says (the
// build's conditions, mainFields, metro, platforms, jsx and typescript), `directory` downloaded
// alone where it is a plain directory in git with no symlink out of it, else the whole repo, from
// GitHub or the cache as buildGitHubBundle downloads it.
export async function suggestedRepoEntries({ github, sha, directory, client, ...resolution } = {}) {
  checkRepo('suggestedEntries', { github, sha, directory })
  client ??= createClient({ token: null })
  sha ??= (await client.getRepoHead({ repo: github })).oid
  const where = `suggestedEntries: ${github}@${sha}`
  let tree
  try {
    if (directory) tree = await client.getRepoTreeId({ repo: github, sha, path: directory })
  } catch {
    // no plain directory in git (a symlink, or under one): the whole repo resolves it
  }
  const subtree = tree === undefined ? null : await treeFiles(client, { github, tree, where })
  const vfs = vfsFromEntries(subtree ?? await repoFiles(client, { github, sha, where }))
  return packageEntries(vfsHost(vfs), posix.resolve('/', subtree ? '.' : directory || '.'), resolution)
}
