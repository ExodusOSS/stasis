import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

// Helpers the static bundlers share. The deep bundler (@exodus/stasis) and the zero-dep
// `add` packer (bundle-cmd.js, here in stasis-core) both need to read package.json `type`,
// find the nearest name+version package.json for a file, normalize CLI entries to
// project-relative paths, and parse JSON defensively. They live in stasis-core because the
// dependency only goes one way: `stasis` imports `stasis-core`, never the reverse.

// Module system for a `.js`/`.ts` file, read from the nearest package.json `type`, or null
// when there is none / it's unrecognized (the caller then falls back to syntax detection, or
// -- in `add`, which never parses -- to commonjs).
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

// Walk up from the file's directory looking for the nearest package.json with both `name` and
// `version`. Returns { pkgDir, name, version } (pkgDir relative to `baseDir`, "." for the
// project root) or null when no such package.json exists at or above the file.
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
    // On Windows `path.relative()` returns an absolute path across drives -- that wouldn't
    // start with `..` but still escapes, so reject both forms.
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
