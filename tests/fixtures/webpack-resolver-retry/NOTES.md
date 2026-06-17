# webpack@4 resolver "Conflict for X" investigation

## Observed symptom
Stasis (StasisWebpack capture mode) throws a `noupsert` conflict for an
`(parent, specifier)` edge in the lockfile's `imports` map -- the same edge
gets recorded twice with different resolved targets:

```
./node_modules/path-to-regexp/index.js
Module not found: AssertionError [ERR_ASSERTION]: Conflict for "isarray"
actual:    'src/node_modules/has-binary2/node_modules/isarray/index.js'
expected:  'src/node_modules/isarray/index.js'
```

Deterministic across runs. Webpack version: 4.15.1.

## What we learned

1. **`afterResolve` fires multiple times per edge in webpack 4.**
   Tracing every `nmf.hooks.afterResolve` event during a real build (with
   `import '@exodus/ethereumjs/tx'` as entry, transpiled via babel-loader)
   shows the same `(issuer, rawRequest)` edge firing 2-7 times within a
   single compilation -- not a stasis bug, the resolver invokes the
   factory multiple times for the same dependency in the graph.

2. **`unsafeCache` default keys WITHOUT the importer's context.**
   `WebpackOptionsDefaulter.js`'s `resolve.cacheWithContext` default is:

   ```js
   options.resolve.plugins?.length > 0
   ```

   So the COMMON case (no custom `resolve.plugins`) → `cacheWithContext =
   false`. `UnsafeCachePlugin.getCacheId` then omits `request.context` from
   the cache key, leaving `{path, query, request}` as the key.
   `request.path` is the directory the resolver is currently searching;
   two edges that start the walk from the same directory share a cache
   entry even with different importers.

3. **The synthetic fixture in this dir does NOT reproduce the conflict.**
   With top-level `isarray@2`, `has-binary2` (nested `isarray@1`), and
   `path-to-regexp`, and the `import '@exodus/ethereumjs/tx'` chain via
   babel-loader, 107 afterResolve events fire, many of them multi-firings
   for the same edge -- but all multi-firings return the SAME target,
   so no noupsert conflict.

## Hypothesis

For the noupsert to fire, two `afterResolve` firings for the same
`(issuer, rawRequest)` must return DIFFERENT `data.resourceResolveData.path`
values. With cacheWithContext=false this happens when:

- two edges share the SAME `request.path` (resolver-search-from
  directory) for the same `request` string, AND
- they should resolve to DIFFERENT files (because the resolution then
  walks up through different node_modules trees), AND
- the first firing's result poisons the cache for the second.

What's missing to reproduce is the trigger that makes `request.path`
coincide between the two distinct edges. Candidates:

- a custom `resolve.modules: ['./src/node_modules', 'node_modules']`-style
  config that makes the resolver walk a shared "modules root";
- a loader-context resolution (e.g. `babel-loader` resolving a config
  reference) firing afterResolve with a context different from the
  source module;
- `resolve.alias` redirecting one of the two packages to a path that
  shares an ancestor with the other.

## Next step

Need the user's webpack `resolve.*` config (especially `resolve.modules`,
`resolve.plugins`, `resolve.alias`, `resolve.symlinks`, and any plugins
that tap `normalModuleFactory.hooks.afterResolve`) to extend the fixture
until the cache-poisoning condition triggers. The diagnostic script at
`tests/repro-resolver-retry.mjs` already groups by `(issuer, request)`
and flags distinct targets -- once the fixture reproduces, the conflict
will appear there as a `!!! distinct targets:` line.
