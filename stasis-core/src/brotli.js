import { constants as zlibConstants } from 'node:zlib'

import { assert } from './util.js'

// Brotli's default quality is 11 (max) and the encoder is superlinear in input
// size, so on a multi-MB source bundle it dominates write time. The quality is
// tunable via `quality` (an integer 0..11, typically config.brotliQuality) or the
// env var -- which must agree when both are set; the output is still a valid .br
// at any quality. Production code pays the default cost for the best ratio.
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
    // `${n}` must round-trip back to raw, rejecting coercible forms like '5.0' / '05' /
    // whitespace (Number('   ') is 0). '' still means "unset" via the truthiness gate.
    const n = Number(raw)
    assert(`${n}` === raw && Number.isInteger(n) && n >= 0 && n <= 11, `EXODUS_STASIS_BROTLI_QUALITY must be an integer 0..11, got ${raw}`)
    assert(quality === undefined || quality === n,
      `brotli quality ${quality} conflicts with EXODUS_STASIS_BROTLI_QUALITY=${raw}`)
    quality = n
  }
  if (quality === undefined) return undefined
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality } }
}
