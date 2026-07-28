import assert from 'node:assert/strict'
import { hash } from 'node:crypto'

import { isSafePath, readTarGz, readZip } from '../archive.js'
import { requestOk } from '../request.js'

// GitHub REST client, scoped to releases and their attachments ("assets" in API terms).
// Transport only: no disk, and no credential discovery -- a caller that needs a private
// repo or a higher rate limit (60 requests/hour per IP unauthenticated, 5000
// authenticated) passes `token` explicitly, so a token is never picked up from the
// environment behind the caller's back.

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const JSON_MEDIA_TYPE = 'application/vnd.github+json'
// GitHub rejects requests that carry no User-Agent, so one is always sent.
const USER_AGENT = '@exodus/stasis-api'

// Metadata answers in one round trip; a download is bounded by its size instead.
const METADATA_TIMEOUT = 30_000
const ASSET_TIMEOUT = 300_000
const ARCHIVE_TIMEOUT = 300_000
// A subtree is decoded in memory, so the archive needs a ceiling: a runaway repo should error
// instead of exhausting the heap. Set well clear of ordinary repos -- a small library's
// archive already measures in the tens of MB -- since the cap is a backstop, not a budget.
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024

const ARCHIVE_ENDPOINTS = { tgz: 'tarball', zip: 'zipball' }

// Each half of a slug must be exactly one path segment, so a hand-assembled value can't
// reshape the endpoint it is interpolated into -- `.` and `..` would climb out of /repos/
// once fetch normalizes the path. Deliberately a segment rule and not GitHub's account
// naming policy: that policy drifts, and encoding it here only turns a loosened rule into a
// local false rejection (it is how a leading-dot repo like `ExodusOSS/.github` gets refused).
const segmentRegex = /^[\w.-]{1,100}$/u
const isSegment = (s) => segmentRegex.test(s) && s !== '.' && s !== '..'
// Refs hold nearly anything, so a tag is percent-encoded rather than matched; these are the
// characters and sequences git itself forbids, rejected up front for a local error message.
const badTagRegex = /[\s~^:?*[\]\\]|\.\./u
// GitHub reports an asset's content digest as `<algorithm>:<hex>`. The hex length is pinned
// per algorithm so a truncated digest fails as a bad argument, not as a content mismatch.
const digestRegex = /^(?:sha256:[\da-f]{64}|sha384:[\da-f]{96}|sha512:[\da-f]{128})$/u
const nextLinkRegex = /^\s*<([^>]+)>\s*;\s*rel="?next"?/u

function assertRepo(repo) {
  assert(typeof repo === 'string', `Unexpected repo: ${repo}`)
  const parts = repo.split('/')
  assert.equal(parts.length, 2, `Expected an \`owner/repo\` slug: ${repo}`)
  const [owner, name] = parts
  assert(isSegment(owner), `Unexpected repo owner: ${owner}`)
  assert(isSegment(name), `Unexpected repo name: ${name}`)
}

function encodeRef(ref, what = 'ref') {
  assert(typeof ref === 'string' && ref !== '', `Unexpected ${what}: ${ref}`)
  assert(!badTagRegex.test(ref), `Unexpected ${what}: ${ref}`)
  return encodeURIComponent(ref)
}

function request(what, url, { accept = JSON_MEDIA_TYPE, token, signal }) {
  const headers = { Accept: accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION }
  if (token !== null) {
    assert(typeof token === 'string' && token !== '', 'Expected a non-empty token')
    headers.Authorization = `Bearer ${token}`
  }
  // An asset download answers with a cross-origin 302 to a storage host. fetch drops
  // Authorization when following a redirect to another origin, so the token stays with
  // GitHub -- which is why redirects are followed rather than handled by hand.
  return requestOk(`github ${what}`, url, { headers, signal })
}

async function parseJson(what, res) {
  try {
    return await res.json()
  } catch (cause) {
    throw new Error(`github ${what} response was not JSON: ${cause.message}`, { cause })
  }
}

// Follow the `next` URL of a GitHub `Link` header, ignoring the other rels. Only URLs on
// the API host are accepted: pagination must not walk a response into following a link to
// somewhere else (which would carry the token there).
function nextLink(header) {
  if (!header) return null
  for (const part of header.split(',')) {
    const m = nextLinkRegex.exec(part)
    if (m && m[1].startsWith(`${API}/`)) return m[1]
  }
  return null
}

// A fixed, curated view of GitHub's payloads rather than a passthrough: volatile or
// caller-irrelevant fields (node_id, author/uploader, download_count, upload_url) are
// dropped and the rest renamed to a stable shape, so consumers can't come to depend on the
// raw API shape. Everything kept here is public API of this package, so a field is added
// when a caller needs one rather than pre-emptively -- adding is cheap, removing breaks.
function normalizeAsset(raw) {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Expected a GitHub asset object')
  return {
    id: raw.id,
    name: raw.name,
    label: raw.label ?? null,
    size: raw.size ?? null,
    contentType: raw.content_type ?? null,
    // Absent on assets uploaded before GitHub began reporting digests.
    digest: raw.digest ?? null,
    // 'uploaded' once the upload completed; anything else is not fetchable yet.
    state: raw.state ?? null,
    downloadUrl: raw.browser_download_url ?? null,
    apiUrl: raw.url ?? null,
  }
}

function normalizeRelease(raw) {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Expected a GitHub release object')
  return {
    id: raw.id,
    tag: raw.tag_name,
    name: raw.name ?? null,
    body: raw.body ?? null,
    draft: Boolean(raw.draft),
    prerelease: Boolean(raw.prerelease),
    commitish: raw.target_commitish ?? null,
    createdAt: raw.created_at ?? null,
    publishedAt: raw.published_at ?? null,
    url: raw.html_url ?? null,
    tarballUrl: raw.tarball_url ?? null,
    zipballUrl: raw.zipball_url ?? null,
    assets: (Array.isArray(raw.assets) ? raw.assets : []).map(normalizeAsset),
  }
}

async function releasePage(url, options) {
  const res = await request('releases', url, options)
  const page = await parseJson('releases', res)
  assert(Array.isArray(page), 'Expected an array of GitHub releases')
  return { page, next: nextLink(res.headers.get('link')) }
}

// List a repo's releases, newest first, including drafts and prereleases (for those the
// token must be able to see them). `limit` caps how many are returned; pass `Infinity` to
// walk every page.
export async function releases(repo, { limit = 100, signal = AbortSignal.timeout(METADATA_TIMEOUT), token = null } = {}) {
  assertRepo(repo)
  assert((Number.isInteger(limit) || limit === Infinity) && limit > 0, `Unexpected limit: ${limit}`)

  const out = []
  // GitHub caps a page at 100 entries. Walking `Link: rel="next"` instead of incrementing
  // `page=` keeps the walk on URLs GitHub itself handed back. One `signal` covers the
  // whole walk, so `limit` also bounds how long a repo with many releases can take.
  let url = `${API}/repos/${repo}/releases?per_page=${Math.min(limit, 100)}`
  while (url !== null) {
    // eslint-disable-next-line no-await-in-loop -- pagination is sequential by nature: the next URL comes from this page's Link header
    const { page, next } = await releasePage(url, { token, signal })
    for (const entry of page) {
      out.push(normalizeRelease(entry))
      if (out.length === limit) return out
    }
    url = next
  }
  return out
}

// Fetch a single release by its tag.
export async function release(repo, tag, { signal = AbortSignal.timeout(METADATA_TIMEOUT), token = null } = {}) {
  assertRepo(repo)
  const res = await request('release', `${API}/repos/${repo}/releases/tags/${encodeRef(tag, 'tag')}`, { token, signal })
  return normalizeRelease(await parseJson('release', res))
}

// Fetch the latest release. GitHub's notion of "latest" skips drafts and prereleases --
// use `releases()` when those matter.
export async function latestRelease(repo, { signal = AbortSignal.timeout(METADATA_TIMEOUT), token = null } = {}) {
  assertRepo(repo)
  const res = await request('release', `${API}/repos/${repo}/releases/latest`, { token, signal })
  return normalizeRelease(await parseJson('release', res))
}

// Download one attachment's bytes by asset id (from a listing's `assets[].id`). Pass the
// listing's `digest` to have it verified before the bytes are handed back, so a truncated or
// swapped download fails here rather than downstream. The default timeout is far longer than
// the metadata calls': release assets can be very large.
export async function asset(repo, id, { digest = null, signal = AbortSignal.timeout(ASSET_TIMEOUT), token = null } = {}) {
  assertRepo(repo)
  assert(Number.isInteger(id) && id > 0, `Unexpected asset id: ${id}`)
  const expected = digest === null ? null : String(digest).toLowerCase()
  assert(expected === null || digestRegex.test(expected), `Unexpected digest: ${digest}`)

  const url = `${API}/repos/${repo}/releases/assets/${id}`
  const res = await request('asset', url, { accept: 'application/octet-stream', token, signal })
  let bytes
  try {
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (cause) {
    throw new Error(`github asset request failed: ${cause.message}`, { cause })
  }

  if (expected !== null) {
    const algorithm = expected.slice(0, expected.indexOf(':'))
    const actual = `${algorithm}:${hash(algorithm, bytes, 'hex')}`
    assert.equal(actual, expected, `Asset ${id} digest mismatch: expected ${expected}, got ${actual}`)
  }
  return bytes
}

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

// Read the body with a hard ceiling. The archive is decoded in memory, so an oversized one
// must fail with a clear message rather than exhaust the heap.
async function readCapped(what, res, maxBytes) {
  const over = (n) => `github ${what} is over the ${maxBytes} byte limit (${n} bytes); raise maxBytes`
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
// One request to GitHub's archive endpoint returns the whole tree at `ref`, which is then
// filtered to `path` (default: everything). No git client is involved and nothing is written
// to disk -- the archive is decompressed and parsed in memory, and only regular files
// survive (see ../archive.js). `format` picks the container: 'tgz' (default) or 'zip'.
//
// Returns `{ root, files }` where `files` maps REPO-relative posix paths -> bytes (so a
// subtree's keys keep their `path` prefix), and `root` is the archive's stripped top-level
// directory, which records the commit the ref resolved to.
export async function subtree(repo, ref, options = {}) {
  const {
    path = '',
    format = 'tgz',
    maxBytes = ARCHIVE_MAX_BYTES,
    signal = AbortSignal.timeout(ARCHIVE_TIMEOUT),
    token = null,
  } = options
  assertRepo(repo)
  const endpoint = ARCHIVE_ENDPOINTS[format]
  assert(endpoint !== undefined, `Unexpected format: ${format}`)
  assert(Number.isInteger(maxBytes) && maxBytes > 0, `Unexpected maxBytes: ${maxBytes}`)
  const prefix = subtreePrefix(path)

  const url = `${API}/repos/${repo}/${endpoint}/${encodeRef(ref)}`
  // Keeps the default JSON Accept even though the body is an archive: unlike the asset
  // endpoint, /tarball and /zipball answer 415 to `application/octet-stream`. GitHub redirects
  // both to codeload, which serves the bytes regardless of what was negotiated here.
  const res = await request('archive', url, { token, signal })
  const bytes = await readCapped('archive', res, maxBytes)
  const { root, files } = stripRoot(format === 'tgz' ? readTarGz(bytes) : readZip(bytes))
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
