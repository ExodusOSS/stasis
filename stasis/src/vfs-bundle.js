import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { checkVfs, loadTree, packageManagerOf, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles from a project's lockfile alone, through the
// dependencies its package manager would install (`packageManager`: 'pnpm', pnpm 10, 11 or 12;
// 'yarn1', yarn 1.22; or 'soldeer', Soldeer 0.12), over the project held in a Vfs, which is only
// read. The tree is laid out by @preventive/deptree into a Vfs of its own, and nothing is read from
// disk or written there but the tarballs and zips: fetched from registry.npmjs.org and Soldeer's
// registry, or read from npm's cache or ~/.audit's where one holds them, every copy held to the
// lockfile's integrity before it is used; cached only where setCacheDir says. buildGitHubBundle
// builds one from a GitHub repo at a commit, its tree fetched from GitHub and held to its git tree
// id, cached there the same way.

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
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion } = {}) {
  packageManagerOf('loadNodeModules', packageManager, ['pnpm', 'yarn1'])
  checkVfs('loadNodeModules', vfs)
  return loadTree({ project: vfsHost(vfs), packageManager, cwd: posix.resolve('/', cwd), packageManagerVersion })
}
