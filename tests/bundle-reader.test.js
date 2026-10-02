import { test } from 'node:test'
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { readBundle } from '@exodus/stasis/bundle-reader'
import { collectComponents } from '../stasis/src/sbom.js'

/* eslint-disable no-await-in-loop -- tests walk small tables of sources and malformed bundles one
   at a time, so a failure names the case (and one-shot sources like a Readable aren't raced). */

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-bundle-reader-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Enough of everything a bundle carries: both bucket kinds, a base64 resource, a BOM, non-ASCII,
// escapes, a platform import map, an executable, a reason map -- and a large file plus many small
// ones, so files straddle the decompressor's output chunks.
function sampleBundle() {
  const big = `${'export const line = "quoted \\\\ text"\n'.repeat(12_000)}😀\n`
  const files = {
    'src/index.js': 'import dep from "dep"\nimport "./platform"\n',
    'src/bom.js': '\ufeffexport const s = "é😀\u2028"\n',
    'src/big.js': big,
    'assets/logo.png': Buffer.from([0, 1, 2, 250, 251, 252, 0x22, 0x5c]).toString('base64'),
    'bin/run.sh': '#!/bin/sh\necho "hi"\n',
  }
  const formats = [
    ['src/index.js', 'module'], ['src/bom.js', 'module'], ['src/big.js', 'module'],
    ['assets/logo.png', 'resource:base64'], ['bin/run.sh', 'shell'],
  ]
  for (let i = 0; i < 150; i += 1) {
    files[`src/small/${i}.js`] = `export default ${i}\n`
    formats.push([`src/small/${i}.js`, 'module'])
  }
  formats.push(['node_modules/dep/index.js', 'commonjs'], ['node_modules/dep/package.json', 'json'])
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/index.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files }],
      ['node_modules/dep', {
        name: 'dep', version: '2.0.0', ecosystem: 'npm',
        files: { 'index.js': 'module.exports = "\\u0000"\n', 'package.json': '{"name":"dep","version":"2.0.0"}' },
      }],
    ]),
    formats: new Map(formats),
    imports: new Map([['*', new Map([['src/index.js', new Map([
      ['dep', 'node_modules/dep/index.js'],
      ['./platform', new Map([['ios', 'src/bom.js'], ['android', 'src/big.js']])],
    ])]])]]),
    executable: new Set(['bin/run.sh']),
    reason: { run: ['src/index.js', 'node_modules/dep/index.js'] },
  })
}

// Low quality: these tests exercise decoding, and quality 11 is slow on the megabyte inputs.
const compressed = (data) => brotliCompressSync(
  typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data),
  { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
// The built-in (non-streaming) read, as the reference.
const parseWhole = (buf) => Bundle.parse(brotliDecompressSync(buf).toString('utf8'))

async function* chunked(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

const collect = () => {
  const files = []
  const formats = new Map()
  return {
    files,
    formats,
    onFile(file, contents, { format }) {
      files.push([file, contents])
      formats.set(file, format)
    },
  }
}

const minimal = (sourceFiles, extra = {}) => ({
  version: 1, config: { scope: 'full' }, entries: [],
  sources: { '.': { name: 'app', version: '1.0.0', files: sourceFiles } },
  formats: {}, imports: {}, ...extra,
})

test('readBundle streams any source into the same Bundle as Bundle.parse', withTmp(async (t, tmp) => {
  const buf = compressed(sampleBundle().serialize())
  const file = join(tmp, 'stasis.code.br')
  writeFileSync(file, buf)
  const whole = parseWhole(buf)
  for (const [label, source] of [
    ['path', file],
    ['file URL', pathToFileURL(file)],
    ['bytes', new Uint8Array(buf)],
    ['ArrayBuffer', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)],
    ['DataView', new DataView(buf.buffer, buf.byteOffset, buf.length)],
    ['7-byte chunks', chunked(buf, 7)],
    ['Readable', createReadStream(file, { highWaterMark: 1024 })],
  ]) {
    const streamed = await readBundle(source)
    t.assert.equal(streamed.serialize(), whole.serialize(), label)
    t.assert.deepStrictEqual(streamed.sources, whole.sources, label)
    t.assert.equal(Object.getPrototypeOf(streamed.modules.get('.').files), null, label)
  }
}))

test('readBundle reads a legacy v0 bundle as Bundle.parse does', async (t) => {
  const buf = compressed({
    version: 0, config: { scope: 'full' }, formats: {}, imports: {},
    sources: { 'src/a.js': 'A', 'node_modules/x/index.js': 'X', 'node_modules/@s/y/lib/z.js': 'Z' },
  })
  const whole = parseWhole(buf)
  const streamed = await readBundle(buf)
  t.assert.equal(streamed.version, 0)
  t.assert.deepStrictEqual([...streamed.modules], [...whole.modules])

  const { files, onFile } = collect()
  const contentsFree = await readBundle(buf, { onFile })
  t.assert.deepStrictEqual(new Map(files), whole.sources)
  t.assert.deepStrictEqual([...contentsFree.modules.keys()], [...whole.modules.keys()])
})

test('readBundle with onFile hands over every file in stream order and returns a contents-free Bundle', async (t) => {
  const buf = compressed(sampleBundle().serialize())
  const whole = parseWhole(buf)
  const { files, onFile } = collect()
  const bundle = await readBundle(chunked(buf, 1000), { onFile })

  // Exactly the files, each once, with the stored contents (resource:base64 stays base64)...
  t.assert.deepStrictEqual(new Map(files), whole.sources)
  t.assert.equal(files.length, whole.sources.size)
  // ...in the order the JSON carries them (sources before modules, as serialize writes them).
  const json = JSON.parse(brotliDecompressSync(buf).toString('utf8'))
  const jsonOrder = [
    ...Object.keys(json.sources['.'].files),
    ...Object.keys(json.modules['node_modules/dep'].files).map((rel) => `node_modules/dep/${rel}`),
  ]
  t.assert.deepStrictEqual(files.map(([file]) => file), jsonOrder)

  // Every other field is intact, and every bucket still lists its files.
  t.assert.throws(() => bundle.sources, /file contents are not retained/)
  for (const field of ['version', 'config', 'entries', 'formats', 'imports', 'executable', 'reason']) {
    t.assert.deepStrictEqual(bundle[field], whole[field], field)
  }
  t.assert.equal(bundle.hasCode, whole.hasCode)
  t.assert.deepStrictEqual([...bundle.modules.keys()], [...whole.modules.keys()])
  for (const [dir, info] of bundle.modules) {
    const { files: wholeFiles, ...wholeInfo } = whole.modules.get(dir)
    const { files: lockedFiles, ...lockedInfo } = info
    t.assert.deepStrictEqual(lockedInfo, wholeInfo)
    t.assert.deepStrictEqual(Object.keys(lockedFiles), Object.keys(wholeFiles))
    t.assert.equal(Object.getPrototypeOf(lockedFiles), null)
    t.assert.ok(Object.isFrozen(lockedFiles))
  }
  // Enough for a metadata-only consumer: the SBOM components are the full Bundle's.
  t.assert.deepStrictEqual(collectComponents([bundle]), collectComponents([whole]))
})

test('readBundle streams files wherever the bundle puts them: after the metadata (newer bundles) or before it', async (t) => {
  const { sources, modules, ...meta } = JSON.parse(sampleBundle().serialize())
  const orders = {
    'files last': { ...meta, sources, modules },
    'files first': { version: meta.version, config: meta.config, sources, modules, ...meta },
  }
  t.assert.notDeepStrictEqual(Object.keys(orders['files last']), Object.keys(orders['files first']))
  for (const [label, json] of Object.entries(orders)) {
    const buf = compressed(json)
    const whole = parseWhole(buf)
    t.assert.equal((await readBundle(chunked(buf, 1000))).serialize(), whole.serialize(), label)
    const { files, formats, onFile } = collect()
    const bundle = await readBundle(chunked(buf, 1000), { onFile })
    t.assert.deepStrictEqual(new Map(files), whole.sources, label)
    for (const field of ['formats', 'imports', 'executable', 'reason']) t.assert.deepStrictEqual(bundle[field], whole[field], `${label}: ${field}`)
    // A file's format is known only once `formats` has streamed by.
    const known = label === 'files last'
    for (const file of whole.sources.keys()) t.assert.equal(formats.get(file), known ? whole.formats.get(file) : undefined, `${label}: ${file}`)
  }
})

test('readBundle with onFile rejects a bundle whose final formats disagree with one it passed', async (t) => {
  // JSON keeps the last of a repeated key, so a second `formats` after the files replaces the one onFile saw.
  const files = String.raw`"sources":{".":{"name":"app","version":"1","files":{"a.js":"A"}}}`
  const head = String.raw`"version":1,"config":{"scope":"full"},"entries":[],"imports":{}`
  const buf = compressed(`{${head},"formats":{"a.js":"module"},${files},"formats":{"a.js":"commonjs"}}`)
  t.assert.equal(parseWhole(buf).formats.get('a.js'), 'commonjs')
  t.assert.equal((await readBundle(buf)).formats.get('a.js'), 'commonjs')
  const seen = collect()
  await t.assert.rejects(readBundle(buf, seen), /bundle file 'a\.js' changed format after onFile got it/)
  t.assert.deepStrictEqual([...seen.formats], [['a.js', 'module']])

  // The root listing's format may be keyed '' (older writers) as well as '.'.
  const listing = collect()
  await readBundle(compressed(`{${head},"formats":{"":"directory"},"sources":{".":{"name":"app","version":"1","files":{"":"[]"}}}}`), listing)
  t.assert.deepStrictEqual([...listing.formats], [['.', 'directory']])
})

test('readBundle awaits onFile one file at a time, and stops on its failure', async (t) => {
  const buf = compressed(sampleBundle().serialize())
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  await readBundle(buf, {
    onFile: async () => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      inFlight -= 1
    },
  })
  t.assert.equal(maxInFlight, 1)
  t.assert.equal(calls, parseWhole(buf).sources.size)

  let seen = 0
  await t.assert.rejects(readBundle(chunked(buf, 512), {
    onFile: () => {
      seen += 1
      if (seen === 3) throw new Error('disk full')
    },
  }), /disk full/)
  t.assert.equal(seen, 3)
})

test('readBundle rejects what Bundle.parse rejects, with the same error', async (t) => {
  const cases = {
    'unknown format': minimal({ 'a.js': 'A' }, { formats: { 'a.js': 'bogus' } }),
    'escaping file path': minimal({ '../evil.js': 'x' }),
    'escaping bucket dir': minimal({}, { sources: { '..': { name: 'app', version: '1', files: { 'a.js': 'A' } } } }),
    'bad version': { ...minimal({ 'a.js': 'A' }), version: 7 },
    'duplicate flat key across buckets': minimal({}, {
      sources: {
        '.': { name: 'app', version: '1', files: { 'pkg/a.js': 'one' } },
        pkg: { name: 'pkg', version: '1', files: { 'a.js': 'two' } },
      },
    }),
  }
  for (const [label, json] of Object.entries(cases)) {
    const buf = compressed(json)
    let expected
    t.assert.throws(() => parseWhole(buf), (error) => (expected = error) !== undefined, label)
    await t.assert.rejects(readBundle(buf), { name: expected.name, message: expected.message }, label)
    await t.assert.rejects(readBundle(buf, { onFile() {} }), label)
  }
})

test('readBundle with onFile never hands over an escaping path or a second payload for a file', async (t) => {
  // Files are handed over after each decompressed chunk is parsed, so a rejection can also withhold
  // earlier files of the same chunk -- 1-byte chunks make every earlier file go out first.
  const escaping = collect()
  const bad = compressed(minimal({ 'ok.js': 'fine', '../evil.js': 'x' }))
  await t.assert.rejects(readBundle(chunked(bad, 1), escaping), /non-canonical file key/)
  await t.assert.rejects(readBundle(bad, { onFile() {} }), /non-canonical file key/)
  t.assert.ok(escaping.files.every(([file]) => file !== '../evil.js'))

  // v0: the flat path stays inside the root, but the bucket split fromJSON infers from it (at the
  // node_modules segment) escapes -- so it must be rejected before it reaches onFile, too.
  const v0 = compressed({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { 'a/node_modules/x/../../../b': 'B' } })
  t.assert.throws(() => parseWhole(v0))
  // A file named '.' is a second spelling of the root key; only the root listing ('') may take it.
  await t.assert.rejects(readBundle(compressed(minimal({ '.': 'root' })), collect()), /non-canonical file key "\."/)
  const v0Files = collect()
  await t.assert.rejects(readBundle(v0, v0Files), /non-canonical file key "a\/node_modules\/x\/\.\.\/\.\.\/\.\.\/b"/)
  t.assert.deepStrictEqual(v0Files.files, [])

  // An empty bucket dir joins with any rel into an absolute key: Bundle.parse rejects it, and so
  // does the reader before onFile sees it.
  const absolute = compressed(minimal({}, { sources: { '': { name: 'x', version: '1', files: { 'etc/passwd': 'hi' } } } }))
  t.assert.throws(() => parseWhole(absolute), /non-canonical file key "\/etc\/passwd"/)
  await t.assert.rejects(readBundle(absolute), /non-canonical file key "\/etc\/passwd"/)
  const absoluteFiles = collect()
  await t.assert.rejects(readBundle(absolute, absoluteFiles), /non-canonical file key "\/etc\/passwd"/)
  t.assert.deepStrictEqual(absoluteFiles.files, [])

  // Bundle.parse (JSON.parse) keeps a repeated key's last value; a stream can't take the first back.
  const repeated = String.raw`{"version":1,"config":{"scope":"full"},"entries":[],"sources":{".":{"name":"app","version":"1","files":{"a.js":"one","a.js":"two"}}},"formats":{},"imports":{}}`
  t.assert.equal(parseWhole(compressed(repeated)).modules.get('.').files['a.js'], 'two')
  t.assert.equal((await readBundle(compressed(repeated))).modules.get('.').files['a.js'], 'two')
  const twice = collect()
  await t.assert.rejects(readBundle(chunked(compressed(repeated), 1), twice), /carries file 'a.js' twice/)
  t.assert.ok(twice.files.filter(([file]) => file === 'a.js').length <= 1)
})

test('readBundle with onFile keys every file as bundle.sources does, v0 paths included', async (t) => {
  for (const path of ['', '.', 'node_modules/foo/', 'node_modules/@s/y/lib/z.js', 'src/a.js']) {
    const buf = compressed({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { [path]: 'x' } })
    const { files, onFile } = collect()
    await readBundle(buf, { onFile })
    t.assert.deepStrictEqual(files.map(([file]) => file), [...parseWhole(buf).sources.keys()], JSON.stringify(path))
  }
  // '' and '.' both spell the root listing, so a v0 bundle can't carry both.
  const both = compressed({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: { '': 'x', '.': 'y' } })
  t.assert.throws(() => parseWhole(both), /duplicate file key '\.'/)
  await t.assert.rejects(readBundle(both), /duplicate file key '\.'/)
  await t.assert.rejects(readBundle(both, collect()), /bundle carries file '\.' twice/)
})

test('readBundle rejects as soon as it is aborted, even while onFile is still running', async (t) => {
  const controller = new AbortController()
  let received
  let settled = false
  let timer
  try {
    await t.assert.rejects(readBundle(compressed(minimal({ 'a.js': 'A' })), {
      signal: controller.signal,
      onFile: (file, contents, options) => {
        received = options?.signal
        controller.abort()
        return new Promise((resolve) => {
          timer = setTimeout(() => resolve((settled = true)), 5000)
        })
      },
    }), { name: 'AbortError' })
  } finally {
    clearTimeout(timer)
  }
  t.assert.equal(settled, false, 'rejected without waiting for onFile')
  t.assert.equal(received, controller.signal)
})

test('readBundle ignores bytes after the brotli stream, as brotliDecompressSync does, however they arrive', withTmp(async (t, tmp) => {
  const tail = new Uint8Array(300_000)
  for (let i = 0, x = 1; i < tail.length; i += 1) tail[i] = (x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0) >>> 24
  const buf = Buffer.concat([compressed(sampleBundle().serialize()), tail])
  const file = join(tmp, 'trailing.br')
  writeFileSync(file, buf)
  const expected = parseWhole(buf).serialize()
  for (const [label, source] of [['bytes', buf], ['path', file], ['7-byte chunks', chunked(buf, 7)], ['64 KiB chunks', chunked(buf, 65_536)]]) {
    t.assert.equal((await readBundle(source)).serialize(), expected, label)
  }
  // A truncated stream still fails.
  await t.assert.rejects(readBundle(chunked(buf.subarray(0, 100), 7)))
}))

test('readBundle stops calling onFile once aborted, even for files queued from the same chunk', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.js`, 'x']))
  const controller = new AbortController()
  let calls = 0
  await t.assert.rejects(readBundle(compressed(minimal(files)), {
    signal: controller.signal,
    onFile: () => {
      calls += 1
      controller.abort()
    },
  }), { name: 'AbortError' })
  t.assert.equal(calls, 1)
})

test('readBundle with onFile rejects bundles whose streamed files differ from their file list', async (t) => {
  const cases = {
    // A repeated bucket: JSON.parse keeps the last, but the first one's files were already handed over.
    'repeated bucket': String.raw`{"version":1,"config":{"scope":"node_modules"},"modules":{"node_modules/x":{"name":"x","version":"1","files":{"a.js":"A"}},"node_modules/x":{"name":"x","version":"1","files":{"b.js":"B"}}},"formats":{},"imports":{}}`,
    // v0 ignores `modules`, so what streamed from it isn't in the bundle.
    'v0 with modules': JSON.stringify({
      version: 0, config: { scope: 'full' }, formats: {}, imports: {},
      sources: { 'a.js': 'A' }, modules: { 'node_modules/x': { name: 'x', version: '1', files: { 'b.js': 'B' } } },
    }),
    // Nothing to hand over for a non-string payload.
    'non-string contents': JSON.stringify(minimal({ 'a.js': null })),
    // What streams from v0 `modules` can share a key with a non-string file parse keeps.
    'v0 modules shadowing a file': JSON.stringify({
      version: 0, config: { scope: 'full' }, formats: {}, imports: {},
      sources: { 'node_modules/x/a.js': 42 }, modules: { 'node_modules/x': { name: 'x', version: '1', files: { 'a.js': 'EVIL' } } },
    }),
    'array sources': JSON.stringify({ version: 0, config: { scope: 'full' }, formats: {}, imports: {}, sources: ['A'] }),
  }
  for (const [label, text] of Object.entries(cases)) {
    const buf = compressed(text)
    const whole = parseWhole(buf)
    t.assert.deepStrictEqual([...(await readBundle(buf)).modules], [...whole.modules], `${label}: full mode matches Bundle.parse`)
    await t.assert.rejects(readBundle(buf, { onFile() {} }), /is not a placeholder|outside its file list/, label)
  }
})

test('readBundle rejects a missing file, a non-brotli file, truncation, and bad JSON', withTmp(async (t, tmp) => {
  await t.assert.rejects(readBundle(join(tmp, 'missing.br')), { code: 'ENOENT' })
  await t.assert.rejects(readBundle(Buffer.from(JSON.stringify(minimal({})))))
  const buf = compressed(sampleBundle().serialize())
  await t.assert.rejects(readBundle(buf.subarray(0, buf.length - 10)))
  await t.assert.rejects(readBundle(compressed('{"version":1,')), SyntaxError)
  await t.assert.rejects(readBundle(compressed('{"version":1} trailing')), SyntaxError)
  await t.assert.rejects(readBundle(buf, { onFile: 'nope' }), /onFile must be a function/)
}))

test('readBundle stops reading as soon as the JSON goes bad, and honors an abort signal', async (t) => {
  // Poorly compressible payload behind a bad first byte: the parser fails on the first output chunk.
  const noise = new Uint8Array(2 * 1024 * 1024)
  for (let i = 0, x = 1; i < noise.length; i += 1) noise[i] = (x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0) >>> 24
  const buf = compressed(Buffer.concat([Buffer.from('x'), noise]))
  const chunks = Math.ceil(buf.length / 16_384)
  let pulled = 0
  async function* source() {
    for (let i = 0; i < buf.length; i += 16_384) {
      pulled += 1
      yield buf.subarray(i, i + 16_384)
    }
  }
  await t.assert.rejects(readBundle(source()), SyntaxError)
  t.assert.ok(pulled < chunks / 4, `pulled ${pulled} of ${chunks} chunks`)

  await t.assert.rejects(readBundle(buf, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})
