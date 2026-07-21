# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a conventional, runnable JavaScript bundle,
following the artifact's **recorded import graph exactly** instead of esbuild's
own resolution: every import resolves to the edge stasis attested and every
module's bytes come from the artifact, not disk.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- First positional (**required**): the `stasis.code.br` bundle or `stasis.lock.json` lockfile to build from.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm` (`iife` under `--platform=hermes`). |
| `--platform` | Target platform `node`\|`browser`\|`neutral` (esbuild's), or `hermes`. Default `node`. See [Hermes](#hermes---platformhermes). |
| `--babel` | Transform every code file with the project's own `babel.config.*` before bundling. See [`--babel`](#the-projects-babel-config---babel). |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); value forwarded verbatim, must be valid JS as esbuild's CLI expects (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact. `--platform=hermes` and
`--babel` additionally transform each file's *content* on its way into the
bundle — the graph they follow is still exactly the recorded one.

## Externals

`--external=PATTERN` only affects specifiers the artifact does **not** record —
handed back to esbuild as misses. Re-declare capture-time externals with it so
esbuild leaves them as runtime imports; it can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## Hermes (`--platform=hermes`)

Hermes (React Native's engine) executes a dialect without classes, class fields,
private members, `let`/`const`, arrow functions, async generators or `for await`.
`--platform=hermes` downlevels every code file before the final bundle:

1. **esbuild pre-transform** — lowers class fields / private members / static
   blocks / `using` into plain class syntax (stripping TypeScript and compiling
   JSX on the way), the shape Babel's class transform can consume.
2. **Babel worker pool** — applies `@babel/plugin-transform-block-scoping` and
   `@babel/plugin-transform-classes`, the two lowerings esbuild refuses to do.
3. **Final esbuild bundle** — lowers arrows, async generators and `for await`,
   keeps its own helpers off `let`/`const`, and fails closed if a `class` or
   `let`/`const` somehow survived.

`--format` defaults to `iife` and `esm` is rejected (Hermes has no
`import`/`export`); `cjs` stays available for post-processing pipelines. esbuild
itself runs as platform `neutral`.

```sh
stasis build --platform=hermes --output=out.js app.code.br   # feed out.js to hermesc
```

Babel is resolved **from the project** (the directory you run `stasis build`
in), never from stasis's own dependencies — add the deps to the project:

```sh
npm i -D @babel/core @babel/plugin-transform-block-scoping @babel/plugin-transform-classes
```

## The project's Babel config (`--babel`)

`--babel` runs every code file through the project's own
`babel.config.(js|cjs|mjs|json)` — resolved from the project directory, plugins
and presets included — **instead of** the built-in pipeline, with no esbuild
pre-transform: Babel sees each file's attested bytes verbatim, exactly as the
project's own toolchain (e.g. Metro) would hand them over. The config's output
must be plain JS that esbuild can parse (a config that leaves TS/JSX in place
fails the build).

Combined with `--platform=hermes`, the project config **replaces** steps 1–2 of
the built-in downlevel while the final bundle's Hermes feature checks still
apply — so a config that doesn't lower classes or `let`/`const` fails closed
rather than shipping a bundle Hermes can't parse.

```sh
stasis build --babel --platform=hermes --output=out.js app.code.br
```

`--babel` needs `@babel/core` installed in the project (a dev dependency is
fine); a missing config or a missing install fails with instructions.

## esbuild is an optional peer dependency

esbuild is not a hard dependency of `@exodus/stasis`. Install it where stasis can find it:

```sh
npm i -D esbuild      # local (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

`stasis build` resolves a local install first, then a global one, and errors if neither is present.

## Entry point

The entry point is the optional second positional argument:

| Artifact records | Entry argument |
| - | - |
| **one** entry | Optional; that entry is used. |
| **several** entries | Required; omitting it (or naming an unrecorded entry) fails with the list of available entries. |

The selector matches the artifact's recorded, project-relative entry paths (e.g.
`src/index.js`); a leading `./` is tolerated and a cwd-relative path is normalized
into the project root before matching.

```sh
stasis build app.stasis.code.br src/worker.js   # build the src/worker.js entry
```

## Bundle vs. lockfile

| | Bundle (`stasis.code.br`) | Lockfile (`stasis.lock.json`) |
| - | - | - |
| Carries | Every reachable source | The graph + per-file digests, no content |
| Needs on disk | Nothing — not even a `package.json` | Each attested file, read from disk |
| Resolution / bytes | `imports` map + `sources` bytes | Reads the file, verifies its `sha512` before use |

A specifier the artifact doesn't record is handed back to esbuild, which
externalizes it. Where disk bytes differ from the artifact, a bundle uses its own
bytes and a lockfile fails the build closed.

## Scope and language

`stasis build` requires a **full-scope** artifact — a `node_modules`-scope one
omits the entry and the workspace's own code.

Only JavaScript/TypeScript is supported. The entry being built may be
`.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`/`.jsx`/`.tsx`, loader chosen from the
extension. JSX compiles to esbuild's default classic runtime
(`React.createElement`), overridable per file with a `/** @jsx ... */` pragma;
esbuild's `jsx`/`jsxFactory` options are not exposed and `--platform` does not
affect the JSX runtime. Solidity/PHP/Bash/Rust entries are rejected.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files. JSX in plain `.js` files
(the React Native convention) otherwise fails with *"The JSX syntax extension is
not currently enabled"*. Opt in per extension with `--loader` (any esbuild
loader, e.g. `--loader=.mjs:jsx`):

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

The static `stasis bundle` scanner has the same blind spot for the same reason:
JSX in a `.js`/`.cjs`/`.mjs` file is an *"Unexpected token"* parse error, which is
fatal for an ESM file whose static import graph can't be enumerated from the
partial parse (`JS bundle would be broken at load time`). Pass `--jsx` (its
counterpart to `build`'s `--loader`) so the scanner parses past the JSX to the
import graph and stores the JSX source verbatim for `stasis build --loader=.js:jsx`
to transform later:

```sh
stasis bundle --metro --platforms=ios,android --jsx index.js   # React Native JSX-in-.js
```

`--jsx` is off by default. For *parsing*, it covers only the `.js`/`.cjs`/`.mjs`
family; the `.ts` family is left JSX-free because its `<T>` generics collide with
JSX (put JSX-in-TS in a `.tsx` file, as TypeScript itself requires). It also makes
`.jsx`/`.tsx` files **carryable**: a dependency reached through them — e.g. a
package whose React Native entry is `src/index.tsx` — is scanned and bundled (its
JSX source stored verbatim for `stasis build` to transform), and the `--metro`/
`--mainFields` resolver probes `.jsx`/`.tsx` for extensionless imports. Off by
default, a reached `.jsx`/`.tsx` file instead fails closed as a target *"a source
bundle can't carry"*, so a bundle whose toolchain can't build JSX never silently
ships it.

### Non-code assets (`--resources`)

Not every import graph is loadable purely in JS: a React Native entry may
`import logo from './logo.png'`, and Metro consumes such assets from the bundle.
By default a reached non-code file is fatal — it *"a source bundle can't carry"*.
Pass `--resources=<ext-or-name>[,…]` to carry the allowlisted files as resources
instead, with their import edges recorded:

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

Each carried file is stored by content — `resource` for UTF-8 (e.g. `.svg`),
`resource:base64` for binary (e.g. `.png`) — the same formats the `--metro` native
capture and the esbuild/webpack plugins use. The allowlist entries are bare
extensions (`png`) or extensionless filenames (`LICENSE`); code extensions are
rejected (they're always tracked as code). Only files *reached through the import
graph* are carried — an allowlisted extension that nothing imports adds nothing.
`--resources` is JS-only and pairs with plain, `--mainFields`, and `--metro` alike.

A resource is carried, not built: `stasis build` (esbuild) still needs a matching
`--loader` (e.g. `--loader=.png:dataurl`) to emit one, so an entry that imports an
asset without a configured loader fails at build time — the bundle/lockfile carries
the bytes for attestation and for Metro regardless.

> [!NOTE]
> The static `stasis bundle` command does not accept `.jsx`/`.tsx` *entries* (it
> carries them only as reached dependencies, under `--jsx`). A bundle/lockfile
> captured by the esbuild or webpack plugins can carry `.jsx`/`.tsx` entries too —
> and `stasis build` builds those.

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that marks itself
`__esModule` (the Babel/TypeScript shape — `exports.__esModule = true;
exports.default = …`), `import dep from 'cjs-pkg'` binds differently under the two
interop conventions:

| | `dep` binds to | Reach the value via |
| - | - | - |
| **Node** / `stasis run` (ignores `__esModule`) | the whole `module.exports` | `dep.default` |
| **esbuild** / `stasis build` (bundler convention) | `module.exports.default` directly | `dep` |

Only the interop shim differs; the recorded graph is followed exactly. Named
imports (`import { x } from …`) and CommonJS packages that don't set `__esModule`
are unaffected. This matches the esbuild/webpack capture plugins, so the
divergence is only against `stasis run` and a plain on-disk `esbuild` build.
