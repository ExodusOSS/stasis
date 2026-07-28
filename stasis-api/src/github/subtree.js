import assert from 'node:assert/strict'

import { isSafePath, readTarGz } from '../archive.js'
import { API, assertRepo, encodeRef, readCapped, request } from './core.js'

// A repo's source tree at an exact ref, read into memory.

const ARCHIVE_TIMEOUT = 300_000
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

// Every GitHub archive nests the tree under one top-level directory whose name carries the
// resolved commit (`owner-repo-<sha>`). Take that directory from the entries themselves
// rather than reconstructing the name and trusting it to match.
function stripRoot(entries) {
  let root = null
  for (const name of entries.keys()) {
    const slash = name.indexOf('/')
    assert(slash > 0, `Unexpected archive entry outside the root directory: ${name}`)
    const first = name.slice(0, slash)
    if (root === null) root = first
    else assert.equal(first, root, 'Unexpected archive with more than one top-level directory')
  }
  const files = new Map()
  for (const [name, content] of entries) files.set(name.slice(root.length + 1), content)
  return { root, files }
}

// Fetch a repo subtree at an exact commit, tag or branch, into memory.
//
// One request to GitHub's tarball endpoint returns the whole tree at `ref`, which is then
// filtered to `path` (default: everything). No git client is involved and nothing is written
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
    signal = AbortSignal.timeout(ARCHIVE_TIMEOUT),
    token = null,
  } = options
  assertRepo(repo)
  assert(Number.isInteger(maxBytes) && maxBytes > 0, `Unexpected maxBytes: ${maxBytes}`)
  const prefix = subtreePrefix(path)

  const url = `${API}/repos/${repo}/tarball/${encodeRef(ref)}`
  // Keeps the default JSON Accept even though the body is an archive: unlike the asset
  // endpoint, /tarball answers 415 to `application/octet-stream`. GitHub redirects to
  // codeload, which serves the bytes regardless of what was negotiated here.
  const res = await request('archive', url, { token, signal })
  const bytes = await readCapped('archive', res, maxBytes)
  const { root, files } = stripRoot(readTarGz(bytes))
  if (prefix === '') return { root, files }

  const out = new Map()
  for (const [name, content] of files) {
    if (name.startsWith(prefix)) out.set(name, content)
  }
  // A path that matches nothing is a typo far more often than an intentionally empty
  // subtree, and an empty Map would be indistinguishable from a successful read.
  assert(out.size > 0, `No files under '${path}' in ${repo} at ${ref}`)
  return { root, files: out }
}
