import { constants as zlibConstants } from 'node:zlib'

import { assert } from './util.js'

// Brotli's default quality is 11 (max) and the encoder is superlinear in input
// size, so on a multi-MB source bundle it dominates write time. The quality is
// tunable via the `brotliQuality` config option (Config option / stasis.config.json
// key, passed in here by the writer) or the env var; the output is still a valid
// .br at any quality. Tests that bundle real-world dependency trees override it
// to keep runs fast. Production code pays the default cost in exchange for the
// best ratio.
//
// `quality` is an explicit integer 0..11 (typically config.brotliQuality), or
// undefined for "no opinion". The env var must agree with an explicit quality
// when both are set -- same fail-loud stance as Config's env-vs-option checks.
// Callers going through Config never trip that assert (Config already enforces
// agreement); it exists for direct callers like `stasis bundle --brotli-quality`.
//
// Kept out of `util.js` so that importing the generic helpers there (`sortPaths`,
// `assertRealPathWithinBase`, …) doesn't transitively load `node:zlib`. Only the
// code that actually compresses a bundle (`state.js`, `stasis bundle`) reaches
// for this, and that code already imports zlib directly.
export function brotliOptions(quality) {
  if (quality !== undefined) {
    assert(Number.isInteger(quality) && quality >= 0 && quality <= 11, `brotli quality must be an integer 0..11, got ${quality}`)
  }
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (raw) {
    const n = Number(raw)
    assert(Number.isInteger(n) && n >= 0 && n <= 11, `EXODUS_STASIS_BROTLI_QUALITY must be an integer 0..11, got ${raw}`)
    assert(quality === undefined || quality === n,
      `brotli quality ${quality} conflicts with EXODUS_STASIS_BROTLI_QUALITY=${raw}`)
    quality = n
  }
  if (quality === undefined) return undefined
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality } }
}
