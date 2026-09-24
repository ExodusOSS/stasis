import * as fs from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { VfsError } from '@preventive/vfs'

// The overlay host that serves a pnpm lockfile's in-memory node_modules to a reader (the `host`
// surface `@exodus/stasis`' static bundler reads through; see its src/host.js for the contract).
// The memory layer is a @preventive/vfs `Vfs` holding the layout at the project's real absolute
// paths (a Vfs resolves every path from `/`, so the host's paths are its paths, no translation).
// The overlay is strict about its zone: under the project root, every path with a `node_modules`
// segment is served from the Vfs ONLY -- whatever install happens to sit on disk is invisible --
// while the workspace's own sources come from disk. Symlinks cross both ways (an importer's link
// into the store, a `link:` dependency out to a workspace directory), so the overlay walks
// realpaths itself, one link at a time, asking each zone only what sits at a name.
//
// Host surface (all paths absolute):
//   stat(p) -> { isFile(), isDirectory(), isSymbolicLink(), mode } | null   (follows symlinks)
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

const dirent = (name, type) => ({
  name,
  isFile: () => type === 'file',
  isDirectory: () => type === 'directory',
  isSymbolicLink: () => type === 'symlink',
})

// A `Dirent` from node:fs reduced to the plain shape hosts return.
const fromFsDirent = (d) => dirent(d.name, d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other')

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// fs.Stats#mode carries the file type above the permission bits a Vfs stat holds.
const TYPE_BITS = { file: 0o100000, directory: 0o40000, symlink: 0o120000 }

const statsFor = (st) => ({
  isFile: () => st.type === 'file',
  isDirectory: () => st.type === 'directory',
  isSymbolicLink: () => st.type === 'symlink',
  mode: TYPE_BITS[st.type] | st.mode,
})

// The Vfs's own bytes, as the Buffer the host contract promises: a view, never a copy (and the
// contract's readers never write into it).
const asBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// A host over `vfs` for the node_modules zone under `root` and the real disk everywhere else.
// `makeResolver(host)` builds the module resolver lazily (the resolution algorithm belongs to the
// bundler, so it is injected rather than imported here).
export function createOverlayHost({ root, vfs, makeResolver }) {
  root = resolve(root)
  if (sep !== '/') throw new Error('The virtual pnpm host is POSIX-only')
  if (typeof vfs?.lstat !== 'function') throw new TypeError('createOverlayHost: vfs must be a @preventive/vfs Vfs')
  if (typeof makeResolver !== 'function') throw new TypeError('createOverlayHost: makeResolver(host) is required')

  // Under root AND containing a node_modules segment: memory only.
  const inVirtualZone = (p) => {
    const rel = relative(root, p)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
    return rel.split('/').includes('node_modules')
  }

  // What the Vfs holds at `p` itself (the last link not followed), or null when nothing is there.
  // `p` is a real path but for its last name, so the Vfs walks plain directories to it; a path
  // through something that is not one reads as absent, as a missing one does.
  const nodeAt = (p) => {
    try {
      return vfs.lstat(p)
    } catch (err) {
      if (err instanceof VfsError && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null
      throw err
    }
  }

  // Symlink target of `p` (memory or disk, per zone); null when `p` exists and isn't a link.
  const readlink = (p) => {
    if (inVirtualZone(p)) {
      const node = nodeAt(p)
      if (node === null) throw fsError('ENOENT', 'no such file or directory', p)
      return node.type === 'symlink' ? vfs.readlink(p) : null
    }
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (st === undefined) throw fsError('ENOENT', 'no such file or directory', p)
    return st.isSymbolicLink() ? readlinkSync(p) : null
  }

  // Memoized per path (the Vfs is immutable for the build and the disk is assumed still), so the
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

  // The Vfs node at a real path, which has to be there.
  const nodeOf = (real) => {
    const node = nodeAt(real)
    if (node === null) throw fsError('ENOENT', 'no such file or directory', real)
    return node
  }

  const host = {
    virtual: true,
    root,
    vfs,
    inVirtualZone,
    stat(p) {
      let real
      try {
        real = realpath(resolve(p))
      } catch {
        return null
      }
      if (inVirtualZone(real)) {
        const node = nodeAt(real)
        return node !== null && node.type !== 'symlink' ? statsFor(node) : null
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
        const node = nodeAt(candidate)
        return node === null ? null : statsFor(node)
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
        if (nodeOf(real).type !== 'file') throw fsError('EISDIR', 'illegal operation on a directory', p)
        return asBuffer(vfs.readFile(real))
      }
      return readFileSync(real)
    },
    readdir(p) {
      const real = realpath(resolve(p))
      if (inVirtualZone(real)) {
        if (nodeOf(real).type !== 'directory') throw fsError('ENOTDIR', 'not a directory', p)
        return vfs.readdir(real).map((name) => dirent(name, vfs.lstat(join(real, name)).type)).toSorted(byName)
      }
      // A disk directory under root shows the VIRTUAL node_modules (if any), never the real one.
      const nm = join(real, 'node_modules')
      const masked = inVirtualZone(nm)
      const out = readdirSync(real, { withFileTypes: true })
        .filter((d) => d.name !== 'node_modules' || !masked)
        .map(fromFsDirent)
      if (masked && nodeAt(nm)?.type === 'directory') out.push(dirent('node_modules', 'directory'))
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
