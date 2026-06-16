import { constants as zlibConstants } from 'node:zlib'

import { assert } from './util.js'

// Brotli's default quality is 11 (max) and the encoder is superlinear in input
// size, so on a multi-MB source bundle it dominates write time. Tests that
// bundle real-world dependency trees can override this via the env var to keep
// runs fast; the output is still a valid .br at any quality. Production code
// pays the default cost in exchange for the best ratio.
//
// Kept out of `util.js` so that importing the generic helpers there (`sortPaths`,
// `assertRealPathWithinBase`, …) doesn't transitively load `node:zlib`. Only the
// code that actually compresses a bundle (`state.js`, `stasis bundle`) reaches
// for this, and that code already imports zlib directly.
export function brotliOptions() {
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (!raw) return undefined
  const n = Number(raw)
  assert(Number.isInteger(n) && n >= 0 && n <= 11, `EXODUS_STASIS_BROTLI_QUALITY must be an integer 0..11, got ${raw}`)
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: n } }
}
