import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// Read a stasis artifact from disk and parse it into a Lockfile or Bundle,
// reporting which kind it turned out to be. `kind` is one of:
//   'lockfile'  -- a `stasis.lock.json` (files recorded as SRI digests)
//   'code'      -- a `stasis.code.br`   (files recorded as UTF-8 source bytes)
//   'resources' -- a `stasis.resources.br` (files recorded as base64 blobs)
// The kind matters to callers that re-derive digests from a bundle's bytes
// (`stasis diff`): code files hash as UTF-8 text, resource files hash as the
// decoded base64 bytes -- so a code bundle and a resource bundle of the same
// underlying file produce different per-kind hashing paths.
//
// Lockfiles are JSON text starting with `{`; code/resource bundles are
// brotli-compressed JSON. Sniff the leading byte to route to the right parser
// so its diagnostic surfaces on failure.
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
  // Code bundles carry `formats`/`imports`; resource bundles don't. Route on shape.
  try {
    const isCode = JSON.parse(text).formats !== undefined
    return isCode
      ? { kind: 'code', artifact: Bundle.parseCode(text) }
      : { kind: 'resources', artifact: Bundle.parseResources(text) }
  } catch (cause) {
    throw new Error(`Failed to parse stasis bundle: ${file}`, { cause })
  }
}

// Read a stasis artifact from disk and parse it into a Lockfile or Bundle.
// Shared by `stasis audit` and `stasis sbom`, which both inventory the packages
// a lockfile/bundle records and don't care which kind it is. Thin wrapper over
// `parseFileWithKind` that drops the `kind`.
export function parseFile(file) {
  return parseFileWithKind(file).artifact
}
