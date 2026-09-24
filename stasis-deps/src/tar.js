import { gunzipSync } from 'node:zlib'

import { unpack } from '@preventive/archive/tar.js'

// In-memory reader for npm package tarballs (gzipped ustar/pax/GNU tar), on @preventive/archive's
// strict tar reader. Returns the package's files keyed by their path relative to the package root
// -- the leading `package/` (or whatever single top-level directory the publisher used; npm and
// pnpm both strip exactly one component) removed -- each with its bytes and mode. Nothing touches
// the disk: the files go into the virtual node_modules. Only regular files are kept, which is what
// npm (pacote) and pnpm keep when they unpack a package: directories are implied by their files,
// and symlinks, hard links, devices and fifos are dropped. What no honest packer writes -- a name
// that is absolute, climbs out (`..`) or repeats as a different entry, a symlink whose target
// leaves the archive, a truncated or unterminated archive, a sparse file -- the reader refuses, so
// such a tarball fails the build instead of being trusted.
//
// @preventive/archive 1.0.0-beta.3 renamed the hard-link entry type from tar-stream's 'link' to
// 'hardlink' (and @preventive/vfs 1.0.0-beta.1 its Vfs#link to Vfs#hardlink): nothing here keeps a
// hard link, but a filter on entry types has to spell the new name.

const isGzip = (bytes) => bytes.length > 2 && bytes[0] === 0x1F && bytes[1] === 0x8B

// -> Map<relPath, { data: Uint8Array, mode: number }>. `data` views the unpacked archive; `label`
// names the tarball in errors.
export function readPackageTarball(bytes, { label = 'tarball' } = {}) {
  let entries
  try {
    entries = unpack(isGzip(bytes) ? gunzipSync(bytes) : bytes)
  } catch (cause) {
    throw new Error(`${label}: ${cause.message}`, { cause })
  }
  const files = new Map()
  for (const { name, type, data, mode } of entries) {
    if (type !== 'file' && type !== 'contiguous-file') continue
    // A name is cleaned (no `.`, `..` or empty segment, never absolute), so the first slash ends
    // the top-level directory. A file beside that directory is nothing npm would install.
    const slash = name.indexOf('/')
    if (slash === -1) continue
    files.set(name.slice(slash + 1), { data, mode })
  }
  return files
}
