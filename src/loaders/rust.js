// Rust loader: produces a `{ sources, resolutions, missing }` triple from a
// crate's source files, mirroring the Solidity/Bash loaders' interface. The
// reachable set is discovered by following `mod foo;` declarations (the only
// thing that pulls a new file into a crate); `use crate::path` statements
// don't add files, they just reference already-declared modules, so they're
// resolved against the module tree for the import graph but never widen the walk.
//
// `use crate::` resolution is best-effort (external crates, macro paths, and
// item-vs-module ambiguity are simply dropped). An unconditional `mod foo;`
// with no backing file is a genuine hole (a compile error in a real crate) and
// is reported in `missing` so the bundle builder can reject it; a cfg-gated
// `mod` (e.g. `#[cfg(test)] mod tests;`) may be compiled out and is tolerated.
// Comments are stripped before extraction so a commented-out `mod`/`use` is
// neither followed nor flagged.

import { realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '../util.js'

// `mod foo;` / `pub mod foo;` / `pub(crate) mod foo;` — external module
// declarations only. Inline `mod foo { ... }` is intentionally NOT matched.
// Applied per (trimmed) line, so it stays anchored at the line start.
const MOD_DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/u

// `crate::path::to::item` references (in `use` or expression position).
const USE_CRATE_RE = /\bcrate(?:::\w+)+/gu

// A `#[cfg(...)]` / `#[cfg_attr(...)]` attribute gates the next item on a build
// configuration that may be off (e.g. `#[cfg(test)]`).
const CFG_ATTR_RE = /^#\[\s*cfg(?:_attr)?\b/u

// Strip `//` line comments and `/* */` block comments so a commented-out
// `mod`/`use` isn't mistaken for a real one — a commented `mod foo;` with no
// backing file would otherwise be reported as a fatal "missing module".
// Newlines inside block comments are preserved so the per-line matching below
// stays aligned. Not string-literal aware (a `//` or `/* */` inside a string
// can't masquerade as a line-anchored `mod` decl, so it doesn't matter for
// extraction), and nested block comments aren't handled — both are acceptable
// for best-effort extraction and match the Solidity loader's fidelity.
function stripRustComments(content) {
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
  return noBlock.replace(/\/\/[^\n]*/gu, '')
}

// Extract external `mod <name>;` declarations as { name, conditional } records.
// `conditional` is true when a `#[cfg(...)]` attribute gates the declaration:
// such a module may be compiled out (e.g. `#[cfg(test)] mod tests;`), so the
// bundle builder treats its absence as tolerable rather than fatal.
export function extractModDecls(content) {
  const decls = []
  let cfgPending = false
  for (const raw of stripRustComments(content).split('\n')) {
    const line = raw.trim()
    if (line === '') continue // blank lines don't break a contiguous attribute group
    const m = MOD_DECL_RE.exec(line)
    if (m) {
      decls.push({ name: m[1], conditional: cfgPending })
      cfgPending = false
    } else if (CFG_ATTR_RE.test(line)) {
      cfgPending = true
    } else if (!line.startsWith('#[')) {
      cfgPending = false // a non-attribute line ends the attribute group
    }
  }
  return decls
}

export function extractCrateUses(content) {
  return [...stripRustComments(content).matchAll(USE_CRATE_RE)].map((m) => m[0])
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
// by walking `mod` edges out from every crate root (main.rs / lib.rs). The walk
// is iterative (a deep `mod` chain would overflow a recursive descent) and
// depth-bounded: a `seen` set stops mod cycles, and MAX_MODULE_DEPTH caps a
// pathologically deep chain — both the descent and the O(depth²) growth of the
// joined module-path strings. Real crates nest a handful deep; the cap only
// ever trims best-effort `use crate::` resolution for absurd input (file
// collection happens in collectRustFilesFromDisk, which is unaffected).
const MAX_MODULE_DEPTH = 1000

export function buildModuleTree(sources, resolutions) {
  const tree = new Map()
  for (const filePath of sources.keys()) {
    const name = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath
    if (name !== 'main.rs' && name !== 'lib.rs') continue
    const seen = new Set()
    const stack = [[filePath, 'crate', 0]]
    while (stack.length > 0) {
      const [path, modulePath, depth] = stack.pop()
      tree.set(modulePath, path)
      if (seen.has(path) || depth >= MAX_MODULE_DEPTH) continue
      seen.add(path)
      const specMap = resolutions.get(path)
      if (!specMap) continue
      for (const [spec, resolved] of specMap) {
        if (!spec.startsWith('mod ')) continue
        stack.push([resolved, `${modulePath}::${spec.slice(4)}`, depth + 1])
      }
    }
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
// An unconditional `mod foo;` with no file is recorded in `missing` (the
// bundle builder treats it as fatal); a cfg-gated `mod`, unresolved `crate::`
// references, and self/duplicate references are omitted.
export function buildRustTree(sources) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const { name, conditional } of extractModDecls(content)) {
      const resolved = resolveModPath(name, path, { knownSources: sources })
      if (resolved) {
        specMap.set(`mod ${name}`, resolved)
      } else if (!conditional) {
        console.warn(`[loader.rust] Missing module: ${name} from ${path}`)
        missing.push({ spec: `mod ${name}`, from: path })
      }
      // conditional && unresolved: a cfg-gated module that may be compiled out
      // (e.g. #[cfg(test)] mod tests;) — tolerated, not a fatal hole.
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
  const realBase = realpathSync(baseDir)

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          assertRealPathWithinBase(realBase, baseDir, relPath)
          return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.rust] Missing file: ${relPath}`)
            return null
          }
          // resolveModPath gates candidates with isFile so a directory is
          // normally never queued; guard EISDIR anyway (symmetry with bash).
          if (err.code === 'EISDIR') {
            console.warn(`[loader.rust] Skipping directory reference: ${relPath}`)
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
      for (const { name } of extractModDecls(content)) {
        const resolved = resolveModPath(name, relPath, { baseDir })
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
// Returns { sources, resolutions, missing }.
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
