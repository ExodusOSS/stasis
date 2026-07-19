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

// The format a shallow-packed file gets, WITHOUT parsing it. For the extensions the
// static bundler recognizes it matches scan.js's `formatForFile` exactly (so a shallow
// bundle and a deep one agree on a file's format, and `--add` can merge them); it adds
// the analysis-only source languages by extension, and classifies everything else as a
// resource -- raw UTF-8 ('resource') or, for non-UTF-8 bytes, base64 ('resource:base64').
//
// LIMITATION: a `.js`/`.ts` file in a package with no (or an unrecognized) `type` field
// falls back to commonjs here. The deep bundler resolves that case by parsing for module
// syntax; shallow mode deliberately doesn't parse, so use `.mjs`/`.cjs` or a package.json
// `type` when the module system matters.
function shallowFormat(absFile, buf) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.mjs') return 'module'
  if (ext === '.cjs') return 'commonjs'
  if (ext === '.json') return 'json'
  if (ext === '.mts') return 'module-typescript'
  if (ext === '.cts') return 'commonjs-typescript'
  if (ext === '.js' || ext === '.ts') {
    const suffix = ext === '.ts' ? '-typescript' : ''
    return `${packageType(absFile) ?? 'commonjs'}${suffix}`
  }
  if (ext === '.sol') return 'solidity'
  if (ext === '.php') return 'php'
  if (ext === '.sh' || ext === '.bash') return 'bash'
  if (ext === '.rs') return 'rust'
  return isUtf8(buf) ? 'resource' : 'resource:base64'
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
    const format = shallowFormat(abs, buf)
    let content
    if (format === 'resource:base64') {
      content = buf.toString('base64')
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
    mergedFrom = existing.sources.size
    bundle = existing.merge(bundle)
  }

  const data = brotliCompressSync(bundle.serialize(), brotliOptions(brotliQuality))
  if (target === '-') {
    process.stdout.write(data)
  } else {
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  }

  const files = [...bundle.sources.keys()]
  const packages = [...bundle.modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  const pkgLabel = `${packages} package${packages === 1 ? '' : 's'}`
  const dest = target === '-' ? '<stdout>' : target
  if (mergedFrom !== undefined) {
    const added = files.length - mergedFrom
    console.warn(`[${logLabel}] Added ${added} file${added === 1 ? '' : 's'} (${files.length} total in ${pkgLabel}) to ${dest} (shallow)`)
  } else {
    console.warn(`[${logLabel}] Bundled ${files.length} file${files.length === 1 ? '' : 's'} in ${pkgLabel} to ${dest} (shallow)`)
  }
}
