# <img src="./logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis`

*Analyzeable source code bundles with resolutions + fine-grained lockfiles.*

Both lockfiles and bundles only include what is actually _used_.\
Generally about 10x smaller than production-focused `node_modules` install.

Enforcing these lets you focus automated code scanning and alerts only on code that matters,
and makes the analysis import graph aware.

Ideal workflow: create bundle -> analyze -> ship _that exact bundle_ to production.

Lockfile can attest the bundle in a readable form, but that's not required - bundle itself can be an attestation.

| Lockfile | Bundle |
| -------- | ------ |
| `stasis.lock.json` | `stasis.code.br` |
| Asserts per-file content integrity and the import graph | Contains per-file content (source) and the import graph |
| Human-readable | Compressed |
| Asserts only, files are read from disk | Loads or asserts (can be used as a lockfile)|
| Modes: `add`, `replace`, `frozen`, `ignore` | Modes: `load`, `add`, `replace`, `frozen`, `ignore` |

The main difference between lockfiles and bundles is that lockfiles contain integrities, and bundles contain full content.\
See [file formats](https://github.com/ExodusOSS/stasis/blob/main/doc/file-formats.md).

Both can be run in full scope (default) or just in `node_modules` scope.

## Why a separate bundle format?

| | Stasis | JS bundlers | Sourcemaps | SEA | source + deps tarball | Containers |
| - | - | - | - | - | - | - |
| Runnable | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Contains original sources | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Sources match runtime | ✅ | ➖ | ❌ Deps can misreport | ➖ | ✅ | ✅ |
| Dependency versions | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Import edges | ✅ | ❌ | ❌ | ❌ | 🔍 Implicit | 🔍 Implicit |
| Constrained to related code | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

_Lockfiles (npm/pnpm/etc) not mentioned: they are like the "tarball" column, but also require network, install step and are not self-contained._

## Commands

| Command | What it does |
| - | - |
| `stasis run --lock=add app.js` | build just a lockfile |
| `stasis run --lock=frozen app.js` | verify disk against the lockfile |
| `stasis run --bundle=add app.js` | build just a bundle |
| `stasis run --bundle=frozen app.js` | verify disk against the bundle alone (self-attesting) |
| `stasis run --bundle=load app.js` | run from the bundle alone |
| `stasis run --lock=add --bundle=add app.js` | build a lockfile and bundle together |
| `stasis run --lock=frozen --bundle=load app.js` | run from the bundle, verified against the lockfile |
| `stasis run --lock=add --bundle=add --mock app.js` | build without the app's side effects (network, fs writes) |
| `stasis run --lock=add --child-process app.js` | also attest modules loaded in forked child processes (e.g. Metro transform workers) |
| `stasis run --bundle=add --fs=sync app.js` | build a bundle that also captures sync `fs.readFileSync`/`readdirSync` reads |
| `stasis bundle src/index.js` | build a bundle statically, without executing it |
| `stasis bundle --add src/worker.js` | merge more entries (and their import graph) into an existing `stasis.code.br` instead of replacing it |
| `stasis bundle --conditions=react-native,browser app.js` | statically bundle, asserting extra `exports`/`imports` resolution conditions |
| `stasis bundle --mainFields=react-native,browser,main app.js` | statically bundle, honoring legacy package `mainFields` (incl. browser-field object redirection) |
| `stasis bundle --metro --platforms=ios,android app.js` | statically bundle the way Metro resolves: RN conditions + mainFields + `.ios`/`.android`/`.native` suffixes, all platforms at once, plus each bundled native dependency's `ios/`/`android/` sources + podspec |
| `stasis build --output=out.js app.stasis.code.br [entry]` | rebuild a runnable JS bundle with esbuild, following the bundle's recorded import graph exactly (entry optional when the bundle has one) |
| `stasis build --output=out.js stasis.lock.json [entry]` | same, reading + verifying sources from disk against the lockfile |
| `stasis extract app.stasis.code.br` | unpack a bundle back to sources + a `stasis.lock.json` |
| `stasis diff --stat a.lock.json b.stasis.code.br` | summarize module/file differences between two lockfiles/bundles |
| `stasis prune` | trim `node_modules` to the lockfile, verifying the rest |
| `stasis audit stasis.lock.json` | report npm advisories for a lockfile's dependencies |
| `stasis audit app.stasis.code.br` | report npm advisories for a bundle's dependencies |
| `stasis sbom --format=spdx stasis.lock.json` | export an SPDX SBOM for a lockfile or bundle |
| `stasis sbom --format=cyclonedx app.stasis.code.br` | export a CycloneDX SBOM for a lockfile or bundle |

## Runtime

The zero-dependency [`@exodus/stasis-core`](../stasis-core) CLI provides `run` and `prune` commands only; the bundler plugins live in [`@exodus/stasis-plugins`](../stasis-plugins).

## License

[MIT](./LICENSE)
