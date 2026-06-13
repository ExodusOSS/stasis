import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state.util'

const FILE_LOCK = 'stasis.lock.json'

// Re-derive a Lockfile from an already-parsed code Bundle. A bundle records the
// UTF-8 source bytes of every file; a lockfile records their SRI digests. Both
// share the same per-package bucket shape (name/version/files) plus the
// entries/config metadata, so the conversion is just "hash each file's bytes"
// while carrying everything else across verbatim.
//
// Requires a v1 bundle: v0 records no package name/version (parseCode infers
// buckets with null metadata), and Lockfile.serialize must attest both for
// every node_modules bucket.
//
// The digest is taken over the same UTF-8 bytes we write to disk, so it equals
// what `stasis run --lock=add` would record for the extracted tree and what
// `stasis prune` recomputes when validating it.
export function lockfileFromBundle(bundle) {
  const modules = new Map()
  for (const [dir, { name, version, origin, files }] of bundle.modules) {
    const hashed = Object.create(null)
    for (const [rel, content] of Object.entries(files)) {
      hashed[rel] = sha512integrity(content)
    }
    // Carry the dependency `origin` across so the derived lockfile records the
    // same ecosystem tag the bundle did.
    modules.set(dir, origin === undefined
      ? { name, version, files: hashed }
      : { name, version, origin, files: hashed })
  }
  // Carry the bundle's resolution + format maps across so the derived lockfile
  // attests them too (parseCode already validated the paths) -- without them
  // the lockfile would be a legacy bytes-only one, and a later frozen run
  // against the same bundle would skip the resolution/format cross-checks.
  return new Lockfile({
    config: bundle.config,
    entries: bundle.entries,
    modules,
    imports: bundle.imports,
    formats: bundle.formats,
  })
}

// Extract a brotli-compressed stasis code bundle (`stasis.code.br`) back onto
// disk: write every bundled source to `output` (default: cwd), preserving its
// project-relative path, and drop a matching `stasis.lock.json` alongside them.
// The lockfile is derived from the bundle's own contents, so the extracted tree
// validates against it out of the box (e.g. `stasis prune`). For legacy v0
// bundles only the sources are extracted -- see the in-body comment.
//
// Returns `{ dir, files }` where `files` is the number of sources written
// (the lockfile is not counted).
export function extractCommand({ cwd = process.cwd(), bundleFile, output } = {}) {
  if (!bundleFile) throw new Error('extract: a bundle file is required')
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  let bundle
  try {
    bundle = Bundle.parseCode(brotliDecompressSync(readFileSync(bundleAbs)).toString('utf-8'))
  } catch (cause) {
    // Bundle.parseCode rejects non-code shapes (e.g. a stasis.resources.br fed
    // by mistake) with bare message-less asserts; wrap so the user sees which
    // file failed instead of an empty error.
    throw new Error(`extract: not a valid stasis code bundle: ${bundleAbs}`, { cause })
  }

  // v0 legacy bundles record no package name/version (parseCode infers buckets
  // with null metadata), so no lockfile can be restored from them:
  // Lockfile.serialize requires both for every node_modules bucket, and a
  // null-metadata workspace entry would be rejected later by State.addFile's
  // name/version cross-check. The sources themselves are still fully
  // recoverable -- extract them and skip the lockfile, with a warning.
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)

  // Plan first, write later: validate every target path and confirm it stays
  // inside outDir before touching disk, so a malformed bundle can't write a
  // partial tree. Walk bundle.modules directly rather than the flattening
  // `sources` getter, which silently last-wins when two buckets collapse to
  // the same path. Treat the bundle as untrusted input and verify containment
  // two ways: the resolved path must be BOTH non-escaping relative to outDir
  // (no leading '..', not absolute -- `relative` returns an absolute path
  // across Windows drives) AND lexically under `outDir/` (the trailing
  // separator rejects sibling dirs that merely share outDir as a name prefix,
  // e.g. `<outDir>-evil`). These checks are lexical only: pre-existing
  // symlinks inside outDir are followed by the writes, so untrusted bundles
  // belong in a fresh directory (see doc/extract.md).
  const writes = []
  const targets = new Set()
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      if (relToOut.startsWith('..') || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // Only canonical paths are accepted: a path that changes under the
      // resolve+relative round-trip (mid-path '..' or '.', empty segments, an
      // empty file name) is nothing State or the Solidity bundler ever emit,
      // and writing it would desync the on-disk tree from the lockfile's
      // recorded paths.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      if (withLockfile && abs === lockAbs) {
        throw new Error(`extract: bundle contains ${FILE_LOCK}, which would collide with the derived lockfile`)
      }
      targets.add(abs)
      writes.push([abs, content])
    }
  }
  // A planned file may not also be needed as a parent directory of another --
  // the mkdirSync/writeFileSync pair below would otherwise throw halfway
  // through the writes.
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
