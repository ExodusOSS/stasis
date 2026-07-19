import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { brotliOptions } from './brotli.js'
import { findPackageMetadata, normalizeEntries, packageType, readJson } from './bundle-util.js'
import { canonicalizePath } from './state-util.js'
import { assertRealPathWithinBase, classifyFormat, isBrotliQuality, parseResourcesOption, pathExt, splitNodeModulesPath } from './util.js'

const CONFIG_FILE = 'stasis.config.json'

// The loader format a CODE/source file gets from its path alone, WITHOUT parsing it -- or null when
// `add` doesn't recognize it as source (the caller then treats it as a resource iff declared in the
// config `resources` allowlist, else refuses it). Beyond the .js/.ts package-`type` rule (which
// reads the nearest package.json, so it can't be name-only), it just consults classifyFormat -- the
// single name->format authority -- so an `add` bundle and a deep/native one agree on every format
// and can be merged. `content` is passed only so an extensionless `#!/usr/bin/env bash` wrapper is
// recognized as 'shell'.
//
// LIMITATION: a `.js`/`.ts` file with no (or an unrecognized) package `type` falls back to commonjs
// here -- the deep bundler parses for module syntax, but `add` doesn't; use `.mjs`/`.cjs` or a
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

// Read add's inputs from stasis.config.json: the two split targets (`bundleFile` for
// code, `resourcesBundleFile` for resources) and the `resources` allowlist that classifies
// which non-source files are resources. add REQUIRES a config -- unlike the deep
// `bundle`, which infers everything from the entries -- because the split targets and the
// resource classification are project decisions that belong in the config, not on the CLI.
function readAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) {
    throw new Error(`add requires a ${CONFIG_FILE} (it declares bundleFile, resourcesBundleFile, and the resources allowlist)`)
  }
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
  }
  // The two split targets must name distinct on-disk files. The code bundle and the resources
  // bundle have incompatible shapes (the runtime asserts a resources bundle has no entries and
  // only resource formats), so aiming both at one path yields a pair the loader can't consume --
  // and the second write would clobber the first. Canonicalize (resolve + realpath) like
  // Config's write-target collision check, so './dist/x.br' vs 'dist/x.br', or two symlinks to
  // the same inode, are caught -- not just byte-identical strings.
  if (cfg.bundleFile && cfg.resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, cfg.bundleFile)) === canonicalizePath(resolve(baseDir, cfg.resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, cfg.bundleFile)})`)
  }
  return { bundleFile: cfg.bundleFile, resourcesBundleFile: cfg.resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality }
}

// Assemble a Bundle from files already read into `rel -> { content, format }`, bucketed per
// package.json like the deep bundler (node_modules files into per-package `npm` buckets,
// everything else into the workspace ".", with a name+version from the nearest package.json).
// `imports` is empty (nothing is resolved) and every non-resource file is recorded as an
// entry (each explicitly listed file is its own root). A resources-only set therefore yields a
// bundle with no entries -- exactly the shape the runtime's resources-bundle split expects.
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
  // findPackageMetadata's result depends only on the file's DIRECTORY (it dirnames the path
  // first, then walks up), so memoize per directory -- sibling files in one directory share
  // the same package.json walk instead of re-doing the existsSync + read for each.
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

  // Attribute the packed files to the `bundle` consumer, like the deep static builders, so an
  // add into a bundle other consumers touched keeps the provenance map complete.
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats,
    imports: new Map(),
  }).withReason('bundle')
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

// Run `stasis[-core] add` end-to-end: add the explicitly listed files to the project's
// split bundles. Reads stasis.config.json (REQUIRED) for the two targets + the resources
// allowlist, classifies each file -- a recognized source file (see sourceFormat) goes to the
// code bundle (`bundleFile`), a file declared in `resources` goes to the resources bundle
// (`resourcesBundleFile`), and anything else is refused -- then merges each set into its
// target on disk, creating it if absent. No dependency scan/loaders/resolver, so this lives in
// stasis-core. The two bundles are a split pair that (at run time) share ONE lockfile;
// add writes no lockfile of its own. `logLabel` prefixes the one-line stderr summary.
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

  // De-duplicate while keeping first-seen order (the same file listed twice is one file).
  const files = [...new Set(normalizeEntries(entries, cwd))]
  const codeFiles = new Map()
  const resourceFiles = new Map()
  for (const rel of files) {
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) throw new Error(`add: file not found: ${rel}`)
    // A bundle must carry only in-tree, attestable bytes: realpath the file and refuse a
    // symlink whose target escapes the project root (matches the deep bundler / loaders).
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
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

  if (codeFiles.size > 0 && !bundleFile) {
    throw new Error(`add: ${CONFIG_FILE} must set "bundleFile" to add source files (${[...codeFiles.keys()].join(', ')})`)
  }
  if (resourceFiles.size > 0 && !resourcesBundleFile) {
    throw new Error(`add: ${CONFIG_FILE} must set "resourcesBundleFile" to add resources (${[...resourceFiles.keys()].join(', ')})`)
  }

  const summary = []
  if (codeFiles.size > 0) {
    const r = addToBundleFile(baseDir, bundleFile, assembleBundle(baseDir, codeFiles, workspaceName, workspaceVersion), brotliQuality)
    summary.push(`+${r.added} source (${r.total} total) -> ${r.path}`)
  }
  if (resourceFiles.size > 0) {
    const r = addToBundleFile(baseDir, resourcesBundleFile, assembleBundle(baseDir, resourceFiles, workspaceName, workspaceVersion), brotliQuality)
    summary.push(`+${r.added} resource (${r.total} total) -> ${r.path}`)
  }
  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
