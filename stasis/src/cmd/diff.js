import { resolve } from 'node:path'

import { parseFileWithKind } from '../parse.js'
import { diffArtifacts, formatDiffStat, hasDifferences } from '../diff.js'

// Run the `stasis diff` CLI command end-to-end: read the two given
// lockfiles/bundles from disk (this is the layer that pulls in brotli, via
// `parseFileWithKind`), diff them through the file-free `@exodus/stasis/diff`
// API, and print the requested view. `left` is the baseline ("from"), `right`
// the comparison ("to"). Today only the `--stat` summary is implemented, so
// `stat` is required; the report goes to `out` (stdout by default).
//
// Either side may be a lockfile or a bundle, in any combination: a bundle's
// recorded bytes are re-hashed into the SRI digests a lockfile records, so a
// lockfile and a bundle compare in the same digest space (see src/diff.js).
//
// Returns `{ diff, differences }` so the caller can set the process exit code
// (non-zero when the artifacts differ, like `diff(1)`).
export function diffCommand({ cwd = process.cwd(), left, right, stat, out = process.stdout } = {}) {
  if (!left || !right) throw new Error('diff: two files (lockfile or bundle) are required')
  if (!stat) throw new Error('diff: only --stat is implemented; pass stat: true')

  const a = parseFileWithKind(resolve(cwd, left))
  const b = parseFileWithKind(resolve(cwd, right))
  const diff = diffArtifacts(a, b)

  out.write(formatDiffStat(diff, { left, right, leftKind: a.kind, rightKind: b.kind }))
  return { diff, differences: hasDifferences(diff) }
}
