import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

// Module system from the nearest package.json `type`, or null when absent/unrecognized.
export function packageType(file) {
  const pkg = findPackageJSON(pathToFileURL(file).toString())
  if (!pkg) return null
  try {
    const type = JSON.parse(readFileSync(pkg, 'utf8')).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Nearest package.json (walking up) that has both name and version; returns { pkgDir, name, version } (pkgDir relative to baseDir, "." for root) or null.
export function findPackageMetadata(baseDir, fileRelPath) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name && pkg.version) return { pkgDir: dir, name: pkg.name, version: pkg.version }
      } catch { /* malformed -- keep walking */ }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Map the given CLI entries to POSIX, project-relative paths, rejecting any that escape cwd.
export function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    // On Windows path.relative() returns an absolute path across drives (no leading '..'), so reject that form too.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

// Parse a JSON file, returning null on a missing/unreadable/malformed file instead of throwing.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
