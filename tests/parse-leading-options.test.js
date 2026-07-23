import { test } from 'node:test'

import { parseLeadingOptions } from '@exodus/stasis-core/util'

// onError is usage() in the bins (it exits); throw a sentinel so tests catch the call and halt.
const throwingOnError = (msg) => {
  throw new Error(`ONERROR:${msg}`)
}

test('splits the leading options off argv and leaves the positionals behind', (t) => {
  const argv = ['--output', 'dir', 'bundle.br']
  const values = parseLeadingOptions(argv, { output: { type: 'string', short: 'o' } }, {
    valueFlags: ['--output', '-o'],
    onError: throwingOnError,
  })
  t.assert.deepEqual(values, { output: 'dir' })
  t.assert.deepEqual(argv, ['bundle.br'], 'argv is mutated in place to hold only the positionals')
})

test('consumes a separate-token value for a short value flag', (t) => {
  const argv = ['-o', 'dir', 'bundle.br']
  const values = parseLeadingOptions(argv, { output: { type: 'string', short: 'o' } }, {
    valueFlags: ['--output', '-o'],
    onError: throwingOnError,
  })
  t.assert.equal(values.output, 'dir')
  t.assert.deepEqual(argv, ['bundle.br'])
})

test('accepts the =-form for a long option', (t) => {
  const argv = ['--output=dir', 'bundle.br']
  const values = parseLeadingOptions(argv, { output: { type: 'string', short: 'o' } }, {
    valueFlags: ['--output', '-o'],
    onError: throwingOnError,
  })
  t.assert.equal(values.output, 'dir')
  t.assert.deepEqual(argv, ['bundle.br'])
})

test('stops at the first positional so a forwarded child argv survives verbatim (run semantics)', (t) => {
  const argv = ['--lock', 'add', 'app.js', '--app-flag', '-x']
  const values = parseLeadingOptions(argv, { lock: { type: 'string', default: 'none' } }, {
    valueFlags: ['--lock'],
    onError: throwingOnError,
  })
  t.assert.equal(values.lock, 'add')
  t.assert.deepEqual(argv, ['app.js', '--app-flag', '-x'], 'nothing after the first positional is consumed')
})

test('honors option defaults when the flag is absent', (t) => {
  const argv = ['file.js']
  const values = parseLeadingOptions(argv, { lock: { type: 'string', default: 'none' } }, {
    onError: throwingOnError,
  })
  t.assert.equal(values.lock, 'none')
  t.assert.deepEqual(argv, ['file.js'])
})

test('works with no valueFlags (a boolean-only command like diff)', (t) => {
  const argv = ['--stat', '--imports', 'a.json', 'b.json']
  const values = parseLeadingOptions(argv, { stat: { type: 'boolean' }, imports: { type: 'boolean' } }, {
    onError: throwingOnError,
  })
  t.assert.deepEqual(values, { stat: true, imports: true })
  t.assert.deepEqual(argv, ['a.json', 'b.json'])
})

test('empty argv yields empty values and leaves argv empty', (t) => {
  const argv = []
  const values = parseLeadingOptions(argv, { output: { type: 'string' } }, { onError: throwingOnError })
  t.assert.deepEqual(argv, [])
  t.assert.ok(!('output' in values))
})

test('routes an unknown-option parse error to onError with an "Error:" prefix', (t) => {
  const argv = ['--nope', 'file']
  t.assert.throws(
    () => parseLeadingOptions(argv, { known: { type: 'boolean' } }, { onError: throwingOnError }),
    /ONERROR:Error: /,
  )
})

test('routes a missing value-flag argument to onError', (t) => {
  const argv = ['-o']
  t.assert.throws(
    () => parseLeadingOptions(argv, { output: { type: 'string', short: 'o' } }, {
      valueFlags: ['--output', '-o'],
      onError: throwingOnError,
    }),
    /ONERROR:Error: /,
  )
})
