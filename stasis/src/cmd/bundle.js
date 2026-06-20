import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { scan } from '../scan.js'
import { State } from '@exodus/stasis-core/state'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { nodeFormatToStasis, splitNodeModulesPath } from '@exodus/stasis-core/util'
import {
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  readRemappingsFile,
} from '../loaders/solidity.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { buildRustTree, collectRustFilesFromDisk } from '../loaders/rust.js'
import {
  bucketizePhpSources,
  buildPhpTree,
  collectPhpFilesFromDisk,
  loadComposerAutoload,
  loadLaravelProviderFiles,
} from '../loaders/php.js'

const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const BASH_EXTS = new Set(['.sh', '.bash'])
const RUST_EXTS = new Set(['.rs'])

// Fallback package identity for the workspace bucket when no package.json
// with a name+version can be found by walking up from any of the bundled
// files. Bundle.parse requires every workspace/module bucket to have
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

const PHP_WORKSPACE_NAME = 'php-bundle'
const PHP_WORKSPACE_VERSION = '0.0.0'
const PHP_FORMAT = 'php'

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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Split a Soldeer dependency dir name (`<name>-<version>`) into its parts, e.g.
// `@openzeppelin-contracts-5.0.2` -> { name: '@openzeppelin-contracts',
// version: '5.0.2' }. Soldeer encodes the version into the directory name, so
// that's the authoritative identity for a Soldeer package. Falls back to
// version 0.0.0 when the dir doesn't end in a semver (every bucket must attest
// a version).
function parseSoldeerDir(seg) {
  const m = /^(.+)-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/u.exec(seg)
  return m ? { name: m[1], version: m[2] } : { name: seg, version: '0.0.0' }
}

// Extract `owner/repo` from a github.com remote (https, ssh, or scp-style),
// dropping a trailing `.git`. Returns null for non-github hosts.
function githubSlug(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

// Parse `.gitmodules` into Map<submodulePath, { name, branch }>, keeping only
// github.com submodules (the ones we can attribute as `github`). `.gitmodules`
// is git-config INI: `[submodule "<n>"]` sections with `path`/`url`/`branch`.
function parseGithubSubmodules(baseDir) {
  const byPath = new Map()
  const text = readFileSyncOrNull(join(baseDir, '.gitmodules'))
  if (!text) return byPath
  let cur = null
  const flush = () => {
    if (cur?.path && cur?.url) {
      const name = githubSlug(cur.url)
      if (name) byPath.set(cur.path.replace(/\/+$/u, ''), { name, branch: cur.branch })
    }
    cur = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      flush()
      cur = line.startsWith('[submodule') ? {} : null
      continue
    }
    if (!cur) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key === 'path' || key === 'url' || key === 'branch') cur[key] = line.slice(eq + 1).trim()
  }
  flush()
  return byPath
}

function readFileSyncOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// Classify a bundled Solidity file into its dependency bucket. Solidity installs
// deps three ways, each its own ecosystem: npm (`node_modules`, left to the
// shared bucketizer), Soldeer (`dependencies/<name>-<version>/` → `soldeer`),
// and `forge install` git submodules (`lib/<dir>/`, when `.gitmodules` records a
// github.com URL → `github`, per SBOM/Package-URL `pkg:github/owner/repo`).
// Returns { bucketDir, name, version, ecosystem } for a Soldeer/github dep, or
// null to defer to the package.json/node_modules/workspace logic.
function makeSolidityClassifier(baseDir) {
  const submodules = parseGithubSubmodules(baseDir)
  return (path) => {
    if (path.startsWith('dependencies/')) {
      const seg = path.slice('dependencies/'.length).split('/')[0]
      if (seg) {
        const { name, version } = parseSoldeerDir(seg)
        return { bucketDir: `dependencies/${seg}`, name, version, ecosystem: 'soldeer' }
      }
    }
    for (const [sub, { name, branch }] of submodules) {
      if (path === sub || path.startsWith(`${sub}/`)) {
        const pkg = readJson(join(baseDir, sub, 'package.json'))
        return { bucketDir: sub, name, version: pkg?.version ?? branch ?? '0.0.0', ecosystem: 'github' }
      }
    }
    return null
  }
}

// Minimal Cargo.toml reader: pull `name`/`version` from the `[package]` table.
// A full TOML parse isn't warranted — those two string keys are all we need to
// identify a vendored crate. Returns null when there's no readable package name.
function parseCargoToml(file) {
  const text = readFileSyncOrNull(file)
  if (!text) return null
  const at = text.search(/^\[package\]\s*$/mu)
  let body = text
  if (at !== -1) {
    const rest = text.slice(at)
    const next = rest.slice(1).search(/^\[/mu) // start of the table after [package]
    body = next === -1 ? rest : rest.slice(0, next + 1)
  }
  const name = /^\s*name\s*=\s*"([^"]+)"/mu.exec(body)?.[1]
  const version = /^\s*version\s*=\s*"([^"]+)"/mu.exec(body)?.[1]
  return name ? { name, version: version ?? '0.0.0' } : null
}

// Classify a bundled Rust file. `cargo vendor` copies external crates in-tree
// under `vendor/<dir>/`; each is its own crate with a Cargo.toml, so bucket it
// under `vendor/<dir>` and tag it `cargo` (Package-URL `pkg:cargo/<name>`). The
// workspace's own code and path/workspace members defer to the workspace logic.
function makeRustClassifier(baseDir) {
  return (path) => {
    if (!path.startsWith('vendor/')) return null
    const dir = path.slice('vendor/'.length).split('/')[0]
    if (!dir) return null
    const bucketDir = `vendor/${dir}`
    const pkg = parseCargoToml(join(baseDir, bucketDir, 'Cargo.toml'))
    return pkg ? { bucketDir, name: pkg.name, version: pkg.version, ecosystem: 'cargo' } : null
  }
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
//
// Dependency buckets (those under node_modules) are tagged `ecosystem: 'npm'`:
// node_modules is npm's install layout, so that's where the package came from,
// regardless of the bundle's language — a Solidity or Bash import resolved out
// of node_modules is an npm package all the same. This mirrors State's own
// node_modules tagging (see stasis-core state.js) and lets consumers tell deps
// apart from the workspace's own packages; the workspace/`.` bucket carries no
// ecosystem. (PHP's Composer `vendor/` deps are tagged `composer` separately, by
// the PHP bucketizer.)
//
// `classifyDep(path)` is an optional language-specific hook: when it returns a
// { bucketDir, name, version, ecosystem } record the file is placed there
// directly, which is how non-node_modules ecosystems are attributed (e.g.
// Solidity's Soldeer `dependencies/` and github submodules). Returning null (or
// omitting the hook) defers to the node_modules/package.json/workspace logic.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, workspaceName, workspaceVersion, format, conditionKey, classifyDep,
}) {
  const modules = new Map()
  const ensureBucket = (dir, name, version, bucketEcosystem) => {
    if (!modules.has(dir)) {
      modules.set(dir, bucketEcosystem === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, ecosystem: bucketEcosystem, files: Object.create(null) })
    }
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const dep = classifyDep?.(path)
    if (dep) {
      ensureBucket(dep.bucketDir, dep.name, dep.version, dep.ecosystem)
        .files[path.slice(dep.bucketDir.length + 1)] = content
      continue
    }
    const meta = findPackageMetadata(baseDir, path)
    const inNodeModules = splitNodeModulesPath(path) !== null
    if (meta) {
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`No package.json with name+version found for ${path}`)
      }
      const rel = meta.pkgDir === '.' ? path : path.slice(meta.pkgDir.length + 1)
      const bucketEcosystem = meta.pkgDir.includes('node_modules') ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, bucketEcosystem).files[rel] = content
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
    classifyDep: makeSolidityClassifier(baseDir),
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .sh/.bash files by
// walking the source/exec graph and reading every reachable script from disk.
// Mirrors buildSolidityBundle's bucketizing, with a bash-specific policy:
//   - a .sh/.bash reference whose path lands INSIDE the bundle root
//     (`source ./lib.sh`, `dir/x.sh`) but resolves to no bundled script is
//     fatal — a self-contained bundle can't carry a dangling local source —
//     as is a missing entry.
//   - everything else is best-effort and dropped: PATH commands (`grep`,
//     `node`), dynamic `$VAR` paths, extensionless sources, absolute system
//     paths (`source /etc/profile.d/x.sh`), and `../` paths that escape the
//     root — none can live in the bundle.
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

  // Bundles must be self-contained: every entry must load, and every .sh/.bash
  // reference pointing inside the bundle root must resolve to a bundled script.
  // External/best-effort references (commands, $VAR paths, extensionless,
  // absolute, or `../`-escaping sources) are left out by buildBashTree and
  // never reach `missing`.
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
    classifyDep: makeRustClassifier(baseDir),
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .php files by
// statically scanning their `require`/`include` graph -- and, when the project
// uses Composer, the class-autoload graph too -- reading every reachable file
// from disk. No PHP is ever executed. Mirrors buildSolidityBundle: files are
// bucketed per package.json, tagged with the `php` format, and edges are keyed
// under a dedicated "php" condition bucket.
//
// Composer autoloading is followed automatically when a composer.json (or
// generated vendor/composer/autoload_*.php map) is present: PSR-4/PSR-0/
// classmap/files config is read and the classes each file references (`use`
// imports, `new`/`extends`/`implements`, type hints, …) are resolved to their
// files the way Composer's ClassLoader would. That resolution is best-effort
// (unresolvable references are typically built-in or extension classes), so it
// never blocks the bundle; explicit `require`/`include` of a literal path is
// still strict.
//
// Refuses to write when an entry can't be loaded or any explicit include is
// unresolved -- a bundle with holes would silently operate on a partial set of
// sources.
export async function buildPhpBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildPhpBundle: at least one entry .php file is required')
  }
  for (const e of entries) {
    if (!e.endsWith('.php')) throw new Error(`buildPhpBundle: not a .php file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  const autoload = loadComposerAutoload(baseDir)

  // Laravel auto-discovers vendor/app service providers (via composer metadata
  // and bootstrap/providers.php) rather than referencing them statically; seed
  // them as extra roots so the config/route/view files they pull in get bundled.
  const providerRoots = loadLaravelProviderFiles(baseDir, autoload)

  const sources = await collectPhpFilesFromDisk(baseDir, [...normalized, ...providerRoots], { autoload })
  const { resolutions, missing } = buildPhpTree(sources, { baseDir, autoload })

  const issues = []
  for (const entry of normalized) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from } of missing) {
    issues.push(`Unresolved import: ${spec} from ${from}`)
  }
  if (issues.length > 0) {
    throw new Error(`PHP bundle has unresolved imports:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }

  // Group per Composer package (vendor/<pkg> buckets with name+version from
  // composer.json / installed.json), not the node_modules-based bucketizer.
  const modules = bucketizePhpSources(baseDir, sources, PHP_WORKSPACE_NAME, PHP_WORKSPACE_VERSION)

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, PHP_FORMAT)

  // PHP includes don't depend on Node conditions; key them under a dedicated
  // "php" bucket rather than the wildcard "*" used for JS code bundles.
  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([['php', importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(normalized),
    modules,
    formats,
    imports,
  })
}

// Build a stasis Bundle (in-memory) from a list of entry .js/.cjs/.mjs (or
// .ts/.cts/.mts) files by statically scanning the require/import graph and
// reading reachable file contents from disk -- no user code is ever loaded or
// executed. TypeScript files behave exactly like JS ones: sources are stored
// verbatim with Node's type-stripping formats recorded, and Node strips the
// types at load time. The bundle shape matches what @exodus/stasis-core/hooks
// records at runtime, so the result loads via `stasis run --bundle=load`
// interchangeably with a runtime-produced one.
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
    throw new Error('buildJsBundle: at least one entry .js/.cjs/.mjs/.ts/.cts/.mts file is required')
  }
  for (const e of entries) {
    if (!JS_EXTS.has(extname(e))) throw new Error(`buildJsBundle: not a JS/TS file: ${e}`)
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
  // guard), so scan salvages the edges. A module-family file ('module' /
  // 'module-typescript') in the eagerly-linked set is a hole we can't
  // enumerate; so is any file the parser couldn't process at all
  // (recovered=false -- nothing was salvaged, and format may even be null).
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format?.startsWith('module') === true || !p.recovered)
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
  // per-edge import map. State.s `serialize` then emits the same v1 layout
  // the runtime loader writes — see @exodus/stasis-core/hooks for the matching pair.
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
    // scan emits Node's module.format strings (module/commonjs/*-typescript); map them to
    // stasis's `<lang>:<kind>` taxonomy at the State boundary, same as the runtime loader
    // (hooks.js) does. addFile's inference then agrees (reconcileFormat), not conflicts.
    state.addFile(url, { format: nodeFormatToStasis(info.format), isEntry })
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

// Classify entries into the single bundle language they all share and check
// option applicability. Shared by buildBundle and bundleCommand; `name`
// prefixes error messages with the caller.
function classifyEntries(name, { entries, mappingFile, scope, lockfile }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${name}: at least one entry file is required`)
  }
  let kind
  if (entries.every((e) => e.endsWith('.sol'))) kind = 'sol'
  else if (entries.every((e) => e.endsWith('.php'))) kind = 'php'
  else if (entries.every((e) => JS_EXTS.has(extname(e)))) kind = 'js'
  else if (entries.every((e) => BASH_EXTS.has(extname(e)))) kind = 'bash'
  else if (entries.every((e) => RUST_EXTS.has(extname(e)))) kind = 'rust'
  else {
    throw new Error(`${name}: entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts, all be .sh/.bash, or all be .rs (no mixing)`)
  }
  if (mappingFile && kind !== 'sol') {
    throw new Error(`${name}: --mapping is only valid for .sol bundles`)
  }
  if (scope !== undefined && kind !== 'js') {
    throw new Error(`${name}: --scope is only valid for JS bundles`)
  }
  if (lockfile !== undefined && kind !== 'js') {
    throw new Error(`${name}: --lockfile is only valid for JS bundles`)
  }
  return kind
}

// Programmatic equivalent of `stasis bundle`: build and return an in-memory
// Bundle from a list of entry files, without writing anything to disk
// (serialize with bundle.serialize() to get the JSON that `stasis bundle`
// brotli-compresses into stasis.code.br).
//
// Dispatch by extension matches the CLI: all entries must be one language —
// .sol (Solidity), .php (PHP), .js/.cjs/.mjs/.ts/.cts/.mts (JS/TS, via static
// scan), .sh/.bash (Bash), or .rs (Rust); mixing fails fast. `mappingFile` is
// the optional Solidity remappings file (foundry.toml or remappings.txt) and
// is only valid for .sol entries; `scope` overrides the configured bundle
// scope and is only valid for JS/TS entries.
export async function buildBundle({ cwd = process.cwd(), entries, mappingFile, scope } = {}) {
  const kind = classifyEntries('buildBundle', { entries, mappingFile, scope })
  if (kind === 'sol') return buildSolidityBundle({ cwd, entries, mappingFile })
  if (kind === 'php') return buildPhpBundle({ cwd, entries })
  if (kind === 'bash') return buildBashBundle({ cwd, entries })
  if (kind === 'rust') return buildRustBundle({ cwd, entries })
  const state = await buildJsBundle({ cwd, entries, scope })
  return state.sourceBundle
}

// Where `stasis bundle` writes when no --output is given: stasis.code.br, the
// same name `stasis run --bundle=load` discovers by default, so the two commands
// round-trip with no flags. A file (not stdout) is the common case; pass
// --output=- to stream the raw brotli bytes to stdout.
const DEFAULT_BUNDLE_FILE = 'stasis.code.br'

// Run the bundle CLI command end-to-end. Always produces a brotli-compressed
// stasis bundle (matching the on-disk format of `stasis.code.br`). Writes to
// `output` when given, to stasis.code.br in `cwd` by default, or to stdout
// when `output` is `-`. Prints a one-line `[stasis] Bundled <n> files in <p>
// packages from <dir> to <dest>` summary to stderr so it doesn't interleave
// with binary output written to stdout.
//
// Dispatch by extension: all entries must be one language — .sol (Solidity),
// .php (PHP), .js/.cjs/.mjs/.ts/.cts/.mts (JS/TS, via static scan), .sh/.bash
// (Bash, via source/exec graph walk), or .rs (Rust, via mod-declaration walk).
// Mixing fails fast; --mapping is .sol only, --scope/--lockfile are JS/TS only.
//
// For JS bundles, an optional `lockfile` path writes a stasis.lock.json that
// attests every file in the bundle. The static scan walks both branches of
// conditional requires (e.g. debug/src/index.js' `if (browser) require('./browser')
// else require('./node')`), so the runtime lockfile from `stasis run --lock=add`
// won't attest the unused branch -- if the user wants `lock=frozen` against a
// statically-built bundle, they need this companion lockfile.
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output, scope, lockfile } = {}) {
  const kind = classifyEntries('bundleCommand', { entries, mappingFile, scope, lockfile })

  let bundle
  let lockData
  if (kind === 'js' && lockfile) {
    // The companion lockfile attests file hashes, which only State carries —
    // a Bundle holds sources, not digests — so this path keeps the State.
    const state = await buildJsBundle({ cwd, entries, scope })
    bundle = state.sourceBundle
    lockData = state.lockData
  } else {
    bundle = await buildBundle({ cwd, entries, mappingFile, scope })
  }
  const serialized = bundle.serialize()
  const files = [...bundle.sources.keys()]
  const modules = bundle.modules

  const data = brotliCompressSync(serialized, brotliOptions())
  // Default to writing stasis.code.br in cwd; `-` is the conventional opt-in
  // for streaming the raw brotli bytes to stdout (e.g. to pipe somewhere else).
  const target = output ?? DEFAULT_BUNDLE_FILE
  if (target === '-') {
    process.stdout.write(data)
  } else {
    const outAbs = resolve(cwd, target)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  }
  if (lockData) {
    const lockAbs = resolve(cwd, lockfile)
    mkdirSync(dirname(lockAbs), { recursive: true })
    writeFileSync(lockAbs, lockData)
  }
  const fromDir = outermostDir(files, resolve(cwd))
  const dest = target === '-' ? '<stdout>' : target
  // Count packages: every non-empty bucket, with the project's own source (the
  // "." workspace bucket) counting as one package alongside each dependency.
  const packages = [...modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  const pkgLabel = `${packages} package${packages === 1 ? '' : 's'}`
  console.warn(`[stasis] Bundled ${files.length} files in ${pkgLabel} from ${fromDir} to ${dest}`)
}
