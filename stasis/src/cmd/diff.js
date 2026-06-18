import { resolve } from 'node:path'

import { sha512integrity } from '@exodus/stasis-core/state-util'
import { parseFileWithKind } from '../parse.js'
import { diffArtifacts, formatDiffStat, hasDifferences } from '../diff.js'

// Run the `stasis diff` CLI command end-to-end: read the two given
// lockfiles/bundles from disk (this is the layer that pulls in brotli, via
// `parseFileWithKind`), diff them through the file-free `@exodus/stasis/diff`
// API, and print the requested view. `left` is the baseline ("from"), `right`
// the comparison ("to"). Today only the `--stat` summary is implemented, so
// `stat` is required; the report goes to `out` (stdout by default). With
// `imports: true` (the `--imports` flag) the report also diffs the resolution
// graphs — which import edges were added, removed, or redirected.
//
// This layer owns the canonical hash: the file-free diff API doesn't pull in
// `node:crypto`, so we inject `sha512integrity` (the same digest `stasis run`
// records) for it to re-hash bundle bytes with.
//
// Either side may be a lockfile or a bundle, in any combination: a bundle's
// recorded bytes are re-hashed into the SRI digests a lockfile records, so a
// lockfile and a bundle compare in the same digest space (see src/diff.js).
//
// Returns `{ diff, differences }` so the caller can set the process exit code
// (non-zero when the artifacts differ, like `diff(1)`).
export function diffCommand({ cwd = process.cwd(), left, right, stat, imports = false, out = process.stdout } = {}) {
  if (!left || !right) throw new Error('diff: two files (lockfile or bundle) are required')
  if (!stat) throw new Error('diff: only --stat is implemented; pass stat: true')

  const a = parseFileWithKind(resolve(cwd, left))
  const b = parseFileWithKind(resolve(cwd, right))
  const diff = diffArtifacts(a, b, { imports, hash: sha512integrity })

  out.write(formatDiffStat(diff, { left, right, leftKind: a.kind, rightKind: b.kind }))
  return { diff, differences: hasDifferences(diff) }
}
