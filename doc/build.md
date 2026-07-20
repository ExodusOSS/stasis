# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a conventional, runnable JavaScript bundle,
following the artifact's **recorded import graph exactly** instead of esbuild's
own resolution: every import resolves to the edge stasis attested and every
module's bytes come from the artifact, not disk.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral)] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- First positional (**required**): the `stasis.code.br` bundle or `stasis.lock.json` lockfile to build from.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm`. |
| `--platform` | esbuild target platform `node`\|`browser`\|`neutral`. Default `node`. |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); value forwarded verbatim, must be valid JS as esbuild's CLI expects (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact.

## Externals

`--external=PATTERN` only affects specifiers the artifact does **not** record —
handed back to esbuild as misses. Re-declare capture-time externals with it so
esbuild leaves them as runtime imports; it can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

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

The language check is scoped to the **entry being built** and the files
**reachable from it** through the recorded import graph — the same set esbuild
follows. A non-JS file elsewhere in the artifact (another entry's subtree, or a
file attested with `stasis add`) is never reached from this entry, so it does
not block the build; only a non-JS file the built entry actually imports fails
it. An artifact carrying, say, a JS app *and* an `android/app/build.gradle`
therefore still builds its JS entry.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files. JSX in plain `.js` files
(the React Native convention) otherwise fails with *"The JSX syntax extension is
not currently enabled"*. Opt in per extension with `--loader` (any esbuild
loader, e.g. `--loader=.mjs:jsx`):

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

**Non-code assets** are not emitted yet. Assets (`.png`/`.svg`/… as
`resource`/`resource:base64`) are recorded as files but not as import *edges*, so
a code-only entry builds fine even when the artifact carries assets for other
entries, while an entry that imports an asset fails at build time.

> [!NOTE]
> The static `stasis bundle` command does not accept `.jsx`/`.tsx` entries, but a
> bundle/lockfile captured by the esbuild or webpack plugins can carry them — and
> `stasis build` builds those.

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
