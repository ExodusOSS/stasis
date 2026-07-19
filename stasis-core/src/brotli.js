import { constants as zlibConstants } from 'node:zlib'

import { assert, isBrotliQuality, parseBrotliQuality } from './util.js'

// Default brotli quality; 11 (max) costs far more for a marginal gain over 9.
export const DEFAULT_BROTLI_QUALITY = 9

export function brotliOptions(quality) {
  if (quality !== undefined) {
    assert(isBrotliQuality(quality), `brotli quality must be an integer 0..11, got ${quality}`)
  }
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (raw) {
    const n = parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', raw)
    assert(quality === undefined || quality === n,
      `brotli quality ${quality} conflicts with EXODUS_STASIS_BROTLI_QUALITY=${raw}`)
    quality = n
  }
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality ?? DEFAULT_BROTLI_QUALITY } }
}
