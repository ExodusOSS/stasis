import * as fs from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

// Snapshotted before `stasis run --fs` patches node:fs, whose realpathSync doesn't throw ENOENT and
// whose statSync answers with synthetic modes.
const { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } = fs

export const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

let lastParent
let lastRequire

export const diskHost = {
  stat(p) {
    try {
      return statSync(p, { throwIfNoEntry: false }) ?? null
    } catch {
      return null
    }
  },
  readFile: (p) => readFileSync(p),
  readdir: (p) => readdirSync(p, { withFileTypes: true }).toSorted(byName),
  readlink: (p) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null),
  realpath: (p) => realpathSync(p),
  findPackageJSON: (p) => findPackageJSON(pathToFileURL(p).href),
  resolve(parentFile, specifier, conditions) {
    if (parentFile !== lastParent) {
      lastRequire = createRequire(parentFile)
      lastParent = parentFile
    }
    return lastRequire.resolve(specifier, { conditions })
  },
}
