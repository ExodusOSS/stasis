# Stasis File Formats

Stasis writes up to three files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled sources **and** resources | Brotli-compressed JSON |

There is no separate resources bundle. A single bundle holds both code and
resources, distinguished **per file** by its `format` (see below): code files
carry their loader format, resource files carry `resource` or `resource:base64`.

All stasis-generated files carry an integer `version` field. Lockfiles and
bundles are independently versioned. Paths are POSIX-style and relative to the
directory holding the lockfile; none may start with `..`.

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

`add` loads existing data and refuses to modify it; `replace` ignores it and
rebuilds from scratch; `frozen` loads it read-only and requires every
observed file to match; `ignore` tolerates it without loading or writing. An
unset `bundle` produces no bundle, and a stray one on disk is rejected (a
footgun guard). For `bundle`, `load`
additionally *serves* the recorded bytes in place of reading disk, whereas
`frozen` reads disk and verifies it against the bundle — making the bundle
itself the attestation, so a frozen bundle needs no sibling lockfile (it
"operates as a lockfile"). `bundle = load` is incompatible with
`lock = add | replace`; `bundle = frozen` composes with any `lock` mode; and at
least one of `lock`/`bundle` must be set. Unknown keys are rejected. If both the file
and env var set a key, they must match. Only `scope` is persisted into the
lockfile/bundle `config` block.

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
- `sources` keys are workspace package dirs — `"."` for the top-level
  package, workspace-relative paths for any others (must not contain
  `node_modules`); `modules` keys are dependency dirs (must contain
  `node_modules`). Classification is by the file's **real** path: a workspace
  package that pnpm links into `node_modules` via a symlink whose target lies
  outside any `node_modules` is recorded as a **source** under its real path
  (so it is omitted from a `node_modules`-scope bundle), not as a dependency
  under the symlink path. (A lockfile produced before this rule that recorded
  such a file under `node_modules/<dep>/…` must be regenerated — `lock = frozen`
  would otherwise flag the moved path as a resolution mismatch.)
- Each module record's `name`/`version` come from the owning `package.json`.
  `files` maps package-dir-relative paths to SRI digests
  (`sha512-<base64(sha512(bytes))>`).
- Dependency records carry an `ecosystem` (next to `name`/`version`) naming the
  package ecosystem they were installed from, using the SBOM/Package-URL `type`
  vocabulary where one exists: `npm` (`node_modules`), `composer` (Composer
  `vendor/…`), `cargo` (Rust `cargo vendor` crates), `github` (`forge install`
  git submodules from github.com), and `soldeer` (the Foundry-native Solidity
  package manager — no purl type exists, so this is a descriptive value).
  `ecosystem` reflects where the package physically resolved, not the bundle's
  language — a Solidity or Bash import pulled out of `node_modules` is an npm
  package, so it's tagged `npm`. The workspace/top-level buckets (`sources`,
  keyed `"."` or a workspace dir) are first-party code, not dependencies, so
  they omit `ecosystem`. Lockfiles/bundles written before this field existed
  simply lack it, and are still accepted on load.
- `imports` records the observed resolutions in the same shape as the
  bundle's `imports` map (conditions → parent file → specifier → resolved
  project-relative path), so the lockfile attests not just file bytes but
  which file each specifier resolves to. In `lock = frozen` runs the
  resolutions observed from disk are checked against it: a resolution that
  diverges from the recorded target is fatal (byte hashes can't see a
  specifier redirected to a *different* attested file, e.g. via an
  unattested `package.json` `main`); an edge the lockfile doesn't record is
  fatal in `scope = full` and tolerated for workspace parents in
  `scope = node_modules`, where the workspace is deliberately unattested.
  Lockfiles written before this field existed omit it; such lockfiles attest
  resolutions only as far as they were recorded (frozen runs warn about this).
- `formats` records each file's format in the same shape as the bundle's
  `formats` map. Code files use a Node loader format (`module`, `commonjs`,
  `json`, `module-typescript`, `commonjs-typescript`) or a source-language tag
  (`solidity`, `php`, `bash`, `rust`). Resource files use `resource` (content is
  raw UTF-8) or `resource:base64` (content is binary, base64-encoded) — this is
  what distinguishes a resource from code per file, and tells a reader how to
  decode the bundle payload. Filesystem captures (`stasis run --fs=sync`) add
  `directory` for a `fs.readdirSync` listing (the content is a sorted JSON array
  of names); a captured `fs.readFileSync` reuses the code or resource tags above.
  The integrity of a `directory` listing is the sha512 of its JSON text, just
  like any other content. The loader picks module-vs-commonjs and (for the
  `*-typescript` formats) whether type-shaped syntax is stripped purely from
  this value, so attesting it stops a tampered bundle — or a flipped, un-pinned
  `package.json` `type` on disk — from running hash-valid bytes under a
  different format. Checked the same way as `imports`: a mismatch is fatal, and
  on disk only the attested zone is enforced (`node_modules` files in
  `node_modules` scope, everything in `full`). Lockfiles predating this field
  omit it and attest formats not at all (frozen runs warn).
- File and module maps are sorted by the project's `sortPaths` rule
  (files-in-dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load | frozen`. `bundle = frozen` is self-attesting and requires
no lockfile. In `bundle = frozen` runs the bundle
is loaded read-only (never rewritten) and each file/resolution/format observed
from disk is verified against it, the same closed-set checks `lock = frozen`
applies from the lockfile — an unrecorded file, a byte/format mismatch, or a
resolution redirected to a different recorded file is fatal. When a lockfile/frozen
verification rejects something, that run writes nothing — so a detected mismatch can
never be baked into the lockfile or bundle (this holds even if user code swallows the
rejection and exits cleanly). The write is gated on the verification, not the exit code:
a run that exits non-zero for its own reasons (a server's own SIGINT shutdown, a CLI
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

- `entries`/`sources`/`modules` mirror the lockfile shape, with `files`
  recording the file's bytes instead of SRI digests. Code and `resource`
  files store raw UTF-8; `resource:base64` files store base64. `entries` and
  `sources` are present only when `scope = full`; `modules` may be
  omitted (treated as empty). A bundle that carries code in `scope = full`
  must declare at least one entry; a bundle with only resources (no code)
  may have none.
- `formats`: project-relative path → format. Code files use a Node loader
  format (`module`, `commonjs`, `module-typescript`, `commonjs-typescript`,
  `json`) or a source-language tag (`solidity`, `php`, `bash`, `rust`).
  Resource files use `resource` (raw UTF-8 payload) or `resource:base64`
  (base64 payload) — the per-file tag that both marks a file as a resource
  and says how to decode its bundle bytes. A `directory` tag (a `stasis run
  --fs` capture) marks a raw-UTF-8 JSON listing. May be missing per file for code
  whose format Node infers. TypeScript sources are stored verbatim (types
  intact); Node strips the types at load time based on the format.
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
  (`lock = frozen` warns about it); regenerate the lockfile to enable it.
- In `bundle = load` mode with `scope = full`, entry-point resolutions
  are checked against `entries`.

A legacy `version: 0` shape — flat top-level `sources` keyed by project-
relative path with no `entries`/`modules`/`formats`/`imports` — is still
accepted by **offline tooling** (`stasis extract`, `stasis diff`,
`stasis audit`, `stasis sbom`): `Bundle.parse` regroups its flat sources
by inferred module dir for the metadata those commands need.

**`stasis run` refuses v0 bundles.** A v0 bundle carries no per-file
`formats` (so resources can't be distinguished from code and the loader
can't attest module-vs-commonjs) and no `imports` map (so resolution
edges go unchecked) — serving or verifying one at runtime would silently
widen the trust boundary. Upgrade with `stasis run --bundle=replace`
(starts fresh, writes v1) or `stasis bundle` (re-bundles from source).
The bundle is always written as `version: 1`.

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
Dependency buckets carry an `ecosystem` like any other bundle, attributed by
the install layout each file resolves out of. A dep under `node_modules` is an
npm package whatever the language (so Solidity and Bash deps that resolve there
are `npm`). Beyond that, the Solidity bundler recognises Soldeer's
`dependencies/<name>-<version>/` layout (`soldeer`, name/version from the dir)
and `forge install` git submodules under `lib/<dir>/` (`github`, named
`owner/repo` from the github.com URL in `.gitmodules`); the Rust bundler
follows `use <crate>` into `cargo vendor`'s `vendor/<crate>/` directory and
tags those `cargo` (name/version from each crate's `Cargo.toml`). A git
submodule with no `package.json`/`branch`, or a Soldeer dir with no version
suffix, falls back to version `0.0.0`. The workspace bucket has none.

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

## Resources in the bundle

Resources (assets like images, fonts, or any non-code file a build references)
live in the same `stasis.code.br` as code — there is no separate resources
bundle. Each resource is a file in the usual `sources`/`modules` buckets, tagged
in `formats` by how its payload is encoded:

- `resource` — the bytes are valid UTF-8 and stored raw (human-readable in the
  bundle); used for text assets like SVG.
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

In the lockfile, a resource is hashed like any other file (sha512 of its raw
bytes) and carries the same `resource`/`resource:base64` entry in `formats`, so
a frozen run verifies a copied asset byte-for-byte just as it does code.

## Filesystem captures (`stasis run --fs=sync` / `--fs=async`)

The loader hooks capture the module graph; `--fs=sync` additionally monkey-patches the
**sync** readers `fs.readFileSync` and `fs.readdirSync`, plus the metadata/existence probes
`fs.lstatSync`/`fs.statSync`/`fs.existsSync`/`fs.accessSync`/`fs.realpathSync` (and only
those — no streams, `fs.opendir`, `fs.readlink` (a resolver probe that already treats a read
error as "not a symlink", so an absent recorded file resolves correctly unserved), the
deprecated callback `fs.exists`, …) so a program's
explicit file reads are recorded into the bundle (`--bundle=add|replace`) and served back
from it (`--bundle=load`). The same `--fs=…` flag is needed on the load run for the patch
to serve; an un-captured read falls through to the real disk read.

`--fs=async` patches everything `--fs=sync` does **and** the async counterparts —
the callback forms `fs.readFile`/`fs.readdir`/`fs.lstat`/`fs.stat`/`fs.access`/`fs.realpath`
and the promise forms `fs.promises.*` (which is `node:fs/promises`, so
`import … from 'node:fs/promises'` is covered too). Each async wrapper records/serves
identically to its sync sibling; a served callback is always invoked asynchronously. The
captured bytes and `directory` listings are the same regardless of mode — a bundle built
with `--fs=async` is read by either mode (the load run just won't intercept async reads
under `--fs=sync`).

Captures live in the usual `sources`/`modules` buckets, tagged in `formats`:

- A `fs.readFileSync(path)` is stored "generically by extension": a recognized code
  extension (`.json`/`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) carrying UTF-8 bytes
  keeps its Node loader format; anything else (and any of those whose bytes are not
  UTF-8) falls back to `resource`/`resource:base64`. A file that is both imported
  and read this way collapses to one entry. The optional encoding argument (string
  or `{ encoding }`) is honored when serving; an invalid encoding throws as fs does.
- A single-argument `fs.readdirSync(path)` is stored as `directory`: its listing is
  **sorted** and JSON-serialized so the attested bytes are reproducible regardless
  of the OS's directory order. Note this makes replay subtly *un*faithful to
  capture for that one call: at capture time the program sees the OS order, but on
  a `--bundle=load` run it receives the sorted listing, so code that relies on
  `readdirSync` ordering should sort explicitly. `readdirSync` calls with options
  (`encoding`, `withFileTypes`, `recursive`) pass through untouched, so such a call
  is not captured and is not served from the bundle on load.
- `fs.lstatSync(path)` and `fs.statSync(path)` are not themselves recorded; on a load
  run, for a path the bundle already carries — a recorded file, a `directory`, or an
  ancestor directory implied by a recorded file (a bundled `node_modules/dep/index.js`
  proves `node_modules` and `node_modules/dep` are directories) —
  `.isFile()`/`.isDirectory()` answer from the bundle so existence checks succeed even
  when the path is absent from disk. Other `Stats` fields/methods are the real stat's
  while the file is still on disk, and benign synthetic defaults (`0` / epoch / a
  file-or-directory `mode`) once it's gone — so fs wrappers that read more than
  `isFile()`/`isDirectory()` off the result (graceful-fs's `statFixSync` reads
  `uid`/`gid`, for example) keep working under `--bundle=load` instead of re-throwing
  `ENOENT`. Any path the bundle does not carry passes straight through to the real
  call.
- `fs.existsSync(path)`, `fs.accessSync(path)` and `fs.realpathSync(path)` (plus the async
  `fs.access`/`fs.realpath` and `fs.promises.*` forms) are **existence/canonical-path
  probes**, served (load run, for a path the bundle carries) and otherwise passed through.
  Like `lstat`/`stat` they are **serve-only — never captured**: a probe records nothing, so a
  file that is *only* existence-probed (never read or imported) is not in the bundle and its
  probe falls through to disk on load. They matter because build tools check a file *before*
  reading it on a channel that never touches its bytes: `@babel/core`, for one, guards config
  loading with `fs.existsSync(babel.config.js)` and realpath-canonicalizes the path **before**
  it `require()`s the file — so without serving the probe, a bundled-but-absent `babel.config.js`
  reads as missing and Babel silently runs with no config (an empty on-disk `babel.config.js`
  "works" only because its existence passes the probe; its bytes then come from the bundle via
  the module loader — and because Babel both probes *and* `require()`s the config, it is recorded
  in `sources`, so the probe answers from the bundle on load). `existsSync` answers `true`/`false`;
  `accessSync` serves a carried path **read-only** — `F_OK`/`R_OK` (existence/readable) succeed,
  but `W_OK`/`X_OK` (writable/executable) defer to the real fs, which reports a bundle-only file
  as not writable (the bundle is read-only); `realpathSync` returns the real symlink-resolved path while the file is on
  disk, and falls back to the **lexically**-resolved request path once it is bundle-only (so a
  symlink in a surviving ancestor directory is not re-resolved — for the absent-config case this
  is moot, but a tool that canonicalizes-then-compares a path under a symlinked ancestor could see
  capture/load divergence). Its `.native` variant is covered too.

Source-map sidecars (`*.map`) are an exception: they are build-time debug artifacts
that never affect a program's emitted output, yet tools read them regardless of any
"sourcemaps off" setting (e.g. `@babel/core` reads a transformed file's sibling
`.js.map` to chain an *input* source map no matter the bundler's `devtool`). So under
`--fs` every in-root `*.map` is treated as **non-existent** — never captured, never
served, an `ENOENT` to the reader (`readFileSync`/`readFile`, `statSync`/`lstatSync`,
`accessSync`/`realpathSync`, and `false` from `existsSync`) — in **both** capture and load,
so a stray map read neither aborts a capture nor
bloats the lockfile/bundle, and a captured build stays byte-identical to a hermetic
replay. This is independent of bundle mode: `--fs` attests reads in the lockfile whether
or not a bundle is written, so a map is excluded from the lockfile the same way either
way. To capture a `.map` instead (e.g. you genuinely ship one as data), add `map` to the
`resources` allowlist; it is then recorded and served like any other declared resource —
and once a `.map` is in the bundle it is served on load by membership, even if that run
omits `--resources=map`.

The two recorded kinds are hashed like any other content (the `directory` integrity
is the sha512 of its JSON text), so the lockfile attests them and a frozen run
verifies them. `--fs` (either mode) requires an active bundle mode (`add`, `replace`, or `load`).

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the three files
found in a directory without a sibling `package.json` is fatal, and they may
only appear in one directory along the path.
