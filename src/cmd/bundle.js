import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '../bundle.js'
import {
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  readRemappingsFile,
} from '../loaders/solidity.js'

// Placeholder package identity for synthetic Solidity bundles. The Bundle
// workspace bucket requires a name+version but Solidity projects do not
// necessarily have a package.json — attest the bundle as
// `solidity-bundle@0.0.0` so Bundle's parseCode invariants hold.
const SOLIDITY_NAME = 'solidity-bundle'
const SOLIDITY_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'

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
  const { resolutions } = buildSolidityTree(sources, { remappings })

  // Slot every loaded .sol file under the workspace bucket "." that Bundle
  // expects. Solidity files have no package identity, so we tag the bucket
  // with a synthetic name+version that satisfies parseCode.
  const files = Object.create(null)
  for (const [path, content] of sources) files[path] = content

  const formats = new Map()
  for (const path of sources.keys()) formats.set(path, SOLIDITY_FORMAT)

  // Solidity imports do not depend on Node conditions; collapse everything
  // under the wildcard "*" condition key.
  const importsForKey = new Map()
  for (const [parent, specMap] of resolutions) importsForKey.set(parent, specMap)
  const imports = new Map([['*', importsForKey]])

  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(normalized),
    modules: new Map([['.', { name: SOLIDITY_NAME, version: SOLIDITY_VERSION, files }]]),
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
  const data = brotliCompressSync(bundle.serializeCode())
  if (output) {
    const outAbs = resolve(cwd, output)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, data)
  } else {
    process.stdout.write(data)
  }
  const files = Object.keys(bundle.modules.get('.').files)
  const fromDir = outermostDir(files, resolve(cwd))
  const dest = output ?? '<stdout>'
  console.warn(`[stasis] Bundled ${files.length} files from ${fromDir} to ${dest}`)
  return bundle
}
