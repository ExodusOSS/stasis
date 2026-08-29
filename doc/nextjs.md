# Next.js

Stasis integrates with Next.js twice, and the two compose:

| | What it attests | How |
| - | - | - |
| `withStasis` (`@exodus/stasis/nextjs`) | What a real `next build` compiles — client, server and edge compilers | wraps `next.config.*`, wiring one shared `StasisWebpack` into every compiler config Next builds |
| `stasis bundle --nextjs` | The statically reachable app graph, without executing a build | discovers the convention entries and resolves them the way Next's server + client compilers do |

## Live capture: `withStasis` in `next.config`

```js
// next.config.mjs
import { withStasis } from '@exodus/stasis/nextjs'

export default withStasis({
  // your next config (an OBJECT; resolve a function config first)
}, {
  // optional stasis options: lock, bundle, bundleFile, resources, ...
})
```

Wire it permanently: without stasis env, options, or an ambient preload the plugin is **inert**,
so plain `next build` / `next dev` behave exactly as before. Activate a capture per run:

```sh
EXODUS_STASIS_LOCK=add EXODUS_STASIS_SCOPE=full next build          # write stasis.lock.json
EXODUS_STASIS_LOCK=frozen EXODUS_STASIS_SCOPE=full next build       # verify disk against it
EXODUS_STASIS_RESOURCES=css,scss,png,svg,ico,woff2 ...              # allowlist non-code imports
```

`next build` runs its client/server/edge compilers as sequential webpack builds in one process.
The wrapper hands all of them **one** shared plugin instance and defers the capture write to a
single end-of-process flush, so the artifact lands once, complete — and not at all if any
compiler fails (a partial capture never overwrites a good artifact).

To also attest the build process itself (Next's own imports, the workers it forks), run the build
under the stasis loader instead of bare env:

```sh
stasis run --lock=add --child-process node_modules/next/dist/bin/next build
```

Refused, loudly, rather than silently under-attesting:

- **`next dev` capture** — watch rebuilds would attest stale content (`StasisWebpack`'s one-shot
  refusal); dev with stasis inert is untouched.
- **`experimental.webpackBuildWorker: true` with a writing mode** — each compiler would build in
  its own process and clobber the others' artifact. Verify/load modes stay allowed. (Next only
  auto-enables the worker when there is no custom webpack hook; this wrapper is one.)
- **Turbopack** — it never calls the webpack hooks, so nothing can be captured. The wrapper
  throws at config load when stasis is active and the Next CLI exported `TURBOPACK` (drop
  `--turbopack`; on Next 16+ pass `--webpack`). This detection is best-effort: keep stasis builds
  on webpack.

A non-code import (CSS, images, fonts) fails the capture until its extension is allowlisted via
`resources` (option or `EXODUS_STASIS_RESOURCES`) — the same rule as every stasis bundler plugin.

## Static walk: `stasis bundle --nextjs`

```sh
stasis bundle --nextjs                                   # entries discovered, stasis.code.br written
stasis bundle --nextjs --resources=css,png --lockfile=stasis.lock.json
stasis bundle --nextjs server.js                         # extra entries (a custom server) join in
```

No entry positionals needed: the file system is Next's entry list, and `--nextjs` enumerates it —
`pages/**` (API routes and `_app`/`_document`/`_error` included), the `app/` special files
(`page`, `layout`, `template`, `loading`, `error`, `not-found`, `global-error`, `default`,
`route`, `forbidden`, `unauthorized`, the sitemap/robots/manifest/icon/image metadata routes),
`middleware`/`proxy`, `instrumentation`, `instrumentation-client`, each also under `src/` (root
wins). `app/` folders prefixed `_` are private and skipped.

Resolution runs twice, modeling Next's compilers:

- **server pass** — all entries; `mainFields: ['main', 'module']`, Node conditions.
- **client pass** — the `pages/` routes (minus `pages/api/**` and `_document`) **plus every
  reached file whose directive prologue declares `'use client'`** (dependencies included), the
  boundaries Next's client compiler starts from; `mainFields: ['browser', 'module', 'main']`, the
  `browser` condition, browser-field redirects.

Where the two passes agree an edge is recorded flat; where they diverge it's recorded per pass —
`"dual-pkg": { "client": "…/browser.js", "server": "…/node.js" }` — the same per-key shape
`--metro` uses for platforms.

`--nextjs` implies `--jsx` (Next apps are JSX-first) and `--typescript`, honoring
`compilerOptions.paths` aliases from `tsconfig.json` (or `jsconfig.json` for JS-only apps;
`--tsconfig` overrides). It conflicts with `--metro`/`--mainFields`/`--conditions`/`--platforms`/
`--scope` (it presets its own, full-scope) and combines with `--resources`, `--package-json`,
`--lockfile`, `--add`, `--flow`.

Known approximations (the live plugin has none of these — it records what the real build
resolved): the edge runtime is not a separate pass (middleware resolves like the server), the RSC
layers' `react-server` condition and Next's vendored `react`/`react-dom` aliases are not modeled,
the `webpack` exports condition is not asserted, and a custom `pageExtensions` or webpack alias
config is not read from `next.config` — list such entries explicitly.
