import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js'
import { moduleFileKey } from './util.js'

const FILE_LOCK = 'stasis.lock.json'

// Re-derive a Lockfile from an already-parsed Bundle. A bundle records each file's content
// (UTF-8 for code/'resource', base64 for 'resource:base64'); a lockfile records each file's SRI
// digest over its raw on-disk bytes. Both share the per-package bucket shape (name/version/files)
// plus entries/config metadata, so the conversion is just "hash each file's bytes" and carry
// everything else across verbatim.
//
// Requires a v1 bundle: v0 records no package name/version (Bundle.parse infers null-metadata
// buckets), and Lockfile.serialize must attest both for every node_modules bucket.
//
// The digest is over the same bytes we write to disk, so it equals what `stasis run --lock=add`
// records for the extracted tree and what `stasis prune` recomputes when validating it.
// Reject a 'resource:base64' content string that isn't canonical base64. Buffer.from silently
// drops invalid chars and accepts non-canonical padding, so a tampered bundle could ship
// `XXXX_invalid_chars==` whose decoded bytes hash to whatever it wants -- it would still
// round-trip through `extract` (decode -> write -> re-hash -> match), yet the on-disk file
// diverges from what an honest producer wrote. Fail closed by requiring decode -> re-encode to
// be a fixed point.
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
      // sha512 of each file's raw on-disk bytes -- the same hash `stasis run` produces. Decode
      // 'resource:base64' files back to raw bytes first; code and 'resource' are stored as raw
      // UTF-8 and hash identically either way (Node hashes a string as its UTF-8 bytes).
      // assertCanonicalBase64 closes the lying-tag hole by rejecting non-canonical base64.
      const file = dir === '.' ? rel : `${dir}/${rel}`
      const bytes = bundle.formats.get(file) === 'resource:base64'
        ? assertCanonicalBase64(content, file)
        : content
      hashed[rel] = sha512integrity(bytes)
    }
    // Carry the `ecosystem` tag across so the derived lockfile records what the bundle did.
    modules.set(dir, ecosystem === undefined
      ? { name, version, files: hashed }
      : { name, version, ecosystem, files: hashed })
  }
  // Carry the bundle's resolution + format maps across so the derived lockfile attests them too
  // (Bundle.parse already validated the paths) -- without them it would be a legacy bytes-only
  // lockfile, and a later frozen run would skip the resolution/format cross-checks.
  return new Lockfile({
    config: bundle.config,
    entries: bundle.entries,
    modules,
    imports: bundle.imports,
    formats: bundle.formats,
  })
}

// Extract a brotli-compressed stasis code bundle (`stasis.code.br`) back onto disk: write every
// bundled source to `output` (default: cwd) at its project-relative path, and drop a matching
// `stasis.lock.json` alongside. The lockfile is derived from the bundle's contents, so the
// extracted tree validates against it out of the box (e.g. `stasis prune`). Legacy v0 bundles
// extract sources only -- see the in-body comment.
//
// Returns `{ dir, files }` where `files` is the number of sources written (lockfile excluded).
export function extractCommand({ cwd = process.cwd(), bundleFile, output } = {}) {
  if (!bundleFile) throw new Error('extract: a bundle file is required')
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  let bundle
  try {
    bundle = Bundle.parse(brotliDecompressSync(readFileSync(bundleAbs)).toString('utf-8'))
  } catch (cause) {
    // Bundle.parse rejects malformed shapes (e.g. a lockfile JSON fed by mistake, or a non-stasis
    // brotli blob) with message-less asserts; wrap so the user sees which file failed.
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }

  // v0 legacy bundles record no package name/version (Bundle.parse infers null-metadata buckets),
  // so no lockfile can be restored: Lockfile.serialize requires both for every node_modules
  // bucket, and a null-metadata workspace entry would fail State.addFile's name/version check.
  // Sources are still recoverable -- extract them and skip the lockfile, with a warning.
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)

  // Plan first, write later: validate every target path stays inside outDir before touching disk,
  // so a malformed bundle can't write a partial tree. Walk bundle.modules directly, not the
  // flattening `sources` getter (which silently last-wins when two buckets collapse to one path).
  // Treat the bundle as untrusted and verify containment two ways: the resolved path must be
  // non-escaping relative to outDir (no leading '..', not absolute -- `relative` returns an
  // absolute path across Windows drives) AND lexically under `outDir/` (the trailing separator
  // rejects siblings that merely share outDir as a name prefix, e.g. `<outDir>-evil`). Checks are
  // lexical only: pre-existing symlinks inside outDir are followed by the writes, so untrusted
  // bundles belong in a fresh directory (see doc/extract.md).
  const writes = []
  const targets = new Set()
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // A `directory` capture (`stasis run --fs`) keys a listing at the directory's OWN path; it
      // isn't a file to write (its children recreate the directory) and would collide with them
      // at the file-vs-directory guard below. Skip it on disk -- the derived lockfile still
      // attests its hash (lockfileFromBundle hashes every entry, directory listings included).
      // The format is looked up under the canonical key (moduleFileKey, so a package-ROOT
      // listing's rel==='' maps to the dir, not `${dir}/`); the write path keeps the literal
      // join, so a NON-directory empty file name still trips the non-canonical-path guard.
      if (bundle.formats.get(moduleFileKey(dir, rel)) === 'directory') continue
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      if (relToOut.startsWith('..') || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // Only canonical paths are accepted: one that changes under the resolve+relative round-trip
      // (mid-path '..' or '.', empty segments, empty file name) is nothing State or the Solidity
      // bundler emits, and writing it would desync the on-disk tree from the lockfile's paths.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      if (withLockfile && abs === lockAbs) {
        throw new Error(`extract: bundle contains ${FILE_LOCK}, which would collide with the derived lockfile`)
      }
      targets.add(abs)
      // Resources are decoded back to original bytes: 'resource:base64' from base64 (rejected if
      // non-canonical), 'resource' and code written as the raw UTF-8 string.
      const data = bundle.formats.get(file) === 'resource:base64'
        ? assertCanonicalBase64(content, file)
        : content
      writes.push([abs, data])
    }
  }
  // A planned file may not also be a parent directory of another -- the mkdirSync/writeFileSync
  // pair below would otherwise throw halfway through the writes.
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
