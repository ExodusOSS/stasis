import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import tar from 'tar-stream'

import { checkTarballIntegrity, downloadTarball, resolvePackage } from '../apis/npm/index.js'
import { buildJsBundle } from './bundle.js'

const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const TYPES_FILE = /\.d\.(?:ts|mts|cts)$/u

// Split `name[@version]` into its parts; scoped names keep their leading
// `@scope/` (the lastIndexOf split leaves an index-0 `@` alone). A bare name
// selects the registry's `latest` dist-tag.
export function parseNpmSpec(spec) {
  assert(typeof spec === 'string' && spec.length > 0, 'Expected an npm package spec (name or name@version)')
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec, version: 'latest' }
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  assert(version.length > 0, `Invalid npm package spec: ${spec}`)
  return { name, version }
}

// Tarballs are cached as plain .tgz files. EXODUS_STASIS_CACHE_DIR overrides
// the location (tests point it at a tmp dir); otherwise XDG_CACHE_HOME or
// ~/.cache. Cached bytes are NEVER trusted as-is: every load re-verifies the
// registry-reported integrity, and a corrupt entry is refetched.
function npmCacheDir() {
  const base = process.env.EXODUS_STASIS_CACHE_DIR
    || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stasis')
  return join(base, 'npm')
}

export async function fetchNpmTarball({ name, version, tarball, integrity, shasum }) {
  // resolvePackage validated name (registry charset) and version (semver), so
  // the flattened filename can't traverse out of the cache dir.
  const cachePath = join(npmCacheDir(), `${name.replaceAll('/', '+')}-${version}.tgz`)
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath)
    try {
      checkTarballIntegrity(cached, { integrity, shasum })
      return cached
    } catch {
      console.warn(`[stasis] Cached tarball failed integrity check, refetching: ${cachePath}`)
    }
  }

  const data = await downloadTarball(tarball)
  // Fatal on a fresh download: bytes that disagree with the registry metadata
  // must never be cached or used.
  checkTarballIntegrity(data, { integrity, shasum })
  mkdirSync(dirname(cachePath), { recursive: true })
  // temp + rename so a concurrent reader never sees a half-written tarball
  const tmpPath = `${cachePath}.${process.pid}.tmp`
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, cachePath)
  return data
}

// Strip the tarball's single top-level folder (npm uses `package/`, but the
// prefix is not guaranteed -- npm itself strips one path component no matter
// what it's called) and reject anything that could escape the extraction root.
function tarEntryPath(name) {
  assert(!name.startsWith('/') && !name.includes('\\'), `Unexpected tar entry path: ${name}`)
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  assert(!parts.includes('..'), `Refusing tar entry escaping the package root: ${name}`)
  return parts.length < 2 ? null : parts.slice(1).join('/') // < 2: the top-level folder itself
}

// Parse a gzipped npm tarball into a path → content Buffer map without
// touching disk. Only regular files are accepted: npm never publishes links,
// and a symlink/hardlink in a tarball could alias files outside the package,
// so their presence is treated as hostile rather than skipped.
export async function extractNpmTarball(tgz) {
  let data
  try {
    data = gunzipSync(tgz)
  } catch (cause) {
    throw new Error(`npm tarball is not valid gzip data: ${cause.message}`, { cause })
  }

  const files = new Map()
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    let path = null
    try {
      assert(header.type !== 'symlink' && header.type !== 'link', `Refusing ${header.type} entry in npm tarball: ${header.name}`)
      if (header.type === 'file') path = tarEntryPath(header.name)
    } catch (err) {
      extract.destroy(err)
      return
    }
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      // Duplicate entries: the last one wins, matching tar extraction to disk.
      if (path !== null) files.set(path, Buffer.concat(chunks))
      next()
    })
  })
  await new Promise((resolve, reject) => {
    extract.on('finish', resolve)
    extract.on('error', reject)
    extract.end(data)
  })
  return files
}

// Derive bundle entry files from the extracted package's manifest: every leaf
// of `exports` across all conditions EXCEPT `types` (type declarations are
// erased before runtime), plus the legacy `main`, `browser`, and
// `react-native` fields (string form, or the replacement values of their map
// form). Only JS-family files can seed the scan, so .d.ts/.json/.css/.wasm
// targets are skipped, as are wildcard subpath patterns (`./pattern/*`) --
// they can't be enumerated without guessing what consumers request. Legacy
// fields get Node's historical extension/index fallback; `exports` targets
// are exact paths by spec. With neither exports nor main, Node's CJS default
// of ./index.js applies.
export function deriveNpmEntries(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const exact = new Set()
  const legacy = new Set()

  const addExports = (node) => {
    if (typeof node === 'string') {
      if (!node.includes('*')) exact.add(node)
    } else if (Array.isArray(node)) {
      for (const alternative of node) addExports(alternative)
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'types') continue
        addExports(value)
      }
    }
  }
  if (pkg.exports !== undefined) addExports(pkg.exports)

  if (typeof pkg.main === 'string') legacy.add(pkg.main)
  for (const field of ['browser', 'react-native']) {
    const value = pkg[field]
    if (typeof value === 'string') {
      legacy.add(value)
    } else if (value !== null && typeof value === 'object') {
      // Replacement map: the values are the files actually loaded on that
      // platform; the keys they replace are covered via main/exports already.
      for (const replacement of Object.values(value)) {
        if (typeof replacement === 'string') legacy.add(replacement)
      }
    }
  }
  if (pkg.exports === undefined && typeof pkg.main !== 'string') legacy.add('./index.js')

  const entries = new Set()
  const addEntry = (target) => {
    const rel = target.replace(/^\.\//u, '')
    if (rel.startsWith('/') || rel.split('/').includes('..')) return false // manifest may not point outside the package
    if (TYPES_FILE.test(rel) || !JS_EXTS.has(extname(rel))) return false
    let isFile
    try {
      isFile = statSync(join(pkgDir, rel)).isFile()
    } catch {
      isFile = false
    }
    if (!isFile) return false
    entries.add(rel)
    return true
  }
  for (const target of exact) addEntry(target)
  for (const target of legacy) {
    // Node's legacy main resolution: exact, then `.js`, then `/index.js`
    // (.json variants exist too but aren't scannable entry points).
    if (addEntry(target)) continue
    if (addEntry(`${target}.js`)) continue
    addEntry(`${target.replace(/\/$/u, '')}/index.js`)
  }

  assert(entries.size > 0, `No JS entry points found in ${pkg.name ?? 'package'} (main/exports/browser/react-native)`)
  return [...entries].toSorted()
}

// Fetch `name[@version]` from the npm registry (latest when no version is
// given), verify the tarball against the registry-reported integrity (cache
// hits are re-verified on every load), extract it to a temp dir, and build a
// scope=full JS bundle from its manifest-derived entry points. The tarball
// carries only the package's own files -- its dependency tree is not
// installed -- so imports of bare specifiers that don't resolve are tolerated
// with a warning, while broken relative imports stay fatal (those are holes
// in the package itself). Returns the serialized bundle plus everything
// bundleCommand needs for its summary, never a live State: the temp dir is
// gone by the time this resolves.
export async function buildNpmBundle({ spec } = {}) {
  const { name, version } = parseNpmSpec(spec)
  const resolved = await resolvePackage(name, version)
  const tgz = await fetchNpmTarball(resolved)
  const extracted = await extractNpmTarball(tgz)
  assert(extracted.has('package.json'), `npm tarball for ${resolved.name}@${resolved.version} has no package.json`)

  // realpath: on platforms where tmpdir() is a symlink (macOS /tmp),
  // Node's resolver returns real paths and State.relative would see every
  // scanned file as outside the root.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-npm-')))
  try {
    // Don't materialize stasis's own root-level artifacts from the tarball:
    // State would load a shipped stasis.config.json as the project config and
    // refuse our explicit scope. They're never import targets, so leaving
    // them off disk doesn't change what gets bundled.
    const stasisArtifacts = new Set(['stasis.config.json', 'stasis.lock.json', 'stasis.code.br', 'stasis.resources.br'])
    for (const [rel, content] of extracted) {
      if (stasisArtifacts.has(rel)) continue
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    // Stop State's project-root walk at the extraction dir: a stray
    // package.json in the tmp dir's ancestry must not become the workspace
    // root and shift every bundled path.
    const marker = join(dir, 'pnpm-workspace.yaml')
    if (!existsSync(marker)) writeFileSync(marker, '')

    const entries = deriveNpmEntries(dir)
    const state = await buildJsBundle({ cwd: dir, entries, scope: 'full', tolerateMissingBare: true })
    return {
      name: resolved.name,
      version: resolved.version,
      entries,
      sourceData: state.sourceData,
      lockData: state.lockData,
      files: [...state.sources.keys()],
      modules: state.modules,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
