import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// Read a stasis artifact from disk and parse it into a Lockfile or Bundle.
// Lockfiles are JSON text starting with `{`; code/resource bundles are
// brotli-compressed JSON. Sniff the leading byte to route to the right parser
// so its diagnostic surfaces on failure. Shared by `stasis audit` and
// `stasis sbom`, which both inventory the packages a lockfile/bundle records.
export function parseFile(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`File not found: ${file}`, { cause })
    throw new Error(`Failed to read ${file}: ${cause.message}`, { cause })
  }
  if (buf[0] === 0x7b /* '{' */) {
    try {
      return Lockfile.parse(buf.toString('utf8'))
    } catch (cause) {
      throw new Error(`Failed to parse stasis lockfile: ${file}`, { cause })
    }
  }
  let text
  try {
    text = brotliDecompressSync(buf).toString('utf8')
  } catch (cause) {
    throw new Error(`Failed to read ${file} as a stasis bundle (not brotli)`, { cause })
  }
  // Code bundles carry `formats`/`imports`; resource bundles don't. Route on shape.
  try {
    const isCode = JSON.parse(text).formats !== undefined
    return isCode ? Bundle.parseCode(text) : Bundle.parseResources(text)
  } catch (cause) {
    throw new Error(`Failed to parse stasis bundle: ${file}`, { cause })
  }
}
