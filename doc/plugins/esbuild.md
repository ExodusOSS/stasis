# esbuild plugin (`@exodus/stasis/esbuild`)

`StasisEsbuild` is an esbuild plugin that captures the module graph of an
esbuild build into a stasis lockfile and/or bundle — and, in load mode, serves a
bundle's attested bytes back into the build. See
[bundler plugins](./README.md) for the concepts shared across all three plugins
(capture vs. load, options, `resources`, running under `stasis run`).

```js
import * as esbuild from 'esbuild'
import { StasisEsbuild } from '@exodus/stasis/esbuild'

await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  format: 'esm',
  plugins: [new StasisEsbuild(/* { scope, lock, bundle, resources, ... } */)],
})
```

`new StasisEsbuild(options)` accepts the [shared option bag](./README.md#options).
With no options (or matching ones) it reuses the `stasis run` preload; run the
build under `stasis run --lock=add scripts/build.mjs` to write a unified
lockfile, or pass `{ lock: 'none', bundle: 'add', bundleFile: '…' }` to emit a
standalone bundle with no loader.

## How capture works

The plugin registers three esbuild hooks:

- **`onResolve` (namespace `file`)** re-runs esbuild's own resolver (via a
  synthetic `stasis` namespace so it doesn't re-enter the plugin), then
  classifies the resolved path by extension. A code import that isn't an entry
  records a resolution edge (`addImport`) keyed by the as-written specifier; an
  unknown extension errors unless opted into `resources`.
- **`onLoad` (namespace `file`)** reads the resolved file's bytes and records
  them (`addFile`). Code files must be valid UTF-8 (a code extension with
  non-UTF-8 bytes is rejected as malformed). It then returns the bytes to
  esbuild with the matching `loader` (`.cjs`/`.mjs`/`.cts`/`.mts` peel their
  leading letter to `js`/`ts`), so stasis sits transparently in front of
  esbuild's normal loading.
- **`onEnd`** writes the lockfile/bundle, but only when `result.errors` is empty
  (and only when not reusing the `stasis run` preload, which writes itself).

### Resources

Files you list in `resources` (an extension like `png`, or an extensionless
filename like `LICENSE`) are recorded for their bytes but **not** returned with a
loader — emitting them stays esbuild's job via the build's own `loader` config
(`file`, `dataurl`, `copy`, …), the same way a webpack `file-loader` runs
independently of stasis. An asset with no configured loader errors in esbuild, as
usual; that's your build's responsibility, not the plugin's.

```js
new StasisEsbuild({ resources: ['png', 'svg'] })
// build with: loader: { '.png': 'file', '.svg': 'file' }
```

### Sibling-plugin `suffix`

If another plugin returns a non-empty `suffix` on its resolve result (some
CSS-modules plugins do, to carry a query-style suffix), stasis **refuses it**
with an assertion: it can't persist suffixes to the bundle, and would rather
fail loudly at capture time than silently drop one. Disable that plugin for the
stasis build or have it drop the suffix.

## Load mode (`bundle=load`)

In load mode the plugin's `onResolve` resolves imports from the **bundle's
import map** instead of esbuild's resolver, and `onLoad` returns the bundle's
attested bytes (`getFile`, which re-verifies the hash against the lockfile)
rather than reading disk. The on-disk file need not exist. Resolved paths keep
their original absolute form, so esbuild's path-banner comments, asset names,
and source maps come out identical to a capture-mode build — a captured bundle
round-trips to byte-identical output.

Entry points are anchored to `cwd` just like `stasis run`, so even the entry
needn't be on disk; in `scope=full` the entry is checked against the bundle's
recorded `entries`.

Node **built-ins** (`fs`, `node:path`, …) and **externals** are handed back to
esbuild rather than resolved from the bundle: built-ins are skipped up front (so
the import map is never consulted for `fs`), and a specifier the bundle records
no edge for — an externalized module at a clean capture — returns `undefined` so
esbuild externalizes it as it would without the plugin. This relaxes only the
resolve-time edge lookup; a genuinely missing in-scope **file** still fails closed
at `onLoad`, so no disk fallback is introduced.

### Import attributes

Import attributes (`import data from './x.json' with { type: 'json' }`) are
forwarded symmetrically on both capture and load, so a plugin-captured bundle
reloads through the plugin. **Known gap:** a bundle captured by the *Node run
loader* keys attributed edges under specific conditions (`node, import, … (with:
…)`); the plugin's lookup is keyed under `*` and won't find those, so a
Node-loader-captured bundle that uses import attributes won't reload via the
esbuild plugin without further work. Only the `type` attribute is accepted;
anything else throws, since persisting other attributes isn't designed yet.
