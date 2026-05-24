import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
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

function normaliseEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    if (rel.startsWith('..')) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
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
  const normalised = normaliseEntries(entries, cwd)

  const sources = await collectSolidityFilesFromDisk(baseDir, normalised, remappings)
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
    entries: new Set(normalised),
    modules: new Map([['.', { name: SOLIDITY_NAME, version: SOLIDITY_VERSION, files }]]),
    formats,
    imports,
  })
}

// Run the bundle CLI command end-to-end. When `output` is provided, writes
// the serialised bundle to that path (brotli-compressed when the path ends
// in `.br`, plain JSON otherwise). When omitted, writes JSON to stdout.
export async function bundleCommand({ cwd = process.cwd(), entries, mappingFile, output } = {}) {
  const bundle = await buildSolidityBundle({ cwd, entries, mappingFile })
  const text = bundle.serializeCode()
  if (output) {
    const outAbs = resolve(cwd, output)
    mkdirSync(dirname(outAbs), { recursive: true })
    const data = output.endsWith('.br') ? brotliCompressSync(text) : text
    writeFileSync(outAbs, data)
  } else {
    process.stdout.write(text)
  }
  return bundle
}
