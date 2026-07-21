# Stasis File Formats

Stasis writes up to three files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled sources **and** resources | Brotli-compressed JSON |

There is no separate resources bundle: one bundle holds both, distinguished
**per file** by `format` — code files carry their loader format, resources carry
`resource`/`resource:base64`.

Every stasis-generated file carries an integer `version`; lockfiles and bundles
are versioned independently. Paths are POSIX-style, relative to the directory
holding the lockfile, and may not start with `..`.

## `stasis.config.json`

```json
{ "scope": "node_modules", "lock": "frozen", "bundle": "load", "debug": false }
```

| Key | Values | Default | Env var |
| --- | --- | --- | --- |
| `scope` | `"node_modules"`, `"full"` | `"full"` | `EXODUS_STASIS_SCOPE` |
| `lock` | `"ignore"`, `"add"`, `"replace"`, `"frozen"` | `"add"` | `EXODUS_STASIS_LOCK` |
| `bundle` | `"ignore"`, `"add"`, `"replace"`, `"load"`, `"frozen"` | unset | `EXODUS_STASIS_BUNDLE` |
| `debug` | boolean | `false` | `EXODUS_STASIS_DEBUG` |
| `packageJSON` | boolean | `false` | `EXODUS_STASIS_PACKAGE_JSON` |
| `fs` | `"sync"`, `"async"` | unset | `EXODUS_STASIS_FS` |
| `brotliQuality` | integer `0`–`11` | `9` | `EXODUS_STASIS_BROTLI_QUALITY` |

`lock`/`bundle` modes:

| Mode | Behavior |
| --- | --- |
| `ignore` | Tolerate existing data without loading or writing it |
| `add` | Load existing data, refuse to modify it |
| `replace` | Ignore existing data, rebuild from scratch |
| `frozen` | Load read-only; require every observed file to match |
| `load` | Bundle only — *serve* recorded bytes instead of reading disk |

For `bundle`, `frozen` reads disk and verifies it against the bundle, making the
bundle its own attestation — a frozen bundle needs no sibling lockfile. An unset
`bundle` produces no bundle, and a stray one on disk is rejected.

Composition rules:
- `bundle = load` is incompatible with `lock = add | replace`.
- `bundle = frozen` composes with any `lock` mode.
- At least one of `lock`/`bundle` must be set.
- `fs` (the filesystem-capture mode, equivalent to `--fs`; see "Filesystem
  captures") requires a read/write bundle mode (`bundle = add | replace | load`).

`brotliQuality` tunes bundle-write compression (equivalent to `--brotli-quality`):
lower is faster, higher is smaller; `9` is the default. It affects only the
artifact's encoding — the decompressed content, and thus every hash, is identical
at any quality — so it is inert under read-only bundle modes.

`packageJSON` (equivalent to `--package-json` on `stasis run`/`stasis bundle`)
auto-includes each bundled module's `package.json` when a bundle is written, even
if the run/scan never reached it — so a `bundle = load` of the artifact, or a
`prune`, can still read every dependency's manifest. It only takes effect while
*writing* a bundle (`bundle = add | replace`); its effect is the extra bundled
files (attested like any other), so the flag itself is not serialized. JS bundles
only on the `stasis bundle` side (`.sol`/`.php`/`.sh`/`.rs` bundles have no npm
`package.json`).

Unknown keys are rejected. A key set by both file and env var must match. Only
`scope` is persisted into the lockfile/bundle `config` block; `debug`,
`childProcess`, `packageJSON`, `fs`, and `brotliQuality` are run-time flags, not
attested.

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
      "ecosystem": "npm",
      "files": { "index.js": "sha512-…", "package.json": "sha512-…" }
    }
  },
  "imports": {
    "node, import": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } }
  },
  "formats": {
    "src/index.js": "module",
    "node_modules/@exodus/bytes/index.js": "commonjs"
  }
}
```

- `entries` and `sources` are present only when `scope = full`; `modules` is
  always present.
- `sources` keys are workspace package dirs (`"."` for top-level,
  workspace-relative paths otherwise; none may contain `node_modules`); `modules`
  keys are dependency dirs (must contain `node_modules`). Classification is by the
  file's **real** path: a workspace package that pnpm symlinks into `node_modules`
  from a target outside any `node_modules` is a **source** under its real path, not
  a dependency under the symlink path. A lockfile predating this rule must be
  regenerated, or `lock = frozen` flags the moved path as a mismatch.
- Each module's `name`/`version` come from its `package.json`. `files` maps
  package-dir-relative paths to SRI digests (`sha512-<base64(sha512(bytes))>`).
- Dependency records carry an `ecosystem` (beside `name`/`version`) naming where
  the package resolved, using the SBOM/Package-URL `type` vocabulary: `npm`
  (`node_modules`), `composer` (Composer `vendor/…`), `cargo` (`cargo vendor`
  crates), `github` (`forge install` git submodules from github.com), `soldeer`
  (the Foundry Solidity package manager — no purl type exists). It reflects where
  the package physically resolved, not the bundle's language — a Solidity or Bash
  import out of `node_modules` is `npm`. Workspace/top-level buckets (`sources`)
  are first-party and omit `ecosystem`. Artifacts predating this field lack it and
  still load.
- `imports` records observed resolutions (conditions → parent file → specifier →
  resolved project-relative path). Under `lock = frozen`, disk resolutions are
  checked: a divergence from the recorded target is fatal (catching a specifier
  redirected to a *different* attested file, which byte hashes can't); an
  unrecorded edge is fatal in `scope = full` but tolerated for workspace parents
  in `scope = node_modules`.
- Per-platform edges (`stasis bundle --metro --platforms=…`): a resolution target
  is normally a project-relative file string. When `--metro` resolves one
  `(parent, specifier)` edge to **different** files across platforms (e.g.
  `./Button` → `Button.ios.js` on `ios` but base `Button.js` on `web`), the target
  becomes a `{ "<platform>": "<file>" }` object keyed by exactly the requested
  platforms (no `"*"`). Edges every platform agrees on stay a flat string, and a
  single requested platform never produces a map. The file set is the union across
  platforms. Bundle and companion lockfile share this shape. Such artifacts are for
  analysis/attestation: plain `stasis run --bundle=load` has no platform context
  and fails closed on a per-platform edge (`ERR_STASIS_PLATFORM_SPECIFIC`).
- `formats` records each file's format. Values:
  Node loader (`module`, `commonjs`, `json`, `module-typescript`,
  `commonjs-typescript`); source-language (`solidity`, `php`, `shell`, `rust`);
  native build-input (`java`, `kotlin`, `gradle`, `objc`, `objcpp`, `swift`, `c`,
  `cpp`, `c-header`, `cpp-header`, `ruby`, `cmake`, `podspec`, `podfile`,
  `podfile-lock`, `template`, `xml`, `env`, `fastlane`, `pbxproj`); `resource`
  (raw UTF-8) / `resource:base64` (binary); and the filesystem-capture tags
  `directory`, `stat:file`, `stat:directory` (see "Filesystem captures"). Native
  tags come from the Metro native capture and aren't runnable by Node; `pbxproj`
  is an Xcode project file added via `stasis add`. The loader picks
  module-vs-commonjs and (for `*-typescript`) type-stripping purely from this
  value. Checked like `imports`: a mismatch is fatal, and on disk only the attested
  zone is enforced (`node_modules` files in `node_modules` scope, everything in
  `full`).
- File and module maps are sorted by the project's `sortPaths` rule (files in a
  dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load | frozen`. `bundle = frozen` is self-attesting (no lockfile
needed): the bundle loads read-only and each file/resolution/format observed from
disk is verified against it — so an unrecorded file, a byte/format mismatch, or a
resolution redirected to a different recorded file is fatal.

A frozen/lockfile verification that rejects something writes nothing, so a
detected mismatch can never be baked into the artifact. The write is gated on
verification, not exit code: a run that exits non-zero for its own reasons (a
SIGINT shutdown, a CLI reporting failures) still persists what it cleanly captured.

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
      "ecosystem": "npm",
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

- `entries`/`sources`/`modules` mirror the lockfile shape, but `files` records the
  file's bytes instead of SRI digests. Code and `resource` files store raw UTF-8;
  `resource:base64` files store base64. `entries`/`sources` are present only when
  `scope = full`; `modules` may be omitted (treated as empty). A bundle carrying
  code in `scope = full` must declare at least one entry; a resources-only bundle
  may have none.
- `formats`: project-relative path → format, same vocabulary as the lockfile's
  `formats`. May be missing per file for code whose format Node infers. TypeScript
  sources are stored verbatim (types intact); Node strips types at load time.
- `imports`: conditions → parent file → specifier → resolved project-relative
  path. The conditions key is `"*"`, a comma-joined list (e.g. `"node, import"`),
  or — for source-language bundles — the language tag (`solidity`/`php`/`shell`/`rust`).
  Statically built JS bundles use `"*"` per edge, except that a
  `(parent, specifier)` resolving differently under the require() and import()
  contexts keeps each target under its real condition key.
- When a `stasis.lock.json` is loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version`, and per-module file lists must match; each
  loaded source is hash-verified against the lockfile.
- When the lockfile records `imports`, every bundle resolution edge must land on
  the file the lockfile attests for that `(parent, specifier)`. The conditions key
  is matched exactly first; on a miss the edge passes only if every condition set
  the lockfile records for that parent+specifier agrees on the same target. Unknown
  or inconsistently-attested edges are fatal.
- In `bundle = load` with `scope = full`, entry-point resolutions are checked
  against `entries`.

A legacy `version: 0` shape — flat top-level `sources` keyed by project-relative
path, with no `entries`/`modules`/`formats`/`imports` — is still accepted by
**offline tooling** (`stasis extract`, `stasis diff`, `stasis audit`,
`stasis sbom`): `Bundle.parse` regroups its flat sources by inferred module dir.

**`stasis run` refuses v0 bundles** (no per-file `formats`, no `imports` map, so
runtime serving/verifying would widen the trust boundary). Upgrade with
`stasis run --bundle=replace` (starts fresh) or `stasis bundle` (re-bundles from
source). Bundles are always written as `version: 1`.

### Source-language bundles (Solidity / PHP / Bash / Rust)

`stasis bundle` dispatches on the entry file extension (no mixing within one
invocation):

| Extension(s) | Language | How the graph is found | `format` / `imports` key |
| --- | --- | --- | --- |
| `.js` `.cjs` `.mjs` `.ts` `.cts` `.mts` | JavaScript / TypeScript | static require/import scan | Node format / `"*"` + conditions |
| `.sol` | Solidity | `import` statements (+ remappings via `--mapping`) | `solidity` |
| `.php` | PHP | literal `require`/`include` paths + Composer-autoloaded class references (PSR-4/PSR-0/classmap/files) | `php` |
| `.sh` `.bash` | Shell | `source`/`.`, `bash`/`sh` exec, direct `./x.sh`, `# Depends on:`, `# shellcheck source=` | `shell` |
| `.rs` | Rust | `mod` declarations (+ `use crate::` edges) | `rust` |

These four are **`scope = full`, produce-only artifacts** in the same
`stasis.code.br` shape as a JS bundle, tagged with a language `format` and keyed
under a language `imports` condition. They are for external static analysis —
**not** `stasis run --bundle=load`, which executes JavaScript and rejects a non-JS
`format`. Every reachable file is read from disk (symlinks whose real target
escapes the bundle root are refused) and bucketized by the nearest `package.json`,
except PHP, which buckets by the nearest `composer.json`
(`vendor/<vendor>/<pkg>`, versions from `vendor/composer/installed.json`). With no
manifest above a file, the workspace bucket gets a placeholder identity
(`solidity-bundle`/`php-bundle`/`bash-bundle`/`rust-bundle` at `0.0.0`).

Dependency buckets carry an `ecosystem`, attributed by the install layout each
file resolves out of:

| Bundler | Layout | `ecosystem` |
| --- | --- | --- |
| any | dep under `node_modules` | `npm` |
| Solidity | Soldeer `dependencies/<name>-<version>/` | `soldeer` (name/version from dir) |
| Solidity | `forge install` submodule `lib/<dir>/` | `github` (`owner/repo` from `.gitmodules` URL) |
| Rust | `use <crate>` → `cargo vendor`'s `vendor/<crate>/` | `cargo` (name/version from `Cargo.toml`) |

A dep under `node_modules` is `npm` whatever the language. A git submodule with no
`package.json`/`branch`, or a Soldeer dir with no version suffix, falls back to
`0.0.0`; the workspace bucket carries no `ecosystem`.

What counts as a fatal unresolved reference differs by language:

| Language | Fatal if unresolved | Best-effort / tolerated |
| --- | --- | --- |
| Solidity | every `import` | — |
| PHP | every literal `require`/`include` path | Composer-autoloaded class refs (unresolved ones usually built-in/extension classes); a dynamic include with a static dir prefix pulls in that dir's `.php` files as candidates |
| Bash | every in-root `.sh`/`.bash` reference | PATH commands, `$VAR`/absolute/system paths, `../`-escaping sources (external); dynamic `source "${VAR}/x.sh"` followed via `# shellcheck source=` when present |
| Rust | every unconditional `mod foo;` | `#[cfg(...)]`-gated `mod`, all `use crate::` edges |

A missing entry is always fatal.

## Resources in the bundle

Resources (images, fonts, any non-code file a build references) live in the same
`stasis.code.br` as code, as files in the usual `sources`/`modules` buckets,
tagged in `formats` by payload encoding:

- `resource` — valid UTF-8, stored raw (human-readable; e.g. SVG).
- `resource:base64` — binary bytes, base64-encoded.

```json
{
  "version": 1,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "sources": {
    ".": { "name": "...", "version": "...", "files": {
      "src/index.js": "…source…",
      "src/icon.svg": "<svg>…</svg>",
      "src/logo.png": "<base64>"
    } }
  },
  "modules": {},
  "formats": {
    "src/index.js": "module",
    "src/icon.svg": "resource",
    "src/logo.png": "resource:base64"
  },
  "imports": { "*": { "src/index.js": {} } }
}
```

In the lockfile a resource is hashed like any other file (sha512 of its raw bytes)
and carries the same `formats` tag, so a frozen run verifies a copied asset
byte-for-byte just as it does code.

## Filesystem captures (`stasis run --fs=sync` / `--fs=async`)

Loader hooks capture the module graph; `--fs` additionally patches explicit `fs`
calls so a program's own reads — and the kind (file vs directory) of each path it
stats — are recorded into the bundle (`--bundle=add|replace`) and served back
(`--bundle=load`). The same `--fs=…` flag is needed on the load run for the patch
to serve; an un-captured read falls through to the real disk read. The mode can
equivalently be set as `"fs": "sync" | "async"` in `stasis.config.json` (or
`EXODUS_STASIS_FS`). `--fs` requires an active bundle mode (`add`, `replace`, or `load`).

| Patched call (sync forms) | Captured as | Load behavior |
| --- | --- | --- |
| `readFileSync` | file bytes (see below) | serves bytes |
| `readdirSync` (no options) | `directory` — sorted JSON name array | serves listing |
| `lstatSync` / `statSync` (no options) | payload-free `stat:file` / `stat:directory` | answers kind |
| `existsSync` / `accessSync` / `realpathSync` | **not captured** (serve-only) | serves if path already carried |

`--fs=sync` patches the sync forms above; `--fs=async` also patches the callback
forms (`readFile`/`readdir`/`lstat`/`stat`/`access`/`realpath`) and the promise
forms `fs.promises.*` (i.e. `node:fs/promises`). Each async wrapper
records/serves identically to its sync sibling; a served callback is always
invoked asynchronously. Captured bytes and listings are mode-independent, so a
`--fs=async` bundle is read by either mode. Not patched: streams, `fs.opendir`,
`fs.readlink`, the deprecated callback `fs.exists`.

Captures live in the usual `sources`/`modules` buckets, tagged in `formats`.

**`readFileSync`** is stored generically by extension: a recognized code extension
(`.json`/`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) with UTF-8 bytes keeps its Node
loader format; anything else (or non-UTF-8 bytes) falls back to
`resource`/`resource:base64`. A file both imported and read collapses to one
entry. The optional encoding argument (string or `{ encoding }`) is honored when
serving; an invalid encoding throws as fs does.

**`readdirSync`** stores a single-argument call as a sorted, JSON-serialized
`directory` (reproducible regardless of OS order). Replay is thus subtly
un-faithful — capture sees OS order, a `--bundle=load` run sees the sorted listing
— so code relying on `readdirSync` order should sort explicitly. Calls with
options (`encoding`, `withFileTypes`, `recursive`) pass through untouched. A
listing captured at a package bucket root sits at the bucket's own key: rel `''`
in its `files`, format keyed at the bucket dir (`.` for the project root).

**`lstatSync`/`statSync`** record a single-argument call's **kind** only. The real
call runs first (the program gets the genuine `Stats` and errors); the observed
type is stored as a **payload-free** `stat:file`/`stat:directory` — no bytes,
hash, or `files` entry. Only regular files and directories are modelled: a symlink
(under `lstat`), socket, or FIFO records nothing; a `statSync` through an in-root
symlink records the *target's* kind, keyed at the requested path. A path already
carried as content, or whose real location escapes the root, records no stat
entry; reading a stat-only path later (same run or a `lock=add`/`bundle=add`
re-run) upgrades the stat record to a real content record. On load,
`.isFile()`/`.isDirectory()` answer from the bundle for any carried path — a
recorded file, `directory`, stat record, or an ancestor directory implied by a
recorded path (a bundled `node_modules/dep/index.js` proves `node_modules` and
`node_modules/dep` are directories). Other `Stats` fields are the real stat's
while the file is on disk, and benign synthetic defaults (`0`/epoch/a
file-or-directory `mode`) once it's gone, so wrappers that read more than
`isFile()`/`isDirectory()` keep working. Uncarried paths and calls with options
(`bigint`, `throwIfNoEntry`) pass through untouched.

**`existsSync`/`accessSync`/`realpathSync`** (and the async `access`/`realpath`
and `fs.promises.*` forms) are existence/canonical-path probes: served for a
carried path, otherwise passed through. Unlike `lstat`/`stat` they are
**serve-only, never captured** — a file *only* probed isn't in the bundle and its
probe falls through to disk on load; but a path the program does `lstat`/`stat`
gains a stat record these probes then answer from. Per call: `existsSync` answers
`true`/`false`; `accessSync` serves a carried path **read-only** (`F_OK`/`R_OK`
succeed; `W_OK`/`X_OK` defer to the real fs); `realpathSync` returns the real
symlink-resolved path while the file is on disk and falls back to the
**lexically** resolved request path once bundle-only. The `.native` variant is covered.

> [!NOTE]
> Build tools check a file *before* reading it: e.g. `@babel/core`
> `fs.existsSync`s and realpath-canonicalizes `babel.config.js` before
> `require()`ing it — so an unserved probe makes a bundled-but-absent config read
> as missing (Babel then silently runs with no config).

Source-map sidecars (`*.map`) are treated as **non-existent** under `--fs` in both
capture and load — never captured, never served, an `ENOENT` to
`readFileSync`/`readFile`, `statSync`/`lstatSync`, `accessSync`/`realpathSync`,
and `false` from `existsSync` — so a stray map read neither aborts a capture nor
bloats the artifact. This is independent of bundle mode. To capture a `.map` as
data instead, add `map` to the `resources` allowlist; once a `.map` is in the
bundle it is served on load by membership, even if that run omits `--resources=map`.

Content captures are hashed like any content (a `directory`'s integrity is the
sha512 of its JSON text), so a frozen run verifies them; a stat record has no
content — its `formats` entry is the attestation, cross-checked
bundle-vs-lockfile like every other format.

When a bundler plugin runs with its own `bundleFile` (a *sidecar*), a read the
sidecar already attests is skipped in the main bundle at capture and served from
the sidecar at load, so the module graph isn't duplicated.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the three stasis
files in a directory without a sibling `package.json` is fatal, and they may
appear in only one directory along the path.
