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
//
// `files` are keys whose CONTENT (or directory listing) the child recorded; a stat-only observation
// has no content and rides `formats` alone as 'stat:*'. The two are NOT derivable from each other: an
// fs-read .js carries a hash with no format, and an import edge can give a stat-only key a real
// format without any bytes -- collapsing them would promote that key to a byte re-read.

import { KNOWN_FORMATS, assert, fileMapToObject, isPlainObject, objectToMaps, posixPathEscapes } from './util.js'

export const SHARD_VERSION = 1

// Maps in, Maps out: State speaks Maps, so the object round-trip lives here rather than at both call
// sites. `imports` nests (conditions -> parent -> specifier -> file, or -> platform -> file under
// --metro), which is why the conversion recurses instead of flattening one level.
export function serializeShard({ scope, files, formats, imports }) {
  return JSON.stringify({
    version: SHARD_VERSION,
    scope,
    files,
    formats: fileMapToObject(formats, { sorted: false }),
    imports: fileMapToObject(imports, { sorted: false }),
  })
}

// Validate and convert in ONE pass, as Lockfile.parse and Bundle.parse do. The signature upstream is
// what makes a shard trustworthy; this guards against a malformed message (wrong-version copy,
// truncated write) and applies the two schema rules those parsers apply to the same fields, so a
// shard can never carry a format the next run's Lockfile.parse would refuse. Maps also keep the
// lookups off Object.prototype -- a key like 'constructor' is a legal path.
export function parseShard(text) {
  const json = JSON.parse(text)
  assert(isPlainObject(json), 'shard must be an object')
  assert(json.version === SHARD_VERSION, `shard version ${json.version} != ${SHARD_VERSION}`)
  assert(['node_modules', 'full'].includes(json.scope), `shard scope: ${json.scope}`)
  assert(Array.isArray(json.files), 'shard files must be an array')
  assert(isPlainObject(json.formats) && isPlainObject(json.imports), 'shard formats/imports must be objects')

  for (const file of json.files) assertKey(file, 'shard file')
  const formats = objectToMaps(json.formats)
  for (const [file, format] of formats) {
    assertKey(file, 'shard format')
    assert(KNOWN_FORMATS.has(format), `shard format for ${file}: ${format}`)
  }
  const imports = objectToMaps(json.imports)
  for (const [, byParent] of imports) {
    assert(byParent instanceof Map, 'shard imports: expected a parent map')
    for (const [parent, specs] of byParent) {
      assertKey(parent, 'shard import parent')
      assert(specs instanceof Map, `shard imports for ${parent}: expected a specifier map`)
      for (const [, target] of specs) assertTarget(target, parent)
    }
  }
  return { scope: json.scope, files: json.files, formats, imports }
}

function assertKey(key, what) {
  assert(typeof key === 'string' && key !== '' && !posixPathEscapes(key), `${what}: ${key}`)
}

// A target is a file, or (--metro) a platform -> file map; nothing deeper.
function assertTarget(target, parent) {
  if (target instanceof Map) {
    for (const [, file] of target) assertKey(file, `shard import target from ${parent}`)
    return
  }
  assertKey(target, `shard import target from ${parent}`)
}
