# <img src="/stasis/logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis-deps`

A project's `node_modules` reconstructed **in memory** from its `pnpm-lock.yaml`: every package
tarball is downloaded into a content-addressed cache, verified against the lockfile's integrity,
unpacked in memory and laid out exactly as `pnpm install` would (pnpm's isolated virtual store,
dependency symlinks, hoisting) — with nothing unpacked to disk and no package script ever run.

It is the optional dependency behind `stasis bundle --pnpm` in [`@exodus/stasis`](../stasis)
(install both: `npm i -D @exodus/stasis @exodus/stasis-deps`), and knows nothing about bundling
or module resolution itself. See [doc/pnpm.md](https://github.com/ExodusOSS/stasis/blob/main/doc/pnpm.md).

```js
import { createOverlayHost, loadPnpmNodeModules } from '@exodus/stasis-deps'

const { root, tree, summary } = await loadPnpmNodeModules({ cwd, cacheDir, offline })
// `tree` is a MemoryTree of the lockfile's node_modules; read it through a host:
const host = createOverlayHost({ root, tree, makeResolver })
```

Subpath exports (`/lockfile`, `/dep-path`, `/tar`, `/fetch`, `/settings`, `/layout`, `/vfs`)
expose the pieces. Its only dependency is [`@preventive/yaml`](https://npmjs.com/package/@preventive/yaml),
the strict parser for the YAML subset pnpm writes.

## License

[MIT](./LICENSE)
