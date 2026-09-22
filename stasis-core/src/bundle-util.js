import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

import { assertRealPathWithinBase, hasNodeModulesSegment, toPosix } from './util.js'

// Several readers here take an optional `host` -- the filesystem view of `stasis bundle --pnpm`'s
// in-memory node_modules ({ stat, readFile, realpath, exists }; see stasis/src/pnpm/vfs.js). With
// none given they read the real disk exactly as before.

// Nearest package.json for `file` through `host`, never walking up out of a node_modules dir --
// Node's own findPackageJSON rule, so the two agree on which manifest scopes a file.
function findPackageJSONThrough(file, host) {
  let dir = dirname(file)
  while (true) {
    if (basename(dir) === 'node_modules') return undefined
    const candidate = join(dir, 'package.json')
    if (host.stat(candidate)?.isFile()) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function packageType(file, host) {
  const pkg = host ? findPackageJSONThrough(file, host) : findPackageJSON(pathToFileURL(file).toString())
  if (!pkg) return null
  try {
    const type = JSON.parse((host ? host.readFile(pkg) : readFileSync(pkg)).toString('utf8')).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Nearest package.json (walking up) that identifies a bucket; pkgDir is relative to baseDir ("."
// at the root). Inside node_modules both name and version are required; a workspace package
// outside node_modules may omit version (the name alone claims the bucket, matching
// State#locateModule). Null if none. `host` (optional) reads through a virtual filesystem.
export function findPackageMetadata(baseDir, fileRelPath, host) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (host ? host.stat(pkgPath)?.isFile() : existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse((host ? host.readFile(pkgPath) : readFileSync(pkgPath)).toString('utf8'))
        if (pkg.name && (pkg.version || !hasNodeModulesSegment(toPosix(dir)))) {
          // `?? undefined` folds a literal `"version": null` into the one absent-version spelling.
          return { pkgDir: dir, name: pkg.name, version: pkg.version ?? undefined }
        }
      } catch { /* malformed -- keep walking */ }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = toPosix(relative(baseDir, abs))
    // On Windows path.relative() returns an absolute path across drives (no leading '..'), so reject that form too.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

// Bytes of a bundled module's `package.json`, or null to skip when it's absent on disk; non-UTF-8 aborts (never silently skipped).
export function readModuleManifest({ baseDir, realBase, rel, host } = {}) {
  const absolute = join(baseDir, rel)
  if (!(host ? host.exists(absolute) : existsSync(absolute))) return null
  assertRealPathWithinBase(realBase, baseDir, rel, host)
  const buf = host ? host.readFile(absolute) : readFileSync(absolute)
  if (!isUtf8(buf)) throw new Error(`package.json is not valid UTF-8: ${rel}`)
  return buf
}

// Never throws: a missing/unreadable/malformed file yields null.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
