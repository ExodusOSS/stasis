// Based on DeepView's Solidity loader.
// https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js
//
// Adapted to produce a `{ sources, resolutions }` pair only. The mapping
// file (foundry.toml or remappings.txt) is read to extract `remappings`,
// but is itself not included in `sources`.

import { readFile } from 'node:fs/promises'
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

// Returns a candidate resolved path, or null if the specifier doesn't match
// any remapping and isn't a relative import. The caller is responsible for
// checking whether the resolved path actually exists in `sources` (the
// etherscan bundle's cnames are exact-match keys — `@openzeppelin/…` lives
// alongside `contracts/Foo.sol` — so a non-relative, non-remapped specifier
// may still be a hit when matched verbatim against the bundle). Logging
// "Missing import" also lives at the callsite because only the callsite
// knows whether that verbatim fallback matched.
export function resolveSolImport(specifier, fromFile, remappings) {
  // Try remappings (longest prefix match)
  let best = null
  for (const { prefix, target } of remappings) {
    if (specifier.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, target }
    }
  }
  if (best) {
    const target = best.target.replace(/\/$/u, '')
    const remaining = specifier.slice(best.prefix.length).replace(/^\//u, '')
    const result = remaining ? `${target}/${remaining}` : target
    return result.replace(/^\.\//u, '')
  }

  // Relative import. `..` segments that would traverse above the project
  // root return null instead of silently clamping to root — clamping would
  // change the import target into something the source never asked for.
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

  return null
}

// Build the { sources, resolutions } pair from a Map of already-loaded
// Solidity sources (any key format — relative paths for disk-loaded
// projects, `${address}/${cname}` for etherscan, etc.) plus optional
// remappings. Imports that resolve via remappings/relative paths win; as a
// fallback we also accept an import specifier that matches a stored key
// verbatim (etherscan bundles imports like `@openzeppelin/contracts/.../
// IERC20.sol` which is itself a stored cname).
export function buildSolidityTree(sources, { remappings = [] } = {}) {
  const resolutions = new Map()
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractSolImports(content)) {
      let resolved = resolveSolImport(spec, path, remappings)
      if (resolved && !sources.has(resolved)) resolved = null
      // Verbatim fallback: many Solidity ecosystems (etherscan bundles,
      // hardhat flat layouts) ship `@openzeppelin/...` imports as literal
      // keys in the source map. If the remap/relative resolution didn't
      // hit but the bundle has the specifier itself as a key, use it.
      if (!resolved && sources.has(spec)) resolved = spec
      if (resolved) specMap.set(spec, resolved)
      else console.warn(`[loader.solidity] Missing import: ${spec} from ${path}`)
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions }
}

// Walk the filesystem starting from `entries`, following relative/remapped
// imports and reading each file exactly once. Returns a Map<relPath, content>
// suitable for passing into buildSolidityTree. Files in the same wave are
// read in parallel; subsequent waves depend on the imports discovered in
// the previous one.
//
// Specifiers that exactly match one of the explicit entries (the file
// list passed by the caller) are accepted as-is, even when they don't
// match any remapping. Solidity projects routinely write
// `import "src/A.sol"` and rely on solc's include-path / Foundry's
// remap-from-root behavior; here we don't have a true include path,
// but if the caller listed `src/A.sol` themselves we know the path is
// intentional and resolves to that file. Mirrors the `sources.has(spec)`
// fallback in `buildSolidityTree`, but applied during the walk so the
// file actually gets loaded into `sources`.
export async function collectSolidityFilesFromDisk(baseDir, entries, remappings) {
  const sources = new Map()
  const knownEntries = new Set(entries)

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    // A resolved path that doesn't exist on disk is treated like an
    // unresolved import: warn and skip rather than aborting the entire
    // walk. Other read errors (EACCES, EIO, …) still propagate.
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
        let resolved = resolveSolImport(spec, relPath, remappings)
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
  return buildSolidityTree(sources, { remappings })
}
