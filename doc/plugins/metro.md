# Metro plugin (`@exodus/stasis/metro`)

`StasisMetro` captures the module graph of a Metro build (React Native) into a
stasis lockfile and/or bundle. Unlike the esbuild and webpack plugins, **capture
and load are wired separately** in Metro:

- **Capture** is a serializer — `@exodus/stasis/metro` (`StasisMetro` /
  `withStasis`).
- **Load** is a worker transformer — `@exodus/stasis/metro-transformer` —
  documented at the bottom of this page.

See [bundler plugins](./README.md) for the concepts shared across all three
plugins (capture vs. load, options, `resources`, running under `stasis run`).

## Capture: wiring the serializer

The recommended surface is `withStasis`, an idiomatic Metro-config wrapper (in
the spirit of `withNativeWind` / `withSentryConfig`):

```js
// metro.config.js
const { withStasis } = require('@exodus/stasis/metro')

module.exports = withStasis(require('./metro.config.base'), {
  /* scope, lock, bundle, resources, ... */
})
```

`withStasis(config, options)` returns a **new** config (it doesn't mutate the
input) with `serializer.customSerializer` wired so stasis captures the graph and
then your existing `customSerializer` (or Metro's default output) still produces
the bundle. `options` is the [shared option bag](./README.md#options).

For manual wiring, build the serializer yourself:

```js
const { StasisMetro } = require('@exodus/stasis/metro')
const stasis = new StasisMetro(options)

module.exports = {
  serializer: {
    customSerializer: stasis.customSerializer(/* existing customSerializer? */),
  },
}
```

### Why the serializer, and what it covers

Metro transforms each file in a pool of **worker** processes, but a stasis
`State` is process-local — observations made in a worker never reach the writer.
Metro's `customSerializer` runs **once, in the main process, after the whole
graph is built**, with every module and resolution edge in hand. That's the one
place a single `State` can see the complete graph (mirroring webpack's
`afterResolve` and esbuild's `onResolve`/`onLoad`, which also run in the
bundler's main process).

`customSerializer` is also the only stable Metro surface that receives
`preModules` — the polyfills/runtime Metro prepends to every bundle (real
shipped files). `withStasis` and `customSerializer` capture those;
`serializerHook` does not (see below).

The serializer reads each module's path off the graph, skips synthetic/virtual
modules (a `require.context` `?ctx=` module, `__prelude__`, anything not an
existing absolute file), classifies by extension, reads bytes from disk, and
records files and their code-to-code resolution edges. As with the other
plugins, code files must be valid UTF-8, and an unknown file throws unless its
extension or filename is opted into `resources`.

### The experimental hook (lower coverage)

```js
serializer: { experimentalSerializerHook: stasis.serializerHook }
```

`serializerHook` taps `experimentalSerializerHook`, which is observation-only
(Metro ignores its return value, so stasis produces no output of its own).
**Lower coverage:** Metro never passes `preModules` to this hook, so the
prepended polyfills/runtime go unattested. Prefer `withStasis` /
`customSerializer`.

### Writing

The serializer writes the lockfile/bundle after capturing — Metro only reaches
serialization once the graph has built and transformed successfully, so this is
the clean-build gate (the equivalent of webpack's `stats.hasErrors()`). In
watch/dev mode it fires on every rebuild; `State.write`'s per-artifact
compare-and-skip makes an unchanged graph a cheap no-op. When reusing the
`stasis run` preload, the loader writes instead.

### `resources`

Asset imports (`import logo from './logo.png'`) are captured for their bytes
when their extension (or filename) is in `resources`; emitting them stays Metro's
asset pipeline's job.

```js
withStasis(config, { resources: ['png', 'svg'] })
```

### Known coverage gaps (Metro-specific)

- **Scaled asset variants.** `import x from './logo.png'` is one module in
  Metro's graph, keyed by the base path; Metro discovers `logo@2x.png` / `@3x`
  through its `AssetData` (parallel scales/files arrays), not as separate graph
  modules — so only the base file is attested. Assets pulled in by the *native*
  build via `react-native.config.js` (e.g. fonts through `react-native-asset`)
  aren't in Metro's JS graph at all and aren't covered.
- **Platform-specific lockfiles.** Edges are recorded under the as-written
  specifier (`'./Foo'`) resolved to the platform variant Metro picked
  (`Foo.ios.js`), all under the `*` conditions key. A lockfile captured for one
  platform won't match a `frozen` run for another — capture and verify per
  platform. It fails **closed** (rejects a mismatched resolution, never silently
  accepts one).

### Capture rejects `bundle=load`

The serializer is the capture half only; in `bundle=load` it throws, pointing
you at the worker transformer instead. Capture modes — `lock`/`bundle`
`add`/`replace`/`frozen`, and `lock=none`/`ignore` — all work.

## Load: the worker transformer (`@exodus/stasis/metro-transformer`)

Load is the mirror image of capture: it only ever **reads** an immutable bundle,
and every worker reads the same bytes, so there's nothing to synchronize between
workers. That makes the per-worker **transformer** the natural seam — each
worker independently serves attested bytes, no IPC. Wire it in load mode only,
and do **not** also wire the `StasisMetro` serializer:

```js
// metro.config.js (load mode)
module.exports = {
  transformer: {
    transformerPath: require.resolve('@exodus/stasis/metro-transformer'),
  },
}
```

Run with `EXODUS_STASIS_BUNDLE=load` (plus `EXODUS_STASIS_BUNDLE_FILE` / `_LOCK`
/ `_SCOPE`), or a `stasis.config.json` with `"bundle": "load"`. In any other
mode the transformer is a transparent pass-through, so it's safe to leave wired
permanently.

The transformer wraps your real transformer — Metro's default
`metro-transform-worker`, or override via
`EXODUS_STASIS_METRO_BASE_TRANSFORMER` — and, in load mode, replaces the file's
`data` with the bundle's attested bytes (`getFile`, hash-verified, fail-closed)
before delegating. So the transform consumes bundle bytes: a tampered on-disk
source is ignored for the output and, under a lockfile, rejected; an in-scope
file the bundle doesn't carry throws; out-of-scope files pass their disk bytes
through untouched. Its `getCacheKey` folds in the base transformer's key and a
load-mode discriminator so load results never cross-pollinate a plain build's
transform cache.

> [!IMPORTANT]
> **Known limitation:** this does **not** let Metro build with the sources fully
> absent from disk. Metro reads each file from disk in the worker (and hashes it
> in the main process for its transform cache) *before* this transformer runs,
> and resolves `package.json` via its own fs. Serving those reads from the
> bundle would need fs interception across the main and worker processes
> (`stasis --mock` territory), which is larger than this seam. Today's guarantee
> is "build the bundle's attested bytes, fail closed on disk drift," not "build
> from a bundle with no source tree" — mirroring the webpack `node_modules`
> crossing gap.
