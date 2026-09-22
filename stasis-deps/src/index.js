import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parsePnpmLockfile } from './lockfile.js'
import { loadPnpmSettings } from './settings.js'
import { buildLayout, computeSkipped, currentPlatform, planTarballs } from './layout.js'
import { defaultCacheDir, fetchTarballs } from './fetch.js'
import { readPackageTarball } from './tar.js'

export { MemoryTree, createOverlayHost } from './vfs.js'

// @exodus/stasis-deps: a project's node_modules reconstructed in memory from its pnpm-lock.yaml --
// tarballs fetched into a verified cache, unpacked in memory, laid out exactly as `pnpm install`
// would, with no package script ever run. `@exodus/stasis` reads it through the overlay host to
// build a bundle without an install (`stasis bundle --pnpm`); this package itself knows nothing
// about bundling or module resolution.

export const LOCKFILE_NAME = 'pnpm-lock.yaml'

// The directory holding the pnpm-lock.yaml that governs `cwd`: cwd itself or the nearest ancestor
// (a pnpm workspace keeps one lockfile at its root).
export function findLockfileRoot(cwd) {
  let dir = resolve(cwd)
  while (true) {
    if (existsSync(join(dir, LOCKFILE_NAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Read the lockfile, download every needed tarball into the cache (verified, never unpacked on
// disk), unpack them in memory and lay out pnpm's node_modules tree in memory. Returns the tree
// (a MemoryTree rooted at the lockfile dir's real paths) plus what went into it; wrap it in
// createOverlayHost({ root, tree, makeResolver }) to read through it.
export async function loadPnpmNodeModules({ cwd = process.cwd(), cacheDir, offline = false, log = (msg) => console.warn(msg), fetchImpl, concurrency } = {}) {
  const root = findLockfileRoot(cwd)
  if (root === null) throw new Error(`stasis --pnpm: no ${LOCKFILE_NAME} found in ${resolve(cwd)} or any parent directory`)
  const lockfile = parsePnpmLockfile(readFileSync(join(root, LOCKFILE_NAME), 'utf8'))
  const settings = loadPnpmSettings({ root })
  if (settings.nodeLinker !== 'isolated') {
    throw new Error(`stasis --pnpm: node-linker=${settings.nodeLinker} is not supported; only pnpm's default isolated node_modules layout is reproduced`)
  }

  const platform = currentPlatform()
  const skipped = computeSkipped(lockfile, platform)
  const plan = planTarballs(lockfile, { skipped, settings, root })
  cacheDir = resolve(cacheDir ?? defaultCacheDir())

  const recorded = plan.filter((entry) => entry.recorded).length
  log?.(`[stasis] pnpm: ${lockfile.snapshots.size} snapshot${lockfile.snapshots.size === 1 ? '' : 's'} in ${LOCKFILE_NAME}, ${plan.length} tarball${plan.length === 1 ? '' : 's'} to verify${recorded > 0 ? ` (${recorded} tarball URL${recorded === 1 ? '' : 's'} recorded in the lockfile, asserted)` : ''}${skipped.size > 0 ? ` (${skipped.size} optional skipped on ${platform.os}-${platform.cpu})` : ''}; cache ${cacheDir}`)
  const { tarballs, downloaded, cached } = await fetchTarballs(plan, { cacheDir, offline, fetchImpl, concurrency })
  log?.(`[stasis] pnpm: ${downloaded} downloaded, ${cached} from cache, all integrity-verified`)

  const filesByKey = new Map()
  for (const [key, bytes] of tarballs) filesByKey.set(key, readPackageTarball(bytes, { label: key }))

  // Non-root workspace projects, by package name (hoist-workspace-packages links them by name).
  const workspaceDirs = new Map()
  for (const id of lockfile.importers.keys()) {
    if (id === '.') continue
    const dir = resolve(root, id)
    try {
      const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof name === 'string' && name !== '') workspaceDirs.set(name, dir)
    } catch { /* an importer without a readable manifest simply isn't hoisted by name */ }
  }

  const layout = buildLayout({
    root,
    lockfile,
    settings,
    skipped,
    workspaceDirs,
    filesFor: (key) => {
      const files = filesByKey.get(key)
      if (!files) throw new Error(`stasis --pnpm: internal: no tarball for ${key}`)
      return files
    },
  })
  return {
    root,
    tree: layout.tree,
    lockfile,
    settings,
    skipped,
    layout,
    summary: { snapshots: lockfile.snapshots.size, tarballs: plan.length, downloaded, cached, skipped: skipped.size, cacheDir },
  }
}
