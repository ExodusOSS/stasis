// Based on DeepView's Solidity loader.
// https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js
// Produces a `{ sources, resolutions }` pair; the mapping file (foundry.toml /
// remappings.txt) is read for `remappings` but not included in `sources`.

import { realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

const SOL_IMPORT_RE = /import\s[^"']*["']([^"']+)["']/gu

export function extractSolImports(content) {
  return [...content.matchAll(SOL_IMPORT_RE)].map((m) => m[1])
}

export function parseRemappingsFromToml(tomlContent) {
  const match = tomlContent.match(/remappings\s*=\s*\[([\s\S]*?)\]/u)
  if (!match) return []
  return parseRemappings([...match[1].matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]).join('\n'))
}

export function parseRemappings(content) {
  return content.trim().split('\n').map((entry) => {
    const eqIdx = entry.indexOf('=')
    if (eqIdx === -1) return null
    return { prefix: entry.slice(0, eqIdx), target: entry.slice(eqIdx + 1) }
  }).filter(Boolean)
}

// Resolve a Solidity import to a baseDir-relative POSIX path, trying in order:
// (1) remappings (longest prefix wins); (2) relative `./`/`../` (root-escape ->
// null, not clamped); (3) Node CJS resolver for scoped npm packages
// (`@scope/pkg/...`); (4) project-relative fallback if the file exists. Returns
// null when nothing resolves.
export function resolveSolImport(specifier, fromFile, { remappings = [], baseDir } = {}) {
  let best = null
  for (const { prefix, target } of remappings) {
    if (specifier.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, target }
    }
  }
  if (best) {
    const target = best.target.replace(/\/$/u, '')
    const remaining = specifier.slice(best.prefix.length).replace(/^\//u, '')
    return (remaining ? `${target}/${remaining}` : target).replace(/^\.\//u, '')
  }

  if (specifier.startsWith('.')) {
    const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
    const parts = [...(fromDir ? fromDir.split('/') : []), ...specifier.split('/')]
    const resolved = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') {
        if (resolved.length === 0) return null
        resolved.pop()
      } else {
        resolved.push(part)
      }
    }
    return resolved.join('/')
  }

  // Node-style `@scope/pkg/sub/path`. createRequire is anchored at the importing
  // source so nested node_modules resolve like Node. `..` segments in the subpath
  // are rejected so a crafted specifier can't escape the resolved package.
  if (baseDir && specifier.startsWith('@')) {
    const parts = specifier.split('/')
    if (parts.length < 3) return null
    if (parts.slice(2).includes('..')) return null
    try {
      const abs = createRequire(resolve(baseDir, fromFile)).resolve(specifier)
      const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
      if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
    } catch { /* package missing, exports map blocks the subpath, … */ }
  }

  // Project-relative fallback: accept the spec as-is if a real file sits at
  // `<baseDir>/<spec>`. The isFile() guard keeps directories out of the read
  // queue (they'd surface as EISDIR mid-walk). Only bare specs reach here.
  if (baseDir && !isAbsolute(specifier)) {
    const rel = relative(baseDir, resolve(baseDir, specifier)).split(/[\\/]/u).join('/')
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
      try {
        if (statSync(join(baseDir, rel)).isFile()) return rel
      } catch { /* missing or not statable */ }
    }
  }

  return null
}

// Build `{ sources, resolutions, missing }` from already-loaded Solidity sources
// plus optional remappings. Imports resolve via remappings/relative/Node; as a
// final fallback a specifier matching a stored key verbatim is accepted. `missing`
// lists every (spec, from) pair that didn't resolve or resolved outside `sources`.
export function buildSolidityTree(sources, { remappings = [], baseDir } = {}) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractSolImports(content)) {
      let resolved = resolveSolImport(spec, path, { remappings, baseDir })
      if (resolved && !sources.has(resolved)) resolved = null
      if (!resolved && sources.has(spec)) resolved = spec
      if (resolved) {
        specMap.set(spec, resolved)
      } else {
        console.warn(`[loader.solidity] Missing import: ${spec} from ${path}`)
        missing.push({ spec, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem from `entries`, following resolved imports and reading each
// file once (same-wave reads run in parallel). Caller-listed entries are also
// accepted as verbatim non-relative import targets (Foundry-style `import "src/A.sol"`).
export async function collectSolidityFilesFromDisk(baseDir, entries, remappings) {
  const sources = new Map()
  const knownEntries = new Set(entries)
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
            console.warn(`[loader.solidity] Missing import: ${relPath}`)
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
      for (const spec of extractSolImports(content)) {
        let resolved = resolveSolImport(spec, relPath, { remappings, baseDir })
        if (!resolved && knownEntries.has(spec)) resolved = spec
        if (resolved) {
          if (!sources.has(resolved)) next.push(resolved)
        } else {
          console.warn(`[loader.solidity] Missing import: ${spec} from ${relPath}`)
        }
      }
    }
    await processWave(next)
  }

  await processWave(entries)
  return sources
}

// Read a foundry.toml/remappings.txt mapping file -> parsed remappings (the file
// itself is not added to sources).
export async function readRemappingsFile(mappingFile) {
  const content = await readFile(mappingFile, 'utf8')
  if (mappingFile.endsWith('.toml')) return parseRemappingsFromToml(content)
  return parseRemappings(content)
}

// Reject absolute and `..`-escaping paths in a `.sol.txt` listing so it can't
// trick the loader into reading files outside the listing's directory.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level entry: a `.sol.txt` listing whose optional first line is a
// `*.toml`/`remappings.txt` mapping file (resolved relative to the listing); the
// remaining lines are `*.sol` files.
export async function loadSolidity(solTxtFile) {
  const baseDir = dirname(resolve(solTxtFile))
  const listing = await readFile(solTxtFile, 'utf8')
  const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error(`Empty Solidity listing: ${solTxtFile}`)

  let remappings = []
  if (lines[0].endsWith('.toml') || lines[0].endsWith('remappings.txt')) {
    const mapping = lines.shift()
    assertWithinBase(baseDir, mapping, 'Mapping path')
    remappings = await readRemappingsFile(join(baseDir, mapping))
  }

  if (!lines.every((line) => line.endsWith('.sol'))) {
    throw new Error(`Solidity listing must only contain .sol files: ${solTxtFile}`)
  }

  const entries = lines.map((l) => l.replace(/^\.\//u, ''))
  for (const e of entries) assertWithinBase(baseDir, e, 'Entry path')
  const sources = await collectSolidityFilesFromDisk(baseDir, entries, remappings)
  return buildSolidityTree(sources, { remappings, baseDir })
}
