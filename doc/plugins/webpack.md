# webpack plugin (`@exodus/stasis/webpack`)

`StasisWebpack` is a webpack plugin (works on **webpack 4 and 5**) that captures
the module graph of a webpack build into a stasis lockfile and/or bundle — and,
in load mode, serves a bundle's attested bytes back into the build. See
[bundler plugins](./README.md) for the concepts shared across all three plugins
(capture vs. load, options, `resources`, running under `stasis run`).

```js
const { StasisWebpack } = require('@exodus/stasis/webpack')

module.exports = {
  mode: 'none',
  target: 'node',
  entry: './src/index.js',
  output: { path: __dirname + '/dist', filename: 'bundle.js' },
  plugins: [new StasisWebpack(/* { scope, lock, bundle, resources, ... } */)],
}
```

`new StasisWebpack(options)` accepts the [shared option bag](./README.md#options).
With no options (or matching ones) it reuses the `stasis run` preload; run the
build under `stasis run --lock=add scripts/build.mjs` to write a unified
lockfile, or pass `{ lock: 'none', bundle: 'add', bundleFile: '…' }` to emit a
standalone bundle with no loader.

## How capture works

The plugin taps `normalModuleFactory`:

- **`afterResolve`** fires for every resolved module. The plugin reads the
  resolved on-disk path (`resourceResolveData.path`), skips anything synthetic
  (`data:` URIs, `null-loader` stubs, non-existent paths), classifies it by
  extension, reads its bytes, and records them. A code module that isn't an
  entry also records its resolution edge (`addImport`) keyed by the module's
  `rawRequest`. Code files must be valid UTF-8.
- **`compiler.hooks.done`** writes the lockfile/bundle, skipping if
  `stats.hasErrors()` (and skipping entirely when reusing the `stasis run`
  preload, which writes itself).

### Cross-version handling

The plugin papers over two webpack 4 vs. 5 differences so one code path serves
both:

- webpack 5 nests `rawRequest`/`resourceResolveData` under `data.createData`;
  webpack 4 hangs them off `data` directly. The plugin unwraps either shape.
- **Issuer attribution** (which parent an edge belongs to) is tiered most- to
  least-reliable. webpack 4's resolver can leave a *stale* `context.issuer` on
  the resolve data by the time `afterResolve` fires, so the plugin also taps
  `beforeResolve` and records the fresh issuer keyed (in a `WeakMap`) by the
  dependency object, preferring that value. This dodges a real webpack 4 bug
  (reproduced under 4.15.1 and 4.47.0) that would otherwise mis-bucket edges.

### Resources

Files you list in `resources` (an extension like `png`, or an extensionless
filename like `LICENSE`) are recorded for their bytes; the plugin does **not**
emit them — that stays your `file-loader`/asset-module config's job, running
independently of stasis. An unknown file throws with a message naming it.

```js
new StasisWebpack({ resources: ['png', 'svg', 'css'] })
```

## Load mode (`bundle=load`)

In load mode the plugin wraps `compiler.inputFileSystem` in a `Proxy` and taps
`beforeResolve`:

- **`inputFileSystem.readFile`/`stat`** for an in-scope path are served from the
  bundle (`getFile`, which re-verifies the hash against the lockfile) instead of
  disk. `stat` reports a synthetic file entry whose `size` is the source's byte
  length, or — for any **directory** the bundle records (an explicit capture, or
  one implied by a bundled descendant) — a synthetic directory entry, so the
  resolver's walk over intermediate directories short-circuits without touching
  disk. A `Proxy` (rather than a wrapper object) keeps webpack's
  `CachedInputFileSystem` internals — `readdir`, `lstat`, `purge`, … — working
  with `this` bound to the real fs.
- **`beforeResolve`** redirects an in-scope module's request to the absolute path
  the bundle's import map attests, so the resolver short-circuits without walking
  `node_modules` or trying extension fallbacks. Two requests are deliberately
  *not* redirected and defer to webpack: Node **built-ins** (`fs`, `node:path`,
  …; never bundled, and never consulted in the import map, so a tampered bundle
  can't redirect `fs` to a file) and **externals** — a request the bundle records
  no edge for, which at a clean capture means webpack externalized it (`electron`
  under an electron target, anything the target's externals preset covers, or a
  user `externals` entry). This relaxes only the resolve-time *edge* lookup;
  in-scope file **bytes** still fail closed at the `inputFileSystem` wrapper.

"In scope" depends only on bundle mode + scope, never on whether the path
happens to be in the bundle: an in-scope file the bundle is missing throws (a
resolution error), never falls back to disk. Out-of-scope paths (system files,
and in `node_modules` scope the app sources) defer to disk.

### Crossing `node_modules`

A load build can resolve through `node_modules` as long as every path the
resolver touches is attested — files **and** the intermediate directories it
stats while walking. When the build ran under `stasis run`, the build-time
machinery the resolver needs (webpack loaders like `babel-loader`/`ts-loader` and
the directories along their resolution path) was captured by the loader alongside
the app graph.

If the plugin writes its **own** `bundleFile`, that layout is a
[sidecar](./README.md#state-coordination-reference): the app graph lives in the
plugin's bundle and the loaders/build closure in the **parent** (preload) bundle,
both under the one shared lockfile. Load then consults the whole **family**
(sidecar first, then parent), serving each path from whichever bundle carries it.
In the reuse case — one unified bundle — the family is just that bundle.

> [!IMPORTANT]
> **Residual gap:** every path the resolver touches must be attested by *some*
> family bundle. Intermediate-directory stats are now covered (including
> directories implied by a parent-bundle file, e.g. a loader's directory). What
> remains uncovered is the dependency `package.json` files webpack's resolver
> reads via `fs.readFile` through its `DescriptionFilePlugin`: the Node run loader
> captures the modules Node *imports*, not arbitrary resolver `fs.readFile` calls,
> so a `package.json` no family bundle carries still fails closed. Capturing those
> (or a description-file shortcut) is the remaining work — see the skipped TODO in
> `tests/webpack.test.js`. Capture mode and the lockfile/`frozen` flows have no
> such restriction.
