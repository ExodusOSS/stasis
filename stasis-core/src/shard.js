// Wire format for child->root capture forwarding (--child-process). A shard carries only keys, formats and
// resolution edges; content, listings, stat kinds and exec bits are re-derived from the root's OWN disk, so
// a shard cannot inject content or a forged bit. `files` and `formats` are independent -- don't collapse them.

import { KNOWN_FORMATS, assert, fileMapToObject, isPlainObject, objectToMaps, posixPathEscapes } from './util.js'

export const SHARD_VERSION = 1

// `imports` nests (conditions -> parent -> specifier -> file, or -> platform -> file under --metro),
// so the conversion recurses rather than flattening one level.
export function serializeShard({ scope, files, formats, imports }) {
  return JSON.stringify({
    version: SHARD_VERSION,
    scope,
    files,
    formats: fileMapToObject(formats, { sorted: false }),
    imports: fileMapToObject(imports, { sorted: false }),
  })
}

// The upstream signature is what makes a shard trustworthy; this only guards a malformed message,
// applying the same schema rules Lockfile.parse will. Maps keep lookups off Object.prototype.
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
