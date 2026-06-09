import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '../bundle.js'
import { Lockfile } from '../lockfile.js'
import { sha512integrity } from '../state.util.js'

const FILE_LOCK = 'stasis.lock.json'

// Re-derive a Lockfile from an already-parsed code Bundle. A bundle records the
// UTF-8 source bytes of every file; a lockfile records their SRI digests. Both
// share the same per-package bucket shape (name/version/files) plus the
// entries/config metadata, so the conversion is just "hash each file's bytes"
// while carrying everything else across verbatim.
//
// The digest is taken over the same UTF-8 bytes we write to disk, so it equals
// what `stasis run --lock=add` would record for the extracted tree and what
// `stasis prune` recomputes when validating it.
export function lockfileFromBundle(bundle) {
  const modules = new Map()
  for (const [dir, { name, version, files }] of bundle.modules) {
    const hashed = Object.create(null)
    for (const [rel, content] of Object.entries(files)) {
      hashed[rel] = sha512integrity(content)
    }
    modules.set(dir, { name, version, files: hashed })
  }
  return new Lockfile({ config: bundle.config, entries: bundle.entries, modules })
}

// Extract a brotli-compressed stasis code bundle (`stasis.code.br`) back onto
// disk: write every bundled source to `output` (default: cwd), preserving its
// project-relative path, and drop a matching `stasis.lock.json` alongside them.
// The lockfile is derived from the bundle's own contents, so the extracted tree
// validates against it out of the box (e.g. `stasis run --lock=frozen` or
// `stasis prune`).
//
// Returns `{ dir, files }` where `files` is the number of sources written
// (the lockfile is not counted).
export function extractCommand({ cwd = process.cwd(), bundleFile, output } = {}) {
  if (!bundleFile) throw new Error('extractCommand: a bundle file is required')
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  const bundle = Bundle.parseCode(brotliDecompressSync(readFileSync(bundleAbs)).toString('utf-8'))
  const outDir = resolve(cwd, output ?? '.')

  // Plan first, write later: resolve every target path and confirm it stays
  // inside outDir before touching disk, so a malformed bundle can't write a
  // partial tree. Bundle.parseCode already rejects paths that *start* with
  // '..', but a crafted bundle could still embed '..' mid-path; treat the
  // bundle as untrusted input and verify containment explicitly.
  const writes = []
  for (const [file, content] of bundle.sources) {
    const abs = resolve(outDir, file)
    if (abs !== outDir && !abs.startsWith(`${outDir}${sep}`)) {
      throw new Error(`extract: bundle path escapes output dir: ${file}`)
    }
    writes.push([abs, content])
  }
  const lockText = lockfileFromBundle(bundle).serialize()

  for (const [abs, content] of writes) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it
  writeFileSync(join(outDir, FILE_LOCK), lockText)

  console.warn(`[stasis] Extracted ${writes.length} file(s) and ${FILE_LOCK} to ${outDir}`)
  return { dir: outDir, files: writes.length }
}
