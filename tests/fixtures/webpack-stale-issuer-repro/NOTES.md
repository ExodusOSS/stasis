# webpack 4 `resourceResolveData.context.issuer` staleness — root cause

## What this fixture reproduces

A topology where stasis's `StasisWebpack` plugin would (in capture mode)
record a `noupsert` conflict for a single `(parent, specifier)` edge --
the same edge gets recorded twice with different resolved targets.

The shape:

```
node_modules/
  bs58/                 (top: v3)
  base58check/          (top: v2, requires bs58 -> top)
  example/              (symlink to ../example)
example/
  index.js              (requires bs58 + base58check)
  node_modules/
    bs58/               (middle: v6)
    base-x/             (middle)
```

`example/index.js`:

```js
require('bs58')          // resolves to MIDDLE (example/node_modules/bs58@6)
require('base58check')   // resolves to TOP (node_modules/base58check)
```

Then `node_modules/base58check/index.js` does `require('bs58')` which
resolves to TOP (node_modules/bs58@3). Two distinct edges:

- `(example/index.js, 'bs58')          -> middle`
- `(base58check/index.js, 'bs58')      -> top`

## What goes wrong

Tracing `normalModuleFactory.hooks.beforeResolve` AND
`normalModuleFactory.hooks.afterResolve` for the same compilation:

```
BEFORE: 'bs58'  contextInfo.issuer = example/index.js              ← correct
AFTER : 'bs58'  rrd.context.issuer = example/index.js  rrd.path = middle ← correct
BEFORE: 'bs58'  contextInfo.issuer = node_modules/base58check/index.js   ← correct
AFTER : 'bs58'  rrd.context.issuer = example/index.js  rrd.path = top    ← STALE issuer!
```

`beforeResolve` for base58check's `'bs58'` sees the correct
`contextInfo.issuer = base58check/index.js`. But by the time
`afterResolve` fires, `data.resourceResolveData.context.issuer` has been
reused from the *previous* resolver invocation -- `example/index.js`.
`rrd.path` (the actual resolved file) is still correct: top-level bs58.

Stasis's capture plugin (stasis-core/src/webpack.js) reads
`data.resourceResolveData.context.issuer` as the parent for `addImport`.
With the stale value, both edges land under
`(example/index.js, 'bs58')`, but with different targets -- noupsert
throws the "Conflict for X" error.

## Is the webpack bundle itself wrong? No.

`rrd.path` (what webpack actually uses to load the module) is correct in
both events. Webpack-produced bundles are not affected at runtime --
base58check correctly gets top-level bs58@3, example/index.js correctly
gets middle bs58@6. Only plugins that READ `rrd.context.issuer` for
introspection (stasis, dep-graph tools, etc.) observe the staleness.

## Fix on the stasis side

Capture `contextInfo.issuer` in `nmf.hooks.beforeResolve` keyed by the
dependency object (`data.dependencies[0]`), then look it up in
`afterResolve` instead of reading `data.resourceResolveData.context.issuer`.
The `BEFORE` value is reliable; only the `AFTER` value goes stale.

## Reproduction infrastructure

The fixture under this directory has just the user-side files
(`package.json` + `example/package.json` + `example/index.js`). Run
`npm install` to materialize the node_modules (it'll natively produce
the 2-layer bs58 split: top@3 + middle@6); `base58check` lands at
top-level via npm hoisting. The "leaf" version the user originally
described (`example/node_modules/base58check/node_modules/bs58`) is NOT
needed to trigger the bug -- the 2-layer topology with the symlinked
`example` file dep is enough, because the stale-issuer mechanism doesn't
care about how deep the conflicting bs58 trees are.

The diagnostic trace script
(`tests/repro-resolver-retry.mjs`, on the same investigation branch)
groups `afterResolve` events by `(rrd.context.issuer, rawRequest)` and
flags any edge that resolves to multiple distinct targets -- which is
how this stale-issuer pattern surfaces.

Reproduced under both webpack@4.15.1 and webpack@4.47.0.
