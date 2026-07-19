# `stasis diff`

`stasis diff` compares two stasis artifacts — lockfiles (`stasis.lock.json`)
and/or bundles (`stasis.code.br`), in any combination — and reports what changed
at both the **module** (package) and the **file** level.

```sh
stasis diff --stat [--imports] path/to/(lockfile|bundle) path/to/(lockfile|bundle)
```

| Flag | Meaning |
| - | - |
| `--stat` (**required** for now) | Print a summary of *what* changed — added/removed/changed modules and added/removed/differing files — not the differing contents. |
| `--imports` (optional) | Also diff the **resolution graphs**: added/removed/redirected import edges (see below). Off by default (verbose). |

`--stat` is the only mode today and must be explicit (a future content-level diff
will take over the bare invocation). Pass exactly two positionals: the baseline
(`from`) then the comparison (`to`).

Exits **0** when equivalent, **1** when they differ (a read/parse error also
exits non-zero), so it composes in CI.

## Comparing across kinds (lockfile vs bundle)

A lockfile records each file as an SRI digest (`sha512-<base64>`); a bundle
records the bytes. `stasis diff` re-hashes each bundle file into that same digest
(`resource:base64` decoded first), so both sides land in one digest space and a
byte-identical file never shows as a difference.

## What it reports

**Modules** (whole-package granularity):

- **added** / **removed** — a package directory present on only one side (the
  workspace `"."` bucket, a `node_modules/<pkg>` dependency, …). Carries the
  package `name@version` and its file count.
- **changed** — a package on both sides whose `name` or `version` differs,
  reported only when both sides record one. A legacy `version: 0` bundle records
  neither, so it is never flagged.

**Files** (within packages present on **both** sides):

- **added** / **removed** — a file that appears or disappears inside a shared package.
- **differing** — a file present on both sides whose content digest differs.

The Files count is scoped to shared packages: a package on only one side is
counted once as an added/removed **module** (with its file count) and its files
are *not* re-listed. So removing a whole 200-file dependency shows as
`- pkg (200 files)` under **Modules** while the Files line stays `0 removed`.

| Marker | Meaning |
| - | - |
| `-` | only in the first (baseline) file |
| `+` | only in the second file |
| `*` | changed in place |

## Import resolutions (`--imports`)

Both lockfiles and bundles record a **resolution graph**: per condition set,
which file every `(parent, specifier)` import resolved to. `--imports` compares
the set of files each `(parent, specifier)` resolves to and reports each one:

- **removed** — resolved only by the first artifact;
- **added** — resolved only by the second;
- **changed** — resolved on both sides but to a *different* file (a **redirect**).

A redirect is a real difference even when every file hash is unchanged, so
`--imports` exits non-zero on it. The *conditions* dimension is folded away:
comparing resolved targets per `(parent, specifier)` rather than raw edge keys
lets a statically built `"*"` bundle and a runtime lockfile's precise condition
sets (e.g. `"node, import"`) compare cleanly. When either side doesn't attest
resolutions (a lockfile written before stasis recorded `imports`) the import diff
is skipped with a note.

## Scope differences

Each artifact records its `scope` (`full` or `node_modules`); a mismatch is noted
in the header. Diffing a `full` side against a `node_modules` side reports
workspace/first-party packages as **removed** modules (omitted by design);
diffing a full lockfile against a code-only `stasis.code.br` surfaces resource
files as **removed** within their packages. The header note flags these so they
aren't mistaken for drift.

## Programmatic API (`@exodus/stasis/diff`)

Exported as `@exodus/stasis/diff`. It operates on already-parsed
`@exodus/stasis-core` `Bundle`/`Lockfile` instances and pulls in **no disk,
brotli (`node:zlib`), or crypto (`node:crypto`)**: the caller supplies the
artifacts (each paired with its `kind`) and, to compare a bundle, the **hash
function** that re-hashes its bytes into a lockfile-style digest.

```js
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state.util'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '@exodus/stasis/diff'

const lock = { artifact: Lockfile.parse(lockText), kind: 'lockfile' }
const bundle = { artifact: Bundle.parse(bundleJson), kind: 'bundle' } // you read/decompress it yourself

// `hash` is required when a bundle is involved; a lockfile↔lockfile diff omits it.
const diff = diffArtifacts(lock, bundle, { hash: sha512integrity, imports: true })
if (hasDifferences(diff)) console.log(formatDiffStat(diff, { left: 'a', right: 'b', leftKind: 'lockfile', rightKind: 'bundle' }))
```

- `normalizeArtifact({ artifact, kind }, { hash })` — project an artifact onto the
  shared digest space (`kind` is `'lockfile' | 'bundle'`; `hash` required for bundles).
- `diffArtifacts(left, right, { hash, imports })` — the structured
  `{ scope, modules, files, imports? }` report (`left` is the baseline; `imports`
  included only when `imports: true`).
- `hasDifferences(diff)` — whether any module/file/import edge changed.
- `formatDiffStat(diff, labels)` — render the `--stat` summary string.

The `stasis diff` CLI is the thin file-reading wrapper around this API: it brings
in brotli (to read `.br` bundles off disk) and injects `sha512integrity` as the hash.
