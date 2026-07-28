import assert from 'node:assert/strict'
import { hash } from 'node:crypto'

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

// Owners are alphanumeric with single inner hyphens (at most 39 alphanumerics); repo names
// add `.`, `_` and `-` (at most 100 chars). Validated rather than just escaped so a
// hand-assembled slug can't reshape the endpoint it is interpolated into -- a `..` segment
// would climb out of /repos/ once fetch normalizes the path.
const ownerRegex = /^[\da-z](?:-?[\da-z]){0,38}$/iu
const repoRegex = /^\w[\w.-]{0,99}$/u
// Refs hold nearly anything, so a tag is percent-encoded rather than matched; these are the
// characters and sequences git itself forbids, rejected up front for a local error message.
const badTagRegex = /[\s~^:?*[\]\\]|\.\./u
// GitHub reports an asset's content digest as `<algorithm>:<hex>`. The hex length is pinned
// per algorithm so a truncated digest fails as a bad argument, not as a content mismatch.
const digestRegex = /^(?:sha256:[\da-f]{64}|sha384:[\da-f]{96}|sha512:[\da-f]{128})$/u

function repoSlug(repo) {
  assert(typeof repo === 'string', `Unexpected repo: ${repo}`)
  const parts = repo.split('/')
  assert.equal(parts.length, 2, `Expected an \`owner/repo\` slug: ${repo}`)
  const [owner, name] = parts
  assert(ownerRegex.test(owner), `Unexpected repo owner: ${owner}`)
  assert(repoRegex.test(name), `Unexpected repo name: ${name}`)
  return `${owner}/${name}`
}

function encodeTag(tag) {
  assert(typeof tag === 'string' && tag !== '', `Unexpected tag: ${tag}`)
  assert(!badTagRegex.test(tag), `Unexpected tag: ${tag}`)
  return encodeURIComponent(tag)
}

async function request(what, url, { accept = JSON_MEDIA_TYPE, token = null, signal }) {
  const headers = { Accept: accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION }
  if (token !== null) {
    assert(typeof token === 'string' && token !== '', 'Expected a non-empty token')
    headers.Authorization = `Bearer ${token}`
  }

  let res
  try {
    // An asset download answers with a cross-origin 302 to a storage host. fetch drops
    // Authorization when following a redirect to another origin, so the token stays with
    // GitHub -- which is why redirects are followed here rather than handled by hand.
    res = await fetch(url, { headers, signal })
  } catch (cause) {
    throw new Error(`github ${what} request failed: ${cause.message}`, { cause })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`github ${what} request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  return res
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
    const m = /^\s*<([^>]+)>\s*;\s*rel="?next"?/u.exec(part)
    if (m && m[1].startsWith(`${API}/`)) return m[1]
  }
  return null
}

// A deliberately narrow view of GitHub's payloads: what identifies a release plus what is
// needed to fetch and verify its attachments. Extra fields are dropped rather than passed
// through, so consumers can't come to depend on the raw API shape.
function normalizeAsset(raw) {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Expected a GitHub asset object')
  return {
    id: raw.id,
    name: raw.name,
    label: raw.label ?? null,
    size: raw.size ?? null,
    contentType: raw.content_type ?? null,
    // `<algorithm>:<hex>` when GitHub has computed one -- assets uploaded before it
    // started reporting digests have none. Pass it to `asset()` to verify the download.
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

// One page of the releases listing, plus where the next one lives (null when this is the last).
async function releasePage(url, options) {
  const res = await request('releases', url, options)
  const page = await parseJson('releases', res)
  assert(Array.isArray(page), 'Expected an array of GitHub releases')
  return { page, next: nextLink(res.headers.get('link')) }
}

// List a repo's releases, newest first, including drafts and prereleases (for those the
// token must be able to see them). `limit` caps how many are returned; pass `Infinity` to
// walk every page.
export async function releases(repo, { limit = 100, signal = AbortSignal.timeout(30_000), token = null } = {}) {
  const slug = repoSlug(repo)
  assert((Number.isInteger(limit) || limit === Infinity) && limit > 0, `Unexpected limit: ${limit}`)

  const out = []
  // GitHub caps a page at 100 entries. Walking `Link: rel="next"` instead of incrementing
  // `page=` keeps the walk on URLs GitHub itself handed back. One `signal` covers the
  // whole walk, so `limit` also bounds how long a repo with many releases can take.
  let url = `${API}/repos/${slug}/releases?per_page=${Math.min(limit, 100)}`
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
export async function release(repo, tag, { signal = AbortSignal.timeout(30_000), token = null } = {}) {
  const url = `${API}/repos/${repoSlug(repo)}/releases/tags/${encodeTag(tag)}`
  const res = await request('release', url, { token, signal })
  return normalizeRelease(await parseJson('release', res))
}

// Fetch the latest release. GitHub's notion of "latest" skips drafts and prereleases --
// use `releases()` when those matter.
export async function latestRelease(repo, { signal = AbortSignal.timeout(30_000), token = null } = {}) {
  const url = `${API}/repos/${repoSlug(repo)}/releases/latest`
  const res = await request('release', url, { token, signal })
  return normalizeRelease(await parseJson('release', res))
}

// Download one attachment's bytes by asset id (from a listing's `assets[].id`). When
// `digest` is given -- the listing's `digest`, `<algorithm>:<hex>` -- it is verified before
// the bytes are handed back, so a truncated or swapped download fails here and not
// somewhere downstream. Default timeout is generous: release assets can be large.
export async function asset(repo, id, { digest = null, signal = AbortSignal.timeout(300_000), token = null } = {}) {
  const slug = repoSlug(repo)
  assert(Number.isInteger(id) && id > 0, `Unexpected asset id: ${id}`)
  const expected = digest === null ? null : String(digest).toLowerCase()
  assert(expected === null || digestRegex.test(expected), `Unexpected digest: ${digest}`)

  const url = `${API}/repos/${slug}/releases/assets/${id}`
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
