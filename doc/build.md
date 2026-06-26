# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over one of a stasis
artifact's entry points to produce a conventional, runnable JavaScript bundle —
but it follows the artifact's **recorded import graph exactly** instead of
esbuild's own module resolution. Every import resolves to the edge stasis
attested, and every module's bytes come from the artifact, so the output
reflects what was bundled/locked, not whatever happens to be installed on disk.

This is the "ship that exact bundle to production" half of the workflow: create
a bundle, analyze it, then `stasis build` it into the artifact you actually run.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral)] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- The first positional argument is the artifact to build from: a
  `stasis.code.br` bundle or a `stasis.lock.json` lockfile.
- The second, optional positional argument is the **entry point** to build (see
  [Entry point](#entry-point) below).
- `--output` / `-o` (**required**): where to write. A path ending in
  `.js`/`.cjs`/`.mjs` names a single output file; anything else is a directory.
- `--format`: esbuild output format (`esm`, `cjs`, `iife`). Defaults to `esm`.
- `--platform`: esbuild target platform (`node`, `browser`, `neutral`).
  Defaults to `node`.
- `--minify`, `--sourcemap`: forwarded to esbuild.
- `--define=KEY=VALUE` (repeatable): an esbuild
  [define](https://esbuild.github.io/api/#define). The value is forwarded verbatim,
  so it must be valid JS the way esbuild's CLI expects — a JSON literal, an identifier,
  etc. (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`).
- `--external=PATTERN` (repeatable): an esbuild
  [external](https://esbuild.github.io/api/#external). See [Externals](#externals) below.
- `--loader=.EXT:NAME` (repeatable): an esbuild
  [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g.
  `--loader=.js:jsx` to parse JSX in `.js` files (see [JSX in `.js`/`.ts`](#jsx-in-jsts)).

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's output —
the import graph itself is fixed by the artifact and is unaffected by them.

## Externals

`--external=PATTERN` is esbuild's native external option, and it only steers specifiers
esbuild itself would resolve — the ones the artifact does **not** record. A bundle hands a
specifier it doesn't carry back to esbuild as a miss; `--external` re-declares those (the
externals that existed at capture time) so esbuild leaves them as runtime imports instead
of trying — and failing — to resolve them on disk. A specifier the artifact **does** record
is always followed from the artifact, so `--external` never silently un-inlines an attested
edge — the recorded graph wins.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## esbuild is an optional peer dependency

`stasis build` is the only command that needs a bundler, so esbuild is not a
hard dependency of `@exodus/stasis`. Install it where stasis can find it:

```sh
npm i -D esbuild      # local (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

`stasis build` resolves a local install first, then a global one, and prints an
actionable error if neither is present.

## Entry point

`stasis build` builds one entry point. Which one is the optional second
positional argument:

- The artifact records **one** entry → the argument is optional and that entry
  is used.
- The artifact records **several** entries → the argument is required; omitting
  it (or naming an entry the artifact doesn't record) fails with the list of
  available entries.

The selector is matched against the artifact's recorded, project-relative entry
paths (e.g. `src/index.js`). A leading `./` is tolerated, and a path relative to
the current directory is normalized into the project root before matching. Only
recorded entries are accepted — those are the graph roots the artifact attests.

```sh
stasis build app.stasis.code.br src/worker.js   # build the src/worker.js entry
```

## Bundle vs. lockfile

A **bundle** (`stasis.code.br`) is self-contained: it carries every reachable
source, so `stasis build` needs nothing else on disk — not even a `package.json`.
Resolution comes from the bundle's `imports` map and bytes from its `sources`; a
specifier the bundle doesn't record is handed back to esbuild, which externalizes
it the same way it would a Node built-in or a declared `external` (the bundle only
contains what it recorded, so the build only inlines what it recorded).

A **lockfile** (`stasis.lock.json`) carries the graph and per-file digests but no
content, so `stasis build` reads each attested file from disk and verifies it
against the lockfile's `sha512` before using it — the same check a
`stasis run --lock=frozen` replay makes. A changed or tampered file fails the
build closed; the build never sees bytes the lockfile doesn't vouch for.

Either way the build is faithful to the recorded graph: if the bytes on disk
differ from what the artifact attests, the bundle's bytes win (and a lockfile
build refuses outright).

## Scope and language

`stasis build` requires a **full-scope** artifact. A `node_modules`-scope bundle
or lockfile omits the entry and the workspace's own code, so there is nothing to
build from it on its own.

Only JavaScript/TypeScript artifacts are supported — esbuild is a JS bundler.
Entries may be `.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts` as well as `.jsx`/`.tsx`
(esbuild's JSX/TSX loaders are selected from the extension; JSX compiles to esbuild's
default classic runtime — `React.createElement` — which a `/** @jsx ... */` pragma can
override per file; `stasis build` does not expose esbuild's `jsx`/`jsxFactory` options,
and `--platform` does not affect the JSX runtime).
Artifacts produced by the Solidity/PHP/Bash/Rust bundlers are rejected with a
clear message.

### JSX in `.js`/`.ts`

The loader is chosen from the file extension, so JSX is parsed automatically only in
`.jsx`/`.tsx` files. Codebases that put JSX in plain `.js` files (the React Native
convention) otherwise fail with *"The JSX syntax extension is not currently enabled"*.
Override the loader per extension with `--loader`:

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

`--loader` is general (any esbuild loader, e.g. `--loader=.mjs:jsx`). Prefer it over a
blanket default because mapping `.ts`→`tsx` would break TypeScript angle-bracket type
assertions (`<T>x`), so the safe extension default is kept and JSX-in-`.js`/`.ts` is opt-in.

`stasis build` does not emit **non-code assets** yet. stasis records assets
(`.png`/`.svg`/… as `resource`/`resource:base64`) as files but not as import *edges*,
so whether a build hits one depends on the **entry you select**, not on the artifact as
a whole: a code-only entry builds fine even when the artifact carries assets for *other*
entries, while an entry that imports an asset fails at build time (esbuild can't resolve
the un-graphed resource).

> [!NOTE]
> The static `stasis bundle` command is JS/TS-only and does not accept `.jsx`/`.tsx`
> entries, but a bundle/lockfile captured by the esbuild or webpack plugins can carry
> them — and `stasis build` builds those.

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that marks itself
`__esModule` (the shape Babel/TypeScript emit) — `import dep from 'cjs-pkg'` where
`cjs-pkg` sets `exports.__esModule = true; exports.default = …` — two interop
conventions disagree on what `dep` binds to:

- **Node** (and `stasis run`, which loads through Node's own loader): `dep` is the
  dependency's whole `module.exports`. Node does **not** honor `__esModule`, so you
  reach the value through `dep.default`.
- **esbuild's bundler convention** (what `stasis build` produces): `dep` is unwrapped
  to `module.exports.default` directly.

`stasis build` follows the **bundler convention**, so a default import of an
`__esModule` CommonJS package binds differently than it would under `stasis run` or a
`node`-loaded build of the same graph. The recorded import *graph* is still followed
exactly — this affects only the generated interop shim for that one import shape.

This is **consistent** with how the esbuild and webpack capture plugins themselves
bundle (they serve module bytes the same way), so a bundle captured by those plugins and
then `stasis build`-ed keeps the interop it had at capture. The divergence is specifically
against Node-native execution (`stasis run`) and against a plain on-disk `esbuild` build.

The cause is an esbuild constraint, not a stasis resolution choice: `stasis build` serves
every module's bytes to esbuild through an `onLoad` plugin hook (that is how it follows the
artifact instead of disk), and esbuild's plugin API exposes no way to declare a
plugin-loaded file's module type. esbuild therefore infers CommonJS from the file's syntax
and emits its bundler-convention interop (`__toESM(require(…))`), rather than the
Node-faithful form (`__toESM(require(…), 1)`) it uses when it reads a file off disk and can
see the package's `package.json` `type`/extension. Named imports (`import { x } from …`)
and CommonJS packages that do **not** set `__esModule` are unaffected.
