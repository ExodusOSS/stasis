import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { scan } from '../scan.js'
import { createFieldResolver, resolveConditions } from '../resolve-fields.js'
import { State } from '@exodus/stasis-core/state'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { assertRealPathWithinBase, moduleFileKey, splitNodeModulesPath } from '@exodus/stasis-core/util'
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
// `format` tags every file uniformly (the single-language non-JS callers); pass
// `formats` (a Map<path, format>) instead to tag per file, as the JS resolver path
// does (a graph mixes module / commonjs / *-typescript / json). `resolutions`
// values may be a target string (a flat edge) or a Map<platform, target> (a `--metro`
// edge that resolves differently per platform) -- both round-trip through the bundle's
// recursive serializer untouched.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, workspaceName, workspaceVersion, format, formats, conditionKey, classifyDep,
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

  const formatsMap = new Map()
  for (const path of sources.keys()) formatsMap.set(path, formats?.get(path) ?? format)

  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([[conditionKey, importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats: formatsMap,
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

// Classify a scanner's unresolved edges + parse errors into `fatal` (the bundle
// would be broken, or silently divergent from plain node, at load) vs tolerated
// (a miss runtime code can catch). The rationale for each rule lives at the call
// site in buildJsBundle; this is the shared computation so the plain and the
// resolver-driven (`--mainFields`) JS paths gate identically.
function analyzeScanner(scanner) {
  // Static reachability: files reached from an entry through static ESM
  // `import`/`export ... from` edges load eagerly, before any user code runs, so
  // a failure there is uncatchable; below a require()/dynamic-import() boundary it
  // surfaces as a catchable miss and only warns.
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
  const fatalUnresolved = (u) => staticKinds.has(u.kind) && staticReachable.has(u.parentURL)
  const fatal = scanner.unresolved
    .filter((u) => fatalUnresolved(u))
    .map((u) => `unresolved ${u.kind} ${u.spec} from ${fileURLToPath(u.parentURL)} (${u.reason})`)
  // Parse failures whose edges are genuinely unknown: a module-family file in the
  // eagerly-linked set, or any file the parser couldn't process at all.
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format?.startsWith('module') === true || !p.recovered)
  for (const p of scanner.parseErrors) {
    if (fatalParse(p)) fatal.push(`parse error in ${fileURLToPath(p.url)}: ${p.message}`)
  }
  // Edges resolving to a file a source bundle can't carry (extensionless, .node,
  // .wasm): scan records the edge but never queues the child, so load would die.
  for (const [, byParent] of scanner.imports) {
    for (const [parentURL, specMap] of byParent) {
      for (const [spec, childURL] of specMap) {
        if (!scanner.files.has(childURL)) {
          fatal.push(`${spec} from ${fileURLToPath(parentURL)} resolves to ${fileURLToPath(childURL)}, which a source bundle can't carry`)
        }
      }
    }
  }
  const tolerated = scanner.unresolved.filter((u) => !fatalUnresolved(u))
  const toleratedParse = scanner.parseErrors.filter((p) => !fatalParse(p))
  return { fatal, tolerated, toleratedParse }
}

// Throw on any fatal scan issue (the bundle can't be written); warn on tolerated
// ones. `label`, when set, tags the scan pass in the message.
function reportScanIssues({ fatal, tolerated, toleratedParse }, { label = '' } = {}) {
  const where = label ? ` (${label})` : ''
  if (fatal.length > 0) {
    const shown = fatal.slice(0, 10).map((s) => `  ${s}`).join('\n')
    const more = fatal.length > 10 ? `\n  ... and ${fatal.length - 10} more` : ''
    throw new Error(`JS bundle would be broken at load time${where}:\n${shown}${more}`)
  }
  if (tolerated.length > 0) {
    const summary = tolerated
      .slice(0, 10)
      .map((u) => `  ${u.kind} ${u.spec ?? '<dynamic>'} from ${fileURLToPath(u.parentURL)} (${u.reason})`)
      .join('\n')
    const more = tolerated.length > 10 ? `\n  ... and ${tolerated.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${tolerated.length} unresolved import(s)${where}; they will fall through at load time:\n${summary}${more}`)
  }
  if (toleratedParse.length > 0) {
    const summary = toleratedParse
      .slice(0, 10)
      .map((p) => `  ${fileURLToPath(p.url)}: ${p.message}`)
      .join('\n')
    const more = toleratedParse.length > 10 ? `\n  ... and ${toleratedParse.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${toleratedParse.length} file(s) with parse errors${where}; their recorded imports may be incomplete:\n${summary}${more}`)
  }
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
// Scope comes from the project's stasis.config.json (or `EXODUS_STASIS_SCOPE`);
// pass `scope` explicitly to override.
//
// `conditions` are extra `exports`/`imports` resolution conditions, merged on top
// of the format-derived base set Node always asserts (`node`, `import`/`require`,
// `module-sync`, `node-addons`). They change which branch of a package's
// conditional `exports` the static scan follows -- and therefore which file lands
// in the bundle -- exactly as if Node resolved with those conditions active. Empty
// (the default) reproduces plain Node resolution.
//
// NOTE: conditions are only one input to module resolution. On their own they do
// NOT honour legacy package `mainFields` (`react-native`/`browser`/`main`) or
// platform-specific file suffixes (`.ios`/`.android`/`.native`), neither of which
// the `exports` field expresses; `--mainFields` (see buildResolvedJsBundle) adds
// the former.
export async function buildJsBundle({ cwd = process.cwd(), entries, scope, conditions = [] } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildJsBundle: at least one entry .js/.cjs/.mjs/.ts/.cts/.mts file is required')
  }
  for (const e of entries) {
    if (!JS_EXTS.has(extname(e))) throw new Error(`buildJsBundle: not a JS/TS file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))

  // Normalize conditions the way the CLI already does (trim, drop empties), so the
  // programmatic API (`buildBundle({ conditions })`) tolerates the same sloppy input.
  // A '' or whitespace-only condition never matches an `exports` key, so dropping it
  // is a no-op for clean input -- this just stops a bogus token reaching the resolver.
  const scanConditions = conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)

  const scanner = scan(absEntries, { conditions: scanConditions })

  // Fail closed exactly where the bundle is GUARANTEED broken (or silently
  // divergent from plain node) at load time; warn where runtime code can catch
  // the miss the same way it would without a bundle. Static ESM edges load
  // eagerly (uncatchable) so unresolved ones / unknown parse holes there are
  // fatal; require()/dynamic-import() misses surface at the callsite and only
  // warn -- the optional-dependency pattern (`try { require(x) } catch {}`) keeps
  // bundling, because the runtime loader never records those edges either and
  // state.getImport throws the same catchable MODULE_NOT_FOUND at load. Edges
  // resolving to a file a source bundle can't carry are always fatal. (See
  // analyzeScanner for the precise rules.)
  reportScanIssues(analyzeScanner(scanner))

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

// Source extensions probed when a resolved entry/redirect target names no extension.
// Limited to what a source bundle can actually carry (scan's RESOLVABLE_EXTS), so the
// resolver never resolves a file the bundle would then reject. `--mainFields` lets a
// caller pick its own fields, `--metro` presets the React Native fields, and
// `--conditions` adds its own extra exports conditions.
const SOURCE_EXTS = ['js', 'json', 'ts']
// React Native preset mainFields asserted by `--metro` (which sets these plus the
// react-native/browser conditions and platform suffixes, so the user supplies neither
// --mainFields nor --conditions alongside it).
const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']
// Metro's default `transformer.asyncRequireModulePath`. Metro's transform rewrites
// every dynamic `import()` callsite (and its prefetch/importMaybeSync variants) into
// `require(<asyncRequireModulePath>)(...)` -- see transformImportCall in
// metro/src/ModuleGraph/worker/collectDependencies.js -- so the helper module is a
// real dependency of every module that async-imports, resolved per parent and shipped
// in the bundle, without ANY source file naming it. A static scan can only cover it by
// mirroring the injection (see injectMetroAsyncRequire). Overridable via the
// `asyncRequireModulePath` option because Metro configs override the config key it
// mirrors (Expo sets 'expo/internal/async-require-module' when `expo` is installed).
const METRO_ASYNC_REQUIRE_MODULE_PATH = 'metro-runtime/src/modules/asyncRequire'
// Synthetic, project-relative path for the empty module a browser/react-native
// `false` redirect resolves to. Carried in the bundle as a real (empty) CJS file
// so the edge points at attestable bytes rather than a sentinel.
const EMPTY_MODULE_PATH = '.stasis/empty-module.js'

// Mirror Metro's async-import injection into a platform scan (`--metro` only). Metro's
// transform makes its async-import helper (METRO_ASYNC_REQUIRE_MODULE_PATH, or the
// project's configured override) a dependency of every module that uses a dynamic
// import(): the helper is resolved from each such module like any other bare specifier
// and ships in the bundle, without any source file naming it -- invisible to a plain
// import walk. So: for every scanned module with a dynamic-import edge, resolve the
// helper from that module through the same platform resolver (per-parent, so distinct
// copies in a non-hoisted tree land per parent, exactly like Metro), pull the resolved
// file and its subtree into the scan, and record the edge a runtime StasisMetro capture
// of the real graph would attest: (parent, <asyncRequireModulePath>) -> helper. The
// edge is recorded as a require edge -- that's what the injected callsite compiles to
// -- so the fatal/tolerated gate treats the helper's subtree like any other
// require()-boundary subtree.
//
// The trigger is ANY dynamic-import edge (resolved, unresolved, non-literal, or
// browser-map-emptied): Metro wraps the callsite before resolution, so this errs toward
// attesting the helper, never toward omitting a shipped file. Runs to a fixpoint
// because an injected helper is scanned like any module and may itself dynamic-import
// (a custom helper then gets its own injected edge, possibly onto itself).
//
// Fails closed when the helper can't be resolved (or resolves to a file a source
// bundle can't carry): a bundle silently missing a file Metro ships would defeat the
// attestation -- a frozen/load run against the real build rejects it anyway.
//
// SCOPE: this mirrors the one module Metro's TRANSFORM injects as a graph dependency.
// Metro's serializer-level preModules (the prepended polyfills/runtime, e.g.
// metro-runtime/src/polyfills/require.js, chosen by the config's getPolyfills) are not
// dependencies of any module and not statically knowable here -- they're covered by the
// runtime StasisMetro capture (which receives preModules), not by `stasis bundle --metro`.
function injectMetroAsyncRequire(scanner, resolver, specifier) {
  const done = new Set()
  let pending = [...scanner.files.keys()]
  while (pending.length > 0) {
    for (const url of pending) {
      done.add(url)
      const info = scanner.files.get(url)
      if (!info.edges.some((e) => e.kind === 'dynamic-import')) continue
      const parentFile = fileURLToPath(url)
      const r = resolver(parentFile, specifier)
      // The parent package's browser map applies to the injected resolution like to any
      // other (it's a normal dependency resolution in Metro too): `false` records an
      // empty-module edge; a remap onto a builtin leaves no file edge to record.
      if (r?.builtin) continue
      if (r?.empty) {
        info.edges.push({ kind: 'require', spec: specifier, empty: true })
        continue
      }
      if (!r?.url) {
        throw new Error(
          `Can't resolve Metro's async-import helper '${specifier}' from ${parentFile} -- ` +
          `Metro injects a require() of it into every module that uses a dynamic import(), so it ` +
          `ships in the real bundle and the stasis bundle must attest it. Install it (metro-runtime ` +
          `for Metro's default config), or pass the project's configured ` +
          `transformer.asyncRequireModulePath via --asyncRequireModulePath.`
        )
      }
      const target = fileURLToPath(r.url)
      const ext = extname(target)
      if (!JS_EXTS.has(ext) && ext !== '.json') {
        throw new Error(
          `Metro's async-import helper '${specifier}' resolves to ${target}, which a source bundle can't carry`
        )
      }
      info.edges.push({ kind: 'require', spec: specifier, child: r.url })
      scanner.walkFiles([target])
    }
    pending = [...scanner.files.keys()].filter((u) => !done.has(u))
  }
}

// Build a JS/TS Bundle (and companion Lockfile) through the legacy-field resolver
// (src/resolve-fields.js) rather than Node's resolver -- the `--mainFields` and
// `--metro` paths. The graph is scanned once PER platform (just `[null]` in
// `--mainFields` mode, where there are no platform suffixes); the file set is the union
// across platforms, and each `(parent, specifier)` edge is recorded FLAT (a single
// target) when every platform that has it agrees, and UNFLATTENED to a
// `{ platform: target }` map only where platforms genuinely diverge. A single platform
// therefore never unflattens; platform keys are exactly the supplied platforms (no
// wildcard). A browser/react-native `false` redirect resolves to a synthetic empty
// module carried in the bundle. In `--metro` mode the scan also mirrors Metro's
// async-import injection (see injectMetroAsyncRequire): any dynamic import() pulls in
// `asyncRequireModulePath` (Metro's default helper unless overridden) with a
// per-parent edge, exactly as the transformed bundle ships it. Returns
// { bundle, lockfile } (the lockfile attests the same files + the same -- possibly
// per-platform -- edges, by integrity).
async function buildResolvedJsBundle({
  cwd = process.cwd(), entries, mainFields, platforms, conditions = [], metro = false,
  asyncRequireModulePath = METRO_ASYNC_REQUIRE_MODULE_PATH,
}) {
  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))
  const normalized = normalizeEntries(entries, cwd)

  const toRel = (abs) => {
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Bundle would reach a file outside the project root: ${abs}`)
    }
    return rel
  }

  // Normalize conditions like buildJsBundle does, so a sloppy programmatic caller
  // (stray '' / whitespace) can't push a bogus token into the resolver.
  const scanConditions = conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)

  const formatsByRel = new Map()
  // parentRel -> specifier -> Map<platformKey, targetRel>. Collapsed into flat /
  // platform-map edges after every platform has been scanned.
  const edges = new Map()
  const reached = new Set() // absolute paths of every real file reached on any platform
  let usesEmpty = false

  for (const platform of platforms) {
    // `--metro` asserts the React Native preset's conditions (react-native, plus
    // browser for the web platform); `--mainFields` (platform === null) carries the
    // user's own `--conditions`. scan layers these on the format-derived base.
    const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : scanConditions
    const resolver = createFieldResolver({
      mainFields,
      platform,
      preferNative: platform !== null && platform !== 'web',
      sourceExts: SOURCE_EXTS,
      conditions: resolveConditions('commonjs', extras),
    })
    const scanner = scan(absEntries, { conditions: extras, resolve: resolver })
    // Metro mode: mirror the async-import helper injection BEFORE gating/recording, so
    // the helper's files and edges flow through the same checks as everything else.
    if (metro) injectMetroAsyncRequire(scanner, resolver, asyncRequireModulePath)
    reportScanIssues(analyzeScanner(scanner), { label: platform ?? 'mainFields' })

    const platformKey = platform ?? '*' // '*' is a private placeholder for the single mainFields pass; it never unflattens
    for (const [url, info] of scanner.files) {
      const rel = toRel(fileURLToPath(url))
      reached.add(fileURLToPath(url))
      formatsByRel.set(rel, info.format)
      for (const e of info.edges) {
        if (e.builtin || e.dynamic) continue
        let target
        if (e.empty) { usesEmpty = true; target = EMPTY_MODULE_PATH }
        else if (e.child) target = toRel(fileURLToPath(e.child))
        else continue // unresolved (already warned/thrown by reportScanIssues)
        if (!edges.has(rel)) edges.set(rel, new Map())
        const bySpec = edges.get(rel)
        if (!bySpec.has(e.spec)) bySpec.set(e.spec, new Map())
        bySpec.get(e.spec).set(platformKey, target)
      }
    }
  }

  // Read every reached file's bytes once: content for the bundle, integrity for the
  // lockfile (hash the raw bytes so it matches `stasis run --lock=frozen`). The stored
  // source is UTF-8 text, so the bytes must BE valid UTF-8 -- otherwise toString('utf8')
  // would lossily diverge from the hashed bytes.
  const sources = new Map()
  const integrities = new Map()
  const realBase = realpathSync(baseDir)
  for (const abs of reached) {
    const rel = toRel(abs)
    // A bundle must carry only in-tree, attestable bytes. The field resolver returns the
    // lexical path it probed, so an in-tree-named symlink whose real target escapes the
    // project root would slip past toRel's textual check -- realpath it and fail closed,
    // the same way the State-based JS path and the non-JS loaders do.
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    if (!isUtf8(buf)) throw new Error(`JS bundle source is not valid UTF-8: ${rel}`)
    sources.set(rel, buf.toString('utf8'))
    integrities.set(rel, sha512integrity(buf))
  }
  if (usesEmpty) {
    // The empty module is synthetic; refuse to shadow a real reached file that
    // happens to sit at the reserved path rather than silently clobber it.
    if (formatsByRel.has(EMPTY_MODULE_PATH)) {
      throw new Error(`Bundle needs the reserved empty-module path ${EMPTY_MODULE_PATH}, but the project has a real file there`)
    }
    sources.set(EMPTY_MODULE_PATH, '')
    formatsByRel.set(EMPTY_MODULE_PATH, 'commonjs')
    integrities.set(EMPTY_MODULE_PATH, sha512integrity(Buffer.alloc(0)))
  }

  // Collapse each edge: one distinct target across the platforms that have it -> flat
  // string; otherwise a Map<platform, target> (platform keys only, sorted).
  const resolutions = new Map()
  for (const [parent, bySpec] of edges) {
    const specMap = new Map()
    for (const [spec, byPlatform] of bySpec) {
      const distinct = new Set(byPlatform.values())
      if (distinct.size === 1) {
        specMap.set(spec, [...distinct][0])
      } else {
        specMap.set(spec, new Map([...byPlatform].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))))
      }
    }
    resolutions.set(parent, specMap)
  }

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const bundle = assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    formats: formatsByRel,
    workspaceName: rootPkg.name ?? 'workspace',
    workspaceVersion: rootPkg.version ?? '0.0.0',
    conditionKey: '*',
  })

  // The companion lockfile mirrors the bundle exactly, swapping file content for
  // its integrity. modules/imports/formats/entries are shared shapes, so a frozen
  // lockfile attests the same resolution graph the bundle carries.
  const lockModules = new Map()
  for (const [dir, m] of bundle.modules) {
    const files = Object.create(null)
    for (const rel of Object.keys(m.files)) files[rel] = integrities.get(moduleFileKey(dir, rel))
    lockModules.set(dir, { name: m.name, version: m.version, ...(m.ecosystem === undefined ? {} : { ecosystem: m.ecosystem }), files })
  }
  const lockfile = new Lockfile({
    config: bundle.config,
    entries: bundle.entries,
    modules: lockModules,
    imports: bundle.imports,
    formats: bundle.formats,
  })

  return { bundle, lockfile }
}

// Classify entries into the single bundle language they all share and check
// option applicability. Shared by buildBundle and bundleCommand; `name`
// prefixes error messages with the caller.
function classifyEntries(name, { entries, mappingFile, scope, lockfile, conditions, mainFields, platforms, metro, asyncRequireModulePath }) {
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
  // Conditions only steer Node's `exports`/`imports` resolution, which the other
  // languages' resolvers don't consult -- reject them rather than accept a flag
  // that would silently do nothing.
  if (Array.isArray(conditions) && conditions.length > 0 && kind !== 'js') {
    throw new Error(`${name}: --conditions is only valid for JS bundles`)
  }
  // --mainFields and --metro/--platforms are legacy-/platform-resolution knobs; JS-only.
  if (mainFields !== undefined && kind !== 'js') {
    throw new Error(`${name}: --mainFields is only valid for JS bundles`)
  }
  if ((metro || (Array.isArray(platforms) && platforms.length > 0)) && kind !== 'js') {
    throw new Error(`${name}: --metro is only valid for JS bundles`)
  }
  // `--metro` is a preset for conditions + mainFields + platform suffixes, so it can't
  // be combined with explicit --conditions/--mainFields (they'd conflict), and it needs
  // --platforms to know which suffixes to resolve. `--platforms` is meaningless without it.
  if (metro) {
    if (Array.isArray(conditions) && conditions.length > 0) {
      throw new Error(`${name}: --conditions can't be combined with --metro (it sets its own conditions)`)
    }
    if (mainFields !== undefined) {
      throw new Error(`${name}: --mainFields can't be combined with --metro (it sets its own mainFields)`)
    }
    if (!Array.isArray(platforms) || platforms.length === 0) {
      throw new Error(`${name}: --metro requires --platforms (e.g. --platforms=ios,android)`)
    }
    // A platform name becomes a bundle/lockfile edge key (Bundle/Lockfile parse reject
    // a '/'); '*' is the reserved private placeholder. Reject both so the writer can
    // never emit an edge map the readers refuse -- a divergent-edge, data-dependent break.
    for (const p of platforms) {
      if (typeof p !== 'string' || p.length === 0 || p === '*' || p.includes('/')) {
        throw new Error(`${name}: invalid platform '${p}' (a platform name can't be empty, contain '/', or be '*')`)
      }
    }
  } else if (Array.isArray(platforms) && platforms.length > 0) {
    throw new Error(`${name}: --platforms is only valid with --metro`)
  }
  // --asyncRequireModulePath overrides which async-import helper `--metro` injects for
  // dynamic import()s (mirroring Metro's `transformer.asyncRequireModulePath` config
  // key); outside --metro nothing injects, so the option would be silently ignored.
  if (asyncRequireModulePath !== undefined) {
    if (!metro) throw new Error(`${name}: --asyncRequireModulePath is only valid with --metro`)
    if (typeof asyncRequireModulePath !== 'string' || asyncRequireModulePath.length === 0) {
      throw new Error(`${name}: --asyncRequireModulePath must be a non-empty module specifier`)
    }
  }
  // The field resolver always emits a full-scope bundle (no node_modules-only mode), so
  // --scope alongside --mainFields/--metro would be silently ignored -- reject it.
  if (scope !== undefined && (mainFields !== undefined || metro)) {
    throw new Error(`${name}: --scope is not supported with --mainFields or --metro`)
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
// scope and is only valid for JS/TS entries; `conditions` are extra `exports`
// resolution conditions (e.g. `['react-native']`) and are JS/TS-only too.
//
// `mainFields` (an array of legacy package fields, e.g. `['react-native','browser','main']`)
// selects the legacy-field resolver -- see buildResolvedJsBundle. It resolves
// non-`exports` packages via those fields, including the browser-field object
// redirection, and composes with `conditions`. `metro: true` is instead a preset that
// sets its OWN React Native fields + conditions + platform suffixes (so it is not
// combined with `mainFields`/`conditions`) and requires `platforms` (e.g.
// `['ios','android']`); the edge graph is then per-platform, and any dynamic import()
// additionally pulls in Metro's async-import helper the way Metro's transform injects
// it -- `asyncRequireModulePath` (metro-only) overrides which helper, mirroring the
// Metro config key of the same name (e.g. Expo's 'expo/internal/async-require-module').
// JS/TS-only.
export async function buildBundle({ cwd = process.cwd(), entries, mappingFile, scope, conditions, mainFields, platforms, metro, asyncRequireModulePath } = {}) {
  const kind = classifyEntries('buildBundle', { entries, mappingFile, scope, conditions, mainFields, platforms, metro, asyncRequireModulePath })
  if (kind === 'sol') return buildSolidityBundle({ cwd, entries, mappingFile })
  if (kind === 'php') return buildPhpBundle({ cwd, entries })
  if (kind === 'bash') return buildBashBundle({ cwd, entries })
  if (kind === 'rust') return buildRustBundle({ cwd, entries })
  if (metro || mainFields !== undefined) {
    const { bundle } = await buildResolvedJsBundle({
      cwd,
      entries,
      mainFields: metro ? METRO_MAIN_FIELDS : mainFields,
      platforms: metro ? platforms : [null],
      conditions,
      metro: Boolean(metro),
      ...(asyncRequireModulePath === undefined ? {} : { asyncRequireModulePath }),
    })
    return bundle
  }
  const state = await buildJsBundle({ cwd, entries, scope, conditions })
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
// Mixing fails fast; --mapping is .sol only, --scope/--lockfile/--conditions are
// JS/TS only.
//
// `conditions` are extra Node `exports`/`imports` resolution conditions to assert
// during the static scan (e.g. `['react-native']` or `['browser']`). They only
// affect `exports`/`imports` condition matching -- not legacy mainFields -- so on
// their own they don't honour a package's legacy entry fields. See buildJsBundle.
//
// `metro`/`platforms` resolve the way Metro does (see buildResolvedJsBundle); with
// them, `asyncRequireModulePath` overrides which async-import helper a dynamic
// import() injects, mirroring Metro's `transformer.asyncRequireModulePath` config key.
//
// For JS bundles, an optional `lockfile` path writes a stasis.lock.json that
// attests every file in the bundle. The static scan walks both branches of
// conditional requires (e.g. debug/src/index.js' `if (browser) require('./browser')
// else require('./node')`), so the runtime lockfile from `stasis run --lock=add`
// won't attest the unused branch -- if the user wants `lock=frozen` against a
// statically-built bundle, they need this companion lockfile.
//
// With `--conditions`, that companion lockfile attests the conditions-SELECTED
// resolution graph. A plain `stasis run --lock=frozen` doesn't replay `--conditions`,
// so it resolves different files on disk and fails closed (correctly -- the lockfile
// genuinely attests a different graph). Pair such a lockfile with `--bundle=load`, or
// replay the same `--conditions` at run time, so the attested and observed graphs agree.
// `brotliQuality` (integer 0..11, optional; unset = brotli's default 11) tunes the
// output compression, forwarded to brotliOptions().
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output, scope, lockfile, conditions, mainFields, platforms, metro, asyncRequireModulePath, brotliQuality } = {}) {
  const kind = classifyEntries('bundleCommand', { entries, mappingFile, scope, lockfile, conditions, mainFields, platforms, metro, asyncRequireModulePath })

  let bundle
  let lockData
  if (kind === 'js' && (metro || mainFields !== undefined)) {
    // The legacy-field resolver path builds the Bundle (and the matching Lockfile)
    // directly -- it carries per-platform edges and a synthetic empty module (for a
    // browser/react-native `false` redirect) that State's disk-reading addFile can't
    // represent.
    const built = await buildResolvedJsBundle({
      cwd,
      entries,
      mainFields: metro ? METRO_MAIN_FIELDS : mainFields,
      platforms: metro ? platforms : [null],
      conditions,
      metro: Boolean(metro),
      ...(asyncRequireModulePath === undefined ? {} : { asyncRequireModulePath }),
    })
    bundle = built.bundle
    if (lockfile) lockData = built.lockfile.serialize()
  } else if (kind === 'js' && lockfile) {
    // The companion lockfile attests file hashes, which only State carries —
    // a Bundle holds sources, not digests — so this path keeps the State.
    const state = await buildJsBundle({ cwd, entries, scope, conditions })
    bundle = state.sourceBundle
    lockData = state.lockData
  } else {
    bundle = await buildBundle({ cwd, entries, mappingFile, scope, conditions })
  }
  const serialized = bundle.serialize()
  const files = [...bundle.sources.keys()]
  const modules = bundle.modules

  const data = brotliCompressSync(serialized, brotliOptions(brotliQuality))
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
