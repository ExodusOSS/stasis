# Stasis File Formats

Stasis writes up to four files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled text sources | Brotli-compressed JSON |
| `stasis.resources.br` | Bundled binary resources | Brotli-compressed JSON |

All three stasis-generated files carry an integer `version` field. Lockfiles
and bundles are independently versioned. Paths are POSIX-style and relative
to the directory holding the lockfile; none may start with `..`.

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
  },
  "imports": {
    "node, import": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } }
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
- `imports` records the observed resolutions in the same shape as the
  bundle's `imports` map (conditions → parent file → specifier → resolved
  project-relative path), so the lockfile attests not just file bytes but
  which file each specifier resolves to. Lockfiles written before this field
  existed omit it; such lockfiles attest bytes only.
- File and module maps are sorted by the project's `sortPaths` rule
  (files-in-dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load`. Requires a sibling `stasis.lock.json` unless
`lock = none | replace`.

```json
{
  "version": 1,
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
  `sources` are present only when `scope = full`; `modules` may be
  omitted (treated as empty).
- `formats`: project-relative path → Node loader format (`module`,
  `commonjs`, `module-typescript`, `commonjs-typescript`, `json`). May be
  missing per file. TypeScript sources are stored verbatim (types intact);
  Node strips the types at load time based on the format. Source-language
  bundles (see below) use a language tag here instead: `solidity`, `php`,
  `bash`, or `rust`.
- `imports`: conditions → parent file → specifier → resolved
  project-relative path. The conditions key is either `"*"`, a
  comma-joined list (e.g. `"node, import"`), or — for source-language
  bundles — the language tag (`solidity`/`php`/`bash`/`rust`).
- When a `stasis.lock.json` is loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version`, and per-module file lists must
  match. Each loaded source is hash-verified against the lockfile.
- When the lockfile records `imports`, every resolution edge in the
  bundle must land on the file the lockfile attests for that
  (parent, specifier). The conditions key is matched exactly first; on a
  miss — e.g. a static bundle's `"*"` edges checked against a runtime
  lockfile's precise condition sets, or vice versa — the edge passes only
  when every condition set the lockfile records for that parent+specifier
  agrees on the same target. Unknown or inconsistently-attested edges are
  fatal. This closes the redirect hole where a tampered bundle points a
  specifier at a *different* hash-valid file, while still letting a
  `stasis bundle` artifact validate against a runtime-generated lockfile
  when their graphs coincide. Lockfiles without `imports` skip the check
  (a warning is printed in `bundle = load` mode); regenerate the lockfile
  to enable it.
- In `bundle = load` mode with `scope = full`, entry-point resolutions
  are checked against `entries`.

A legacy `version: 0` shape — flat top-level `sources` keyed by project-
relative path with no `entries`/`modules` — is still accepted on load
(loses cross-check of module metadata; lockfile-driven integrity checks
still apply). The bundle is always written as `version: 1`.

### Source-language bundles (Solidity / PHP / Bash / Rust)

`stasis bundle` dispatches on the entry file extension (no mixing within one
invocation):

| Extension(s) | Language | How the graph is found | `format` / `imports` key |
| --- | --- | --- | --- |
| `.js` `.cjs` `.mjs` `.ts` `.cts` `.mts` | JavaScript / TypeScript | static require/import scan | Node format / `"*"` + conditions |
| `.sol` | Solidity | `import` statements (+ remappings via `--mapping`) | `solidity` |
| `.php` | PHP | literal `require`/`include` paths + Composer-autoloaded class references (PSR-4/PSR-0/classmap/files) | `php` |
| `.sh` `.bash` | Bash | `source`/`.`, `bash`/`sh` exec, direct `./x.sh`, `# Depends on:`, `# shellcheck source=` | `bash` |
| `.rs` | Rust | `mod` declarations (+ `use crate::` edges) | `rust` |

These four are **`scope = full`, produce-only artifacts** written in the same
`stasis.code.br` shape as a JS bundle, but tagged with a language `format` and
keyed under a language `imports` condition. They are intended for external
static analysis / inspection — **not** for `stasis run --bundle=load`, which
executes JavaScript through Node's module hooks and rejects a non-JS `format`
with a clear error. Every reachable file is read from disk (symlinks whose real
target escapes the bundle root are refused), bucketized by the nearest
`package.json` like a JS bundle — except PHP, which buckets by the nearest
`composer.json` instead (`vendor/<vendor>/<pkg>` buckets, with versions from
`vendor/composer/installed.json`). With no such manifest above a file the
workspace bucket gets a placeholder identity
(`solidity-bundle`/`php-bundle`/`bash-bundle`/`rust-bundle` at `0.0.0`).

What counts as a fatal unresolved reference differs by language: Solidity
requires every `import` to resolve; PHP requires every literal
`require`/`include` path to resolve (Composer-autoloaded class references stay
best-effort — unresolved ones are typically built-in or extension classes —
and a dynamic include with a static directory prefix pulls in every `.php`
file of that directory as a candidate); Bash requires every in-root
`.sh`/`.bash` reference to resolve (PATH commands, `$VAR` paths,
absolute/system paths, and `../`-escaping sources are tolerated as external —
a dynamic `source "${VAR}/x.sh"` is followed via its `# shellcheck source=`
directive when present); Rust requires every
unconditional `mod foo;` to resolve (a `#[cfg(...)]`-gated `mod` and all
`use crate::` edges are best-effort). A missing entry is always fatal.

## `stasis.resources.br`

Brotli-compressed JSON. Same write/read gating as `stasis.code.br`.

```json
{
  "version": 1,
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
`imports`. Resource bytes are stored base64-encoded. A legacy `version: 0`
shape with a flat top-level `resources` map is still accepted on load;
writes are always `version: 1`.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the four files
found in a directory without a sibling `package.json` is fatal, and they may
only appear in one directory along the path.
