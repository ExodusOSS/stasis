import assert from 'node:assert/strict'

import { requestOk } from '../request.js'

// Core GitHub REST plumbing: the host, the headers every call sends, identifier validation,
// pagination, and body reading. Knows how to talk to GitHub but not what to ask it for --
// each endpoint family builds on this (see releases.js, subtree.js).
//
// Transport only: no disk, and no credential discovery -- a caller that needs a private repo
// or a higher rate limit (60 requests/hour per IP unauthenticated, 5000 authenticated) passes
// `token` explicitly, so a token is never picked up from the environment behind its back.

export const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
export const JSON_MEDIA_TYPE = 'application/vnd.github+json'
// GitHub rejects requests that carry no User-Agent, so one is always sent.
const USER_AGENT = '@exodus/stasis-api'

// Metadata answers in one round trip; a download is bounded by its size instead, so the
// endpoints that transfer bytes set their own longer timeout.
export const METADATA_TIMEOUT = 30_000

// Each half of a slug must be exactly one path segment, so a hand-assembled value can't
// reshape the endpoint it is interpolated into -- `.` and `..` would climb out of /repos/
// once fetch normalizes the path. Deliberately a segment rule and not GitHub's account
// naming policy: that policy drifts, and encoding it here only turns a loosened rule into a
// local false rejection (it is how a leading-dot repo like `ExodusOSS/.github` gets refused).
const segmentRegex = /^[\w.-]{1,100}$/u
const isSegment = (s) => segmentRegex.test(s) && s !== '.' && s !== '..'
// Refs hold nearly anything, so one is percent-encoded rather than matched; these are the
// characters and sequences git itself forbids, rejected up front for a local error message.
const badRefRegex = /[\s~^:?*[\]\\]|\.\./u

export function assertRepo(repo) {
  assert(typeof repo === 'string', `Unexpected repo: ${repo}`)
  const parts = repo.split('/')
  assert.equal(parts.length, 2, `Expected an \`owner/repo\` slug: ${repo}`)
  const [owner, name] = parts
  assert(isSegment(owner), `Unexpected repo owner: ${owner}`)
  assert(isSegment(name), `Unexpected repo name: ${name}`)
}

export function encodeRef(ref, what = 'ref') {
  assert(typeof ref === 'string' && ref !== '', `Unexpected ${what}: ${ref}`)
  assert(!badRefRegex.test(ref), `Unexpected ${what}: ${ref}`)
  return encodeURIComponent(ref)
}

export function request(what, url, { accept = JSON_MEDIA_TYPE, token, signal }) {
  const headers = { Accept: accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION }
  if (token !== null) {
    assert(typeof token === 'string' && token !== '', 'Expected a non-empty token')
    headers.Authorization = `Bearer ${token}`
  }
  // A download answers with a cross-origin 302 to a storage host. fetch drops Authorization
  // when following a redirect to another origin, so the token stays with GitHub -- which is
  // why redirects are followed rather than handled by hand.
  return requestOk(`github ${what}`, url, { headers, signal })
}

export async function parseJson(what, res) {
  try {
    return await res.json()
  } catch (cause) {
    throw new Error(`github ${what} response was not JSON: ${cause.message}`, { cause })
  }
}

const nextLinkRegex = /^\s*<([^>]+)>\s*;\s*rel="?next"?/u

// Follow the `next` URL of a GitHub `Link` header, ignoring the other rels. Only URLs on the
// API host are accepted: pagination must not walk a response into following a link to
// somewhere else (which would carry the token there).
export function nextLink(header) {
  if (!header) return null
  for (const part of header.split(',')) {
    const m = nextLinkRegex.exec(part)
    if (m && m[1].startsWith(`${API}/`)) return m[1]
  }
  return null
}

// Read a response body with a hard ceiling, for the endpoints that hand back bytes rather
// than JSON: the payload is held in memory, so an oversized one must fail with a clear
// message rather than exhaust the heap.
export async function readCapped(what, res, maxBytes) {
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
