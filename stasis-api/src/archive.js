import assert from 'node:assert/strict'
import { gunzipSync, inflateRawSync } from 'node:zlib'

// In-memory readers for the two archive formats GitHub serves a repo tree as: gzipped tar
// (`/tarball`) and zip (`/zipball`). Both take the whole archive as bytes and return a
// `Map` of entry path -> bytes; nothing touches disk and no external unzip is involved
// (Node's zlib does the decompression, the container framing is parsed here).
//
// Only regular files are kept. Directories, symlinks, hardlinks and device nodes carry no
// content a caller can use, and a symlink target is precisely the thing that could point
// out of the tree, so they are dropped rather than represented.

const BLOCK = 512

// An entry must land inside the tree it claims to be part of. Rejected: absolute paths, any
// `..` segment, a backslash (zip mandates `/`, so a backslash is a separator smuggled past a
// posix-only check), and NUL.
export function isSafePath(path) {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return !path.split('/').includes('..')
}

// Copy an entry out of the archive buffer instead of returning a view into it: callers
// typically keep a subtree and drop the rest, and a subarray would pin the entire archive in
// memory for as long as any single file is referenced.
const detach = (bytes) => new Uint8Array(bytes)

// A zlib output buffer is already its own allocation, so it can be re-typed without a copy.
const asBytes = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

const view = (bytes) =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const field = (buf, start, end) => {
  const slice = buf.subarray(start, end)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

// tar numbers are octal ASCII. GNU/star write sizes above 8 GiB in a base-256 form instead,
// flagged by the high bit of the first byte.
function readNumber(buf, start, end) {
  if ((buf[start] & 0x80) !== 0) {
    let n = 0n
    for (let i = start; i < end; i++) n = (n << 8n) | BigInt(i === start ? buf[i] & 0x7f : buf[i])
    assert(n <= BigInt(Number.MAX_SAFE_INTEGER), 'Malformed tar archive: entry too large')
    return Number(n)
  }
  const text = field(buf, start, end).trim()
  if (text === '') return 0
  const n = Number.parseInt(text, 8)
  assert(Number.isSafeInteger(n) && n >= 0, `Malformed tar archive: bad size ${text}`)
  return n
}

// ustar splits a long path across `prefix` (345..500) and `name` (0..100).
function ustarName(header) {
  const name = field(header, 0, 100)
  const prefix = field(header, 345, 500)
  return prefix === '' ? name : `${prefix}/${name}`
}

// pax extended headers are a run of `<byteLength> <key>=<value>\n` records, where the length
// counts itself. Only `path` matters here (it overrides the ustar name of the next entry).
function paxPath(data) {
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space === -1) return null
    const length = Number.parseInt(data.subarray(i, space).toString('latin1'), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || i + length > data.length) return null
    const record = data.subarray(space + 1, i + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1)
    i += length
  }
  return null
}

export function readTar(bytes) {
  const tar = view(bytes)
  const files = new Map()
  // A pax ('x') or GNU longname ('L') block names the entry that FOLLOWS it.
  let pending = null
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    // The archive ends with zero blocks; the first one is enough to stop.
    if (header.every((b) => b === 0)) break

    const size = readNumber(header, 124, 136)
    const type = String.fromCharCode(header[156])
    const start = offset + BLOCK
    const end = start + size
    assert(end <= tar.length, 'Malformed tar archive: truncated entry')

    if (type === 'x' || type === 'L') {
      pending = type === 'x' ? paxPath(tar.subarray(start, end)) : field(tar, start, end)
    } else if (type !== 'g') {
      const name = pending ?? ustarName(header)
      pending = null
      // '0' and NUL both mean a regular file; every other type carries nothing to keep.
      if (type === '0' || type === '\0') {
        assert(isSafePath(name), `Unsafe archive path: ${name}`)
        files.set(name, detach(tar.subarray(start, end)))
      }
    }

    offset = end + ((BLOCK - (size % BLOCK)) % BLOCK)
  }
  return files
}

export function readTarGz(bytes) {
  let tar
  try {
    tar = gunzipSync(view(bytes))
  } catch (cause) {
    throw new Error(`Malformed tar.gz archive: ${cause.message}`, { cause })
  }
  return readTar(tar)
}

const EOCD_SIGNATURE = 0x0605_4b50
const CENTRAL_SIGNATURE = 0x0201_4b50
const LOCAL_SIGNATURE = 0x0403_4b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xff_ff

// The end-of-central-directory record sits at the end, after a comment of up to 64 KiB, so it
// has to be found by scanning backwards for its signature.
function findEocd(buf) {
  const floor = Math.max(0, buf.length - MAX_COMMENT - EOCD_SIZE)
  for (let i = buf.length - EOCD_SIZE; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

export function readZip(bytes) {
  const buf = view(bytes)
  assert(buf.length >= EOCD_SIZE, 'Malformed zip archive: too short')
  const eocd = findEocd(buf)
  assert(eocd !== -1, 'Malformed zip archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  const size = buf.readUInt32LE(eocd + 12)
  const offset = buf.readUInt32LE(eocd + 16)
  // Zip64 saturates these fields and moves the real values into a separate record. A repo
  // archive never needs it, so fail loudly rather than walk a truncated directory.
  assert(count !== 0xff_ff && offset !== 0xff_ff_ff_ff, 'Zip64 archives are not supported')
  assert(offset + size <= buf.length, 'Malformed zip archive: central directory out of range')

  const files = new Map()
  let p = offset
  for (let i = 0; i < count; i++) {
    assert(p + 46 <= buf.length && buf.readUInt32LE(p) === CENTRAL_SIGNATURE,
      'Malformed zip archive: bad central directory entry')
    const method = buf.readUInt16LE(p + 10)
    // Sizes are read from the central directory, which is authoritative even when the local
    // header defers them to a trailing data descriptor (general-purpose flag bit 3).
    const compressed = buf.readUInt32LE(p + 20)
    const uncompressed = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    p += 46 + nameLength + extraLength + commentLength

    // A trailing slash is how zip records a directory.
    if (name.endsWith('/')) continue
    assert(isSafePath(name), `Unsafe archive path: ${name}`)

    assert(localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === LOCAL_SIGNATURE,
      `Malformed zip archive: bad local header for ${name}`)
    // The local header repeats the name and extra field with its own lengths, which are the
    // ones that locate the data.
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    assert(start + compressed <= buf.length, `Malformed zip archive: truncated entry ${name}`)
    const data = buf.subarray(start, start + compressed)

    let content
    if (method === 0) {
      content = detach(data)
    } else if (method === 8) {
      try {
        content = asBytes(inflateRawSync(data))
      } catch (cause) {
        throw new Error(`Malformed zip archive: cannot inflate ${name}: ${cause.message}`, { cause })
      }
    } else {
      throw new Error(`Unsupported zip compression method ${method} for ${name}`)
    }
    assert.equal(content.length, uncompressed, `Malformed zip archive: size mismatch for ${name}`)
    files.set(name, content)
  }
  return files
}
