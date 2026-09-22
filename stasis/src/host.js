import * as fs from 'node:fs'
import { createRequire } from 'node:module'

// The filesystem view the static JS bundler reads through. Every reader the scanner, the
// resolvers and the materializer use goes through a `host`, so the same code runs over the real
// disk (this module's `diskHost`) or over an in-memory node_modules laid out from a pnpm lockfile
// (`@exodus/stasis-deps`' overlay host, behind `stasis bundle --pnpm`).
//
// Host surface (all paths absolute):
//   stat(p) -> { isFile(), isDirectory(), mode } | null      (follows symlinks)
//   lstat(p) -> { isFile(), isDirectory(), isSymbolicLink(), mode } | null
//   readFile(p) -> Buffer                                    (throws ENOENT / EISDIR)
//   readdir(p) -> [{ name, isFile(), isDirectory(), isSymbolicLink() }] sorted by name
//   realpath(p) -> string                                    (throws ENOENT / ELOOP)
//   exists(p) -> boolean
//   resolve(parentFile, specifier, conditions: Set) -> string (Node CJS resolution; throws with .code)
//   virtual: boolean

// Snapshot the genuine fs functions: `stasis run --fs` patches node:fs, and a host must never
// read through a patch.
const { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } = fs

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// A `Dirent` from node:fs reduced to the plain shape hosts return.
const fromFsDirent = (d) => {
  const kind = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
  return {
    name: d.name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  }
}

// The real filesystem, resolving through Node's own `require.resolve` (byte-for-byte what the
// runtime does, NODE_PATH and all) -- the host the plain `stasis bundle` path always used.
export const diskHost = {
  virtual: false,
  stat(p) {
    try {
      return statSync(p, { throwIfNoEntry: false }) ?? null
    } catch {
      return null
    }
  },
  lstat(p) {
    try {
      return lstatSync(p, { throwIfNoEntry: false }) ?? null
    } catch {
      return null
    }
  },
  readFile(p) {
    return readFileSync(p)
  },
  readdir(p) {
    return readdirSync(p, { withFileTypes: true }).map(fromFsDirent).toSorted(byName)
  },
  realpath(p) {
    return realpathSync(p)
  },
  exists(p) {
    return existsSync(p)
  },
  resolve(parentFile, specifier, conditions) {
    return createRequire(parentFile).resolve(specifier, { conditions })
  },
}
