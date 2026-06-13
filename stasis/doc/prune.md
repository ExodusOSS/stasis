# `stasis prune`

`stasis prune` (also exported as `@exodus/stasis/prune`) constrains an
installed `node_modules` tree to the files recorded in
`stasis.lock.json`.

```json
// package.json
{ "scripts": { "postinstall": "stasis prune" } }
```

`prune` walks `node_modules`, keeps and verifies (sha512) every file
listed in the lockfile, keeps unverified `package.json` files in
directories the lockfile recognises as a module, prunes everything else
(including `package.json` files under directories the lockfile doesn't
list), and fails if a lockfile-listed file is missing on disk. The walk
planning and disk mutation are separated: any error aborts before a
single `unlink` runs.

`prune` also rejects up front if pnpm's `enableGlobalVirtualStore` is
turned on (checked via the `npm_config_enable_global_virtual_store` env
var pnpm exports). With the global virtual store enabled `node_modules`
is dominated by symlinks into a shared store, which `prune` skips and
which makes the lockfile-vs-disk comparison meaningless.
