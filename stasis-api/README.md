# <img src="/stasis/logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis-api`

Zero-dependency registry API clients used by `@exodus/stasis`.

Transport only: no credential discovery, no caching, and no disk access — except the
`npm/semver` shim, which binds to the semver already bundled with the running Node's npm CLI
rather than installing one.

| Export | What it provides |
| - | - |
| `@exodus/stasis-api/npm` | `advisories(list)` — npm bulk security advisories for `{ name, version }` pairs |
| `@exodus/stasis-api/npm/semver` | lazily-bound `semver` from the bundled npm CLI, so nothing is installed for it |
| `@exodus/stasis-api/github` | `releases()`, `release()`, `latestRelease()`, `asset()` — GitHub releases and their attachments; `subtree()` — a repo tree at an exact ref |

```js
import { asset, latestRelease } from '@exodus/stasis-api/github'

const { tag, assets } = await latestRelease('ExodusOSS/stasis')
const bundle = assets.find((a) => a.name.endsWith('.stasis.code.br'))
// `digest` (when GitHub reports one) is verified before the bytes are returned
const bytes = await asset('ExodusOSS/stasis', bundle.id, { digest: bundle.digest })
console.log(tag, bundle.name, bytes.byteLength)
```

`asset()` buffers the attachment in memory, so a caller fetching several large assets should
bound its own concurrency rather than firing them all at once.

`subtree()` reads a repo tree at an exact commit, tag or branch — no git client, nothing
written to disk. One archive request per call, decompressed and parsed in memory:

```js
import { subtree } from '@exodus/stasis-api/github'

// omit `path` for the whole tree
const { root, files } = await subtree('ExodusOSS/bytes', 'v1.15.1', { path: 'benchmarks' })
console.log(root) // 'ExodusOSS-bytes-c33d586' — the commit the ref resolved to
for (const [path, bytes] of files) console.log(path, bytes.byteLength) // 'benchmarks/…', repo-relative
```

Keys stay repo-relative, so a subtree's paths keep their `path` prefix. Only regular files are
returned: directories and symlinks carry no usable content, and a symlink target is exactly
what could point outside the tree. Rejected rather than sanitized: entries that escape the
tree, a path that appears twice (the second would shadow the first), and archives with more
than one top-level directory. The whole archive is held in memory while it is parsed, bounded
by `maxBytes` (256 MiB by default).

Every function takes an optional `signal` (defaulting to a timeout) and, for GitHub, an
optional `token` — no token is ever read from the environment.

See main package [GitHub](https://github.com/ExodusOSS/stasis/tree/main/stasis) or [npm](https://npmjs.com/package/@exodus/stasis) for full README.

## License

[MIT](./LICENSE)
