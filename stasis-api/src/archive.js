import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

// In-memory reader for the gzipped tar GitHub serves a repo tree as (`/tarball`, available
// for every repo). Takes the whole archive as bytes and returns a `Map` of entry path ->
// bytes; nothing touches disk and no external tar is involved -- Node's zlib decompresses,
// the ustar framing is parsed here, so the package stays dependency-free.
//
// Only regular files are kept. Directories, symlinks, hardlinks and device nodes carry no
// content a caller can use, and a symlink target is precisely the thing that could point
// out of the tree, so they are dropped rather than represented.

const BLOCK = 512

const dotdotRegex = /(?:^|\/)\.\.(?:\/|$)/u

// An entry must land inside the tree it claims to be part of. Rejected: absolute paths, any
// `..` segment, a backslash (a separator that would slip past a posix-only check), and NUL.
export function isSafePath(path) {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return !dotdotRegex.test(path)
}

// Copy an entry out of the archive buffer instead of returning a view into it: callers
// typically keep a subtree and drop the rest, and a subarray would pin the entire archive in
// memory for as long as any single file is referenced.
const detach = (bytes) => new Uint8Array(bytes)

// tar pads its text fields with NUL. Read the range directly rather than slicing a view out
// of it first -- this runs three times per entry, so the views alone would outnumber the
// files in the archive several times over.
const field = (buf, start, end) => {
  const nul = buf.indexOf(0, start)
  return buf.toString('utf8', start, nul === -1 || nul > end ? end : nul)
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

function readTar(tar, select) {
  const files = new Map()
  // Names are tracked separately from the returned entries so the checks below cover the
  // whole archive even when `select` keeps only part of it.
  const seen = new Set()
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
        // tar can legally hold the same path twice and the reader would keep whichever came
        // last, so a second entry could shadow the first -- and the shadowed bytes would
        // never be seen. Refuse the archive instead of silently picking a winner.
        assert(!seen.has(name), `Duplicate archive path: ${name}`)
        seen.add(name)
        // `select` maps an entry to the key it is stored under, or drops it by returning
        // null. Both checks above run either way, so a dropped entry still cannot smuggle an
        // unsafe or duplicated path past them -- it only skips being copied.
        const key = select(name)
        if (key !== null) files.set(key, detach(tar.subarray(start, end)))
      }
    }

    offset = end + ((BLOCK - (size % BLOCK)) % BLOCK)
  }
  return files
}

// `select` narrows and re-keys the archive as it is read, so the bytes of an entry the caller
// does not want are never copied out of it -- filtering afterwards would memcpy the whole
// tree to keep a fraction of it.
//
// `maxBytes` bounds the DECOMPRESSED size. gzip can expand a tiny input a thousandfold, so a
// cap on the downloaded bytes alone would still let a compression bomb exhaust the heap here.
export function readTarGz(bytes, select = (name) => name, maxBytes = Infinity) {
  let tar
  try {
    tar = gunzipSync(bytes, { maxOutputLength: maxBytes === Infinity ? undefined : maxBytes })
  } catch (cause) {
    // The output cap tripping is a size refusal, not a damaged archive -- say which.
    if (cause.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`Archive is over the ${maxBytes} byte limit once decompressed; raise maxBytes`, { cause })
    }
    throw new Error(`Malformed tar.gz archive: ${cause.message}`, { cause })
  }
  return readTar(tar, select)
}
