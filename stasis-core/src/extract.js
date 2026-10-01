import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js'
import { EXECUTE_BITS, canObserveExecuteBits, moduleFileKey } from './util.js'

const FILE_LOCK = 'stasis.lock.json'

// Buffer.from silently drops invalid chars, so a tampered `resource:base64` could hash-spoof; require a fixed point.
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
      // Hash the raw on-disk bytes, so decode 'resource:base64' back first.
      const file = moduleFileKey(dir, rel)
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
    // Same file set as the bundle, so its executable list transfers as-is.
    executable: bundle.executable,
  })
}

export function extractCommand({ cwd = process.cwd(), bundleFile, output, logLabel = 'stasis-core' } = {}) {
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

  // v0 bundles have null metadata, so no lockfile can be derived (serialize requires name+version).
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)

  // Plan-first: every target is validated inside outDir before any write; walk modules, not the last-wins
  // `sources` getter. Containment is lexical -- symlinks are followed, so untrusted bundles need a fresh dir (doc/extract.md).
  const writes = []
  const targets = new Set()
  let executables = 0
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // `key` is the per-file map key (moduleFileKey handles rel === ''); `file` below is the WRITE path and keeps
      // the plain join, so a non-`directory` rel === '' fails the canonical-path check instead of writing at the bucket root.
      const key = moduleFileKey(dir, rel)
      // Skip a `directory` capture: it's a listing at the dir's own path, not a file to write (its children recreate the dir).
      if (bundle.formats.get(key) === 'directory') continue
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      // The `..` test is `../`-aware, NOT a bare startsWith('..') -- that would reject a legit `..foo` filename.
      if (relToOut === '..' || relToOut.startsWith(`..${sep}`) || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // A non-canonical path changes under the resolve+relative round-trip; writing it desyncs tree from lockfile.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      if (withLockfile && abs === lockAbs) {
        throw new Error(`extract: bundle contains ${FILE_LOCK}, which would collide with the derived lockfile`)
      }
      targets.add(abs)
      // Executability rides the plan tuple, so the chmod can only ever reach a file we actually wrote.
      const exec = bundle.executable.has(key)
      if (exec) executables += 1
      const data = bundle.formats.get(key) === 'resource:base64'
        ? assertCanonicalBase64(content, file)
        : content
      writes.push([abs, data, exec])
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

  // Only the execute bit is attested, so only it is touched -- rw bits stay as written (never widen a 0600 target)
  // and setuid/setgid/sticky are cleared. Applied to every written file; skipped for v0, which attests no modes.
  const withModes = withLockfile && canObserveExecuteBits()
  let chmodFailures = 0
  const applyMode = (abs, exec) => {
    let stats
    try {
      stats = lstatSync(abs)
    } catch {
      chmodFailures += 1
      return
    }
    // Never chmod through a symlink: +x on a link's target could make an arbitrary file outside outDir runnable.
    if (stats.isSymbolicLink()) return
    const perms = stats.mode & 0o7777
    const rwx = perms & 0o777
    // Execute wherever readable, with owner-execute as a floor so an aggressive umask can't defeat it.
    const want = exec ? rwx | ((rwx & 0o444) >> 2) | 0o100 : rwx & ~EXECUTE_BITS
    if (want === perms) return
    // Tolerated per file: a mode-less filesystem (vfat/exFAT/CIFS) accepts the write and rejects the chmod.
    try {
      chmodSync(abs, want)
    } catch {
      chmodFailures += 1
    }
  }

  for (const [abs, content, exec] of writes) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    if (withModes) applyMode(abs, exec)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it
  if (withLockfile) writeFileSync(lockAbs, lockText)

  const execNote = executables > 0 ? ` (${executables} executable)` : ''
  console.warn(`[${logLabel}] Extracted ${writes.length} file(s)${execNote}${withLockfile ? ` and ${FILE_LOCK}` : ''} to ${outDir}`)
  if (chmodFailures > 0) {
    console.warn(`[${logLabel}] Warning: could not set file modes on ${chmodFailures} file(s) (the filesystem may not support them); contents were written`)
  }
  if (!withLockfile) {
    console.warn(`[${logLabel}] Warning: legacy v0 bundle records no package name/version, so ${FILE_LOCK} can not be restored and was not written`)
  }
  return { dir: outDir, files: writes.length, executable: executables }
}
