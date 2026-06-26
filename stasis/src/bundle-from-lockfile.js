import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Bundle } from '@exodus/stasis-core/bundle'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { moduleFileKey } from '@exodus/stasis-core/util'

// Reconstruct an in-memory Bundle from a lockfile by reading every file it attests
// from disk and verifying each against the lockfile's SRI digest -- the exact inverse
// of `extract`'s lockfileFromBundle. A changed or tampered file fails closed here (the
// digest won't match), so building from a lockfile is as trustworthy as a
// `stasis run --lock=frozen` replay: the build only ever sees bytes the lockfile
// vouches for. `root` is the project root the lockfile's paths are relative to.
//
// Directory captures (`stasis run --fs` readdir listings, format 'directory') are
// skipped: they key a listing at a directory's own path, not a file esbuild could load.
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
      // The lockfile digests raw on-disk bytes; verify against them before trusting
      // the file. (Code and 'resource' files hash identically whether viewed as a
      // string or bytes, since Node hashes a string as its UTF-8 bytes.)
      const actual = sha512integrity(bytes)
      if (actual !== integrity) {
        throw new Error(`stasis: ${file} does not match the lockfile (expected ${integrity}, got ${actual})`)
      }
      // Store content the way a Bundle does: 'resource:base64' as base64 text,
      // everything else (code, 'resource') as a raw UTF-8 string. A non-base64 entry is
      // digested AND served as UTF-8 text, so a non-UTF-8 byte would transcode lossily
      // (U+FFFD), diverging the served content from the verified bytes -- mirror the
      // capture side's isUtf8 guard and fail closed instead.
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
