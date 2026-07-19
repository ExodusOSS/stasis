# `stasis prune`

`stasis prune` (also exported as `@exodus/stasis/prune`) constrains an
installed `node_modules` tree to the files recorded in
`stasis.lock.json`.

```json
// package.json
{ "scripts": { "postinstall": "stasis prune" } }
```

`prune` walks `node_modules`, keeps and verifies (sha512) every file listed in
the lockfile, rewrites recognised modules' `package.json` down to a minimal
field set (below), prunes everything else (including `package.json` files under
directories the lockfile doesn't list), and fails if a lockfile-listed file is
missing on disk. Planning and disk mutation are separated: any error aborts
before a single `unlink` or rewrite runs.

## `package.json` rewriting

`package.json` contents aren't recorded in the lockfile, yet they're
load-bearing for resolution — unattested content `prune` can't trust verbatim.
So it overwrites each one with only the fields needed to resolve and load the
package, dropping everything else (`scripts`, `dependencies`, `engines`,
`config`, …) as unneeded — and, for `scripts`, as attack surface:

| Field | Handling |
| --- | --- |
| `name`, `version` | Taken from the **lockfile**, not disk — the attested source of the package's identity. |
| `license` | Copied only if an ASCII string shorter than 64 bytes. |
| `type` | Copied only if exactly `"module"` or `"commonjs"`. |
| `main`, `module`, `jsnext:main`, `jsnext`, `source`, `browser`, `react-native`, `bin`, `sideEffects`, `exports`, `imports` | Copied, but filtered so every file referenced is one the lockfile records for that module — a rewritten manifest never points resolution at a path `prune` is about to delete. See below. |

Filtering rules for that last group:

- `jsnext:main`/`jsnext` (Vite's default `mainFields`) and `source` (Parcel,
  Metro/React Native) are legacy/framework entry points, kept on the same
  present-file basis as `main`/`module`.
- `exports`/`imports` targets are matched verbatim (Node applies no
  extension/index resolution to them); `main`/`module`/`browser`/`bin` get
  Node's extension/index expansion.
- `sideEffects` also accepts a boolean.
- `browser`/`react-native` keep `false` stubs and bare-module targets; `imports`
  keeps bare specifiers; `exports` keeps neither. Subpath patterns (`./*`) are
  kept as-is; targets that escape the module (`..` or absolute) are dropped.
- A field that filters down to nothing is dropped entirely (never emitted as an
  empty `{}`/`[]`).

Two cases are kept as-is rather than minimised:

- A `package.json` that **is** in the lockfile's file list — imported directly
  (e.g. `require('pkg/package.json')`), so its bytes are attested — is
  hash-verified and kept in full.
- A **nested** `package.json` (e.g. a `dist/cjs/package.json` of
  `{"type":"commonjs"}` that flips the module system for a subtree) carries no
  package identity, so it's reduced to the fields that govern resolution *within*
  the subtree — `type`, the directory entry points
  `main`/`module`/`browser`/`react-native`, and `exports`/`imports` — filtered
  (relative to the nested dir) to present files. Dropping them, as a naive prune
  would (their dir isn't a recorded module), would silently revert that subtree's
  `.js` files to the package root's module system and break `require('pkg/subdir')`
  and `#imports` resolution within it.

Rewriting is idempotent: re-running `prune` produces byte-identical
`package.json` files. Each is rewritten by **replacing** the file (write a new
file, then rename over it), never in place: a pnpm-installed `package.json` is
typically a hardlink into pnpm's store, so an in-place write would mutate the
shared inode. The rename creates a fresh inode and leaves the store copy
untouched.

## Symlinks

`prune` leaves a symlink in place only when its real target stays **inside
`node_modules`** — prune's entire attestation perimeter (it walks and hashes
`node_modules`, nothing else). pnpm's public `node_modules/<pkg>` entries link
into `node_modules/.pnpm/...`, whose real files `prune` walks and attests
directly, so the link itself needs no validation; unreferenced store files are
pruned like any other untracked file, and a pre-existing dangling link is left
as-is. A symlink whose target **escapes** `node_modules` — even to a workspace
package elsewhere under the bundle root — is refused: leaving it would make
unattested content reachable from the pruned tree. `prune` aborts during
planning, before touching disk.

## pnpm workspaces

When run in a pnpm workspace root — detected by a `pnpm-workspace.yaml` —
`prune` adjusts:

- It covers **every** package's `node_modules` (each workspace package's, plus
  the root's), discovered by walking the workspace (never descending into a
  `node_modules`, a dotdir, or outside the root).
- The symlink containment boundary widens from `node_modules` to the **whole
  workspace**. A workspace dependency that links to a sibling package's source
  directory — outside any `node_modules` but inside the workspace — is left in
  place, its target **not** content-validated (workspace sources are
  first-party, not attested deps). A link whose target escapes the workspace root
  is still refused.
- It still only ever deletes files **inside a `node_modules`** — workspace source
  files are never touched — and never accesses anything outside the workspace
  root.

`prune` also rejects up front if pnpm's `enableGlobalVirtualStore` is turned on
(checked via the `npm_config_enable_global_virtual_store` env var pnpm exports):
`node_modules` is then dominated by symlinks into a shared store, making the
lockfile-vs-disk comparison meaningless.
