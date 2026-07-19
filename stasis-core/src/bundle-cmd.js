import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { brotliOptions } from './brotli.js'
import { assertRealPathWithinBase, isBrotliQuality, parseResourcesOption, pathExt, splitNodeModulesPath } from './util.js'

const CONFIG_FILE = 'stasis.config.json'

// Module system for a `.js`/`.ts` file, read from the nearest package.json `type`. Node
// otherwise falls back to module-vs-commonjs SYNTAX detection, which needs a parse; bundle-add
// never parses, so a typeless package defaults to commonjs (see sourceFormat's LIMITATION).
function packageType(file) {
  const pkg = findPackageJSON(pathToFileURL(file).toString())
  if (!pkg) return null
  try {
    const type = JSON.parse(readFileSync(pkg, 'utf8')).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Extensions whose loader format depends on the extension alone. `.js`/`.ts` (which also need
// the package `type`) and everything else are handled by sourceFormat.
const FIXED_FORMATS = new Map([
  ['.mjs', 'module'], ['.cjs', 'commonjs'], ['.json', 'json'],
  ['.mts', 'module-typescript'], ['.cts', 'commonjs-typescript'],
  ['.sol', 'solidity'], ['.php', 'php'], ['.sh', 'bash'], ['.bash', 'bash'], ['.rs', 'rust'],
])

// The loader format a CODE/source file gets from its path alone, WITHOUT parsing it -- or
// null for an extension bundle-add does not recognize as source (the caller then treats it
// as a resource iff it's declared in the config `resources` allowlist, else refuses it). For
// .js/.cjs/.mjs/.ts/.cts/.mts/.json this matches scan.js's `formatForFile` (so a bundle-add
// bundle and a deep one agree on a file's format, and the two can be merged); it adds the
// analysis-only source languages by extension.
//
// LIMITATION: a `.js`/`.ts` file in a package with no (or an unrecognized) `type` field falls
// back to commonjs here. The deep bundler resolves that case by parsing for module syntax;
// bundle-add deliberately doesn't parse, so use `.mjs`/`.cjs` or a package.json `type` when
// the module system matters.
function sourceFormat(absFile) {
  const ext = extname(absFile).toLowerCase()
  const fixed = FIXED_FORMATS.get(ext)
  if (fixed) return fixed
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return null
}

// Nearest package.json (walking up from the file's dir) that declares BOTH name and version,
// expressed relative to `baseDir` ("." for the project root). null when none exists at or
// above the file. Buckets files the same way the deep bundler does, so the two produce
// interchangeable module layouts.
function findPackageMetadata(baseDir, fileRelPath) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name && pkg.version) return { pkgDir: dir, name: pkg.name, version: pkg.version }
      } catch { /* malformed -- keep walking */ }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Map the given files to POSIX, project-relative paths, rejecting any that escape cwd.
function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    // On Windows `path.relative()` returns an absolute path across drives -- reject both forms.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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

// Read bundle-add's inputs from stasis.config.json: the two split targets (`bundleFile` for
// code, `resourcesBundleFile` for resources) and the `resources` allowlist that classifies
// which non-source files are resources. bundle-add REQUIRES a config -- unlike the deep
// `bundle`, which infers everything from the entries -- because the split targets and the
// resource classification are project decisions that belong in the config, not on the CLI.
function readBundleAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) {
    throw new Error(`bundle-add requires a ${CONFIG_FILE} (it declares bundleFile, resourcesBundleFile, and the resources allowlist)`)
  }
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
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

  for (const [rel, { content, format }] of files) {
    const meta = findPackageMetadata(baseDir, rel)
    const inNodeModules = splitNodeModulesPath(rel) !== null
    if (meta) {
      // A node_modules file whose nearest package.json is the workspace root hides a
      // misconfigured dependency -- refuse rather than mislabel it (matches the deep path).
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`bundle-add: no package.json with name+version found for ${rel}`)
      }
      const relInBucket = meta.pkgDir === '.' ? rel : rel.slice(meta.pkgDir.length + 1)
      const ecosystem = meta.pkgDir.includes('node_modules') ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, ecosystem).files[relInBucket] = content
    } else {
      if (inNodeModules) throw new Error(`bundle-add: no package.json with name+version found for ${rel}`)
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
      throw new Error(`bundle-add: failed to read the existing bundle at ${targetPath}`, { cause })
    }
    mergedFrom = tally(existing).files
    bundle = existing.merge(bundle)
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, brotliCompressSync(bundle.serialize(), brotliOptions(brotliQuality)))
  const { files, packages } = tally(bundle)
  return { path: targetPath, total: files, packages, added: mergedFrom === undefined ? files : files - mergedFrom }
}

// Run `stasis[-core] bundle-add` end-to-end: add the explicitly listed files to the project's
// split bundles. Reads stasis.config.json (REQUIRED) for the two targets + the resources
// allowlist, classifies each file -- a recognized source file (see sourceFormat) goes to the
// code bundle (`bundleFile`), a file declared in `resources` goes to the resources bundle
// (`resourcesBundleFile`), and anything else is refused -- then merges each set into its
// target on disk, creating it if absent. No dependency scan/loaders/resolver, so this lives in
// stasis-core. The two bundles are a split pair that (at run time) share ONE lockfile;
// bundle-add writes no lockfile of its own. `logLabel` prefixes the one-line stderr summary.
export function bundleAddCommand({ cwd = process.cwd(), entries, logLabel = 'stasis-core' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('bundle-add: at least one file is required')
  }
  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  const { bundleFile, resourcesBundleFile, resources, brotliQuality } = readBundleAddConfig(baseDir)

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const workspaceName = rootPkg.name ?? 'workspace'
  const workspaceVersion = rootPkg.version ?? '0.0.0'

  // De-duplicate while keeping first-seen order (the same file listed twice is one file).
  const files = [...new Set(normalizeEntries(entries, cwd))]
  const codeFiles = new Map()
  const resourceFiles = new Map()
  for (const rel of files) {
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) throw new Error(`bundle-add: file not found: ${rel}`)
    // A bundle must carry only in-tree, attestable bytes: realpath the file and refuse a
    // symlink whose target escapes the project root (matches the deep bundler / loaders).
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    const format = sourceFormat(abs)
    if (format !== null) {
      // Stored source is a UTF-8 string, so the bytes must BE UTF-8 or the stored text would
      // lossily diverge from the file on disk.
      if (!isUtf8(buf)) throw new Error(`bundle-add: ${rel} is not valid UTF-8 (format '${format}')`)
      codeFiles.set(rel, { content: buf.toString('utf8'), format })
    } else if (resources.has(pathExt(rel) || basename(rel).toLowerCase())) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64' })
    } else {
      throw new Error(`bundle-add: ${rel} is neither a recognized source file nor a declared resource; add its extension to "resources" in ${CONFIG_FILE}`)
    }
  }

  if (codeFiles.size > 0 && !bundleFile) {
    throw new Error(`bundle-add: ${CONFIG_FILE} must set "bundleFile" to add source files (${[...codeFiles.keys()].join(', ')})`)
  }
  if (resourceFiles.size > 0 && !resourcesBundleFile) {
    throw new Error(`bundle-add: ${CONFIG_FILE} must set "resourcesBundleFile" to add resources (${[...resourceFiles.keys()].join(', ')})`)
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
  console.warn(`[${logLabel}] bundle-add: ${summary.join('; ')}`)
}
