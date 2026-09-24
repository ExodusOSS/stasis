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

const { root, vfs, summary } = await loadPnpmNodeModules({ cwd, cacheDir, offline })
// `vfs` is a @preventive/vfs Vfs holding the lockfile's node_modules at the project's real
// paths; read it (and the workspace's own sources on disk) through the overlay host:
const host = createOverlayHost({ root, vfs, makeResolver })
```

Subpath exports (`/lockfile`, `/dep-path`, `/tar`, `/fetch`, `/settings`, `/layout`, `/overlay`)
expose the pieces. It is built on three strict, dependency-light libraries:
[`@preventive/yaml`](https://npmjs.com/package/@preventive/yaml) (the YAML subset pnpm writes),
[`@preventive/archive`](https://npmjs.com/package/@preventive/archive) (the in-memory tar reader,
which refuses what no honest packer writes: escaping or duplicate names, symlinks out of the
archive, truncated archives) and [`@preventive/vfs`](https://npmjs.com/package/@preventive/vfs)
(the in-memory filesystem with POSIX path resolution the layout is built into).

## License

[MIT](./LICENSE)
