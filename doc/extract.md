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

## The execute bit

A bundle attests exactly one permission fact per file — whether it is executable (see
[file-formats.md](file-formats.md#executable-files)) — and that is the only bit
`extract` touches. Read and write bits are left exactly as the write produced them:
umask-derived for a file `extract` creates (`0644`, so an executable becomes `0755`),
and the target's own when overwriting. Normalizing the whole mode would widen a
deliberately restricted pre-existing file — turning a `0600` secret into `0644` — and
`extract` has no standing to decide that.

The adjustment runs on *every* written file, not only the executable ones, which is what
makes the extracted tree match the artifact: re-extracting over an older tree also
**drops** an execute bit the bundle stopped attesting, so extraction is idempotent.
Execute is added wherever the file is readable, with owner-execute as a floor so an
aggressive umask can't quietly produce a file the bundle calls runnable and isn't.
`setuid`/`setgid`/sticky are cleared from anything `extract` rewrites — the bytes are the
bundle's now, and a privileged bit a stale target carried must not survive to arm them.

Only files `extract` actually wrote are touched, and the derived `stasis.lock.json`
carries the same list. Modes are left entirely alone for a legacy `version: 0` bundle,
which attests nothing about them, and on Windows, which reports no POSIX execute bits.
A filesystem that can't store modes (vfat/exFAT/CIFS, some bind mounts) is tolerated per
file: the bytes still land, the lockfile is still written, and the count of files whose
mode could not be set is reported.

> [!NOTE]
> A target that is itself a **symlink** is written through (see below) but never
> `chmod`ed: an overwrite can only change a link target's contents, whereas granting it
> `+x` would let a bundle make a file outside the output directory runnable.

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
