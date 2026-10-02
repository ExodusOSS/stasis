import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { KINDS, checkAhead } from './vfs-bundle/entries.js'
import { suggestedRepoEntries } from './vfs-bundle/github.js'
import { NODE_MODULES_MANAGERS, checkTarget, checkVfs, detectPackageManager, loadTree, packageManagerFor, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles from a project's lockfile alone, through the
// dependencies its package manager would install (`packageManager`: 'pnpm', pnpm 10, 11 or 12;
// 'yarn1', yarn 1.22; or 'soldeer', Soldeer 0.12; without one, the one whose lockfile installs the
// project, where only one's does), over the project held in a Vfs, which is only read. The tree is
// laid out by @preventive/deptree into a Vfs of its own, and nothing is read from disk or written
// there but the tarballs and zips: fetched from registry.npmjs.org and Soldeer's registry, or read
// from npm's cache or ~/.audit's where one holds them, every copy held to the lockfile's integrity
// before it is used; cached only where setCacheDir says. buildGitHubBundle builds one from a GitHub
// repo at a commit (the default branch's head without one), its tree fetched from GitHub and held
// to its git tree id, cached there the same way.

export { buildVfsBundle } from './cmd/bundle.js'
export { buildGitHubBundle } from './vfs-bundle/github.js'
export { setCacheDir } from '@preventive/deptree/pnpm.js'
export { Vfs }

// A `host` (@exodus/stasis-core/host) over `vfs` alone, its `/` the filesystem's, reading it as it is
// at each call.
export function createVfsHost(vfs) {
  checkVfs('createVfsHost', vfs)
  return vfsHost(vfs, { cache: false })
}

// -> { root, vfs, projects, host, stats, packageManager, packageManagerVersion }, as 'pnpm' or 'yarn1'
// installs node_modules: the directory in the project's Vfs it installs cwd from, which holds the
// lockfile; the Vfs the tree is laid out into, rooted there; the projects' directories from there;
// the host reading the project through the tree; deptree's counts; and the package manager
// reproduced, at `packageManagerVersion` if given, else the one the root package.json's
// packageManager pins, else pnpm 10.33.4 or yarn 1.22.22. The host caches what it reads, of the
// project's Vfs too, so neither is to change while it is used.
// `os`, `cpu` and `libc` ('glibc', 'musl' or 'unknown', pnpm's alone) are the machine packages are
// matched against: this one's but for what is given (for another os, libc defaults to 'unknown').
// Without a `packageManager`, it is the one of the two whose lockfile installs cwd, where only one's
// does.
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc } = {}) {
  checkVfs('loadNodeModules', vfs)
  checkTarget('loadNodeModules', { os, cpu, libc })
  const project = vfsHost(vfs)
  // A real path, as detection and the layout take it.
  cwd = project.realpath(posix.resolve('/', cwd))
  packageManager = packageManagerFor('loadNodeModules', project, cwd, { packageManager, packageManagerVersion }, NODE_MODULES_MANAGERS)
  return loadTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc })
}

// -> the entries buildGitHubBundle takes where none are given, as paths from the project's
// directory, of the kind its package manager builds: `packageManager` if given, else the one
// detected as the build detects it. For pnpm and yarn 1, the entry points its package.json names,
// resolved as the build resolves them with the same `conditions`, `mainFields`, `metro`,
// `platforms`, `jsx` and `typescript` (packageEntries); for Soldeer, its .sol entry points by name
// and layout (solidityEntries). The options are checked as the build checks them. Of the project
// held in `vfs`, from `cwd`; or of a GitHub repo, `{ github, sha, directory, client }` as
// buildGitHubBundle takes them, downloaded as it downloads them.
export async function suggestedEntries({ vfs, cwd = '/', packageManager, conditions, mainFields, metro, platforms, jsx, typescript, ...repo } = {}) {
  const resolution = { conditions, mainFields, metro, platforms, jsx, typescript }
  if (vfs === undefined && repo.github === undefined) throw new Error('suggestedEntries: a vfs or a github repo is required')
  if (vfs !== undefined && repo.github !== undefined) throw new Error('suggestedEntries: takes a vfs or a github repo, not both')
  if (vfs === undefined) return suggestedRepoEntries({ ...repo, packageManager }, resolution)
  checkVfs('suggestedEntries', vfs)
  const host = vfsHost(vfs)
  const at = posix.resolve('/', cwd)
  const pm = checkAhead('suggestedEntries', packageManager ?? detectPackageManager('suggestedEntries', host, at), resolution)
  return KINDS[pm.kind].entries(host, at, resolution)
}
