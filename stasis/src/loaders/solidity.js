// Based on DeepView's Solidity loader.
// https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js
// Produces a `{ sources, resolutions }` pair. Imports resolve the way solc does under the project's
// build tool: remappings (discovered the way `forge build` does for a Foundry project, see
// foundry.js), then solc's base path (the project root), a Foundry library's include path, and
// Hardhat's/Node's node_modules lookup. The mapping/config files are read, not added to `sources`.

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase, toPosix } from '@exodus/stasis-core/util'
import { isDir, isFile } from '../resolve-typescript.js'
import { FOUNDRY_TOML, REMAPPINGS_TXT, foundryProfile, foundryProject, foundryTomlRemappings, parseRemappingLines, toSolcRemapping } from './foundry.js'

// --- Import scan ------------------------------------------------------------------------------

// The scan's ASCII classes, by char code: identifier start [A-Za-z_$], identifier part [\w$], digit,
// and a number literal's [\w.].
const isIdentStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36
const isDigit = (c) => c >= 48 && c <= 57
const isIdentPart = (c) => isIdentStart(c) || isDigit(c)
const isNumberPart = (c) => (isIdentPart(c) && c !== 36) || c === 46
const STRING_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

// A string literal starting at `text[i]` (a quote): `{ value, end }`, `value` null when it's
// unterminated on its line (solc rejects those).
function readStringLiteral(text, i) {
  const quote = text[i]
  let value = ''
  let j = i + 1
  while (j < text.length) {
    const ch = text[j]
    if (ch === quote) return { value, end: j + 1 }
    if (ch === '\n') return { value: null, end: j }
    if (ch === '\\') {
      const next = text[j + 1]
      if (next === 'x' && /^[\da-f]{2}$/iu.test(text.slice(j + 2, j + 4))) {
        value += String.fromCodePoint(Number.parseInt(text.slice(j + 2, j + 4), 16))
        j += 4
      } else if (next === 'u' && /^[\da-f]{4}$/iu.test(text.slice(j + 2, j + 6))) {
        value += String.fromCodePoint(Number.parseInt(text.slice(j + 2, j + 6), 16))
        j += 6
      } else if (next === '\n') {
        j += 2 // line continuation
      } else if (next === '\r' && text[j + 2] === '\n') {
        j += 3
      } else {
        value += STRING_ESCAPES[next] ?? next ?? ''
        j += 2
      }
      continue
    }
    value += ch
    j++
  }
  return { value: null, end: j }
}

// The path of every import directive, in source order. The text is tokenized far enough to skip
// comments and string literals, so a commented-out `// import "./Old.sol";` or a string holding
// the word `import` is never taken for one. An import is the `import` keyword followed, before its
// `;`, by the path literal: `import "p";`, `import "p" as X;`, `import * as X from "p";`,
// `import {A, B as C} from "p";` -- over any number of lines.
export function extractSolImports(content) {
  const specs = []
  const n = content.length
  let inImport = false
  let i = 0
  while (i < n) {
    const c = content.charCodeAt(i)
    const next = content.charCodeAt(i + 1)
    if (c === 47 && next === 47) { // `//`
      const eol = content.indexOf('\n', i + 2)
      i = eol === -1 ? n : eol + 1
    } else if (c === 47 && next === 42) { // `/*`
      const close = content.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
    } else if (c === 34 || c === 39) { // `"` or `'`
      const { value, end } = readStringLiteral(content, i)
      if (inImport && value !== null) {
        specs.push(value)
        inImport = false
      }
      i = end
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(content.charCodeAt(j))) j++
      if (j - i === 6 && content.startsWith('import', i)) inImport = true
      i = j
    } else if (isDigit(c)) {
      // A number literal (`0x1f`, `1e18`, `1_000`): its letters aren't identifiers.
      let j = i + 1
      while (j < n && isNumberPart(content.charCodeAt(j))) j++
      i = j
    } else {
      if (c === 59) inImport = false // `;`
      i++
    }
  }
  return specs
}

// --- Remappings ---------------------------------------------------------------------------------

// Loader-side shape: `{ context, prefix, target }` (context null = global).
const toLoaderRemapping = ({ context, name, path }) => ({ context, prefix: name, target: path })

// remappings.txt text -> remappings as written, one `[context:]prefix=target` per line (lines
// trimmed; blank and invalid lines skipped).
export function parseRemappings(content) {
  return parseRemappingLines(content).map(toLoaderRemapping)
}

// foundry.toml text -> the `remappings` of `[profile.default]`, overlaid by the selected profile's
// (FOUNDRY_PROFILE in `env`) when it sets them.
export function parseRemappingsFromToml(tomlContent, { env = process.env } = {}) {
  return foundryTomlRemappings(tomlContent, foundryProfile(env)).map(toLoaderRemapping)
}

// Read a foundry.toml/remappings.txt mapping file -> its remappings, as listed (no discovery
// around it) and slash-terminated as forge reads them. The file itself is not added to sources.
export async function readRemappingsFile(mappingFile, { env = process.env } = {}) {
  const content = await readFile(mappingFile, 'utf8')
  const listed = mappingFile.endsWith('.toml') ? foundryTomlRemappings(content, foundryProfile(env)) : parseRemappingLines(content, mappingFile)
  return listed.map(toSolcRemapping)
}

// What resolves the imports of the project at `baseDir`: `{ remappings, libs, files }`.
// - `mappingFile` (foundry.toml / remappings.txt): exactly the remappings it lists, nothing else.
// - else, with a foundry.toml at the root: what `forge build` uses (foundry.js) -- remappings.txt,
//   the profile's remappings, dependencies' own configs, auto-detected `lib/` remappings and their
//   contexts -- and forge's `libs` (an absolute import inside a library resolves against it).
// - else a remappings.txt at the root (solc / Hardhat 3), taken as listed.
// `files` are the project-relative config files that were read.
export async function discoverSolidityConfig(baseDir, { mappingFile, env = process.env } = {}) {
  if (mappingFile) {
    const abs = resolve(baseDir, mappingFile)
    const rel = toPosix(relative(baseDir, abs))
    return { remappings: await readRemappingsFile(abs, { env }), libs: [], files: rel.startsWith('..') || isAbsolute(rel) ? [] : [rel] }
  }
  if (isFile(join(baseDir, FOUNDRY_TOML))) return foundryProject(baseDir, { env })
  if (isFile(join(baseDir, REMAPPINGS_TXT))) {
    return { remappings: await readRemappingsFile(join(baseDir, REMAPPINGS_TXT), { env }), libs: [], files: [REMAPPINGS_TXT] }
  }
  return { remappings: [], libs: [], files: [] }
}

// Solc's remapping choice for the source unit `name` imported from `fromFile`: among the
// remappings whose context is a prefix of `fromFile` and whose prefix is a prefix of `name`, the
// longest context wins, then the longest prefix, then the one listed last. The target replaces the
// prefix verbatim (`//` collapsed). Null when none applies.
export function applyRemappings(name, fromFile, remappings) {
  let best = null
  for (const r of remappings) {
    const context = r.context ?? ''
    if (!fromFile.startsWith(context) || !name.startsWith(r.prefix)) continue
    if (best && (context.length < best.context.length || (context.length === best.context.length && r.prefix.length < best.prefix.length))) continue
    best = { context, prefix: r.prefix, target: r.target }
  }
  if (!best) return null
  return posix.normalize(best.target + name.slice(best.prefix.length)).replace(/^\.\//u, '')
}

// A relative import (first segment `.` or `..`) as solc resolves it: against the importing file's
// directory. Null when it climbs above the root (solc would clamp; that names a different file).
function resolveRelativeImport(specifier, fromFile) {
  const resolved = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')).split('/') : []
  for (const part of specifier.split('/')) {
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

const isRelativeImport = (specifier) => {
  const first = specifier.split('/')[0]
  return first === '.' || first === '..'
}

// `<baseDir>/<spec>` when a real file sits there, as a clean project-relative path.
function projectFile(baseDir, spec) {
  if (isAbsolute(spec)) return null
  const rel = toPosix(relative(baseDir, resolve(baseDir, spec)))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return isFile(join(baseDir, rel)) ? rel : null
}

// No `.`/`..`/empty segment: a bare spec can't wander out of the directory it's looked up in.
const isPlainSpec = (spec) => spec.split('/').every((p) => p !== '' && p !== '.' && p !== '..')

// Forge's absolute import inside a library (`lib/dep/src/A.sol` importing `src/B.sol`): tried
// against each directory from the importer's up to (not including) its lib dir; forge passes the
// matching one to solc as an include path.
function libraryFile(baseDir, spec, fromFile, libs) {
  const lib = libs.map((l) => posix.normalize(toPosix(l)).replace(/\/$/u, '')).find((l) => fromFile.startsWith(`${l}/`))
  if (!lib) return null
  for (let dir = posix.dirname(fromFile); dir !== lib && dir.startsWith(`${lib}/`); dir = posix.dirname(dir)) {
    const hit = projectFile(baseDir, `${dir}/${spec}`)
    if (hit) return hit
  }
  return null
}

// A package import (`pkg/path.sol`, `@scope/pkg/path.sol`) by file path through node_modules, from
// the importing file's directory up to the root (Hardhat and Node; a package's `exports` map
// doesn't apply to Solidity sources).
function nodeModulesFile(baseDir, spec, fromFile) {
  const parts = spec.split('/')
  if (parts.length < (spec.startsWith('@') ? 3 : 2)) return null
  for (let dir = posix.dirname(fromFile); ; dir = posix.dirname(dir)) {
    if (posix.basename(dir) !== 'node_modules') {
      const hit = projectFile(baseDir, dir === '.' ? `node_modules/${spec}` : `${dir}/node_modules/${spec}`)
      if (hit) return hit
    }
    if (dir === '.' || dir === '/' || dir === '') return null
  }
}

// Resolve a Solidity import to a baseDir-relative POSIX path, the way solc does: a relative import
// (`./`, `../`) is taken against the importing file (root escape -> null), then remappings apply
// (longest context, then longest prefix; see applyRemappings). An unremapped non-relative import
// is then looked up, when `baseDir` is given, as a project file (solc's base path), inside the
// importer's library (forge's include path; `libs` are forge's lib dirs), and through node_modules
// by file path (Hardhat / Node). Returns null when nothing resolves.
export function resolveSolImport(specifier, fromFile, { remappings = [], baseDir, libs = [] } = {}) {
  const relativeImport = isRelativeImport(specifier)
  const name = relativeImport ? resolveRelativeImport(specifier, fromFile) : specifier
  if (name === null) return null
  const remapped = applyRemappings(name, fromFile, remappings)
  if (remapped !== null) return remapped
  if (relativeImport) return name
  if (!baseDir) return null
  return projectFile(baseDir, name)
    ?? (isPlainSpec(name) ? libraryFile(baseDir, name, fromFile, libs) ?? nodeModulesFile(baseDir, name, fromFile) : null)
}

// The files that describe a Solidity build (bundled by `--manifests`) besides the config files
// discovery read: the root's dependency pins and build-tool config, and each package's manifests.
export const SOLIDITY_ROOT_MANIFESTS = [
  FOUNDRY_TOML, REMAPPINGS_TXT, 'foundry.lock', 'soldeer.lock', '.gitmodules', 'package.json',
  ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((ext) => `hardhat.config.${ext}`),
]
export const SOLIDITY_PACKAGE_MANIFESTS = ['package.json', FOUNDRY_TOML, REMAPPINGS_TXT]

// --- The walk -----------------------------------------------------------------------------------

// Build `{ sources, resolutions, missing }` from already-loaded Solidity sources plus remappings.
// Imports resolve as resolveSolImport does; as a final fallback a specifier matching a stored key
// verbatim is accepted. `missing` lists every (spec, from) pair that didn't resolve or resolved
// outside `sources`.
export function buildSolidityTree(sources, { remappings = [], baseDir, libs = [] } = {}) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractSolImports(content)) {
      let resolved = resolveSolImport(spec, path, { remappings, baseDir, libs })
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

// Walk the filesystem from `entries`, following resolved imports and reading each file once
// (same-wave reads run in parallel). Caller-listed entries are also accepted as verbatim
// non-relative import targets (Foundry-style `import "src/A.sol"`).
export async function collectSolidityFilesFromDisk(baseDir, entries, remappings, { libs = [] } = {}) {
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
        let resolved = resolveSolImport(spec, relPath, { remappings, baseDir, libs })
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

const realpathOrNull = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

// Every `.sol` file under the project-relative directory `dir`, sorted, symlinks followed (as forge
// and Hardhat collect a source dir) but each real directory walked once. A dir's real path is its
// parent's plus its name unless it's a symlink.
function solidityFilesUnder(baseDir, dir) {
  const out = []
  const seen = new Set()
  const walk = (rel, real) => {
    if (real === null || seen.has(real)) return
    seen.add(real)
    for (const e of readdirSync(join(baseDir, rel), { withFileTypes: true })) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`
      let kind = e
      if (e.isSymbolicLink()) {
        try {
          kind = statSync(join(baseDir, child))
        } catch {
          continue
        }
      }
      if (kind.isDirectory()) walk(child, e.isSymbolicLink() ? realpathOrNull(join(baseDir, child)) : join(real, e.name))
      else if (kind.isFile() && e.name.endsWith('.sol')) out.push(child)
    }
  }
  walk(dir, realpathOrNull(join(baseDir, dir)))
  return out.toSorted()
}

// Project-relative entries with each directory replaced by the `.sol` files under it (deduped, in
// order). A directory holding none is an error.
export function expandSolidityEntries(baseDir, entries) {
  const out = new Set()
  for (const e of entries) {
    const entry = e === '' ? '.' : e
    // A missing entry is reported by the walk.
    if (!isDir(join(baseDir, entry))) {
      out.add(entry)
      continue
    }
    const files = solidityFilesUnder(baseDir, entry)
    if (files.length === 0) throw new Error(`No .sol files under ${entry === '.' ? './' : `${entry}/`} (a directory entry stands for the Solidity sources under it)`)
    for (const f of files) out.add(f)
  }
  return [...out]
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

// High-level entry: a `.sol.txt` listing whose optional first line is a `*.toml`/`remappings.txt`
// mapping file (resolved relative to the listing); the remaining lines are `*.sol` files. Without
// a mapping line, the remappings are discovered as for `stasis bundle` (discoverSolidityConfig).
export async function loadSolidity(solTxtFile, { env = process.env } = {}) {
  const baseDir = dirname(resolve(solTxtFile))
  const listing = await readFile(solTxtFile, 'utf8')
  const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error(`Empty Solidity listing: ${solTxtFile}`)

  let mappingFile
  if (lines[0].endsWith('.toml') || lines[0].endsWith('remappings.txt')) {
    mappingFile = lines.shift()
    assertWithinBase(baseDir, mappingFile, 'Mapping path')
  }

  if (!lines.every((line) => line.endsWith('.sol'))) {
    throw new Error(`Solidity listing must only contain .sol files: ${solTxtFile}`)
  }

  const entries = lines.map((l) => l.replace(/^\.\//u, ''))
  for (const e of entries) assertWithinBase(baseDir, e, 'Entry path')
  const { remappings, libs } = await discoverSolidityConfig(baseDir, { mappingFile, env })
  const sources = await collectSolidityFilesFromDisk(baseDir, entries, remappings, { libs })
  return buildSolidityTree(sources, { remappings, baseDir, libs })
}
