import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Tarball acquisition for `stasis bundle --pnpm`: every package the lockfile names is downloaded
// into a content-addressed cache (keyed by the lockfile's SRI integrity), verified against that
// integrity, and handed back as bytes. Nothing is ever unpacked onto disk, and no package script
// runs -- the cache holds pristine `.tgz` files only. A cached tarball is re-verified on every
// read, so a tampered cache fails closed exactly like a tampered download.

export function defaultCacheDir({ env = process.env } = {}) {
  if (env.STASIS_PNPM_CACHE) return resolve(env.STASIS_PNPM_CACHE)
  const base = env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(homedir(), '.cache')
  return join(base, 'stasis', 'pnpm-tarballs')
}

const SRI = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/u

export function parseIntegrity(integrity) {
  // pnpm writes a single SRI; a space-separated list (npm style) yields the strongest entry.
  const parts = String(integrity ?? '').trim().split(/\s+/u).filter(Boolean)
  const order = ['sha512', 'sha384', 'sha256', 'sha1']
  let best = null
  for (const part of parts) {
    const m = SRI.exec(part)
    if (!m) continue
    if (best === null || order.indexOf(m[1]) < order.indexOf(best.algorithm)) {
      best = { algorithm: m[1], digest: m[2] }
    }
  }
  return best
}

export function integrityOf(bytes, algorithm) {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

// Cache file for an integrity: `<cache>/<algorithm>/<hex digest>.tgz`.
export function cachePathFor(cacheDir, { algorithm, digest }) {
  return join(cacheDir, algorithm, `${Buffer.from(digest, 'base64').toString('hex')}.tgz`)
}

function verify(bytes, parsed, label) {
  const actual = integrityOf(bytes, parsed.algorithm)
  const expected = `${parsed.algorithm}-${parsed.digest}`
  if (actual !== expected) {
    throw new Error(`stasis --pnpm: integrity mismatch for ${label}: expected ${expected}, got ${actual}`)
  }
}

async function download(url, { headers, signal }) {
  let res
  try {
    res = await fetch(url, { headers, signal, redirect: 'follow' })
  } catch (cause) {
    throw new Error(`stasis --pnpm: download failed for ${url}: ${cause.message}`, { cause })
  }
  if (!res.ok) throw new Error(`stasis --pnpm: download failed for ${url}: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

// Fetch (or read from cache) and verify one tarball. `entry`: { url, integrity, label, headers,
// local? } -- `local` names an on-disk `.tgz` (a `file:` dependency) read in place of a download.
export async function fetchTarball(entry, { cacheDir, signal, offline = false, fetchImpl = download } = {}) {
  const parsed = parseIntegrity(entry.integrity)
  if (!parsed) throw new Error(`stasis --pnpm: ${entry.label} has no usable integrity in the lockfile; refusing to fetch it unverified`)
  if (entry.local) {
    let bytes
    try {
      bytes = readFileSync(entry.local)
    } catch (cause) {
      throw new Error(`stasis --pnpm: ${entry.label}: local tarball not found at ${entry.local}`, { cause })
    }
    verify(bytes, parsed, `${entry.label} (${entry.local})`)
    return { bytes, fromCache: true }
  }
  const cached = cachePathFor(cacheDir, parsed)
  let bytes = null
  try {
    bytes = readFileSync(cached)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (bytes !== null) {
    try {
      verify(bytes, parsed, `${entry.label} (cached at ${cached})`)
      return { bytes, fromCache: true }
    } catch (err) {
      // A corrupt cache entry is evicted and re-fetched, not trusted.
      rmSync(cached, { force: true })
      if (offline) throw err
    }
  }
  if (offline) throw new Error(`stasis --pnpm: ${entry.label} is not in the tarball cache (${cached}) and --pnpm-offline forbids downloading it`)
  bytes = await fetchImpl(entry.url, { headers: entry.headers, signal })
  verify(bytes, parsed, `${entry.label} (downloaded from ${entry.url})`)
  mkdirSync(dirname(cached), { recursive: true })
  // Write-then-rename so a concurrent reader never sees a partial tarball.
  const tmp = `${cached}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, cached)
  return { bytes, fromCache: false }
}

// Fetch every entry with bounded concurrency; -> Map<entry.key, bytes>. Fails on the first error
// (aborting the rest): a bundle can't be built from a partial package set anyway.
export async function fetchTarballs(entries, { cacheDir, concurrency = 12, offline = false, fetchImpl, onProgress } = {}) {
  const out = new Map()
  const controller = new AbortController()
  const queue = [...entries]
  let failure = null
  let downloaded = 0
  let cached = 0
  // Each worker takes the next entry when its current one settles (a fixed-width pool).
  const worker = async () => {
    const entry = queue.shift()
    if (entry === undefined || failure !== null) return
    try {
      const { bytes, fromCache } = await fetchTarball(entry, { cacheDir, signal: controller.signal, offline, fetchImpl })
      if (fromCache) cached++
      else downloaded++
      out.set(entry.key, bytes)
      onProgress?.({ done: out.size, total: entries.length, entry, fromCache })
    } catch (err) {
      failure ??= err
      controller.abort()
      return
    }
    return worker()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()))
  if (failure) throw failure
  return { tarballs: out, downloaded, cached }
}
