import { isUtf8 } from 'node:buffer'
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { brotliOptions } from './brotli.js'
import { findPackageMetadata, normalizeEntries, packageType, readJson } from './bundle-util.js'
import { canonicalizePath, sha512integrity } from './state-util.js'
import { assertRealPathWithinBase, classifyFormat, hasNodeModulesSegment, isAutoExcludedFile, isBinaryPlist, isBrotliQuality, isExecutableMode, moduleFileKey, parseResourcesOption, pathExt, sortPaths, splitNodeModulesPath } from './util.js'

const CONFIG_FILE = 'stasis.config.json'
const LOCK_FILE = 'stasis.lock.json'

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
  // Split targets must be distinct files (else they clobber on write); canonicalized so symlink and relative aliases are caught too.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality }
}

// Assemble a Bundle bucketed per package.json. `add` records NO entries -- its files are attested, not entry points -- so nothing in an add bundle is runnable via `--bundle=load`.
function assembleBundle(baseDir, files, workspaceName, workspaceVersion) {
  const modules = new Map()
  const formats = new Map()
  const executable = new Set()
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

  for (const [rel, { content, format, executable: isExec }] of files) {
    const meta = metaFor(rel)
    const inNodeModules = splitNodeModulesPath(rel) !== null
    if (meta) {
      // A node_modules file whose nearest package.json is the workspace root is a misconfigured dep -- refuse.
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
    if (isExec) executable.add(rel)
  }

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(),
    modules,
    formats,
    imports: new Map(),
    executable,
  }).withReason('add')
}

// Merge add-if-missing into any existing bundle (divergent bytes for an attested path throw -- see
// mergeModuleMaps), returning the write as a thunk so every target's conflicts surface before the
// first byte lands and an aborted `add` leaves the project untouched.
function prepareBundleFile(baseDir, targetPath, bundle, brotliQuality) {
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
  const bytes = brotliCompressSync(bundle.serialize(), brotliOptions(brotliQuality))
  const { files, packages } = tally(bundle)
  return {
    write: () => {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, bytes)
    },
    summary: { path: targetPath, total: files, packages, added: mergedFrom === undefined ? files : files - mergedFrom },
  }
}

// Companion Lockfile: the bundle's shape with each file's content swapped for its on-disk integrity, so `--lock=frozen` matches.
function bundleToLockfile(bundle, integrities) {
  const modules = new Map()
  for (const [dir, m] of bundle.modules) {
    const files = Object.create(null)
    for (const rel of Object.keys(m.files)) files[rel] = integrities.get(moduleFileKey(dir, rel))
    modules.set(dir, { name: m.name, version: m.version, ...(m.ecosystem === undefined ? {} : { ecosystem: m.ecosystem }), files })
  }
  return new Lockfile({ config: bundle.config, entries: bundle.entries, modules, imports: bundle.imports, formats: bundle.formats, executable: bundle.executable })
}

// Merge into the project's stasis.lock.json (strict: divergent bytes throw), deferring the write like
// prepareBundleFile so a conflict here doesn't leave the bundles updated.
function prepareLockfile(lockPath, lockAdd) {
  let existing
  try {
    existing = Lockfile.parse(readFileSync(lockPath, 'utf8'))
  } catch (cause) {
    throw new Error(`add: failed to read the existing ${LOCK_FILE}`, { cause })
  }
  const before = tally(existing).files
  const merged = existing.merge(lockAdd)
  const serialized = merged.serialize()
  const total = tally(merged).files
  return { write: () => writeFileSync(lockPath, serialized), summary: { total, added: total - before } }
}

const toPosix = (path) => path.split(/[\\/]/u).join('/')

// GLOB step: expand directories into their files (recursive glob), as rel -> { swept, stats }.
// `swept` marks what the expansion FOUND -- only those face the auto-exclusion filter; `stats` is the
// walk's own stat, carried so validation doesn't re-probe the inode (undefined = not on disk, so
// validation reports it missing). Gotcha: `**/*` skips dotfiles (.env, .git/...) -- name them explicitly.
function expandDirectories(baseDir, rels) {
  const out = new Map()
  // First writer wins, EXCEPT that a named path overrides the same path already swept in.
  const record = (rel, swept, stats) => {
    if (swept && out.has(rel)) return
    out.set(rel, { swept, stats })
  }
  for (const rel of rels) {
    const stats = statSync(join(baseDir, rel), { throwIfNoEntry: false })
    if (stats === undefined || !stats.isDirectory()) {
      record(rel, false, stats)
      continue
    }
    const dirAbs = join(baseDir, rel)
    const found = []
    for (const match of globSync('**/*', { cwd: dirAbs })) {
      const fileAbs = join(dirAbs, match)
      // A dangling symlink stats as undefined -- skipped, not a hard ENOENT out of the walk.
      const fileStats = statSync(fileAbs, { throwIfNoEntry: false })
      if (fileStats?.isFile()) found.push([toPosix(relative(baseDir, fileAbs)), fileStats])
    }
    // Sorted, so neither the packed order nor any message derived from it depends on readdir order.
    for (const [file, fileStats] of found.toSorted(([a], [b]) => sortPaths(a, b))) record(file, true, fileStats)
  }
  return out
}

// One error for every file validation rejected, so a directory sweep names all of them at once
// instead of one per re-run. A lone offender keeps its exact standalone message.
function validationError({ missing, undeclared, nonUtf8 }) {
  const parts = []
  const list = (rels) => rels.toSorted(sortPaths).join(', ')
  if (missing.length === 1) parts.push(`file not found: ${missing[0]}`)
  else if (missing.length > 1) parts.push(`${missing.length} files not found: ${list(missing)}`)
  if (undeclared.length === 1) {
    parts.push(`${undeclared[0]} is neither a recognized source file nor a declared resource; add its extension to "resources" in ${CONFIG_FILE}`)
  } else if (undeclared.length > 1) {
    parts.push(`${undeclared.length} files are neither recognized source files nor declared resources; add their extensions to "resources" in ${CONFIG_FILE}: ${list(undeclared)}`)
  }
  if (nonUtf8.length === 1) parts.push(`${nonUtf8[0].rel} is not valid UTF-8 (format '${nonUtf8[0].format}')`)
  else if (nonUtf8.length > 1) {
    parts.push(`${nonUtf8.length} files are not valid UTF-8: ${nonUtf8.map(({ rel, format }) => `${rel} (format '${format}')`).join(', ')}`)
  }
  return new Error(`add: ${parts.join('; ')}`)
}

// VALIDATE step: classify the WHOLE set -- each file recognized source or a declared resource --
// before a single target is touched, collecting every offender into one error. `files` is [rel, stats]
// pairs from the glob step (stats undefined = not on disk). Containment is the one rule NOT collected:
// a symlink escaping the root is a security invariant, so it fails closed on the spot.
function validateFiles({ baseDir, realBase, files, resources, hash }) {
  const codeFiles = new Map()
  const resourceFiles = new Map()
  const integrities = new Map()
  const missing = []
  const undeclared = []
  const nonUtf8 = []
  for (const [rel, stats] of files) {
    if (stats === undefined) {
      missing.push(rel)
      continue
    }
    const executable = isExecutableMode(stats)
    // Refuse a symlink whose realpath escapes the project root -- a bundle carries only in-tree bytes.
    assertRealPathWithinBase(realBase, baseDir, rel)
    const abs = join(baseDir, rel)
    const buf = readFileSync(abs)
    if (hash) integrities.set(rel, sha512integrity(buf))
    const format = sourceFormat(abs, buf)
    // A binary plist can't be stored as the UTF-8 string its 'xml' format implies, so it is NOT source: it falls through to the resource branch (opaque base64).
    if (format !== null && !isBinaryPlist(rel, buf)) {
      // Source is stored as a UTF-8 string, so non-UTF-8 bytes would lossily diverge from the file on disk.
      if (isUtf8(buf)) codeFiles.set(rel, { content: buf.toString('utf8'), format, executable })
      else nonUtf8.push({ rel, format })
    } else if (resources.has(pathExt(rel) || basename(rel).toLowerCase())) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64', executable })
    } else {
      undeclared.push(rel)
    }
  }
  if (missing.length + undeclared.length + nonUtf8.length > 0) throw validationError({ missing, undeclared, nonUtf8 })
  return { codeFiles, resourceFiles, integrities }
}

// GLOB the listed paths (a directory expands to the files under it) -> FILTER the auto-excluded set
// out of what the sweep found -> VALIDATE the whole surviving set -> only then ADD it to the target
// bundle(s), add-if-missing. A stasis.lock.json is updated only when one already exists.
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

  // The CONFIGURED bundle targets, project-relative: a sweep must never attest an artifact this very
  // run is writing, and a target can be named anything (`dist/code.br`), which isAutoExcludedFile's
  // by-name rule can't recognize (it does cover the lockfile). One configured outside the project
  // yields a '..' path, which no swept path can equal.
  const outputs = new Set([bundleFile, resourcesBundleFile]
    .filter((file) => file !== undefined)
    .map((file) => toPosix(relative(baseDir, resolve(baseDir, file)))))

  const expanded = expandDirectories(baseDir, normalizeEntries(entries, cwd))
  // FILTER step: drop the auto-excluded set, but only from what the sweep FOUND -- a path the caller
  // named is added as asked. Counted in the summary below rather than dropped silently.
  const files = []
  const excluded = []
  for (const [rel, { swept, stats }] of expanded) {
    if (swept && (outputs.has(rel) || isAutoExcludedFile(rel, { resources }))) excluded.push(rel)
    else files.push([rel, stats])
  }
  if (files.length === 0) {
    throw new Error(`add: no files to add (directory entries matched ${excluded.length === 0
      ? 'nothing' : `only auto-excluded files: ${excluded.toSorted(sortPaths).join(', ')}`})`)
  }

  const { codeFiles, resourceFiles, integrities } = validateFiles({ baseDir, realBase, files, resources, hash: hasLock })

  // ADD step: every target's merge is computed first, then the writes run -- see prepareBundleFile.
  const summary = []
  const writes = []
  const planTarget = (target, entriesForTarget, kind) => {
    if (entriesForTarget.size === 0) return
    const { write, summary: r } = prepareBundleFile(baseDir, target, assembleBundle(baseDir, entriesForTarget, workspaceName, workspaceVersion), brotliQuality)
    writes.push(write)
    summary.push(`+${r.added} ${kind} (${r.total} total) -> ${r.path}`)
  }
  if (resourcesBundleFile) {
    planTarget(bundleFile, codeFiles, 'source')
    planTarget(resourcesBundleFile, resourceFiles, 'resource')
  } else {
    const all = new Map([...codeFiles, ...resourceFiles])
    const kind = codeFiles.size > 0 && resourceFiles.size > 0 ? 'file' : resourceFiles.size > 0 ? 'resource' : 'source'
    planTarget(bundleFile, all, kind)
  }

  // One lockfile attests both split targets, so merge in every packed file's integrity (code + resources together).
  if (hasLock) {
    const allFiles = new Map([...codeFiles, ...resourceFiles])
    const lockAdd = bundleToLockfile(assembleBundle(baseDir, allFiles, workspaceName, workspaceVersion), integrities)
    const { write, summary: r } = prepareLockfile(lockPath, lockAdd)
    writes.push(write)
    summary.push(`+${r.added} (${r.total} total) -> ${LOCK_FILE}`)
  }
  if (excluded.length > 0) summary.push(`skipped ${excluded.length} auto-excluded`)

  for (const write of writes) write()
  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
