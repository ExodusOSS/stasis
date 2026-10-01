import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { scan } from '../scan.js'
import { createFieldResolver, resolveConditions } from '../resolve-fields.js'
import { discoverTsconfig, isDir, loadTsconfigPaths } from '../resolve-typescript.js'
import { createMetroResolver } from '../metro-resolver.js'
import { State } from '@exodus/stasis-core/state'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { detectRepo, findPackageMetadata, normalizeEntries, packageType, readJson, readModuleManifest, readPackageJson, readRegularFileOrNull } from '@exodus/stasis-core/bundle-util'
import { RN_CORE_INCLUDE_FILES, assertRealPathWithinBase, classifyNativeCapture, isDotEnvFile, isExcludedNativeDir, isExecutableFile, isNativeArtifact, isNativeManifest, isPodspec, isSkippedNativeWalkDir, moduleFileKey, parseResourcesOption, posixPathEscapes, refineNativeCapture, splitNodeModulesPath } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
import {
  SOLIDITY_PACKAGE_MANIFESTS,
  SOLIDITY_ROOT_MANIFESTS,
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  discoverSolidityConfig,
  expandSolidityEntries,
} from '../loaders/solidity.js'
import { readGitmodules } from '../loaders/solidity-ownership.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { buildRustTree, collectRustFilesFromDisk } from '../loaders/rust.js'
import { VENDOR_DIR as CARGO_VENDOR_DIR, createCargoContext } from '../loaders/cargo.js'
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

// Fallback identity for the workspace bucket; Bundle.parse requires every bucket to attest name+version.
const SOLIDITY_WORKSPACE_NAME = 'solidity-bundle'
const SOLIDITY_WORKSPACE_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'
const BASH_WORKSPACE_NAME = 'bash-bundle'
const BASH_WORKSPACE_VERSION = '0.0.0'
const SHELL_FORMAT = 'shell'

const RUST_WORKSPACE_NAME = 'rust-bundle'
const RUST_WORKSPACE_VERSION = '0.0.0'
const RUST_FORMAT = 'rust'

const PHP_WORKSPACE_NAME = 'php-bundle'
const PHP_WORKSPACE_VERSION = '0.0.0'
const PHP_FORMAT = 'php'

// Deepest common parent dir of `paths`, relative to `cwd`; starts with `..` when entries
// escape cwd (e.g. via remapping), or "." when it is cwd itself.
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

// Split a Soldeer dep dir `<name>-<version>` (its authoritative identity); falls back to
// version 0.0.0 when it doesn't end in a semver (every bucket must attest a version).
function parseSoldeerDir(seg) {
  const m = /^(.+)-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/u.exec(seg)
  return m ? { name: m[1], version: m[2] } : { name: seg, version: '0.0.0' }
}

// Extract `owner/repo` from a github.com remote (https/ssh/scp); null for non-github hosts.
function githubSlug(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

// `.gitmodules` (readGitmodules) -> Map<submodulePath, { name, branch }>, github.com submodules
// only.
function parseGithubSubmodules(baseDir) {
  const byPath = new Map()
  for (const { path, url, branch } of readGitmodules(baseDir)) {
    const name = githubSlug(url)
    if (name) byPath.set(path, { name, branch })
  }
  return byPath
}

// Classify a Solidity file's dep bucket: Soldeer (`dependencies/<name>-<version>/`) or a
// github submodule (`lib/`, via `.gitmodules`), else null to defer to the node_modules/
// workspace logic. `check` vets a package.json path before it is read (ownership.assert).
function makeSolidityClassifier(baseDir, check) {
  const submodules = parseGithubSubmodules(baseDir)
  const versions = new Map() // a submodule's package.json version, read once
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
        if (!versions.has(sub)) versions.set(sub, readPackageJson(baseDir, moduleFileKey(sub, 'package.json'), { strict: true, check })?.version)
        return { bucketDir: sub, name, version: versions.get(sub) ?? branch ?? '0.0.0', ecosystem: 'github' }
      }
    }
    return null
  }
}

// Classify a Rust file by the nearest Cargo.toml `[package]`: a `cargo vendor`ed crate under
// `vendor/<dir>/` is a dependency (tagged `cargo`); any other package (the crate itself, a
// workspace member reached through a `path` dependency) is first-party, so no ecosystem. Null
// (no manifest above the file) defers to the package.json/placeholder logic.
function makeRustClassifier(cargo) {
  return (path) => {
    const pkg = cargo.packageInfo(path)
    if (!pkg) return null
    const vendored = pkg.dir.startsWith(`${CARGO_VENDOR_DIR}/`)
    return { bucketDir: pkg.dir, name: pkg.name, version: pkg.version, ecosystem: vendored ? 'cargo' : undefined }
  }
}

// A file's key inside its bucket: the inverse of moduleFileKey.
const fileInBucket = (bucketDir, path) => (bucketDir === '.' ? path : path.slice(bucketDir.length + 1))

// Project-relative paths in `sources` whose on-disk file carries a POSIX execute bit -- the
// `executable` list both artifacts record. The State-driven path derives this in addFile; the
// static builders never touch a State, so they stat here.
function executableSources(baseDir, sources, host) {
  const executable = new Set()
  for (const path of sources.keys()) {
    if (isExecutableFile(join(baseDir, path), host)) executable.add(path)
  }
  return executable
}

// Assemble a full-scope code Bundle shared by the non-JS bundlers. Files are bucketed by
// nearest package.json (node_modules -> `npm`-tagged bucket, workspace -> its dir, none ->
// "." with the placeholder identity); a node_modules file whose nearest package.json is the
// workspace root is rejected, not mislabeled; `packageOf(path)` finds that package.json
// (packageLookup by default, which walks past a malformed one). `classifyDep(path)` optionally
// places a file directly (non-node_modules ecosystems like Soldeer/github); null defers. `format` tags
// every file; `formats` (Map<path,format>) overrides it per file. `resolutions` values are
// a flat target string or a Map<platform,target>; both round-trip untouched.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, workspaceName, workspaceVersion, format, formats, conditionKey, classifyDep, host,
  packageOf = packageLookup(baseDir, { host }),
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
      ensureBucket(dep.bucketDir, dep.name, dep.version, dep.ecosystem).files[fileInBucket(dep.bucketDir, path)] = content
      continue
    }
    const meta = packageOf(path)
    const inNodeModules = splitNodeModulesPath(path) !== null
    if (meta) {
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`No package.json with name+version found for ${path}`)
      }
      const bucketEcosystem = meta.pkgDir.includes('node_modules') ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, bucketEcosystem).files[fileInBucket(meta.pkgDir, path)] = content
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

  // Executable bits, straight off disk (a synthetic source with no file there is simply not
  // executable). Shell bundles lean on this most: `stasis extract` puts the +x back on the scripts.
  const executable = executableSources(baseDir, sources, host)

  // Attribute files to the `bundle` consumer (static builders skip State's per-file tagging).
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats: formatsMap,
    imports,
    executable,
  }).withReason('bundle')
}

// Files never carried, whatever reads them: `.env` files, and Hardhat's config, which is code.
const neverCarried = (rel) => isDotEnvFile(rel) || posix.basename(rel).startsWith('hardhat.config.')

// findPackageMetadata (with `options`) once per directory, the only thing its answer depends on.
function packageLookup(baseDir, options) {
  const byDir = new Map()
  return (path) => {
    const dir = posix.dirname(path)
    if (!byDir.has(dir)) byDir.set(dir, findPackageMetadata(baseDir, path, options))
    return byDir.get(dir)
  }
}

// The build-description files of a Solidity bundle (--manifests), as Map<path, text>, sorted:
// `configFiles` (what discoverSolidityConfig read, whatever they're called), each of which must be
// carried -- one outside the root, neverCarried, refused or gone is an error, as the bundle
// couldn't reproduce the resolution without it -- plus the SOLIDITY_*_MANIFESTS that exist, for the
// root and for each package dir `classifyDep`/`packageOf` places a bundled source in, but none
// whose path `ownership` refuses (see solidityOwnership). Carried as written: whatever they hold
// (an RPC URL with its API key, an Etherscan key, a URL's credentials) is in the bundle too, as
// with --package-json.
function solidityManifests(baseDir, sources, configFiles, { classifyDep, packageOf, ownership }) {
  const realBase = realpathSync(baseDir)
  // `{ text }`, or `{ why }` it can't be carried (null: nothing is there). Read by the real path
  // `ownership` resolved `rel` to, so what's carried is the file it vouched for.
  const carry = (rel) => {
    const { reason, real, outside } = ownership.of(rel)
    if (reason) return { why: reason }
    if (real === null) return { why: null }
    if (outside) throw new Error(`Refusing to follow symlink escaping bundle root: ${rel} -> ${resolve(realBase, real)}`)
    const buf = readRegularFileOrNull(join(realBase, real), rel)
    if (buf === null) return { why: null } // a directory
    if (!isUtf8(buf)) throw new Error(`Solidity manifest is not valid UTF-8: ${rel}`)
    return { text: buf.toString('utf8') }
  }
  const unreproducible = (rel, why) => new Error(`--manifests can't carry ${rel}, which the Solidity resolution read: ${why}`)
  const out = new Map()
  for (const rel of configFiles) {
    if (posixPathEscapes(rel)) throw unreproducible(rel, 'it lies outside the bundle root')
    if (neverCarried(rel)) throw unreproducible(rel, '.env files and hardhat.config.* are never carried')
    if (sources.has(rel)) continue
    const { text, why } = carry(rel)
    if (text === undefined) throw unreproducible(rel, why ?? 'it is gone')
    out.set(rel, text)
  }
  const optional = new Set(SOLIDITY_ROOT_MANIFESTS)
  for (const path of sources.keys()) {
    const dirs = [classifyDep(path)?.bucketDir, packageOf(path)?.pkgDir].filter((d) => d !== undefined)
    for (const dir of dirs) for (const name of SOLIDITY_PACKAGE_MANIFESTS) optional.add(moduleFileKey(dir, name))
  }
  for (const rel of optional) {
    if (sources.has(rel) || out.has(rel)) continue
    const { text, why } = carry(rel)
    if (why) console.warn(`[stasis] Not carrying ${rel}: ${why}`)
    if (text !== undefined) out.set(rel, text)
  }
  return new Map([...out.keys()].toSorted().map((rel) => [rel, out.get(rel)]))
}

// An entry `stasis bundle` takes for a directory: one that is, or an extensionless path that
// doesn't exist (a project without `script/` still bundles with `src test script`).
export const isDirEntry = (abs, host = diskHost) => isDir(abs, host) || (extname(abs) === '' && host.stat(abs) === null)

// What's wrong with `entries`' directory entries (resolved against `cwd`), or null: a directory
// entry stands for the .sol files under it, so it goes with Solidity entries only; and entries
// that are all missing extensionless paths are a mistyped file, not a project without those dirs.
export function directoryEntryError(entries, cwd = process.cwd(), host = diskHost) {
  const dirs = entries.filter((e) => isDirEntry(resolve(cwd, e), host))
  const absent = dirs.filter((e) => host.stat(resolve(cwd, e)) === null)
  if (absent.length === entries.length) return `no such file or directory: ${absent[0]}`
  if (dirs.length === 0 || entries.every((e) => e.endsWith('.sol') || dirs.includes(e))) return null
  return absent.length > 0
    ? `no such file or directory: ${absent[0]}`
    : `a directory entry is only supported for Solidity bundles (it stands for the .sol files under it): ${dirs[0]}`
}

// Build an in-memory Bundle from entry .sol files and directories (a directory stands for the .sol
// files under it, as forge's src/test/script dirs and Hardhat's contracts dir do; a missing or
// empty one is skipped). Imports resolve through the remappings the project's build uses
// (discoverSolidityConfig: forge's discovery for a Foundry project); `mappingFile`
// (foundry.toml/remappings.txt) pins them to exactly what it lists. An import is refused when it
// reaches a non-.sol file or leaves the root, or when a dependency's reaches the project's own
// files. Config files are read, and bundled only with `manifests` (see solidityManifests). `env`
// supplies FOUNDRY_PROFILE / FOUNDRY_REMAPPINGS, reported when they apply. The project is read
// through `host`.
export async function buildSolidityBundle({ cwd = process.cwd(), entries, mappingFile, manifests = false, env = process.env, host = diskHost } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildSolidityBundle: at least one entry .sol file or directory is required')
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  for (const e of normalized) {
    if (!e.endsWith('.sol') && !isDirEntry(join(baseDir, e), host)) throw new Error(`buildSolidityBundle: not a .sol file or directory: ${e}`)
  }
  const expanded = expandSolidityEntries(baseDir, normalized, host)

  const { remappings, libs, ownership, files: configFiles, envUsed } = await discoverSolidityConfig(baseDir, { mappingFile, env })
  // The bundle doesn't record the environment, so say when it shaped the resolution.
  if (envUsed.length > 0) console.warn(`[stasis] Solidity imports resolved with ${envUsed.join(', ')} from the environment`)
  const sources = await collectSolidityFilesFromDisk(baseDir, expanded, remappings, { libs, ownership })
  const { resolutions, missing } = buildSolidityTree(sources, { remappings, baseDir, libs, ownership })

  // Bundles must be self-contained: fail on a missing entry or unresolved import.
  const issues = []
  for (const entry of expanded) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from, reason } of missing) {
    issues.push(`Unresolved import: ${spec} from ${from}${reason ? ` (refused: ${reason})` : ''}`)
  }
  if (issues.length > 0) {
    throw new Error(`Solidity bundle has unresolved imports:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }

  const classifyDep = makeSolidityClassifier(baseDir, ownership.assert)
  const packageOf = packageLookup(baseDir, { strict: true, check: ownership.assert })
  const bundled = new Map(sources)
  const formats = new Map()
  if (manifests) {
    for (const [path, text] of solidityManifests(baseDir, sources, configFiles, { classifyDep, packageOf, ownership })) {
      bundled.set(path, text)
      formats.set(path, posix.basename(path) === 'package.json' ? 'json' : 'resource')
    }
  }

  return assembleCodeBundle({
    baseDir,
    entries: expanded,
    sources: bundled,
    resolutions,
    workspaceName: SOLIDITY_WORKSPACE_NAME,
    workspaceVersion: SOLIDITY_WORKSPACE_VERSION,
    format: SOLIDITY_FORMAT,
    formats,
    conditionKey: 'solidity',
    classifyDep,
    packageOf,
  })
}

// Build an in-memory Bundle from entry .sh/.bash files by walking the source/exec graph.
// A local `source` inside the bundle root that resolves to no bundled script is fatal;
// external refs (PATH commands, `$VAR`, absolute, `../`-escaping) are dropped.
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

  // Self-contained: fail on a missing entry or unresolved in-root script (external refs never reach `missing`).
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
    format: SHELL_FORMAT,
    conditionKey: SHELL_FORMAT,
  })
}

// Build an in-memory Bundle from entry .rs files (crate roots) by walking `mod` declarations and
// references to in-tree crates (the package's own lib, Cargo `path` deps, `cargo vendor`ed
// crates). An unresolvable unconditional `mod` is fatal; path edges (`crate::`/`self::`/`super::`/
// relative `use`s) are recorded best-effort and never widen the file set. Registry deps that
// aren't vendored can't be bundled: they're reported, with a `cargo vendor` hint when there is no
// `vendor/` dir at all. Each crate's features are resolved from the manifests (Cargo.toml +
// Cargo.lock) the way `cargo build` of the entries' packages would, so `#[cfg(feature = …)]` code
// that is off stays out; `cargo` takes them from `cargo metadata` instead (opt-in: it runs cargo).
// `cargoFeatures` / `cargoNoDefaultFeatures` / `cargoAllFeatures` are cargo's `--features` /
// `--no-default-features` / `--all-features` for the entries' packages, in either mode.
export async function buildRustBundle({ cwd = process.cwd(), entries, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildRustBundle: at least one entry .rs file is required')
  }
  for (const e of entries) {
    if (!RUST_EXTS.has(extname(e))) throw new Error(`buildRustBundle: not a .rs file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)

  // One Cargo context for the walk, the edge pass and the bucketing: manifests are read once, and
  // the walk's crate resolution and the tree's feature decisions agree.
  const cargoCtx = createCargoContext(baseDir, {
    entries: normalized,
    cargo,
    features: cargoFeatures,
    noDefaultFeatures: cargoNoDefaultFeatures,
    allFeatures: cargoAllFeatures,
  })
  const sources = await collectRustFilesFromDisk(baseDir, normalized, { cargo: cargoCtx })
  const { resolutions, missing, unresolvedCrates } = buildRustTree(sources, { roots: normalized, baseDir, cargo: cargoCtx })

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

  // EXODUS_STASIS_DEBUG=1: show the feature resolution the cfg decisions came from, per package, so
  // the manifest replay and `cargo metadata` (which unifies dev/build deps like resolver 1) can be compared.
  if (process.env.EXODUS_STASIS_DEBUG === '1' || process.env.EXODUS_STASIS_DEBUG === 'true') {
    const resolved = [...cargoCtx.resolvedFeatures()].toSorted(([a], [b]) => (a < b ? -1 : 1))
    const mode = cargo ? 'cargo metadata' : 'Cargo.toml + Cargo.lock'
    console.warn(`[stasis] Rust features (${mode}), ${resolved.length} package${resolved.length === 1 ? '' : 's'}:`)
    for (const [dir, set] of resolved) {
      const pkg = cargoCtx.packageInfo(moduleFileKey(dir, 'Cargo.toml'))
      console.warn(`[stasis]   ${pkg?.name ?? '?'}@${pkg?.version ?? '?'} (${dir}): ${[...set].toSorted().join(', ') || '(none)'}`)
    }
  }

  // Deps live outside the bundle root unless vendored; with no `vendor/` dir the fix is one command.
  if (unresolvedCrates.size > 0 && !existsSync(join(baseDir, CARGO_VENDOR_DIR))) {
    const names = [...unresolvedCrates].toSorted()
    const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? `, ... and ${names.length - 10} more` : '')
    console.warn(`[stasis] ${names.length} crate${names.length === 1 ? '' : 's'} referenced but not found in the bundle root: ${shown}`)
    console.warn('[stasis] Registry dependencies are bundled only when vendored in-tree: run `cargo vendor` first.')
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
    classifyDep: makeRustClassifier(cargoCtx),
  })
}

// Build an in-memory Bundle from entry .php files by statically scanning the
// require/include graph (and Composer's class-autoload graph when present); no PHP is
// executed. Autoload resolution is best-effort; explicit require/include of a literal path
// is strict, and a missing entry or unresolved explicit include is fatal.
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

  // Laravel auto-discovers service providers rather than referencing them statically; seed
  // them as extra roots so their config/route/view files get bundled.
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

  // Group per Composer package (vendor/<pkg>), not the node_modules bucketizer.
  const modules = bucketizePhpSources(baseDir, sources, PHP_WORKSPACE_NAME, PHP_WORKSPACE_VERSION)

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, PHP_FORMAT)

  // PHP includes don't vary by Node condition; key edges under "php", not the JS wildcard "*".
  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([['php', importsForKey]])

  // Attribute to the `bundle` consumer, like the other static builders.
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(normalized),
    modules,
    formats,
    imports,
    executable: executableSources(baseDir, sources),
  }).withReason('bundle')
}

// Render a scanned file URL for diagnostics: project-relative when inside `baseDir`, else absolute.
// The scan issue checks run on the LIVE scan, whose files/imports are keyed by absolute file: URLs
// (the resolver returns absolute paths); relativizing here matches the project-relative paths the
// bundle itself stores (toRel), rather than leaking the machine's absolute paths into the message.
function displayPath(url, baseDir) {
  const abs = fileURLToPath(url)
  if (!baseDir) return abs
  const rel = relative(baseDir, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
}

// Classify scanner unresolved edges + parse errors into fatal (broken/divergent at load)
// vs tolerated (a catchable runtime miss). Shared so the plain and --mainFields JS paths
// gate identically. `baseDir` relativizes the paths in the emitted messages (see displayPath).
function analyzeScanner(scanner, { baseDir } = {}) {
  const show = (url) => displayPath(url, baseDir)
  // Static ESM import/export-from edges load eagerly before user code, so a failure there is
  // uncatchable (fatal); misses below a require()/dynamic-import() boundary are catchable (warn).
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
    .map((u) => `unresolved ${u.kind} ${u.spec} from ${show(u.parentURL)} (${u.reason})`)
  // Fatal parse: an eagerly-linked module-family file, or any file the parser couldn't process.
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format?.startsWith('module') === true || !p.recovered)
  for (const p of scanner.parseErrors) {
    if (fatalParse(p)) fatal.push(`parse error in ${show(p.url)}: ${p.message}`)
  }
  // Edge resolving to a file a source bundle can't carry (.node/.wasm/extensionless): scan
  // records it but never queues the child, so load would die.
  for (const [, byParent] of scanner.imports) {
    for (const [parentURL, specMap] of byParent) {
      for (const [spec, childURL] of specMap) {
        if (!scanner.files.has(childURL)) {
          fatal.push(`${spec} from ${show(parentURL)} resolves to ${show(childURL)}, which a source bundle can't carry`)
        }
      }
    }
  }
  const tolerated = scanner.unresolved.filter((u) => !fatalUnresolved(u))
  const toleratedParse = scanner.parseErrors.filter((p) => !fatalParse(p))
  return { fatal, tolerated, toleratedParse }
}

// Throw on fatal scan issues; warn on tolerated ones. `label` tags the scan pass; `baseDir`
// relativizes the paths in the warnings (see displayPath), matching analyzeScanner's messages.
function reportScanIssues({ fatal, tolerated, toleratedParse }, { label = '', baseDir } = {}) {
  const where = label ? ` (${label})` : ''
  const show = (url) => displayPath(url, baseDir)
  if (fatal.length > 0) {
    const shown = fatal.slice(0, 10).map((s) => `  ${s}`).join('\n')
    const more = fatal.length > 10 ? `\n  ... and ${fatal.length - 10} more` : ''
    throw new Error(`JS bundle would be broken at load time${where}:\n${shown}${more}`)
  }
  if (tolerated.length > 0) {
    const summary = tolerated
      .slice(0, 10)
      .map((u) => `  ${u.kind} ${u.spec ?? '<dynamic>'} from ${show(u.parentURL)} (${u.reason})`)
      .join('\n')
    const more = tolerated.length > 10 ? `\n  ... and ${tolerated.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${tolerated.length} unresolved import(s)${where}; they will fall through at load time:\n${summary}${more}`)
  }
  if (toleratedParse.length > 0) {
    const summary = toleratedParse
      .slice(0, 10)
      .map((p) => `  ${show(p.url)}: ${p.message}`)
      .join('\n')
    const more = toleratedParse.length > 10 ? `\n  ... and ${toleratedParse.length - 10} more` : ''
    console.warn(`[stasis] Bundle has ${toleratedParse.length} file(s) with parse errors${where}; their recorded imports may be incomplete:\n${summary}${more}`)
  }
}

// Build a JS/TS Bundle (in-memory) by statically scanning the require/import graph; no
// user code is executed, and TS is stored verbatim (Node strips types at load). Scope comes
// from stasis.config.json / `EXODUS_STASIS_SCOPE` unless `scope` overrides. `conditions` are
// extra `exports`/`imports` conditions; on their own they don't honour legacy mainFields or
// platform suffixes (see `--mainFields` / buildResolvedJsBundle). `typescript` maps a failed
// resolution to its on-disk TS source (tsc's rules; see resolve-typescript.js), honouring the
// `paths` aliases of `tsconfig` (an explicit config path, default the project's tsconfig.json).
// Files are read through `host` (@exodus/stasis-core/host), the disk by default; EXODUS_STASIS_*
// settings from `env`.
export async function buildJsBundle({ cwd = process.cwd(), env = process.env, entries, scope, conditions = [], jsx = false, flow = false, typescript = false, tsconfig, resources = [], packageJSON = false, host = diskHost } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildJsBundle: at least one entry .js/.cjs/.mjs/.ts/.cts/.mts file is required')
  }
  for (const e of entries) {
    if (!JS_EXTS.has(extname(e))) throw new Error(`buildJsBundle: not a JS/TS file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))

  // Normalize conditions (trim, drop empties) so a sloppy programmatic caller can't push a
  // bogus token into the resolver.
  const scanConditions = conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)
  // --resources: extensions/filenames carried as opaque assets instead of failing "can't carry".
  const resourceSet = parseResourcesOption('buildJsBundle', resources)

  // --typescript honours tsconfig `paths` aliases: an explicit --tsconfig must exist, otherwise
  // the project root's tsconfig.json applies when present (null matcher = no aliases).
  const typescriptPaths = typescript ? loadTsconfigPaths(discoverTsconfig(baseDir, tsconfig, host), host) : null

  const scanner = scan(absEntries, { conditions: scanConditions, jsx, flow, typescript, typescriptPaths, resources: resourceSet, host })

  // Fail closed where the bundle is guaranteed broken at load; warn on catchable misses (see analyzeScanner).
  reportScanIssues(analyzeScanner(scanner, { baseDir }), { baseDir })

  // Materialise via a non-preload State: addFile bucketizes + records sources/formats,
  // addImport replays the edge map; serialize emits the runtime loader's v1 layout.
  // bundle:'replace' skips reading any on-disk stasis.code.br (bundle:'add' would leak stale
  // entries); lock:'ignore' tolerates a pre-existing lockfile without consuming it; and it is never
  // written, so it claims no write target.
  const state = new State(baseDir, { bundle: 'replace', lock: 'ignore', ...(scope ? { scope } : {}), host, env, claim: false })
  for (const [url, info] of scanner.files) {
    // A resource carries bytes only: addFile derives resource vs resource:base64 from the content
    // and stores it under `resources` (a resource can't be an entry, so no isEntry).
    if (info.resource) {
      state.addFile(url, { resource: true })
      continue
    }
    const isEntry = scanner.entries.has(url)
    state.addFile(url, { format: info.format, isEntry })
  }
  // Edges where every context agrees keep the wildcard '*' key (getImport's fallback when a
  // condition lookup misses). Where the require()- and import()-context resolutions of one
  // (parent, specifier) DIVERGE, each target keeps its real condition key -- one '*' entry
  // would serve one context the other's file; an unmatched set fails closed via resolveBundled.
  const byParent = new Map()
  for (const [key, parents] of scanner.imports) {
    for (const [parentURL, specs] of parents) {
      if (!byParent.has(parentURL)) byParent.set(parentURL, new Map())
      const bySpec = byParent.get(parentURL)
      for (const [spec, childURL] of specs) {
        if (!bySpec.has(spec)) bySpec.set(spec, new Map())
        bySpec.get(spec).set(key, childURL)
      }
    }
  }
  for (const [parentURL, bySpec] of byParent) {
    for (const [spec, byKey] of bySpec) {
      const targets = new Set(byKey.values())
      if (targets.size === 1) {
        state.addImport(parentURL, spec, [...targets][0], { conditions: '*' })
      } else {
        for (const [key, childURL] of byKey) {
          state.addImport(parentURL, spec, childURL, { conditions: key.split(', ') })
        }
      }
    }
  }
  // --package-json: fold each bundled module's package.json into the State's buckets (idempotent --
  // no-ops any manifest the scan already reached). State's bundle=replace makes writeBundle true, so addFile accepts them.
  if (packageJSON) state.includePackageJson()
  return state
}

// Extensions probed when a resolved target names none. Limited to what a source bundle can
// carry (scan's RESOLVABLE_EXTS) so the resolver never resolves a file the bundle would reject.
// --jsx widens this to the JSX/TSX extensions (mirroring scan's jsx-gated RESOLVABLE_EXTS) so an
// extensionless `import './Foo'` can land on Foo.jsx/Foo.tsx, as Metro's sourceExts do. `.js`/`.ts`
// keep their existing precedence (base order preserved as a subsequence); collisions across the
// added extensions are rare and, like the base list, don't track the project's real Metro order.
const SOURCE_EXTS = ['js', 'json', 'ts']
const SOURCE_EXTS_JSX = ['js', 'jsx', 'json', 'ts', 'tsx']
// React Native preset mainFields for `--metro` (which also sets the RN conditions + platform suffixes).
const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']
// Synthetic path for the empty module a browser/react-native `false` redirect resolves to,
// carried as a real empty CJS file so the edge points at attestable bytes.
const EMPTY_MODULE_PATH = '.stasis/empty-module.js'

// Recursively collect files under a native ios/android dir, skipping build output and symlinks
// (cycle/escape hazard). Absolute paths into `out`.
function walkNativeDir(dirAbs, out, host) {
  let entries
  try {
    entries = host.readdir(dirAbs)
  } catch {
    return // absent -- nothing for this platform
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dirAbs, ent.name)
    if (ent.isDirectory()) {
      if (!isSkippedNativeWalkDir(ent.name)) walkNativeDir(full, out, host)
    } else if (ent.isFile() && !isNativeArtifact(ent.name)) {
      out.push(full)
    }
  }
}

// Recursively collect podspec-load manifests (isNativeManifest) under `dirAbs`. RN's own
// podspecs live in scattered subdirs a root-only scan would miss, so recurse fully.
function collectNativeManifests(dirAbs, out, host, atRoot = false) {
  let entries
  try {
    entries = host.readdir(dirAbs)
  } catch {
    return
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dirAbs, ent.name)
    if (ent.isDirectory()) {
      if (!isSkippedNativeWalkDir(ent.name) && !(atRoot && isExcludedNativeDir(ent.name))) collectNativeManifests(full, out, host)
    } else if (ent.isFile() && isNativeManifest(ent.name)) {
      out.push(full)
    }
  }
}

// Native source files a bundled RN dep contributes to the app's native build (podspecs +
// ios/android sources). Manifests are kept only when the package is actually native (podspec
// or ios/android dir), else a JS-only dep's package.json would be pulled in. Deduped absolute paths.
function nativeModuleFiles(pkgAbs, host) {
  const manifests = []
  collectNativeManifests(pkgAbs, manifests, host, true)
  const hasIos = host.stat(join(pkgAbs, 'ios')) !== null
  const hasAndroid = host.stat(join(pkgAbs, 'android')) !== null
  if (!hasIos && !hasAndroid && !manifests.some((f) => isPodspec(f))) return []
  const out = [...manifests]
  if (hasIos) walkNativeDir(join(pkgAbs, 'ios'), out, host)
  if (hasAndroid) walkNativeDir(join(pkgAbs, 'android'), out, host)
  return [...new Set(out)]
}

// Build a JS/TS Bundle + companion Lockfile via the legacy-field resolver (`--mainFields`/
// `--metro`). Scanned once per platform; each edge is recorded flat when the platforms that
// have it agree, or as a `{ platform: target }` map where they diverge. Returns { bundle, lockfile }.
async function buildResolvedJsBundle({ cwd = process.cwd(), entries, mainFields, platforms, conditions = [], metro = false, metroResolver = false, jsx = false, flow = false, typescript = false, tsconfig, resources = [], packageJSON = false, host = diskHost }) {
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

  // Normalize conditions (drop stray ''/whitespace) so a sloppy caller can't push a bogus token into the resolver.
  const scanConditions = conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)

  // Under --jsx the resolver probes .jsx/.tsx too, matching scan's jsx-widened carryable set.
  const sourceExts = jsx ? SOURCE_EXTS_JSX : SOURCE_EXTS
  // --typescript's tsconfig `paths` matcher, shared by every per-platform resolver below.
  const typescriptPaths = typescript ? loadTsconfigPaths(discoverTsconfig(baseDir, tsconfig, host), host) : null
  // --resources: extensions/filenames carried as opaque assets instead of failing "can't carry".
  const resourceSet = parseResourcesOption('buildResolvedJsBundle', resources)

  const formatsByRel = new Map()
  // Reached files the scanner tagged as resources (rel keys); read as bytes below, not UTF-8 source.
  const resourceRels = new Set()
  // parentRel -> specifier -> Map<platformKey, targetRel>; collapsed after all platforms scanned.
  const edges = new Map()
  const reached = new Set() // absolute paths reached on any platform
  let usesEmpty = false

  for (const platform of platforms) {
    // --metro asserts the RN conditions (+ browser on web); --mainFields (platform null) carries the user's --conditions.
    const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : scanConditions
    // --metro --metro-resolver delegates to the project's own metro-resolver for byte-for-byte Metro
    // fidelity; otherwise the built-in field/suffix resolver (resolve-fields.js) reproduces it.
    // metro-resolver derives default/require|import/platform conditions itself, so it takes only the
    // extra `react-native` condition (browser comes from its per-platform map, keyed on `web`).
    const resolver = metroResolver
      ? createMetroResolver({ projectDir: baseDir, platform, sourceExts, mainFields, conditionNames: ['react-native'] })
      : createFieldResolver({
          mainFields,
          platform,
          preferNative: platform !== null && platform !== 'web',
          sourceExts,
          conditions: resolveConditions('commonjs', extras),
          // Opt into Metro's package-entry browser-field quirks only on the --metro path.
          metro,
          // --typescript: tsc's mapping, inside the field resolver (the scanner's own fallback
          // only backs the built-in resolver). Unreachable under --metro-resolver
          // (classifyEntries rejects the combination -- metro-resolver can't substitute).
          typescript,
          typescriptPaths,
          host,
        })
    const scanner = scan(absEntries, { conditions: extras, resolve: resolver, jsx, flow, resources: resourceSet, host })
    reportScanIssues(analyzeScanner(scanner, { baseDir }), { baseDir, label: platform ?? 'mainFields' })

    const platformKey = platform ?? '*' // '*' is a private placeholder for the single mainFields pass; it never unflattens
    for (const [url, info] of scanner.files) {
      const rel = toRel(fileURLToPath(url))
      reached.add(fileURLToPath(url))
      if (info.resource) resourceRels.add(rel)
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

  // Read each reached file once: bytes for the bundle, integrity for the lockfile. Source is
  // stored as UTF-8 text, so non-UTF-8 bytes would diverge from the hashed bytes -- reject them.
  const sources = new Map()
  const integrities = new Map()
  const realBase = host.realpath(baseDir)
  for (const abs of reached) {
    const rel = toRel(abs)
    // Security: the field resolver returns the lexical path, so an in-tree-named symlink
    // escaping the root would slip past toRel's textual check -- realpath and fail closed.
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    const buf = host.readFile(abs)
    if (resourceRels.has(rel)) {
      // A resource carries bytes, not JS source: store UTF-8 verbatim or base64 when binary, and
      // tag the byte-derived format (same shape as the --metro native capture below).
      const utf8 = isUtf8(buf)
      sources.set(rel, utf8 ? buf.toString('utf8') : buf.toString('base64'))
      formatsByRel.set(rel, utf8 ? 'resource' : 'resource:base64')
    } else {
      if (!isUtf8(buf)) throw new Error(`JS bundle source is not valid UTF-8: ${rel}`)
      sources.set(rel, buf.toString('utf8'))
    }
    integrities.set(rel, sha512integrity(buf))
  }
  if (usesEmpty) {
    // Refuse to shadow a real reached file sitting at the reserved empty-module path.
    if (formatsByRel.has(EMPTY_MODULE_PATH)) {
      throw new Error(`Bundle needs the reserved empty-module path ${EMPTY_MODULE_PATH}, but the project has a real file there`)
    }
    sources.set(EMPTY_MODULE_PATH, '')
    formatsByRel.set(EMPTY_MODULE_PATH, 'commonjs')
    integrities.set(EMPTY_MODULE_PATH, sha512integrity(Buffer.alloc(0)))
  }

  // --metro also carries each bundled dependency's native build-input surface (ios/android
  // sources + podspecs), scoped to the node_modules packages actually in the bundle. Native
  // source is stored as code under a language tag; other assets as 'resource'/'resource:base64'.
  if (metro) {
    const pkgDirs = new Set()
    for (const abs of reached) {
      // Follow the CODE/module graph only: a package reached solely for an asset (--resources) is
      // not a linked native dependency, so it must not drag in its ios/android surface.
      if (resourceRels.has(toRel(abs))) continue
      const nm = splitNodeModulesPath(toRel(abs))
      if (nm) pkgDirs.add(nm.dir)
    }
    for (const pkgDir of [...pkgDirs].toSorted()) {
      const pkgAbs = join(baseDir, pkgDir)
      // react-native core isn't a Pod (config reports it via reactNativePath, not `dependencies`),
      // so walk its whole tree for native source (React/, ReactCommon/, ReactAndroid/, ...) the same
      // way a native dep's ios/android surface is walked; every other dep gets its ios/android + podspecs.
      const isRnCore = pkgDir.slice(pkgDir.lastIndexOf('node_modules/') + 'node_modules/'.length) === 'react-native'
      const files = isRnCore ? [] : nativeModuleFiles(pkgAbs, host)
      if (isRnCore) walkNativeDir(pkgAbs, files, host)
      for (const abs of files) {
        const rel = toRel(abs)
        if (sources.has(rel)) continue
        assertRealPathWithinBase(realBase, baseDir, rel, host)
        // classifyNativeCapture (shared with the StasisMetro plugin) returns action skip/code/resource with a format tag.
        const byName = classifyNativeCapture(rel)
        if (byName.action === 'skip') continue
        const buf = host.readFile(abs)
        // Byte-level rules (prebuilt binaries, binary plists) -- see refineNativeCapture.
        const { action, format } = refineNativeCapture(byName, rel, buf, resourceSet)
        if (action === 'skip') continue
        const utf8 = isUtf8(buf)
        if (action === 'code') {
          if (!utf8) throw new Error(`native source is not valid UTF-8: ${rel}`)
          sources.set(rel, buf.toString('utf8'))
          formatsByRel.set(rel, format)
        } else {
          sources.set(rel, utf8 ? buf.toString('utf8') : buf.toString('base64'))
          formatsByRel.set(rel, utf8 ? 'resource' : 'resource:base64')
        }
        integrities.set(rel, sha512integrity(buf))
      }
      // RN core's `.js` build scripts the classify loop skips (Metro-owned by extension, but never in
      // the graph): force-include as code so the podspec/Ruby that invokes them at pod-install resolves.
      if (isRnCore) {
        for (const file of RN_CORE_INCLUDE_FILES) {
          const abs = join(pkgAbs, file)
          if (host.stat(abs) === null) continue
          const rel = toRel(abs)
          if (sources.has(rel)) continue
          assertRealPathWithinBase(realBase, baseDir, rel, host)
          const buf = host.readFile(abs)
          if (!isUtf8(buf)) throw new Error(`native source is not valid UTF-8: ${rel}`)
          sources.set(rel, buf.toString('utf8'))
          formatsByRel.set(rel, packageType(abs, host) === 'module' ? 'module' : 'commonjs')
          integrities.set(rel, sha512integrity(buf))
        }
      }
    }
  }

  // --package-json: fold each bundled module's package.json into `sources` (and its integrity into
  // the companion lockfile) even when the scan never reached it. Buckets are the same ones
  // assembleCodeBundle derives (findPackageMetadata -> pkgDir, else the '.' workspace bucket);
  // packageLookup memoizes it per directory so a package's many files don't each re-walk to the
  // same manifest. readModuleManifest applies the read/validate rules shared with the State path
  // (containment, UTF-8-aborts); no identity check here -- these buckets are all fresh from disk.
  if (packageJSON) {
    const packageOf = packageLookup(baseDir, { host })
    const pkgDirs = new Set()
    for (const abs of reached) {
      const rel = toRel(abs)
      const meta = packageOf(rel)
      if (meta) pkgDirs.add(meta.pkgDir)
      else if (!splitNodeModulesPath(rel)) pkgDirs.add('.')
    }
    for (const pkgDir of pkgDirs) {
      const rel = moduleFileKey(pkgDir, 'package.json')
      if (sources.has(rel)) continue
      const buf = readModuleManifest({ baseDir, realBase, rel, host })
      if (!buf) continue
      sources.set(rel, buf.toString('utf8'))
      formatsByRel.set(rel, 'json')
      integrities.set(rel, sha512integrity(buf))
    }
  }

  // Collapse each edge: one distinct target across platforms -> flat string; else a sorted Map<platform, target>.
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

  const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
  const bundle = assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    formats: formatsByRel,
    workspaceName: rootPkg.name ?? 'workspace',
    workspaceVersion: rootPkg.version ?? '0.0.0',
    conditionKey: '*',
    host,
  })

  // The companion lockfile mirrors the bundle, swapping file content for its integrity.
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
    // Same file set as the bundle, so the same executable list attests it.
    executable: bundle.executable,
  })

  return { bundle, lockfile }
}

// Classify entries into their single shared language and check option applicability; `name` prefixes
// errors. A directory entry (resolved against `cwd`, on `host`) stands for the .sol files under it: Solidity only.
function classifyEntries(name, { cwd = process.cwd(), entries, mappingFile, manifests, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, jsx, flow, typescript, tsconfig, resources, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, host = diskHost }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${name}: at least one entry file is required`)
  }
  const dirError = directoryEntryError(entries, cwd, host)
  if (dirError !== null) throw new Error(`${name}: ${dirError}`)
  let kind
  if (entries.every((e) => e.endsWith('.sol') || isDirEntry(resolve(cwd, e), host))) kind = 'sol'
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
  // --manifests carries the Solidity build's description files (foundry.toml, remappings.txt, ...).
  if (manifests && kind !== 'sol') {
    throw new Error(`${name}: --manifests is only valid for .sol bundles`)
  }
  // --cargo runs `cargo metadata` for the Rust feature/dependency resolution and the --cargo-*
  // flags steer that resolution; nothing else reads Cargo.
  if (kind !== 'rust') {
    if (cargo) throw new Error(`${name}: --cargo is only valid for Rust bundles`)
    if (Array.isArray(cargoFeatures) && cargoFeatures.length > 0) throw new Error(`${name}: --cargo-features is only valid for Rust bundles`)
    if (cargoNoDefaultFeatures) throw new Error(`${name}: --cargo-no-default-features is only valid for Rust bundles`)
    if (cargoAllFeatures) throw new Error(`${name}: --cargo-all-features is only valid for Rust bundles`)
  }
  if (scope !== undefined && kind !== 'js') {
    throw new Error(`${name}: --scope is only valid for JS bundles`)
  }
  if (lockfile !== undefined && kind !== 'js') {
    throw new Error(`${name}: --lockfile is only valid for JS bundles`)
  }
  // Reject --conditions for non-JS: their resolvers don't consult exports/imports conditions, so it would silently do nothing.
  if (Array.isArray(conditions) && conditions.length > 0 && kind !== 'js') {
    throw new Error(`${name}: --conditions is only valid for JS bundles`)
  }
  // --flow strips Flow type syntax before the JS parser; the non-JS loaders never parse with oxc.
  if (flow && kind !== 'js') {
    throw new Error(`${name}: --flow is only valid for JS bundles`)
  }
  // --typescript maps JS-output specifiers to their on-disk TS sources; only the JS resolvers do it.
  if (typescript && kind !== 'js') {
    throw new Error(`${name}: --typescript is only valid for JS bundles`)
  }
  // --tsconfig names the config whose `paths` aliases --typescript honours; meaningless without it.
  if (tsconfig !== undefined && !typescript) {
    throw new Error(`${name}: --tsconfig is only valid with --typescript`)
  }
  // --resources carries allowlisted assets reached through the JS import graph; JS-only. The list
  // is validated (parseResourcesOption) in the builders, but reject a code extension here too so a
  // typo surfaces with the command name rather than deep in the scan.
  if (Array.isArray(resources) && resources.length > 0) {
    if (kind !== 'js') throw new Error(`${name}: --resources is only valid for JS bundles`)
    parseResourcesOption(name, resources)
  }
  // --mainFields and --metro/--platforms are legacy-/platform-resolution knobs; JS-only.
  if (mainFields !== undefined && kind !== 'js') {
    throw new Error(`${name}: --mainFields is only valid for JS bundles`)
  }
  // --jsx toggles the scanner's JSX parsing for the .js family; only JS entries are scanned.
  if (jsx && kind !== 'js') {
    throw new Error(`${name}: --jsx is only valid for JS bundles`)
  }
  // --package-json folds each bundled module's npm package.json in; JS-only (the sol/php/bash/rust
  // bucketizers group by their own ecosystems' manifests, not an npm package.json).
  if (packageJSON && kind !== 'js') {
    throw new Error(`${name}: --package-json is only valid for JS bundles`)
  }
  if ((metro || (Array.isArray(platforms) && platforms.length > 0)) && kind !== 'js') {
    throw new Error(`${name}: --metro is only valid for JS bundles`)
  }
  // --metro presets conditions + mainFields + platform suffixes, so it can't combine with
  // explicit --conditions/--mainFields and requires --platforms; --platforms is meaningless without it.
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
    // A platform name becomes an edge key: reject '/' (Bundle/Lockfile parse refuse it) and
    // the reserved '*' placeholder, so the writer never emits a map the readers reject.
    for (const p of platforms) {
      if (typeof p !== 'string' || p.length === 0 || p === '*' || p.includes('/')) {
        throw new Error(`${name}: invalid platform '${p}' (a platform name can't be empty, contain '/', or be '*')`)
      }
    }
  } else if (Array.isArray(platforms) && platforms.length > 0) {
    throw new Error(`${name}: --platforms is only valid with --metro`)
  }
  // --metro-resolver swaps in the project's real metro-resolver; it only means something under --metro.
  if (metroResolver && !metro) {
    throw new Error(`${name}: --metro-resolver is only valid with --metro`)
  }
  // metro-resolver has no TS extension substitution, so --typescript would silently not apply -- reject it.
  if (typescript && metroResolver) {
    throw new Error(`${name}: --typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)`)
  }
  // The field resolver always emits full-scope, so --scope with --mainFields/--metro would be silently ignored -- reject it.
  if (scope !== undefined && (mainFields !== undefined || metro)) {
    throw new Error(`${name}: --scope is not supported with --mainFields or --metro`)
  }
  return kind
}

// A JS bundle as `stasis bundle` builds it: by the legacy-field resolver with `mainFields` or
// `metro`, whose per-platform edges and synthetic empty module a State can't hold, else through a
// State, which detects the bundle's repo itself. -> { bundle, lockfile: () => Lockfile, stateBuilt }
async function buildJs({ mainFields, platforms, metro, metroResolver, ...options }) {
  if (metro || mainFields !== undefined) {
    const built = await buildResolvedJsBundle({ ...options, mainFields: metro ? METRO_MAIN_FIELDS : mainFields, platforms: metro ? platforms : [null], metro: Boolean(metro), metroResolver: Boolean(metroResolver) })
    return { bundle: built.bundle, lockfile: () => built.lockfile, stateBuilt: false }
  }
  const state = await buildJsBundle(options)
  // Stamp the `bundle` consumer (the static build carries none).
  return { bundle: state.sourceBundle.withReason('bundle'), lockfile: () => state.lockfile, stateBuilt: true }
}

// A bundle from the lockfile of the project held in `vfs` alone (@exodus/stasis/vfs-bundle), `cwd` a
// path there: buildBundle's JS options, resolved through the node_modules 'pnpm' or 'yarn1' would
// install, or its Solidity options, through the dependencies folder 'soldeer' would install; with
// nothing read from disk but tarballs and zips. No EXODUS_STASIS_* setting is read; `env` supplies
// a Solidity bundle's FOUNDRY_PROFILE and FOUNDRY_REMAPPINGS alone. `repo`, the informational
// `{ github, directory | root, commit }`, is the Bundle's, over what is detected in the Vfs as
// `stasis bundle` detects it on disk.
// -> { bundle: Bundle, lockfile: Lockfile (of a JS bundle), stats }
export async function buildVfsBundle({ vfs, packageManager, cwd = '/', packageManagerVersion, repo, env = {}, ...options } = {}) {
  const { checkVfs, loadTree, packageManagerOf, vfsHost } = await import('../vfs-bundle/tree.js')
  const pm = packageManagerOf('buildVfsBundle', packageManager)
  checkVfs('buildVfsBundle', vfs)
  // Checked as the Bundle checks it, before anything is fetched.
  if (repo !== undefined) repo = new Bundle({ repo }).repo
  const project = vfsHost(vfs)
  // A real path, as every file the scan reaches is.
  cwd = project.realpath(posix.resolve('/', cwd))
  if (classifyEntries('buildVfsBundle', { cwd, ...options, host: project }) !== pm.kind) throw new Error(`buildVfsBundle: only ${pm.kind === 'sol' ? 'Solidity' : 'JS'} bundles are built with ${packageManager}`)
  // The project's metro-resolver resolves against the node_modules on disk.
  if (options.metroResolver) throw new Error('buildVfsBundle: metroResolver is not supported')
  // Checked before anything is fetched: an entry out of what the tree installs is in the project
  // already. (A Solidity entry that is no .sol file is a directory, skipped where it is missing.)
  for (const entry of options.entries) {
    const abs = posix.resolve(cwd, entry)
    if (pm.kind === 'sol' && !abs.endsWith('.sol')) continue
    if (!posix.relative(cwd, abs).split('/').includes(pm.installs) && project.stat(abs) === null) throw new Error(`entry not found: ${abs}`)
  }
  const { host, stats } = await loadTree({ project, packageManager, cwd, packageManagerVersion })
  const { bundle, lockfile, stateBuilt } = pm.kind === 'sol'
    ? { bundle: await buildSolidityBundle({ ...options, cwd, env, host }) }
    : await buildJs({ ...options, cwd, host, env: {} })
  if (repo !== undefined) bundle.repo = repo
  // Rooted at cwd, where `stasis bundle` detects its repo.
  else if (!stateBuilt) bundle.repo ??= detectRepo(cwd, host)
  return { bundle, lockfile: lockfile?.(), stats }
}

// Programmatic equivalent of `stasis bundle`: build and return an in-memory Bundle without
// writing to disk. Files are attributed to the `bundle` consumer. Option applicability
// (--mapping|--manifests/.sol, --scope|--conditions|--mainFields|--metro|--jsx|--flow|--typescript/JS) is enforced by classifyEntries.
export async function buildBundle({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, scope, conditions, mainFields, platforms, metro, metroResolver, jsx = false, flow = false, typescript = false, tsconfig, resources = [], packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false } = {}) {
  const kind = classifyEntries('buildBundle', { cwd, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, jsx, flow, typescript, tsconfig, resources, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures })
  if (kind === 'sol') return buildSolidityBundle({ cwd, env, entries, mappingFile, manifests })
  if (kind === 'php') return buildPhpBundle({ cwd, entries })
  if (kind === 'bash') return buildBashBundle({ cwd, entries })
  if (kind === 'rust') return buildRustBundle({ cwd, entries, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures })
  return (await buildJs({ cwd, env, entries, scope, conditions, mainFields, platforms, metro, metroResolver, jsx, flow, typescript, tsconfig, resources, packageJSON })).bundle
}

// Default output: stasis.code.br, the same name `stasis run --bundle=load` discovers, so the two round-trip with no flags.
const DEFAULT_BUNDLE_FILE = 'stasis.code.br'

// Run `stasis bundle`: build a brotli-compressed bundle and write it to `output`
// (stasis.code.br by default, `-` for stdout; the summary goes to stderr so it never
// interleaves with binary stdout). An optional JS `lockfile` attests every bundled file;
// with `--conditions` it attests the conditions-selected graph, so a plain
// `stasis run --lock=frozen` (which doesn't replay them) fails closed -- pair it with
// `--bundle=load` or replay the conditions. `add` unions the fresh build into the bundle
// already on disk (strict; a conflicting file throws) and can't target stdout.
export async function bundleCommand({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, output, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, jsx = false, flow = false, typescript = false, tsconfig, resources = [], packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, brotliQuality, add = false } = {}) {
  const kind = classifyEntries('bundleCommand', { cwd, entries, mappingFile, manifests, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, jsx, flow, typescript, tsconfig, resources, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures })

  const target = output ?? DEFAULT_BUNDLE_FILE
  // --add has nothing to merge into on stdout (write-only).
  if (add && target === '-') {
    throw new Error('bundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  }

  let bundle
  let lockData
  let stateBuilt = false
  if (kind === 'js') {
    const built = await buildJs({ cwd, env, entries, scope, conditions, mainFields, platforms, metro, metroResolver, jsx, flow, typescript, tsconfig, resources, packageJSON })
    ;({ bundle, stateBuilt } = built)
    if (lockfile) lockData = built.lockfile().serialize()
  } else {
    bundle = await buildBundle({ cwd, env, entries, mappingFile, manifests, scope, conditions, jsx, flow, typescript, tsconfig, resources, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures })
  }

  // State-built bundles keep the State root's repo (no cwd fallback: their paths are relative to that root).
  if (!stateBuilt) bundle.repo ??= detectRepo(cwd)

  // --add: union the fresh build into the existing on-disk bundle; a conflicting file throws. Skipped when nothing is on disk.
  const outAbs = target === '-' ? undefined : resolve(cwd, target)
  // Files the pre-existing bundle carried; undefined when no merge happened (the summary's merged sentinel).
  let mergedFrom
  if (add && existsSync(outAbs)) {
    let existing
    try {
      existing = Bundle.parse(brotliDecompressSync(readFileSync(outAbs)).toString('utf8'))
    } catch (cause) {
      throw new Error(`bundleCommand: --add failed to read the existing bundle at ${target}`, { cause })
    }
    mergedFrom = existing.sources.size
    bundle = existing.merge(bundle)
    // Keep the companion lockfile consistent with the merged bundle: union an existing one.
    // With none on disk we can't attest the pre-existing bundle's files (their hashes live
    // only in that missing lockfile), so refuse rather than write an under-attesting lockfile.
    if (lockData && lockfile) {
      const lockAbs = resolve(cwd, lockfile)
      if (!existsSync(lockAbs)) {
        throw new Error(`bundleCommand: --add can't write a complete lockfile at ${lockfile}: the bundle at ${target} already carries files a fresh lockfile wouldn't attest, and there's no existing lockfile to merge into. Write --lockfile alongside the bundle from the first build, or drop --lockfile.`)
      }
      let existingLock
      try {
        existingLock = Lockfile.parse(readFileSync(lockAbs, 'utf8'))
      } catch (cause) {
        throw new Error(`bundleCommand: --add failed to read the existing lockfile at ${lockfile}`, { cause })
      }
      lockData = existingLock.merge(Lockfile.parse(lockData)).serialize()
    }
  }

  const serialized = bundle.serialize()
  const files = [...bundle.sources.keys()]
  const modules = bundle.modules

  const data = brotliCompressSync(serialized, brotliOptions(brotliQuality))
  if (target === '-') {
    process.stdout.write(data)
  } else {
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
  // Count packages: every non-empty bucket (the "." workspace bucket counts as one).
  const packages = [...modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  const pkgLabel = `${packages} package${packages === 1 ? '' : 's'}`
  // On a merge, report newly-added files alongside the totals; a fresh write keeps the plain line.
  if (mergedFrom !== undefined) {
    const added = files.length - mergedFrom
    console.warn(`[stasis] Added ${added} file${added === 1 ? '' : 's'} (${files.length} total in ${pkgLabel}) from ${fromDir} to ${dest}`)
  } else {
    console.warn(`[stasis] Bundled ${files.length} files in ${pkgLabel} from ${fromDir} to ${dest}`)
  }
}
