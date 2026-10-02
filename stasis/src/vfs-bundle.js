import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { checkVfsOptions } from './cmd/bundle.js'
import { packageEntries } from './vfs-bundle/entries.js'
import { suggestedRepoEntries } from './vfs-bundle/github.js'
import { checkTarget, checkVfs, loadTree, packageManagerOf, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles from a project's lockfile alone, through the
// dependencies its package manager would install (`packageManager`: 'pnpm', pnpm 10, 11 or 12;
// 'yarn1', yarn 1.22; or 'soldeer', Soldeer 0.12), over the project held in a Vfs, which is only
// read. The tree is laid out by @preventive/deptree into a Vfs of its own, and nothing is read from
// disk or written there but the tarballs and zips: fetched from registry.npmjs.org and Soldeer's
// registry, or read from npm's cache or ~/.audit's where one holds them, every copy held to the
// lockfile's integrity before it is used; cached only where setCacheDir says. buildGitHubBundle
// builds one from a GitHub repo at a commit (the default branch's head without one), its tree
// fetched from GitHub and held to its git tree id, cached there the same way.

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
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc } = {}) {
  packageManagerOf('loadNodeModules', packageManager, ['pnpm', 'yarn1'])
  checkVfs('loadNodeModules', vfs)
  checkTarget('loadNodeModules', { os, cpu, libc })
  return loadTree({ project: vfsHost(vfs), packageManager, cwd: posix.resolve('/', cwd), packageManagerVersion, os, cpu, libc })
}

// -> the JS entry points a package.json names, as paths from its directory, which buildGitHubBundle
// takes where no entries are given, resolved as the build resolves them with the same
// `conditions`, `mainFields`, `metro`, `platforms`, `jsx` and `typescript` (checked as it checks
// them), in its order: the package's own entry, as `./` resolves there (`main`, or under
// `mainFields` or `metro` the first of its main fields, for each of the platforms); each subpath of
// `exports` (but a pattern), as the package's name resolves for require() and for import, with the
// conditions the build adds (the RN ones under `metro`); and each `bin`. Under `typescript`, what
// resolution misses is mapped to its TS source as tsc maps it. Each a file in that directory, named
// from within it. Of the project held in `vfs`, from the package.json in `cwd`; or of a GitHub
// repo, `{ github, sha, directory, client }` as buildGitHubBundle takes them, from the one in
// `directory` or the repo's root. None without a package.json.
export async function suggestedEntries({ vfs, cwd = '/', conditions, mainFields, metro, platforms, jsx, typescript, ...repo } = {}) {
  const resolution = { conditions, mainFields, metro, platforms, jsx, typescript }
  if (vfs === undefined && repo.github === undefined) throw new Error('suggestedEntries: a vfs or a github repo is required')
  if (vfs !== undefined && repo.github !== undefined) throw new Error('suggestedEntries: takes a vfs or a github repo, not both')
  // Over a JS entry, as each suggested one is.
  checkVfsOptions('suggestedEntries', { kind: 'js' }, undefined, { ...resolution, entries: ['index.js'], cwd: '/', host: vfsHost(new Vfs()) })
  if (vfs === undefined) return suggestedRepoEntries({ ...repo, ...resolution })
  checkVfs('suggestedEntries', vfs)
  return packageEntries(vfsHost(vfs), posix.resolve('/', cwd), resolution)
}
