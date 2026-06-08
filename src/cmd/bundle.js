import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '../bundle.js'
import { brotliOptions, splitNodeModulesPath } from '../util.js'
import {
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  readRemappingsFile,
} from '../loaders/solidity.js'

// Fallback package identity for the workspace bucket when no package.json
// with a name+version can be found by walking up from any of the bundled
// files. Bundle.parseCode requires every workspace/module bucket to have
// both fields, so we have to attest something.
const SOLIDITY_WORKSPACE_NAME = 'solidity-bundle'
const SOLIDITY_WORKSPACE_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'

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

  // Partition every loaded .sol file into a per-package bucket. The
  // bucket is the directory holding the nearest package.json with a
  // name+version. node_modules files land in `node_modules/<pkg>` buckets
  // (or deeper, when a nested package.json claims the file); workspace
  // files land in their nearest workspace package.json's dir, or in the
  // fallback "." bucket with placeholder metadata when no package.json
  // could be found.
  const modules = new Map()
  const ensureBucket = (dir, name, version) => {
    if (!modules.has(dir)) modules.set(dir, { name, version, files: Object.create(null) })
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const meta = findPackageMetadata(baseDir, path)
    const inNodeModules = splitNodeModulesPath(path) !== null
    if (meta) {
      // A file inside node_modules whose nearest package.json is the
      // workspace root would silently land in the workspace bucket and
      // hide the misconfigured dependency — refuse instead.
      if (inNodeModules && !meta.pkgDir.includes('node_modules')) {
        throw new Error(`No package.json with name+version found for ${path}`)
      }
      const rel = meta.pkgDir === '.' ? path : path.slice(meta.pkgDir.length + 1)
      ensureBucket(meta.pkgDir, meta.name, meta.version).files[rel] = content
    } else {
      // Files under node_modules without any discoverable package.json
      // would otherwise leak into the workspace bucket; that's a project
      // misconfiguration, surface it loudly.
      if (inNodeModules) throw new Error(`No package.json with name+version found for ${path}`)
      ensureBucket('.', SOLIDITY_WORKSPACE_NAME, SOLIDITY_WORKSPACE_VERSION).files[path] = content
    }
  }

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, SOLIDITY_FORMAT)

  // Solidity imports don't depend on Node conditions; key them under a
  // dedicated "solidity" bucket rather than the wildcard "*" used for
  // JS code bundles.
  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([['solidity', importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(normalized),
    modules,
    formats,
    imports,
  })
}

// Run the bundle CLI command end-to-end. Always produces a brotli-compressed
// stasis bundle (matching the on-disk format of `stasis.code.br`). When
// `output` is provided, writes to that path; otherwise writes to stdout.
// Prints a one-line `[stasis] Bundled <n> files from <dir> to <dest>` summary
// to stderr so it doesn't interleave with the binary output on stdout.
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output } = {}) {
  const bundle = await buildSolidityBundle({ cwd, entries, mappingFile })
  const data = brotliCompressSync(bundle.serializeCode(), brotliOptions())
  if (output) {
    const outAbs = resolve(cwd, output)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  } else {
    process.stdout.write(data)
  }
  // Bundle.sources flattens every per-package bucket into project-relative
  // paths, so the summary reflects every file we wrote — workspace and
  // node_modules alike — not just the workspace bucket.
  const files = [...bundle.sources.keys()]
  const fromDir = outermostDir(files, resolve(cwd))
  const dest = output ?? '<stdout>'
  console.warn(`[stasis] Bundled ${files.length} files from ${fromDir} to ${dest}`)
  return bundle
}
