import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { subtree } from '@exodus/stasis-api/github'

const API = 'https://api.github.com'
const ROOT = 'ExodusOSS-stasis-802ab55'

const withFetch = (impl, fn) => async (t) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return impl({ url, opts, calls })
  }
  try {
    return await fn(t, calls)
  } finally {
    globalThis.fetch = original
  }
}

// --- archive fixtures -------------------------------------------------------
// Built byte-by-byte rather than shelled out to tar/zip, so the tests pin the framing the
// readers parse (and stay runnable with no external tools).

const tarHeader = (name, size, type = '0') => {
  const h = Buffer.alloc(512)
  h.write(name.length > 100 ? name.slice(0, 100) : name, 0, 100, 'utf8')
  h.write('000644 \0', 100, 8, 'utf8')
  h.write('0000000 \0', 108, 8, 'utf8')
  h.write('0000000 \0', 116, 8, 'utf8')
  h.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  h.write('00000000000 ', 136, 12, 'utf8')
  h.write(type, 156, 1, 'utf8')
  h.write('ustar\0', 257, 6, 'utf8')
  h.write('00', 263, 2, 'utf8')
  // Checksum is computed with the field itself blank-filled.
  h.fill(0x20, 148, 156)
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return h
}

const padding = (size) => Buffer.alloc((512 - (size % 512)) % 512)

// entries: [name, content, type?] — type '0' file, '5' dir, '2' symlink, 'x' pax, 'L' longname
const tarball = (entries) => {
  const parts = []
  for (const [name, content, type = '0'] of entries) {
    const data = Buffer.from(content)
    parts.push(tarHeader(name, data.length, type), data, padding(data.length))
  }
  parts.push(Buffer.alloc(1024)) // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(parts))
}

// A pax record is `<byteLength> <key>=<value>\n`, where the length counts its own digits —
// so it has to be solved for rather than computed in one step.
const paxBlock = (path) => {
  const body = ` path=${path}\n`
  let length = body.length + 2
  while (`${length}`.length + body.length !== length) length = `${length}`.length + body.length
  return ['PaxHeaders/entry', `${length}${body}`, 'x']
}

const TREE = [
  [`${ROOT}/`, '', '5'],
  [`${ROOT}/package.json`, '{"name":"stasis"}'],
  [`${ROOT}/src/`, '', '5'],
  [`${ROOT}/src/entry.js`, 'export const x = 1\n'],
  [`${ROOT}/src/lib/util.js`, 'export const y = 2\n'],
  [`${ROOT}/contracts/A.sol`, 'contract A {}\n'],
]

const archive = (body) => new Response(body, { status: 200 })
const text = (bytes) => Buffer.from(bytes).toString('utf8')

// --- tests ------------------------------------------------------------------

test('subtree() fetches the tarball at a ref and returns repo-relative files', withFetch(
  () => archive(tarball(TREE)),
  async (t, calls) => {
    const { root, files } = await subtree('ExodusOSS/stasis', '802ab555e9b754884b445394287673a2982023d5')
    t.assert.equal(calls[0].url, `${API}/repos/ExodusOSS/stasis/tarball/802ab555e9b754884b445394287673a2982023d5`)
    // The archive endpoints answer 415 to `application/octet-stream` (unlike the asset
    // endpoint, which requires it), so the default JSON Accept has to stand.
    t.assert.equal(calls[0].opts.headers.Accept, 'application/vnd.github+json')
    // The archive's top-level dir is stripped but reported: it records the resolved commit.
    t.assert.equal(root, ROOT)
    t.assert.deepEqual([...files.keys()], [
      'package.json', 'src/entry.js', 'src/lib/util.js', 'contracts/A.sol',
    ], 'directory entries carry no content and are dropped')
    t.assert.equal(text(files.get('src/entry.js')), 'export const x = 1\n')
    t.assert.ok(files.get('src/entry.js') instanceof Uint8Array)
  }
))

test('subtree() filters to a path, keeping keys repo-relative', withFetch(
  () => archive(tarball(TREE)),
  async (t) => {
    const { files } = await subtree('ExodusOSS/stasis', 'v1.0.0', { path: 'src' })
    t.assert.deepEqual([...files.keys()], ['src/entry.js', 'src/lib/util.js'])
    // A trailing or leading slash is the same request.
    const slashed = await subtree('ExodusOSS/stasis', 'v1.0.0', { path: '/src/' })
    t.assert.deepEqual([...slashed.files.keys()], ['src/entry.js', 'src/lib/util.js'])
    // A nested subtree works the same way.
    const nested = await subtree('ExodusOSS/stasis', 'v1.0.0', { path: 'src/lib' })
    t.assert.deepEqual([...nested.files.keys()], ['src/lib/util.js'])
  }
))

test('subtree() round-trips binary content byte-for-byte', withFetch(
  () => archive(tarball([[`${ROOT}/blob.bin`, Buffer.from([0, 1, 2, 253, 254, 255, 0, 10, 13])]])),
  async (t) => {
    const { files } = await subtree('o/r', 'v1')
    t.assert.deepEqual([...files.get('blob.bin')], [0, 1, 2, 253, 254, 255, 0, 10, 13])
  }
))

test('subtree() rejects an archive that carries the same path twice', withFetch(
  () => archive(tarball([[`${ROOT}/a.js`, 'first'], [`${ROOT}/a.js`, 'second']])),
  async (t) => {
    // tar can legally repeat a path and the later entry would win, hiding the earlier bytes
    // from every caller. Refuse rather than silently pick one.
    await t.assert.rejects(() => subtree('o/r', 'v1'), /Duplicate archive path: .*\/a\.js/)
  }
))

test('subtree() keeps only regular files — symlinks and dirs are dropped', withFetch(
  () => archive(tarball([
    [`${ROOT}/real.js`, 'ok\n'],
    [`${ROOT}/dir/`, '', '5'],
    [`${ROOT}/link.js`, '', '2'],
    [`${ROOT}/hard.js`, '', '1'],
  ])),
  async (t) => {
    const { files } = await subtree('o/r', 'v1')
    // A symlink's target is exactly what could point out of the tree, so links are not
    // represented at all rather than resolved.
    t.assert.deepEqual([...files.keys()], ['real.js'])
  }
))

test('subtree() reads long paths from ustar prefix and pax headers', withFetch(
  ({ calls }) => {
    const long = `${'nested/'.repeat(12)}deep.js` // > 100 chars, needs prefix or pax
    if (calls.length === 1) {
      // ustar form: the header splits the path across prefix + name
      const h = tarHeader('deep.js', 3)
      h.write(`${ROOT}/${'nested'.repeat(2)}`, 345, 155, 'utf8')
      return archive(gzipSync(Buffer.concat([h, Buffer.from('ok\n'), padding(3), Buffer.alloc(1024)])))
    }
    return archive(tarball([paxBlock(`${ROOT}/${long}`), [`${ROOT}/ignored.js`, 'ok\n']]))
  },
  async (t) => {
    const ustar = await subtree('o/r', 'v1')
    t.assert.deepEqual([...ustar.files.keys()], ['nestednested/deep.js'])
    // The pax block renames the entry that follows it.
    const pax = await subtree('o/r', 'v1')
    t.assert.deepEqual([...pax.files.keys()], [`${'nested/'.repeat(12)}deep.js`])
  }
))

test('subtree() refuses an archive entry that escapes the tree', withFetch(
  () => archive(tarball([[`${ROOT}/ok.js`, 'x'], [`${ROOT}/../../etc/passwd`, 'boom']])),
  async (t) => {
    await t.assert.rejects(() => subtree('o/r', 'v1'), /Unsafe archive path: .*etc\/passwd/)
  }
))

test('subtree() rejects an archive whose entries share no single root', withFetch(
  ({ calls }) => archive(calls.length === 1
    ? tarball([[`${ROOT}/a.js`, 'x'], ['other-root/b.js', 'y']])
    : tarball([['toplevel.js', 'x']])),
  async (t) => {
    await t.assert.rejects(() => subtree('o/r', 'v1'), /more than one top-level directory/)
    await t.assert.rejects(() => subtree('o/r', 'v1'), /outside the root directory: toplevel.js/)
  }
))

test('subtree() fails loudly when the path matches nothing', withFetch(
  () => archive(tarball(TREE)),
  async (t) => {
    // An empty Map would be indistinguishable from a successful read of an empty dir.
    await t.assert.rejects(
      () => subtree('ExodusOSS/stasis', 'v1.0.0', { path: 'typo' }),
      /No files under 'typo' in ExodusOSS\/stasis at v1.0.0/
    )
  }
))

test('subtree() enforces maxBytes from content-length and from the stream', withFetch(
  ({ calls }) => {
    const body = tarball([[`${ROOT}/big.js`, 'x'.repeat(4096)]])
    // First call declares its length; second withholds it, so only the streamed count catches it.
    return calls.length === 1
      ? new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
      : new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(body)); c.close() },
      }), { status: 200 })
  },
  async (t) => {
    await t.assert.rejects(() => subtree('o/r', 'v1', { maxBytes: 64 }),
      /github archive is over the 64 byte limit \(\d+ bytes\); raise maxBytes/)
    await t.assert.rejects(() => subtree('o/r', 'v1', { maxBytes: 64 }),
      /github archive is over the 64 byte limit \(\d+ bytes\); raise maxBytes/)
  }
))

test('subtree() validates its arguments before making a request', withFetch(
  () => { throw new Error('fetch must not be called') },
  async (t, calls) => {
    await t.assert.rejects(() => subtree('stasis', 'v1'), /Expected an `owner\/repo` slug/)
    await t.assert.rejects(() => subtree('o/r', ''), /Unexpected ref: /)
    await t.assert.rejects(() => subtree('o/r', 'v1..v2'), /Unexpected ref: v1\.\.v2/)
    await t.assert.rejects(() => subtree('o/r', 'v1', { path: '../etc' }), /Unexpected path: \.\.\/etc/)
    await t.assert.rejects(() => subtree('o/r', 'v1', { path: 'a/../../b' }), /Unexpected path: a\/\.\.\/\.\.\/b/)
    await t.assert.rejects(() => subtree('o/r', 'v1', { path: 42 }), /Unexpected path: 42/)
    await t.assert.rejects(() => subtree('o/r', 'v1', { maxBytes: 0 }), /Unexpected maxBytes: 0/)
    t.assert.equal(calls.length, 0, 'nothing reaches the network')
  }
))

test('subtree() passes a token through and reports HTTP failures like the other endpoints', withFetch(
  ({ calls }) => calls.length === 1
    ? archive(tarball([[`${ROOT}/a.js`, 'x']]))
    : new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' }),
  async (t, calls) => {
    await subtree('o/r', 'v1', { token: 'ghp_secret' })
    t.assert.equal(calls[0].opts.headers.Authorization, 'Bearer ghp_secret')
    await t.assert.rejects(() => subtree('o/r', 'nope'),
      /github archive request failed: 404 Not Found — {"message":"Not Found"}/)
  }
))

test('subtree() surfaces a corrupt archive as a malformed-archive error', withFetch(
  ({ calls }) => archive(calls.length === 1
    ? Buffer.from('not gzip at all')
    // Valid gzip whose payload is not a tar: the framing check has to catch it.
    : gzipSync(Buffer.alloc(600, 0x41))),
  async (t) => {
    await t.assert.rejects(() => subtree('o/r', 'v1'), /Malformed tar.gz archive/)
    await t.assert.rejects(() => subtree('o/r', 'v1'), /Malformed tar archive/)
  }
))
