import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Bundle } from '@exodus/stasis-core/bundle'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { moduleFileKey } from '@exodus/stasis-core/util'

// Reconstruct an in-memory Bundle from a lockfile, reading every attested file from disk and
// verifying each against the lockfile's SRI digest -- fail closed on mismatch, so this is as
// trustworthy as a `stasis run --lock=frozen` replay. `root` is what the lockfile's paths are
// relative to. Directory captures (format 'directory') are skipped -- not files esbuild can load.
export function bundleFromLockfile(lockfile, { root }) {
  if (!lockfile.imports) throw new Error('stasis: lockfile has no recorded import graph')
  const formats = lockfile.formats ?? new Map()
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, files }] of lockfile.modules) {
    const out = Object.create(null)
    for (const [rel, integrity] of Object.entries(files)) {
      const file = moduleFileKey(dir, rel)
      const format = formats.get(file)
      if (format === 'directory') continue
      const abs = resolve(root, file)
      let bytes
      try {
        bytes = readFileSync(abs)
      } catch (cause) {
        throw new Error(`stasis: file attested by the lockfile is missing on disk: ${file}`, { cause })
      }
      // The lockfile digests raw on-disk bytes; verify before trusting the file.
      const actual = sha512integrity(bytes)
      if (actual !== integrity) {
        throw new Error(`stasis: ${file} does not match the lockfile (expected ${integrity}, got ${actual})`)
      }
      // Store content as a Bundle does: 'resource:base64' as base64, everything else as a UTF-8 string.
      // A non-UTF-8 byte in a non-base64 entry would transcode lossily (U+FFFD), diverging served
      // content from the verified bytes -- mirror the capture side's isUtf8 guard and fail closed.
      if (format === 'resource:base64') {
        out[rel] = bytes.toString('base64')
      } else {
        if (!isUtf8(bytes)) throw new Error(`stasis: ${file} is recorded as '${format ?? 'code'}' but is not valid UTF-8`)
        out[rel] = bytes.toString('utf8')
      }
    }
    modules.set(dir, ecosystem === undefined
      ? { name, version, files: out }
      : { name, version, ecosystem, files: out })
  }
  return new Bundle({
    config: lockfile.config,
    entries: lockfile.entries,
    modules,
    imports: lockfile.imports,
    formats,
  })
}
