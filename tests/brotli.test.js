// brotli helpers + State.create()'s strict (async) bundle reads.
//
// The point of moving bundle decompression to the async streaming decoder is that it can
// REJECT trailing bytes after the brotli stream (ERR_TRAILING_JUNK_AFTER_STREAM_END),
// which the one-shot sync API silently ignores. State.create() (the four runtime bundle
// readers: `stasis run` + the webpack/esbuild/metro plugins) uses it; the synchronous
// `new State()` (offline tooling, tests) stays lenient.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compress, decompress, decompressSync } from '@exodus/stasis-core/brotli'
import { State } from '@exodus/stasis-core/state'

test('compress + decompress round-trips', async (t) => {
  const payload = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }))
  const out = await decompress(compress(payload))
  t.assert.ok(out.equals(payload))
})

test('decompress (async) rejects trailing garbage after the stream end', async (t) => {
  const comp = compress(Buffer.from('hello'))
  await t.assert.rejects(
    decompress(Buffer.concat([comp, Buffer.from('GARBAGE')])),
    (err) => err.code === 'ERR_TRAILING_JUNK_AFTER_STREAM_END'
  )
})

test('decompressSync (sync) is lenient: trailing garbage is ignored', (t) => {
  const comp = compress(Buffer.from('hello'))
  const out = decompressSync(Buffer.concat([comp, Buffer.from('GARBAGE')]))
  t.assert.equal(out.toString('utf-8'), 'hello')
})

test('decompress rejects a truncated stream', async (t) => {
  const comp = compress(Buffer.from('hello world, a slightly longer payload'))
  await t.assert.rejects(decompress(comp.subarray(0, comp.length - 3)))
})

const project = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-brotli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }))
  writeFileSync(join(dir, 'runner.cjs'), 'module.exports = 1\n')
  const cap = new State(dir, { scope: 'full', bundle: 'add' })
  cap.addFile(pathToFileURL(join(dir, 'runner.cjs')).toString(), { format: 'commonjs', isEntry: true })
  const brPath = join(dir, 'stasis.code.br')
  writeFileSync(brPath, compress(cap.sourceData))
  return { dir, brPath }
}

test('State.create() loads a bundle and rejects one with trailing garbage', async (t) => {
  const { dir, brPath } = project(t)

  const loaded = await State.create(dir, { scope: 'full', bundle: 'frozen' })
  t.assert.ok(loaded.sources.size > 0, 'bundle loaded')

  appendFileSync(brPath, Buffer.from('GARBAGE-AFTER-STREAM'))
  await t.assert.rejects(
    State.create(dir, { scope: 'full', bundle: 'frozen' }),
    (err) => err.code === 'ERR_TRAILING_JUNK_AFTER_STREAM_END'
  )
})

test('new State() (sync) stays lenient about trailing garbage', (t) => {
  const { dir, brPath } = project(t)
  appendFileSync(brPath, Buffer.from('GARBAGE-AFTER-STREAM'))
  t.assert.doesNotThrow(() => new State(dir, { scope: 'full', bundle: 'frozen' }))
})
