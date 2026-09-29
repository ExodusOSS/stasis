// Based on DeepView's Solidity loader.
// https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js
// Produces a `{ sources, resolutions }` pair. Imports resolve the way solc does under the project's
// build tool: remappings (discovered the way `forge build` does for a Foundry project, see
// foundry.js), then a Foundry library's include path, solc's base path (the project root), and
// Hardhat's/Node's node_modules lookup. The mapping/config files are read, not added to `sources`.
// Dependencies are untrusted input: an import only ever reaches a `.sol` file inside the project,
// a dependency's imports only its own and other dependencies' files (by real path), and nothing
// is read through a link a dependency planted out of itself (solidityOwnership).

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { assertRealPathWithinBase, toPosix } from '@exodus/stasis-core/util'
import { isDir, isFile } from '../resolve-typescript.js'
import {
  FOUNDRY_TOML,
  REMAPPINGS_TXT,
  foundryLibs,
  foundryProfile,
  foundryProject,
  foundryTomlRemappings,
  parseRemappingLines,
  readFoundryTomlRemappings,
  toSolcRemapping,
} from './foundry.js'
import { escapeReason, projectOwnership, solidityOwnership } from './solidity-ownership.js'

export { solidityOwnership } from './solidity-ownership.js'

// --- Import scan ------------------------------------------------------------------------------

// The scan's ASCII classes, by char code: identifier start [A-Za-z_$], identifier part [\w$], digit,
// and a number literal's [\w.].
const isIdentStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36
const isDigit = (c) => c >= 48 && c <= 57
const isIdentPart = (c) => isIdentStart(c) || isDigit(c)
const isNumberPart = (c) => (isIdentPart(c) && c !== 36) || c === 46
const STRING_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

const utf8 = (s) => [...Buffer.from(s, 'utf8')]

// A string literal starting at `text[i]` (a quote): `{ value, end }`, `value` null when it's
// unterminated on its line (solc rejects those). A literal is bytes, as in solc: `\xNN` is one
// byte, `\uNNNN` and plain text their UTF-8, and the path is those bytes read as UTF-8.
function readStringLiteral(text, i) {
  const quote = text.charCodeAt(i)
  let bytes = null // set at the first escape; until then the literal is a plain slice
  let start = i + 1
  let j = start
  while (j < text.length) {
    const c = text.charCodeAt(j)
    if (c === quote) {
      if (bytes === null) return { value: text.slice(start, j), end: j + 1 }
      bytes.push(...utf8(text.slice(start, j)))
      return { value: Buffer.from(bytes).toString('utf8'), end: j + 1 }
    }
    if (c === 10 || c === 13) return { value: null, end: j }
    if (c !== 92) {
      j++
      continue
    }
    bytes ??= []
    bytes.push(...utf8(text.slice(start, j)))
    const next = text[j + 1]
    if (next === 'x' && /^[\da-f]{2}$/iu.test(text.slice(j + 2, j + 4))) {
      bytes.push(Number.parseInt(text.slice(j + 2, j + 4), 16))
      j += 4
    } else if (next === 'u' && /^[\da-f]{4}$/iu.test(text.slice(j + 2, j + 6))) {
      bytes.push(...utf8(String.fromCodePoint(Number.parseInt(text.slice(j + 2, j + 6), 16))))
      j += 6
    } else if (next === '\r' && text[j + 2] === '\n') {
      j += 3 // line continuation
    } else if (next === '\n' || next === '\r') {
      j += 2
    } else if (next === undefined) {
      return { value: null, end: j + 1 }
    } else {
      bytes.push(...utf8(STRING_ESCAPES[next] ?? next))
      j += 2
    }
    start = j
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
    if (c === 47 && next === 47) { // `//`, to the end of the line (`\n` or `\r`, as solc ends it)
      let eol = i + 2
      while (eol < n && content.charCodeAt(eol) !== 10 && content.charCodeAt(eol) !== 13) eol++
      i = eol
    } else if (c === 47 && next === 42) { // `/*`
      const close = content.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
    } else if (c === 34 || c === 39) { // `"` or `'`
      const { value, end } = readStringLiteral(content, i)
      // An unterminated literal ends the import too (solc rejects the file).
      if (inImport && value !== null) specs.push(value)
      inImport = false
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

const realpathOrNull = (p, host) => {
  try {
    return host.realpath(p)
  } catch {
    return null
  }
}

// Loader-side shape: `{ context, prefix, target }` (context null = global).
const toLoaderRemapping = ({ context, name, path }) => ({ context, prefix: name, target: path })

// remappings.txt text -> remappings as written, one `[context:]prefix=target` per line (lines
// trimmed, blank ones skipped; an empty target is solc's, valid). A line that isn't one throws.
export function parseRemappings(content) {
  return parseRemappingLines(content, undefined, { emptyPath: true }).map(toLoaderRemapping)
}

// foundry.toml text -> the `remappings` of `[profile.default]`, overlaid by the selected profile's
// (FOUNDRY_PROFILE in `env`) when it sets them.
export function parseRemappingsFromToml(tomlContent, { env = process.env } = {}) {
  return foundryTomlRemappings(tomlContent, foundryProfile(env)).map(toLoaderRemapping)
}

// Read a mapping file -> its remappings as listed (no discovery around it) and the files read. A
// foundry.toml (its selected profile, with its `extends` base) is forge's, and so is a
// remappings.txt when `forge` says forge reads it: slash-terminated the way forge reads them.
// Otherwise (solc, Hardhat) a remappings.txt applies as written.
function readMapping(mappingFile, { env, forge, host }) {
  if (mappingFile.endsWith('.toml')) {
    const { remappings, files, profiled } = readFoundryTomlRemappings(mappingFile, foundryProfile(env))
    return { remappings: remappings.map(toSolcRemapping), files, profiled }
  }
  const listed = parseRemappingLines(await readFile(mappingFile, 'utf8'), mappingFile, { emptyPath: !forge })
  return { remappings: listed.map(forge ? toSolcRemapping : toLoaderRemapping), files: [mappingFile] }
}

// Read a foundry.toml/remappings.txt mapping file -> its remappings (see readMapping; `forge`
// defaults to a remappings.txt applying as written). The file itself is not added to sources.
export function readRemappingsFile(mappingFile, { env = process.env, forge = false, host = diskHost } = {}) {
  return readMapping(mappingFile, { env, forge, host }).remappings
}

// --- Resolution ---------------------------------------------------------------------------------

// What resolves the imports of the project at `baseDir`:
// `{ remappings, libs, ownership, files, envUsed }`.
// - `mappingFile` (foundry.toml / remappings.txt): exactly the remappings it lists (see readMapping).
// - else, with a foundry.toml at the root: what `forge build` uses (foundry.js) -- remappings.txt,
//   the profile's remappings, dependencies' own configs, auto-detected `lib/` remappings and their
//   contexts.
// - else a remappings.txt at the root (solc / Hardhat 3), taken as written.
// `libs` are forge's lib dirs whenever the root has a foundry.toml (an absolute import inside a
// library resolves against it); `ownership` tells the dependencies' files from the project's
// (solidityOwnership: forge's libs, Soldeer's `dependencies/`, git submodules, node_modules);
// `files` the project-relative config files read; `envUsed` the environment variables that
// shaped the result.
export async function discoverSolidityConfig(baseDir, { mappingFile, env = process.env } = {}) {
  const forge = isFile(join(baseDir, FOUNDRY_TOML))
  if (forge && !mappingFile) {
    const { remappings, libs, ownership, files, envUsed } = foundryProject(baseDir, { env })
    return { remappings, libs, ownership, files, envUsed }
  }
  const { libs, profiled } = forge ? foundryLibs(baseDir, { env }) : { libs: [], profiled: false }
  const ownership = projectOwnership(baseDir, libs, { soldeer: forge })
  const within = (abs) => {
    const rel = toPosix(relative(baseDir, abs))
    return rel.startsWith('..') || isAbsolute(rel) ? [] : [rel]
  }
  if (mappingFile) {
    const abs = resolve(baseDir, mappingFile)
    const read = await readMapping(abs, { env, forge })
    const { remappings, files } = read
    // The profile picks the mapping file's remappings (a .toml) or the root foundry.toml's libs.
    const envUsed = profiled || read.profiled ? [`FOUNDRY_PROFILE=${env.FOUNDRY_PROFILE}`] : []
    return { remappings, libs, ownership, files: files.flatMap(within), envUsed }
  }
  const txt = join(baseDir, REMAPPINGS_TXT)
  const remappings = isFile(txt) ? (await readMapping(txt, { env, forge })).remappings : []
  return { remappings, libs, ownership, files: isFile(txt) ? [REMAPPINGS_TXT] : [], envUsed: [] }
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
// directory. Null when it climbs above the root: solc clamps there (`../../B.sol` from `src/A.sol`
// is `B.sol`), but an import reaching out of the project is refused rather than redirected.
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
function projectFile(baseDir, spec, host) {
  if (isAbsolute(spec)) return null
  const rel = toPosix(relative(baseDir, resolve(baseDir, spec)))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return isFile(join(baseDir, rel), host) ? rel : null
}

// No `.`/`..`/empty segment: a bare spec can't wander out of the directory it's looked up in.
const isPlainSpec = (spec) => spec.split('/').every((p) => p !== '' && p !== '.' && p !== '..')

// Forge's absolute import inside a library (`lib/dep/src/A.sol` importing `src/B.sol`): tried
// against each directory from the parent of the importer's up to (not including) its lib dir, as
// foundry-compilers' `resolve_absolute_library` does; forge passes the matching one to solc as an
// include path.
function libraryFile(baseDir, spec, fromFile, libs, host) {
  const lib = libs.map((l) => posix.normalize(toPosix(l)).replace(/\/$/u, '')).find((l) => fromFile.startsWith(`${l}/`))
  if (!lib) return null
  for (let dir = posix.dirname(posix.dirname(fromFile)); dir !== lib && dir.startsWith(`${lib}/`); dir = posix.dirname(dir)) {
    const hit = projectFile(baseDir, `${dir}/${spec}`, host)
    if (hit) return hit
  }
  return null
}

// A package import (`pkg/path.sol`, `@scope/pkg/path.sol`) by file path through node_modules, from
// the importing file's directory up to the root (Hardhat and Node; a package's `exports` map
// doesn't apply to Solidity sources).
function nodeModulesFile(baseDir, spec, fromFile, host) {
  const parts = spec.split('/')
  if (parts.length < (spec.startsWith('@') ? 3 : 2)) return null
  for (let dir = posix.dirname(fromFile); ; dir = posix.dirname(dir)) {
    if (posix.basename(dir) !== 'node_modules') {
      const hit = projectFile(baseDir, dir === '.' ? `node_modules/${spec}` : `${dir}/node_modules/${spec}`, host)
      if (hit) return hit
    }
    if (dir === '.' || dir === '/' || dir === '') return null
  }
}

// Where an import resolves, as `{ path }`, or `{ reason }` when it may not be read (`reason: null`:
// it names no file). See resolveSolImport.
function resolveImport(specifier, fromFile, { remappings = [], baseDir, libs = [], ownership } = {}) {
  const relativeImport = isRelativeImport(specifier)
  const name = relativeImport ? resolveRelativeImport(specifier, fromFile) : specifier
  if (name === null) return { reason: 'it climbs above the project root' }
  let path = applyRemappings(name, fromFile, remappings)
  if (path === null && relativeImport) path = name
  if (path === null && baseDir) {
    const plain = isPlainSpec(name)
    path = (plain ? libraryFile(baseDir, name, fromFile, libs, host) : null) ?? projectFile(baseDir, name, host) ?? (plain ? nodeModulesFile(baseDir, name, fromFile, host) : null)
  }
  if (path === null) return { reason: null }
  if (isAbsolute(path) || posix.isAbsolute(path) || path === '..' || path.startsWith('../')) return { reason: `it resolves to ${path}, outside the project root` }
  if (!path.endsWith('.sol')) return { reason: `it resolves to ${path}, which is not a .sol file` }
  if (!baseDir) return { path }
  const own = ownership ?? solidityOwnership(baseDir)
  const target = own.of(path)
  if (target.escape) return { reason: escapeReason(path, target.escape) }
  // (A link out of the root is refused when the file is read.)
  if (target.real !== null && !target.outside && !target.dependency && own.of(fromFile).dependency) return { reason: `a dependency may not import the project's own ${path}` }
  return { path }
}

// Resolve a Solidity import to a baseDir-relative POSIX path, the way solc does: a relative import
// (`./`, `../`) is taken against the importing file (root escape -> null), then remappings apply
// (longest context, then longest prefix; see applyRemappings). An unremapped non-relative import
// is then looked up, when `baseDir` is given, inside the importer's library (forge's include path;
// `libs` are forge's lib dirs), as a project file (solc's base path), and through node_modules by
// file path (Hardhat / Node). Returns null when nothing resolves, or when the result isn't a `.sol`
// file inside the root, crosses a link a dependency planted out of itself, or is the project's own
// file imported by a dependency's -- by real path, with `ownership` (solidityOwnership's; by default
// only node_modules holds dependencies).
export function resolveSolImport(specifier, fromFile, options = {}) {
  return resolveImport(specifier, fromFile, options).path ?? null
}

// The files that describe a Solidity build (bundled by `--manifests`) besides the config files
// discovery read: the root's dependency pins, and each package's manifests. (`hardhat.config.*` is
// code that may hold keys, so it is never carried.)
export const SOLIDITY_ROOT_MANIFESTS = [FOUNDRY_TOML, REMAPPINGS_TXT, 'foundry.lock', 'soldeer.lock', '.gitmodules', 'package.json']
export const SOLIDITY_PACKAGE_MANIFESTS = ['package.json', FOUNDRY_TOML, REMAPPINGS_TXT]

// --- The walk -----------------------------------------------------------------------------------

// Build `{ sources, resolutions, missing }` from already-loaded Solidity sources plus remappings.
// Imports resolve as resolveSolImport does (`libs`, `ownership`: see there); as a final
// fallback a specifier naming no file but matching a stored key verbatim is accepted. `missing`
// lists every `{ spec, from }` that didn't resolve or resolved outside `sources`, with the
// `reason` when it was refused.
export function buildSolidityTree(sources, { remappings = [], baseDir, libs = [], ownership = baseDir && solidityOwnership(baseDir) } = {}) {
  const resolutions = new Map()
  const missing = []
  const options = { remappings, baseDir, libs, dependencyDirs, host, realBase: baseDir && dependencyDirs ? host.realpath(baseDir) : undefined }
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractSolImports(content)) {
      const r = resolveImport(spec, path, { remappings, baseDir, libs, ownership })
      let resolved = r.path && sources.has(r.path) ? r.path : null
      if (!resolved && !r.reason && sources.has(spec)) resolved = spec
      if (resolved) {
        specMap.set(spec, resolved)
      } else {
        console.warn(`[loader.solidity] ${r.reason ? 'Refused' : 'Missing'} import: ${spec} from ${path}${r.reason ? ` (${r.reason})` : ''}`)
        missing.push(r.reason ? { spec, from: path, reason: r.reason } : { spec, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem from `entries`, following resolved imports and reading each file once
// (same-wave reads run in parallel). Caller-listed entries are also accepted as verbatim
// non-relative import targets naming no file (Foundry-style `import "src/A.sol"`). An entry that
// crosses a dependency's link out of itself (see solidityOwnership) is refused.
export async function collectSolidityFilesFromDisk(baseDir, entries, remappings, { libs = [], ownership = solidityOwnership(baseDir) } = {}) {
  const sources = new Map()
  const knownEntries = new Set(entries)
  const realBase = realpathSync(baseDir)
  for (const entry of entries) {
    const { escape } = ownership.of(entry)
    if (escape) throw new Error(`Refusing entry ${entry}: ${escapeReason(entry, escape)}`)
  }

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
        throw err
      }
    })
    const next = []
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content] = entry
      sources.set(relPath, content)
      for (const spec of extractSolImports(content)) {
        const r = resolveImport(spec, relPath, { remappings, baseDir, libs, ownership })
        const resolved = r.path ?? (!r.reason && knownEntries.has(spec) ? spec : null)
        if (resolved) {
          if (!sources.has(resolved)) next.push(resolved)
        } else {
          console.warn(`[loader.solidity] ${r.reason ? 'Refused' : 'Missing'} import: ${spec} from ${relPath}${r.reason ? ` (${r.reason})` : ''}`)
        }
      }
    }
    wave = next
  }
  return sources
}

// Every `.sol` file under the project-relative directory `dir`, sorted, symlinks followed as forge
// (walkdir, `follow_links`) collects a source dir: a symlinked directory whose real path is one on
// the current walk (the walk root included) is a loop and skipped; anything else is walked, so two
// links to one directory are two directories. A dir's real path is its parent's plus its name
// unless it's a symlink.
function solidityFilesUnder(baseDir, dir, host) {
  const out = []
  // The real paths of the directories on the current walk; one may repeat (a real directory
  // reached again through a link is walked, as walkdir does, and checked only at links).
  const stack = []
  const walk = (rel, real) => {
    stack.push(real)
    for (const e of host.readdir(join(baseDir, rel))) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`
      let kind = e
      let childReal = join(real, e.name)
      if (e.isSymbolicLink()) {
        childReal = realpathOrNull(join(baseDir, child), host)
        kind = host.stat(join(baseDir, child))
        if (kind === null) continue
        if (kind.isDirectory() && (childReal === null || stack.includes(childReal))) continue
      }
      if (kind.isDirectory()) walk(child, childReal)
      else if (kind.isFile() && e.name.endsWith('.sol')) out.push(child)
    }
    stack.pop()
  }
  const root = realpathOrNull(join(baseDir, dir), host)
  if (root !== null) walk(dir, root)
  return out.toSorted()
}

// Project-relative entries with each directory replaced by the `.sol` files under it (deduped, in
// order). A `.sol` entry is kept as is (a missing one is reported by the walk); a directory that
// is missing or holds no `.sol` file is skipped with a warning, as forge skips an absent `script/`,
// and it's an error only when no entry yields a file (when none exists, a mistyped path).
export function expandSolidityEntries(baseDir, entries) {
  const out = new Set()
  const shown = (entry) => (entry === '.' ? './' : `${entry}/`)
  for (const e of entries) {
    const entry = e === '' ? '.' : e
    const dir = isDir(join(baseDir, entry), host)
    if (!dir && entry.endsWith('.sol')) {
      out.add(entry)
      continue
    }
    const files = dir ? solidityFilesUnder(baseDir, entry, host) : []
    if (files.length === 0) console.warn(`[stasis] Skipping ${shown(entry)}: ${dir ? 'no .sol files under it' : 'no such directory'}`)
    for (const f of files) out.add(f)
  }
  if (out.size === 0) {
    if (entries.every((e) => !existsSync(join(baseDir, e)))) throw new Error(`No such file or directory: ${entries[0]}`)
    throw new Error(`No .sol files under ${entries.map((e) => shown(e === '' ? '.' : e)).join(', ')} (a directory entry stands for the Solidity sources under it)`)
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
  const { remappings, libs, ownership } = await discoverSolidityConfig(baseDir, { mappingFile, env })
  const sources = await collectSolidityFilesFromDisk(baseDir, entries, remappings, { libs, ownership })
  return buildSolidityTree(sources, { remappings, baseDir, libs, ownership })
}
