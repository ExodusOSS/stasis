import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { brotliOptions } from './brotli.js'
import { assertRealPathWithinBase, splitNodeModulesPath } from './util.js'

// Where `stasis[-core] bundle --shallow` writes when no --output is given -- the same
// name `stasis run --bundle=load` discovers by default.
const DEFAULT_BUNDLE_FILE = 'stasis.code.br'

// Module system for a `.js`/`.ts` file, read from the nearest package.json `type`.
// Node otherwise falls back to module-vs-commonjs SYNTAX detection, which needs a parse;
// a shallow bundle never parses, so a typeless package defaults to commonjs (see below).
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

// Extensions whose loader format depends on the extension alone. `.js`/`.ts` (which also
// need the package `type`) and unknown extensions (resources, decided from the bytes) are
// handled by shallowFormat / the read loop.
const FIXED_FORMATS = new Map([
  ['.mjs', 'module'], ['.cjs', 'commonjs'], ['.json', 'json'],
  ['.mts', 'module-typescript'], ['.cts', 'commonjs-typescript'],
  ['.sol', 'solidity'], ['.php', 'php'], ['.sh', 'bash'], ['.bash', 'bash'], ['.rs', 'rust'],
])

// The loader format a shallow-packed CODE/source file gets from its path alone, WITHOUT
// parsing it -- or null for an extension shallow treats as a resource (the caller decides
// resource vs resource:base64 from the bytes). For .js/.cjs/.mjs/.ts/.cts/.mts/.json this
// matches scan.js's `formatForFile` (so a shallow bundle and a deep one agree on a file's
// format, and `--add` can merge them); it adds the analysis-only source languages by extension.
//
// LIMITATION: a `.js`/`.ts` file in a package with no (or an unrecognized) `type` field
// falls back to commonjs here. The deep bundler resolves that case by parsing for module
// syntax; shallow mode deliberately doesn't parse, so use `.mjs`/`.cjs` or a package.json
// `type` when the module system matters.
function shallowFormat(absFile) {
  const ext = extname(absFile).toLowerCase()
  const fixed = FIXED_FORMATS.get(ext)
  if (fixed) return fixed
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return null
}

// Nearest package.json (walking up from the file's dir) that declares BOTH name and
// version, expressed relative to `baseDir` ("." for the project root). null when none
// exists at or above the file. Identical to the deep bundler's helper -- shallow buckets
// files the same way so the two produce interchangeable module layouts.
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

// Build a stasis Bundle (in-memory) that packs EXACTLY the given files -- no dependency
// scan, no import-graph walk, no loaders. Each file is read from disk, its format inferred
// from its path (see shallowFormat), and bucketed per package.json the same way the deep
// bundler buckets (node_modules files into per-package `npm` buckets, everything else into
// the workspace ".", with a name+version from the nearest package.json). `imports` is empty
// (nothing is resolved) and every non-resource file is recorded as an entry (each explicitly
// requested file is its own root). Refuses a file that's missing or an in-tree symlink whose
// real target escapes the project root, so the bundle stays self-contained and attestable.
export function buildShallowBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildShallowBundle: at least one file is required')
  }

  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  // De-duplicate while keeping first-seen order (the same file listed twice is one file).
  const files = [...new Set(normalizeEntries(entries, cwd))]

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const workspaceName = rootPkg.name ?? 'workspace'
  const workspaceVersion = rootPkg.version ?? '0.0.0'

  const modules = new Map()
  const formats = new Map()
  const codeEntries = []
  const ensureBucket = (dir, name, version, ecosystem) => {
    if (!modules.has(dir)) {
      modules.set(dir, ecosystem === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, ecosystem, files: Object.create(null) })
    }
    return modules.get(dir)
  }

  for (const rel of files) {
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) throw new Error(`buildShallowBundle: file not found: ${rel}`)
    // A bundle must carry only in-tree, attestable bytes: realpath the file and refuse a
    // symlink whose target escapes the project root (matches the deep bundler / loaders).
    assertRealPathWithinBase(realBase, baseDir, rel)
    const buf = readFileSync(abs)
    // A code/source file's format comes from its path; anything else is a resource,
    // stored raw UTF-8 or base64 by content. isUtf8 is consulted at most once per file.
    let format = shallowFormat(abs)
    let content
    if (format === null) {
      const utf8 = isUtf8(buf)
      format = utf8 ? 'resource' : 'resource:base64'
      content = utf8 ? buf.toString('utf8') : buf.toString('base64')
    } else {
      // Stored source is a UTF-8 string, so the bytes must BE UTF-8 or the stored text
      // would lossily diverge from the file on disk.
      if (!isUtf8(buf)) throw new Error(`buildShallowBundle: ${rel} is not valid UTF-8 (format '${format}')`)
      content = buf.toString('utf8')
    }

    const meta = findPackageMetadata(baseDir, rel)
    const inNodeModules = splitNodeModulesPath(rel) !== null
    if (meta) {
      // A node_modules file whose nearest package.json is the workspace root hides a
      // misconfigured dependency -- refuse rather than mislabel it (matches the deep path).
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`buildShallowBundle: no package.json with name+version found for ${rel}`)
      }
      const relInBucket = meta.pkgDir === '.' ? rel : rel.slice(meta.pkgDir.length + 1)
      const ecosystem = meta.pkgDir.includes('node_modules') ? 'npm' : undefined
      ensureBucket(meta.pkgDir, meta.name, meta.version, ecosystem).files[relInBucket] = content
    } else {
      if (inNodeModules) throw new Error(`buildShallowBundle: no package.json with name+version found for ${rel}`)
      ensureBucket('.', workspaceName, workspaceVersion).files[rel] = content
    }

    formats.set(rel, format)
    if (!Bundle.isResourceFormat(format)) codeEntries.push(rel)
  }

  // Attribute the packed files to the `bundle` consumer, like the deep static builders,
  // so `--add` into a bundle other consumers touched keeps the provenance map complete.
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(codeEntries),
    modules,
    formats,
    imports: new Map(),
  }).withReason('bundle')
}

// Total file count + non-empty-package count from a bundle's module buckets, in one pass
// -- avoids materializing the flat `sources` Map (a getter that rebuilds it on each access)
// just to read a length.
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

// Run the shallow bundle CLI command end-to-end: build a shallow Bundle from `entries`,
// optionally merge it into the bundle already at `output` (--add), brotli-compress, and
// write to `output` (stasis.code.br by default, or `-` for stdout). `logLabel` prefixes
// the one-line stderr summary (`stasis` from the full CLI, `stasis-core` from the core one).
export function shallowBundleCommand({ cwd = process.cwd(), entries, output, add = false, brotliQuality, logLabel = 'stasis-core' } = {}) {
  const target = output ?? DEFAULT_BUNDLE_FILE
  // --add reads the artifact at `target` back to merge into; stdout is write-only.
  if (add && target === '-') {
    throw new Error('shallowBundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  }

  let bundle = buildShallowBundle({ cwd, entries })

  // --add: grow the bundle already on disk instead of replacing it (Bundle.merge is
  // strict -- a file whose bytes/format differ throws). A missing target is a fresh write.
  const outAbs = target === '-' ? undefined : resolve(cwd, target)
  let mergedFrom
  if (add && existsSync(outAbs)) {
    let existing
    try {
      existing = Bundle.parse(brotliDecompressSync(readFileSync(outAbs)).toString('utf8'))
    } catch (cause) {
      throw new Error(`shallowBundleCommand: --add failed to read the existing bundle at ${target}`, { cause })
    }
    mergedFrom = tally(existing).files
    bundle = existing.merge(bundle)
  }

  const data = brotliCompressSync(bundle.serialize(), brotliOptions(brotliQuality))
  if (target === '-') {
    process.stdout.write(data)
  } else {
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  }

  const { files, packages } = tally(bundle)
  const pkgLabel = `${packages} package${packages === 1 ? '' : 's'}`
  const dest = target === '-' ? '<stdout>' : target
  if (mergedFrom !== undefined) {
    const added = files - mergedFrom
    console.warn(`[${logLabel}] Added ${added} file${added === 1 ? '' : 's'} (${files} total in ${pkgLabel}) to ${dest} (shallow)`)
  } else {
    console.warn(`[${logLabel}] Bundled ${files} file${files === 1 ? '' : 's'} in ${pkgLabel} to ${dest} (shallow)`)
  }
}
