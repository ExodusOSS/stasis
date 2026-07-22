import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

import { assertRealPathWithinBase } from './util.js'

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

// Read a bundled module's `package.json` for the `packageJSON` auto-include option, applying the
// rules shared by the State (`run`/plain `bundle`) and resolved (`--metro`/`--mainFields`) paths:
// skip (null) when absent on disk; reject a manifest whose real path escapes the root (like every
// bundled read); ABORT on non-UTF-8 bytes (never silently skipped). When `identity` is given -- the
// State path, whose module buckets may be ABSORBED from a prior bundle -- skip a manifest whose
// on-disk name/version has drifted from the bundled bucket rather than bundle a manifest describing
// different bytes than the bundled code. `rel` is the project-relative manifest path; returns the
// raw bytes to bundle, or null to skip.
export function readModuleManifest({ baseDir, realBase, rel, identity } = {}) {
  const absolute = join(baseDir, rel)
  if (!existsSync(absolute)) return null
  assertRealPathWithinBase(realBase, baseDir, rel)
  const buf = readFileSync(absolute)
  if (!isUtf8(buf)) throw new Error(`package.json is not valid UTF-8: ${rel}`)
  if (identity !== undefined) {
    let pkg
    try { pkg = JSON.parse(buf.toString()) } catch { return null } // malformed manifest for an untouched bucket: skip
    if (pkg?.name !== identity.name || pkg?.version !== identity.version) return null
  }
  return buf
}

// Parse a JSON file, returning null on a missing/unreadable/malformed file instead of throwing.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
