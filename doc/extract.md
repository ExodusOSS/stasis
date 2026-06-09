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
record, and the bundle's `entries`, package dirs, and `name`/`version` metadata
are carried across verbatim. The extracted tree therefore validates against the
lockfile out of the box — e.g. `stasis run --lock=frozen` against the sources,
or `stasis prune` against the extracted `node_modules`.

`extract` reads the bundle as untrusted input: paths are resolved and checked to
stay inside the output directory before anything is written, so a malformed
bundle can't escape it or leave a half-written tree behind.

> [!NOTE]
> `extract` operates on code bundles (`stasis.code.br`). Resource bundles
> (`stasis.resources.br`) are not handled.
