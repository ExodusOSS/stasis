# Bundler plugins

Stasis ships first-party plugins for three JavaScript bundlers:

| Bundler | Import | Capture | Load |
| --- | --- | --- | --- |
| esbuild | `@exodus/stasis/esbuild` → `StasisEsbuild` | ✅ | ✅ |
| webpack (4 & 5) | `@exodus/stasis/webpack` → `StasisWebpack` | ✅ | ✅ (limited) |
| Metro (React Native) | `@exodus/stasis/metro` → `StasisMetro` / `withStasis` | ✅ | ✅ via a separate worker transformer (`@exodus/stasis/metro-transformer`) |

A plugin produces (and, in load mode, consumes) the **same** `stasis.lock.json`
and `stasis.code.br` artifacts as `stasis run` — see
[file formats](../file-formats.md). The difference is *where* the module graph
is observed: `stasis run` watches Node's own module loader as your program
executes, whereas a bundler plugin watches the **bundler's** graph as it
resolves, loads, and bundles your app. That makes the plugins the way to attest
a build artifact: the exact set of source files and resolution edges that went
into the bundle your bundler emitted.

Per-bundler details, including each one's wiring and known gaps:

- [esbuild](./esbuild.md)
- [webpack](./webpack.md)
- [Metro](./metro.md)

The rest of this page covers what all three share.

## Capture vs. load

Every plugin operates in one of two directions, selected by the `bundle`/`lock`
mode (below) exactly like the CLI:

- **Capture** (`lock=add|replace|frozen`, `bundle=add|replace|frozen`, or
  `lock=none|ignore`): the plugin observes each file the bundler resolves, reads
  its bytes from disk, and records them — source content, resolution edges, and
  per-file [formats](../file-formats.md) — into the lockfile and/or bundle. A
  `frozen` mode verifies what it observes against the committed artifact instead
  of writing. This is the common case: build your app, capture what went in.
- **Load** (`bundle=load`): the plugin *serves* the bundle's attested bytes back
  into the build in place of reading disk. The on-disk file may differ or be
  absent — the bundle is the source of truth — and every served byte is
  re-hashed against the lockfile (when one is loaded) on the way through, so a
  tampered bundle fails closed. This mirrors `stasis run --bundle=load`. An
  in-scope source *file* the bundle doesn't carry is a hard error, never a silent
  disk fallback; Node built-ins and modules the bundler *externalizes* aren't
  carried as bundle edges, so load mode hands those back to the bundler's own
  resolver (a tampered bundle still can't redirect `fs` to an arbitrary file).

Load mode has bundler-specific wiring and gaps (Metro load is a *separate*
transformer, not this plugin; webpack has a residual `package.json`-resolution
gap) — see each bundler's page.

## Running under `stasis run` (recommended for lockfiles)

The plugins are designed to run **inside a build that is itself launched by
`stasis run`**:

```sh
stasis run --lock=add --scope=full scripts/build.mjs
```

```js
// scripts/build.mjs
import * as esbuild from 'esbuild'
import { StasisEsbuild } from '@exodus/stasis/esbuild'

await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true,
  outdir: 'dist',
  plugins: [new StasisEsbuild()], // inherits the run's lock/scope/bundle
})
```

When a build runs under `stasis run`, the stasis loader installs a process-wide
**preload** `State`. A plugin constructed with no (or matching) options detects
that preload and **reuses it**, so a *single* lockfile/bundle is written that
covers both graphs:

- the loader's view — the build tooling itself (the bundler, your config, their
  dependencies), and
- the plugin's view — the application modules the bundler pulled in.

This is why a plugin that wants to write a lockfile (`lock=add|replace|frozen`)
**requires** a preload: without one, the lockfile would silently miss every
dependency the bundler itself dragged in. A plugin asking for a lockfile with no
preload throws a clear error rather than producing a partial one.

Configuration comes from the same three sources as the CLI, in the same
precedence — `EXODUS_STASIS_*` env vars (which `stasis run` sets for the child),
an explicit constructor option, and `stasis.config.json`; if more than one sets
a key they must agree. See [file formats → `stasis.config.json`](../file-formats.md#stasisconfigjson).

## Running standalone (no `stasis run`)

You can also drop a plugin into an ordinary build with no stasis loader. Without
a preload the rules are:

- **Bundle-only** is fully supported — opt out of the lockfile and emit just a
  bundle:

  ```js
  new StasisEsbuild({ lock: 'none', bundle: 'add', bundleFile: 'app.stasis.code.br' })
  ```

  This captures only the bundled app (no build-tooling deps), which is exactly
  what a bundle of "what I shipped" should contain.

- **A standalone lockfile is refused.** `lock=add|replace|frozen` with no
  preload throws (it would miss the bundler's own dependencies) — run under
  `stasis run` instead. A plugin can't point at its own lockfile; the lockfile is
  always the run's (see coordination, below).

- **Inert opt-out**: `{ lock: 'none', bundle: 'none' }` makes the plugin a no-op
  that registers no hooks — handy for leaving the plugin wired into a shared
  config and toggling it off by env. (A *partial* opt-out — one field `'none'`,
  the other omitted — is rejected with a message telling you to set both.)

## Options

All three plugins take the same options as the loader and CLI. Anything unset
falls back to env (`EXODUS_STASIS_*`) / `stasis.config.json` / defaults.

| Option | Values | Meaning |
| --- | --- | --- |
| `scope` | `"full"` (default), `"node_modules"` | What the artifact covers. `node_modules` records only dependencies; app sources are left out (and, in load mode, served from disk). |
| `lock` | `"add"` (default), `"replace"`, `"frozen"`, `"ignore"`, `"none"` | Lockfile mode. `add` won't modify an existing lockfile; `replace` rebuilds it; `frozen` verifies disk against it; `ignore`/`none` write none. |
| `bundle` | `"add"`, `"replace"`, `"load"`, `"frozen"`, `"ignore"`, `"none"` | Bundle mode. Unset/`none` writes no `stasis.code.br`. `load` serves bundle bytes back into the build. |
| `bundleFile` | path | Where to write/read the bundle. Differing from a preload's bundle path produces a *sidecar* sharing the preload's lockfile. |
| `resourcesBundleFile` | path | Split layout: emit resources to this file and code to `bundleFile`. |
| `debug` | boolean | Verbose diagnostics. |
| `resources` | `string[]` | Allowlist of non-code asset extensions / extensionless filenames — see below. |

The `lock`/`bundle` mode semantics are identical to the CLI flags; the canonical
description lives in [file formats](../file-formats.md#stasisconfigjson). There is
**no per-plugin lockfile path** — a plugin always shares the run's lockfile; a
non-default location is set process-wide (the `EXODUS_STASIS_LOCK_FILE` env var or
loader config), not per-plugin.

## The `resources` allowlist

A bundler routinely pulls in non-JavaScript files — `.png`, `.svg`, `.css`,
fonts, a `LICENSE` — through its own asset loaders. Stasis classifies every file
the bundler resolves by its extension (or, for an extensionless file, its name):

- **Code** (`.js .mjs .cjs .ts .jsx .tsx .mts .cts .json`) is always tracked,
  with its loader format.
- **A resource** is tracked only if you opt it into `resources`, e.g.
  `new StasisWebpack({ resources: ['png', 'svg', 'css'] })`. An entry is a bare
  extension (`png`, `.png`) or an extensionless filename (`LICENSE`, `Makefile`);
  a dotted entry like `data.bin` is rejected (declare the extension `bin`
  instead). The file is stored in the same bundle as code, tagged `resource` (raw
  UTF-8, e.g. SVG) or `resource:base64` (binary) per file. Imports *to* a
  resource carry no resolution edge — only its bytes are attested.
- **Anything else is a hard error.** An unrecognized file fails the build with a
  message naming it, forcing you to either declare it a resource or stop
  importing it. This is deliberate: stasis never silently widens what it attests.

`resources` is a process-wide setting — a plugin option, the `--resources` flag,
`EXODUS_STASIS_RESOURCES` (comma-separated), or `stasis.config.json` — so a
plugin's allowlist must **agree** with an active preload's. Listing a code
extension is rejected (code is always tracked). The plugin does **not** emit the
asset — that stays your bundler's job (esbuild's `loader`, webpack's
`file-loader`/asset modules, Metro's asset pipeline); stasis only records its
bytes alongside.

## When artifacts are written

A plugin writes its lockfile/bundle only on a **clean** build:

- **esbuild** writes in `onEnd`, skipping if `result.errors` is non-empty.
- **webpack** writes in `compiler.hooks.done`, skipping if `stats.hasErrors()`.
- **Metro** writes after the serializer runs, which Metro only reaches once the
  whole graph has built successfully.

A failed build therefore never overwrites a good committed artifact with a
partial one. When the plugin is *reusing* the `stasis run` preload, the loader's
own `beforeExit`/`exit` hooks own the write instead, so the plugin stays out of
the way.

## State coordination (reference)

When a preload is active the plugin always **shares its lockfile** — it can't
specify its own — and these rules decide whether it reuses the preload State or
runs as a sidecar:

1. `lock`, `scope`, `debug`, and `resources` passed to the plugin must **agree**
   with the preload — a conflict throws rather than being silently overridden.
2. If the preload already writes a bundle, the plugin can't disable it and its
   `bundle` mode must match. Same `bundleFile` (or unset) → **reuse** the preload.
   A different `bundleFile` → a **sidecar** State that shares the preload's
   lockfile data (hashes, entries, modules) but writes its own bundle.
3. If the preload writes no bundle, a plugin that also wants none just reuses it
   for lockfile coverage; a plugin that wants a bundle must give an explicit
   `bundleFile` (→ sidecar).

Only the **bundle** can split off per-plugin; the lockfile stays unified. That
sidecar split is what lets webpack's load mode serve a loader's files from the
parent (preload) bundle while the app graph lives in the plugin's own bundle —
both validated against the one shared lockfile.
