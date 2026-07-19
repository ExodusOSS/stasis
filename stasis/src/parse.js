import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// Read a stasis artifact and parse it into a Lockfile or Bundle, reporting its `kind`
// ('lockfile' | 'bundle'). Lockfiles are JSON starting with `{`; bundles are brotli-compressed
// JSON — sniff the leading byte to route to the right parser so its diagnostic surfaces on failure.
export function parseFileWithKind(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`File not found: ${file}`, { cause })
    throw new Error(`Failed to read ${file}: ${cause.message}`, { cause })
  }
  if (buf[0] === 0x7b /* '{' */) {
    try {
      return { kind: 'lockfile', artifact: Lockfile.parse(buf.toString('utf8')) }
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
  try {
    return { kind: 'bundle', artifact: Bundle.parse(text) }
  } catch (cause) {
    throw new Error(`Failed to parse stasis bundle: ${file}`, { cause })
  }
}

// Thin wrapper over parseFileWithKind that drops the `kind` (for callers like audit/sbom).
export function parseFile(file) {
  return parseFileWithKind(file).artifact
}
