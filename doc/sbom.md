# `stasis sbom`

`stasis sbom` exports a Software Bill of Materials (SBOM) from one or more
stasis lockfiles (`stasis.lock.json`) and/or bundles (`stasis.code.br`,
`stasis.resources.br`). It reads the same artifacts as `stasis audit` and emits
the package inventory they record in a standard, tool-agnostic format.

```sh
stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle) ...
```

- `--format` (**required**): `spdx` (SPDX 2.3, JSON) or `cyclonedx`
  (CycloneDX 1.5, JSON). There is no default — you must pick one.
- `--output` / `-o`: file to write the document to. Defaults to stdout; `-` is
  explicit stdout. Intermediate directories are created as needed. The one-line
  summary is always written to stderr, so it never corrupts a document streamed
  to stdout (e.g. `stasis sbom --format=spdx stasis.lock.json > sbom.json`).
- One or more positional arguments: the lockfiles/bundles to inventory.

## What it includes

Unlike `stasis audit` — which inventories only installed dependencies, to query
the npm advisory database — an SBOM is the **full** bill of materials, so
first-party/workspace packages are included alongside dependencies. Every
package bucket that records a `name` and `version` becomes one component:

- The lone **workspace root** (the `"."` bucket) is the document's *primary*
  component: `metadata.component` in CycloneDX, the `DESCRIBES` target in SPDX,
  typed `application`. When several inputs (or a monorepo) yield more than one
  workspace package — or a `node_modules`-scope artifact yields none — there is
  no single subject: every package is listed as a plain component and the SPDX
  document `DESCRIBES` the workspace packages (or all of them, if none).
- Installed **dependencies** are typed `library`. The primary component
  `DEPENDS_ON` each of them (CycloneDX `dependencies`, SPDX relationships) — a
  flat graph: every package a lockfile/bundle carries is a transitive
  dependency of the root.

Packages are deduplicated by ecosystem + name + version across all inputs and
sorted by name then version. Inventory is at the **package** level, not the
file level. Legacy `version: 0` bundles record no package `name`/`version`, so
they contribute nothing.

## Package URLs

Each component carries a [purl](https://github.com/package-url/purl-spec) — the
cross-format identifier both SPDX (`externalRefs`) and CycloneDX (`purl`)
understand — derived from the artifact's ecosystem:

| Artifact | Ecosystem | purl |
| --- | --- | --- |
| Lockfiles, JS/TS bundles, Solidity/Rust/Bash bundles | npm (names come from `package.json`) | `pkg:npm/<name>@<version>` |
| PHP bundles (files tagged with the `php` loader format) | Composer | `pkg:composer/<vendor>/<name>@<version>` |

npm scopes (`@scope/name`) and Composer vendors (`vendor/name`) map to the
purl namespace and the CycloneDX `group`; Composer names are lowercased per the
purl spec. The Solidity/Rust/Bash source bundles bucket by `package.json` like a
JS bundle, so their real dependencies get correct npm purls; the synthetic
workspace placeholder (e.g. `rust-bundle@0.0.0`) is just the primary component.

## Notes

- The generated document records `@exodus/stasis` (with its version) as the
  creating tool (SPDX `creationInfo.creators`, CycloneDX `metadata.tools`).
- `stasis sbom` does not reach the network — it reports exactly what the input
  artifacts attest, nothing more. Pair it with `stasis audit` to cross-check
  those same packages against published advisories.
