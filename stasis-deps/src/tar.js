import { gunzipSync } from 'node:zlib'

// In-memory reader for npm package tarballs (gzipped ustar/pax/GNU tar). Returns the package's
// files keyed by their path relative to the package root -- the leading `package/` (or whatever
// single top-level directory the publisher used; pnpm and npm both strip exactly one component)
// removed -- each with its bytes and mode. Nothing touches the disk: the tree stays in memory for
// the virtual node_modules. Only regular files are kept: npm never publishes symlinks or devices,
// and a tarball that tries to plant one (or a `..`/absolute path) is refused rather than trusted.

const BLOCK = 512

function readString(buf, start, length) {
  let end = start
  const limit = start + length
  while (end < limit && buf[end] !== 0) end++
  return buf.toString('utf8', start, end)
}

// Octal ASCII field, or GNU base-256 when the high bit of the first byte is set.
function readNumber(buf, start, length) {
  if (buf[start] & 0x80) {
    let n = 0
    for (let i = start + 1; i < start + length; i++) n = n * 256 + buf[i]
    return n
  }
  const text = readString(buf, start, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function parsePax(buf) {
  const out = new Map()
  let pos = 0
  while (pos < buf.length) {
    const space = buf.indexOf(0x20, pos)
    if (space === -1) break
    const len = Number.parseInt(buf.toString('utf8', pos, space), 10)
    if (!Number.isInteger(len) || len <= 0) break
    const record = buf.toString('utf8', space + 1, pos + len - 1) // drop the trailing \n
    const eq = record.indexOf('=')
    if (eq !== -1) out.set(record.slice(0, eq), record.slice(eq + 1))
    pos += len
  }
  return out
}

function isGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1F && buf[1] === 0x8B
}

// Strip the single top-level directory and normalize: reject anything that could escape.
function packageRelative(entryPath, label) {
  const parts = entryPath.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error(`${label}: tarball entry escapes the package: ${entryPath}`)
  if (entryPath.startsWith('/')) throw new Error(`${label}: tarball entry has an absolute path: ${entryPath}`)
  if (parts.length < 2) return null // the top-level dir itself, or a stray root file: nothing to keep
  return parts.slice(1).join('/')
}

// -> Map<relPath, { content: Buffer, mode: number }>. `label` names the tarball in errors.
export function readPackageTarball(bytes, { label = 'tarball' } = {}) {
  const tar = isGzip(bytes) ? gunzipSync(bytes) : bytes
  const files = new Map()
  let pos = 0
  let longName = null
  let pax = null
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK)
    if (header.every((b) => b === 0)) break // end-of-archive marker
    const magic = readString(header, 257, 6)
    let name = readString(header, 0, 100)
    const mode = readNumber(header, 100, 8)
    let size = readNumber(header, 124, 12)
    const typeflag = header[156] === 0 ? '0' : String.fromCodePoint(header[156])
    if (magic.startsWith('ustar')) {
      const prefix = readString(header, 345, 155)
      if (prefix) name = `${prefix}/${name}`
    }
    pos += BLOCK
    const dataEnd = pos + size
    if (dataEnd > tar.length) throw new Error(`${label}: truncated tarball`)
    const data = tar.subarray(pos, dataEnd)
    pos = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK)

    if (typeflag === 'L') { longName = readString(data, 0, data.length); continue }
    if (typeflag === 'x') { pax = parsePax(data); continue }
    if (typeflag === 'g' || typeflag === 'K') continue // global pax / GNU long link: nothing we keep

    if (pax?.has('path')) name = pax.get('path')
    else if (longName !== null) name = longName
    if (pax?.has('size')) size = Number(pax.get('size'))
    longName = null
    pax = null

    if (typeflag !== '0' && typeflag !== '7') continue // dirs are implied by files; links/devices dropped
    const rel = packageRelative(name, label)
    if (rel === null) continue
    // A later duplicate entry wins, as with every tar extractor (npm's pack never emits one).
    files.set(rel, { content: Buffer.from(data), mode: mode & 0o777 })
  }
  return files
}
