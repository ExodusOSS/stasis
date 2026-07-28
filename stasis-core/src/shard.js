// Wire format for child->root capture forwarding (--child-process). A shard is NOT a lockfile: it is
// a machine-only message between two processes of ONE build, signed with the root's key, merged once
// and discarded. So it carries only what State#mergeShard reads -- the scope, the project-relative
// KEYS the child recorded, their formats, and the resolution edges. Everything else a lockfile holds
// is re-derived from the root's OWN disk (bytes re-read and re-hashed, listings re-listed, stat kinds
// re-stat'd, exec bits re-inspected), precisely so a shard cannot inject content or a forged bit.
//
// Unordered and unindented for the same reason: the merge is order-independent, and nothing diffs a
// shard. VERSION is asserted on parse because the two ends can host different stasis-core copies -- a
// mismatch must be refused (the merge skips a shard it cannot parse), not misread.

import assert from 'node:assert/strict'

export const SHARD_VERSION = 1

// `files` are keys whose CONTENT (or directory listing) the child recorded. A stat-only observation
// has no content and rides `formats` alone as 'stat:*' -- the split mergeShard's two passes expect.
export function serializeShard({ scope, files, formats, imports }) {
  return JSON.stringify({ shard: SHARD_VERSION, scope, files, formats, imports })
}

// Structure only: the signature upstream is what makes a shard trustworthy, and mergeShard
// range-checks every key and re-derives every value it acts on. This guards against a malformed
// message (wrong-version copy, truncated write), not a hostile one.
export function parseShard(text) {
  const json = JSON.parse(text)
  assert.ok(isPlainRecord(json), 'shard must be an object')
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
