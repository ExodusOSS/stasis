import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      // moduleFileKey (not a bare `${dir}/${rel}`) so a `directory` capture's rel==='' keys the dir, matching the write loop's format lookup.
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
    // Same file set as the bundle (hashed, not swapped out), so its executable list transfers as-is
    // -- the extracted tree and the lockfile beside it agree on which files carry the bit.
    executable: bundle.executable,
  })
}

// Extract stasis.code.br onto disk (default cwd) + derive a matching stasis.lock.json. v0 bundles extract sources only.
// logLabel prefixes the status lines so each CLI self-identifies (stasis-core -> [stasis-core], stasis -> [stasis]), like addCommand.
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

  // v0 bundles have null metadata, so no lockfile can be derived (Lockfile.serialize requires name+version); extract sources only.
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)

  // Plan-first: validate every target is inside outDir before any write (no partial tree); walk modules, not the
  // last-wins `sources` getter. Containment is lexical -- symlinks in outDir are followed, so untrusted bundles need a fresh dir (see doc/extract.md).
  const writes = []
  const targets = new Set()
  let executables = 0
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // Key for the bundle's per-file maps. moduleFileKey handles a bucket-root capture (rel === ''),
      // which is also how every writer keys `executable`; `file` below is the WRITE path, which keeps
      // the plain join so a rel === '' entry that isn't a `directory` fails the canonical-path check
      // rather than materializing a file at the bucket root.
      const key = moduleFileKey(dir, rel)
      // Skip a `directory` capture: it's a listing at the dir's own path, not a file to write (its children recreate the dir).
      if (bundle.formats.get(key) === 'directory') continue
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      // Escapes: `..`-relative to outDir, or not lexically under `<outDir>/`. The `..` test is
      // `../`-aware (matching posixPathEscapes), NOT a bare startsWith('..') -- the latter also
      // rejects a legit first segment like `..foo` (a real filename resolve keeps safely inside outDir).
      if (relToOut === '..' || relToOut.startsWith(`..${sep}`) || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // Reject non-canonical paths (they change under the resolve+relative round-trip): writing them desyncs the tree from the lockfile.
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

  // Modes for the files we write, derived once from the process umask so a fresh create lands where
  // the caller expects (0644/0755 at the usual 022, 0600/0700 at 077). Deriving from each file's own
  // post-write mode instead would inherit whatever a PRE-EXISTING target carried -- writeFileSync
  // keeps an existing inode's mode -- which could neither clear an execute bit the bundle no longer
  // attests nor avoid arming a stale setuid bit. Masked to plain permission bits for the same reason.
  // An executable keeps at least owner-execute, so an aggressive umask can't quietly produce a file
  // the bundle says is runnable and isn't.
  const umask = process.umask()
  const PLAIN_MODE = 0o666 & ~umask & 0o777
  const EXEC_MODE = ((0o777 & ~umask) | 0o100) & 0o777

  // Applied to EVERY written file, not just the executable ones, so the extracted tree matches the
  // artifact: re-extracting over an older tree drops a bit the bundle stopped attesting.
  let chmodFailures = 0
  for (const [abs, content, exec] of writes) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    // Tolerated per file: a filesystem with no POSIX modes (vfat/exFAT/CIFS, a drvfs mount) accepts
    // the write and rejects the chmod, and losing the whole extraction -- including the lockfile
    // below -- over metadata it cannot store would be worse than the bytes landing with host modes.
    try {
      chmodSync(abs, exec ? EXEC_MODE : PLAIN_MODE)
    } catch {
      chmodFailures += 1
    }
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
