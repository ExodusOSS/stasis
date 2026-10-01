import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { JsonStreamParser } from '../stasis/src/json-stream.js'

// JsonStreamParser's contract is exact equivalence with JSON.parse(bytes.toString('utf8')), however
// the bytes are chunked: every case below is checked against JSON.parse differentially.

const encoder = new TextEncoder()
const toBytes = (input) => (typeof input === 'string' ? encoder.encode(input) : Uint8Array.from(input))

const streamParse = (bytes, sizes, options) => {
  const parser = new JsonStreamParser(options)
  for (let i = 0, k = 0; i < bytes.length; k += 1) {
    const size = sizes[k % sizes.length]
    parser.write(bytes.subarray(i, i + size))
    i += size
  }
  return parser.end()
}

const outcome = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

// Structural identity: prototypes, own-key ORDER, descriptors, and -0. Iterative, for deep input.
function sameJSON(left, right) {
  const pending = [[left, right]]
  while (pending.length > 0) {
    const [a, b] = pending.pop()
    if (typeof a !== typeof b) return false
    if (typeof a === 'number') {
      if (!Object.is(a, b)) return false
      continue
    }
    if (a === null || typeof a !== 'object') {
      if (a !== b) return false
      continue
    }
    if (b === null || Array.isArray(a) !== Array.isArray(b)) return false
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    const keysA = Reflect.ownKeys(a)
    const keysB = Reflect.ownKeys(b)
    if (keysA.length !== keysB.length) return false
    for (const [i, key] of keysA.entries()) {
      if (keysB[i] !== key) return false
      const da = Object.getOwnPropertyDescriptor(a, key)
      const db = Object.getOwnPropertyDescriptor(b, key)
      if (da.enumerable !== db.enumerable || da.writable !== db.writable || da.configurable !== db.configurable) return false
      pending.push([da.value, db.value])
    }
  }
  return true
}

const CHUNKINGS = [[Infinity], [1], [2], [3], [5, 1, 7], [64]]

const agrees = (expected, actual) =>
  expected.ok ? actual.ok && sameJSON(actual.value, expected.value) : !actual.ok && actual.error instanceof SyntaxError

// V8's JSON.parse (Node 24+) can mis-decode a short escaped object KEY once an earlier call cached a
// colliding one -- `{"a\\":1}` then `{"a\"":1}` yields the key `a\` -- so an oracle that has parsed
// earlier cases can be wrong. A disagreement is re-judged in a fresh process (a clean string table).
function agreesInFreshProcess(bytes, sizes) {
  const parserUrl = new URL('../stasis/src/json-stream.js', import.meta.url).href
  const code = `import { JsonStreamParser } from ${JSON.stringify(parserUrl)}
    const sameJSON = ${sameJSON}
    const outcome = ${outcome}
    const streamParse = ${streamParse}
    const agrees = ${agrees}
    const bytes = Buffer.from(${JSON.stringify(Buffer.from(bytes).toString('hex'))}, 'hex')
    const expected = outcome(() => JSON.parse(bytes.toString('utf8')))
    process.stdout.write(String(agrees(expected, outcome(() => streamParse(bytes, ${JSON.stringify(sizes)})))))`
  const { stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  if (stdout !== 'true' && stdout !== 'false') throw new Error(`fresh-process recheck failed: ${stderr}`)
  return stdout === 'true'
}

function assertMatchesJSONParse(t, input, chunkings = CHUNKINGS) {
  const bytes = toBytes(input)
  const expected = outcome(() => JSON.parse(Buffer.from(bytes).toString('utf8')))
  for (const sizes of chunkings) {
    const actual = outcome(() => streamParse(bytes, sizes))
    if (agrees(expected, actual) || agreesInFreshProcess(bytes, sizes)) continue
    const label = `${JSON.stringify(Buffer.from(bytes).toString('latin1'))} in chunks of ${sizes}`
    t.assert.equal(actual.ok, expected.ok, `verdict for ${label}${actual.ok ? '' : `: ${actual.error.message}`}`)
    t.assert.fail(`value for ${label}`)
  }
}

const CASES = [
  // scalars and whitespace
  '0', '-0', '1', '-1', '1.5', '1e5', '1E+5', '1e-5', '-0.0e-0', '1e400', '-1e400', '5e-324', '123456789012345678901234567890',
  '01', '-', '+1', '.5', '1.', '1e', '1e+', '--1', '0x10', 'NaN', 'Infinity', '1_000',
  'true', 'false', 'null', 'tru', 'nul', 'nulll', 'True', 'undefined',
  ' \t\n\r 1 \t\n\r ', ' 1', '1 ', '\f1', '', ' ', '1 2', '[] []', '{}x',
  // strings and escapes
  '""', '"a"', '"\\""', '"\\\\"', '"\\/"', '"\\b\\f\\n\\r\\t"', '"\\u0041"', '"\\u00e9"', '"\\uD83D\\uDE00"',
  '"\\ud800"', '"\\udc00x"', '"\\u12"', '"\\u12g4"', '"\\x41"', '"\\\'"', '"\\', '"abc', '"a\\"', '"\\\\\\""',
  '"é😀  "', '"﻿BOM inside a string"', '﻿"a leading BOM"', '"\u007f"',
  '"a\nb"', '"\t"', '"\u0000"', '"\u001f"', '"\\\n"',
  // containers
  '[]', '{}', '[1,2,3]', '[1,]', '[,1]', '[1 2]', '[[[]]]', '[', ']', '[1', '{"a":1', '{"a"}', '{"a":}', '{a:1}',
  "{'a':1}", '{"a":1,}', '{,"a":1}', '{"a" 1}', '{"a"::1}', '{"a":1 "b":2}', '[1]]', '{"a":1}}', '[}', '{]',
  '{"a":[1,{"b":null}],"c":{"d":[true,false]}}', ' [ 1 , { "a" : "b" } ] ',
  // object key semantics
  '{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"b":1,"a":2,"1":3,"0":4,"-1":5,"01":6,"4294967295":7,"4294967294":8}',
  '{"__proto__":1}', '{"__proto__":{"polluted":true}}', '{"__proto__":1,"__proto__":2}', '{"a":{"__proto__":[]}}',
  '{"constructor":1,"toString":2,"hasOwnProperty":3,"valueOf":{}}', '{"":1,"":2}', '{"\\u0061":1,"a":2}',
]

test('JsonStreamParser matches JSON.parse on edge cases, at every chunking', (t) => {
  for (const input of CASES) assertMatchesJSONParse(t, input)
})

test('JsonStreamParser matches JSON.parse on invalid UTF-8 and BOM bytes', (t) => {
  const q = 0x22
  for (const bytes of [
    [q, 0xff, q], [q, 0xc3, q], [q, 0xc3, 0xa9, q], [q, 0xe2, 0x82, q], [q, 0xed, 0xa0, 0x80, q],
    [q, 0xf0, 0x9f, 0x98, q], [q, 0xf4, 0x90, 0x80, 0x80, q], [q, 0xc0, 0x80, q], [q, 0x80, 0xbf, q],
    [q, 0x5c, 0xc3, 0xa9, q], [q, 0x5c, 0x6e, 0xff, q], [q, 0xe2, q, 0x82, q],
    [0xef, 0xbb, 0xbf, 0x31], [0xff, 0x31], [0x31, 0xff], [0x5b, 0xc3, 0x5d],
    [q, 0xef, 0xbb, 0xbf, 0x41, q], [0x7b, q, 0xff, q, 0x3a, 0x31, 0x7d],
  ]) {
    assertMatchesJSONParse(t, bytes)
  }
})

test('JsonStreamParser handles long and deeply nested input', (t) => {
  const big = 'x'.repeat(300_000)
  assertMatchesJSONParse(t, JSON.stringify({ big, escaped: `${big}\n"\\${big}`, emoji: '😀'.repeat(50_000) }),
    [[Infinity], [4096], [16_384, 1]])
  const depth = 20_000
  assertMatchesJSONParse(t, `${'['.repeat(depth)}${']'.repeat(depth)}`, [[Infinity], [7]])
  assertMatchesJSONParse(t, `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`, [[Infinity], [7]])
  assertMatchesJSONParse(t, `${'['.repeat(depth)}${']'.repeat(depth - 1)}`, [[Infinity]])
})

// --- seeded fuzz --------------------------------------------------------------

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d_2b_79_f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296
}

function makeGenerator(random) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const ws = () => pick(['', '', '', ' ', '\n', '\t', '\r\n', '  '])
  const STRING_PIECES = ['a', 'Z', ' ', 'é', '😀', ' ', '﻿', '\u007f', '\\n', '\\"', '\\\\', '\\/', '\\b', '\\t', '\\u0000', '\\u001f', '\\ud800', '\\udfff', '\\uD83D\\uDE00', '\\u00e9']
  const string = () => {
    let s = '"'
    for (let n = Math.floor(random() * 6); n > 0; n -= 1) s += pick(STRING_PIECES)
    return `${s}"`
  }
  const KEYS = ['"a"', '"b"', '"__proto__"', '"0"', '"1"', '"10"', '"-1"', '"constructor"', '""', '"é"', '"\\u0061"']
  const NUMBERS = ['0', '-0', '1', '-12', '3.25', '1e3', '2E-2', '-0.5e+1', '1e400', '12345678901234567890', '5e-324']
  const value = (depth) => {
    const r = random()
    if (r < 0.1) return pick(['true', 'false', 'null'])
    if (r < 0.3) return pick(NUMBERS)
    if (r < 0.55 || depth > 4) return string()
    const count = Math.floor(random() * 4)
    const items = []
    if (r < 0.75) {
      for (let i = 0; i < count; i += 1) items.push(`${ws()}${value(depth + 1)}${ws()}`)
      return `[${items.join(',')}]`
    }
    for (let i = 0; i < count; i += 1) {
      items.push(`${ws()}${random() < 0.7 ? pick(KEYS) : string()}${ws()}:${ws()}${value(depth + 1)}${ws()}`)
    }
    return `{${items.join(',')}}`
  }
  const MUTATION_BYTES = [0x00, 0x0a, 0x22, 0x5c, 0x2c, 0x3a, 0x5b, 0x5d, 0x7b, 0x7d, 0x30, 0x2d, 0x65, 0x80, 0xc3, 0xe2, 0xff]
  const mutate = (bytes) => {
    const out = [...bytes]
    for (let n = 1 + Math.floor(random() * 2); n > 0; n -= 1) {
      const at = Math.floor(random() * (out.length + 1))
      const op = random()
      if (op < 0.4) out[at] = pick(MUTATION_BYTES)
      else if (op < 0.7) out.splice(at, 1)
      else if (op < 0.9) out.splice(at, 0, pick(MUTATION_BYTES))
      else out.length = at
    }
    return out.filter((b) => b !== undefined)
  }
  return { text: () => `${ws()}${value(0)}${ws()}`, mutate }
}

test('JsonStreamParser matches JSON.parse on generated and mutated input (seeded fuzz)', (t) => {
  const random = mulberry32(0x5_7a_51_5)
  const { text, mutate } = makeGenerator(random)
  for (let i = 0; i < 2500; i += 1) {
    const bytes = encoder.encode(text())
    const sizes = [1 + Math.floor(random() * 9), 1 + Math.floor(random() * 3)]
    assertMatchesJSONParse(t, bytes, [[Infinity], sizes])
    assertMatchesJSONParse(t, mutate(bytes), [[Infinity], sizes])
  }
})

test('JsonStreamParser decodes escaped keys correctly whatever JSON.parse has cached', (t) => {
  // The V8 key-cache case above: JSON.parse may answer `a\` for the second key after seeing the first.
  // The parser decodes a key as a lone string, which that cache never serves.
  JSON.parse(String.raw`{"a\\":1}`)
  const second = encoder.encode(String.raw`{"a\"":1}`)
  t.assert.deepStrictEqual(Object.keys(streamParse(second, [Infinity])), ['a"'])
  t.assert.deepStrictEqual(Object.keys(streamParse(encoder.encode(String.raw`{"a\\":1,"a\"":2}`), [1])), ['a\\', 'a"'])
  // And the fresh-process recheck the differential tests fall back on agrees with the parser.
  t.assert.equal(agreesInFreshProcess(second, [2]), true)
})

// --- API behavior -------------------------------------------------------------

test('JsonStreamParser copies what it keeps, so a written chunk may be reused', (t) => {
  const parser = new JsonStreamParser()
  const text = '{"key":"a string that straddles chunks","n":12345'
  const buffer = new Uint8Array(4)
  for (let i = 0; i < text.length; i += buffer.length) {
    const piece = encoder.encode(text.slice(i, i + buffer.length))
    buffer.fill(0x21)
    buffer.set(piece)
    parser.write(buffer.subarray(0, piece.length))
  }
  buffer.fill(0x21)
  parser.write(encoder.encode('}'))
  t.assert.deepStrictEqual(parser.end(), JSON.parse(`${text}}`))
})

test('JsonStreamParser copies what it keeps from Buffer chunks too (Buffer#slice is only a view)', (t) => {
  const parser = new JsonStreamParser()
  const chunk = Buffer.from('["abc')
  parser.write(chunk)
  chunk.fill('z')
  parser.write(Buffer.from('"]'))
  t.assert.deepStrictEqual(parser.end(), ['abc'])
})

test('JsonStreamParser takes any ArrayBuffer view, and refuses other chunks without failing', (t) => {
  const parser = new JsonStreamParser()
  parser.write(encoder.encode('[1,'))
  t.assert.throws(() => parser.write(encoder.encode('2,').buffer), TypeError)
  t.assert.throws(() => parser.write('2,'), TypeError)
  const bytes = encoder.encode('2,3]')
  parser.write(new DataView(bytes.buffer, bytes.byteOffset, 2))
  parser.write(bytes.subarray(2))
  t.assert.deepStrictEqual(parser.end(), [1, 2, 3])
})

test('JsonStreamParser onString swaps each string value (never a key) and sees its path', (t) => {
  const seen = []
  const value = streamParse(encoder.encode('{"a":"x","b":["y",{"c":"z"}],"d":1}'), [3], {
    onString: (s, path) => {
      seen.push([s, [...path]])
      return s.toUpperCase()
    },
  })
  t.assert.deepStrictEqual(seen, [['x', ['a']], ['y', ['b', 0]], ['z', ['b', 1, 'c']]])
  t.assert.deepStrictEqual(value, { a: 'X', b: ['Y', { c: 'Z' }], d: 1 })
  t.assert.deepStrictEqual(streamParse(encoder.encode('"top"'), [1], { onString: (s, path) => `${s}:${path.length}` }), 'top:0')
})

test('JsonStreamParser refuses use after end or after a failure', (t) => {
  const done = new JsonStreamParser()
  done.write(encoder.encode('1'))
  t.assert.equal(done.end(), 1)
  t.assert.throws(() => done.write(encoder.encode(' ')), /after end/)
  t.assert.throws(() => done.end(), /after end/)

  const failed = new JsonStreamParser()
  t.assert.throws(() => failed.write(encoder.encode('[1,]')), SyntaxError)
  t.assert.throws(() => failed.write(encoder.encode('2]')), /after end or failure/)
  t.assert.throws(() => failed.end(), /after end or failure/)
})

test('JsonStreamParser reports the byte offset of an error', (t) => {
  const parser = new JsonStreamParser()
  parser.write(encoder.encode('[1, 2'))
  t.assert.throws(() => parser.write(encoder.encode(', x]')), /at byte 7/)
})
