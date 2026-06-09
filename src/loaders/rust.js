// Rust loader: produces a `{ sources, resolutions }` pair from a crate's
// source files, mirroring the Solidity/Bash loaders' interface. The reachable
// set is discovered by following `mod foo;` declarations (the only thing that
// pulls a new file into a crate); `use crate::path` statements don't add
// files, they just reference modules already declared, so they're resolved
// against the module tree for the import graph but never widen the walk.
//
// Resolution of `use crate::` references is best-effort (external crates,
// macro paths, and item-vs-module ambiguity are simply dropped), but a
// `mod foo;` with no backing file is reported in `missing` so the bundle
// builder can reject it — an unresolvable `mod` is a genuine hole (and a
// compile error in a real crate). Only `mod` edges widen the file set.

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

// `mod foo;` / `pub mod foo;` / `pub(crate) mod foo;` — external module
// declarations only. Inline `mod foo { ... }` is intentionally NOT matched.
const MOD_DECL_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gmu

// `crate::path::to::item` references (in `use` or expression position).
const USE_CRATE_RE = /\bcrate(?:::\w+)+/gu

export function extractModDecls(content) {
  return [...content.matchAll(MOD_DECL_RE)].map((m) => m[1])
}

export function extractCrateUses(content) {
  return [...content.matchAll(USE_CRATE_RE)].map((m) => m[0])
}

// The directory where this file's submodules live, per Rust's path rules:
//   - crate roots (main.rs/lib.rs) and mod.rs hold submodules as siblings
//   - any other foo.rs holds them under a foo/ subdirectory
export function getModuleDir(filePath) {
  const lastSlash = filePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
  if (name === 'main.rs' || name === 'lib.rs' || name === 'mod.rs') return dir
  const stem = name.replace(/\.rs$/u, '')
  return dir ? `${dir}/${stem}` : stem
}

// Resolve a `mod <name>;` declaration to the baseDir-relative file that
// defines it, trying `<dir>/<name>.rs` then `<dir>/<name>/mod.rs`. Existence
// is checked against `knownSources` (tree mode) or the filesystem under
// `baseDir` (walk mode); returns null when neither finds a file.
export function resolveModPath(modName, fromFile, { knownSources, baseDir } = {}) {
  const modDir = getModuleDir(fromFile)
  const base = modDir ? `${modDir}/${modName}` : modName
  const candidates = [`${base}.rs`, `${base}/mod.rs`]

  if (knownSources) return candidates.find((c) => knownSources.has(c)) ?? null
  if (baseDir) {
    for (const c of candidates) {
      try {
        if (statSync(join(baseDir, c)).isFile()) return c
      } catch { /* missing — try the next candidate */ }
    }
  }
  return null
}

// Build a `module path -> file` map (e.g. "crate::foo::bar" -> "src/foo/bar.rs")
// by walking `mod` edges out from every crate root (main.rs / lib.rs). The
// `seen` guard keeps a pathological mod cycle from recursing forever.
export function buildModuleTree(sources, resolutions) {
  const tree = new Map()
  const walk = (filePath, modulePath, seen) => {
    tree.set(modulePath, filePath)
    if (seen.has(filePath)) return
    seen.add(filePath)
    const specMap = resolutions.get(filePath)
    if (!specMap) return
    for (const [spec, resolved] of specMap) {
      if (!spec.startsWith('mod ')) continue
      walk(resolved, `${modulePath}::${spec.slice(4)}`, seen)
    }
  }
  for (const filePath of sources.keys()) {
    const name = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath
    if (name === 'main.rs' || name === 'lib.rs') walk(filePath, 'crate', new Set())
  }
  return tree
}

// Resolve a `crate::a::b::Item` path to the file of the deepest module along
// it (the trailing item names aren't modules), e.g. `crate::foo::Bar` ->
// the file for `crate::foo`. Returns null when no prefix names a module.
export function resolveUsePath(usePath, moduleTree) {
  const parts = usePath.split('::')
  for (let i = parts.length; i >= 1; i--) {
    const modulePath = parts.slice(0, i).join('::')
    if (moduleTree.has(modulePath)) return moduleTree.get(modulePath)
  }
  return null
}

// Build the { sources, resolutions, missing } triple from a Map of
// already-loaded Rust sources. Two-phase: resolve `mod` edges (which also
// defines the module tree), then resolve `crate::` references against it.
// A `mod foo;` with no file is recorded in `missing` (the bundle builder
// treats it as fatal); unresolved `crate::` references are best-effort and
// simply omitted, as are self- and duplicate references.
export function buildRustTree(sources) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const modName of extractModDecls(content)) {
      const resolved = resolveModPath(modName, path, { knownSources: sources })
      if (resolved) {
        specMap.set(`mod ${modName}`, resolved)
      } else {
        console.warn(`[loader.rust] Missing module: ${modName} from ${path}`)
        missing.push({ spec: `mod ${modName}`, from: path })
      }
    }
    resolutions.set(path, specMap)
  }

  const moduleTree = buildModuleTree(sources, resolutions)
  for (const [path, content] of sources) {
    const specMap = resolutions.get(path)
    for (const usePath of extractCrateUses(content)) {
      const resolved = resolveUsePath(usePath, moduleTree)
      if (resolved && resolved !== path && !specMap.has(usePath)) {
        specMap.set(usePath, resolved)
      }
    }
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem from `entries`, following `mod` declarations and reading
// each reachable file once. A `mod` whose file is missing on disk warns and is
// skipped; the walk continues. Files in a wave are read in parallel.
export async function collectRustFilesFromDisk(baseDir, entries) {
  const sources = new Map()

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.rust] Missing file: ${relPath}`)
            return null
          }
          throw err
        }
      })
    )
    const next = []
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content] = entry
      sources.set(relPath, content)
      for (const modName of extractModDecls(content)) {
        const resolved = resolveModPath(modName, relPath, { baseDir })
        if (resolved && !sources.has(resolved)) next.push(resolved)
      }
    }
    await processWave(next)
  }

  await processWave(entries)
  return sources
}

// Reject absolute paths and `..`-escaping paths in a `.rs.txt` listing so a
// malicious or sloppy listing can't read files outside the listing's own dir.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level: takes a `.rs.txt` listing whose lines are crate entry points
// (typically src/main.rs or src/lib.rs), resolved relative to the listing.
// Walks `mod` declarations from there, then resolves `crate::` references.
// Returns { sources, resolutions }.
export async function loadRust(rsTxtFile) {
  const baseDir = dirname(resolve(rsTxtFile))
  const listing = await readFile(rsTxtFile, 'utf8')
  const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^\.\//u, ''))
  if (lines.length === 0) throw new Error(`Empty Rust listing: ${rsTxtFile}`)

  if (!lines.every((line) => extname(line) === '.rs')) {
    throw new Error(`Rust listing must only contain .rs files: ${rsTxtFile}`)
  }
  for (const line of lines) assertWithinBase(baseDir, line, 'Entry path')

  const sources = await collectRustFilesFromDisk(baseDir, lines)
  return buildRustTree(sources)
}
