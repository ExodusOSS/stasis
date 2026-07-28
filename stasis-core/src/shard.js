// The wire format for child->root capture forwarding (--child-process). A shard is NOT a lockfile:
// it is a machine-only message between two processes of ONE build, signed by the root's own key,
// written to a temp dir, merged once and discarded. It was a serialized Lockfile, which made every
// flush pay for things the merge never looks at.
//
// What State#mergeShard actually reads from a shard: the scope, the project-relative KEYS the child
// recorded, their formats, and the resolution edges. Everything else a lockfile carries is re-derived
// from the root's OWN disk -- bytes are re-read and re-hashed, listings re-listed, stat kinds
// re-stat'd, exec bits re-inspected -- precisely so a shard cannot inject content or a forged bit.
// So the sha512 integrity per file (~100 chars each), the per-bucket name/version, the
// node_modules/sources split and the executable set were all serialized, signed, written, re-read and
// parsed for nothing. Dropping them shrinks a Metro worker's shard by more than half and turns the
// snapshot from a walk of the whole absorbed baseline into a walk of what this process observed.
//
// Ordering is not part of the format either: the merge is order-independent (a weak 'stat:*' yields
// to a real format whichever arrives first, and content always wins), so the deterministic path
// sorting a committed lockfile needs -- sortPaths splits BOTH operands on every comparison -- is
// pure cost here. No pretty-printing for the same reason: the indent roughly doubles the bytes to
// build, sign, write, re-read and parse.
//
// VERSION is asserted on parse: shards only ever travel between processes of one build, but those
// processes can host different stasis-core copies, so a mismatch must be refused (the merge skips a
// shard it cannot parse) rather than misread.

import assert from 'node:assert/strict'

export const SHARD_VERSION = 1

// Serialize one child's capture. `files` are the keys whose CONTENT (or directory listing) the child
// recorded; a stat-only observation appears in `formats` alone, with a 'stat:*' value and no `files`
// entry -- the same split mergeShard's two replay passes expect.
export function serializeShard({ scope, files, formats, imports }) {
  return JSON.stringify({ shard: SHARD_VERSION, scope, files, formats, imports })
}

// Parse + shape-check a shard. Structure only: every KEY is range-checked and real-path contained by
// mergeShard, and every value it acts on is re-derived from disk, so this guards against a malformed
// message (a wrong-version copy, a truncated write), not against a hostile one -- the signature does
// that upstream. Returns plain objects; the caller iterates them.
export function parseShard(text) {
  const json = JSON.parse(text)
  assert.ok(json !== null && typeof json === 'object' && !Array.isArray(json), 'shard must be an object')
  assert.equal(json.shard, SHARD_VERSION, `shard version ${json.shard} != ${SHARD_VERSION}`)
  assert.equal(typeof json.scope, 'string', 'shard scope must be a string')
  assert.ok(Array.isArray(json.files) && json.files.every((f) => typeof f === 'string'),
    'shard files must be an array of strings')
  assert.ok(isStringMap(json.formats), 'shard formats must map file -> format string')
  assert.ok(isNestedStringMap(json.imports), 'shard imports must map conditions -> parent -> specifier -> file')
  return json
}

const isPlainRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const isStringMap = (x) => isPlainRecord(x) && Object.values(x).every((v) => typeof v === 'string')
const isNestedStringMap = (x) =>
  isPlainRecord(x) && Object.values(x).every((byParent) =>
    isPlainRecord(byParent) && Object.values(byParent).every((specs) => isStringMap(specs)))
