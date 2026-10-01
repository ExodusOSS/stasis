import { constants } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { byName } from '@exodus/stasis-core/host'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { LockfileError as TreeLockfileError, YamlError as TreeYamlError, buildPnpmTree, findPnpmProjects } from '@preventive/deptree/pnpm.js'
import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
import { LockfileError, YamlError, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { VfsError } from '@preventive/vfs'
import { createNodeResolver } from '../resolve-node.js'

// A project's node_modules laid out in memory from its lockfile by @preventive/deptree, as
// `pnpm install --frozen-lockfile --ignore-scripts` lays it out with pnpm 10 or 11, or `yarn
// install --frozen-lockfile --ignore-scripts` with yarn 1.22, and the host that reads the project
// through it. The project is read through a host it is given, and nothing else.

// The text of the file `host` holds at `p`, or undefined.
const readText = (host, p) => (host.stat(p)?.isFile() ? host.readFile(p).toString('utf8') : undefined)

// cwd or its nearest ancestor holding `name`, the lockfile (a workspace keeps one at its root).
function findLockfileRoot(host, cwd, name) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (host.stat(join(dir, name))?.isFile()) return dir
    if (dirname(dir) === dir) return null
  }
}

// @preventive/lockfile's refusals: of the copy pnpm-lock.yaml is checked with here, and of the one
// deptree reads with, which may be another.
const LOCKFILE_ERRORS = [LockfileError, YamlError, TreeLockfileError, TreeYamlError]

// What `read` gives back, or a promise of it, a refusal of @preventive/lockfile's naming `file`.
function naming(file, read) {
  const rename = (cause) => {
    if (!LOCKFILE_ERRORS.some((type) => cause instanceof type)) throw cause
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
  try {
    const result = read()
    return result instanceof Promise ? result.catch(rename) : result
  } catch (cause) {
    return rename(cause)
  }
}

// pnpm-lock.yaml is read before deptree reads it, to name it in a refusal.
function checkPnpmLockfile(host, file) {
  const parsed = naming(file, () => parsePnpmLockfile(readText(host, file)))
  if (parsed.lockfile === undefined) {
    throw new Error(`${file} holds pnpm's env document alone and no lockfile for the project; run \`pnpm install\` first`)
  }
}

// The package cwd is in, the nearest package.json with a name above it, has to be one of the
// `projects` the package manager finds: another is a project of its own, installed from its own
// lockfile.
function checkProject(host, root, cwd, projects, file) {
  for (let dir = cwd; dir !== root; dir = dirname(dir)) {
    const text = readText(host, join(dir, 'package.json'))
    if (text === undefined) continue
    if (projects.has(relative(root, dir))) return
    let name
    try {
      name = JSON.parse(text)?.name
    } catch {
      name = null // unreadable, a package all the same
    }
    if (name === undefined) continue // a `type` marker
    throw new Error(`${file} does not install ${dir}: it is none of the lockfile's projects`)
  }
}

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

// pnpm's libc, detect-libc's familySync, by its check of Node's report alone (it reads
// /usr/bin/ldd first): unknown where that can't tell, which pnpm then installs everything for.
// The report leaves out the network, whose reverse DNS can stall.
let libc
function currentLibc() {
  if (libc !== undefined) return libc
  libc = 'unknown'
  if (process.platform !== 'linux' || !process.report) return libc
  const { excludeNetwork } = process.report
  try {
    process.report.excludeNetwork = true
    const report = process.report.getReport()
    if (report.header?.glibcVersionRuntime) libc = 'glibc'
    else if (report.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-'))) libc = 'musl'
  } catch { /* unknown */ } finally {
    process.report.excludeNetwork = excludeNetwork
  }
  return libc
}

const machine = () => ({ node: process.versions.node, os: process.platform, cpu: process.arch })

// What each package manager reproduced installs from: its lockfile, the name the root
// package.json's packageManager pins it by, the version reproduced where that pins none, the
// projects it finds in a view of the lockfile's directory, and the tree it lays out from there.
const PACKAGE_MANAGERS = {
  pnpm: {
    lockfile: 'pnpm-lock.yaml',
    name: 'pnpm',
    version: '10.33.4',
    check: checkPnpmLockfile,
    projects: (view, root, pnpm) => naming(join(root, 'pnpm-workspace.yaml'), () => findPnpmProjects({ project: view, host: { pnpm } })),
    build: (view, pnpm) => buildPnpmTree({ project: view, host: { pnpm, ...machine(), libc: currentLibc() } }),
  },
  yarn1: {
    lockfile: 'yarn.lock',
    name: 'yarn',
    version: '1.22.22',
    check: () => {},
    projects: (view) => findYarn1Workspaces({ project: view }),
    build: (view, yarn) => buildYarn1Tree({ project: view, host: { yarn, ...machine() } }),
  },
}

// layOutTree's tree, with the host reading `project` through it.
export async function loadTree(options) {
  const tree = await layOutTree(options)
  return { ...tree, host: vfsHost(tree.vfs, { root: tree.root, outside: options.project, projects: tree.projects }) }
}

export function checkPackageManager(name, packageManager) {
  if (!Object.hasOwn(PACKAGE_MANAGERS, packageManager)) throw new TypeError(`${name}: packageManager must be one of ${Object.keys(PACKAGE_MANAGERS).map((n) => `'${n}'`).join(', ')}`)
}

// -> { root, vfs, projects, stats, packageManager, packageManagerVersion }, of the project `project`
// holds that `cwd` is in, as `packageManager` installs it: the lockfile's directory, as a real path;
// a new Vfs holding the tree, rooted there; the directories of the projects it finds, from there;
// deptree's counts; and the version reproduced, `packageManagerVersion` if given, else the one the
// root package.json's packageManager pins, else the default. deptree reads the project through a
// view of `project`, which nothing is written through.
async function layOutTree({ project, packageManager, cwd, packageManagerVersion }) {
  const pm = PACKAGE_MANAGERS[packageManager]
  const found = findLockfileRoot(project, cwd, pm.lockfile)
  if (found === null) throw new Error(`no ${pm.lockfile} found in ${cwd} or any parent directory`)
  const file = join(found, pm.lockfile)
  pm.check(project, file)
  let manifest
  try {
    manifest = JSON.parse(readText(project, join(found, 'package.json')))
  } catch { /* deptree refuses it */ }
  // Left out, deptree takes the one packageManager pins, and refuses another package manager.
  const version = packageManagerVersion ?? (manifest?.packageManager === undefined ? pm.version : undefined)
  const view = projectView(project, found)
  const projects = new Set(pm.projects(view, found, version))
  checkProject(project, found, cwd, projects, file)
  const { vfs, stats } = await naming(file, () => pm.build(view, version))
  const pinned = String(manifest?.packageManager).startsWith(`${pm.name}@`) ? /^[^@]+@([^+]+)/u.exec(manifest.packageManager)[1] : undefined
  return { root: project.realpath(found), vfs, projects, stats, packageManager, packageManagerVersion: version ?? pinned }
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
    if (err instanceof VfsError && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null
    throw err
  }
}

const TREE = 'tree'
const NONE = 'none'
const OUTSIDE = 'outside'

const invalidPackageConfig = (path, cause) => Object.assign(new Error(`Invalid package config ${path}.`, { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' })

// A `host` (@exodus/stasis-core/host) over `vfs`. Alone, every path is the Vfs's. With `root`, a
// real path, and `outside`, a host of the rest, the Vfs's `/` stands for `root`, holding the tree
// the package manager lays out there: the node_modules of each of `projects` (their directories
// from `root`) is served from the Vfs only, whatever `outside` holds there; any other node_modules
// out of `root` is none; and everything else comes from `outside`. Symlinks cross between the two
// both ways, so realpaths are walked here one link at a time. A relative path is from `/`. What it
// reads is cached, as for a tree that holds still, unless `cache` is false.
export function vfsHost(vfs, { root, outside, projects = ['.'], cache = true } = {}) {
  if (sep !== '/') throw new Error('The virtual node_modules host is POSIX-only')
  if (typeof vfs?.lstat !== 'function') throw new TypeError('vfs must be a @preventive/vfs Vfs')
  const disk = outside ?? null
  const managed = new Set(projects)
  // Paths here are absolute and normal.
  const prefix = disk === null || root === '/' ? '/' : `${root}/`
  // The root and the directories above it, whatever their names.
  const towardRoot = (p) => p === root || prefix.startsWith(`${p}/`)
  const zoneOf = (p) => {
    if (disk === null) return TREE
    if (!p.startsWith(prefix)) return hasNodeModulesSegment(p) && !towardRoot(p) ? NONE : OUTSIDE
    const names = p.slice(prefix.length).split('/')
    const at = names.indexOf('node_modules')
    return at !== -1 && managed.has(names.slice(0, at).join('/') || '.') ? TREE : OUTSIDE
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
        const data = JSON.parse(host.readFile(path).toString('utf8'))
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
      // An outside directory shows the tree's node_modules in place of its own, and none out of
      // `root`.
      const out = disk.readdir(real).filter((d) => zoneOf(join(real, d.name)) === OUTSIDE)
      const nm = join(real, 'node_modules')
      if (zoneOf(nm) === TREE && lstatOrNull(vfs, inVfs(nm))?.type === 'directory') out.push(dirent('node_modules', 'directory'))
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
    // As Node's: the nearest package.json above a file's real path, never out of a node_modules dir.
    findPackageJSON(p) {
      let from = abs(p)
      if (host.stat(from)?.isFile()) from = realpath(from)
      for (let dir = dirname(from); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
        const candidate = join(dir, 'package.json')
        if (host.stat(candidate)?.isFile()) {
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
