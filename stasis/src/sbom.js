import semver from './apis/npm/semver.cjs'
import pkg from '../package.json' with { type: 'json' }

// `@exodus/stasis/sbom` — derive an SPDX 2.3 or CycloneDX 1.5 Software Bill of
// Materials from already-parsed stasis artifacts (`Bundle`/`Lockfile`
// instances). This module is deliberately free of file/transport concerns: it
// never reads disk and never touches brotli (`node:zlib`), so it can run
// wherever an artifact instance can be handed to it. The CLI glue that reads
// `stasis.code.br`/`stasis.lock.json` off disk (and so pulls in brotli) lives
// in `src/cmd/sbom.js`.

// Identity stamped into every generated SBOM's tool/creator metadata. The tool
// name is the published package name, per the command's spec.
const DEFAULT_TOOL = { name: '@exodus/stasis', version: pkg.version, vendor: 'Exodus Movement, Inc.' }

// Per-call UUID/timestamp without importing node:crypto — Web Crypto is global
// in modern Node, keeping this module dependency-light.
const newUuid = () => globalThis.crypto.randomUUID()

// purl `type`s we know how to mint. A dependency whose recorded ecosystem has
// no registered purl type (`soldeer`) gets no purl — better than a fabricated
// one — while npm/composer/cargo/github all map to official types.
const PURL_TYPES = new Set(['npm', 'composer', 'cargo', 'github'])

// Infer a whole artifact's ecosystem from its loader formats. Used for the
// first-party/workspace buckets (which never carry the per-dependency
// `ecosystem` field) and as the fallback for older artifacts that predate the
// field entirely. PHP bundles tag files with the `php` format and map to
// Composer; everything else (JS/TS, and the Solidity/Rust/Bash source bundles,
// which all bucket by `package.json`) uses npm-style names.
function detectEcosystem(artifact) {
  const formats = artifact.formats
  if (formats && typeof formats.values === 'function') {
    for (const format of formats.values()) {
      if (format === 'php') return 'composer'
    }
  }
  return 'npm'
}

// Legacy scope classification for artifacts predating the per-dependency
// `ecosystem` field: the "." bucket and other non-`node_modules` dirs are
// first-party, except in a Composer bundle where vendor packages live outside
// `node_modules`.
function classifyScope(ecosystem, dir) {
  if (dir === '.') return 'workspace'
  if (ecosystem === 'composer') return 'dependency'
  return dir.includes('node_modules') ? 'dependency' : 'workspace'
}

// Split a package name into its purl/CycloneDX namespace (group) and bare name.
// npm scopes (`@scope/name`), Composer vendors and GitHub owners (`a/b`) all use
// the segment before the first slash; cargo crates and bare names have none.
function splitName(ecosystem, name) {
  const namespaced = ecosystem === 'composer' || ecosystem === 'github' ||
    (ecosystem === 'npm' && name.startsWith('@'))
  if (namespaced && name.includes('/')) {
    const slash = name.indexOf('/')
    return { group: name.slice(0, slash), name: name.slice(slash + 1) }
  }
  return { group: undefined, name }
}

// Build a Package URL (purl) — the cross-format component identifier SPDX and
// CycloneDX both understand — for a package in a known ecosystem, or null when
// the ecosystem has no purl type. Each path segment is percent-encoded (so an
// npm scope's `@` becomes `%40`), while the `/` namespace separator and the
// `@` before the version stay literal, per the purl spec. Composer and GitHub
// names are case-insensitive, so they're lowercased as the spec requires.
export function buildPurl(ecosystem, rawName, version) {
  if (!PURL_TYPES.has(ecosystem)) return null
  let { group, name } = splitName(ecosystem, rawName)
  if (ecosystem === 'composer' || ecosystem === 'github') {
    group = group?.toLowerCase()
    name = name.toLowerCase()
  }
  const namespace = group ? `${encodeURIComponent(group)}/` : ''
  return `pkg:${ecosystem}/${namespace}${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function compareComponents(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.version !== b.version) {
    if (semver.valid(a.version) && semver.valid(b.version)) return semver.compare(a.version, b.version)
    return a.version < b.version ? -1 : 1
  }
  return a.ecosystem < b.ecosystem ? -1 : a.ecosystem > b.ecosystem ? 1 : 0
}

// Collect the deduplicated, sorted set of packages recorded across one or more
// already-parsed stasis artifacts (`Bundle`/`Lockfile` instances). Unlike
// `stasis audit` (which inventories only installed dependencies to query the
// registry), an SBOM is the *full* bill of materials, so first-party/workspace
// packages are included too — tagged `scope: 'workspace'` vs. `'dependency'` so
// the formatters can pick a primary component. Buckets without a name+version
// (legacy v0 bundles record neither) are skipped: there is nothing to attest.
//
// Each dependency's `ecosystem` (npm/composer/cargo/github/soldeer) comes from
// the per-bucket field newer artifacts record; older artifacts predate it, so
// we fall back to inferring it from the file's loader formats and install path.
// Dedup is by ecosystem+name+version; a package seen as first-party in any
// artifact stays workspace regardless of argument order, so the output doesn't
// depend on how the artifacts are listed.
export function collectComponents(artifacts) {
  const seen = new Map()
  for (const artifact of artifacts) {
    const records = [...artifact.modules]
    // The per-dependency `ecosystem` field cleanly separates deps (tagged) from
    // first-party buckets (untagged). If no bucket carries it, the artifact
    // predates the field and we use the format/path heuristic for everything.
    const tagged = records.some(([, m]) => m.ecosystem !== undefined)
    const fileEcosystem = detectEcosystem(artifact)
    for (const [dir, { name, version, ecosystem }] of records) {
      if (!name || !version) continue
      let scope, eco
      if (ecosystem !== undefined) {
        scope = 'dependency'
        eco = ecosystem
      } else if (tagged) {
        // Untagged bucket in a modern artifact: first-party workspace code. Its
        // purl ecosystem is inferred (npm, or composer for a PHP project).
        scope = 'workspace'
        eco = fileEcosystem
      } else {
        scope = classifyScope(fileEcosystem, dir)
        eco = fileEcosystem
      }
      const key = `${eco} ${name} ${version}`
      const existing = seen.get(key)
      if (existing) {
        if (scope === 'workspace') existing.scope = 'workspace'
        continue
      }
      seen.set(key, { name, version, scope, ecosystem: eco, purl: buildPurl(eco, name, version) })
    }
  }
  return [...seen.values()].toSorted(compareComponents)
}

// Pick the single component the SBOM is *about* (its primary/root). That is the
// lone workspace package when there is exactly one; with zero or several
// workspace roots (a node_modules-only artifact, or several inputs/monorepo
// packages) the BOM has no single subject and every package is listed as a
// plain component. `rest` is everything that is not the primary.
function selectPrimary(components) {
  const workspace = components.filter((c) => c.scope === 'workspace')
  const primary = workspace.length === 1 ? workspace[0] : null
  return { primary, rest: primary ? components.filter((c) => c !== primary) : components }
}

// SBOM timestamps are RFC 3339 / ISO 8601 to whole seconds (SPDX's canonical
// `YYYY-MM-DDThh:mm:ssZ`); drop the milliseconds Date.toISOString includes.
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/u, 'Z')

// A CycloneDX bom-ref must uniquely identify a component within the document;
// the purl does when present, and ecosystem+name+version is unique by
// construction (it is the dedup key) otherwise.
const bomRef = (c) => c.purl ?? `${c.ecosystem}:${c.name}@${c.version}`

// Render an SPDX 2.3 document (as a plain object) for the collected components.
// The document DESCRIBES its primary component and the primary DEPENDS_ON each
// installed dependency (a flat graph — every package in a lockfile/bundle is a
// transitive dependency of the root). With no single primary the document
// DESCRIBES the workspace packages, or every package when there are none.
export function toSpdx(components, { tool = DEFAULT_TOOL, now = new Date(), uuid = newUuid() } = {}) {
  const { primary, rest } = selectPrimary(components)
  const ordered = primary ? [primary, ...rest] : components
  const ids = new Map(ordered.map((c, i) => [c, `SPDXRef-Package-${i}`]))

  const packages = ordered.map((c) => ({
    SPDXID: ids.get(c),
    name: c.name,
    versionInfo: c.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    ...(c.purl && {
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl }],
    }),
    primaryPackagePurpose: c.scope === 'workspace' ? 'APPLICATION' : 'LIBRARY',
  }))

  const relationships = []
  if (primary) {
    relationships.push({ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: ids.get(primary), relationshipType: 'DESCRIBES' })
    for (const c of rest) {
      if (c.scope === 'dependency') {
        relationships.push({ spdxElementId: ids.get(primary), relatedSpdxElement: ids.get(c), relationshipType: 'DEPENDS_ON' })
      }
    }
  } else {
    const workspace = ordered.filter((c) => c.scope === 'workspace')
    for (const c of workspace.length > 0 ? workspace : ordered) {
      relationships.push({ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: ids.get(c), relationshipType: 'DESCRIBES' })
    }
  }

  const docName = primary ? `${primary.name}@${primary.version}` : 'stasis-sbom'
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(docName)}-${uuid}`,
    creationInfo: {
      created: isoSeconds(now),
      creators: [`Tool: ${tool.name}-${tool.version}`, `Organization: ${tool.vendor}`],
    },
    packages,
    relationships,
  }
}

// Render a CycloneDX 1.5 document (as a plain object) for the collected
// components. The primary (workspace root) becomes `metadata.component`; the
// rest are listed in `components`, with a flat `dependencies` edge from the
// primary to each installed dependency.
export function toCyclonedx(components, { tool = DEFAULT_TOOL, now = new Date(), uuid = newUuid() } = {}) {
  const { primary, rest } = selectPrimary(components)
  const toComponent = (c) => {
    const { group, name } = splitName(c.ecosystem, c.name)
    return {
      type: c.scope === 'workspace' ? 'application' : 'library',
      'bom-ref': bomRef(c),
      ...(group && { group }),
      name,
      version: c.version,
      ...(c.purl && { purl: c.purl }),
    }
  }

  const doc = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      timestamp: isoSeconds(now),
      // CycloneDX 1.5 `tools.components` shape: the flat tools array is
      // deprecated in 1.5 (removed in 1.6), and newer consumers read this form.
      tools: { components: [{ type: 'application', publisher: tool.vendor, name: tool.name, version: tool.version }] },
      ...(primary && { component: toComponent(primary) }),
    },
    components: rest.map(toComponent),
  }
  if (primary) {
    const dependsOn = rest.filter((c) => c.scope === 'dependency').map(bomRef)
    doc.dependencies = [{ ref: bomRef(primary), dependsOn }]
  }
  return doc
}

// Dispatch to the requested format. `components` is the output of
// `collectComponents`; `options` accepts `{ tool, now, uuid }` for custom
// tool identity / deterministic output.
export function generateSbom(format, components, options) {
  if (format === 'spdx') return toSpdx(components, options)
  if (format === 'cyclonedx') return toCyclonedx(components, options)
  throw new Error(`sbom: format must be spdx or cyclonedx, got ${format}`)
}

// Convenience one-shot: collect the components from already-parsed artifacts and
// render them in `format`. Equivalent to
// `generateSbom(format, collectComponents(artifacts), options)`.
export function sbom(format, artifacts, options) {
  return generateSbom(format, collectComponents(artifacts), options)
}
