# Stasis File Formats

Stasis writes up to three files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled sources **and** resources | Brotli-compressed JSON |

There is no separate resources bundle: one bundle holds both, distinguished
**per file** by `format` — code files carry their loader format, resources carry
`resource`/`resource:base64` (see below).

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
bundle its own attestation — a frozen bundle needs no sibling lockfile ("operates
as a lockfile"). An unset `bundle` produces no bundle, and a stray one on disk is
rejected (a footgun guard).

Composition rules:
- `bundle = load` is incompatible with `lock = add | replace`.
- `bundle = frozen` composes with any `lock` mode.
- At least one of `lock`/`bundle` must be set.
- `fs` (the filesystem-capture mode, equivalent to `--fs`; see "Filesystem
  captures" below) requires a read/write bundle mode (`bundle = add | replace | load`).

`brotliQuality` tunes bundle-write compression (equivalent to `--brotli-quality`):
lower is faster, higher is smaller; `9` is the default (`11` is brotli's max but
its superlinear cost there buys little). It affects only the artifact's encoding —
the decompressed content, and thus every hash and attestation, is identical at any
quality — so it is inert under read-only bundle modes.

Unknown keys are rejected. A key set by both file and env var must match. Only
`scope` is persisted into the lockfile/bundle `config` block; `debug`,
`childProcess`, `fs`, and `brotliQuality` are run-time flags, not attested.

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
  from a target outside any `node_modules` is a **source** under its real path
  (omitted from a `node_modules`-scope bundle), not a dependency under the symlink
  path. A lockfile predating this rule that recorded such a file under
  `node_modules/<dep>/…` must be regenerated, or `lock = frozen` flags the moved
  path as a mismatch.
- Each module's `name`/`version` come from its `package.json`. `files` maps
  package-dir-relative paths to SRI digests (`sha512-<base64(sha512(bytes))>`).
- Dependency records carry an `ecosystem` (beside `name`/`version`) naming where
  the package resolved, using the SBOM/Package-URL `type` vocabulary where one
  exists: `npm` (`node_modules`), `composer` (Composer `vendor/…`), `cargo`
  (`cargo vendor` crates), `github` (`forge install` git submodules from
  github.com), `soldeer` (the Foundry-native Solidity package manager — no purl
  type exists, so this is descriptive). It reflects where the package physically
  resolved, not the bundle's language — a Solidity or Bash import pulled out of
  `node_modules` is `npm`. Workspace/top-level buckets (`sources`, keyed `"."` or a
  workspace dir) are first-party, not dependencies, and omit `ecosystem`. Artifacts
  predating this field lack it and still load.
- `imports` records observed resolutions in the bundle's `imports` shape
  (conditions → parent file → specifier → resolved project-relative path), so the
  lockfile attests which file each specifier resolves to, not just bytes. Under
  `lock = frozen`, disk resolutions are checked against it: a divergence from the
  recorded target is fatal (byte hashes can't catch a specifier redirected to a
  *different* attested file, e.g. via an unattested `package.json` `main`); an
  unrecorded edge is fatal in `scope = full` but tolerated for workspace parents in
  `scope = node_modules` (the workspace is deliberately unattested). Lockfiles
  predating this field omit it and attest resolutions only as far as recorded
  (frozen runs warn).
- Per-platform edges (`stasis bundle --metro --platforms=…`): a resolution target
  is normally a project-relative file string. When `--metro` resolves one
  `(parent, specifier)` edge to **different** files across platforms (e.g.
  `./Button` → `Button.ios.js` on `ios` but base `Button.js` on `web`, which has no
  `.web` variant and, being web, opts out of `.native`), the target becomes a
  `{ "<platform>": "<file>" }` object keyed by exactly the requested platforms (no
  `"*"`). Edges every platform agrees on stay a flat string, and a single requested
  platform never produces a map. The file set is the union across platforms (a base
  `.js` and its `.ios.js`/`.android.js` variants can all appear). Bundle and
  companion lockfile share this shape. Such artifacts are for analysis/attestation:
  plain `stasis run --bundle=load` has no platform context and fails closed on a
  per-platform edge (`ERR_STASIS_PLATFORM_SPECIFIC`).
- `formats` records each file's format (same shape as the bundle's map). Values:
  Node loader (`module`, `commonjs`, `json`, `module-typescript`,
  `commonjs-typescript`); source-language (`solidity`, `php`, `shell`, `rust`);
  native build-input (`java`, `kotlin`, `gradle`, `objc`, `objcpp`, `swift`, `c`,
  `cpp`, `c-header`, `cpp-header`, `ruby`, `cmake`, `podspec`, `podfile`,
  `podfile-lock`, `template`, `xml`, `env`, `fastlane`, `pbxproj`); `resource`
  (raw UTF-8) / `resource:base64` (binary); and the filesystem-capture tags
  `directory`, `stat:file`, `stat:directory` (see "Filesystem captures" below).
  Native tags are attested by the Metro native capture for the CocoaPods/Gradle
  toolchain and aren't runnable by Node; `pbxproj` is an Xcode project file added
  via `stasis add` (the packager excludes the `.xcodeproj` bundle it lives in).
  `resource`/`resource:base64` both marks a file as a resource and says how to
  decode its payload. The loader picks module-vs-commonjs and (for `*-typescript`)
  type-stripping purely from this value, so attesting it stops a tampered bundle —
  or a flipped, un-pinned `package.json` `type` on disk — from running hash-valid
  bytes under a different format. Checked like `imports`: a mismatch is fatal, and
  on disk only the attested zone is enforced (`node_modules` files in
  `node_modules` scope, everything in `full`). Lockfiles predating this field omit
  it and attest formats not at all (frozen runs warn).
- File and module maps are sorted by the project's `sortPaths` rule (files in a
  dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load | frozen`. `bundle = frozen` is self-attesting (no lockfile
needed): the bundle loads read-only and each file/resolution/format observed from
disk is verified against it — the same closed-set checks `lock = frozen` runs from
the lockfile, so an unrecorded file, a byte/format mismatch, or a resolution
redirected to a different recorded file is fatal.

A frozen/lockfile verification that rejects something writes nothing, so a detected
mismatch can never be baked into the artifact — even if user code swallows the
rejection and exits cleanly. The write is gated on verification, not exit code: a
run that exits non-zero for its own reasons (a server's SIGINT shutdown, a CLI
reporting failures) still persists what it cleanly captured.

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
  (no code) may have none.
- `formats`: project-relative path → format, using the same vocabulary as the
  lockfile's `formats` above (Node loader / source-language / native build-input /
  resource / fs-capture tags). May be missing per file for code whose format Node
  infers. TypeScript sources are stored verbatim (types intact); Node strips the
  types at load time based on the format.
- `imports`: conditions → parent file → specifier → resolved project-relative
  path. The conditions key is `"*"`, a comma-joined list (e.g. `"node, import"`),
  or — for source-language bundles — the language tag (`solidity`/`php`/`shell`/`rust`).
- When a `stasis.lock.json` is loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version`, and per-module file lists must match; each
  loaded source is hash-verified against the lockfile.
- When the lockfile records `imports`, every bundle resolution edge must land on
  the file the lockfile attests for that `(parent, specifier)`. The conditions key
  is matched exactly first; on a miss (e.g. a static bundle's `"*"` edges vs a
  runtime lockfile's precise condition sets, or vice versa) the edge passes only if
  every condition set the lockfile records for that parent+specifier agrees on the
  same target. Unknown or inconsistently-attested edges are fatal. This closes the
  redirect hole where a tampered bundle points a specifier at a *different*
  hash-valid file, while still letting a `stasis bundle` artifact validate against a
  runtime-generated lockfile when their graphs coincide. Lockfiles without
  `imports` skip the check (`lock = frozen` warns); regenerate to enable it.
- In `bundle = load` with `scope = full`, entry-point resolutions are checked
  against `entries`.

A legacy `version: 0` shape — flat top-level `sources` keyed by project-relative
path, with no `entries`/`modules`/`formats`/`imports` — is still accepted by
**offline tooling** (`stasis extract`, `stasis diff`, `stasis audit`,
`stasis sbom`): `Bundle.parse` regroups its flat sources by inferred module dir for
the metadata those commands need.

**`stasis run` refuses v0 bundles.** With no per-file `formats` (resources can't be
told from code; the loader can't attest module-vs-commonjs) and no `imports` map
(resolution edges go unchecked), serving or verifying one at runtime would silently
widen the trust boundary. Upgrade with `stasis run --bundle=replace` (starts fresh)
or `stasis bundle` (re-bundles from source). Bundles are always written as
`version: 1`.

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
under a language `imports` condition. They are for external static analysis /
inspection — **not** `stasis run --bundle=load`, which executes JavaScript through
Node's module hooks and rejects a non-JS `format` with a clear error. Every
reachable file is read from disk (symlinks whose real target escapes the bundle
root are refused) and bucketized by the nearest `package.json`, except PHP, which
buckets by the nearest `composer.json` (`vendor/<vendor>/<pkg>`, versions from
`vendor/composer/installed.json`). With no such manifest above a file, the
workspace bucket gets a placeholder identity
(`solidity-bundle`/`php-bundle`/`bash-bundle`/`rust-bundle` at `0.0.0`).

Dependency buckets carry an `ecosystem` (see the lockfile's list), attributed by
the install layout each file resolves out of:

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
`stasis.code.br` as code, as files in the usual `sources`/`modules` buckets, tagged
in `formats` by payload encoding:

- `resource` — valid UTF-8, stored raw (human-readable in the bundle; e.g. SVG).
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
`EXODUS_STASIS_FS`), picked up by both runs without repeating the flag. `--fs`
(either mode) requires an active bundle mode (`add`, `replace`, or `load`).

| Patched call (sync forms) | Captured as | Load behavior |
| --- | --- | --- |
| `readFileSync` | file bytes (see below) | serves bytes |
| `readdirSync` (no options) | `directory` — sorted JSON name array | serves listing |
| `lstatSync` / `statSync` (no options) | payload-free `stat:file` / `stat:directory` | answers kind |
| `existsSync` / `accessSync` / `realpathSync` | **not captured** (serve-only) | serves if path already carried |

`--fs=sync` patches the sync forms above; `--fs=async` also patches the callback
forms (`readFile`/`readdir`/`lstat`/`stat`/`access`/`realpath`) and the promise
forms `fs.promises.*` (i.e. `node:fs/promises`, covering a direct `import` of it
too). Each async wrapper records/serves identically to its sync sibling; a served
callback is always invoked asynchronously. Captured bytes and listings are
mode-independent, so a `--fs=async` bundle is read by either mode (a `--fs=sync`
load run just won't intercept async reads). Not patched: streams, `fs.opendir`,
`fs.readlink` (a resolver probe that treats a read error as "not a symlink", so an
absent recorded file still resolves unserved), the deprecated callback `fs.exists`.

Captures live in the usual `sources`/`modules` buckets, tagged in `formats`.

**`readFileSync`** is stored generically by extension: a recognized code extension
(`.json`/`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) with UTF-8 bytes keeps its Node
loader format; anything else (or non-UTF-8 bytes) falls back to
`resource`/`resource:base64`. A file both imported and read collapses to one entry.
The optional encoding argument (string or `{ encoding }`) is honored when serving;
an invalid encoding throws as fs does.

**`readdirSync`** stores a single-argument call as a sorted, JSON-serialized
`directory` so the attested bytes are reproducible regardless of OS order. Replay
is thus subtly un-faithful for that call — capture sees OS order, a `--bundle=load`
run sees the sorted listing — so code relying on `readdirSync` order should sort
explicitly. Calls with options (`encoding`, `withFileTypes`, `recursive`) pass
through untouched (not captured, not served). A listing captured at a package
bucket root sits at the bucket's own key: rel `''` in its `files`, format keyed at
the bucket dir (`.` for the project root).

**`lstatSync`/`statSync`** record a single-argument call's **kind** only. The real
call runs first (the program gets the genuine `Stats` and genuine errors); the
observed type is stored as a **payload-free** `stat:file`/`stat:directory` — no
bytes, hash, or `files` entry — so a path that is *only* stat'd still answers its
type getters on load. Only regular files and directories are modelled: a symlink
(under `lstat`), socket, or FIFO records nothing; a `statSync` through an in-root
symlink records the *target's* kind, keyed at the requested path. A path already
carried as content, or whose real location escapes the root, records no stat entry;
reading a stat-only path later (same run or a `lock=add`/`bundle=add` re-run)
upgrades the weak stat record to the real content record instead of conflicting. On
load, `.isFile()`/`.isDirectory()` answer from the bundle for any carried path — a
recorded file, `directory`, stat record, or an ancestor directory implied by a
recorded path (a bundled `node_modules/dep/index.js` proves `node_modules` and
`node_modules/dep` are directories) — so existence checks succeed even when the
path is absent from disk. Other `Stats` fields are the real stat's while the file
is on disk, and benign synthetic defaults (`0`/epoch/a file-or-directory `mode`)
once it's gone, so wrappers that read more than `isFile()`/`isDirectory()`
(graceful-fs's `statFixSync` reads `uid`/`gid`) keep working instead of re-throwing
`ENOENT`. Uncarried paths pass through; calls with options (`bigint`,
`throwIfNoEntry`) pass through untouched.

**`existsSync`/`accessSync`/`realpathSync`** (and the async `access`/`realpath` and
`fs.promises.*` forms) are existence/canonical-path probes: served for a carried
path, otherwise passed through. Unlike `lstat`/`stat` they are **serve-only, never
captured** — a file that is *only* probed (never read, stat'd, or imported) isn't in
the bundle and its probe falls through to disk on load; but a path the program does
`lstat`/`stat` gains a stat record these probes then answer from (same kind lookup).
Per call: `existsSync` answers `true`/`false`; `accessSync` serves a carried path
**read-only** (`F_OK`/`R_OK` succeed; `W_OK`/`X_OK` defer to the real fs, which
reports a bundle-only file as not writable); `realpathSync` returns the real
symlink-resolved path while the file is on disk and falls back to the **lexically**
resolved request path once bundle-only (a symlink in a surviving ancestor is not
re-resolved, so a tool that canonicalizes-then-compares under a symlinked ancestor
could see capture/load divergence). The `.native` variant is covered too.

Probes matter because build tools check a file *before* reading it, on a channel
that never touches its bytes. `@babel/core` guards config loading with
`fs.existsSync(babel.config.js)` and realpath-canonicalizes the path **before** it
`require()`s the file — so without serving the probe, a bundled-but-absent
`babel.config.js` reads as missing and Babel silently runs with no config. (An empty
on-disk `babel.config.js` "works" only because its existence passes the probe; its
bytes then come from the bundle via the module loader. Because Babel both probes
*and* `require()`s the config, it lands in `sources`, so the probe answers from the
bundle on load.)

Source-map sidecars (`*.map`) are an exception: build-time debug artifacts that
never affect a program's emitted output, yet tools read them regardless of any
"sourcemaps off" setting (e.g. `@babel/core` reads a transformed file's sibling
`.js.map` to chain an *input* source map no matter the bundler's `devtool`). So
under `--fs` every in-root `*.map` is treated as **non-existent** in both capture
and load — never captured, never served, an `ENOENT` to `readFileSync`/`readFile`,
`statSync`/`lstatSync`, `accessSync`/`realpathSync`, and `false` from `existsSync` —
so a stray map read neither aborts a capture nor bloats the lockfile/bundle, and a
captured build stays byte-identical to a hermetic replay. This is independent of
bundle mode: `--fs` attests reads in the lockfile whether or not a bundle is
written, so a map is excluded either way. To capture a `.map` as data instead, add
`map` to the `resources` allowlist; it is then recorded and served like any declared
resource — and once a `.map` is in the bundle it is served on load by membership,
even if that run omits `--resources=map`.

Content captures are hashed like any content (a `directory`'s integrity is the
sha512 of its JSON text), so the lockfile attests them and a frozen run verifies
them; a stat record has no content — its `formats` entry is the attestation,
cross-checked bundle-vs-lockfile like every other format.

When a bundler plugin runs with its own `bundleFile` (a *sidecar*), `--fs`
coordinates so the bundler's module graph isn't duplicated into the main bundle: a
read the sidecar already attests is skipped at capture and served from the sidecar
at load, while only non-graph reads land in main.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the three stasis files
in a directory without a sibling `package.json` is fatal, and they may appear in
only one directory along the path.
