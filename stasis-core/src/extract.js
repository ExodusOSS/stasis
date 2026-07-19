import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js'
import { moduleFileKey } from './util.js'

const FILE_LOCK = 'stasis.lock.json'

// Reject non-canonical base64: Buffer.from silently drops invalid chars / accepts bad padding, so a tampered
// `resource:base64` could hash-spoof while round-tripping through extract. Require decode -> re-encode to be a fixed point.
function assertCanonicalBase64(content, file) {
  const buf = Buffer.from(content, 'base64')
  if (buf.toString('base64') !== content) {
    throw new Error(`extract: non-canonical base64 in resource:base64 content for ${file}`)
  }
  return buf
}

export function lockfileFromBundle(bundle) {
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, files }] of bundle.modules) {
    const hashed = Object.create(null)
    for (const [rel, content] of Object.entries(files)) {
      // Hash each file's raw on-disk bytes; decode 'resource:base64' back first (assertCanonicalBase64 rejects lying tags).
      const file = dir === '.' ? rel : `${dir}/${rel}`
      const bytes = bundle.formats.get(file) === 'resource:base64'
        ? assertCanonicalBase64(content, file)
        : content
      hashed[rel] = sha512integrity(bytes)
    }
    modules.set(dir, ecosystem === undefined
      ? { name, version, files: hashed }
      : { name, version, ecosystem, files: hashed })
  }
  // Carry imports+formats across, else the derived lockfile is bytes-only and a later frozen run skips those cross-checks.
  return new Lockfile({
    config: bundle.config,
    entries: bundle.entries,
    modules,
    imports: bundle.imports,
    formats: bundle.formats,
  })
}

// Extract stasis.code.br onto disk (default cwd) + derive a matching stasis.lock.json. v0 bundles extract sources only.
export function extractCommand({ cwd = process.cwd(), bundleFile, output } = {}) {
  if (!bundleFile) throw new Error('extract: a bundle file is required')
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  let bundle
  try {
    bundle = Bundle.parse(brotliDecompressSync(readFileSync(bundleAbs)).toString('utf-8'))
  } catch (cause) {
    // Bundle.parse throws message-less asserts; wrap so the user learns which file failed.
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }

  // v0 bundles have null metadata, so no lockfile can be derived (Lockfile.serialize requires name+version); extract sources only.
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)

  // Plan-first: validate every target is inside outDir before any write (no partial tree); walk modules, not the
  // last-wins `sources` getter. Containment is lexical -- symlinks in outDir are followed, so untrusted bundles need a fresh dir (see doc/extract.md).
  const writes = []
  const targets = new Set()
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // Skip a `directory` capture: it's a listing at the dir's own path, not a file to write (its children recreate the dir).
      // Look up format under moduleFileKey (a root listing's rel==='' maps to the dir, not `${dir}/`).
      if (bundle.formats.get(moduleFileKey(dir, rel)) === 'directory') continue
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      if (relToOut.startsWith('..') || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // Reject non-canonical paths (they change under the resolve+relative round-trip): writing them desyncs the tree from the lockfile.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      if (withLockfile && abs === lockAbs) {
        throw new Error(`extract: bundle contains ${FILE_LOCK}, which would collide with the derived lockfile`)
      }
      targets.add(abs)
      const data = bundle.formats.get(file) === 'resource:base64'
        ? assertCanonicalBase64(content, file)
        : content
      writes.push([abs, data])
    }
  }
  // A planned file must not also be a parent directory of another, else the writes throw halfway through.
  for (const [abs] of writes) {
    for (let d = dirname(abs); d.length > outDir.length; d = dirname(d)) {
      if (targets.has(d)) {
        throw new Error(`extract: bundle path used as both file and directory: ${relative(outDir, d)}`)
      }
    }
  }
  const lockText = withLockfile ? lockfileFromBundle(bundle).serialize() : null

  for (const [abs, content] of writes) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it
  if (withLockfile) writeFileSync(lockAbs, lockText)

  console.warn(`[stasis] Extracted ${writes.length} file(s)${withLockfile ? ` and ${FILE_LOCK}` : ''} to ${outDir}`)
  if (!withLockfile) {
    console.warn(`[stasis] Warning: legacy v0 bundle records no package name/version, so ${FILE_LOCK} can not be restored and was not written`)
  }
  return { dir: outDir, files: writes.length }
}
