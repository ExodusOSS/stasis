import { Buffer } from 'node:buffer'
import { brotliCompressSync, brotliDecompressSync, createBrotliDecompress, constants as zlibConstants } from 'node:zlib'

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
// for this, and that code already imports from here.
export function brotliOptions() {
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (!raw) return undefined
  const n = Number(raw)
  assert(Number.isInteger(n) && n >= 0 && n <= 11, `EXODUS_STASIS_BROTLI_QUALITY must be an integer 0..11, got ${raw}`)
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: n } }
}

// Compress a bundle payload. Synchronous: the write path (`state.js` #emitBundle,
// `stasis bundle`) is sync, and brotli at quality 11 is CPU-bound anyway.
export function compress(data) {
  return brotliCompressSync(data, brotliOptions())
}

// Strict, async decompression. Rejects ANY trailing bytes after the end of the
// brotli stream with ERR_TRAILING_JUNK_AFTER_STREAM_END -- mirroring the `brotli`
// CLI's "corrupt input" and matching the WHATWG Compression Streams spec. The
// one-shot `brotliDecompressSync` silently ignores trailing garbage and exposes
// no consumed-byte count, so this enforcement is only reachable via the streaming
// decoder (`rejectGarbageAfterEnd`), which is why bundle reads are async. The
// check is free: the decoder already locates the stream end while decoding.
export function decompress(buffer) {
  return new Promise((resolve, reject) => {
    const engine = createBrotliDecompress({ rejectGarbageAfterEnd: true })
    const chunks = []
    engine.on('data', (chunk) => chunks.push(chunk))
    engine.on('end', () => resolve(Buffer.concat(chunks)))
    engine.on('error', reject)
    engine.end(buffer)
  })
}

// Lenient, synchronous decompression for callers that can't be async (offline
// CLI tooling, tests). Trailing bytes after the stream end are silently ignored
// -- the sync zlib API cannot reject them. Prefer `decompress` on any path that
// can await it.
export function decompressSync(buffer) {
  return brotliDecompressSync(buffer)
}
