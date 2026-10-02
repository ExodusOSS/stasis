import { constants } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { packageJSONStat, packageJSONText, readJson } from '@exodus/stasis-core/bundle-util'
import { byName } from '@exodus/stasis-core/host'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { buildPnpmTree, findPnpmProjects } from '@preventive/deptree/pnpm.js'
import { LockfileError, TomlError, buildSoldeerTree } from '@preventive/deptree/soldeer.js'
import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
import { VfsError } from '@preventive/vfs'
import { createNodeResolver } from '../resolve-node.js'
import { settleSoldeer } from './soldeer.js'
import { isDir, isFile } from '../resolve-typescript.js'

// A project's dependencies laid out in memory from its lockfile by @preventive/deptree, as `pnpm
// install --frozen-lockfile --ignore-scripts` lays out its node_modules with pnpm 10, 11 or 12, `yarn
// install --frozen-lockfile --ignore-scripts` with yarn 1.22, or `soldeer install` its dependencies
// folder with Soldeer 0.12, and the host that reads the project through them. The project is read
// through a host it is given, and nothing else.

// cwd or the nearest of its ancestors that `holds`, or null.
function nearest(cwd, holds) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (holds(dir)) return dir
    if (dirname(dir) === dir) return null
  }
}

// Whether a directory holds a file of one of `names`.
const holding = (host, ...names) => (dir) => names.some((name) => isFile(join(dir, name), host))

// The directory of the package cwd is in that is none of `projects` (their directories from
// `root`), or null: the nearest package.json with a name between cwd and `root`, one without being a
// `type` marker.
function outsider(host, root, cwd, projects) {
  for (let dir = cwd; dir !== root; dir = dirname(dir)) {
    const file = join(dir, 'package.json')
    if (!isFile(file, host)) continue
    if (projects.has(relative(root, dir))) return null
    const json = readJson(file, host) // unreadable, a package all the same
    if (json === null || json.name !== undefined) return dir
  }
  return null
}

// `promise`, a refusal of @preventive/lockfile's naming `file` (deptree names the files it reads but
// for yarn.lock and soldeer.lock).
const naming = (file, promise) => promise.catch((cause) => {
  if (!(cause instanceof LockfileError || cause instanceof TomlError)) throw cause
  throw new Error(`${file}: ${cause.message}`, { cause })
})

// The directory `root` as `host` holds it, by paths from `/`, as deptree reads a project.
function projectView(host, root) {
  const at = (p) => (p === '/' ? root : join(root, p))
  const typeOf = (st) => (st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other')
  const stat = (p) => {
    const st = host.stat(at(p))
    if (st === null) throw new VfsError('ENOENT', p)
    return st
  }
  return {
    readdir: (p) => host.readdir(at(p)).map((d) => d.name),
    lstat(p) {
      if (host.readlink(at(p)) !== null) return { type: 'symlink', mode: 0o777 }
      const st = stat(p)
      return { type: typeOf(st), mode: st.mode & 0o777 }
    },
    stat: (p) => ({ type: typeOf(stat(p)) }),
    readFile: (p) => host.readFile(at(p)),
  }
}

// What pnpm matches packages' `libc` against (as deptree's host.libc takes it).
const LIBCS = new Set(['glibc', 'musl', 'unknown'])

// pnpm's libc, detect-libc's familySync, by its check of Node's report alone (it reads
// /usr/bin/ldd first): unknown where that can't tell, which pnpm then installs everything for.
// The report leaves out the network, whose reverse DNS can stall.
let machineLibc
function currentLibc() {
  if (machineLibc !== undefined) return machineLibc
  machineLibc = 'unknown'
  if (process.platform !== 'linux' || !process.report) return machineLibc
  const { excludeNetwork } = process.report
  try {
    process.report.excludeNetwork = true
    const report = process.report.getReport()
    if (report.header?.glibcVersionRuntime) machineLibc = 'glibc'
    else if (report.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-'))) machineLibc = 'musl'
  } catch { /* unknown */ } finally {
    process.report.excludeNetwork = excludeNetwork
  }
  return machineLibc
}

const machine = () => ({ node: process.versions.node, os: process.platform, cpu: process.arch })

// The machine a tree is laid out for: this one, but for the `os`, `cpu` and `libc` given. A libc is
// detected only for this machine's os; for another, unless given, pnpm matches none ('unknown').
const target = ({ os, cpu, libc } = {}) => {
  const here = machine()
  const forOs = os ?? here.os
  return { node: here.node, os: forOs, cpu: cpu ?? here.cpu, libc: libc ?? (forOs === here.os ? currentLibc() : 'unknown') }
}

// `os` and `cpu` as Node names them (process.platform, process.arch); `libc` is pnpm's alone, and
// Soldeer takes `os` alone: what a package manager matches nothing against changes nothing.
export function checkTarget(name, { os, cpu, libc }) {
  for (const [key, value] of Object.entries({ os, cpu })) {
    if (value !== undefined && (typeof value !== 'string' || value === '')) throw new TypeError(`${name}: ${key} must be a non-empty string`)
  }
  if (libc !== undefined && !LIBCS.has(libc)) throw new TypeError(`${name}: libc must be one of 'glibc', 'musl', 'unknown'`)
}

// yarn installs a workspace from the root that declares it, whatever yarn.lock is nearer, and any
// other package from the nearest yarn.lock.
function yarn1Root(host, cwd) {
  const workspaces = (dir) => {
    const declared = readJson(join(dir, 'package.json'), host)?.workspaces
    return Boolean(Array.isArray(declared) ? declared : declared?.packages)
  }
  const root = nearest(cwd, workspaces)
  if (root !== null && outsider(host, root, cwd, new Set(findYarn1Workspaces({ project: projectView(host, root) }))) === null) return root
  return nearest(cwd, holding(host, 'yarn.lock'))
}

// What each package manager reproduced installs from: the kind of bundle it installs for; its
// lockfile; the name a root package.json's packageManager pins it by, where one does; the version
// reproduced where nothing pins one; the directory it installs cwd from, which holds the lockfile;
// whether a directory holding the lockfile is installed from by itself, by the names in it and in
// each directory above it (`above()`, as listings); the projects it finds in a view of that
// directory; the directory it installs in each, and any it hides, as another package manager's; and
// the tree.
const PACKAGE_MANAGERS = {
  pnpm: {
    kind: 'js',
    lockfile: 'pnpm-lock.yaml',
    pin: 'pnpm',
    version: '10.33.4',
    // pnpm installs from the workspace's root, whatever pnpm-lock.yaml is nearer.
    root: (host, cwd) => nearest(cwd, holding(host, 'pnpm-workspace.yaml')) ?? nearest(cwd, holding(host, 'pnpm-lock.yaml')),
    alone: async (names, above) => !(await above()).some((dir) => dir.includes('pnpm-workspace.yaml')),
    projects: (view, pnpm) => findPnpmProjects({ project: view, host: { pnpm } }),
    installs: 'node_modules',
    build: (view, pnpm, _file, given) => buildPnpmTree({ project: view, host: { pnpm, ...target(given) } }),
  },
  yarn1: {
    kind: 'js',
    lockfile: 'yarn.lock',
    pin: 'yarn',
    version: '1.22.22',
    root: yarn1Root,
    // A package.json above may declare it a workspace.
    alone: async (names, above) => !(await above()).some((dir) => dir.includes('package.json')),
    projects: (view) => findYarn1Workspaces({ project: view }),
    installs: 'node_modules',
    build: (view, yarn, file, given) => {
      const { libc: _, ...host } = target({ ...given, libc: 'unknown' }) // yarn 1 matches no libc
      return naming(file, buildYarn1Tree({ project: view, host: { yarn, ...host } }))
    },
  },
  soldeer: {
    kind: 'sol',
    lockfile: 'soldeer.lock',
    version: '0.12.0',
    // Soldeer installs from the nearest directory holding foundry.toml or soldeer.toml, never above
    // the git repository's root; without one, from that root, else from cwd.
    root: (host, cwd) => nearest(cwd, (dir) => holding(host, 'foundry.toml', 'soldeer.toml')(dir) || isDir(join(dir, '.git'), host)) ?? cwd,
    alone: async (names, above) => names.includes('foundry.toml') || names.includes('soldeer.toml') || !(await above()).some((dir) => dir.includes('foundry.toml') || dir.includes('soldeer.toml')),
    projects: () => ['.'],
    installs: 'dependencies',
    hides: 'node_modules',
    async build(view, soldeer, file, given) {
      const tree = await naming(file, buildSoldeerTree({ project: view, host: { soldeer, os: given?.os ?? process.platform } }))
      settleSoldeer(view, tree.vfs, dirname(file))
      return tree
    },
  },
}

// layOutTree's tree, with the host reading `project` through it: the tree serves what the package
// manager installs, and any file it writes beside it at the root.
export async function loadTree(options) {
  const tree = await layOutTree(options)
  const pm = PACKAGE_MANAGERS[options.packageManager]
  const files = tree.vfs.readdir('/').filter((name) => tree.vfs.lstat(`/${name}`).type === 'file')
  const installs = [...[...tree.projects].map((dir) => join(dir, pm.installs)), ...files]
  return { ...tree, host: vfsHost(tree.vfs, { root: tree.root, outside: options.project, installs, hides: pm.hides }) }
}

// The lockfile `packageManager` installs from, e.g. 'pnpm-lock.yaml'.
export const lockfileOf = (packageManager) => PACKAGE_MANAGERS[packageManager].lockfile

// Whether `packageManager` installs a directory holding its lockfile from that directory itself, by
// the names in it and, from `above()`, the names in each directory above it.
export const installedAlone = (packageManager, names, above) => PACKAGE_MANAGERS[packageManager].alone(names, above)

// The real path of the directory the project `vfs` holds at `cwd` is installed from, which holds the
// lockfile and which a bundle's paths are relative to; null without one.
export function lockfileRoot(vfs, packageManager, cwd) {
  const host = vfsHost(vfs)
  const pm = PACKAGE_MANAGERS[packageManager]
  const found = pm.root(host, host.realpath(cwd))
  return found !== null && isFile(join(found, pm.lockfile), host) ? host.realpath(found) : null
}

// The PACKAGE_MANAGERS entry of `packageManager`, which has to be one of `names`.
export function packageManagerOf(name, packageManager, names = Object.keys(PACKAGE_MANAGERS)) {
  if (!names.includes(packageManager)) throw new TypeError(`${name}: packageManager must be one of ${names.map((n) => `'${n}'`).join(', ')}`)
  return PACKAGE_MANAGERS[packageManager]
}

// Anything read as a @preventive/vfs Vfs: a Vfs of another copy of the package is one too.
export function checkVfs(name, vfs) {
  for (const method of ['lstat', 'readdir', 'readFile', 'readlink']) {
    if (typeof vfs?.[method] !== 'function') throw new TypeError(`${name}: vfs must be a @preventive/vfs Vfs holding the project`)
  }
}

// -> { root, vfs, projects, stats, packageManager, packageManagerVersion }, of the project `project`
// holds that `cwd` is in, as `packageManager` installs it: the directory it installs from, as a real
// path; a new Vfs holding the tree, rooted there; the directories of the projects it finds, from
// there; deptree's counts; and the version reproduced, `packageManagerVersion` if given, else the one
// the root package.json's packageManager pins, else the default. deptree reads the project through a
// view of `project`, which nothing is written through.
async function layOutTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc }) {
  const pm = PACKAGE_MANAGERS[packageManager]
  const found = pm.root(project, cwd)
  if (found === null) throw new Error(`no ${pm.lockfile} found in ${cwd} or any parent directory`)
  const file = join(found, pm.lockfile)
  if (!isFile(file, project)) throw new Error(`no ${pm.lockfile} found in ${found}, where ${cwd} is installed from`)
  const pinned = pm.pin === undefined ? undefined : readJson(join(found, 'package.json'), project)?.packageManager
  // Left out, deptree takes the one packageManager pins, and refuses another package manager.
  const version = packageManagerVersion ?? (pinned === undefined ? pm.version : undefined)
  const view = projectView(project, found)
  const projects = new Set(pm.projects(view, version))
  const other = pm.kind === 'js' ? outsider(project, found, cwd, projects) : null
  if (other !== null) throw new Error(`${file} does not install ${other}: it is none of the lockfile's projects`)
  const { vfs, stats } = await pm.build(view, version, file, { os, cpu, libc })
  return {
    root: project.realpath(found),
    vfs,
    projects,
    stats,
    packageManager,
    packageManagerVersion: version ?? (String(pinned).startsWith(`${pm.pin}@`) ? /^[^@]+@([^+]+)/u.exec(pinned)[1] : undefined),
  }
}

// fs.Stats#mode carries the file type above the permission bits a Vfs stat holds.
const TYPE_BITS = { file: constants.S_IFREG, directory: constants.S_IFDIR, symlink: constants.S_IFLNK }

const statsFor = (st) => ({
  isFile: () => st.type === 'file',
  isDirectory: () => st.type === 'directory',
  isSymbolicLink: () => st.type === 'symlink',
  mode: TYPE_BITS[st.type] | st.mode,
})

const dirent = (name, type) => ({
  name,
  isFile: () => type === 'file',
  isDirectory: () => type === 'directory',
  isSymbolicLink: () => type === 'symlink',
})

// A view over the Vfs's bytes, never a copy.
const asBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// What `vfs` holds at `p` itself (the last link not followed), or null.
function lstatOrNull(vfs, p) {
  try {
    return vfs.lstat(p)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
    throw err
  }
}

const TREE = 'tree'
const NONE = 'none'
const OUTSIDE = 'outside'

const invalidPackageConfig = (path, cause) => Object.assign(new Error(`Invalid package config ${path}.`, { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' })

// A `host` (@exodus/stasis-core/host) over `vfs`. Alone, every path is the Vfs's. With `root`, a
// real path, and `outside`, a host of the rest, the Vfs's `/` stands for `root`, holding the tree
// the package manager lays out there: each of the paths it `installs` (from `root`) is served from
// the Vfs only, whatever `outside` holds there; a directory named `hides` anywhere, and any
// node_modules out of `root`, is none; and everything else comes from `outside`. Symlinks cross
// between the two both ways, so realpaths are walked here one link at a time. A relative path is
// from `/`. What it reads is cached, as for a tree that holds still, unless `cache` is false.
export function vfsHost(vfs, { root, outside, installs = [], hides, cache = true } = {}) {
  if (sep !== '/') throw new Error('The Vfs host is POSIX-only')
  const disk = outside ?? null
  const installed = new Set(installs)
  // Paths here are absolute and normal.
  const prefix = disk === null || root === '/' ? '/' : `${root}/`
  // The root and the directories above it, whatever their names.
  const towardRoot = (p) => p === root || prefix.startsWith(`${p}/`)
  const zoneOf = (p) => {
    if (disk === null) return TREE
    if (!p.startsWith(prefix)) return hasNodeModulesSegment(p) && !towardRoot(p) ? NONE : OUTSIDE
    const rel = p.slice(prefix.length)
    for (let at = rel.indexOf('/'); at !== -1; at = rel.indexOf('/', at + 1)) {
      if (installed.has(rel.slice(0, at))) return TREE
    }
    if (installed.has(rel)) return TREE
    return hides !== undefined && rel.split('/').includes(hides) ? NONE : OUTSIDE
  }
  // The names of the installed paths in each directory holding one.
  const installedIn = new Map()
  for (const dir of disk === null ? [] : installed) {
    const at = join(root, dirname(dir))
    installedIn.set(at, [...(installedIn.get(at) ?? []), basename(dir)])
  }
  // A path in the tree, as the Vfs spells it.
  const inVfs = disk === null ? (p) => p : (p) => `/${p.slice(prefix.length)}`
  const abs = (p) => resolve('/', p)
  const memo = () => (cache ? new Map() : { get() {}, set() {} })

  // `p` is a real path but for its last name; null when it exists and isn't a link.
  const readlink = (p) => {
    const zone = zoneOf(p)
    if (zone === OUTSIDE) return disk.readlink(p)
    if (zone === NONE) throw new VfsError('ENOENT', p)
    const node = lstatOrNull(vfs, inVfs(p))
    if (node === null) throw new VfsError('ENOENT', p)
    return node.type === 'symlink' ? vfs.readlink(inVfs(p)) : null
  }

  const realCache = memo()
  const realpath = (p, hops = 0) => {
    if (p === '/') return '/'
    const hit = realCache.get(p)
    if (hit !== undefined) {
      if (hit instanceof Error) throw hit
      return hit
    }
    let result
    try {
      const parentReal = realpath(dirname(p), hops)
      const candidate = join(parentReal, basename(p))
      const link = readlink(candidate)
      if (link === null) {
        result = candidate
      } else {
        if (hops >= 40) throw new VfsError('ELOOP', p)
        result = realpath(resolve(dirname(candidate), link), hops + 1)
      }
    } catch (err) {
      if (hops === 0 && (err.code === 'ENOENT' || err.code === 'ELOOP')) realCache.set(p, err)
      throw err
    }
    realCache.set(p, result)
    return result
  }

  const nodeOf = (real) => {
    const node = lstatOrNull(vfs, inVfs(real))
    if (node === null) throw new VfsError('ENOENT', real)
    return node
  }

  // Node's findPackageJSON refuses a manifest that is no JSON object.
  const manifestErrors = memo()
  const checkManifest = (path) => {
    let error = manifestErrors.get(path)
    if (error === undefined) {
      error = null
      try {
        const data = JSON.parse(packageJSONText(host.readFile(path)))
        if (data === null || typeof data !== 'object' || Array.isArray(data)) error = invalidPackageConfig(path)
      } catch (cause) {
        error = invalidPackageConfig(path, cause)
      }
      manifestErrors.set(path, error)
    }
    if (error !== null) throw error
  }

  const statCache = memo()
  const statOf = (real) => {
    if (zoneOf(real) === OUTSIDE) return disk.stat(real)
    let stats = statCache.get(real)
    if (stats === undefined) {
      const node = lstatOrNull(vfs, inVfs(real))
      stats = node !== null && node.type !== 'symlink' ? statsFor(node) : null
      statCache.set(real, stats)
    }
    return stats
  }
  // A path ending in `/` or `/.` names a directory, which path.resolve drops.
  const namesDir = (p) => p.endsWith('/') || p.endsWith('/.')
  const checkDir = (p, real) => {
    if (namesDir(p) && statOf(real)?.isDirectory() === false) throw new VfsError('ENOTDIR', p)
  }

  const host = {
    stat(p) {
      let real
      try {
        real = realpath(abs(p))
      } catch {
        return null
      }
      const stats = statOf(real)
      return stats !== null && namesDir(p) && !stats.isDirectory() ? null : stats
    },
    readFile(p) {
      const real = realpath(abs(p))
      checkDir(p, real)
      if (zoneOf(real) === OUTSIDE) return disk.readFile(real)
      if (nodeOf(real).type !== 'file') throw new VfsError('EISDIR', p)
      return asBuffer(vfs.readFile(inVfs(real)))
    },
    readdir(p) {
      const real = realpath(abs(p))
      if (zoneOf(real) === TREE) {
        if (nodeOf(real).type !== 'directory') throw new VfsError('ENOTDIR', p)
        const dir = inVfs(real)
        return vfs.readdir(dir).map((name) => dirent(name, vfs.lstat(join(dir, name)).type)).toSorted(byName)
      }
      // An outside directory shows the tree's installed paths in place of its own, and nothing that
      // is none.
      const out = disk.readdir(real).filter((d) => zoneOf(join(real, d.name)) === OUTSIDE)
      for (const name of installedIn.get(real) ?? []) {
        const node = lstatOrNull(vfs, inVfs(join(real, name)))
        if (node !== null) out.push(dirent(name, node.type))
      }
      return out.toSorted(byName)
    },
    readlink(p) {
      if (namesDir(p)) {
        checkDir(p, realpath(abs(p)))
        return null
      }
      p = abs(p)
      return readlink(join(realpath(dirname(p)), basename(p)))
    },
    realpath(p) {
      return realpath(abs(p))
    },
    // As Node's: the nearest package.json above a file's real path, never out of a node_modules dir;
    // one there that can't be read is refused (packageJSONStat).
    findPackageJSON(p) {
      let from = abs(p)
      if (host.stat(from)?.isFile()) from = realpath(from)
      for (let dir = dirname(from); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
        const candidate = join(dir, 'package.json')
        if (packageJSONStat(host, candidate)?.isFile()) {
          checkManifest(candidate)
          return candidate
        }
        if (dirname(dir) === dir) break
      }
      return undefined
    },
    resolve(parentFile, specifier, conditions) {
      return (resolver ?? createNodeResolver(host)).resolve(abs(parentFile), specifier, conditions)
    },
  }
  const resolver = cache ? createNodeResolver(host) : undefined
  return host
}
