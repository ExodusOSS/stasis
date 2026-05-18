# Stasis File Formats

Stasis writes up to four files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled text sources | Brotli-compressed JSON |
| `stasis.resources.br` | Bundled binary resources | Brotli-compressed JSON |

All three stasis-generated files carry an integer `version` field (currently
`0`). Paths are POSIX-style and relative to the directory holding the
lockfile; none may start with `..`.

## `stasis.config.json`

```json
{ "scope": "node_modules", "lock": "add", "bundle": "none", "debug": false }
```

| Key | Values | Default | Env var |
| --- | --- | --- | --- |
| `scope` | `"node_modules"`, `"full"` | `"full"` | `EXODUS_STASIS_SCOPE` |
| `lock` | `"none"`, `"ignore"`, `"add"`, `"replace"`, `"frozen"` | `"add"` | `EXODUS_STASIS_LOCK` |
| `bundle` | `"none"`, `"ignore"`, `"add"`, `"replace"`, `"load"` | `"none"` | `EXODUS_STASIS_BUNDLE` |
| `debug` | boolean | `false` | `EXODUS_STASIS_DEBUG` |

`add` loads existing data and refuses to modify it; `replace` ignores it and
rebuilds from scratch; `frozen` loads it read-only and requires every
observed file to match; `none` rejects the file's presence (footgun guard);
`ignore` tolerates it without loading or writing. `bundle = load` requires
`lock = frozen | none | ignore`; `lock = none` requires a non-`none`
`bundle`. Unknown keys are rejected. If both the file and env var set a
key, they must match. Only `scope` is persisted into the lockfile/bundle
`config` block.

## `stasis.lock.json`

```json
{
  "version": 0,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "sources": {
    ".": {
      "name": "@exodus/stasis",
      "version": "1.0.0-alpha.0",
      "files": { "src/index.js": "sha512-…" }
    }
  },
  "modules": {
    "node_modules/@exodus/bytes": {
      "name": "@exodus/bytes",
      "version": "1.15.0",
      "files": { "index.js": "sha512-…", "package.json": "sha512-…" }
    }
  }
}
```

- `entries` and `sources` are present only when `scope = full`; `modules` is
  always present.
- `sources` keys are workspace package dirs — `"."` for the top-level
  package, workspace-relative paths for any others (must not contain
  `node_modules`); `modules` keys are dependency dirs (must contain
  `node_modules`).
- Each module record's `name`/`version` come from the owning `package.json`.
  `files` maps package-dir-relative paths to SRI digests
  (`sha512-<base64(sha512(bytes))>`).
- File and module maps are sorted by the project's `sortPaths` rule
  (files-in-dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load`. Requires a sibling `stasis.lock.json` unless
`lock = none | replace`.

```json
{
  "version": 0,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "sources": {
    ".": {
      "name": "@exodus/stasis",
      "version": "1.0.0-alpha.0",
      "files": { "src/index.js": "export const x = 1\n" }
    }
  },
  "modules": {
    "node_modules/@exodus/bytes": {
      "name": "@exodus/bytes",
      "version": "1.15.0",
      "files": { "index.js": "..." }
    }
  },
  "formats": { "src/index.js": "module" },
  "imports": {
    "*": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } },
    "node, import": { "node_modules/foo/index.js": { "./impl.js": "node_modules/foo/impl.js" } }
  }
}
```

- `entries`/`sources`/`modules` mirror the lockfile shape, with `files`
  recording UTF-8 source bytes instead of SRI digests. `entries` and
  `sources` are present only when `scope = full`; `modules` is always
  present.
- `formats`: project-relative path → Node loader format (`module`,
  `commonjs`, …). May be missing per file.
- `imports`: conditions → parent file → specifier → resolved
  project-relative path. The conditions key is either `"*"` or a
  comma-joined list (e.g. `"node, import"`).
- When a `stasis.lock.json` is loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version`, and per-module file lists must
  match. Each loaded source is hash-verified against the lockfile.
- In `bundle = load` mode with `scope = full`, entry-point resolutions
  are checked against `entries`.

A legacy "pre-0" shape — flat top-level `sources` keyed by project-
relative path with no `entries`/`modules` — is still accepted on load
(loses cross-check of module metadata; lockfile-driven integrity checks
still apply).

## `stasis.resources.br`

Brotli-compressed JSON. Same write/read gating as `stasis.code.br`.

```json
{
  "version": 0,
  "config": { "scope": "full" },
  "sources": {
    ".": { "name": "...", "version": "...", "files": { "asset.bin": "<base64>" } }
  },
  "modules": {
    "node_modules/foo": { "name": "foo", "version": "...", "files": { "asset.bin": "<base64>" } }
  }
}
```

Same structural rules as `stasis.code.br` minus `entries`/`formats`/
`imports`. Resource bytes are stored base64-encoded. The legacy "pre-0"
shape with a flat top-level `resources` map is still accepted on load.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the four files
found in a directory without a sibling `package.json` is fatal, and they may
only appear in one directory along the path.
