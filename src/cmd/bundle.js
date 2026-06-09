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

const JS_EXTS = new Set(['.js', '.cjs', '.mjs'])

// Fallback package identity for the workspace bucket when no package.json
// with a name+version can be found by walking up from any of the bundled
// files. Bundle.parseCode requires every workspace/module bucket to have
// both fields, so we have to attest something.
const SOLIDITY_WORKSPACE_NAME = 'solidity-bundle'
const SOLIDITY_WORKSPACE_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'

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

  // Partition every loaded .sol file into a per-package bucket. The
  // bucket is the directory holding the nearest package.json with a
  // name+version. node_modules files land in `node_modules/<pkg>` buckets
  // (or deeper, when a nested package.json claims the file); workspace
  // files land in their nearest workspace package.json's dir, or in the
  // fallback "." bucket with placeholder metadata when no package.json
  // could be found.
  const modules = new Map()
  const ensureBucket = (dir, name, version) => {
    if (!modules.has(dir)) modules.set(dir, { name, version, files: Object.create(null) })
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const meta = findPackageMetadata(baseDir, path)
    const inNodeModules = splitNodeModulesPath(path) !== null
    if (meta) {
      // A file inside node_modules whose nearest package.json is the
      // workspace root would silently land in the workspace bucket and
      // hide the misconfigured dependency — refuse instead.
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`No package.json with name+version found for ${path}`)
      }
      const rel = meta.pkgDir === '.' ? path : path.slice(meta.pkgDir.length + 1)
      ensureBucket(meta.pkgDir, meta.name, meta.version).files[rel] = content
    } else {
      // Files under node_modules without any discoverable package.json
      // would otherwise leak into the workspace bucket; that's a project
      // misconfiguration, surface it loudly.
      if (inNodeModules) throw new Error(`No package.json with name+version found for ${path}`)
      ensureBucket('.', SOLIDITY_WORKSPACE_NAME, SOLIDITY_WORKSPACE_VERSION).files[path] = content
    }
  }

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, SOLIDITY_FORMAT)

  // Solidity imports don't depend on Node conditions; key them under a
  // dedicated "solidity" bucket rather than the wildcard "*" used for
  // JS code bundles.
  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([['solidity', importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(normalized),
    modules,
    formats,
    imports,
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .js/.cjs/.mjs files
// by statically scanning the require/import graph and reading reachable file
// contents from disk -- no user code is ever loaded or executed. The bundle
// shape matches what `src/loader.js` records at runtime, so the result loads
// via `stasis run --bundle=load` interchangeably with a runtime-produced one.
//
// Refuses to write when the bundle is guaranteed broken (or silently divergent
// from plain node) at load time: an unresolved static ESM `import`/`export ...
// from` edge reachable from an entry through static edges alone (link-time,
// uncatchable), a module file that can't be parsed (its static edges are
// unknown), or an edge resolving to a file a source bundle can't carry
// (extensionless, .node, .wasm). Failures that runtime code can catch --
// unresolved require()/dynamic import() edges, including entire subtrees
// behind such a boundary -- only warn (see below).
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

  // Fail closed exactly where the bundle is GUARANTEED broken (or silently
  // divergent from plain node) at load time; warn where runtime code can catch
  // the miss the same way it would without a bundle.
  //
  // Static reachability: files linked from an entry through static ESM
  // `import`/`export ... from` edges alone load eagerly, before any user code
  // runs, so no try/catch can intercept a failure there. Below a require()/
  // dynamic import() boundary the same failure surfaces at the callsite as a
  // catchable error, so the optional-dependency pattern (`try { impl = await
  // import('optional-impl') } catch { fallback }`) keeps bundling with a
  // warning -- exactly like `try { require('supports-color') } catch {}`: the
  // runtime loader never records those edges either, because Node's resolver
  // throws before the resolve hook can record them, and at load time
  // state.getImport throws a miss the user's catch handles just like
  // MODULE_NOT_FOUND in the non-bundled path. (`require` calls found in ESM
  // files also stay warn-only: the identifier may be a user-defined function
  // rather than CJS require, so refusing on it would reject valid code.)
  const staticKinds = new Set(['import', 'export-from'])
  const staticReachable = new Set(scanner.entries)
  const walk = [...scanner.entries]
  while (walk.length > 0) {
    for (const e of scanner.files.get(walk.shift())?.edges ?? []) {
      if (staticKinds.has(e.kind) && e.child && !staticReachable.has(e.child)) {
        staticReachable.add(e.child)
        walk.push(e.child)
      }
    }
  }

  // Fatal: unresolved static ESM edges in the eagerly-linked set.
  const fatalUnresolved = (u) => staticKinds.has(u.kind) && staticReachable.has(u.parentURL)
  const fatal = scanner.unresolved
    .filter((u) => fatalUnresolved(u))
    .map((u) => `unresolved ${u.kind} ${u.spec} from ${fileURLToPath(u.parentURL)} (${u.reason})`)

  // Fatal: parse failures whose edges are genuinely unknown. Script (CJS)
  // files only warn: oxc's recovered AST keeps their require()/import() calls
  // (Node's module wrapper accepts code oxc rejects, e.g. a top-level `return`
  // guard), so scan salvages the edges. A module-format file in the
  // eagerly-linked set is a hole we can't enumerate; so is any file the parser
  // couldn't process at all (recovered=false -- nothing was salvaged).
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format === 'module' || !p.recovered)
  for (const p of scanner.parseErrors) {
    if (fatalParse(p)) fatal.push(`parse error in ${fileURLToPath(p.url)}: ${p.message}`)
  }

  // Fatal: edges that resolved to a file a source bundle can't carry
  // (extensionless, .node, .wasm -- scan records the edge but never queues the
  // child). Plain node loads these fine, so the written bundle would silently
  // diverge: the edge sits in the import map with no source behind it, and
  // load dies on state.getFile's assertion -- regardless of try/catch and of
  // where in the graph it sits, so reachability doesn't soften this one.
  for (const [, byParent] of scanner.imports) {
    for (const [parentURL, specMap] of byParent) {
      for (const [spec, childURL] of specMap) {
        if (!scanner.files.has(childURL)) {
          fatal.push(`${spec} from ${fileURLToPath(parentURL)} resolves to ${fileURLToPath(childURL)}, which a source bundle can't carry`)
        }
      }
    }
  }

  if (fatal.length > 0) {
    const shown = fatal.slice(0, 10).map((s) => `  ${s}`).join('\n')
    const more = fatal.length > 10 ? `\n  ... and ${fatal.length - 10} more` : ''
    throw new Error(`JS bundle would be broken at load time:\n${shown}${more}`)
  }

  const tolerated = scanner.unresolved.filter((u) => !fatalUnresolved(u))
  if (tolerated.length > 0) {
    const summary = tolerated
      .slice(0, 10)
      .map((u) => `  ${u.kind} ${u.spec ?? '<dynamic>'} from ${fileURLToPath(u.parentURL)} (${u.reason})`)
      .join('\n')
    const more = tolerated.length > 10 ? `\n  ... and ${tolerated.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${tolerated.length} unresolved import(s); they will fall through at load time:\n${summary}${more}`)
  }
  const toleratedParse = scanner.parseErrors.filter((p) => !fatalParse(p))
  if (toleratedParse.length > 0) {
    const summary = toleratedParse
      .slice(0, 10)
      .map((p) => `  ${fileURLToPath(p.url)}: ${p.message}`)
      .join('\n')
    const more = toleratedParse.length > 10 ? `\n  ... and ${toleratedParse.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${toleratedParse.length} file(s) with parse errors; their recorded imports may be incomplete:\n${summary}${more}`)
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
// Dispatch by extension: all entries must be either .sol (Solidity) OR
// .js/.cjs/.mjs (JS, via static scan). Mixing fails fast; --mapping is .sol only.
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
  if (!isSol && !isJs) {
    throw new Error('bundleCommand: entries must all be .sol or all be .js/.cjs/.mjs (no mixing)')
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
