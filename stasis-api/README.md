# <img src="/stasis/logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis-api`

Zero-dependency registry API clients used by `@exodus/stasis`.

Transport only: no disk access, no credential discovery, no caching.

| Export | What it provides |
| - | - |
| `@exodus/stasis-api/npm` | `advisories(list)` — npm bulk security advisories for `{ name, version }` pairs |
| `@exodus/stasis-api/npm/semver` | lazily-bound `semver` from the bundled npm CLI, so nothing is installed for it |
| `@exodus/stasis-api/github` | `releases()`, `release()`, `latestRelease()`, `asset()` — GitHub releases and their attachments |

```js
import { asset, releases } from '@exodus/stasis-api/github'

const [latest] = await releases('ExodusOSS/stasis', { limit: 1 })
for (const a of latest.assets) {
  // `digest` (when GitHub reports one) is verified before the bytes are returned
  const bytes = await asset('ExodusOSS/stasis', a.id, { digest: a.digest })
  console.log(a.name, bytes.byteLength)
}
```

Every function takes an optional `signal` (defaulting to a timeout) and, for GitHub, an
optional `token` — no token is ever read from the environment.

See main package [GitHub](https://github.com/ExodusOSS/stasis/tree/main/stasis) or [npm](https://npmjs.com/package/@exodus/stasis) for full README.

## License

[MIT](./LICENSE)
