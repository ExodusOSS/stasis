import semver from './apis/npm/semver.cjs'
import pkg from '../package.json' with { type: 'json' }

// Derive an SPDX 2.3 or CycloneDX 1.5 SBOM from already-parsed stasis artifacts (`Bundle`/`Lockfile`).
// Deliberately free of file/transport concerns (no disk, no brotli); the disk-reading CLI glue is src/cmd/sbom.js.

// Tool/creator identity stamped into every generated SBOM.
const DEFAULT_TOOL = { name: '@exodus/stasis', version: pkg.version, vendor: 'Exodus Movement, Inc.' }

// Web Crypto (global) instead of node:crypto, keeping this module dependency-light.
const newUuid = () => globalThis.crypto.randomUUID()

// purl types we can mint; an ecosystem with no registered type (`soldeer`) gets no purl rather than a fabricated one.
const PURL_TYPES = new Set(['npm', 'composer', 'cargo', 'github'])

// Infer an artifact's ecosystem from its loader formats: PHP bundles map to Composer, everything
// else to npm. Used for untagged (first-party) buckets and as the fallback for legacy artifacts
// predating the per-dependency `ecosystem` field.
function detectEcosystem(artifact) {
  const formats = artifact.formats
  if (formats && typeof formats.values === 'function') {
    for (const format of formats.values()) {
      if (format === 'php') return 'composer'
    }
  }
  return 'npm'
}

// Legacy scope classification (pre-`ecosystem` artifacts): non-`node_modules` dirs are first-party,
// except in a Composer bundle where vendor packages live outside `node_modules`.
function classifyScope(ecosystem, dir) {
  if (dir === '.') return 'workspace'
  if (ecosystem === 'composer') return 'dependency'
  return dir.includes('node_modules') ? 'dependency' : 'workspace'
}

// Split a package name into purl/CycloneDX namespace (group) + bare name: npm scopes, Composer
// vendors and GitHub owners use the segment before the first slash; cargo and bare names have none.
function splitName(ecosystem, name) {
  const namespaced = ecosystem === 'composer' || ecosystem === 'github' ||
    (ecosystem === 'npm' && name.startsWith('@'))
  if (namespaced && name.includes('/')) {
    const slash = name.indexOf('/')
    return { group: name.slice(0, slash), name: name.slice(slash + 1) }
  }
  return { group: undefined, name }
}

// Build a Package URL (purl) for a known ecosystem, or null when it has no purl type. Each path
// segment is percent-encoded (npm scope's `@` -> `%40`) while the `/` namespace separator and the
// `@` before the version stay literal; Composer and GitHub names are lowercased, per the purl spec.
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

// Collect the deduplicated, sorted set of packages across parsed artifacts. Unlike `stasis audit`
// (installed deps only), an SBOM is the *full* bill of materials, so workspace/first-party packages
// are included too, tagged scope 'workspace' vs 'dependency'. Buckets without a name+version are
// skipped. Dedup is by ecosystem+name+version; a package seen as workspace in any artifact stays
// workspace regardless of argument order, so output doesn't depend on how artifacts are listed.
export function collectComponents(artifacts) {
  const seen = new Map()
  for (const artifact of artifacts) {
    const records = [...artifact.modules]
    // The per-dependency `ecosystem` field separates deps (tagged) from first-party buckets (untagged);
    // if no bucket carries it, the artifact predates the field and we use the heuristic for everything.
    const tagged = records.some(([, m]) => m.ecosystem !== undefined)
    const fileEcosystem = detectEcosystem(artifact)
    for (const [dir, { name, version, ecosystem }] of records) {
      if (!name || !version) continue
      let scope, eco
      if (ecosystem !== undefined) {
        scope = 'dependency'
        eco = ecosystem
      } else if (tagged) {
        // Untagged bucket in a modern artifact: first-party workspace code; ecosystem inferred.
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

// Pick the single component the SBOM is *about* (its primary/root): the lone workspace package when
// there is exactly one; with zero or several workspace roots there's no single subject, so every
// package is a plain component. `rest` is everything that is not the primary.
function selectPrimary(components) {
  const workspace = components.filter((c) => c.scope === 'workspace')
  const primary = workspace.length === 1 ? workspace[0] : null
  return { primary, rest: primary ? components.filter((c) => c !== primary) : components }
}

// SBOM timestamps are RFC 3339 to whole seconds; drop the milliseconds Date.toISOString includes.
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/u, 'Z')

// A CycloneDX bom-ref must uniquely identify a component; use the purl when present, else
// ecosystem+name+version (unique by construction -- it's the dedup key).
const bomRef = (c) => c.purl ?? `${c.ecosystem}:${c.name}@${c.version}`

// Render an SPDX 2.3 document. It DESCRIBES its primary component, which DEPENDS_ON each installed
// dependency (flat graph). With no single primary, the document DESCRIBES the workspace packages,
// or every package when there are none.
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

// Render a CycloneDX 1.5 document. The primary (workspace root) becomes metadata.component; the
// rest go in `components`, with a flat `dependencies` edge from primary to each installed dependency.
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
      // CycloneDX 1.5 `tools.components` shape: the flat tools array is deprecated in 1.5 (removed in 1.6).
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

// Dispatch to the requested format; options: { tool, now, uuid } for custom identity / deterministic output.
export function generateSbom(format, components, options) {
  if (format === 'spdx') return toSpdx(components, options)
  if (format === 'cyclonedx') return toCyclonedx(components, options)
  throw new Error(`sbom: format must be spdx or cyclonedx, got ${format}`)
}

// Convenience one-shot: collectComponents then generateSbom.
export function sbom(format, artifacts, options) {
  return generateSbom(format, collectComponents(artifacts), options)
}
