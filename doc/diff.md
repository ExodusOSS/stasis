# `stasis diff`

`stasis diff` compares two stasis artifacts — lockfiles (`stasis.lock.json`)
and/or bundles (`stasis.code.br`), in any combination — and reports what changed
at both the **module** (package) and the **file** level.

```sh
stasis diff --stat [--imports] path/to/(lockfile|bundle) path/to/(lockfile|bundle)
```

| Flag | Meaning |
| - | - |
| `--stat` (**required** for now) | Print a summary of *what* changed — added/removed/changed modules and added/removed/differing files — rather than the differing file contents. |
| `--imports` (optional) | Also diff the **resolution graphs**: which import edges were added, removed, or redirected (see below). Off by default because the edge list is verbose. |

`--stat` is the only mode today, and must be requested explicitly because a future
content-level diff will take over the bare `stasis diff` invocation. Pass exactly
two positional arguments: the baseline (`from`) and the comparison (`to`), in that
order.

The command exits **0** when the two artifacts are equivalent and **1** when they
differ (a read/parse error also exits non-zero), so it composes in CI — e.g.
failing a build when a shipped bundle has drifted from its committed lockfile.

## Comparing across kinds (lockfile vs bundle)

A lockfile records each file as an SRI digest (`sha512-<base64>`); a bundle records
the actual bytes. `stasis diff` re-hashes each bundle file into that same digest —
code and raw-UTF-8 `resource` files hash their text directly, `resource:base64`
files are decoded from base64 first — while a lockfile's digest is used as-is. Both
sides thus land in one digest space, so a file that is byte-identical in both never
shows up as a difference, whichever kind each side is.

## What it reports

**Modules** (whole-package granularity):

- **added** / **removed** — a package directory present on only one side (the
  workspace `"."` bucket, a `node_modules/<pkg>` dependency, …). The entry carries
  the package `name@version` and how many files it contributes.
- **changed** — a package present on both sides whose `name` or `version` differs
  (a dependency upgrade is the common case), reported only when both sides actually
  record one. A legacy `version: 0` bundle records neither, so it is never flagged
  as a spurious change.

**Files** (within packages present on **both** sides):

- **added** / **removed** — a file that appears or disappears inside a package that
  exists on both sides.
- **differing** — a file present on both sides whose content digest differs.

The two levels are complementary: a package on only one side is counted once as an
added/removed **module** (with its file count) and its files are *not* re-listed
under Files. The file section is the granular churn *within* packages that survived
on both sides — where a dependency upgrade's real changes show. So the `Files
(within shared modules): …` count is scoped to shared packages: remove a whole
200-file dependency and it shows as `- pkg (200 files)` under **Modules** while the
Files line stays `0 removed`.

Output uses diff-style markers:

| Marker | Meaning |
| - | - |
| `-` | only in the first (baseline) file |
| `+` | only in the second file |
| `*` | changed in place |

## Import resolutions (`--imports`)

Both lockfiles and bundles record a **resolution graph**: per condition set, which
file every `(parent, specifier)` import resolved to. `--imports` compares these at
the **resolution** level — the set of files each `(parent, specifier)` resolves to
— and reports each one that was:

- **removed** — resolved only by the first artifact;
- **added** — resolved only by the second;
- **changed** — resolved on both sides but to a *different* file (a **redirect**).

A redirect is a real difference even when every file hash is unchanged — a specifier
now points at a different, still-hash-valid file, which a byte-level diff can't see
— so `--imports` makes `stasis diff` exit non-zero on it.

The comparison folds the *conditions* dimension away on purpose: a statically built
bundle (`stasis bundle`) records every edge under the wildcard `"*"`, while a
runtime lockfile records precise condition sets like `"node, import"`. Comparing
resolved targets per `(parent, specifier)`, rather than raw edge keys, lets a
`stasis bundle` artifact and a runtime lockfile compare cleanly — only a genuine
redirect shows, not a relabeled condition.

When either side doesn't attest resolutions — a lockfile written before stasis
recorded `imports` (a bundle always carries an `imports` map) — the import diff is
skipped with a note rather than reporting one side's whole graph as added.

## Scope differences

Each artifact records its `scope` (`full` or `node_modules`); `stasis diff` compares
whatever each side records and notes a scope mismatch in the header. Diffing a
`scope = full` lockfile against a `scope = node_modules` bundle reports the
workspace/first-party packages as **removed** modules, because the `node_modules`
side omits them by design — the note calls this out so it isn't mistaken for real
drift. Likewise, diffing a full lockfile (every file, code and binary resources
alike) against a `stasis.code.br` (code only) surfaces the resource files as
**removed** within their packages — the bundle genuinely doesn't carry them.

## Programmatic API (`@exodus/stasis/diff`)

The diff is also a library, exported as `@exodus/stasis/diff`. Like
`@exodus/stasis/sbom`, it operates on already-parsed `@exodus/stasis-core`
`Bundle`/`Lockfile` instances and pulls in **no disk, brotli (`node:zlib`), or
crypto (`node:crypto`)**: the caller supplies the artifacts (each paired with its
`kind`) and, to compare a bundle, the **hash function** that re-hashes its bytes
into a lockfile-style digest.

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
  shared digest space (`kind` is `'lockfile' | 'bundle'`; `hash` re-hashes bundle
  bytes and is required for bundles).
- `diffArtifacts(left, right, { hash, imports })` — the structured
  `{ scope, modules, files, imports? }` report (`left` is the baseline; `imports`
  is included only when `imports: true`).
- `hasDifferences(diff)` — whether any module/file/import edge changed.
- `formatDiffStat(diff, labels)` — render the `--stat` summary string (the whole
  report, including the trailing `Artifacts differ` / `No differences` line, goes to
  stdout).

The `stasis diff` CLI is the thin file-reading wrapper around this API: it brings in
brotli (to read `.br` bundles off disk) and injects `sha512integrity` as the hash.
