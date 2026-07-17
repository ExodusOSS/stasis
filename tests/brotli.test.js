import { test } from 'node:test'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'

import { brotliOptions } from '@exodus/stasis-core/brotli'

// Save/restore EXODUS_STASIS_BROTLI_QUALITY across tests so env-driven tests don't leak.
const withEnv = (value, fn) => (t) => {
  const saved = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (value === undefined) delete process.env.EXODUS_STASIS_BROTLI_QUALITY
  else process.env.EXODUS_STASIS_BROTLI_QUALITY = value
  try {
    return fn(t)
  } finally {
    if (saved === undefined) delete process.env.EXODUS_STASIS_BROTLI_QUALITY
    else process.env.EXODUS_STASIS_BROTLI_QUALITY = saved
  }
}

const QUALITY = zlibConstants.BROTLI_PARAM_QUALITY

test('brotliOptions() with no env and no quality is undefined (brotli default)', withEnv(undefined, (t) => {
  t.assert.equal(brotliOptions(), undefined)
}))

test('brotliOptions(quality) returns the quality param', withEnv(undefined, (t) => {
  t.assert.deepEqual(brotliOptions(5), { params: { [QUALITY]: 5 } })
}))

test('brotliOptions accepts the range edges 0 and 11', withEnv(undefined, (t) => {
  // 0 is valid AND falsy -- pins that no truthiness shortcut drops it.
  t.assert.deepEqual(brotliOptions(0), { params: { [QUALITY]: 0 } })
  t.assert.deepEqual(brotliOptions(11), { params: { [QUALITY]: 11 } })
}))

test('brotliOptions rejects out-of-range or non-integer quality', withEnv(undefined, (t) => {
  for (const bad of [-1, 12, 5.5, '5', true, null, Number.NaN]) {
    t.assert.throws(() => brotliOptions(bad), /brotli quality must be an integer 0\.\.11/)
  }
}))

test('brotliOptions falls back to EXODUS_STASIS_BROTLI_QUALITY', withEnv('3', (t) => {
  t.assert.deepEqual(brotliOptions(), { params: { [QUALITY]: 3 } })
}))

test('brotliOptions env "" is unset; an explicit quality still applies', withEnv('', (t) => {
  t.assert.equal(brotliOptions(), undefined)
  t.assert.deepEqual(brotliOptions(2), { params: { [QUALITY]: 2 } })
}))

test('brotliOptions rejects an invalid env value', withEnv('max', (t) => {
  t.assert.throws(() => brotliOptions(), /EXODUS_STASIS_BROTLI_QUALITY must be an integer 0\.\.11/)
}))

// Non-canonical Number()-coercible strings must throw (Number('   ') is 0!), not silently
// select a quality: `${Number(raw)}` has to round-trip back to the input.
for (const bad of ['5.0', '05', '   ', ' 5 ', '0x5', '5e0', '+5']) {
  test(`brotliOptions rejects non-canonical env value ('${bad}')`, withEnv(bad, (t) => {
    t.assert.throws(() => brotliOptions(), /EXODUS_STASIS_BROTLI_QUALITY must be an integer 0\.\.11/)
  }))
}

test('brotliOptions env agreeing with an explicit quality is accepted', withEnv('4', (t) => {
  t.assert.deepEqual(brotliOptions(4), { params: { [QUALITY]: 4 } })
}))

test('brotliOptions env conflicting with an explicit quality throws', withEnv('4', (t) => {
  t.assert.throws(() => brotliOptions(5), /brotli quality 5 conflicts with EXODUS_STASIS_BROTLI_QUALITY=4/)
}))

test('any quality still produces a valid .br that round-trips', withEnv(undefined, (t) => {
  // The option must only change the encoding effort, never the decoded content.
  const text = JSON.stringify({ files: Array.from({ length: 64 }, (_, i) => `src/module-${i}.js`) })
  for (const quality of [0, 1, 5, 11]) {
    const data = brotliCompressSync(text, brotliOptions(quality))
    t.assert.equal(brotliDecompressSync(data).toString('utf-8'), text, `quality ${quality} round-trips`)
  }
}))
