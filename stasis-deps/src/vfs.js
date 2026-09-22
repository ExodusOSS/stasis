import * as fs from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The in-memory filesystem a pnpm lockfile is laid out into, and the overlay host that serves it
// to a reader (the `host` surface `@exodus/stasis`' static bundler reads through; see its
// src/host.js for the contract). The overlay is strict about its zone: under the project root,
// every path with a `node_modules` segment is served from the memory tree ONLY -- whatever install
// happens to sit on disk is invisible -- while the workspace's own sources come from disk.
//
// Host surface (all paths absolute):
//   stat(p) -> { isFile(), isDirectory(), mode } | null      (follows symlinks)
//   lstat(p) -> { isFile(), isDirectory(), isSymbolicLink(), mode } | null
//   readFile(p) -> Buffer                                    (throws ENOENT / EISDIR)
//   readdir(p) -> [{ name, isFile(), isDirectory(), isSymbolicLink() }] sorted by name
//   realpath(p) -> string                                    (throws ENOENT / ELOOP)
//   exists(p) -> boolean
//   resolve(parentFile, specifier, conditions: Set) -> string (via the injected `makeResolver`)
//   virtual: true

// Snapshot the genuine fs functions: a host must never read through a monkey-patched node:fs.
const { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } = fs

function fsError(code, message, path) {
  const err = new Error(`${code}: ${message}, '${path}'`)
  err.code = code
  err.path = path
  return err
}

const dirent = (name, kind) => ({
  name,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'symlink',
})

// A `Dirent` from node:fs reduced to the plain shape hosts return.
const fromFsDirent = (d) => dirent(d.name, d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other')

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// An in-memory tree of files, directories and symlinks keyed by absolute path. Parent directories
// are implied; a path can hold one node (re-adding a different kind is a layout bug, so it throws).
export class MemoryTree {
  #nodes = new Map()

  get size() {
    return this.#nodes.size
  }

  get(p) {
    return this.#nodes.get(p)
  }

  has(p) {
    return this.#nodes.has(p)
  }

  #ensureDir(p) {
    const existing = this.#nodes.get(p)
    if (existing) {
      if (existing.kind !== 'dir') throw new Error(`virtual fs: ${p} is a ${existing.kind}, not a directory`)
      return existing
    }
    const node = { kind: 'dir', children: new Set() }
    this.#nodes.set(p, node)
    if (p !== '/') this.#ensureDir(dirname(p)).children.add(basename(p))
    return node
  }

  #place(p, node) {
    if (!isAbsolute(p)) throw new Error(`virtual fs: path must be absolute: ${p}`)
    const existing = this.#nodes.get(p)
    if (existing) {
      if (existing.kind === node.kind && node.kind === 'symlink' && existing.target === node.target) return
      throw new Error(`virtual fs: ${p} already exists (${existing.kind})`)
    }
    this.#ensureDir(dirname(p)).children.add(basename(p))
    this.#nodes.set(p, node)
  }

  addDir(p) {
    this.#ensureDir(resolve(p))
  }

  addFile(p, content, mode = 0o644) {
    if (!Buffer.isBuffer(content)) throw new TypeError(`virtual fs: file content must be a Buffer: ${p}`)
    this.#place(resolve(p), { kind: 'file', content, mode: mode & 0o777 })
  }

  // `target` is stored verbatim (relative targets resolve against the link's directory, like readlink).
  addSymlink(p, target) {
    this.#place(resolve(p), { kind: 'symlink', target })
  }

  // Every path in the tree (files, dirs and links), for diagnostics/tests.
  paths() {
    return [...this.#nodes.keys()].toSorted()
  }
}

// A host over `tree` for the node_modules zone under `root` and the real disk everywhere else.
// `makeResolver(host)` builds the module resolver lazily (the resolution algorithm belongs to the
// bundler, so it is injected rather than imported here).
export function createOverlayHost({ root, tree, makeResolver }) {
  root = resolve(root)
  if (sep !== '/') throw new Error('The virtual pnpm host is POSIX-only')
  if (typeof makeResolver !== 'function') throw new TypeError('createOverlayHost: makeResolver(host) is required')

  // Under root AND containing a node_modules segment: memory only.
  const inVirtualZone = (p) => {
    const rel = relative(root, p)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
    return rel.split('/').includes('node_modules')
  }

  // Symlink target of `p` (memory or disk, per zone); null when `p` exists and isn't a link.
  const readlink = (p) => {
    if (inVirtualZone(p)) {
      const node = tree.get(p)
      if (!node) throw fsError('ENOENT', 'no such file or directory', p)
      return node.kind === 'symlink' ? node.target : null
    }
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (st === undefined) throw fsError('ENOENT', 'no such file or directory', p)
    return st.isSymbolicLink() ? readlinkSync(p) : null
  }

  // Memoized per path (the tree is immutable for the build and the disk is assumed still), so the
  // scanner's many probes of one package cost one walk per directory prefix.
  const realCache = new Map()
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
        if (hops >= 40) throw fsError('ELOOP', 'too many levels of symbolic links', p)
        result = realpath(resolve(dirname(candidate), link), hops + 1)
      }
    } catch (err) {
      if (hops === 0 && (err.code === 'ENOENT' || err.code === 'ELOOP')) realCache.set(p, err)
      throw err
    }
    realCache.set(p, result)
    return result
  }

  const nodeAt = (real) => {
    const node = tree.get(real)
    if (!node) throw fsError('ENOENT', 'no such file or directory', real)
    return node
  }

  const statsFor = (node, symlink = false) => ({
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => symlink,
    mode: node.kind === 'file' ? (node.mode | 0o100000) : node.kind === 'dir' ? 0o40755 : 0o120777,
  })

  const host = {
    virtual: true,
    root,
    tree,
    inVirtualZone,
    stat(p) {
      let real
      try {
        real = realpath(resolve(p))
      } catch {
        return null
      }
      if (inVirtualZone(real)) {
        const node = tree.get(real)
        return node && node.kind !== 'symlink' ? statsFor(node) : null
      }
      try {
        return statSync(real, { throwIfNoEntry: false }) ?? null
      } catch {
        return null
      }
    },
    lstat(p) {
      p = resolve(p)
      let parentReal
      try {
        parentReal = realpath(dirname(p))
      } catch {
        return null
      }
      const candidate = join(parentReal, basename(p))
      if (inVirtualZone(candidate)) {
        const node = tree.get(candidate)
        return node ? statsFor(node, node.kind === 'symlink') : null
      }
      try {
        return lstatSync(candidate, { throwIfNoEntry: false }) ?? null
      } catch {
        return null
      }
    },
    readFile(p) {
      const real = realpath(resolve(p))
      if (inVirtualZone(real)) {
        const node = nodeAt(real)
        if (node.kind !== 'file') throw fsError('EISDIR', 'illegal operation on a directory', p)
        return node.content
      }
      return readFileSync(real)
    },
    readdir(p) {
      const real = realpath(resolve(p))
      if (inVirtualZone(real)) {
        const node = nodeAt(real)
        if (node.kind !== 'dir') throw fsError('ENOTDIR', 'not a directory', p)
        return [...node.children].map((name) => {
          const child = tree.get(join(real, name))
          return dirent(name, child.kind)
        }).toSorted(byName)
      }
      // A disk directory under root shows the VIRTUAL node_modules (if any), never the real one.
      const out = readdirSync(real, { withFileTypes: true })
        .filter((d) => d.name !== 'node_modules' || !inVirtualZone(join(real, 'node_modules')))
        .map(fromFsDirent)
      const nm = join(real, 'node_modules')
      if (inVirtualZone(nm) && tree.get(nm)?.kind === 'dir') out.push(dirent('node_modules', 'dir'))
      return out.toSorted(byName)
    },
    realpath(p) {
      return realpath(resolve(p))
    },
    exists(p) {
      return host.stat(p) !== null
    },
    resolve(parentFile, specifier, conditions) {
      return resolver().resolve(parentFile, specifier, conditions)
    },
  }
  let _resolver
  const resolver = () => (_resolver ??= makeResolver(host))
  return host
}
