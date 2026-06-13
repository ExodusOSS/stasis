# <img src="./logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis`

*Analyzeable source code bundles with resolutions + fine-grained lockfiles.*

Both lockfiles and bundles only include what is actually _used_: generally about 10x smaller than production-focused `node_modules` install.

Enforcing these allows to focus automated code scanning and alerts only on code that matters,
and makes the analysis import graph aware.

Ideal workflow: create bundle -> analyze -> ship _that exact bundle_ to production.

Lockfile can attest the bundle in a readable form, but that's not required - bundle itself can be an attestation.

| Lockfile | Bundle |
| -------- | ------ |
| `stasis.lock.json` | `stasis.code.br` |
| Asserts per-file imports integrity and the import graph | Contains per-file imports code and the import graph |
| Human-readable | Compressed |
| Asserts only, files are read from disk | Loads or asserts (can be used as a lockfile)|
| Modes: `add`, `replace`, `frozen`, `ignore` | Modes: `load`, `add`, `replace`, `frozen`, `ignore` |

The main difference between lockfiles and bundles is that lockfiles contain integrities, and bundles contain full content.\
See [file formats](https://github.com/ExodusOSS/stasis/blob/main/doc/file-formats.md).

Both can be run in full scope (default) or just in `node_modules` scope.

## Commands

... TODO: document

## License

[MIT](./LICENSE)
