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
      "files": { "src/index.js": "sha512-…", "scripts/build.sh": "sha512-…" }
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
    "scripts/build.sh": "shell",
    "node_modules/@exodus/bytes/index.js": "commonjs"
  },
  "executable": ["scripts/build.sh"]
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
  `podfile-lock`, `template`, `xml`, `env`, `fastlane`, `pbxproj`); `patch` (a
  `.patch` unified diff — e.g. pnpm `patchedDependencies`, patch-package — a
  UTF-8 text build input applied by a patch step, not runnable by Node); `resource`
  (raw UTF-8) / `resource:base64` (binary); and the filesystem-capture tags
  `directory`, `stat:file`, `stat:directory` (see "Filesystem captures"). Native
  tags come from the Metro native capture and aren't runnable by Node; `pbxproj`
  is an Xcode project file added via `stasis add`. The loader picks
  module-vs-commonjs and (for `*-typescript`) type-stripping purely from this
  value. Checked like `imports`: a mismatch is fatal, and on disk only the attested
  zone is enforced (`node_modules` files in `node_modules` scope, everything in
  `full`).
- `executable` lists the recorded files carrying a POSIX execute bit (see
  "Executable files"); the key is omitted when none do.
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
  "formats": { "src/index.js": "module", "scripts/build.sh": "shell" },
  "imports": {
    "*": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } },
    "node, import": { "node_modules/foo/index.js": { "./impl.js": "node_modules/foo/impl.js" } }
  },
  "executable": ["scripts/build.sh"],
  "sources": {
    ".": {
      "name": "@exodus/stasis",
      "version": "1.0.0-alpha.0",
      "files": { "src/index.js": "export const x = 1\n", "scripts/build.sh": "#!/bin/sh\n…" }
    }
  },
  "modules": {
    "node_modules/@exodus/bytes": {
      "name": "@exodus/bytes",
      "version": "1.15.0",
      "ecosystem": "npm",
      "files": { "index.js": "..." }
    }
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
- `executable` mirrors the lockfile's (see "Executable files"), restricted to the
  files that bundle carries — in a split layout each half lists only its own.
- `repo` (optional, right after `config`) records where the bundle was built:
  `{ "github": "owner/name", "directory": "packages/app", "commit": "<sha>" }`.
  Every field is optional and is validated only when present:
  - `github` must be a valid GitHub `owner/name`. The owner is 1–39 alphanumerics
    or single inner hyphens. The name is 1–100 characters of `[A-Za-z0-9._-]` and
    can't be `.` or `..`.
  - `directory` must be a non-empty string: the bundle root's repo-relative POSIX
    path, at most 1024 characters. It must be safe to use
    unencoded in a GitHub URL (`https://github.com/<github>/tree/<ref>/<directory>`):
    `/`-separated segments of `[A-Za-z0-9._~@+-]`, none empty, `.` or `..`. So it
    is normalized, never absolute and never escapes the repository, and has no
    backslash, drive prefix, space, `%`, `#`, `?` or `:`.
  - `root` must be `true`: the bundle root is the repository root. It replaces
    `directory` there (the two are exclusive), so a missing `directory` means
    "unknown", never "the root".
  - `commit` must be a full lowercase git object id (a 40-hex SHA-1 or a 64-hex
    SHA-256).

  Unknown keys and invalid values are rejected on both serialize and parse. The
  field is **purely informational**: it is never attested, never written to the
  lockfile, and ignored by every verification. Adding to an existing bundle
  (`stasis add`, `stasis bundle --add`, `stasis run` with `bundle = add`) never
  overwrites its `repo`: only the fields that agree between the existing bundle and
  the new build survive, and none if `github` differs or the new build has none.
  `root` follows the same rule as `directory`. For example, the same repository
  and directory at a different commit keeps `github` and `directory` and drops
  `commit`.

  Bundles written by `stasis run` (and the bundler plugins), `stasis bundle`, and
  `stasis add` fill in `repo` automatically, from git first:
  1. **Git:** the nearest work tree root (a directory holding `.git`) at or above
     the bundle root. `github` comes from the `[remote "origin"]` url in
     `.git/config`, `directory` from the bundle root's path below the work tree
     root, and `commit` from `HEAD` (a detached sha, or the branch's loose ref or
     `packed-refs` entry). stasis only reads files under `.git` and never runs git.
  2. **package.json:** if git yields no GitHub origin, the nearest `package.json`
     at or above the bundle root that declares a `repository`, up to the work tree
     root. `github` comes from its GitHub URL or `github:`/`owner/name` shorthand,
     and `directory` from `repository.directory` combined with the bundle root's
     path below that `package.json`. When `repository.directory` is unset, a GitHub
     `homepage` of the same repository such as
     `https://github.com/owner/name/tree/main/packages/app#readme` supplies it
     (`packages/app`; the branch is taken as one path segment). No `commit` is recorded. A `package.json`
     naming a non-GitHub repository records nothing.

  At the repository root, detection records `root: true` rather than a
  `directory`. A detected value that the rules above would reject is left out
  instead of failing the write; a directory that isn't URL-safe therefore records
  neither `directory` nor `root`. In a split layout (`resourcesBundleFile`), each half
  records the origin of its own contents: a fresh write gives both the detected
  `repo`, and adding to one half merges only that half's.

A legacy `version: 0` shape — flat top-level `sources` keyed by project-relative
path, with no `entries`/`modules`/`formats`/`imports` — is still accepted by
**offline tooling** (`stasis extract`, `stasis diff`, `stasis audit`,
`stasis sbom`): `Bundle.parse` regroups its flat sources by inferred module dir.

**`stasis run` refuses v0 bundles** (no per-file `formats`, no `imports` map, so
runtime serving/verifying would widen the trust boundary). Upgrade with
`stasis run --bundle=replace` (starts fresh) or `stasis bundle` (re-bundles from
source). Bundles are always written as `version: 1`.

### Contents-free bundles

`Bundle.fromJSON(value)` is `Bundle.parse` on an already-parsed value. A
streaming reader takes each file's contents out as they arrive
(`Bundle.fileKeyAt(path)` names the file at a key path in the bundle JSON),
leaves a symbol in its place, and calls
`Bundle.fromJSON(value, { contents: false })`. That validates the bundle as
`Bundle.parse` does and rejects any file still holding contents. The result keeps every field and each bucket's file list
(`Object.keys`, `Object.hasOwn`), but reading a file's contents throws, and so
do `sources`, `serialize()` and `merge()`. That is enough for metadata-only
consumers such as the `@exodus/stasis/sbom` API.

### Source-language bundles (Solidity / PHP / Bash / Rust)

`stasis bundle` dispatches on the entry file extension (no mixing within one
invocation; a directory entry is Solidity's, see below):

| Extension(s) | Language | How the graph is found | `format` / `imports` key |
| --- | --- | --- | --- |
| `.js` `.cjs` `.mjs` `.ts` `.cts` `.mts` | JavaScript / TypeScript | static require/import scan | Node format / `"*"` + conditions |
| `.sol` (or a directory) | Solidity | `import` statements, resolved as the project's build tool does (see below) | `solidity` |
| `.php` | PHP | literal `require`/`include` paths + Composer-autoloaded class references (PSR-4/PSR-0/classmap/files) | `php` |
| `.sh` `.bash` | Shell | `source`/`.`, `bash`/`sh` exec, direct `./x.sh`, `# Depends on:`, `# shellcheck source=` | `shell` |
| `.rs` | Rust | `mod` declarations (incl. `#[path = …]` / `#[cfg_attr(…, path = …)]`, inside inline modules too) + `use`/`extern crate` of a crate whose source is in-tree | `rust` |

These four are **`scope = full`, produce-only artifacts** in the same
`stasis.code.br` shape as a JS bundle, tagged with a language `format` and keyed
under a language `imports` condition. They are for external static analysis —
**not** `stasis run --bundle=load`, which executes JavaScript and rejects a non-JS
`format`. Every reachable file is read from disk (symlinks whose real target
escapes the bundle root are refused) and bucketized by the nearest `package.json`,
except PHP, which buckets by the nearest `composer.json`
(`vendor/<vendor>/<pkg>`, versions from `vendor/composer/installed.json`), and
Rust, which buckets by the nearest `Cargo.toml` `[package]` (a workspace member
is its own bucket; `version.workspace = true` resolves through the workspace
root). With no manifest above a file, the workspace bucket gets a placeholder
identity (`solidity-bundle`/`php-bundle`/`bash-bundle`/`rust-bundle` at `0.0.0`).

Solidity entries are `.sol` files or directories: a directory stands for every
`.sol` file under it, imported or not — `stasis bundle src test script` is what
`forge build` compiles, `stasis bundle contracts` what Hardhat compiles (Yul
sources are not collected). Symlinks are followed as forge's walker (walkdir)
follows them: a symlinked directory that is one already on the walk is a loop
and skipped, anything else is walked, so two links to one directory give two
copies. A directory entry that is missing or holds no `.sol` file is skipped
with a warning (a project without `script/` bundles with `src test script`);
only when no entry yields a file is it an error (when none exists, a mistyped
path: `no such file or directory`). Imports are found by a scan
that skips comments (a `//` comment ends at `\n` or `\r`) and string literals
(read as bytes: `\xNN` is one byte, and the path is those bytes as UTF-8), and
resolve the way solc does under the project's build tool:

- A relative import (`./`, `../`) is resolved against the importing file; one
  that climbs above the bundle root is refused (solc would clamp it to the
  root: `../../B.sol` from `src/A.sol` is `B.sol`).
- Remappings then apply as solc applies them: the longest matching context
  wins, then the longest prefix, then the one listed last. With a `foundry.toml`
  at the root they are the ones `forge build` uses (a port of foundry v1.8.3's
  discovery, checked against it): `FOUNDRY_REMAPPINGS`/`DAPP_REMAPPINGS`, the
  root `remappings.txt`, the `remappings` of `[profile.default]` overlaid by the
  `FOUNDRY_PROFILE` profile (with its `extends` base), the remappings of every
  dependency that is itself a Foundry project (its `foundry.toml` and
  `remappings.txt`, relativised onto it, transitively), and the ones forge
  auto-detects under the `libs` dirs (`lib/` and/or `node_modules/` when unset),
  including the contextual ones that scope a dependency's imports to its own
  copy of a package; aliases of the project's own `src`/`test`/`script` dirs
  are dropped, and `auto_detect_remappings = false` turns detection off.
A `foundry.toml` or `extends` base that isn't TOML, a config that isn't UTF-8
  (`foundry.toml`, `remappings.txt`, `.gitmodules`), a setting of the wrong type
  (`libs = "deps"`, a `src` that isn't a string, an `extends` that isn't a path
  or `{ path, strategy }`), and an invalid remapping (a `remappings.txt` line or
  `FOUNDRY_REMAPPINGS` entry that isn't `[context:]prefix=target`, or a
  `remappings` value that isn't an array of such strings), is an error naming
  the file (from the root), whosever it is and in every mode: nothing falls back
  to a default (forge refuses these too, but quietly skips a dependency's
  `foundry.toml` it can't read). So is a config that isn't a regular file: a
  FIFO, a device or a link to one (`remappings.txt -> /dev/stdin`) is never
  read, so the bundle can't stall on it or take the process's input as config. A `remappings.txt` line is trimmed as forge trims it, so a
  byte-order mark stays part of the first remapping. A dependency's config forge
  rejects for its settings (a missing `extends` base, nested inheritance) is
  skipped with a warning, as forge skips it.
  Profiles are `[profile.<name>]` tables and the legacy top-level `[<name>]`
  ones (the former wins key by key; `extends` counts only in the former, as in
  forge); names match case-insensitively. Not
  read: `~/.foundry/foundry.toml`, `FOUNDRY_CONFIG` and the other `FOUNDRY_*`
  overrides. When `FOUNDRY_PROFILE` (a profile the `foundry.toml` has; one it
  hasn't is warned about) or a remapping variable shapes the result, `stasis
  bundle` says so on stderr; the bundle doesn't record it.
  Without a `foundry.toml`, a root `remappings.txt` applies as written, as solc
  and Hardhat apply it (`@oz/=lib/oz` makes `@oz/X.sol` `lib/ozX.sol`; `x/=`
  makes `x/A.sol` `A.sol`).
  `--mapping=<file>` replaces the remappings with exactly the ones that file
  lists: a `foundry.toml`'s selected profile (with its `extends` base; a
  `remappings` key outside any table is taken too), or a `remappings.txt`. A
  remapping forge reads (from a `foundry.toml`, or a `remappings.txt` next to
  one) gets forge's trailing `/` on prefix and target
  (`forge-std=lib/forge-std/src` is `forge-std/=lib/forge-std/src/`).
- An unremapped non-relative import is looked up inside the importing Foundry
  library first (the include path forge adds for `lib/dep/src/A.sol` importing
  `src/B.sol`: each directory from the importer directory's parent up to the
  lib dir, as foundry-compilers tries them), then as a project file (solc's
  base path: `import "src/A.sol"`), then as a package file in `node_modules`,
  from the importer's directory up (Hardhat and Node: `hardhat/console.sol`,
  `@scope/pkg/contracts/X.sol`; a package's `exports` map doesn't apply to
  Solidity files). `--mapping` changes none of these lookups: a root
  `foundry.toml` still gives the `libs` (the default ones, warned, when forge
  would reject the file), and `FOUNDRY_PROFILE` picking them is reported (one
  that isn't a profile of the `foundry.toml` is warned about instead, as without
  `--mapping`); that `foundry.toml` and its `extends` base count among the
  config files read.

Dependencies are input the project didn't write, so whatever resolves an import,
the result must be a `.sol` file inside the bundle root (an `import ".env";` or
a remapping to `/opt/x/` is refused, stating why), and who owns a file is
decided by where it really is, spelled as the filesystem spells it (on a
case-insensitive one, `LIB/evil` is `lib/evil`). The dependencies are the
entries of forge's `libs` (an absolute one by its real path; a symlinked
`lib/forge-std` is the dependency where it points), Soldeer's `dependencies/`,
git submodules (`.gitmodules` read as git reads it: quoted and escaped paths,
and a key on its section header's line) and every `node_modules` package; a file
is a dependency's when its real path lies in one, however the path got there
(`src/vendor -> ../lib/dep/src` holds the dependency's code). An import from a
dependency must land on a dependency's file too: it may import its own files and
another dependency's (forge-std's `ds-test`), never the project's, whether
through a relative path, a base-path lookup, its own remappings or a symlink. A
symlink no one trusted placed is never followed: one planted inside a dependency
that leads out of it to anything but another dependency (`lib/evil/src/Evil.sol
-> ../../../.env`), and one outside the project that leads back into it (a
dependency linked from elsewhere, `lib/evil -> ../../shared/evil`, holding a
link to the project's `.env`). Links are followed one by one and the result
checked against the OS's own realpath: a path the two resolve differently (a
link target that isn't UTF-8, one whose `\` the OS reads as part of a name), or
one the OS can't resolve at all (a real path past `PATH_MAX`, a link whose end it
can't name: `/proc/self/fd/0` or `/dev/stdin` on a pipe), is refused, not
trusted; only a path with nothing there counts as missing. An `extends` path is
joined as forge joins it and resolved by the OS, so a `..` after a symlink leads
where forge's does, in the project's config and a dependency's alike. Whoever's import, entry or
manifest the path is, the import is refused, the entry rejected, the manifest
not carried, and a dependency's own `foundry.toml`, `extends` base or
`remappings.txt` skipped with a warning (one that is another dependency's file
is read). A dependency's config reaches only what the path from the root does:
one found through an absolute or `/proc/self/cwd` lib is judged by its real
path, a dependency outside the root reads nothing, and a dir a dependency's
`libs` names must be a dependency itself; a config refused says why. A
`package.json` that decides a file's package is refused the same way when a
dependency planted it as a link, and one that doesn't parse (a leading
byte-order mark is skipped, as npm skips it) or isn't a regular file is an error
naming it (not quoting it) rather than giving its files to the parent package; other bundles walk past
a malformed one, as they always have. A
link the project placed (a workspace package linked into `node_modules`, a
linked `lib/` entry, `src/vendor`) may lead anywhere in the root, and so may one
on the path the project was named by (a symlinked checkout); a workspace package
is the project's own code.

The config files are read, not bundled. `--manifests` bundles the build
description too: every config file the resolution read, whatever it's called (an
`extends = "base.conf"`, a `--mapping=remaps`), by its path in the project (by
its real path once a `..` or an absolute or `/proc/self/cwd` lib leads
elsewhere; one whose real path the OS can't give, past `PATH_MAX`, is refused:
normalized, its name would be another file's), the root's `foundry.lock`, `soldeer.lock`, `.gitmodules` and
`package.json`, and the `package.json`, `foundry.toml` and `remappings.txt`
of every package the bundle holds files of — `json` for a `package.json`,
`resource` otherwise, so `stasis extract` restores them. They are carried as
written, as `--package-json` carries `package.json`: stasis doesn't edit them,
so whatever they hold — an `eth_rpc_url` or `[rpc_endpoints]` URL with its API
key, an `[etherscan]` key, the credentials in a `.gitmodules` URL — is in the
bundle too. Keep secrets in the environment (`${VAR}` in `foundry.toml`) rather
than in these files, or don't pass `--manifests`. `hardhat.config.*`, being
code, and `.env` files are never carried. A config the resolution read that
can't be carried — one outside the bundle root (`extends =
"../shared-base.toml"`), a `.env` one (`base.env`, `.env.toml`, `.env.local`),
or one the ownership rules refuse — fails `--manifests`, naming it: without it
the bundle couldn't reproduce the resolution.

Rust entries are crate roots (`src/main.rs`, `src/lib.rs`, `src/bin/*.rs`,
`tests/*.rs`, …): their `mod` declarations resolve as siblings, as rustc does,
and so do those of a file a `#[path = …]` loaded. Each root gets its own module
tree, so a lib and its bin bundled together don't collide on `crate::`. A
`tests/*.rs` or `benches/*.rs` entry is compiled the way `cargo test` does:
`cfg(test)` holds, its `#[test]` fns and `#[cfg(test)]` modules are live, and
the package's dev-dependencies take part in the feature resolution. A `use`/`extern crate` naming a crate found in-tree pulls
that crate's root in: the package's own lib target (`use my_app::…` from
`main.rs`), a Cargo `path` dependency (incl. `workspace = true` ones and
`package = …` renames, honouring `[lib] path`), or a `cargo vendor`ed crate under
`vendor/`. Registry dependencies live in `~/.cargo/registry`, outside the bundle
root, so they're never read: vendor them first (`cargo vendor`). When a bundle
references crates it can't find and there is no `vendor/` dir, `stasis bundle`
says so and suggests it.

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
`0.0.0`; the workspace bucket carries no `ecosystem`. A Rust crate reached
through a Cargo `path` dependency is first-party (its own `Cargo.toml` bucket, no
`ecosystem`), not a registry dep.

What counts as a fatal unresolved reference differs by language:

| Language | Fatal if unresolved | Best-effort / tolerated |
| --- | --- | --- |
| Solidity | every `import` | — |
| PHP | every literal `require`/`include` path | Composer-autoloaded class refs (unresolved ones usually built-in/extension classes); a dynamic include with a static dir prefix pulls in that dir's `.php` files as candidates |
| Bash | every in-root `.sh`/`.bash` reference | PATH commands, `$VAR`/absolute/system paths, `../`-escaping sources (external); dynamic `source "${VAR}/x.sh"` followed via `# shellcheck source=` when present |
| Rust | every `mod foo;` not gated on an undecidable cfg (see the cfg rules below), incl. one whose `#[path]` names no file, or escapes the bundle root | a `mod` gated on a cfg the loader can't decide (`unix`, a feature of a package outside the resolved build, …); a `mod` inside a macro invocation body (`cfg_if! { … }` emits real ones, other macros may not — followed when the file exists); every path edge (`crate::`/`self::`/`super::`/relative `use`s, recorded best-effort and never widening the walk); crates not in-tree (see above); `include_str!`/`include_bytes!` assets |

A missing entry is always fatal.

Rust items whose cfg can never hold in the build are dead code for the bundle
and are skipped whole — a `#[cfg(test)] mod tests;` file, an inline
`mod tests { … }` with every module and `use` in it, a `#[test]` fn body — so
vendored crates' test modules stay out, and with them the dev-dependencies only
test code reaches for. Two kinds of cfg are decided:

- `test`, `doctest`, `doc` and `#[test]` are never on when a program is built.
- `feature = "…"` is decided per crate from **Cargo feature resolution**: the
  loader reads the `Cargo.toml` of every package in-tree (the root package or
  workspace, `path` dependencies, `vendor/`) plus `Cargo.lock`, and replays what
  `cargo build` of the entries' packages does — the roots start from their
  `default` feature, features imply features (`std = ["alloc", "dep:serde",
  "serde?/std"]`), enable optional dependencies and request dependency features,
  and every active dependency gets `default` plus what its dependents ask for,
  to a fixed point. A dependency's own dev-dependencies are nobody's build and
  never count (sha2's `[dev-dependencies] digest = { features = ["dev"] }`
  doesn't turn on digest's `dev`); the entries' packages' dev-dependencies
  count under resolver 1 only, since resolver 2 (edition 2021+, or
  `resolver = "2"`) keeps them out of a normal build. Target-specific
  dependency tables always count (an over-approximation: it only keeps files).
  The crate a versioned dependency resolves to comes from `Cargo.lock`, so two
  vendored versions of one crate each get their own features and edges. A
  package the resolved build doesn't pull in has unknown features, and its gated
  code is kept. The manifests and the lock are read with `@preventive/lockfile`'s
  strict TOML parser (so is a `foundry.toml`): a `Cargo.toml` or `Cargo.lock`
  that exists but isn't TOML stops the build, naming the file and line, and so
  does TOML those files are never written in (a local date, a byte order mark,
  U+FFFD where bytes weren't UTF-8).

`all(…)`/`any(…)`/`not(…)` compose; a predicate that reduces to true (`not(test)`,
an enabled feature) is as firm as no cfg, so a missing module behind it is fatal.
Target cfgs (`unix`, `target_os = …`) stay undecided and their code is kept. A
`cfg_attr` that applies a non-cfg attribute (`#[cfg_attr(docsrs, doc(cfg(…)))]`)
gates nothing.

`stasis bundle --cargo` takes the dependency graph and features from
`cargo metadata` instead of replaying the manifests. It is opt-in because it runs
cargo: nothing is compiled and no build script runs, but cargo reads the
project's `.cargo/config.toml` (which can point `build.rustc` or a wrapper at any
executable), may refresh the registry index, and writes `Cargo.lock` when there is
none — so only on a project you trust. It works with or without a
`.cargo/config.toml` that redirects crates.io to `vendor/`: a registry package
cargo read from `~/.cargo/registry` is matched to its vendored copy by name and
version. Note what it reports: `cargo metadata`
resolves the whole workspace with dev-dependencies and all targets, and gives one
feature set per package — the union across normal, dev and build dependency kinds
and across platforms (resolver-1-style unification). So `--cargo` describes
everything cargo would ever compile for the workspace, tests included, and can
enable features (and so bundle modules) that a plain `cargo build` of the entries'
packages leaves off; the manifest replay describes that build. Set
`EXODUS_STASIS_DEBUG=1` to have `stasis bundle` print the resolved features per
package, in either mode.

The root packages' features follow the same flags as `cargo build`, in either
mode: `--cargo-features=a,b` (repeatable; `x/feat` is a feature of the entries'
package named `x`, else of their dependency `x`, cargo's `dep/feat` form; a name
that matches neither is reported), `--cargo-no-default-features`,
`--cargo-all-features`. Without them, the roots get their `default` feature, as
`cargo build` does. For a `workspace = true` dependency the workspace entry
decides `default-features`: a member's `false` is ignored unless the workspace
disabled them too, as cargo warns.

Rust edge specs are the path as written (`crate::net::client::Client`,
`super::config::Config`, a `use crate::{a::B, c::D}` group flattened to one edge
per path); `mod <name>` for a module file (`mod outer::inner` when declared inside
inline module `outer`); `use <crate>` for a crate root. A `mod` whose files vary
by cfg — `#[cfg_attr(<pred>, path = …)]` variants, or same-name declarations
under exclusive `#[cfg(<pred>)]`s (`#[cfg(unix)] #[path = "u.rs"] mod sys;`
beside `#[cfg(windows)] #[path = "w.rs"] mod sys;`) — records a
`{ <pred>: file, …, "*": <default file> }` map, the same shape as a JS edge that
diverges per Metro platform.

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
  "formats": {
    "src/index.js": "module",
    "src/icon.svg": "resource",
    "src/logo.png": "resource:base64"
  },
  "imports": { "*": { "src/index.js": {} } },
  "sources": {
    ".": { "name": "...", "version": "...", "files": {
      "src/index.js": "…source…",
      "src/icon.svg": "<svg>…</svg>",
      "src/logo.png": "<base64>"
    } }
  },
  "modules": {}
}
```

In the lockfile a resource is hashed like any other file (sha512 of its raw bytes)
and carries the same `formats` tag, so a frozen run verifies a copied asset
byte-for-byte just as it does code.

## Executable files

Both the lockfile and the bundle carry an `executable` array: the project-relative
paths of the **recorded files** whose on-disk mode had any POSIX execute bit
(`0o111`) when they were captured. Sorted by the same `sortPaths` rule as
`entries`, and **omitted entirely when empty**, so an artifact with nothing
executable is byte-identical to one written before the field existed.

```json
{ "executable": ["scripts/build.sh", "node_modules/dep/bin/cli.js"] }
```

Two rules govern the list, enforced on **both** sides — at `serialize`, so a producer
that gets it wrong fails immediately with the offending path, and at `parse`, so a
hand-edited or tampered artifact fails closed:

1. **`executable` is a subset of the artifact's files.** Every entry names a file that
   artifact records. An entry for anything else is malformed — there would be nothing
   for `extract` to chmod.
2. **A non-full scope lists only `node_modules` files.** A `scope = node_modules`
   artifact records only its dependency tree (`sources` is not written), so a workspace
   path can't be among its files and is rejected outright.

- Files only. A `directory` capture is a listing and a `stat:*` record carries no
  content — an entry naming either is rejected, as is a duplicate.
- Ignored on a legacy `version: 0` bundle: v0 has no per-file `formats`, so those
  guards can't run, and `extract` is an untrusted-input path. Fail-safe — no bit granted.
- The bit is read from disk at capture, from a **regular file**, following symlinks
  (a link records its target's mode). A path that can't be stat'd at all is *unknowable*,
  not "not executable" — a transient failure never refutes a recorded bit.
- Disk is authoritative on re-capture: re-reading a file under `lock = add` /
  `bundle = add` refreshes its bit, dropping a stale entry for a file that has since
  lost the bit — a mode change is not a content change, so it needs no
  `--lock=replace`. This covers files the run actually re-reads; one absorbed from an
  existing artifact and never touched is carried forward unverified, like every other
  `add`-mode fact.
- **Windows records none and clears none.** Windows exposes no POSIX execute bits
  (every file stats as `0o666`), so a capture there can neither observe a bit nor
  refute one: it adds nothing, and — importantly — does *not* read "no bit" as "the bit
  was removed", so a Windows run can't strip the list a POSIX capture committed.
- Merging two artifacts (`stasis add`, `stasis bundle --add`) unions the lists, except
  that the **incoming** artifact wins for the files it records: re-adding a file that
  lost its bit clears the stale entry instead of resurrecting it.
- `stasis diff` reports execute-bit changes, so a permission flip on byte-identical
  files is visible to a review gate rather than reading as "no differences".
- `stasis extract` restores the bit — this is what the field is *for*; see
  [extract.md](extract.md). It is metadata carried alongside the bytes, **not** part
  of what `lock = frozen` / `bundle = frozen` verify: an artifact predating the field
  lacks it and still loads, and a mode-only drift is not a hash mismatch.

> [!NOTE]
> The bit reflects the tree on disk, not the recorded bytes, so it depends on how that
> tree got there. npm/pnpm preserve the modes in a package tarball, but git tracks only
> `100644`/`100755`, and `core.fileMode=false`, zip/`git archive` round-trips, and
> `COPY`/`tar` without mode preservation all flatten it — two checkouts of one commit
> can legitimately produce different `executable` arrays.

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
