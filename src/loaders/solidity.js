// Based on DeepView's Solidity loader.
// https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js
//
// Adapted to produce a `{ sources, resolutions }` pair only. The mapping
// file (foundry.toml or remappings.txt) is read to extract `remappings`,
// but is itself not included in `sources`.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

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

// Resolve a Solidity import specifier to a baseDir-relative POSIX path,
// trying three strategies in order:
//   1. user remappings (longest prefix wins)
//   2. relative path (`./...` or `../...`); traversal above the project
//      root returns null instead of clamping
//   3. Node's CJS resolver via createRequire, anchored at the importing
//      source — only when `baseDir` is provided and the specifier looks
//      like a scoped npm package (`@scope/pkg/sub/path`)
// Returns null when no strategy resolves the import.
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

  // Node-style `@scope/pkg/sub/path`. createRequire is anchored at the
  // importing source so nested node_modules resolve like Node would
  // (a file under `node_modules/foo/` finds its deps in
  // `foo/node_modules/` before walking up). `..` segments in the
  // subpath are rejected so a crafted specifier can't escape the
  // resolved package via require.resolve's own path normalization.
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

  return null
}

// Build the { sources, resolutions, missing } triple from a Map of
// already-loaded Solidity sources plus optional remappings. Imports that
// resolve via remappings/relative/Node win; as a final fallback an
// import specifier that matches a stored key verbatim (etherscan
// bundles, hardhat flat layouts) is accepted. `missing` lists every
// (spec, from) pair that could not be resolved or that resolved to a
// file not loaded into `sources`.
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

// Walk the filesystem starting from `entries`, following resolved
// imports and reading each file exactly once. Files in the same wave
// are read in parallel; the next wave depends on the imports
// discovered in the previous one. Caller-listed entries are also
// accepted as verbatim non-relative import targets (Foundry-style
// `import "src/A.sol"`).
export async function collectSolidityFilesFromDisk(baseDir, entries, remappings) {
  const sources = new Map()
  const knownEntries = new Set(entries)

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
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

// Read a foundry.toml or remappings.txt mapping file and return its parsed
// remappings. The mapping file itself is NOT included in the loaded sources.
export async function readRemappingsFile(mappingFile) {
  const content = await readFile(mappingFile, 'utf8')
  if (mappingFile.endsWith('.toml')) return parseRemappingsFromToml(content)
  return parseRemappings(content)
}

// Reject absolute paths and `..`-escaping paths in a `.sol.txt` listing so
// a malicious or sloppy listing can't trick the loader into reading
// arbitrary files outside the listing's own directory.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level: takes an optional .sol.txt listing file. The first line may
// be a `*.toml` or `remappings.txt` mapping file (resolved relative to the
// listing); the remaining lines are `*.sol` files. Mirrors the DeepView
// loader's interface.
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
