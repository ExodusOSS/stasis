import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { parseFile } from '../parse.js'
import { collectComponents, generateSbom } from '../sbom.js'

// Run the `stasis sbom` CLI command end-to-end: read the given lockfiles/bundles
// from disk (this is the layer that pulls in brotli, via `parseFile`), build an
// SBOM in the requested `format` (spdx | cyclonedx) through the file-free
// `@exodus/stasis/sbom` API, and write the pretty-printed JSON to `output` (a
// file, or stdout when `output` is `-` or unset). The one-line summary goes to
// stderr so it never corrupts a document streamed to stdout. `now`/`uuid` are
// injectable for deterministic output.
export function sbomCommand({ cwd = process.cwd(), files, format, output, now, uuid } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('sbom: at least one lockfile or bundle is required')
  }
  const artifacts = files.map((f) => parseFile(resolve(cwd, f)))
  const components = collectComponents(artifacts)
  const doc = generateSbom(format, components, { now, uuid })
  const text = JSON.stringify(doc, undefined, 2) + '\n'

  const target = output ?? '-'
  if (target === '-') {
    process.stdout.write(text)
  } else {
    const outAbs = resolve(cwd, target)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, text)
  }
  const dest = target === '-' ? '<stdout>' : target
  const n = components.length
  console.warn(`[stasis] Wrote ${format} SBOM with ${n} component${n === 1 ? '' : 's'} to ${dest}`)
  return { components, doc }
}
