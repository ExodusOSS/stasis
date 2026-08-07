import { test } from 'node:test'
import { hash } from 'node:crypto'

import { asset, latestRelease, release, releases } from '@exodus/stasis-api/github'

import { json, withFetch } from './fetch.helper.js'

const API = 'https://api.github.com'

const RELEASE = {
  id: 42,
  tag_name: 'v1.2.3',
  name: 'Release 1.2.3',
  body: 'notes',
  draft: false,
  prerelease: false,
  target_commitish: 'main',
  created_at: '2026-01-01T00:00:00Z',
  published_at: '2026-01-02T00:00:00Z',
  html_url: 'https://github.com/ExodusOSS/stasis/releases/tag/v1.2.3',
  tarball_url: `${API}/repos/ExodusOSS/stasis/tarball/v1.2.3`,
  // fields the normalized view deliberately drops -- zipball_url among them: the tarball is
  // available for every repo, so a second archive URL beside it earns nothing
  zipball_url: `${API}/repos/ExodusOSS/stasis/zipball/v1.2.3`,
  node_id: 'RE_kwDO',
  upload_url: `${API}/repos/ExodusOSS/stasis/releases/42/assets{?name,label}`,
  author: { login: 'someone' },
  assets: [
    {
      id: 7,
      name: 'app.stasis.code.br',
      label: 'bundle',
      size: 1234,
      content_type: 'application/octet-stream',
      digest: 'sha256:abc',
      state: 'uploaded',
      browser_download_url: 'https://github.com/ExodusOSS/stasis/releases/download/v1.2.3/app.stasis.code.br',
      url: `${API}/repos/ExodusOSS/stasis/releases/assets/7`,
      download_count: 9,
      uploader: { login: 'someone' },
    },
  ],
}

test('releases() lists a repo and normalizes releases and their attachments', withFetch(
  () => json([RELEASE]),
  async (t, calls) => {
    const list = await releases('ExodusOSS/stasis')
    t.assert.equal(calls.length, 1)
    t.assert.equal(calls[0].url, `${API}/repos/ExodusOSS/stasis/releases?per_page=100`)
    // Metadata reads ask for the versioned JSON media type and identify themselves;
    // GitHub rejects requests without a User-Agent.
    t.assert.equal(calls[0].opts.headers.Accept, 'application/vnd.github+json')
    t.assert.equal(calls[0].opts.headers['X-GitHub-Api-Version'], '2022-11-28')
    t.assert.equal(calls[0].opts.headers['User-Agent'], '@exodus/stasis-api')
    t.assert.equal(calls[0].opts.headers.Authorization, undefined, 'no token means no Authorization header')
    t.assert.ok(calls[0].opts.signal, 'a default timeout signal is always passed')

    t.assert.equal(list.length, 1)
    t.assert.deepEqual(list[0], {
      id: 42,
      tag: 'v1.2.3',
      name: 'Release 1.2.3',
      body: 'notes',
      draft: false,
      prerelease: false,
      commitish: 'main',
      createdAt: '2026-01-01T00:00:00Z',
      publishedAt: '2026-01-02T00:00:00Z',
      url: 'https://github.com/ExodusOSS/stasis/releases/tag/v1.2.3',
      tarballUrl: `${API}/repos/ExodusOSS/stasis/tarball/v1.2.3`,
      assets: [{
        id: 7,
        name: 'app.stasis.code.br',
        label: 'bundle',
        size: 1234,
        contentType: 'application/octet-stream',
        digest: 'sha256:abc',
        state: 'uploaded',
        downloadUrl: 'https://github.com/ExodusOSS/stasis/releases/download/v1.2.3/app.stasis.code.br',
        apiUrl: `${API}/repos/ExodusOSS/stasis/releases/assets/7`,
      }],
    }, 'the raw payload is narrowed, so extra API fields (node_id, uploader, ...) never leak through')
  }
))

test('releases() fills defaults for a bare release with no assets', withFetch(
  () => json([{ id: 1, tag_name: 'v0.0.1' }]),
  async (t) => {
    const [only] = await releases('ExodusOSS/stasis')
    t.assert.equal(only.tag, 'v0.0.1')
    t.assert.deepEqual(only.assets, [])
    for (const key of ['name', 'body', 'commitish', 'createdAt', 'publishedAt', 'url', 'tarballUrl']) {
      t.assert.equal(only[key], null, `${key} defaults to null`)
    }
    // draft/prerelease are booleans even when the payload omits them
    t.assert.equal(only.draft, false)
    t.assert.equal(only.prerelease, false)
  }
))

test('releases() follows the Link header until the last page', withFetch(
  ({ calls }) => calls.length === 1
    ? json([{ id: 1, tag_name: 'v3' }], { link: `<${API}/repos/o/r/releases?per_page=100&page=2>; rel="next", <${API}/repos/o/r/releases?per_page=100&page=9>; rel="last"` })
    : json([{ id: 2, tag_name: 'v2' }]),
  async (t, calls) => {
    const list = await releases('o/r')
    t.assert.equal(calls.length, 2)
    t.assert.equal(calls[1].url, `${API}/repos/o/r/releases?per_page=100&page=2`)
    t.assert.deepEqual(list.map((r) => r.tag), ['v3', 'v2'])
  }
))

test('releases() stops at `limit` instead of walking every page', withFetch(
  ({ calls }) => json(
    [{ id: calls.length * 2 - 1, tag_name: `a${calls.length}` }, { id: calls.length * 2, tag_name: `b${calls.length}` }],
    { link: `<${API}/repos/o/r/releases?per_page=100&page=${calls.length + 1}>; rel="next"` }
  ),
  async (t, calls) => {
    const list = await releases('o/r', { limit: 3 })
    t.assert.deepEqual(list.map((r) => r.tag), ['a1', 'b1', 'a2'])
    t.assert.equal(calls.length, 2, 'the walk stops as soon as the limit is reached')
    // A limit under a full page is asked for verbatim rather than over-fetching.
    await releases('o/r', { limit: 1 })
    t.assert.equal(calls[2].url, `${API}/repos/o/r/releases?per_page=1`)
  }
))

test('releases() with limit=Infinity walks until the pages run out', withFetch(
  ({ calls }) => json([{ id: calls.length, tag_name: `v${calls.length}` }], calls.length < 3
    ? { link: `<${API}/repos/o/r/releases?per_page=100&page=${calls.length + 1}>; rel="next"` }
    : {}),
  async (t, calls) => {
    const list = await releases('o/r', { limit: Infinity })
    t.assert.equal(calls[0].url, `${API}/repos/o/r/releases?per_page=100`, 'a page is still capped at GitHub\'s max')
    t.assert.deepEqual(list.map((r) => r.tag), ['v1', 'v2', 'v3'])
  }
))

test('releases() ignores a `next` link pointing off the API host', withFetch(
  () => json([{ id: 1, tag_name: 'v1' }], { link: '<https://evil.example/repos/o/r/releases?page=2>; rel="next"' }),
  async (t, calls) => {
    // Following it would carry the caller's token to another host.
    const list = await releases('o/r', { token: 'ghp_secret' })
    t.assert.equal(calls.length, 1)
    t.assert.equal(list.length, 1)
  }
))

test('releases() rejects a malformed repo slug before making a request', withFetch(
  () => { throw new Error('fetch must not be called') },
  async (t, calls) => {
    await t.assert.rejects(() => releases('stasis'), /Expected an `owner\/repo` slug: stasis/)
    await t.assert.rejects(() => releases('a/b/c'), /Expected an `owner\/repo` slug: a\/b\/c/)
    await t.assert.rejects(() => releases(42), /Unexpected repo: 42/)
    // `..` would climb out of /repos/ once fetch normalizes the path
    await t.assert.rejects(() => releases('ExodusOSS/..'), /Unexpected repo name: \.\./)
    await t.assert.rejects(() => releases('../x'), /Unexpected repo owner: \.\./)
    await t.assert.rejects(() => releases('o/r?a=b'), /Unexpected repo name: r\?a=b/)
    await t.assert.rejects(() => releases('o r/x'), /Unexpected repo owner: o r/)
    await t.assert.rejects(() => releases('o/r', { limit: 0 }), /Unexpected limit: 0/)
    await t.assert.rejects(() => releases('o/r', { limit: 1.5 }), /Unexpected limit: 1.5/)
    t.assert.equal(calls.length, 0, 'nothing reaches the network')
  }
))

test('releases() accepts the repo names GitHub actually allows', withFetch(
  () => json([]),
  async (t, calls) => {
    // Validation is a path-segment rule, not GitHub's account naming policy: a leading dot
    // (`.github`, the org-wide community health repo), inner dots and leading hyphens are all
    // real and must not be refused locally -- only `.`/`..` and non-segment characters are.
    for (const repo of ['ExodusOSS/.github', 'ExodusOSS/my.repo', 'ExodusOSS/-dash', 'a-b/c_d']) {
      // eslint-disable-next-line no-await-in-loop -- sequential so `calls` below is in list order
      await releases(repo, { limit: 1 })
    }
    t.assert.deepEqual(calls.map((c) => c.url), [
      `${API}/repos/ExodusOSS/.github/releases?per_page=1`,
      `${API}/repos/ExodusOSS/my.repo/releases?per_page=1`,
      `${API}/repos/ExodusOSS/-dash/releases?per_page=1`,
      `${API}/repos/a-b/c_d/releases?per_page=1`,
    ])
  }
))

test('release() fetches one release by tag, percent-encoding the tag', withFetch(
  () => json(RELEASE),
  async (t, calls) => {
    const one = await release('ExodusOSS/stasis', 'v1.2.3', { token: 'ghp_secret' })
    t.assert.equal(calls[0].url, `${API}/repos/ExodusOSS/stasis/releases/tags/v1.2.3`)
    t.assert.equal(calls[0].opts.headers.Authorization, 'Bearer ghp_secret')
    t.assert.equal(one.tag, 'v1.2.3')
    t.assert.equal(one.assets[0].id, 7)

    await release('ExodusOSS/stasis', 'weird/tag#1')
    t.assert.equal(calls[1].url, `${API}/repos/ExodusOSS/stasis/releases/tags/weird%2Ftag%231`,
      'a tag can never introduce extra path segments or a fragment')
  }
))

test('release() rejects tags git itself forbids, and an empty token', withFetch(
  () => { throw new Error('fetch must not be called') },
  async (t, calls) => {
    await t.assert.rejects(() => release('o/r', ''), /Unexpected tag: /)
    await t.assert.rejects(() => release('o/r', 'v1..v2'), /Unexpected tag: v1\.\.v2/)
    await t.assert.rejects(() => release('o/r', 'v1 v2'), /Unexpected tag: v1 v2/)
    await t.assert.rejects(() => release('o/r', 'v1^'), /Unexpected tag: v1\^/)
    await t.assert.rejects(() => release('o/r', null), /Unexpected tag: null/)
    await t.assert.rejects(() => release('o/r', 'v1', { token: '' }), /Expected a non-empty token/)
    t.assert.equal(calls.length, 0)
  }
))

test('latestRelease() asks GitHub for the latest release', withFetch(
  () => json(RELEASE),
  async (t, calls) => {
    const latest = await latestRelease('ExodusOSS/stasis')
    t.assert.equal(calls[0].url, `${API}/repos/ExodusOSS/stasis/releases/latest`)
    t.assert.equal(latest.tag, 'v1.2.3')
  }
))

test('asset() downloads an attachment as bytes', withFetch(
  () => new Response(Buffer.from([1, 2, 3, 4]), { status: 200 }),
  async (t, calls) => {
    const bytes = await asset('ExodusOSS/stasis', 7)
    t.assert.equal(calls[0].url, `${API}/repos/ExodusOSS/stasis/releases/assets/7`)
    t.assert.equal(calls[0].opts.headers.Accept, 'application/octet-stream',
      'the JSON media type would return the asset metadata instead of its content')
    t.assert.ok(bytes instanceof Uint8Array)
    t.assert.deepEqual([...bytes], [1, 2, 3, 4])
  }
))

test('asset() verifies a supplied digest and rejects a mismatch', withFetch(
  () => new Response(Buffer.from('payload'), { status: 200 }),
  async (t) => {
    const digest = `sha256:${hash('sha256', Buffer.from('payload'), 'hex')}`
    const bytes = await asset('o/r', 7, { digest })
    t.assert.equal(Buffer.from(bytes).toString(), 'payload')
    // Uppercase (as some tools render it) still matches.
    t.assert.ok(await asset('o/r', 7, { digest: digest.toUpperCase() }))
    // A truncated or swapped download must fail here, not downstream.
    await t.assert.rejects(
      () => asset('o/r', 7, { digest: `sha256:${'0'.repeat(64)}` }),
      /Asset 7 digest mismatch: expected sha256:0{64}, got sha256:/
    )
    await t.assert.rejects(() => asset('o/r', 7, { digest: 'md5:abc' }), /Unexpected digest: md5:abc/)
    await t.assert.rejects(() => asset('o/r', 7, { digest: 'sha256:nothex' }), /Unexpected digest: sha256:nothex/)
    // A truncated digest STRING is a caller bug, and must not read as a content mismatch.
    await t.assert.rejects(() => asset('o/r', 7, { digest: digest.slice(0, -1) }), /Unexpected digest: sha256:/)
  }
))

test('asset() rejects a non-numeric asset id before making a request', withFetch(
  () => { throw new Error('fetch must not be called') },
  async (t, calls) => {
    await t.assert.rejects(() => asset('o/r', '7'), /Unexpected asset id: 7/)
    await t.assert.rejects(() => asset('o/r', 0), /Unexpected asset id: 0/)
    await t.assert.rejects(() => asset('o/r', 1.5), /Unexpected asset id: 1.5/)
    t.assert.equal(calls.length, 0)
  }
))

test('a non-ok response reports the status and a snippet of the body', withFetch(
  () => new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' }),
  async (t) => {
    await t.assert.rejects(() => releases('o/r'), /github releases request failed: 404 Not Found — {"message":"Not Found"}/)
    await t.assert.rejects(() => release('o/r', 'v1'), /github release request failed: 404 Not Found/)
    await t.assert.rejects(() => latestRelease('o/r'), /github release request failed: 404 Not Found/)
    await t.assert.rejects(() => asset('o/r', 7), /github asset request failed: 404 Not Found/)
  }
))

test('a rate-limited response keeps only the first 200 characters of the body', withFetch(
  () => new Response('x'.repeat(500), { status: 403, statusText: 'Forbidden' }),
  async (t) => {
    await t.assert.rejects(() => releases('o/r'), (err) => {
      t.assert.match(err.message, /github releases request failed: 403 Forbidden — x{200}$/)
      return true
    })
  }
))

test('a transport failure is wrapped with its cause', withFetch(
  () => { throw new Error('connection refused') },
  async (t) => {
    await t.assert.rejects(() => releases('o/r'), (err) => {
      t.assert.match(err.message, /github releases request failed: connection refused/)
      t.assert.equal(err.cause.message, 'connection refused')
      return true
    })
    await t.assert.rejects(() => asset('o/r', 7), /github asset request failed: connection refused/)
  }
))

test('a non-JSON body fails as a bad response, not a crash', withFetch(
  () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  async (t) => {
    await t.assert.rejects(() => releases('o/r'), /github releases response was not JSON/)
    await t.assert.rejects(() => release('o/r', 'v1'), /github release response was not JSON/)
  }
))

test('a JSON body of the wrong shape is rejected', withFetch(
  ({ calls }) => json(calls.length === 1 ? { not: 'an array' } : 'a string'),
  async (t) => {
    await t.assert.rejects(() => releases('o/r'), /Expected an array of GitHub releases/)
    await t.assert.rejects(() => release('o/r', 'v1'), /Expected a GitHub release object/)
  }
))
