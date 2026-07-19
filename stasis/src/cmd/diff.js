import { resolve } from 'node:path'

import { sha512integrity } from '@exodus/stasis-core/state-util'
import { parseFileWithKind } from '../parse.js'
import { diffArtifacts, formatDiffStat, hasDifferences } from '../diff.js'

// Run `stasis diff`: read both lockfiles/bundles from disk and diff them through
// the file-free diff API. Returns { diff, differences } for the caller's exit code.
export function diffCommand({ cwd = process.cwd(), left, right, stat, imports = false, out = process.stdout } = {}) {
  if (!left || !right) throw new Error('diff: two files (lockfile or bundle) are required')
  if (!stat) throw new Error('diff: only --stat is implemented; pass stat: true')

  const a = parseFileWithKind(resolve(cwd, left))
  const b = parseFileWithKind(resolve(cwd, right))
  const diff = diffArtifacts(a, b, { imports, hash: sha512integrity })

  out.write(formatDiffStat(diff, { left, right, leftKind: a.kind, rightKind: b.kind }))
  return { diff, differences: hasDifferences(diff) }
}
