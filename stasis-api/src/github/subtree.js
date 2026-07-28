import assert from 'node:assert/strict'

import { isSafePath, readTarGz } from '../archive.js'
import { TRANSFER_TIMEOUT, encodeRef, repoUrl, request } from './core.js'

// A repo's source tree at an exact ref, read into memory.

// The archive is decoded in memory, so it needs a ceiling: a runaway repo should error
// instead of exhausting the heap. Set well clear of ordinary repos -- a small library's
// archive already measures in the tens of MB -- since the cap is a backstop, not a budget.
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024

// Normalize a subtree path to a `dir/` prefix; '' means the whole tree.
function subtreePrefix(path) {
  assert(typeof path === 'string', `Unexpected path: ${path}`)
  const trimmed = path.replaceAll(/^\/+|\/+$/gu, '')
  if (trimmed === '') return ''
  assert(isSafePath(trimmed), `Unexpected path: ${path}`)
  return `${trimmed}/`
}

// Read the archive body with a hard ceiling. Lives here rather than in core.js because the
// ceiling is this endpoint's `maxBytes` option -- the asset endpoint takes the whole body,
// whose size the caller already knows from the release listing.
async function readCapped(res, maxBytes) {
  const over = (n) => `github archive is over the ${maxBytes} byte limit (${n} bytes); raise maxBytes`
  // Trust `content-length` only to fail early -- it is absent on a chunked response.
  const declared = Number(res.headers.get('content-length'))
  assert(!(declared > maxBytes), over(declared))

  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    assert(!(total > maxBytes), over(total))
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// Fetch a repo subtree at an exact commit, tag or branch, into memory.
//
// One request to GitHub's tarball endpoint returns the whole tree at `ref`, which is then
// narrowed to `path` (default: everything). No git client is involved and nothing is written
// to disk -- the archive is decompressed and parsed in memory, and only regular files
// survive (see ../archive.js).
//
// Returns `{ root, files }` where `files` maps REPO-relative posix paths -> bytes (so a
// subtree's keys keep their `path` prefix), and `root` is the archive's stripped top-level
// directory, which records the commit the ref resolved to.
export async function subtree(repo, ref, options = {}) {
  const {
    path = '',
    maxBytes = ARCHIVE_MAX_BYTES,
    signal = AbortSignal.timeout(TRANSFER_TIMEOUT),
    token,
  } = options
  assert(Number.isInteger(maxBytes) && maxBytes > 0, `Unexpected maxBytes: ${maxBytes}`)
  const prefix = subtreePrefix(path)

  const url = repoUrl(repo, 'tarball', encodeRef(ref))
  // Keeps the default JSON Accept even though the body is an archive: unlike the asset
  // endpoint, /tarball answers 415 to `application/octet-stream`. GitHub redirects to
  // codeload, which serves the bytes regardless of what was negotiated here.
  const res = await request('archive', url, { token, signal })
  const bytes = await readCapped(res, maxBytes)

  // Every GitHub archive nests the tree under one top-level directory whose name carries the
  // resolved commit (`owner-repo-<sha>`). Take that directory from the entries themselves
  // rather than reconstructing the name and trusting it to match.
  //
  // Stripping the root and applying `path` as the archive is read, rather than filtering the
  // finished Map, is what keeps a small subtree cheap: an entry outside it is checked for
  // safety and then skipped, so the whole tree is never copied to keep a fraction of it.
  let root = null
  const files = readTarGz(bytes, (name) => {
    const slash = name.indexOf('/')
    assert(slash > 0, `Unexpected archive entry outside the root directory: ${name}`)
    const first = name.slice(0, slash)
    if (root === null) root = first
    else assert.equal(first, root, 'Unexpected archive with more than one top-level directory')
    // '' prefixes everything, so the whole-tree case needs no branch of its own.
    return name.startsWith(prefix, slash + 1) ? name.slice(slash + 1) : null
  })

  // A path that matches nothing is a typo far more often than an intentionally empty
  // subtree, and an empty Map would be indistinguishable from a successful read.
  assert(prefix === '' || files.size > 0, `No files under '${path}' in ${repo} at ${ref}`)
  return { root, files }
}
