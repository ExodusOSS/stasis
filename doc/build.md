# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over one of a stasis
artifact's entry points to produce a conventional, runnable JavaScript bundle,
but follows the artifact's **recorded import graph exactly** instead of esbuild's
own module resolution. Every import resolves to the edge stasis attested and every
module's bytes come from the artifact, so the output reflects what was
bundled/locked, not whatever is installed on disk.

This is the "ship that exact bundle to production" half of the workflow: create a
bundle, analyze it, then `stasis build` it into the artifact you actually run.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral)] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- First positional (**required**): the artifact to build from — a `stasis.code.br`
  bundle or a `stasis.lock.json` lockfile.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm`. |
| `--platform` | esbuild target platform `node`\|`browser`\|`neutral`. Default `node`. |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); the value is forwarded verbatim, so it must be valid JS as esbuild's CLI expects (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact and unaffected by them.

## Externals

`--external=PATTERN` (esbuild's native option) only affects specifiers the
artifact does **not** record — those are handed back to esbuild as misses.
Re-declare capture-time externals with it so esbuild leaves them as runtime
imports instead of failing to resolve them on disk. Recorded specifiers are
always followed from the artifact; `--external` can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## esbuild is an optional peer dependency

`stasis build` is the only command that needs a bundler, so esbuild is not a hard
dependency of `@exodus/stasis`. Install it where stasis can find it:

```sh
npm i -D esbuild      # local (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

`stasis build` resolves a local install first, then a global one, and prints an
actionable error if neither is present.

## Entry point

`stasis build` builds one entry point, named by the optional second positional
argument:

| Artifact records | Entry argument |
| - | - |
| **one** entry | Optional; that entry is used. |
| **several** entries | Required; omitting it (or naming an unrecorded entry) fails with the list of available entries. |

The selector is matched against the artifact's recorded, project-relative entry
paths (e.g. `src/index.js`). A leading `./` is tolerated, and a path relative to
the current directory is normalized into the project root before matching. Only
recorded entries are accepted — those are the graph roots the artifact attests.

```sh
stasis build app.stasis.code.br src/worker.js   # build the src/worker.js entry
```

## Bundle vs. lockfile

| | Bundle (`stasis.code.br`) | Lockfile (`stasis.lock.json`) |
| - | - | - |
| Carries | Every reachable source | The graph + per-file digests, no content |
| Needs on disk | Nothing — not even a `package.json` | Each attested file, read from disk |
| Resolution / bytes | `imports` map + `sources` bytes | Reads the file, verifies its `sha512` before use (as `stasis run --lock=frozen` does) |

A specifier a bundle doesn't record is handed back to esbuild, which externalizes
it like a Node built-in or a declared `external`. Either way the build follows the
recorded graph: where disk bytes differ from what the artifact attests, a bundle
uses its own bytes and a lockfile fails the build closed.

## Scope and language

`stasis build` requires a **full-scope** artifact — a `node_modules`-scope one
omits the entry and the workspace's own code, leaving nothing to build.

Only JavaScript/TypeScript is supported (esbuild is a JS bundler). Entries may be
`.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`/`.jsx`/`.tsx`, with the loader chosen from
the extension. JSX compiles to esbuild's default classic runtime
(`React.createElement`), overridable per file with a `/** @jsx ... */` pragma;
`stasis build` does not expose esbuild's `jsx`/`jsxFactory` options and
`--platform` does not affect the JSX runtime. Artifacts from the
Solidity/PHP/Bash/Rust bundlers are rejected with a clear message.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files. Codebases that put JSX in
plain `.js` files (the React Native convention) otherwise fail with *"The JSX
syntax extension is not currently enabled"*. Opt in per extension with `--loader`:

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

`--loader` takes any esbuild loader (e.g. `--loader=.mjs:jsx`). JSX-in-`.js`/`.ts`
stays opt-in rather than a default because mapping `.ts`→`tsx` would break
TypeScript angle-bracket type assertions (`<T>x`).

`stasis build` does not emit **non-code assets** yet. stasis records assets
(`.png`/`.svg`/… as `resource`/`resource:base64`) as files but not as import
*edges*, so whether a build hits one depends on the **entry you select**: a
code-only entry builds fine even when the artifact carries assets for other
entries, while an entry that imports an asset fails at build time (esbuild can't
resolve the un-graphed resource).

> [!NOTE]
> The static `stasis bundle` command is JS/TS-only and does not accept `.jsx`/`.tsx`
> entries, but a bundle/lockfile captured by the esbuild or webpack plugins can carry
> them — and `stasis build` builds those.

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that marks itself
`__esModule` (the shape Babel/TypeScript emit — `exports.__esModule = true;
exports.default = …`), two interop conventions disagree on what `import dep from
'cjs-pkg'` binds:

| | `dep` binds to | Reach the value via |
| - | - | - |
| **Node** / `stasis run` (Node's loader; ignores `__esModule`) | the whole `module.exports` | `dep.default` |
| **esbuild** / `stasis build` (bundler convention) | `module.exports.default` directly | `dep` |

`stasis build` follows the bundler convention, so this one import shape binds
differently than under `stasis run` or a `node`-loaded build. The recorded import
*graph* is still followed exactly — only the generated interop shim differs. Named
imports (`import { x } from …`) and CommonJS packages that don't set `__esModule`
are unaffected.

This matches how the esbuild and webpack capture plugins themselves bundle, so a
bundle captured by them and then `stasis build`-ed keeps the interop it had at
capture; the divergence is only against Node-native execution (`stasis run`) and a
plain on-disk `esbuild` build.

The cause is an esbuild constraint, not a stasis choice: `stasis build` serves
every module's bytes through an `onLoad` hook (to follow the artifact, not disk),
and esbuild's plugin API can't declare a plugin-loaded file's module type — so
esbuild infers CommonJS from syntax and emits its bundler-convention interop
(`__toESM(require(…))`) rather than the Node-faithful `__toESM(require(…), 1)` it
uses when it reads a file off disk and can see the package's `package.json`
`type`/extension.
