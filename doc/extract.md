# `stasis extract`

`stasis extract` unpacks a `stasis.code.br` bundle back onto disk: it writes
every bundled source to its original project-relative path and drops a matching
`stasis.lock.json` next to them. It is the inverse of `stasis bundle`.

```sh
stasis extract [--output=path/to/dir] path/to/bundle.stasis.code.br
```

- `--output` / `-o`: directory to extract into. Defaults to the current
  directory. Intermediate directories are created as needed.
- The single positional argument is the brotli-compressed code bundle to read.

## What it writes

For a `scope = full` bundle, the workspace sources land under their relative
paths (`src/index.js`, …) and dependencies under
`node_modules/<pkg>/…`; a `scope = node_modules` bundle writes only the
`node_modules` tree. Either way a `stasis.lock.json` is written into the output
directory.

The lockfile is derived from the bundle's own contents: each file's recorded
UTF-8 bytes are hashed (sha512) into the same SRI digest `stasis run` would
record, and the bundle's `entries`, package dirs, `name`/`version` metadata,
and `imports` (resolution map) are carried across verbatim. The extracted tree therefore validates against the
lockfile out of the box — `stasis prune` works directly against the extracted
`node_modules`; a `stasis run --lock=frozen` additionally needs the project's
`package.json` files, which are only present if the bundle recorded them.

When the bundle attests no root `package.json` (common for bundler-plugin
captures — Metro/webpack read manifests through their own `fs`, so a manifest
is attested only when it was `require()`d or captured as an `--fs` read), a
minimal `{ name, version }` one is synthesized from the workspace bucket's
attested identity — the same basis `stasis prune` rewrites manifests from.
Without it the extracted tree could not serve as a stasis root: State's root
discovery refuses a directory holding a stasis artifact (the derived
`stasis.lock.json`) with no `package.json`, which would block the
no-source-tree flow (`stasis extract` + `stasis run --bundle=load` in the
extracted tree). A `package.json` already present — attested in the bundle,
or pre-existing in the output directory — is never overwritten by the
synthesized one.

Legacy `version: 0` bundles record no package `name`/`version`, so no lockfile
can be restored from them. Their sources are still extracted; the lockfile is
skipped with a warning.

Existing files at target paths are overwritten, including a pre-existing
`stasis.lock.json` in the output directory.

## Untrusted input

`extract` reads the bundle as untrusted input, and plans the whole tree before
writing anything, so a malformed bundle fails before the first write rather
than leaving a partial tree behind. It refuses bundles with:

- paths that escape the output directory (checked both as not-`..`-relative to
  it and as lexically under `<dir>/`),
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a bundled file named `stasis.lock.json`, which would collide with the
  derived lockfile.

The path checks are lexical: `extract` does not resolve symlinks, so writes
pass through any symlink already present inside the output directory (e.g. a
pnpm-managed `node_modules`). Extract untrusted bundles into a fresh, empty
directory.

> [!NOTE]
> `extract` operates on `stasis.code.br`. Code files are written as their source
> text; resource files are decoded back to their original bytes (`resource:base64`
> from base64, `resource` from raw UTF-8) per their `formats` entry.
