# `stasis diff`

`stasis diff` compares two stasis artifacts — lockfiles (`stasis.lock.json`)
and/or bundles (`stasis.code.br`, `stasis.resources.br`) — and reports what
changed between them, at both the **module** (package) and the **file** level.
Either side may be a lockfile or a bundle, in any combination, so a lockfile and
a bundle can be diffed directly.

```sh
stasis diff --stat path/to/(lockfile|bundle) path/to/(lockfile|bundle)
```

- `--stat` (**required** for now): print a summary of *what* changed — the lists
  of added/removed/changed modules and added/removed/differing files — rather
  than the differing file contents. It is the only mode today; a future
  content-level diff will take over the bare `stasis diff` invocation, which is
  why `--stat` must be requested explicitly.
- Exactly two positional arguments: the baseline (`from`) and the comparison
  (`to`), in that order.

The command exits **0** when the two artifacts are equivalent and **1** when
they differ, so it composes in CI — e.g. failing a build when a shipped bundle
has drifted from its committed lockfile. (A read/parse error exits non-zero
too.)

## Comparing across kinds (lockfile vs bundle)

A lockfile records each file as an SRI digest (`sha512-<base64>`); a bundle
records the file's actual bytes. To compare the two, `stasis diff` re-hashes a
bundle's bytes into the very digest a lockfile would have recorded, so both
sides end up in the same digest space:

- a **code bundle** stores UTF-8 source text, hashed directly;
- a **resource bundle** stores base64-encoded blobs, decoded back to their raw
  bytes before hashing;
- a **lockfile** already holds the digest, used as-is.

This is what the headline "you can always tell whether a file is the same
between a bundle and a lockfile by rehashing the bundle" guarantee rests on: a
file present in both, with byte-identical content, never shows up as a
difference, regardless of which kind each side is.

## What it reports

**Modules** (whole-package granularity):

- **added** / **removed** — a package directory present on only one side (the
  workspace `"."` bucket, a `node_modules/<pkg>` dependency, …). The entry
  carries the package `name@version` and how many files it contributes.
- **changed** — a package present on both sides whose `name` or `version`
  differs (a dependency upgrade is the common case). A version/name change is
  only reported when both sides actually record one; a legacy `version: 0`
  bundle records neither, so it is never flagged as a spurious change.

**Files** (within packages present on **both** sides):

- **added** / **removed** — a file that appears or disappears inside a package
  that exists on both sides.
- **differing** — a file present on both sides whose content digest differs.

The two levels are complementary, not redundant: a package that exists on only
one side is reported once as an added/removed **module** (with its file count),
and its individual files are *not* also re-listed under the file section. The
file section is therefore exactly the granular churn *within* packages that
survived — which is where a dependency upgrade's real changes show up.

Output uses diff-style markers: `-` for "only in the first (baseline) file",
`+` for "only in the second", and `~` for "changed in place".

## Scope differences

Each artifact records its `scope` (`full` or `node_modules`). `stasis diff`
compares whatever each side records and notes a scope mismatch in the header.
Diffing a `scope = full` lockfile against a `scope = node_modules` bundle, for
example, will report the workspace/first-party packages as **removed** modules,
because the `node_modules`-scope side deliberately omits them — the note calls
this out so it isn't mistaken for real drift.

Likewise, diffing a full lockfile (which records *every* file, code and binary
resources alike) against a `stasis.code.br` (code only) surfaces the resource
files as removed within their packages — the bundle genuinely doesn't carry
them.

## Programmatic API (`@exodus/stasis/diff`)

The diff is also a library, exported as `@exodus/stasis/diff`. Like
`@exodus/stasis/sbom`, it operates on already-parsed `@exodus/stasis-core`
`Bundle`/`Lockfile` instances and never touches disk or brotli — the caller
supplies the artifacts (paired with their `kind`):

```js
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '@exodus/stasis/diff'

const lock = { artifact: Lockfile.parse(lockText), kind: 'lockfile' }
const code = { artifact: Bundle.parseCode(bundleJson), kind: 'code' } // you read/decompress it yourself

const diff = diffArtifacts(lock, code)
if (hasDifferences(diff)) console.log(formatDiffStat(diff, { left: 'a', right: 'b', leftKind: 'lockfile', rightKind: 'code' }))
```

- `normalizeArtifact({ artifact, kind })` — project an artifact onto the shared
  digest space (`kind` is `'lockfile' | 'code' | 'resources'`).
- `diffArtifacts(left, right)` — the structured `{ scope, modules, files }`
  report (`left` is the baseline).
- `hasDifferences(diff)` — whether any module/file changed.
- `formatDiffStat(diff, labels)` — render the `--stat` summary string.

The `stasis diff` CLI is the thin file-reading wrapper around this API — it is
the layer that brings in brotli, to read `.br` bundles off disk.
