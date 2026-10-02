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
`package.json`; Rust bundles have `--cargo-manifests`, see below).

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
  (`foundry.toml`, `remappings.txt`, `.gitmodules`) — or a `.sol` file that isn't,
  which solc refuses and the bundle won't hold with U+FFFD in place of its
  bytes — a setting of the wrong type
  (`libs = "deps"`, a `src` that isn't a string, an `extends` that isn't a path
  or `{ path, strategy }`), and an invalid remapping (a `remappings.txt` line or
  `FOUNDRY_REMAPPINGS` entry that isn't `[context:]prefix=target`, or a
  `remappings` value that isn't an array of such strings), is an error naming
  the file (from the root) and the line or entry, never its text (a file named
  as a mapping by mistake may hold a secret), whosever it is and in every mode: nothing falls back
  to a default (forge refuses these too, but quietly skips a dependency's
  `foundry.toml` it can't read). So is a config that isn't a regular file: a
  FIFO, a device or a link to one (`remappings.txt -> /dev/stdin`) is never
  read, so the bundle can't stall on it or take the process's input as config.
  So is one there that can't be read, a link loop or a file in a directory that
  may not be searched: only nothing there (a link to nothing included) is no
  file, as `stat` tells them apart. A `remappings.txt` line is trimmed as forge trims it, so a
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
git submodules (`.gitmodules` read with `@preventive/lockfile`'s reader, as git
reads it; a url relative to the superproject's remote, or none, is taken as
written, the submodule then having no GitHub name to bucket it by. A file the
reader refuses — something git reads two ways, or doesn't check, such as
`update = none`, `active` or a `[core]` section — never fails the bundle: it's
warned about and read a submodule at a time (`[submodule.x]` as git reads it,
`[submodule "x"]`), each submodule's last `path`, `url` and `branch`, as git
reads a checkout's `.gitmodules`, dropping with a warning a branch or url that
doesn't read. One whose path doesn't fails closed: a path naming a directory
inside the repository, such as `./lib/x` or `lib/x/`, still makes it a
dependency, unnamed, and only one outside it is skipped. Every other path a
submodule is given (a `path` twice, or a second section of its name) is a
dependency too: git reads the first of two where it reads `.gitmodules` from a
commit, so no directory a submodule names is taken for the project's own. A
`.gitmodules` git itself refuses — a "bad config line", such as a header
`[submodule x]`, `[submodule.lib/x]` or `[submodule "x"` with no `]`, or a value
with no closing quote — is an error, as it is to git: read past, a submodule's
section would be lost, and its directory taken for the project's own) and every
`node_modules` package; a file
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
where forge's does, in the project's config and a dependency's alike, and so
does a bundle built from a Vfs (`stasis github-bundle`, `buildVfsBundle`), whose
host reads a path as the OS does. Whoever's import, entry or
manifest the path is, the import is refused, the entry rejected, the manifest
not carried, and a dependency's own `foundry.toml`, `extends` base or
`remappings.txt` skipped with a warning (one that is another dependency's file
is read). A dependency's config reaches only what the path from the root does:
one found through an absolute or `/proc/self/cwd` lib is judged by its real
path, a dependency outside the root reads nothing, and a dir a dependency's
`libs` names must be a dependency itself; a config refused says why. A
`package.json` that decides a file's package is refused the same way when a
dependency planted it as a link, and one that doesn't parse (a leading
byte-order mark is skipped, as npm skips it), isn't a regular file or can't be
read (a link loop, a directory that may not be searched) is an error naming it
(not quoting it) rather than giving its files to the parent package; a link to
nothing is no `package.json`, as to Node. Other bundles walk past a malformed
or unreadable one, as they always have, but the JS bundler's own lookups (its
resolver and its packages' names, on disk and in a Vfs) refuse one they can't
read as Node does (`ERR_INVALID_PACKAGE_CONFIG`). A
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
and so do those of a file a `#[path = …]` loaded. A `mod` declared inside
inline modules resolves under their directories, each an inline module's name
or its own `#[path = "…"]` (solana-program's `#[path = ""] mod non_bpf_modules
{ mod account_keys; }` finds `account_keys.rs` beside the file). A `mod` inside
an `include!`d file is the including module's child, as rustc splices it, but
its file is looked up beside the included file: `include!("gen/list.rs")` with
`mod bar;` in it finds `gen/bar.rs`, whose own submodules sit under `gen/bar/`
(checked against rustc). A `mod` a `macro_rules!` body declares is declared in
each module of its package that invokes the macro, by bare name or by path
(`crate::m!()`, a `$crate::m!()` in another macro's body) -- through the
macros whose bodies invoke it, the outermost call -- and found beside that
module's file, in the inline module the invocation sits in (not the ones
around the definition), as rustc expands it (serde_core's `crate_root!`,
defined in crate_root.rs and invoked in lib.rs, declares lib.rs's `de`:
`src/de/mod.rs`), under the cfgs the invoking file mounts the definition's
file with; a `#[macro_export]`ed macro's in every crate invoking it (`#[macro_use]
extern crate a; decl!();` declares the app's module). A `mod` in a
`macro_rules!` that another's body defines is that inner macro's, declared
where it is invoked. One nothing invokes is looked up beside the definition. When several
`#[path]` / `#[cfg_attr(<pred>, path = …)]` attributes sit on one `mod`, the
first whose predicate holds decides the file and ends the list, and the default
`name.rs` / `name/mod.rs` lookup is off; variants whose predicate is undecided
stay as cfg-keyed candidates. Each root gets its own module
tree, so a lib and its bin bundled together don't collide on `crate::`. A
`tests/*.rs` or `benches/*.rs` entry is compiled the way `cargo test` does:
`cfg(test)` holds, its `#[test]` fns and `#[cfg(test)]` modules are live, and
the package's dev-dependencies take part in the feature resolution; an
`examples/*.rs` entry links the dev-dependencies too, without `cfg(test)`. A `use`/`extern crate` naming a crate found in-tree pulls
that crate's root in: the package's own lib target (`use my_app::…` from
`main.rs`), a Cargo `path` dependency (incl. `workspace = true` ones and
`package = …` renames, honouring `[lib] path`), or a `cargo vendor`ed crate under
`vendor/` (or the `directory` of the source the cargo config replaces crates.io
with, through any chain of `replace-with`s, whatever its name, relative to the
directory holding the `.cargo` of the config writing it). The cargo config is
what cargo reads when run in the directory of the package the first entry
belongs to (its workspace root found from there): the config of that directory
and of each one above it -- above the bundle root too, read but never bundled;
not `$CARGO_HOME`'s -- merged key by key, the nearest first, as cargo merges
them (a nested workspace's `[source.vendored-sources] directory = "third"`
beside the bundle root's `replace-with`). The vendor directory, the `[patch]`
tables and the rustflags all come from that one reading. Which of a package's dependency tables a name means is the
asking code's, as cargo links them: a build script's, and its modules' -- a file
it shares with the lib through `#[path]` too -- the `[build-dependencies]`, a
test, bench or example's the `[dependencies]` and `[dev-dependencies]`, other
code's the `[dependencies]`; and of those only the tables of the platforms the
code is compiled for (`[target.'cfg(windows)'.dependencies] foo = "2"` is no
crate of a Linux build). Tables that may each apply -- a `cfg(windows)` and a
`cfg(unix)` one without a target, or a shared file's two -- are each followed,
and the edge is a cfg-keyed map of their crates. A
`path` or `[patch]` dependency outside the bundle root is not in-tree, and never
bound to a vendored crate of its name instead: the loader says so, and so it
does of a `path` naming a directory with no `Cargo.toml` holding a `[package]`.
Registry dependencies live in `~/.cargo/registry`, outside the bundle
root, so they're never read: vendor them first (`cargo vendor`). Whenever a
bundle references crates it lacks -- none in-tree, or one whose root the walk
refused (a symlink leading out of the bundle root) -- `stasis bundle` lists
them, `vendor/` dir or not, a dependency the package declares whether a `use`
or only an expression (`serde_json::to_string(…)`) names it. It lists too every
dependency a bundled package's build links that nothing in-tree answers,
however the code names it, if at all (`md-5`, used as `md5`: a crate's lib
name is its manifest's, which the bundle then lacks), as `md-5 (a dependency
of app 0.1.0)`: an active table of the build's platforms (one only maybe
applying too), a dev-dependency only for a test, bench or example entry, a
build-dependency only with `--cargo-manifests` and a build script. With no
`vendor/` dir it also suggests `cargo vendor`.

A path edge (`crate::a::b::Item`, `super::x`, a relative `child::y`) resolves
module by module along the crate's tree, inline `mod x { … }` blocks included
(a `mod imp;` file wins over an inline `mod imp { … }` of the same name under
another cfg). A segment that names no module may be bound by an import of the
module reached, which is followed: a `use` naming it outright (`pub use
serde_core as serde`, `extern crate serde_core as s`, `pub(crate) use helper`
of a `macro_rules!` macro), as far as its visibility reaches -- a plain `use`
only for a path written in that module or below, `pub(super)` / `pub(in …)`
within that scope -- or a glob (`pub use external::*`), when the module it
names is one of this crate and that module has the name: a `pub` child module
(a private `mod` is not glob-importable), an item it defines (a `struct`,
`fn`, `const`, … at module level, an `extern "C"` block's too -- not an
`impl`'s associated items or a fn's local ones; libc's `crate::sigset_t` lands
on the platform file whose `s! { … }` defines it, not on a later platform's
re-export of the name), or a name a `use` of its own binds. A segment with more
path after it names a module or a type-namespace item: a `fn log` or `const
libc` beside `use log::info` / `*const libc::c_char` never stands for the
crate, nor does a `use crate::util::log;` of such a fn -- `log::info!` names
the crate `log`, whose root the bundle loads on the tree pass's request when
the walk had taken the name for the fn. Where a module has several files or imports under cfgs that can't hold
together -- libc's platform modules, each glob re-exported from a `cfg_if!`
branch; mio's two `pub use … Waker` in two branches of one file; tokio's
macro-keyed `mod imp` variants -- a path means the candidate compatible with
the cfgs its own file was mounted under, checked along the whole chain of
imports followed: a file under `#[cfg(unix)] mod unix;` never resolves through
the fuchsia or windows branch (exclusive: a cfg and its negation, two values of
a single-valued key such as `target_os`, two variants of one `mod`, `windows`
against `unix`, an `any(…)` none of whose alternatives can hold -- libc's
`any(target_os = "linux", target_os = "l4re")` branch against a file under
`target_os = "aix"`), and of the compatible ones the first whose cfgs its own
entail (a candidate under the same `target_os` leaf it was mounted under, over
one under an `any(…)` nothing rules out). When none is entailed, every
compatible one under no custom cfg is the answer under its own cfgs, and the
edge is a cfg-keyed map of their files, the shape of a `mod`'s variants below
(a file under no platform cfg asking libc's `crate::sockaddr`, defined per
platform, maps each platform's file, not the first written) -- or that file,
when they agree. So does a path through such a module, the rest of it walked
through each (`use unix as imp;` beside `use windows as imp;`, a module two
cfg-gated globs bring in: `crate::imp::X` maps unix.rs and windows.rs), and
through a module there under a cfg the file doesn't hold beside another
binding of its name (`#[cfg(not(unix))] mod sys;` and `#[cfg(unix)] use
fallback as sys;`). Else the first under a custom cfg; and a candidate under a cfg
the build rules out (a feature that is off, another target) only when nothing
else fits -- unless the asking file is itself under such a cfg, when the build
says nothing: a file the target rules out asks as it would where it is
compiled, under its own cfgs rather than the target's (tokio's
atomic_u64_as_mutex.rs submodules' `super::AtomicU64` is as_mutex's, not the
native one, under a 64-bit target), and one whose own cfgs contradict each
other, compiled nowhere, maps every candidate. A positive cfg that neither rustc nor cargo sets (`loom`,
`docsrs`, `tokio_unstable`, mio's `mio_unsupported_force_poll_poll`, an
`any(…)` of such and of alternatives the file rules out) is a `--cfg` a default
build lacks, so a candidate under one is taken only after those, and one under
its negation (`not(loom)`) counts as certain -- unless the package's build may
set it: a name its build script prints as `cargo:rustc-cfg=…` -- itself or
through a build-dependency it calls (that crate's code, and that of what it
depends on) -- or that a rustflags `--cfg` sets (the `build`/`target.<…>`
`rustflags` of each cargo config the build reads, see above, `RUSTFLAGS`,
`CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_RUSTFLAGS`), is neither presumed off
nor on, and code there that formats a name, whole or in part
(`cargo::rustc-cfg=os_{}`, cfg_aliases' `cfg_aliases!`), writes the directive
apart from the name (build-rs's `rustc_cfg`) or uses `autocfg` makes every
custom cfg of its package so -- as does a build-dependency the bundle root
lacks. What full-line comments say counts for nothing. A child module the build rules out,
or one under a custom cfg it presumably lacks, gives way to whatever else its
module has of the name, as such a candidate does to any other: serde's
docsrs-only `mod de` to the `pub use serde_core::de` of every other build, a
`#[cfg(loom)] mod imp` to the `imp` a `use other::*` brings in -- but only when
none of its files may be there: a `#[cfg_attr(loom, path = "loom.rs")] mod
imp;` falls back to imp.rs in every other build, and shadows the glob. With `--cargo-target`, every file compiled
for the target is under the target's cfgs too, so a `windows` candidate is
out for every file and a `target_os = "linux"` file takes the `any(android,
linux)` branch over the `any(aix, solaris)` one (mio's `sys::Waker` is the
eventfd one under a Linux target; without one, the edge maps each branch's). An
item a module defines in several of its files follows the same ranking, the
module's own tree file first within a rank. A `cfg_if!` branch is
under its own predicate and the negation of every branch before it, nested
chains each on their own; a `#[cfg(…)]` on a macro invocation gates everything
its body declares (mio's `#[cfg(unix)] cfg_os_poll! { mod unix; … }`); the body
of a `cfg_<x>!` gate macro (tokio's `cfg_io_uring!`, mio's `cfg_os_poll!`) is
under the cfg its package's `macro_rules!` definition puts on each item it
wraps (`$( #[cfg(feature = "rt")] $item )*`, the same in every arm), so
`cfg_x!` and `cfg_not_x!` are told apart by their definitions, not their names;
one whose definition the loader can't read (none in the package, arms that
differ or write no cfg, two definitions that differ) is a gate it can't see
into, whose items are never certainly compiled nor ruled out; a
file mounted by several declarations is under any of their cfgs; a module
reached by several glob paths is under either's, and so is everything its own
globs reach. A module reached along glob paths under more than 16 different
cfgs (every path of a dense cycle of cfg-gated globs), or along one that is
already, is under an undecided cfg: never certain, never ruled out, exclusive
with nothing, so whatever stands under it is one candidate of the cfg-keyed
map, beside the others. A written `any(…)`, however many platforms it lists,
is decided like any other cfg. A glob
into the sysroot or into another crate brings in nothing the loader can see, so
it claims nothing -- and since a glob into a crate that isn't in-tree may well
provide a name, an unresolved lead in a file with such a glob (`use syn::*; …
punctuated::Punctuated`) is not reported as an unresolved crate -- unless the
file's package declares a dependency of that name, which the lead then is
(rustc rejects a name both a glob and a crate provide): one missing from the
bundle is reported whatever the globs beside it; a glob into an
in-tree crate explains only the names the module its path names there has, or
its own globs bring in (tokio's `use tokio::sync::*;` explains `mpsc`;
tracing's `use tracing_core::*;` does not hide its `tracing_attributes`), and a
glob into the sysroot or an enum explains none. An `extern crate x as y;` at
the crate root puts `y` in the extern prelude, so `y::…` and `::y::…` resolve
from every file of the crate, and `extern crate self as y;` puts the crate
itself there (syn's `use syn::parse::ParseStream` in syn is syn's own
parse.rs). At the crate root the final segment may be a
`#[macro_export]` macro (`$crate::name!`), which lives in the file defining it:
an invocation (`crate::helper!()`, recorded as `crate::helper!`) names the
macro -- each definition under its file's cfgs, ranked with an import of the
name that leads to a macro (a `pub use inner::m;` of the builds a `#[cfg(docsrs)]`
copy isn't in) -- before a module of that name, an ordinary path
(`crate::helper()`) the other way round. An invocation is looked up among
macros throughout: an item a module defines (`fn m`), a module, an import of
a module or crate, or one leading to a file that defines no macro of the
name (`pub use util::helper;` of a `fn helper`) is no `m!`, so a `fn m` beside
`use crate::macros::*` leaves the glob's `m!` in place. A one-segment path written at the
crate root names it when no crate has the name (anyhow's `pub use anyhow as
format_err;` in lib.rs; a child module's `use x;` does not reach it). The
answers are the same whatever order the files are listed in: each module's
files count in tree order, the variants of a `mod` as declared. Anything
else is an item of the module reached, whose file is the edge's target (a plain
item behind a glob re-export can't be placed more precisely). An import that
leads to another in-tree crate records that crate
(`use serde_core`); one that leads out of the bundle, to the sysroot (`pub use
core::result::Result`) or to a crate that isn't vendored, binds the name to
its own file as far as the bundle knows (serde's `$crate::__private::Result`
records the file of the `lib` module that re-exports `core::result`) -- a
candidate like any other, under its cfgs: tokio's `imp::AtomicU64` is std's,
re-exported in one variant file, or the mutex-based one the other defines. A
module's own items rank with its named imports, ahead of what its globs bring
in, which never shadows them (tokio's `crate::trace::trace_leaf` is the fn
defined under `cfg_not_taskdump!`, not the import under the `cfg_taskdump!`
that is off). The
module an import was first followed from is a dependency too: when nothing
else in the file points at its file, the path's prefix naming it is recorded
(`crate::__private` → private/mod.rs) -- unless that file is the crate root,
which every file of the crate hangs off anyway. An edge from a file to itself
is never recorded.

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
| Rust | every `mod foo;` not gated on an undecidable cfg (see the cfg rules below), incl. one whose `#[path]` names no file, or escapes the bundle root | a `mod` gated on a cfg the loader can't decide (`unix`, a feature of a package outside the resolved build, …); a `mod` inside a macro invocation body (`cfg_if! { … }` emits real ones, other macros may not — followed when the file exists); every path edge (`crate::`/`self::`/`super::`/relative `use`s, recorded best-effort and never widening the walk); crates not in-tree (see above); an `include!`/`include_str!`/`include_bytes!` whose literal path names no file, or whose argument is no literal the loader can read (a `concat!` of anything but `env!("CARGO_MANIFEST_DIR")` and literals, a macro variable) -- both warned; a vendored crate's include, `#[path]` or build script that reaches outside its own package (refused and warned; a `mod` so refused is missing) |

A missing entry is always fatal.

Rust items whose cfg can never hold in the build are dead code for the bundle
and are skipped whole — a `#[cfg(test)] mod tests;` file, an inline
`mod tests { … }` with every module and `use` in it, a `#[test]` fn body — so
vendored crates' test modules stay out, and with them the dev-dependencies only
test code reaches for. Two kinds of cfg are decided:

- `test`, `doctest`, `doc` and `#[test]` are never on when a program is built.
- `feature = "…"` is decided per crate from **Cargo feature resolution**: what
  `cargo build` of the entries' packages turns on. The loader reads the
  `Cargo.toml` of every package in-tree (the root package or workspace, `path`
  dependencies, `vendor/`), the `Cargo.lock` of the entries' workspace (beside
  its root manifest, below the bundle root too; a vendored crate's own published
  lock plays no part) and the `[patch]` of the cargo config with
  `@preventive/lockfile`'s Cargo reader, which reads them as cargo does and
  refuses what cargo would refuse or what it can't tell how cargo reads: a
  `Cargo.toml` with a key cargo doesn't know, a feature naming nothing, a
  `dep?/x` of a dependency no table makes optional, `[replace]`; a `Cargo.lock`
  older than version 3 (no `version`), or one that could be read two ways. Any
  of those stops the build, naming the file -- and so does text that isn't TOML,
  naming the line, or TOML those files are never written in (a local date, a
  byte order mark, U+FFFD where bytes weren't UTF-8); so is a `foundry.toml`.
  - **Cargo's resolver**, where the loader holds all it takes: the lockfile,
    `--cargo-target`, every package the lockfile has in-tree (each path package
    inside the bundle root, every other one vendored with its
    `.cargo-checksum.json`) and entries whose packages are workspace members.
    `@preventive/lockfile` lays the lockfile's graph over the manifests and
    turns on the features the build does, by cargo's rules throughout: each
    dependency table its own source (a git dependency is the git checkout, a
    registry one the registry's copy, whatever their versions), a `[patch]` from
    the root manifest or the cargo config, proc-macro crates and
    build-dependencies built for the host, `--cargo-features` handed out among
    the packages as cargo hands them out. A lockfile out of date with the
    manifests, a vendored copy whose checksum isn't the lockfile's, a feature
    asked of a package that hasn't it: each stops the build. A host the loader
    doesn't know (a target that isn't `host`) is resolved both ways: what the
    host's target-specific tables turn on is on *maybe*. A vendored copy the
    lockfile doesn't list needs no `.cargo-checksum.json`: cargo never reads it.
  - **The replay**, otherwise -- no lockfile, no target, a locked package not
    vendored or without its checksums, an entry outside the workspace -- and
    `stasis bundle` says so and why (`[stasis] Rust features from a replay of
    the manifests, not cargo's resolver: no --cargo-target`): the roots start
    from their `default` feature (a proc-macro crate is resolved for the host,
    where cargo builds it, and for the target too, where cargo activates a
    member it is asked to build), features imply features
    (`std = ["alloc", "dep:serde", "serde?/std"]`; `serde/derive` turns on the
    package's feature `serde` too, written or the one an optional dependency
    gets), enable optional dependencies and request dependency features, and
    every active dependency gets `default` plus what its dependents ask for, to
    a fixed point. A dependency's own dev-dependencies are nobody's build and
    never count (sha2's `[dev-dependencies] digest = { features = ["dev"] }`
    doesn't turn on digest's `dev`); the entries' packages' dev-dependencies
    count under resolver 1 only, since resolver 2 (edition 2021+, or `resolver =
    "2"`) keeps them out of a normal build. Resolver 2 also resolves what is
    built for the host -- build-dependencies, proc-macro crates and what they
    depend on -- apart from what is built for the target: a feature a
    build-dependency asks of a crate isn't on in that crate as a normal
    dependency. And it decides target-specific dependency tables: one counts
    when `--cargo-target` says it applies (a build-dependency's table against
    the host), and not when it says it doesn't; without a target, what only such
    a table enables -- a dependency, a feature -- is on *maybe*: its gated code
    is kept, but a missing module behind it is not fatal, and a candidate under
    it is never taken as certain. Resolver 1 unifies it all, every table
    included. The resolver is the workspace's: its `resolver`, else its
    edition. Each dependency table is a dependency of its own, as cargo has it:
    `rand = "0.7"` under `[dependencies]` beside `rand = "0.8"` under
    `[build-dependencies]` (or a `[dev-dependencies] fake = { package = "rand",
    version = "0.8" }`) is two crates, and a file is followed into the one its
    code uses (see above). The vendored
    copy a dependency resolves to is from where the dependency says: a git
    dependency's (or one a git `[patch]` replaces) a git checkout's -- a copy
    whose `.cargo-checksum.json` has no package checksum -- any other's a
    registry's; of those, the version `Cargo.lock` lists for the crate from that
    source that the requirement allows, so two vendored versions of one crate
    each get their own features and edges; a lock that lists only versions the
    requirement doesn't allow is out of date, and the loader says so and goes by
    the requirement, as when there is no lock entry: the one vendored version
    the requirement allows. Requirements are read by the semver crate's rules
    (`@preventive/lockfile`'s `rust-semver.js`): `1` takes no prerelease, `=2.0.0-rc.1`
    takes that one. A `[patch]` -- in the workspace root's manifest (one above
    the bundle root too), or in the cargo config the build reads (see above:
    nearest first, ahead of the manifest's, its `path` relative to the
    directory holding `.cargo`) -- replaces a crate of its table's source only (`[patch.crates-io]`
    crates.io's, `[patch."https://github.com/…"]` that repository's), and only
    where its version fits the dependent's requirement, as cargo applies it; one
    that doesn't is reported and not used.
    When the locked version isn't vendored, or no vendored version fits, or
    several do and no lock says which, the loader warns and doesn't follow the
    dependency rather than guess: cargo would build none of them from what the
    bundle holds.

  A package the resolved build doesn't pull in has unknown features, and its
  gated code is kept. A member bundled from its own directory, its workspace's
  root above the bundle root, takes what it inherits (`edition.workspace = true`,
  `dep = { workspace = true }`), the resolver and the `[patch]` from that root,
  as cargo does: the loader reads that manifest for those -- never bundling it,
  nor reading the lockfile beside it, nor a stale one beside the member, so
  cargo's resolver doesn't run -- unless its `exclude` takes the package (cargo
  then looks further up). A [workspace] whose `members` don't list the package
  is still its own, as it is to cargo: the package is a member there as a
  member's path dependency, or cargo refuses to build it.

- With `--cargo-target=<triple|host>`, **target cfgs** are decided too: the
  loader asks `rustc --print cfg --target <triple>` (`host`: the running
  rustc's own target, from `rustc -vV`) for the target's cfg set — `unix`,
  `windows`, `target_os`, `target_family`, `target_arch`, `target_env`,
  `target_vendor`, `target_abi`, `target_pointer_width`, `target_endian`,
  `target_has_atomic` — and `#[cfg(windows)]` code, a
  `#[cfg_attr(windows, path = …)]` variant or a `[target.'cfg(windows)'.dependencies]`
  table stays out of a Linux bundle. `target_feature` and `target_thread_local`
  stay undecided: a build may add features (`-C target-cpu=native`), and
  both differ with the toolchain and its flags. Profile cfgs
  (`debug_assertions`, `panic = …`) and custom ones stay undecided too. Build
  scripts (see `--cargo-manifests`), build-dependencies and proc-macro crates
  compile for the host: with `--cargo-target=host` its cfgs decide them as they
  decide the rest; with another target no platform cfg is decided in them, and
  a `[target.'cfg(…)'.build-dependencies]` table is on maybe (resolver 2). A crate
  compiled for both (a dependency that is also a build-dependency) is followed
  as both.
  This runs rustc — `$RUSTC` when set, as cargo honours it, else `rustc` from
  `PATH` — from the user's home directory (the filesystem root when there is
  none, or when the home directory is the bundle root or lies inside it, real
  paths compared), never
  from the project being bundled nor from a temp dir: a rustup proxy picks its
  toolchain from the `rust-toolchain(.toml)` files of the working directory
  and its parents, and such a file may name a `path` to any binary, so the
  project's own (untrusted input) and one planted in a world-writable directory
  must not choose what runs. To use a project's pinned toolchain, set
  `RUSTUP_TOOLCHAIN` or `RUSTC` yourself. It runs with a 60-second limit and
  `RUSTUP_AUTO_INSTALL=0`, so an uninstalled toolchain is an error, never a
  download on the loader's behalf, and needs only rustc's built-in knowledge
  of the target, not its standard library. A target only another
  toolchain knows needs that toolchain's rustc: Solana's `sbf-solana-solana` is
  known to the rustc in its platform-tools
  (`RUSTC=~/.cache/solana/<release>/platform-tools/rust/bin/rustc`), not to a
  rustup one. With `--cargo`, the same triple goes to `cargo metadata
  --filter-platform`.

`all(…)`/`any(…)`/`not(…)` compose, and `true` and `false` are what they say (a
raw `r#name` is the name; `r#true` and `r#false` are names, custom cfgs like any
other); a predicate that reduces to true (`not(test)`,
an enabled feature) is as firm as no cfg, so a missing module behind it is fatal.
A leaf's value is taken as written, spacing outside its quotes aside: `my = "a
b"` and `my = "ab"` (or `"a  b"`) are different values.
One an undecided leaf occurs in more than once is decided when it comes out the
same whatever that leaf is: an item's cfg joined with its enclosing blocks'
`all(any(test, kani), not(kani))` never holds (zerocopy's test-only `use
rand::…`), and `any(unix, not(unix))` always does.
Without a target, target cfgs stay undecided and their code is kept. A
`cfg_attr` that applies a non-cfg attribute (`#[cfg_attr(docsrs, doc(cfg(…)))]`)
gates nothing.

`stasis bundle --cargo` takes the dependency graph and features from
`cargo metadata` instead of resolving them itself. It is opt-in because it runs
cargo: nothing is compiled and no build script runs, but cargo reads the
project's `.cargo/config.toml` (which can point `build.rustc` or a wrapper at any
executable), may refresh the registry index, and writes `Cargo.lock` when there is
none — so only on a project you trust. It works with or without a
`.cargo/config.toml` that redirects crates.io to `vendor/`: a registry package
cargo read from `~/.cargo/registry` is matched to its vendored copy by name and
version. Note what it reports: `cargo metadata`
resolves the whole workspace with dev-dependencies and all targets, and gives one
feature set per package — the union across normal, dev and build dependency kinds
and across platforms (resolver-1-style unification). So `--cargo` takes each of
those features as on only *maybe*, in the target's build and the host's alike:
code under it, or under its negation (`cfg(not(feature = "x"))`, which a build
without `x` compiles), is kept, and only a feature outside the union is off.
It describes everything cargo would ever compile for the workspace, tests
included; the loader's own resolution describes the `cargo build` of the
entries' packages. Set
`EXODUS_STASIS_DEBUG=1` to have `stasis bundle` print the resolved features per
package and context (target, host), and which resolution they come from.

`stasis bundle --cargo-manifests` also carries what describes each bundled
package's build, the way `--package-json` carries npm manifests. For a package
of the project (the root package, a workspace member, a path dependency): its
`Cargo.toml` and the workspace `Cargo.toml` above it, and the build's
`Cargo.lock` and cargo configs: the lockfile of the entries' workspace (or of
their package, outside any) and the configs cargo reads when run in the
entries' package's directory (see above; `.cargo/config` before
`.cargo/config.toml`), those that lie inside the bundle root -- not a path
dependency's own lockfile or config, which no build of the entries reads. For a vendored crate:
its `Cargo.toml` and the `.cargo-checksum.json` cargo checks its files against
-- the lock and config it was published with play no part in a build that
depends on it. A vendored file the bundle reads is checked against that list
in any case, and so is the `Cargo.toml` of every vendored crate the bundle or
its resolution takes in, whose features and dependencies it reads: one changed since `cargo
vendor` stops the bundle, as cargo refuses to build it. All are `resource` files in their package's bucket, or the
workspace bucket for the root-level ones. They are carried as written, as `--package-json` carries `package.json`:
stasis doesn't edit them, so whatever they hold -- a `[registries]` token or
`[http]` proxy in the cargo config, the credentials in a `git = …` URL or a
lockfile's `source = "git+https://…"` -- is in the bundle too. Keep registry
tokens in `~/.cargo/credentials.toml` or the environment
(`CARGO_REGISTRIES_<NAME>_TOKEN`) rather than in these files, or don't pass
`--cargo-manifests`. A file that isn't UTF-8 text is refused, not altered.
Each package's build script
(`[package] build = "…"`, else `build.rs` beside the manifest; `build = false`
means none) is walked like a crate root of its own, compiled for the host, so
its modules and the in-tree `[build-dependencies]` it reaches (and their build
scripts, in turn) come along as Rust code. Nothing runs. A vendored crate (one
under the `vendor/` directory) is held to its own package directory: an
`include!`/`include_str!`/`include_bytes!`, a `#[path = …]` or a `build = "…"`
in it that reaches outside (`include_str!("../../../.git/config")`,
`concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env")`, an inline module's
`#[path = "../../.."]`) is refused with a warning, so a crate from the registry
can't carry the project's secrets into a bundle; the project's own code may
include anything under the bundle root. The check follows symlinks: a file of
a vendored crate that really lies outside its package (a link to the project's
`.env`, a linked directory of modules, a linked manifest) is refused too, and
so is a `[lib] path` outside the package.

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
inline module `outer`); `use <crate>` for a crate root; `include <path>`,
`include_str <path>` and `include_bytes <path>` for the file an include macro
names with a literal — a plain string with its escapes read (`"a \"b\".txt"`),
a raw string (`r#"…"#`), or `concat!(env!("CARGO_MANIFEST_DIR"), "/…")`, the
one `concat!` form the loader can read, relative to the package root, inside a
`#[doc = …]` attribute as much as in an expression; anything else, build output
under `concat!(env!("OUT_DIR"), …)` included, can't be followed and is warned
about unless it is `OUT_DIR`. `include!` splices Rust source, carried and
scanned as a file of its own; the other two carry an asset as `resource` /
`resource:base64`, each relative to the including file. Rust source -- a
module, an `include!`d file, a build script -- and an `include_str!` file are
UTF-8 text, as rustc requires: one that isn't stops the build, naming the
file, never carried with its bytes replaced; an `include_bytes!` file is any
bytes, carried as `resource:base64` when it isn't UTF-8. A file one place names
with `mod` or `include!` and another with `include_str!` is Rust: scanned and
followed, never a resource. An include written inside a `macro_rules!` body
resolves relative to each file that invokes the macro, as rustc expands it --
through the macros whose bodies invoke it, the outermost call (the edge is
that file's, at the invocation, by bare name or by path); so are the bare
macro calls a body makes made and resolved where it is invoked -- the body's
own, even past a `macro_rules!` it defines inside, whose own includes and
calls are its, made where it is invoked in turn. `<name>!` marks a `macro_rules!`
invoked by bare name and defined in another file the invocation can see -- in
textual scope, as rustc has it: the files above it in the module tree, each up
to the `mod` that mounts the next (a macro defined after `mod early;` is not
early.rs's), what a `#[macro_use] mod` hands the file mounting it, from that
`mod` on (tokio's `ready!` through `#[macro_use] mod macros;`; a nested
`#[macro_use]` reaches its own parent, not the crate), the later definition of
a name shadowing the earlier in source order whichever kind each is (serde's
`tri!`, defined by its root's `crate_root!()` after `#[macro_use] mod
crate_root;`, is the root's) as far as each call (a `macro_rules!` written
after a call doesn't reach it), a `macro_rules!` a macro's body declares
standing where that macro is first invoked in the file, and a `mod` it
declares at the invocation in each file hosting it (see above: serde's
`crate_root!`, declared in core/crate_root.rs and invoked in lib.rs after
`#[macro_use] mod macros;`, so `de` sees `forward_to_deserialize_any!`), and, in the crate
root's file, whose items they are, the `#[macro_export]`ed ones -- or by path,
through the module's imports (`use crate::combinator::dispatch;`, a `use
super::*` from the root), into another crate too (`use dep::mac;` or an alias
of it, a prelude's `pub use dep::mac;` behind a glob, the macro in the file
defining it); a crate root's `#[macro_use] extern crate dep;` brings dep's
exported macros to every module; `dep::mac!(…)` has an edge to that file
beside the crate's. Another crate's macro is the one its root names, as a path
there is resolved: each definition under its file's cfgs, judged by that
crate's own build (serde's docsrs-only copies of serde_core's macros give way
to its `pub use serde_core::forward_to_deserialize_any`, followed on into
serde_core), per-platform definitions a cfg-keyed map; and a path's lead is
the crate though the module imports a macro of the same name (`use
helper::{helper, mk}`: `mk!` is helper's). A `macro_rules!` in a sibling file is out of scope
otherwise. A file whose inner
`#![cfg(…)]` can never hold is carried but compiled empty, so nothing in it is
followed (a `#![cfg]` inside a macro invocation's body gates nothing). A `mod`
whose files vary by cfg — `#[cfg_attr(<pred>, path = …)]` variants, or
same-name declarations under exclusive `#[cfg(<pred>)]`s (`#[cfg(unix)] #[path
= "u.rs"] mod sys;` beside `#[cfg(windows)] #[path = "w.rs"] mod sys;`, the
`if #[cfg(unix)] { … }` branches of a `cfg_if!`, each later branch keyed by
the earlier cfgs not holding: `all(not(unix), windows)`, `all(not(unix),
not(windows))`) — records a `{ <pred>: file, …, "*": <default file> }` map,
the same shape as a JS edge that diverges per Metro platform; when every
predicate names one file (libc's `mod primitives` under a dozen) the edge is
that file. A
declaration a gate macro emits (tokio's `cfg_has_atomic_u64! { mod imp; }`
beside `cfg_not_has_atomic_u64! { mod imp; }`) is keyed by the macro
(`cfg_has_atomic_u64!`), whose definition's cfg decides between them; a second file under an already
used key gets it numbered (`*#2`) rather than dropped. A `use` is an import only
when a use tree follows it: the word in macro input (syn's `Token![use]`) or a
tree interpolating a metavariable (`use #path as _serde;` in a `quote!`) is not
one. The body of a `quote!`, `quote_spanned!`, `parse_quote!` or
`parse_quote_spanned!` is a token template for another crate's code and is
skipped whole -- unless the package defines a `macro_rules!` of that name
itself, in whichever of its files (syn's `parse_quote!`), when it is that
macro's input like any other -- while reading the files from disk too, so a
`mod` such a body declares is found whichever file the walk meets first.

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
