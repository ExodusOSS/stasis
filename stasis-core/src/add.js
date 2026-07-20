import { isUtf8 } from 'node:buffer'
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { brotliOptions } from './brotli.js'
import { findPackageMetadata, normalizeEntries, packageType, readJson } from './bundle-util.js'
import { canonicalizePath, sha512integrity } from './state-util.js'
import { assertRealPathWithinBase, classifyFormat, hasNodeModulesSegment, isBrotliQuality, moduleFileKey, parseResourcesOption, pathExt, splitNodeModulesPath } from './util.js'

const CONFIG_FILE = 'stasis.config.json'
const LOCK_FILE = 'stasis.lock.json'

// Loader format for a source file from its path alone (no parsing); null if not recognized as source.
// LIMITATION: a `.js`/`.ts` with no package `type` falls back to commonjs -- use `.mjs`/`.cjs` or set `type` when the module system matters.
function sourceFormat(absFile, content) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return classifyFormat(absFile, { content }) ?? null
}

const tally = (bundle) => {
  let files = 0
  let packages = 0
  for (const m of bundle.modules.values()) {
    const n = Object.keys(m.files).length
    if (n > 0) {
      files += n
      packages += 1
    }
  }
  return { files, packages }
}

function readAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) {
    throw new Error(`add requires a ${CONFIG_FILE} (its bundleFile, resourcesBundleFile, and resources are all optional)`)
  }
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
  }
  const bundleFile = cfg.bundleFile ?? 'stasis.code.br'
  const resourcesBundleFile = cfg.resourcesBundleFile
  // Split targets must be distinct files: aiming both at one path clobbers on write and yields an unloadable pair.
  // Canonicalize (resolve + realpath) so relative-path and symlink aliases are caught, not just byte-identical strings.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality }
}

// Assemble a Bundle, bucketed per package.json. Unlike the deep `bundle` (whose entries are the
// roots it walked from), `add` records NO entries -- the files it attaches are attested, not
// entry points -- so an add bundle carries code with empty entries (valid; assertEntry fails
// closed for it) and nothing in it is runnable via `stasis run --bundle=load`.
function assembleBundle(baseDir, files, workspaceName, workspaceVersion) {
  const modules = new Map()
  const formats = new Map()
  const ensureBucket = (dir, name, version, ecosystem) => {
    if (!modules.has(dir)) {
      modules.set(dir, ecosystem === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, ecosystem, files: Object.create(null) })
    }
    return modules.get(dir)
  }
  // Memoize per directory: findPackageMetadata's result depends only on the file's directory.
  const metaByDir = new Map()
  const metaFor = (rel) => {
    const dir = dirname(rel)
    if (!metaByDir.has(dir)) metaByDir.set(dir, findPackageMetadata(baseDir, rel))
    return metaByDir.get(dir)
  }

  for (const [rel, { content, format }] of files) {
    const meta = metaFor(rel)
    const inNodeModules = splitNodeModulesPath(rel) !== null
    if (meta) {
      // A node_modules file whose nearest package.json is the workspace root is a misconfigured dep -- refuse (matches the deep path).
      if (inNodeModules && !hasNodeModulesSegment(meta.pkgDir)) {
        throw new Error(`add: no package.json with name+version found for ${rel}`)
      }
      const relInBucket = meta.pkgDir === '.' ? rel : rel.slice(meta.pkgDir.length + 1)
      const ecosystem = hasNodeModulesSegment(meta.pkgDir) ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, ecosystem).files[relInBucket] = content
    } else {
      if (inNodeModules) throw new Error(`add: no package.json with name+version found for ${rel}`)
      ensureBucket('.', workspaceName, workspaceVersion).files[rel] = content
    }
    formats.set(rel, format)
  }

  // Attribute packed files to the `add` consumer (distinct from the deep bundler's `bundle`).
  // Empty entries: add files are attested, never entry points.
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(),
    modules,
    formats,
    imports: new Map(),
  }).withReason('add')
}

function addToBundleFile(baseDir, targetPath, bundle, brotliQuality) {
  const abs = resolve(baseDir, targetPath)
  let mergedFrom
  if (existsSync(abs)) {
    let existing
    try {
      existing = Bundle.parse(brotliDecompressSync(readFileSync(abs)).toString('utf8'))
    } catch (cause) {
      throw new Error(`add: failed to read the existing bundle at ${targetPath}`, { cause })
    }
    mergedFrom = tally(existing).files
    bundle = existing.merge(bundle)
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, brotliCompressSync(bundle.serialize(), brotliOptions(brotliQuality)))
  const { files, packages } = tally(bundle)
  return { path: targetPath, total: files, packages, added: mergedFrom === undefined ? files : files - mergedFrom }
}

// Companion Lockfile for the packed files: the bundle's shape with each file's content swapped for
// its on-disk integrity, so a `stasis run --lock=frozen` reading from disk matches. imports is empty.
function bundleToLockfile(bundle, integrities) {
  const modules = new Map()
  for (const [dir, m] of bundle.modules) {
    const files = Object.create(null)
    for (const rel of Object.keys(m.files)) files[rel] = integrities.get(moduleFileKey(dir, rel))
    modules.set(dir, { name: m.name, version: m.version, ...(m.ecosystem === undefined ? {} : { ecosystem: m.ecosystem }), files })
  }
  return new Lockfile({ config: bundle.config, entries: bundle.entries, modules, imports: bundle.imports, formats: bundle.formats })
}

// Merge the companion lockfile into the project's stasis.lock.json (strict: divergent bytes throw).
function updateLockfile(lockPath, lockAdd) {
  let existing
  try {
    existing = Lockfile.parse(readFileSync(lockPath, 'utf8'))
  } catch (cause) {
    throw new Error(`add: failed to read the existing ${LOCK_FILE}`, { cause })
  }
  const before = tally(existing).files
  const merged = existing.merge(lockAdd)
  writeFileSync(lockPath, merged.serialize())
  const total = tally(merged).files
  return { total, added: total - before }
}

// Expand any directory in `rels` into the files under it (recursively, via Node's built-in
// fs.globSync), so `add src/` attests every file in src/ without listing them. Plain files pass
// through unchanged; a path that doesn't exist is kept as-is so the per-file existsSync check
// reports it. `**/*` follows glob's usual rule of not sweeping in dotfiles (`.env`, `.git/...`),
// Expand directories into their files (recursive glob). Gotcha: `**/*` skips dotfiles (.env, .git/...) -- name them explicitly.
function expandDirectories(baseDir, rels) {
  const out = []
  for (const rel of rels) {
    let stat
    try {
      stat = statSync(join(baseDir, rel))
    } catch {
      out.push(rel) // not found -- defer to the caller's clean "file not found" error
      continue
    }
    if (!stat.isDirectory()) {
      out.push(rel)
      continue
    }
    const dirAbs = join(baseDir, rel)
    for (const match of globSync('**/*', { cwd: dirAbs })) {
      const fileAbs = join(dirAbs, match)
      if (statSync(fileAbs).isFile()) out.push(relative(baseDir, fileAbs).split(/[\\/]/u).join('/'))
    }
  }
  return out
}

// Run `add` end-to-end: classify each listed file (recognized source = code, declared resource, else
// refuse) and write the target bundle(s), merging into an existing one if present. If a
// stasis.lock.json already exists, add updates it too (never creates one) so a frozen run stays consistent.
export function addCommand({ cwd = process.cwd(), entries, logLabel = 'stasis-core' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('add: at least one file is required')
  }
  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  const { bundleFile, resourcesBundleFile, resources, brotliQuality } = readAddConfig(baseDir)

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const workspaceName = rootPkg.name ?? 'workspace'
  const workspaceVersion = rootPkg.version ?? '0.0.0'

  // Lockfile updated only if one already exists (never created); hash packed bytes to match a frozen run.
  const lockPath = join(baseDir, LOCK_FILE)
  const hasLock = existsSync(lockPath)
  const integrities = new Map()

  const files = [...new Set(expandDirectories(baseDir, normalizeEntries(entries, cwd)))]
  if (files.length === 0) throw new Error('add: no files to add (directory entries matched nothing)')
  const codeFiles = new Map()
  const resourceFiles = new Map()
  for (const rel of files) {
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) throw new Error(`add: file not found: ${rel}`)
    // Refuse a symlink whose realpath escapes the project root -- a bundle carries only in-tree bytes (matches the deep bundler / loaders).
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    if (hasLock) integrities.set(rel, sha512integrity(buf))
    const format = sourceFormat(abs, buf)
    if (format !== null) {
      // Source is stored as a UTF-8 string, so non-UTF-8 bytes would lossily diverge from the file on disk.
      if (!isUtf8(buf)) throw new Error(`add: ${rel} is not valid UTF-8 (format '${format}')`)
      codeFiles.set(rel, { content: buf.toString('utf8'), format })
    } else if (resources.has(pathExt(rel) || basename(rel).toLowerCase())) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64' })
    } else {
      throw new Error(`add: ${rel} is neither a recognized source file nor a declared resource; add its extension to "resources" in ${CONFIG_FILE}`)
    }
  }

  const summary = []
  const writeTarget = (target, entriesForTarget, kind) => {
    if (entriesForTarget.size === 0) return
    const r = addToBundleFile(baseDir, target, assembleBundle(baseDir, entriesForTarget, workspaceName, workspaceVersion), brotliQuality)
    summary.push(`+${r.added} ${kind} (${r.total} total) -> ${r.path}`)
  }
  if (resourcesBundleFile) {
    writeTarget(bundleFile, codeFiles, 'source')
    writeTarget(resourcesBundleFile, resourceFiles, 'resource')
  } else {
    const all = new Map([...codeFiles, ...resourceFiles])
    const kind = codeFiles.size > 0 && resourceFiles.size > 0 ? 'file' : resourceFiles.size > 0 ? 'resource' : 'source'
    writeTarget(bundleFile, all, kind)
  }

  // A present lockfile attests both split targets from one file, so merge in every packed file's
  // integrity (code + resources together), mirroring the deep bundler's companion lockfile.
  if (hasLock) {
    const allFiles = new Map([...codeFiles, ...resourceFiles])
    const lockAdd = bundleToLockfile(assembleBundle(baseDir, allFiles, workspaceName, workspaceVersion), integrities)
    const r = updateLockfile(lockPath, lockAdd)
    summary.push(`+${r.added} (${r.total} total) -> ${LOCK_FILE}`)
  }

  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
