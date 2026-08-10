import assert from 'node:assert/strict'
import { hash } from 'node:crypto'

import { METADATA_TIMEOUT, TRANSFER_TIMEOUT } from '../request.js'
import { encodeRef, nextLink, parseJson, readBody, repoUrl, request } from './core.js'

// Releases and their attachments ("assets" in API terms).

// GitHub reports an asset's content digest as `<algorithm>:<hex>`. The hex length is pinned
// per algorithm so a truncated digest fails as a bad argument, not as a content mismatch.
const digestRegex = /^(?:sha256:[\da-f]{64}|sha384:[\da-f]{96}|sha512:[\da-f]{128})$/u

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
    // Only the tarball: GitHub serves it for every repo, so carrying `zipball_url` beside it
    // would be a second way to do the same thing (subtree.js reads tarballs for the same reason).
    tarballUrl: raw.tarball_url ?? null,
    assets: (Array.isArray(raw.assets) ? raw.assets : []).map(normalizeAsset),
  }
}

// List a repo's releases, newest first, including drafts and prereleases (for those the
// token must be able to see them). `limit` caps how many are returned; pass `Infinity` to
// walk every page.
export async function releases(repo, { limit = 100, signal = AbortSignal.timeout(METADATA_TIMEOUT), token } = {}) {
  assert((Number.isInteger(limit) || limit === Infinity) && limit > 0, `Unexpected limit: ${limit}`)

  const out = []
  // GitHub caps a page at 100 entries. Walking `Link: rel="next"` instead of incrementing
  // `page=` keeps the walk on URLs GitHub itself handed back. One `signal` covers the
  // whole walk, so `limit` also bounds how long a repo with many releases can take.
  let url = `${repoUrl(repo, 'releases')}?per_page=${Math.min(limit, 100)}`
  while (url !== null) {
    // eslint-disable-next-line no-await-in-loop -- pagination is sequential by nature: the next URL comes from this page's Link header
    const res = await request('releases', url, { token, signal })
    // eslint-disable-next-line no-await-in-loop -- same walk, one page at a time
    const page = await parseJson('releases', res)
    assert(Array.isArray(page), 'Expected an array of GitHub releases')
    for (const entry of page) {
      out.push(normalizeRelease(entry))
      if (out.length === limit) return out
    }
    url = nextLink(res.headers.get('link'))
  }
  return out
}

// `release()` and `latestRelease()` differ only in how the one release is addressed.
async function oneRelease(repo, tail, { signal = AbortSignal.timeout(METADATA_TIMEOUT), token } = {}) {
  const res = await request('release', repoUrl(repo, 'releases', tail), { token, signal })
  return normalizeRelease(await parseJson('release', res))
}

// Fetch a single release by its tag.
export async function release(repo, tag, options) {
  return oneRelease(repo, `tags/${encodeRef(tag, 'tag')}`, options)
}

// Fetch the latest release. GitHub's notion of "latest" skips drafts and prereleases --
// use `releases()` when those matter.
export async function latestRelease(repo, options) {
  return oneRelease(repo, 'latest', options)
}

// Download one attachment's bytes by asset id (from a listing's `assets[].id`). Pass the
// listing's `digest` to have it verified before the bytes are handed back, so a truncated or
// swapped download fails here rather than downstream. The default timeout is far longer than
// the metadata calls': release assets can be very large.
export async function asset(repo, id, { digest = null, signal = AbortSignal.timeout(TRANSFER_TIMEOUT), token } = {}) {
  assert(Number.isInteger(id) && id > 0, `Unexpected asset id: ${id}`)
  const expected = digest === null ? null : String(digest).toLowerCase()
  assert(expected === null || digestRegex.test(expected), `Unexpected digest: ${digest}`)

  const url = repoUrl(repo, 'releases/assets', id)
  const res = await request('asset', url, { accept: 'application/octet-stream', token, signal })
  const bytes = new Uint8Array(await readBody('asset', () => res.arrayBuffer()))

  if (expected !== null) {
    const algorithm = expected.slice(0, expected.indexOf(':'))
    const actual = `${algorithm}:${hash(algorithm, bytes, 'hex')}`
    assert.equal(actual, expected, `Asset ${id} digest mismatch: expected ${expected}, got ${actual}`)
  }
  return bytes
}
