import { toHex } from '@exodus/bytes/hex.js'
import { test } from 'node:test'

test('toHex', (t) => {
  t.assert.equal(toHex(Uint8Array.of(0, 1, 2)), '000102')
})
