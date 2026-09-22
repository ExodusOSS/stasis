import { dirname, join, relative, resolve } from 'node:path'

import { depPathToFilename, registryTarballUrl } from './dep-path.js'
import { resolveDepRef } from './lockfile.js'
import { MemoryTree } from './vfs.js'
import { authHeadersFor, registryFor } from './settings.js'
import semver from '../apis/npm/semver.cjs'

// pnpm's isolated node_modules layout, rebuilt in memory from a lockfile: every snapshot gets
// `<virtualStore>/<depPathToFilename(key)>/node_modules/<name>/` holding its tarball's files,
// its dependencies as sibling symlinks, each importer's `node_modules/<alias>` links into the
// store (or to a `link:` target), and the hoisted fallbacks (`<virtualStore>/node_modules/<alias>`
// for `hoist-pattern`, the root `node_modules/<alias>` for `public-hoist-pattern`). The rules
// mirror @pnpm/headless + @pnpm/hoist for pnpm 10 so resolution -- and the paths a bundle
// records -- match a real `pnpm install` of the same lockfile on this platform.

// --- platform gating (packageIsInstallable) ---

let _libc
function currentLibc() {
  if (_libc !== undefined) return _libc
  _libc = null
  if (process.platform === 'linux') {
    try {
      _libc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
    } catch {
      _libc = 'glibc'
    }
  }
  return _libc
}

export function currentPlatform() {
  return { os: process.platform, cpu: process.arch, libc: currentLibc(), node: process.versions.node }
}

// npm's `os`/`cpu`/`libc` list semantics: `!x` blocks; with any positive entry one must match; `any` matches.
function checkList(value, list) {
  if (list === undefined) return true
  const items = typeof list === 'string' ? [list] : list
  if (items.length === 0 || (items.length === 1 && items[0] === 'any')) return true
  let match = false
  let blocked = false
  let hasPositive = false
  for (const item of items) {
    if (typeof item !== 'string') continue
    if (item.startsWith('!')) {
      if (value === item.slice(1)) blocked = true
    } else {
      hasPositive = true
      if (value === item) match = true
    }
  }
  return !blocked && (!hasPositive || match)
}

function enginesOk(engines, node) {
  const range = engines?.node
  if (typeof range !== 'string' || range === '') return true
  try {
    return semver.satisfies(node, range, { includePrerelease: true })
  } catch {
    return true // an unparseable range (or no semver available) doesn't block an install
  }
}

export function packageIsInstallable(pkg, platform, { checkEngines = false } = {}) {
  if (!checkList(platform.os, pkg.os)) return false
  if (!checkList(platform.cpu, pkg.cpu)) return false
  if (pkg.libc !== undefined && platform.libc !== null && !checkList(platform.libc, pkg.libc)) return false
  if (checkEngines && !enginesOk(pkg.engines, platform.node)) return false
  return true
}

// Direct deps of an importer in pnpm's spread order: devDependencies, dependencies,
// optionalDependencies -- an alias in several groups keeps its FIRST position and LAST reference.
function importerDirectDeps(importer) {
  const out = new Map()
  for (const group of [importer.devDependencies, importer.dependencies, importer.optionalDependencies]) {
    for (const [alias, { version }] of group) out.set(alias, version)
  }
  return out
}

// A snapshot's children in pnpm's spread order (dependencies then optionalDependencies).
function snapshotChildren(snapshot) {
  const out = new Map()
  for (const [alias, ref] of snapshot.dependencies) out.set(alias, ref)
  for (const [alias, ref] of snapshot.optionalDependencies) out.set(alias, ref)
  return out
}

// Snapshots a real install on `platform` would skip: non-installable packages reached only
// through optional dependencies (pnpm's filterLockfileByImportersAndEngine). A package under a
// skipped parent is skipped too, unless something installable also reaches it.
export function computeSkipped(lockfile, platform) {
  const skipped = new Set()
  const picked = new Set()
  const walk = (children, parentInstallable, from) => {
    const next = []
    for (const [alias, ref] of children) {
      const depPath = resolveDepRef(lockfile, alias, ref, from)
      if (depPath === null || picked.has(depPath)) continue
      const snapshot = lockfile.snapshots.get(depPath)
      const pkg = lockfile.packages.get(snapshot.packageKey)
      let installable
      if (!parentInstallable) {
        installable = false
        if (snapshot.optional) skipped.add(depPath)
      } else {
        // An optional package that can't run here is skipped; a required one is installed regardless
        // (pnpm only warns without engine-strict), so the bundle still sees it.
        installable = packageIsInstallable(pkg, platform, { checkEngines: snapshot.optional })
        if (!installable) {
          if (snapshot.optional) skipped.add(depPath)
          else installable = true
        } else {
          skipped.delete(depPath)
        }
      }
      picked.add(depPath)
      next.push([snapshotChildren(snapshot), installable, `snapshot '${depPath}'`])
    }
    for (const args of next) walk(...args)
  }
  for (const [id, importer] of lockfile.importers) walk(importerDirectDeps(importer), true, `importer '${id}'`)
  return skipped
}

// --- hoisting (@pnpm/hoist) ---

// A hoist pattern list: `*` wildcards match any run of characters (scopes included); a `!`
// pattern excludes. Matches when some positive pattern matches and no negative one does.
export function createHoistMatcher(patterns) {
  const toRegExp = (p) => new RegExp(`^${p.split('*').map((s) => s.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u')
  const positive = patterns.filter((p) => !p.startsWith('!')).map(toRegExp)
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => toRegExp(p.slice(1)))
  return (alias) => positive.some((re) => re.test(alias)) && !negative.some((re) => re.test(alias))
}

// BFS over the dependency graph from every importer; -> Map<alias, { depPath | workspaceDir, type: 'public' | 'private' }>.
// The root importer's own direct aliases are never hoisted (they already sit in the root
// node_modules); comparison is case-insensitive like pnpm's.
export function computeHoisted(lockfile, { skipped, settings, workspaceDirs }) {
  const isPublic = createHoistMatcher(settings.publicHoistPattern)
  const isPrivate = createHoistMatcher(settings.hoistPattern)
  const hoistType = (alias) => (isPublic(alias) ? 'public' : isPrivate(alias) ? 'private' : null)

  const rootImporter = lockfile.importers.get('.')
  const hoistedAliases = new Set(rootImporter ? [...importerDirectDeps(rootImporter).keys()].map((a) => a.toLowerCase()) : [])
  const hoisted = new Map()
  const consider = (alias, target) => {
    const type = hoistType(alias)
    if (type === null) return
    const key = alias.toLowerCase()
    if (hoistedAliases.has(key)) return
    hoistedAliases.add(key)
    hoisted.set(alias, { ...target, type })
  }

  // Pseudo-root children: hoisted workspace packages first, then every importer's direct deps.
  const rootChildren = new Map()
  if (settings.hoistWorkspacePackages) {
    for (const [name, dir] of workspaceDirs) rootChildren.set(name, { workspaceDir: dir })
  }
  const level0 = []
  const walked = new Set()
  for (const [id, importer] of lockfile.importers) {
    for (const [alias, ref] of importerDirectDeps(importer)) {
      const depPath = resolveDepRef(lockfile, alias, ref, `importer '${id}'`)
      if (depPath === null || skipped.has(depPath)) continue
      // First importer to name an alias wins (pnpm's directDeps reduce); a workspace package keeps its slot.
      if (!rootChildren.has(alias)) rootChildren.set(alias, { depPath })
      if (!walked.has(depPath)) {
        walked.add(depPath)
        level0.push(depPath)
      }
    }
  }
  for (const [alias, target] of rootChildren) consider(alias, target)

  let level = level0
  while (level.length > 0) {
    const next = []
    for (const depPath of level) {
      const snapshot = lockfile.snapshots.get(depPath)
      for (const [alias, ref] of snapshotChildren(snapshot)) {
        const child = resolveDepRef(lockfile, alias, ref, `snapshot '${depPath}'`)
        if (child === null || skipped.has(child)) continue
        consider(alias, { depPath: child })
        if (!walked.has(child)) {
          walked.add(child)
          next.push(child)
        }
      }
    }
    level = next
  }
  return hoisted
}

// --- the tarballs an install needs ---

// A `resolution.tarball` the lockfile records (`lockfileIncludeTarballUrl`) is an attestation of
// where the package came from, so it is checked, not merely used: an absolute http(s) URL, on the
// registry the settings designate for that package (`registry` / `@scope:registry`), naming this
// very name@version -- exactly the registry layout for the common case, or at least the name and
// version as path segments for registries with their own download paths. Anything else is a
// stale, edited or foreign lockfile entry, and fails closed.
export function assertTarballUrl(url, { name, version }, key, settings) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`stasis --pnpm: '${key}' records an invalid tarball URL in pnpm-lock.yaml: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`stasis --pnpm: '${key}' records a tarball URL with an unsupported scheme: ${url}`)
  }
  const configured = registryFor(settings, name)
  let registry
  try {
    registry = new URL(configured).href
  } catch {
    throw new Error(`stasis --pnpm: the registry configured for ${name} is not a valid URL: ${configured}`)
  }
  const base = registry.endsWith('/') ? registry : `${registry}/`
  if (!url.startsWith(base)) {
    throw new Error(`stasis --pnpm: '${key}' records a tarball URL outside its registry: ${url} (the registry for ${name} is ${base}; point registry/@scope:registry at the registry the lockfile was written against, or refresh the lockfile)`)
  }
  if (url === registryTarballUrl(name, version, base)) return
  let path
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    path = parsed.pathname
  }
  if (!path.includes(`/${name}/`) || !path.split('/').includes(version)) {
    throw new Error(`stasis --pnpm: '${key}' records a tarball URL that does not name ${name}@${version}: ${url}`)
  }
}

// One fetch entry per `packages` key some non-skipped snapshot uses. Only registry/URL tarballs
// with an integrity are fetchable; a git or directory resolution has no attested archive, so it
// is refused (a bundle built from unverifiable bytes would attest the wrong thing). A recorded
// tarball URL is asserted (see assertTarballUrl) and then used; with `lockfileIncludeTarballUrl`
// on, every registry package must record one.
export function planTarballs(lockfile, { skipped, settings, root }) {
  const needed = new Map()
  for (const [depPath, snapshot] of lockfile.snapshots) {
    if (skipped.has(depPath)) continue
    if (snapshot.packageKey.includes('(patch_hash=') || depPath.includes('(patch_hash=')) {
      throw new Error(`stasis --pnpm: '${depPath}' is a patched dependency (pnpm patchedDependencies); applying patches to the virtual tree is not supported yet`)
    }
    if (needed.has(snapshot.packageKey)) continue
    const pkg = lockfile.packages.get(snapshot.packageKey)
    const { resolution } = pkg
    if (resolution.type === 'git' || resolution.repo !== undefined) {
      throw new Error(`stasis --pnpm: '${snapshot.packageKey}' resolves from git (${resolution.repo}); git dependencies have no verifiable tarball and are not supported`)
    }
    if (resolution.type === 'directory' || resolution.directory !== undefined) {
      throw new Error(`stasis --pnpm: '${snapshot.packageKey}' resolves from a local directory (${resolution.directory}); directory dependencies are not supported (use a workspace link:)`)
    }
    let url
    let local = null
    if (typeof resolution.tarball === 'string') {
      url = resolution.tarball
      if (url.startsWith('file:')) {
        // A local tarball (`file:../x.tgz`): read from disk relative to the lockfile dir, verified like any other.
        local = resolve(root, url.slice('file:'.length))
      } else {
        assertTarballUrl(url, pkg, snapshot.packageKey, settings)
      }
    } else if (resolution.tarball !== undefined) {
      throw new Error(`stasis --pnpm: '${snapshot.packageKey}' records a non-string tarball in pnpm-lock.yaml`)
    } else {
      if (settings.lockfileIncludeTarballUrl) {
        throw new Error(`stasis --pnpm: lockfileIncludeTarballUrl is enabled but '${snapshot.packageKey}' records no tarball URL in pnpm-lock.yaml; run \`pnpm install\` to refresh the lockfile`)
      }
      url = registryTarballUrl(pkg.name, pkg.version, registryFor(settings, pkg.name))
    }
    needed.set(snapshot.packageKey, {
      key: snapshot.packageKey,
      label: snapshot.packageKey,
      url,
      local,
      // true when the lockfile itself recorded (and assertTarballUrl vetted) the URL.
      recorded: typeof resolution.tarball === 'string',
      integrity: resolution.integrity,
      headers: local ? undefined : authHeadersFor(settings, url),
    })
  }
  return [...needed.values()]
}

// --- the tree ---

// `filesFor(packageKey)` -> Map<rel, { content, mode }> (the unpacked tarball). `workspaceDirs`:
// Map<packageName, absolute dir> of the non-root importers with a package.json name.
export function buildLayout({ root, lockfile, settings, skipped, filesFor, workspaceDirs = new Map() }) {
  root = resolve(root)
  const virtualStore = resolve(root, settings.virtualStoreDir)
  const tree = new MemoryTree()
  const maxLength = settings.virtualStoreDirMaxLength
  const dirNames = new Map()
  const packageDirs = new Map()

  const storeDirFor = (depPath) => {
    let name = dirNames.get(depPath)
    if (name === undefined) {
      name = depPathToFilename(depPath, maxLength)
      dirNames.set(depPath, name)
    }
    return join(virtualStore, name)
  }
  // The directory a snapshot's own files live in.
  const packageDirFor = (depPath) => {
    let dir = packageDirs.get(depPath)
    if (dir === undefined) {
      const snapshot = lockfile.snapshots.get(depPath)
      dir = join(storeDirFor(depPath), 'node_modules', lockfile.packages.get(snapshot.packageKey).name)
      packageDirs.set(depPath, dir)
    }
    return dir
  }
  const link = (from, to) => tree.addSymlink(from, relative(dirname(from), to))

  // Root node_modules always exists on a real install (pnpm writes .modules.yaml there).
  tree.addDir(join(root, 'node_modules'))
  tree.addDir(virtualStore)

  // 1. Every non-skipped snapshot's files, then its dependency links beside it.
  for (const [depPath, snapshot] of lockfile.snapshots) {
    if (skipped.has(depPath)) continue
    const pkgDir = packageDirFor(depPath)
    const files = filesFor(snapshot.packageKey)
    for (const [rel, { content, mode }] of files) tree.addFile(join(pkgDir, rel), content, mode)
    tree.addDir(pkgDir) // an (odd) empty tarball still yields the directory
    // The store entry's node_modules (NOT dirname(pkgDir): a scoped package sits one level deeper).
    const modulesDir = join(storeDirFor(depPath), 'node_modules')
    for (const [alias, ref] of snapshotChildren(snapshot)) {
      const child = resolveDepRef(lockfile, alias, ref, `snapshot '${depPath}'`)
      const from = join(modulesDir, alias)
      if (child === null) {
        // A `link:` inside the store is relative to the lockfile dir.
        link(from, resolve(root, ref.slice('link:'.length)))
        continue
      }
      if (skipped.has(child) || from === pkgDir) continue
      link(from, packageDirFor(child))
    }
  }

  // 2. Each importer's node_modules.
  for (const [id, importer] of lockfile.importers) {
    const importerDir = resolve(root, id)
    const modulesDir = join(importerDir, 'node_modules')
    tree.addDir(modulesDir)
    for (const group of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
      for (const [alias, { version }] of group) {
        const from = join(modulesDir, alias)
        if (tree.has(from)) continue
        if (version.startsWith('link:')) {
          link(from, resolve(importerDir, version.slice('link:'.length)))
          continue
        }
        const depPath = resolveDepRef(lockfile, alias, version, `importer '${id}'`)
        if (skipped.has(depPath)) continue
        link(from, packageDirFor(depPath))
      }
    }
  }

  // 3. Hoisted fallbacks.
  const hoisted = computeHoisted(lockfile, { skipped, settings, workspaceDirs })
  const privateDir = join(virtualStore, 'node_modules')
  const publicDir = join(root, 'node_modules')
  for (const [alias, target] of hoisted) {
    const from = join(target.type === 'public' ? publicDir : privateDir, alias)
    if (tree.has(from)) continue
    link(from, target.workspaceDir ?? packageDirFor(target.depPath))
  }

  return { tree, virtualStore, hoisted, dirNames }
}
