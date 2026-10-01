import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { assert } from '@exodus/stasis-core/util'

import { JsonStreamParser } from './json-stream.js'

// Settles with `promise`, or rejects as soon as `signal` aborts (the call itself runs on; it has the signal).
const untilAborted = (promise, signal) => (signal === undefined ? promise : new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
}))

// Stands in for a streamed file's contents in the parsed tree; fromJSON's contents-free mode requires one per file.
const STREAMED = Symbol('streamed')

// Streaming reader for stasis.code.br: brotli and JSON are both decoded chunk by chunk, so neither
// the decompressed bytes nor the JSON text are ever held whole. Opt-in -- the built-in readers keep
// Bundle.parse(brotliDecompressSync(...)). `source` is a file path or file URL object, the compressed
// bytes (any ArrayBuffer or view), or an (async) iterable of compressed chunks such as a Readable.
// Bytes after the end of the brotli stream are ignored, as brotliDecompressSync ignores them.
//
// Without onFile, resolves to the same Bundle as Bundle.parse (the same validation, on an
// equivalent parse). With onFile, each file's stored contents (resource:base64 stays base64) go to
// `await onFile(file, contents, { signal })` -- keyed as `bundle.sources` keys them -- one at a time,
// in stream order, and are then dropped: it resolves to a contents-free Bundle (Bundle.fromJSON's
// `contents: false`) listing exactly the files onFile received. An abort rejects at once, even
// while onFile runs.
//
// onFile runs BEFORE the bundle as a whole is validated, so treat what it receives as provisional
// until the promise resolves; on a rejection, discard it. Each path has already passed fromJSON's canonical-key check
// (Bundle.fileKeyAt), and no file is delivered twice. It rejects a few bundles Bundle.parse
// accepts: those whose JSON carries file contents that parse would drop (a repeated key, a v0
// bundle's `modules`), a non-string content, or a `files` array.
export async function readBundle(source, { onFile, signal } = {}) {
  assert(onFile === undefined || typeof onFile === 'function', 'readBundle: onFile must be a function')
  let input = source
  if (typeof source === 'string' || source instanceof URL) input = createReadStream(source)
  else if (source instanceof ArrayBuffer) input = [new Uint8Array(source)]
  else if (ArrayBuffer.isView(source)) input = [new Uint8Array(source.buffer, source.byteOffset, source.byteLength)]

  const delivered = new Set()
  const pending = []
  const parser = new JsonStreamParser(onFile && {
    onString(contents, path) {
      const file = Bundle.fileKeyAt(path)
      if (file === undefined) return contents
      assert(!delivered.has(file), `bundle carries file '${file}' twice`)
      delivered.add(file)
      pending.push([file, contents])
      return STREAMED
    },
  })

  // Big output chunks and buffer let zlib's thread pool decompress ahead while the parser runs; with
  // zlib's defaults (16 KiB chunks) the two take turns and it runs about twice as long.
  const decompress = createBrotliDecompress({ chunkSize: 1024 * 1024, readableHighWaterMark: 4 * 1024 * 1024 })
  let drained = false
  await pipeline(input, decompress, async (chunks) => {
    for await (const chunk of chunks) {
      parser.write(chunk)
      for (const [file, contents] of pending.splice(0)) {
        // One chunk can queue many files: check before each, or an abort only lands after them all.
        signal?.throwIfAborted()
        // Sequential by design: stream order, and backpressure on the decompressor.
        // eslint-disable-next-line no-await-in-loop
        await untilAborted(onFile(file, contents, { signal }), signal)
      }
    }
    drained = true
  }, { signal }).catch((error) => {
    // Once drained, the stream is whole: pipeline reports bytes after it, unread, as an abort.
    if (!drained || signal?.aborted) throw error
  })

  const bundle = Bundle.fromJSON(parser.end(), { contents: !onFile })
  if (onFile) {
    // Every file was a placeholder, so onFile got each one; it must have got nothing else.
    let files = 0
    for (const [, info] of bundle.modules) files += Object.keys(info.files).length
    assert(delivered.size === files, 'bundle carries file contents outside its file list')
  }
  return bundle
}
