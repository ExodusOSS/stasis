import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import semver from './semver.cjs'

const packageNameRegex = /^(@[\da-z-]+\/)?[\w-]+(\.[\w-]+)*$/u

// Override point for registry mirrors and offline tests; the default is the
// public npm registry the rest of this module already talks to.
const registryURL = () =>
  (process.env.EXODUS_STASIS_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/u, '')

// Resolve `name` + `spec` against the npm registry to a concrete published
// version with its tarball URL and integrity. `spec` may be an exact version,
// a dist-tag (default: 'latest'), or a semver range (the highest satisfying
// published version wins). Uses the abbreviated install metadata
// (application/vnd.npm.install-v1+json): it carries dist-tags + per-version
// dist info, which is all we need, at a fraction of the full packument size.
export async function resolvePackage(name, spec = 'latest', { signal = AbortSignal.timeout(30_000) } = {}) {
  assert(typeof name === 'string' && packageNameRegex.test(name), `Unexpected package name: ${name}`)
  assert(typeof spec === 'string' && spec.length > 0, `Unexpected version spec: ${spec}`)

  let res
  try {
    res = await fetch(`${registryURL()}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal,
    })
  } catch (cause) {
    throw new Error(`npm metadata request failed for ${name}: ${cause.message}`, { cause })
  }
  if (res.status === 404) throw new Error(`Package not found on the npm registry: ${name}`)
  if (!res.ok) throw new Error(`npm metadata request failed for ${name}: ${res.status} ${res.statusText}`)
  const meta = await res.json()
  const versions = meta.versions && typeof meta.versions === 'object' ? meta.versions : {}

  let version
  if (semver.valid(spec)) {
    version = spec
  } else if (typeof meta['dist-tags']?.[spec] === 'string') {
    version = meta['dist-tags'][spec]
  } else if (semver.validRange(spec)) {
    const candidates = Object.keys(versions).filter((v) => semver.valid(v) && semver.satisfies(v, spec))
    version = candidates.toSorted((a, b) => semver.compare(a, b)).at(-1)
  }

  const dist = version === undefined || !semver.valid(version) ? undefined : versions[version]?.dist
  if (typeof dist?.tarball !== 'string') {
    throw new Error(`No version matching "${spec}" found for ${name} on the npm registry`)
  }
  return { name, version, tarball: dist.tarball, integrity: dist.integrity, shasum: dist.shasum }
}

// Download tarball bytes. The caller MUST verify them against the
// registry-reported integrity (checkTarballIntegrity) before trusting them.
export async function downloadTarball(url, { signal = AbortSignal.timeout(120_000) } = {}) {
  let res
  try {
    res = await fetch(url, { signal })
  } catch (cause) {
    throw new Error(`npm tarball download failed: ${cause.message}`, { cause })
  }
  if (!res.ok) throw new Error(`npm tarball download failed: ${res.status} ${res.statusText} (${url})`)
  return Buffer.from(await res.arrayBuffer())
}

const SRI_ALGOS = ['sha512', 'sha384', 'sha256', 'sha1'] // strongest first

// Verify tarball bytes against the registry metadata. Prefers the strongest
// hash present in the SRI `integrity` string; old packages predating SRI only
// carry the legacy sha1 `shasum`. Throws on a mismatch or when the metadata
// has nothing to verify against -- unverifiable bytes must never be used.
export function checkTarballIntegrity(data, { integrity, shasum }) {
  if (typeof integrity === 'string' && integrity.length > 0) {
    const hashes = new Map()
    for (const entry of integrity.trim().split(/\s+/u)) {
      const sep = entry.indexOf('-')
      // SRI allows ?options after the digest; nothing meaningful lives there.
      if (sep > 0) hashes.set(entry.slice(0, sep), entry.slice(sep + 1).split('?')[0])
    }
    const algo = SRI_ALGOS.find((a) => hashes.has(a))
    assert(algo, `Unsupported tarball integrity format: ${integrity}`)
    const actual = createHash(algo).update(data).digest('base64')
    assert(actual === hashes.get(algo), `Tarball integrity mismatch: expected ${algo}-${hashes.get(algo)}, got ${algo}-${actual}`)
  } else if (typeof shasum === 'string' && shasum.length > 0) {
    const actual = createHash('sha1').update(data).digest('hex')
    assert(actual === shasum.toLowerCase(), `Tarball shasum mismatch: expected ${shasum}, got ${actual}`)
  } else {
    throw new Error('npm registry metadata carries no integrity hash for this tarball')
  }
}

export async function advisories(list, { signal = AbortSignal.timeout(30_000) } = {}) {
  const groups = new Map()
  for (const { name, version } of list) {
    assert(typeof name === 'string' && typeof version === 'string')
    assert(packageNameRegex.test(name), `Unexpected package name: ${name}`)
    assert(semver.valid(version), `Invalid version: ${version}`)
    if (!groups.has(name)) groups.set(name, new Set())
    groups.get(name).add(version)
  }

  const entries = [...groups].map(([k, v]) => [k, [...v].toSorted((a, b) => semver.compare(a, b))])
  const body = Object.fromEntries(entries.toSorted((a, b) => a[0] < b[0] ? -1 : 1))

  let res
  try {
    res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    throw new Error(`npm advisories request failed: ${cause.message}`, { cause })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`npm advisories request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  return res.json()
}
