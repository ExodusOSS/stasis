import assert from 'node:assert/strict'

import { requestOk } from '../request.js'

// Core GitHub REST plumbing: the host, the headers every call sends, identifier validation,
// and pagination. Knows how to talk to GitHub but not what to ask it -- each endpoint family
// builds on this (see releases.js, subtree.js).
//
// Transport only: no disk, and no credential discovery -- a caller that needs a private repo
// or a higher rate limit (60 requests/hour per IP unauthenticated, 5000 authenticated) passes
// `token` explicitly, so a token is never picked up from the environment behind its back.

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const JSON_MEDIA_TYPE = 'application/vnd.github+json'
// GitHub rejects requests that carry no User-Agent, so one is always sent.
const USER_AGENT = '@exodus/stasis-api'

// Metadata answers in one round trip; a transfer is bounded by its size instead. Both halves
// of that policy live here so the endpoints cannot drift apart on what is a long request.
export const METADATA_TIMEOUT = 30_000
export const TRANSFER_TIMEOUT = 300_000

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

function assertRepo(repo) {
  assert(typeof repo === 'string', `Unexpected repo: ${repo}`)
  const parts = repo.split('/')
  assert.equal(parts.length, 2, `Expected an \`owner/repo\` slug: ${repo}`)
  const [owner, name] = parts
  assert(isSegment(owner), `Unexpected repo owner: ${owner}`)
  assert(isSegment(name), `Unexpected repo name: ${name}`)
}

// The one route by which a repo slug becomes a URL. Validating here rather than at each
// endpoint means a new endpoint cannot assemble a URL and forget the check -- which is the
// whole point of the segment rule above.
export function repoUrl(repo, ...segments) {
  assertRepo(repo)
  return `${API}/repos/${repo}/${segments.join('/')}`
}

export function encodeRef(ref, what = 'ref') {
  assert(typeof ref === 'string' && ref !== '', `Unexpected ${what}: ${ref}`)
  assert(!badRefRegex.test(ref), `Unexpected ${what}: ${ref}`)
  return encodeURIComponent(ref)
}

// Absent and explicitly-null both mean unauthenticated, decided here so an endpoint cannot
// half-declare the policy: a missing default would otherwise reach the assert below as
// `undefined` and be reported as a bad token rather than as no token.
export function request(what, url, { accept = JSON_MEDIA_TYPE, token = null, signal }) {
  const headers = { Accept: accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION }
  if (token !== null && token !== undefined) {
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
