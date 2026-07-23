# `stasis extract`

`stasis extract` unpacks a `stasis.code.br` bundle back onto disk: it writes
every bundled source to its original project-relative path and drops a matching
`stasis.lock.json` next to them. It is the inverse of `stasis bundle`. Because
unpacking needs no scanner or loaders, the command also ships on the
zero-dependency core CLI as `stasis-core extract` (identical flags and behaviour).

```sh
stasis extract [--output=path/to/dir] path/to/bundle.stasis.code.br
stasis-core extract [--output=path/to/dir] path/to/bundle.stasis.code.br
```

| Argument | Meaning |
| --- | --- |
| `--output` / `-o` | Directory to extract into. Defaults to cwd; intermediate dirs are created as needed. |
| positional | The brotli-compressed `stasis.code.br` bundle to read. |

## What it writes

A `scope = full` bundle writes workspace sources under their relative paths
(`src/index.js`, …) and dependencies under `node_modules/<pkg>/…`; a
`scope = node_modules` bundle writes only the `node_modules` tree. Either way a
`stasis.lock.json` lands in the output directory.

The lockfile is derived from the bundle: each file's recorded UTF-8 bytes are
hashed (sha512) into the same SRI digest `stasis run` would record, and the
bundle's `entries`, package dirs, `name`/`version`, and `imports` are carried
across verbatim. The extracted tree validates out of the box — `stasis prune`
works directly against it; `stasis run --lock=frozen` additionally needs the
project's `package.json` files, present only if the bundle recorded them.

Legacy `version: 0` bundles record no `name`/`version`, so no lockfile can be
restored: sources are still extracted, the lockfile is skipped with a warning.

Existing files at target paths are overwritten, including a pre-existing `stasis.lock.json`.

## Untrusted input

`extract` treats the bundle as untrusted and plans the whole tree before writing
anything, so a malformed bundle fails before the first write. It refuses bundles with:

- paths that escape the output directory (checked as not-`..`-relative to it and as lexically under `<dir>/`),
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a bundled file named `stasis.lock.json` (collides with the derived lockfile).

The path checks are lexical: `extract` does not resolve symlinks, so writes pass
through any symlink already present inside the output directory (e.g. a
pnpm-managed `node_modules`). Extract untrusted bundles into a fresh, empty directory.

> [!NOTE]
> Code files are written as their source text; resource files are decoded back to
> their original bytes (`resource:base64` from base64, `resource` from raw UTF-8)
> per their `formats` entry.
