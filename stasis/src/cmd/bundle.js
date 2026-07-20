import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { scan } from '../scan.js'
import { createFieldResolver, resolveConditions } from '../resolve-fields.js'
import { State } from '@exodus/stasis-core/state'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { findPackageMetadata, normalizeEntries, readJson } from '@exodus/stasis-core/bundle-util'
import { RN_CORE_INCLUDE_DIRS, RN_CORE_INCLUDE_FILES, assertRealPathWithinBase, classifyNativeCapture, isExcludedNativeDir, isNativeArtifact, isNativeManifest, isPodspec, moduleFileKey, splitNodeModulesPath } from '@exodus/stasis-core/util'
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

// Parse `.gitmodules` (git-config INI) into Map<submodulePath, { name, branch }>,
// github.com submodules only.
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

// Classify a Solidity file's dep bucket: Soldeer (`dependencies/<name>-<version>/`) or a
// github submodule (`lib/`, via `.gitmodules`), else null to defer to the node_modules/
// workspace logic.
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

// Minimal Cargo.toml reader: name/version from the `[package]` table; null when no name.
function parseCargoToml(file) {
  const text = readFileSyncOrNull(file)
  if (!text) return null
  const at = text.search(/^\[package\]\s*$/mu)
  let body = text
  if (at !== -1) {
    const rest = text.slice(at)
    const next = rest.slice(1).search(/^\[/mu)
    body = next === -1 ? rest : rest.slice(0, next + 1)
  }
  const name = /^\s*name\s*=\s*"([^"]+)"/mu.exec(body)?.[1]
  const version = /^\s*version\s*=\s*"([^"]+)"/mu.exec(body)?.[1]
  return name ? { name, version: version ?? '0.0.0' } : null
}

// Classify a Rust file: `cargo vendor` crates under `vendor/<dir>/` (tagged `cargo`), else
// null to defer to the workspace logic.
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

// Assemble a full-scope code Bundle shared by the non-JS bundlers. Files are bucketed by
// nearest package.json (node_modules -> `npm`-tagged bucket, workspace -> its dir, none ->
// "." with the placeholder identity); a node_modules file whose nearest package.json is the
// workspace root is rejected, not mislabeled. `classifyDep(path)` optionally places a file
// directly (non-node_modules ecosystems like Soldeer/github); null defers. `format` tags
// every file, or pass `formats` (Map<path,format>) to tag per file. `resolutions` values are
// a flat target string or a Map<platform,target>; both round-trip untouched.
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

  // Attribute files to the `bundle` consumer (static builders skip State's per-file tagging).
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats: formatsMap,
    imports,
  }).withReason('bundle')
}

// Build an in-memory Bundle from entry .sol files; `mappingFile` (foundry.toml/remappings.txt)
// is parsed for remappings but not bundled.
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

  // Bundles must be self-contained: fail on a missing entry or unresolved import.
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

// Build an in-memory Bundle from entry .rs files by walking `mod` declarations. An
// unresolvable `mod` is fatal; `use crate::` edges are recorded best-effort (never widen
// the file set, not gated).
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
  }).withReason('bundle')
}

// Classify scanner unresolved edges + parse errors into fatal (broken/divergent at load)
// vs tolerated (a catchable runtime miss). Shared so the plain and --mainFields JS paths
// gate identically.
function analyzeScanner(scanner) {
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
    .map((u) => `unresolved ${u.kind} ${u.spec} from ${fileURLToPath(u.parentURL)} (${u.reason})`)
  // Fatal parse: an eagerly-linked module-family file, or any file the parser couldn't process.
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format?.startsWith('module') === true || !p.recovered)
  for (const p of scanner.parseErrors) {
    if (fatalParse(p)) fatal.push(`parse error in ${fileURLToPath(p.url)}: ${p.message}`)
  }
  // Edge resolving to a file a source bundle can't carry (.node/.wasm/extensionless): scan
  // records it but never queues the child, so load would die.
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

// Throw on fatal scan issues; warn on tolerated ones. `label` tags the scan pass.
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

// Build a JS/TS Bundle (in-memory) by statically scanning the require/import graph; no
// user code is executed, and TS is stored verbatim (Node strips types at load). Scope comes
// from stasis.config.json / `EXODUS_STASIS_SCOPE` unless `scope` overrides. `conditions` are
// extra `exports`/`imports` conditions; on their own they don't honour legacy mainFields or
// platform suffixes (see `--mainFields` / buildResolvedJsBundle).
export async function buildJsBundle({ cwd = process.cwd(), entries, scope, conditions = [] } = {}) {
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

  const scanner = scan(absEntries, { conditions: scanConditions })

  // Fail closed where the bundle is guaranteed broken at load; warn on catchable misses (see analyzeScanner).
  reportScanIssues(analyzeScanner(scanner))

  // Materialise via a non-preload State: addFile bucketizes + records sources/formats,
  // addImport replays the edge map; serialize emits the runtime loader's v1 layout.
  // bundle:'replace' skips reading any on-disk stasis.code.br (bundle:'add' would leak stale
  // entries); lock:'ignore' tolerates a pre-existing lockfile without consuming it.
  const state = new State(baseDir, { bundle: 'replace', lock: 'ignore', ...(scope ? { scope } : {}) })
  for (const [url, info] of scanner.files) {
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
  return state
}

// Extensions probed when a resolved target names none. Limited to what a source bundle can
// carry (scan's RESOLVABLE_EXTS) so the resolver never resolves a file the bundle would reject.
const SOURCE_EXTS = ['js', 'json', 'ts']
// React Native preset mainFields for `--metro` (which also sets the RN conditions + platform suffixes).
const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']
// Synthetic path for the empty module a browser/react-native `false` redirect resolves to,
// carried as a real empty CJS file so the edge points at attestable bytes.
const EMPTY_MODULE_PATH = '.stasis/empty-module.js'

// Build-output subtrees skipped when collecting native ios/android sources (regenerated, never
// source); binary artifacts are excluded separately via isNativeArtifact.
const NATIVE_SKIP_DIRS = new Set(['build', '.gradle', '.cxx', 'Pods', 'DerivedData', 'node_modules', '.git'])

// Recursively collect files under a native ios/android dir, skipping build output and symlinks
// (cycle/escape hazard). Absolute paths into `out`.
function walkNativeDir(dirAbs, out) {
  let entries
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return // absent -- nothing for this platform
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dirAbs, ent.name)
    if (ent.isDirectory()) {
      if (!NATIVE_SKIP_DIRS.has(ent.name) && !isNativeArtifact(ent.name)) walkNativeDir(full, out)
    } else if (ent.isFile() && !isNativeArtifact(ent.name)) {
      out.push(full)
    }
  }
}

// Recursively collect podspec-load manifests (isNativeManifest) under `dirAbs`. RN's own
// podspecs live in scattered subdirs a root-only scan would miss, so recurse fully.
function collectNativeManifests(dirAbs, out, atRoot = false) {
  let entries
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dirAbs, ent.name)
    if (ent.isDirectory()) {
      const skipDir = NATIVE_SKIP_DIRS.has(ent.name) || isNativeArtifact(ent.name) || (atRoot && isExcludedNativeDir(ent.name))
      if (!skipDir) collectNativeManifests(full, out)
    } else if (ent.isFile() && isNativeManifest(ent.name)) {
      out.push(full)
    }
  }
}

// Native source files a bundled RN dep contributes to the app's native build (podspecs +
// ios/android sources). Manifests are kept only when the package is actually native (podspec
// or ios/android dir), else a JS-only dep's package.json would be pulled in. Deduped absolute paths.
function nativeModuleFiles(pkgAbs) {
  const manifests = []
  collectNativeManifests(pkgAbs, manifests, true)
  const hasIos = existsSync(join(pkgAbs, 'ios'))
  const hasAndroid = existsSync(join(pkgAbs, 'android'))
  if (!hasIos && !hasAndroid && !manifests.some((f) => isPodspec(f))) return []
  const out = [...manifests]
  if (hasIos) walkNativeDir(join(pkgAbs, 'ios'), out)
  if (hasAndroid) walkNativeDir(join(pkgAbs, 'android'), out)
  return [...new Set(out)]
}

// Build a JS/TS Bundle + companion Lockfile via the legacy-field resolver (`--mainFields`/
// `--metro`). Scanned once per platform; each edge is recorded flat when the platforms that
// have it agree, or as a `{ platform: target }` map where they diverge. Returns { bundle, lockfile }.
async function buildResolvedJsBundle({ cwd = process.cwd(), entries, mainFields, platforms, conditions = [], metro = false }) {
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

  const formatsByRel = new Map()
  // parentRel -> specifier -> Map<platformKey, targetRel>; collapsed after all platforms scanned.
  const edges = new Map()
  const reached = new Set() // absolute paths reached on any platform
  let usesEmpty = false

  for (const platform of platforms) {
    // --metro asserts the RN conditions (+ browser on web); --mainFields (platform null) carries the user's --conditions.
    const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : scanConditions
    const resolver = createFieldResolver({
      mainFields,
      platform,
      preferNative: platform !== null && platform !== 'web',
      sourceExts: SOURCE_EXTS,
      conditions: resolveConditions('commonjs', extras),
      // Opt into Metro's package-entry browser-field quirks only on the --metro path.
      metro,
    })
    const scanner = scan(absEntries, { conditions: extras, resolve: resolver })
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

  // Read each reached file once: bytes for the bundle, integrity for the lockfile. Source is
  // stored as UTF-8 text, so non-UTF-8 bytes would diverge from the hashed bytes -- reject them.
  const sources = new Map()
  const integrities = new Map()
  const realBase = realpathSync(baseDir)
  for (const abs of reached) {
    const rel = toRel(abs)
    // Security: the field resolver returns the lexical path, so an in-tree-named symlink
    // escaping the root would slip past toRel's textual check -- realpath and fail closed.
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    if (!isUtf8(buf)) throw new Error(`JS bundle source is not valid UTF-8: ${rel}`)
    sources.set(rel, buf.toString('utf8'))
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
      const nm = splitNodeModulesPath(toRel(abs))
      if (nm) pkgDirs.add(nm.dir)
    }
    for (const pkgDir of [...pkgDirs].toSorted()) {
      const pkgAbs = join(baseDir, pkgDir)
      const files = nativeModuleFiles(pkgAbs)
      // React Native core also contributes vetted native dirs/files (Yoga, hermes-engine podspec, CocoaPods scripts).
      if (pkgDir.slice(pkgDir.lastIndexOf('node_modules/') + 'node_modules/'.length) === 'react-native') {
        for (const sub of RN_CORE_INCLUDE_DIRS) walkNativeDir(join(pkgAbs, sub), files)
        for (const file of RN_CORE_INCLUDE_FILES) {
          const f = join(pkgAbs, file)
          if (existsSync(f)) files.push(f)
        }
      }
      for (const abs of files) {
        const rel = toRel(abs)
        if (sources.has(rel)) continue
        assertRealPathWithinBase(realBase, baseDir, rel)
        // classifyNativeCapture (shared with the StasisMetro plugin) returns action skip/code/resource with a format tag.
        const { action, format } = classifyNativeCapture(rel)
        if (action === 'skip') continue
        const buf = readFileSync(abs)
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
  })

  return { bundle, lockfile }
}

// Classify entries into their single shared language and check option applicability; `name` prefixes errors.
function classifyEntries(name, { entries, mappingFile, scope, lockfile, conditions, mainFields, platforms, metro }) {
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
  // Reject --conditions for non-JS: their resolvers don't consult exports/imports conditions, so it would silently do nothing.
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
  // The field resolver always emits full-scope, so --scope with --mainFields/--metro would be silently ignored -- reject it.
  if (scope !== undefined && (mainFields !== undefined || metro)) {
    throw new Error(`${name}: --scope is not supported with --mainFields or --metro`)
  }
  return kind
}

// Programmatic equivalent of `stasis bundle`: build and return an in-memory Bundle without
// writing to disk. Files are attributed to the `bundle` consumer. Option applicability
// (--mapping/.sol, --scope|--conditions|--mainFields|--metro/JS) is enforced by classifyEntries.
export async function buildBundle({ cwd = process.cwd(), entries, mappingFile, scope, conditions, mainFields, platforms, metro } = {}) {
  const kind = classifyEntries('buildBundle', { entries, mappingFile, scope, conditions, mainFields, platforms, metro })
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
    })
    return bundle
  }
  const state = await buildJsBundle({ cwd, entries, scope, conditions })
  // Stamp the `bundle` consumer (the static build carries none).
  return state.sourceBundle.withReason('bundle')
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
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output, scope, lockfile, conditions, mainFields, platforms, metro, brotliQuality, add = false } = {}) {
  const kind = classifyEntries('bundleCommand', { entries, mappingFile, scope, lockfile, conditions, mainFields, platforms, metro })

  const target = output ?? DEFAULT_BUNDLE_FILE
  // --add has nothing to merge into on stdout (write-only).
  if (add && target === '-') {
    throw new Error('bundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  }

  let bundle
  let lockData
  if (kind === 'js' && (metro || mainFields !== undefined)) {
    // The legacy-field resolver builds Bundle + Lockfile directly (per-platform edges + a
    // synthetic empty module State's addFile can't represent).
    const built = await buildResolvedJsBundle({
      cwd,
      entries,
      mainFields: metro ? METRO_MAIN_FIELDS : mainFields,
      platforms: metro ? platforms : [null],
      conditions,
      metro: Boolean(metro),
    })
    bundle = built.bundle
    if (lockfile) lockData = built.lockfile.serialize()
  } else if (kind === 'js' && lockfile) {
    // Keep the State: only it carries the file hashes the companion lockfile needs (a Bundle holds sources, not digests).
    const state = await buildJsBundle({ cwd, entries, scope, conditions })
    // Stamp the `bundle` consumer (this branch bypasses buildBundle to keep the State).
    bundle = state.sourceBundle.withReason('bundle')
    lockData = state.lockData
  } else {
    bundle = await buildBundle({ cwd, entries, mappingFile, scope, conditions })
  }

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
