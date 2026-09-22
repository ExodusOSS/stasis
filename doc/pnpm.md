# `stasis bundle --pnpm`

`stasis bundle --pnpm` builds a JavaScript/TypeScript bundle from a project's
**`pnpm-lock.yaml` alone** — no `pnpm install`, no `node_modules` on disk, and
no package script ever run. Dependencies are resolved through an in-memory
reconstruction of the `node_modules` tree pnpm would have installed, so the
resulting bundle (and companion lockfile) is **byte-identical** to what the
plain `stasis bundle` produces over a real `pnpm install` of the same lockfile.

```sh
stasis bundle --pnpm [--pnpm-cache=dir] [--pnpm-offline] [--scope=…] [--conditions=…] [--mainFields=…] [--metro --platforms=…] [--jsx] [--flow] [--typescript] [--resources=…] [--package-json] [--lockfile=path] [--output=(path|-)] src/index.js
```

| Flag | Meaning |
| - | - |
| `--pnpm` | Resolve dependencies from `pnpm-lock.yaml` instead of the on-disk `node_modules`. JS/TS entries only. |
| `--pnpm-cache=dir` | Where package tarballs are stored. Default `$STASIS_PNPM_CACHE`, else `$XDG_CACHE_HOME/stasis/pnpm-tarballs` (`~/.cache/stasis/pnpm-tarballs`). |
| `--pnpm-offline` | Never download: every tarball must already be in the cache, else the build fails. |

Every other `stasis bundle` JS flag combines with it, except `--metro-resolver`
(the project's own `metro-resolver` reads the real disk, which `--pnpm`
deliberately masks).

## What it does

1. **Reads the lockfile.** `pnpm-lock.yaml` (lockfileVersion 9, pnpm ≥ 9) is
   located in the working directory or the nearest ancestor (a workspace root),
   along with the layout-relevant settings from `~/.npmrc`, `pnpm-workspace.yaml`
   and the project `.npmrc` (`virtual-store-dir`, `virtual-store-dir-max-length`,
   `hoist`, `hoist-pattern`, `public-hoist-pattern`, `shamefully-hoist`,
   `hoist-workspace-packages`, `registry`, `@scope:registry`,
   `//host/:_authToken`).
2. **Downloads every needed tarball into the cache** — content-addressed by the
   lockfile's SRI integrity (`<cache>/sha512/<hex>.tgz`) — and **verifies** each
   against that integrity. A cached tarball is re-verified on every read; a
   mismatch (download or cache) evicts it and fails the build. Tarballs are never
   unpacked onto disk. Optional dependencies pnpm would skip on this platform
   (`os`/`cpu`/`libc`/`engines` mismatch) are neither downloaded nor laid out.
3. **Unpacks in memory** and lays out pnpm's isolated tree:
   `node_modules/.pnpm/<name>@<version>(<peers>)/node_modules/<name>/…` (directory
   names escaped and, when too long, hashed exactly as pnpm 10 does), dependency
   symlinks beside each package, each importer's `node_modules/<alias>` links
   (`link:`/`workspace:` deps point at the real directories on disk), and the
   hoisted fallbacks under `node_modules/.pnpm/node_modules` (and the root
   `node_modules` for `public-hoist-pattern`).
4. **Scans through that tree** with the usual `stasis bundle` rules: Node's
   resolution algorithm (`exports`/`imports`, conditions, `main`, extension
   probing, realpaths) reimplemented over the virtual filesystem, then the
   bundle/lockfile materialized the same way the disk path does. Workspace
   sources still come from disk; **every `node_modules` directory under the
   project root is masked**, so whatever is (or isn't) installed there cannot
   influence the result.

Because the recorded paths are pnpm's real paths, the artifact interoperates
with a real install: `stasis run --bundle=load` serves it, and the companion
`--lockfile` verifies under `stasis run --lock=frozen`.

## Not supported (fails closed)

- `node-linker=hoisted` / `pnp` — only pnpm's default isolated layout is reproduced.
- Git dependencies and `file:` **directory** dependencies (no verifiable tarball).
  Local `file:…tgz` tarballs work (read from disk, integrity-checked).
- `patchedDependencies` — the patch would have to be applied to the in-memory tree.
- Lockfiles older than lockfileVersion 9 — re-run `pnpm install` with pnpm ≥ 9.

## Notes

- The tarball cache holds pristine registry `.tgz` files only; it is safe to
  share between projects and CI runs, and to seed for `--pnpm-offline`.
- Downloads use Node's built-in `fetch`; behind an HTTP(S) proxy, set
  `NODE_USE_ENV_PROXY=1` so it honours `HTTPS_PROXY`. Registry credentials come
  from `.npmrc` (`//host/:_authToken=…`, `${ENV}` expansion included).
- Directory names for very long dependency paths follow pnpm 10's scheme
  (`<prefix>_<32 hex of sha256>`); pnpm 9 used a different hash, so a bundle
  built here matches a pnpm 10 install.
- Platform gating uses the current machine (`process.platform`/`process.arch`,
  glibc vs musl), like `pnpm install` would.
