import { isUtf8 } from 'node:buffer'
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { brotliOptions } from './brotli.js'
import { findPackageMetadata, normalizeEntries, packageType, readJson } from './bundle-util.js'
import { canonicalizePath, sha512integrity } from './state-util.js'
import { assertRealPathWithinBase, classifyFormat, isBrotliQuality, moduleFileKey, parseResourcesOption, pathExt, splitNodeModulesPath } from './util.js'

const CONFIG_FILE = 'stasis.config.json'
const LOCK_FILE = 'stasis.lock.json'

// The loader format a source file gets from its path alone, WITHOUT parsing -- or null when
// `add` doesn't recognize it as source (caller then treats it as a resource iff declared in the
// config `resources` allowlist, else refuses it). Beyond the .js/.ts package-`type` rule, it
// consults classifyFormat -- the single name->format authority -- so `add` and deep/native
// bundles agree on every format and can be merged. `content` is passed only so an extensionless
// `#!/usr/bin/env bash` wrapper is recognized as 'shell'.
//
// LIMITATION: a `.js`/`.ts` file with no (or unrecognized) package `type` falls back to commonjs
// here -- the deep bundler parses for module syntax, `add` doesn't; use `.mjs`/`.cjs` or a
// package.json `type` when the module system matters.
function sourceFormat(absFile, content) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return classifyFormat(absFile, { content }) ?? null
}

// Total file count + non-empty-package count from a bundle's module buckets, in one pass --
// avoids materializing the flat `sources` Map (a getter that rebuilds it on each access).
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

// Read add's inputs from stasis.config.json. add REQUIRES the config file to exist -- it's where
// project decisions live -- but every field is optional and defaults sensibly:
//   - bundleFile: the code target; defaults to the conventional `stasis.code.br`.
//   - resourcesBundleFile: when set, declared resources split into their own bundle; when unset,
//     they go into bundleFile alongside the code (non-split).
//   - resources: the allowlist classifying which non-source files count as resources; default none.
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
  // The two split targets must name distinct on-disk files: the code and resources bundles have
  // incompatible shapes (a resources bundle must have no entries and only resource formats), so
  // aiming both at one path yields a pair the loader can't consume, and the second write clobbers
  // the first. Canonicalize (resolve + realpath) like Config's collision check, so './dist/x.br'
  // vs 'dist/x.br' or two symlinks to one inode are caught, not just byte-identical strings.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality }
}

// Assemble a Bundle from files already read into `rel -> { content, format }`, bucketed per
// package.json like the deep bundler (node_modules into per-package `npm` buckets, the rest
// into the workspace ".", with name+version from the nearest package.json). `imports` is empty
// (nothing is resolved) and every non-resource file is an entry (each listed file is its own
// root), so a resources-only set yields a bundle with no entries -- the shape the runtime's
// resources-bundle split expects.
function assembleBundle(baseDir, files, workspaceName, workspaceVersion) {
  const modules = new Map()
  const formats = new Map()
  const entries = []
  const ensureBucket = (dir, name, version, ecosystem) => {
    if (!modules.has(dir)) {
      modules.set(dir, ecosystem === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, ecosystem, files: Object.create(null) })
    }
    return modules.get(dir)
  }
  // findPackageMetadata's result depends only on the file's DIRECTORY (it dirnames first, then
  // walks up), so memoize per directory -- siblings in one directory share the package.json walk
  // instead of re-doing the existsSync + read each time.
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
      // A node_modules file whose nearest package.json is the workspace root hides a
      // misconfigured dependency -- refuse rather than mislabel it (matches the deep path).
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`add: no package.json with name+version found for ${rel}`)
      }
      const relInBucket = meta.pkgDir === '.' ? rel : rel.slice(meta.pkgDir.length + 1)
      const ecosystem = meta.pkgDir.includes('node_modules') ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, ecosystem).files[relInBucket] = content
    } else {
      if (inNodeModules) throw new Error(`add: no package.json with name+version found for ${rel}`)
      ensureBucket('.', workspaceName, workspaceVersion).files[rel] = content
    }
    formats.set(rel, format)
    if (!Bundle.isResourceFormat(format)) entries.push(rel)
  }

  // Attribute the packed files to the `add` consumer, so a bundle `add` touches keeps its
  // provenance map complete (and distinct from the deep bundler's `bundle` attribution).
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats,
    imports: new Map(),
  }).withReason('add')
}

// Add `bundle` to the artifact already at `targetPath` (Bundle.merge is strict -- a file whose
// bytes/format differ from what the target attests throws), or write it fresh when nothing is
// there yet. Returns the write summary.
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

// Build the companion Lockfile for the files `add` packed: mirror the assembled bundle, swapping
// each file's content for its integrity (hashed from the raw on-disk bytes in `integrities`, so a
// `stasis run --lock=frozen` reading from disk matches). Shares the bundle's modules/entries/
// imports/formats shapes -- `add` resolves nothing, so imports is empty.
function bundleToLockfile(bundle, integrities) {
  const modules = new Map()
  for (const [dir, m] of bundle.modules) {
    const files = Object.create(null)
    for (const rel of Object.keys(m.files)) files[rel] = integrities.get(moduleFileKey(dir, rel))
    modules.set(dir, { name: m.name, version: m.version, ...(m.ecosystem === undefined ? {} : { ecosystem: m.ecosystem }), files })
  }
  return new Lockfile({ config: bundle.config, entries: bundle.entries, modules, imports: bundle.imports, formats: bundle.formats })
}

// Merge the companion lockfile into the project's stasis.lock.json (already present) and rewrite
// it, so the lockfile keeps attesting exactly what the bundles carry. Strict like the bundle
// merge -- a file whose bytes differ from what the lockfile already attests throws.
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
// so add a leading-dot file by naming it explicitly.
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
      // `**/*` also matches nested directories; keep only files.
      if (statSync(fileAbs).isFile()) out.push(relative(baseDir, fileAbs).split(/[\\/]/u).join('/'))
    }
  }
  return out
}

// Run `stasis[-core] add` end-to-end: add the listed files (a directory entry expands to the
// files under it) to the project's bundle(s). Reads stasis.config.json (REQUIRED, though its
// fields default) for the targets + the resources allowlist, classifies each file -- a
// recognized source file (see sourceFormat) is code, a file whose extension is declared in
// `resources` is a resource, anything else is refused -- then writes: with a resourcesBundleFile
// configured the two kinds split into `bundleFile` and `resourcesBundleFile` (a pair that share
// ONE lockfile at run time); without one, everything lands in `bundleFile` (non-split). Each
// target is assembled in memory and written exactly ONCE (one brotli pass), merging into an
// existing bundle if present. No dependency scan/loaders/resolver, so this lives in stasis-core.
// When the project's stasis.lock.json already exists, add updates it too -- attesting the same
// files' integrities -- so a frozen run stays consistent; it never creates a lockfile.
// `logLabel` prefixes the one-line stderr summary.
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

  // Update the project lockfile only if one is already present (add never creates one). When it
  // is, hash each packed file's raw bytes so the companion lockfile entries match a frozen run.
  const lockPath = join(baseDir, LOCK_FILE)
  const hasLock = existsSync(lockPath)
  const integrities = new Map()

  // Expand directory entries to their files, then de-duplicate while keeping first-seen order
  // (the same file listed twice, or reached via both a name and its parent dir, is one file).
  const files = [...new Set(expandDirectories(baseDir, normalizeEntries(entries, cwd)))]
  if (files.length === 0) throw new Error('add: no files to add (directory entries matched nothing)')
  const codeFiles = new Map()
  const resourceFiles = new Map()
  for (const rel of files) {
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) throw new Error(`add: file not found: ${rel}`)
    // A bundle must carry only in-tree, attestable bytes: realpath the file and refuse a
    // symlink whose target escapes the project root (matches the deep bundler / loaders).
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    if (hasLock) integrities.set(rel, sha512integrity(buf))
    const format = sourceFormat(abs, buf)
    if (format !== null) {
      // Stored source is a UTF-8 string, so the bytes must BE UTF-8 or the stored text would
      // lossily diverge from the file on disk.
      if (!isUtf8(buf)) throw new Error(`add: ${rel} is not valid UTF-8 (format '${format}')`)
      codeFiles.set(rel, { content: buf.toString('utf8'), format })
    } else if (resources.has(pathExt(rel) || basename(rel).toLowerCase())) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64' })
    } else {
      throw new Error(`add: ${rel} is neither a recognized source file nor a declared resource; add its extension to "resources" in ${CONFIG_FILE}`)
    }
  }

  // Group files by target bundle, then write each target exactly once. Split mode (a
  // resourcesBundleFile is configured) sends code to bundleFile and resources to
  // resourcesBundleFile; non-split sends everything to bundleFile together.
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
    // Non-split: one combined bundle. Label it by what it holds -- pure code / pure resources
    // keep the split wording; a mix reports the neutral "file".
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
