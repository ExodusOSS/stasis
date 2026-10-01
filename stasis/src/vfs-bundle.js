import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { checkPackageManager, loadTree, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles from a project's lockfile alone, through the
// node_modules its package manager would install (`packageManager`: 'pnpm', pnpm 10 or 11, or
// 'yarn1', yarn 1.22), over the project held in a Vfs, which is only read. The tree is laid out by
// @preventive/deptree into a Vfs of its own, and nothing is read from disk or written there but
// the tarballs, fetched from registry.npmjs.org and cached only where setCacheDir says.

export { buildVfsBundle } from './cmd/bundle.js'
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
