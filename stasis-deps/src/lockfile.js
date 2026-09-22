import { parseYamlStream } from '@preventive/yaml'

import { parseDepPath, refToDepPath, stripPeerSuffix } from './dep-path.js'

// pnpm-lock.yaml (lockfileVersion 9, pnpm >= 9) into a typed model:
//   importers: Map<importerId, { dependencies, devDependencies, optionalDependencies }>, each a
//              Map<alias, { specifier, version }> (`version` is a dependency reference: a bare
//              version + peer suffix, an aliased `name@version`, or `link:<path>`);
//   packages:  Map<`name@version`, { name, version, resolution, engines, os, cpu, libc, hasBin,
//              deprecated, peerDependencies, peerDependenciesMeta, bin, bundledDependencies }>;
//   snapshots: Map<`name@version(peers)`, { dependencies, optionalDependencies (Map<alias, ref>),
//              transitivePeerDependencies, optional, id }>.
// Only the shape is validated here; what to do with a git/directory resolution or a patched
// dependency is the layout builder's call.

const SUPPORTED_MAJOR = 9

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function toDepMap(obj, where) {
  const out = new Map()
  if (obj === undefined || obj === null) return out
  if (!isObject(obj)) throw new Error(`pnpm-lock.yaml: ${where} must be a mapping`)
  for (const [alias, ref] of Object.entries(obj)) {
    if (typeof ref !== 'string') throw new Error(`pnpm-lock.yaml: ${where} '${alias}' must be a string reference`)
    out.set(alias, ref)
  }
  return out
}

function toImporterDeps(obj, where) {
  const out = new Map()
  if (obj === undefined || obj === null) return out
  if (!isObject(obj)) throw new Error(`pnpm-lock.yaml: ${where} must be a mapping`)
  for (const [alias, entry] of Object.entries(obj)) {
    if (!isObject(entry) || typeof entry.version !== 'string') {
      throw new Error(`pnpm-lock.yaml: ${where} '${alias}' must carry a 'version' reference`)
    }
    out.set(alias, { specifier: typeof entry.specifier === 'string' ? entry.specifier : '', version: entry.version })
  }
  return out
}

export function parsePnpmLockfile(text) {
  // @preventive/yaml reads exactly the subset pnpm writes (strict: anchors, tabs, duplicate keys and
  // ambiguous scalars are refused). A pnpm 12 lockfile for a project that pins its package manager
  // is a two-document stream -- the manager's own lockfile first, the project's second -- so the
  // project's is the last document.
  const docs = parseYamlStream(text)
  const doc = docs.at(-1)
  if (!isObject(doc)) throw new Error('pnpm-lock.yaml: not a mapping')
  const version = String(doc.lockfileVersion ?? '')
  const major = Number.parseInt(version, 10)
  if (!Number.isInteger(major) || major !== SUPPORTED_MAJOR) {
    throw new Error(`pnpm-lock.yaml: unsupported lockfileVersion ${JSON.stringify(doc.lockfileVersion)} (stasis --pnpm reads lockfileVersion ${SUPPORTED_MAJOR}.x, written by pnpm >= 9; run \`pnpm install\` with a current pnpm to upgrade it)`)
  }
  if (!isObject(doc.importers) || Object.keys(doc.importers).length === 0) {
    throw new Error('pnpm-lock.yaml: no importers recorded')
  }

  const importers = new Map()
  for (const [id, entry] of Object.entries(doc.importers)) {
    if (!isObject(entry)) throw new Error(`pnpm-lock.yaml: importer '${id}' must be a mapping`)
    importers.set(id, {
      dependencies: toImporterDeps(entry.dependencies, `importers['${id}'].dependencies`),
      devDependencies: toImporterDeps(entry.devDependencies, `importers['${id}'].devDependencies`),
      optionalDependencies: toImporterDeps(entry.optionalDependencies, `importers['${id}'].optionalDependencies`),
    })
  }

  const packages = new Map()
  for (const [key, info] of Object.entries(doc.packages ?? {})) {
    if (!isObject(info)) throw new Error(`pnpm-lock.yaml: packages['${key}'] must be a mapping`)
    if (!isObject(info.resolution)) throw new Error(`pnpm-lock.yaml: packages['${key}'] has no resolution`)
    const parsed = parseDepPath(key)
    packages.set(key, {
      // An explicit name/version wins (non-registry keys like `foo@file:../foo` carry them).
      name: typeof info.name === 'string' ? info.name : parsed.name,
      version: typeof info.version === 'string' ? info.version : parsed.version,
      resolution: info.resolution,
      engines: isObject(info.engines) ? info.engines : undefined,
      os: Array.isArray(info.os) ? info.os : undefined,
      cpu: Array.isArray(info.cpu) ? info.cpu : undefined,
      libc: Array.isArray(info.libc) ? info.libc : undefined,
      hasBin: info.hasBin === true,
      deprecated: typeof info.deprecated === 'string' ? info.deprecated : undefined,
      peerDependencies: isObject(info.peerDependencies) ? info.peerDependencies : undefined,
      peerDependenciesMeta: isObject(info.peerDependenciesMeta) ? info.peerDependenciesMeta : undefined,
      bundledDependencies: info.bundledDependencies,
    })
  }

  const snapshots = new Map()
  for (const [key, info] of Object.entries(doc.snapshots ?? {})) {
    if (info !== null && !isObject(info)) throw new Error(`pnpm-lock.yaml: snapshots['${key}'] must be a mapping`)
    const pkgKey = stripPeerSuffix(key)
    if (!packages.has(pkgKey)) throw new Error(`pnpm-lock.yaml: snapshot '${key}' has no packages entry '${pkgKey}'`)
    const s = info ?? {}
    snapshots.set(key, {
      packageKey: pkgKey,
      dependencies: toDepMap(s.dependencies, `snapshots['${key}'].dependencies`),
      optionalDependencies: toDepMap(s.optionalDependencies, `snapshots['${key}'].optionalDependencies`),
      transitivePeerDependencies: Array.isArray(s.transitivePeerDependencies) ? s.transitivePeerDependencies : [],
      optional: s.optional === true,
    })
  }

  return {
    version,
    settings: isObject(doc.settings) ? doc.settings : {},
    importers,
    packages,
    snapshots,
    overrides: isObject(doc.overrides) ? doc.overrides : {},
    patchedDependencies: isObject(doc.patchedDependencies) ? doc.patchedDependencies : {},
    catalogs: isObject(doc.catalogs) ? doc.catalogs : {},
  }
}

// The snapshot key an importer/snapshot dependency edge points at (null for `link:`); a reference
// naming a snapshot the lockfile does not record is a corrupt lockfile, so fail closed.
export function resolveDepRef(lockfile, alias, ref, from) {
  const depPath = refToDepPath(alias, ref)
  if (depPath === null) return null
  if (!lockfile.snapshots.has(depPath)) {
    throw new Error(`pnpm-lock.yaml: ${from} depends on '${alias}' -> '${ref}', but snapshot '${depPath}' is not recorded`)
  }
  return depPath
}
