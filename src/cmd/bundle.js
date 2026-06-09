import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '../bundle.js'
import { scan } from '../scan.js'
import { State } from '../state.js'
import { brotliOptions, splitNodeModulesPath } from '../util.js'
import {
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  readRemappingsFile,
} from '../loaders/solidity.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { buildRustTree, collectRustFilesFromDisk } from '../loaders/rust.js'

const JS_EXTS = new Set(['.js', '.cjs', '.mjs'])
const BASH_EXTS = new Set(['.sh', '.bash'])
const RUST_EXTS = new Set(['.rs'])

// Fallback package identity for the workspace bucket when no package.json
// with a name+version can be found by walking up from any of the bundled
// files. Bundle.parseCode requires every workspace/module bucket to have
// both fields, so we have to attest something.
const SOLIDITY_WORKSPACE_NAME = 'solidity-bundle'
const SOLIDITY_WORKSPACE_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'

const BASH_WORKSPACE_NAME = 'bash-bundle'
const BASH_WORKSPACE_VERSION = '0.0.0'
const BASH_FORMAT = 'bash'

const RUST_WORKSPACE_NAME = 'rust-bundle'
const RUST_WORKSPACE_VERSION = '0.0.0'
const RUST_FORMAT = 'rust'

// Walk up from the file's directory looking for the nearest package.json
// with both `name` and `version`. Returns { pkgDir, name, version }
// (pkgDir relative to `baseDir`, "." for the project root) or null when no
// such package.json exists at or above the file.
function findPackageMetadata(baseDir, fileRelPath) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name && pkg.version) {
          return { pkgDir: dir, name: pkg.name, version: pkg.version }
        }
      } catch { /* malformed — keep walking */ }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    // On Windows, `path.relative()` returns an absolute path when `abs` is on
    // a different drive than `baseDir` — that wouldn't start with `..` but
    // still escapes, so reject both forms.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

// Deepest directory that is a parent of every file in `paths`, expressed
// relative to `cwd`. `paths` may be POSIX-relative-to-cwd; entries that
// escape cwd (e.g. `../deps/X.sol` via remapping) push the result above
// cwd, in which case the returned path starts with `..`. Returns "." when
// the outermost directory IS cwd itself.
export function outermostDir(paths, cwd) {
  if (paths.length === 0) return '.'
  const cwdAbs = posix.resolve(cwd.replaceAll(/\\/gu, '/'))
  const absDirs = paths.map((p) => posix.dirname(posix.resolve(cwdAbs, p)))
  const partsList = absDirs.map((d) => d.split('/'))
  const common = []
  for (let i = 0; i < partsList[0].length; i++) {
    const c = partsList[0][i]
    if (!partsList.every((parts) => parts[i] === c)) break
    common.push(c)
  }
  const absCommon = common.join('/') || '/'
  const rel = posix.relative(cwdAbs, absCommon)
  return rel === '' ? '.' : rel
}

// Assemble a scope=full code Bundle from a collected source set and its
// resolution graph. Shared by every non-JS bundler (Solidity/Bash/Rust): the
// language-specific work (collecting files, resolving the graph, deciding what
// counts as "missing") happens in the caller; here every file is bucketized
// the same way, tagged `format`, and the whole resolution graph is keyed under
// a single `conditionKey`.
//
// Files are partitioned into per-package buckets by the nearest package.json
// with name+version: node_modules files into `node_modules/<pkg>` buckets,
// workspace files into their package dir, and anything with no discoverable
// package.json into the "." bucket with the given placeholder identity (the
// Bundle layout requires every bucket to attest a name+version). A file under
// node_modules whose nearest package.json is the workspace root is rejected —
// that hides a misconfigured dependency rather than silently mislabeling it.
//
// Unlike the wildcard "*" JS bundles use, these formats don't vary by Node
// resolution condition, so every edge lands under the one `conditionKey`.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, workspaceName, workspaceVersion, format, conditionKey,
}) {
  const modules = new Map()
  const ensureBucket = (dir, name, version) => {
    if (!modules.has(dir)) modules.set(dir, { name, version, files: Object.create(null) })
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const meta = findPackageMetadata(baseDir, path)
    const inNodeModules = splitNodeModulesPath(path) !== null
    if (meta) {
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`No package.json with name+version found for ${path}`)
      }
      const rel = meta.pkgDir === '.' ? path : path.slice(meta.pkgDir.length + 1)
      ensureBucket(meta.pkgDir, meta.name, meta.version).files[rel] = content
    } else {
      if (inNodeModules) throw new Error(`No package.json with name+version found for ${path}`)
      ensureBucket('.', workspaceName, workspaceVersion).files[path] = content
    }
  }

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, format)

  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([[conditionKey, importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats,
    imports,
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .sol files and
// an optional mapping file. The mapping file (foundry.toml or
// remappings.txt) is parsed for remappings but NOT included in the
// bundle's sources. Returns the constructed `Bundle`.
export async function buildSolidityBundle({ cwd = process.cwd(), entries, mappingFile } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildSolidityBundle: at least one entry .sol file is required')
  }
  for (const e of entries) {
    if (!e.endsWith('.sol')) throw new Error(`buildSolidityBundle: not a .sol file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const remappings = mappingFile ? await readRemappingsFile(resolve(cwd, mappingFile)) : []
  const normalized = normalizeEntries(entries, cwd)

  const sources = await collectSolidityFilesFromDisk(baseDir, normalized, remappings)
  const { resolutions, missing } = buildSolidityTree(sources, { remappings, baseDir })

  // Bundles must be self-contained. Refuse to write one when an entry
  // can't be loaded from disk, or when any in-bundle file has an import
  // we couldn't resolve — otherwise downstream consumers would silently
  // operate on a partial set of sources.
  const issues = []
  for (const entry of normalized) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from } of missing) {
    issues.push(`Unresolved import: ${spec} from ${from}`)
  }
  if (issues.length > 0) {
    throw new Error(`Solidity bundle has unresolved imports:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }

  return assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    workspaceName: SOLIDITY_WORKSPACE_NAME,
    workspaceVersion: SOLIDITY_WORKSPACE_VERSION,
    format: SOLIDITY_FORMAT,
    conditionKey: 'solidity',
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .sh/.bash files by
// walking the source/exec graph and reading every reachable script from disk.
// Mirrors buildSolidityBundle's bucketizing, with a bash-specific policy:
//   - a relative/project-relative reference to a .sh/.bash file that doesn't
//     resolve to a bundled script is fatal (a self-contained bundle can't
//     carry a dangling `source ./lib.sh`), as is a missing entry.
//   - everything else is best-effort and dropped: PATH commands (`grep`,
//     `node`), dynamic `$VAR` paths, extensionless sources, and absolute
//     system paths (`source /etc/profile.d/x.sh`) — none belongs in a bundle.
//   - imports live under a dedicated "bash" condition key (like "solidity"),
//     not the JS-bundle wildcard "*".
export async function buildBashBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildBashBundle: at least one entry .sh/.bash file is required')
  }
  for (const e of entries) {
    if (!BASH_EXTS.has(extname(e))) throw new Error(`buildBashBundle: not a .sh/.bash file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)

  const sources = await collectBashFilesFromDisk(baseDir, normalized)
  const { resolutions, missing } = buildBashTree(sources)

  // Bundles must be self-contained: every entry must load, and every
  // relative/project-relative .sh/.bash reference must resolve to a bundled
  // script. Best-effort references (commands, $VAR paths, extensionless or
  // absolute sources) are left out by buildBashTree and never reach `missing`.
  const issues = []
  for (const entry of normalized) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from } of missing) {
    issues.push(`Unresolved script: ${spec} from ${from}`)
  }
  if (issues.length > 0) {
    throw new Error(`Bash bundle has unresolved scripts:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }

  return assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    workspaceName: BASH_WORKSPACE_NAME,
    workspaceVersion: BASH_WORKSPACE_VERSION,
    format: BASH_FORMAT,
    conditionKey: 'bash',
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .rs files by walking
// `mod` declarations from each crate root and reading every reachable module
// from disk. The bundle must be self-contained: an unresolvable `mod foo;`
// (no backing file) is fatal, as is a missing entry. `use crate::` edges are
// recorded in the import graph but stay best-effort — they never widen the
// file set, and their resolution is approximate (item-vs-module, re-exports),
// so they aren't gated; external crates and std are ignored outright. Imports
// live under a dedicated "rust" condition key.
export async function buildRustBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildRustBundle: at least one entry .rs file is required')
  }
  for (const e of entries) {
    if (!RUST_EXTS.has(extname(e))) throw new Error(`buildRustBundle: not a .rs file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)

  const sources = await collectRustFilesFromDisk(baseDir, normalized)
  const { resolutions, missing } = buildRustTree(sources)

  const issues = []
  for (const entry of normalized) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from } of missing) {
    issues.push(`Unresolved module: ${spec} from ${from}`)
  }
  if (issues.length > 0) {
    throw new Error(`Rust bundle has unresolved modules:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }

  return assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    workspaceName: RUST_WORKSPACE_NAME,
    workspaceVersion: RUST_WORKSPACE_VERSION,
    format: RUST_FORMAT,
    conditionKey: 'rust',
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .js/.cjs/.mjs files
// by statically scanning the require/import graph and reading reachable file
// contents from disk -- no user code is ever loaded or executed. The bundle
// shape matches what `src/loader.js` records at runtime, so the result loads
// via `stasis run --bundle=load` interchangeably with a runtime-produced one.
//
// Refuses to write when any specifier is unresolved (dynamic require, missing
// dep, conditional `exports` mismatch): a bundle with holes would silently
// fall through to disk at load time, defeating the point of bundling.
//
// Scope and per-edge conditions come from the project's stasis.config.json
// (or `EXODUS_STASIS_SCOPE`); pass `scope` explicitly to override.
export async function buildJsBundle({ cwd = process.cwd(), entries, scope } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildJsBundle: at least one entry .js/.cjs/.mjs file is required')
  }
  for (const e of entries) {
    if (!JS_EXTS.has(extname(e))) throw new Error(`buildJsBundle: not a JS file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))

  const scanner = scan(absEntries)
  // Unresolved edges (dynamic specifiers, optional deps not installed) are NOT
  // fatal: they match the runtime loader's behavior. Code like
  // `try { require('supports-color') } catch {}` never has its `supports-color`
  // edge recorded by the runtime bundle either, because Node's resolver throws
  // before the resolve hook can record it. At load time, state.getImport will
  // assert for these edges -- and the user's try/catch will catch the assertion
  // exactly as it catches MODULE_NOT_FOUND in the non-bundled path. Warn so the
  // user knows their bundle isn't fully self-contained for those edges, but
  // don't refuse to produce it.
  if (scanner.unresolved.length > 0) {
    const summary = scanner.unresolved
      .slice(0, 10)
      .map((u) => `  ${u.kind} ${u.spec ?? '<dynamic>'} from ${fileURLToPath(u.parentURL)} (${u.reason})`)
      .join('\n')
    const more = scanner.unresolved.length > 10 ? `\n  ... and ${scanner.unresolved.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${scanner.unresolved.length} unresolved import(s); they will fall through at load time:\n${summary}${more}`)
  }

  // Use a non-preload State to materialise the bundle: addFile bucketizes by
  // package.json + records hashes/sources/formats, and addImport replays the
  // per-edge import map. State's serializeCode then emits the same v1 layout
  // the runtime loader writes — see src/loader.js for the matching pair.
  //
  // bundle=replace skips reading any pre-existing stasis.code.br on disk;
  // bundle=add would merge it, leaking stale formats/imports entries for
  // files the new bundle doesn't carry. lock=ignore tolerates a pre-existing
  // stasis.lock.json without loading or validating it (the bundle path
  // doesn't consume one), and refusing to coexist with one (lock=none) would
  // make `stasis bundle` brittle in any project that's also using `stasis run`.
  const state = new State(baseDir, { bundle: 'replace', lock: 'ignore', ...(scope ? { scope } : {}) })
  for (const [url, info] of scanner.files) {
    const isEntry = scanner.entries.has(url)
    state.addFile(url, { format: info.format, isEntry })
  }
  // Static bundles can't anticipate the full condition set Node will pass to
  // its resolve hook at load time (Node adds runtime conditions like
  // 'module-sync', 'node-addons' that aren't accept-list conditions). Store
  // every edge under the wildcard '*' key; State.getImport falls back to it
  // when the runtime-condition lookup misses.
  for (const [, byParent] of scanner.imports) {
    for (const [parentURL, specs] of byParent) {
      for (const [spec, childURL] of specs) {
        state.addImport(parentURL, spec, childURL, { conditions: '*' })
      }
    }
  }
  return state
}

// Run the bundle CLI command end-to-end. Always produces a brotli-compressed
// stasis bundle (matching the on-disk format of `stasis.code.br`). When
// `output` is provided, writes to that path; otherwise writes to stdout.
// Prints a one-line `[stasis] Bundled <n> files from <dir> to <dest>` summary
// to stderr so it doesn't interleave with the binary output on stdout.
//
// Dispatch by extension: all entries must be one language — .sol (Solidity),
// .js/.cjs/.mjs (JS, via static scan), .sh/.bash (Bash, via source/exec graph
// walk), or .rs (Rust, via mod-declaration walk). Mixing fails fast;
// --mapping is .sol only, --scope/--lockfile are JS only.
//
// For JS bundles, an optional `lockfile` path writes a stasis.lock.json that
// attests every file in the bundle. The static scan walks both branches of
// conditional requires (e.g. debug/src/index.js' `if (browser) require('./browser')
// else require('./node')`), so the runtime lockfile from `stasis run --lock=add`
// won't attest the unused branch -- if the user wants `lock=frozen` against a
// statically-built bundle, they need this companion lockfile.
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output, scope, lockfile } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('bundleCommand: at least one entry file is required')
  }
  const isSol = entries.every((e) => e.endsWith('.sol'))
  const isJs = entries.every((e) => JS_EXTS.has(extname(e)))
  const isBash = entries.every((e) => BASH_EXTS.has(extname(e)))
  const isRust = entries.every((e) => RUST_EXTS.has(extname(e)))
  if (!isSol && !isJs && !isBash && !isRust) {
    throw new Error('bundleCommand: entries must all be .sol, all be .js/.cjs/.mjs, all be .sh/.bash, or all be .rs (no mixing)')
  }
  if (mappingFile && !isSol) {
    throw new Error('bundleCommand: --mapping is only valid for .sol bundles')
  }
  if (scope !== undefined && !isJs) {
    throw new Error('bundleCommand: --scope is only valid for JS bundles')
  }
  if (lockfile !== undefined && !isJs) {
    throw new Error('bundleCommand: --lockfile is only valid for JS bundles')
  }

  let serialized
  let files
  let lockData
  if (isSol) {
    const bundle = await buildSolidityBundle({ cwd, entries, mappingFile })
    serialized = bundle.serializeCode()
    files = [...bundle.sources.keys()]
  } else if (isBash) {
    const bundle = await buildBashBundle({ cwd, entries })
    serialized = bundle.serializeCode()
    files = [...bundle.sources.keys()]
  } else if (isRust) {
    const bundle = await buildRustBundle({ cwd, entries })
    serialized = bundle.serializeCode()
    files = [...bundle.sources.keys()]
  } else {
    const state = await buildJsBundle({ cwd, entries, scope })
    serialized = state.sourceData
    files = [...state.sources.keys()]
    if (lockfile) lockData = state.lockData
  }

  const data = brotliCompressSync(serialized, brotliOptions())
  if (output) {
    const outAbs = resolve(cwd, output)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  } else {
    process.stdout.write(data)
  }
  if (lockData) {
    const lockAbs = resolve(cwd, lockfile)
    mkdirSync(dirname(lockAbs), { recursive: true })
    writeFileSync(lockAbs, lockData)
  }
  const fromDir = outermostDir(files, resolve(cwd))
  const dest = output ?? '<stdout>'
  console.warn(`[stasis] Bundled ${files.length} files from ${fromDir} to ${dest}`)
}
