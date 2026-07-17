import * as fs from 'node:fs'
import { basename, isAbsolute, join, posix, relative } from 'node:path'

// Snapshot realpathSync at module-eval, BEFORE `stasis run --fs` patches fs.realpathSync.
// The patch + syncBuiltinESMExports() repoint a LIVE `import { realpathSync }` binding to the
// bundle-serving wrapper, which (by design, for user code) does NOT throw ENOENT for a
// recorded-but-absent path -- which would silently defeat assertRealPathWithinBase's reliance
// on that throw (see its comment). Stasis's own reads must stay on the genuine builtin, so we
// snapshot here exactly like state.js / state-util.js / fs.js do for the other patched readers.
const { realpathSync } = fs

const sep = '/'

// The full, finite universe of `format` strings stasis knows. Lockfile and bundle
// parsers reject any value outside this set so a tampered or forward-incompatible
// artifact fails closed at the schema boundary, not at a later string compare.
// Categories:
//   Executable by Node's loader — module, commonjs, json, *-typescript
//   Source languages (analysis-only, not runnable by Node) — solidity, php, bash, rust
//   Resources (asset payloads) — resource (raw UTF-8), resource:base64 (binary)
//   Filesystem captures (`stasis run --fs`) — directory (a JSON-serialized,
//     sorted `fs.readdirSync` listing; a resource-like raw-UTF-8 payload)
// Adding a new format is a deliberate schema change: list it here AND extend
// hooks.js's executable allowlist if Node should serve it from a bundle.
export const KNOWN_FORMATS = new Set([
  'module',
  'commonjs',
  'json',
  'module-typescript',
  'commonjs-typescript',
  'solidity',
  'php',
  'bash',
  'rust',
  'resource',
  'resource:base64',
  'directory',
])

// File extensions whose bytes are JS-shaped code -- Node's loader and the
// lockfile/bundle format machinery can attest them (module/commonjs/json/
// *-typescript) and `bundle=load` can round-trip them as modules. This is the
// SINGLE source of truth for "is this a code file", shared so the two capture
// paths can't disagree: bundler plugins classify module-graph imports against it
// (classifyExtension), parseResourcesOption refuses to admit any of these into a
// `resources` allowlist (a code file is never an asset payload), and State both
// classifies `--fs` reads and guards `resource:true` against it. Dot-less +
// lowercase, matching pathExt. Drift here was the root of a lockfile/bundle
// desync: `.jsx`/`.tsx` were code to the plugins but missing from the fs-capture's
// own set, so an fs-read tagged a `.jsx` 'resource' while the import tagged it code.
export const CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'mts', 'cts'])

// Lowercased, dot-less extension of a path, or '' if none.
export function pathExt(filePath) {
  const m = /\.([^./\\]+)$/.exec(filePath)
  return m ? m[1].toLowerCase() : ''
}

// Validates + normalizes a `resources` allowlist (plugin option, --resources flag,
// EXODUS_STASIS_RESOURCES, or stasis.config.json) into a Set of lowercase entries. Each
// entry is either a bare extension (`png`, `.png`) or an extensionless filename
// (`LICENSE`, `Makefile`, `license-mit`); classifyExtension matches a file by its
// extension, falling back to its basename when it has none. A dotted entry like
// `data.bin` is rejected -- a file that HAS an extension is keyed by it, so the entry
// would never match; declare the extension (`bin`) instead. Code extensions are rejected
// too (always tracked). Throwing here surfaces misconfigurations immediately rather than
// as silent capture drift. `resources` may be an array (option / config) or undefined.
export function parseResourcesOption(label, resources) {
  if (resources === undefined) return new Set()
  if (!Array.isArray(resources)) {
    throw new TypeError(`${label}: resources must be an array of extension/filename strings`)
  }
  const out = new Set()
  for (const entry of resources) {
    if (typeof entry !== 'string') {
      throw new TypeError(`${label}: resources entry must be a string, got ${typeof entry}`)
    }
    const clean = entry.toLowerCase().replace(/^\./, '')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is not a valid extension or filename (use e.g. 'png' or 'LICENSE')`)
    }
    if (CODE_EXTENSIONS.has(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is a code extension; remove it (code extensions are always tracked)`)
    }
    out.add(clean)
  }
  return out
}

export const isBrotliQuality = (n) => Number.isInteger(n) && n >= 0 && n <= 11

// Parse an EXODUS_STASIS_BROTLI_QUALITY / --brotli-quality string into a brotli quality
// (integer 0..11). `${n}` must round-trip back to the input, so Number()-coercible
// non-canonical forms ('5.0', '05', ' 5 ', whitespace -> 0) throw instead of silently
// selecting an unintended quality. The single parser for the env var and both CLIs.
export function parseBrotliQuality(name, value) {
  const n = Number(value)
  if (`${n}` !== value || !isBrotliQuality(n)) {
    throw new RangeError(`${name} must be an integer 0..11 (got '${value}')`)
  }
  return n
}

// Classifies a file against the code set + a parsed resources allowlist. Returns 'code'
// (track with its loader format), 'resource' (track with a 'resource'/'resource:base64'
// format -- the encoding is chosen from content), or 'unknown' (caller must reject). A
// file is keyed by its extension, or -- when it has none (LICENSE, Makefile, a dotless
// name) -- by its basename, so a resources entry can be an extension or an extensionless
// filename. The 'unknown' path forces every non-JS asset to be declared explicitly -- no
// silent attestation widening. The SINGLE classifier for both capture paths: bundler
// plugins run it on module-graph imports, State runs it on `--fs` reads, so the two
// can't drift.
export function classifyExtension(filePath, resources) {
  const ext = pathExt(filePath)
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (resources.has(ext || basename(filePath).toLowerCase())) return 'resource'
  return 'unknown'
}

// Set-equality for parsed resources allowlists (lowercase extension/filename sets).
// Coordinates a plugin's `resources` option against an active preload's, and the env
// var against an explicit option in Config.
export function extSetsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const ext of a) if (!b.has(ext)) return false
  return true
}

// Flat project-relative key for the file `rel` inside module dir `dir`, inverse of
// the bucketing State/Bundle apply. The `rel === ''` branch is reached only by a
// `directory` capture whose path IS a module root (e.g. `fs.readdirSync` of a
// package dir, or of the project root): the listing is keyed at the bucket itself,
// so the flat key is the dir — never `${dir}/`, which a trailing-slash join would
// wrongly produce and break the round-trip. The workspace root keys at '.' (the
// '.' bucket's own dir), NOT '': join('.', '') === '.' is what lockfile re-absorb
// derives, so a '' key would be written but never found again on load. For every
// ordinary file `rel` is a real basename, so this matches the historical
// `dir === '.' ? rel : `${dir}/${rel}`` exactly.
export function moduleFileKey(dir, rel) {
  if (rel === '') return dir
  return dir === '.' ? rel : `${dir}/${rel}`
}

// Resolve `baseDir/relPath` through symlinks and confirm the real target stays
// within `realBase` (the caller-resolved real path of baseDir). Throws on a
// symlink that escapes the bundle root: a crafted in-tree symlink
// (`link.sh -> /etc/passwd`, or a symlinked directory) must not pull an
// external file into a self-contained, attestable bundle. The textual path
// guards elsewhere don't catch this because they never resolve symlinks.
// realpathSync surfaces ENOENT for a missing path, which the loaders' disk
// walks already handle as "missing".
export function assertRealPathWithinBase(realBase, baseDir, relPath) {
  const real = realpathSync(join(baseDir, relPath))
  const rel = relative(realBase, real).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to follow symlink escaping bundle root: ${relPath} -> ${real}`)
  }
}

export function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

export function sortPaths(a, b) {
  const [al, bl] = [a.split(sep), b.split(sep)]
  while (al.length > 0 && al[0] === bl[0]) {
    al.shift()
    bl.shift()
  }
  if (al.length === 0 && bl.length === 0) return 0

  // First process each file in dir, then subdirs
  if (al.length < 2) return bl.length < 2 && al > bl ? 1 : -1
  if (bl.length < 2) return 1

  // * comes first
  if (al[0] === '*') return -1
  if (bl[0] === '*') return 1

  // node_modules comes last
  if (al[0] === 'node_modules') return 1
  if (bl[0] === 'node_modules') return -1

  // Prefer example/ over example-something/
  const [an, bn] = [al, bl].map((list) => list.join(String.fromCodePoint(0)))
  if (an < bn) return -1
  if (an > bn) return 1
  throw new Error('Unreachable')
}

export const isPlainObject = (x) => x && [null, Object.prototype].includes(Object.getPrototypeOf(x))

export const fromEntries = (entries) => Object.setPrototypeOf(Object.fromEntries(entries), null)

export const fileSetToObject = (set) => [...set].toSorted((a, b) => sortPaths(a, b))

export const fileMapToObject = (map) => fromEntries(
  [...map]
    .toSorted((a, b) => sortPaths(a[0], b[0]))
    .map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v) : v])
)

export const objectToMaps = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)

// True when a POSIX, project-relative path escapes the root once normalized:
// a leading `..`, an absolute path, or a mid-path `..` that pops above the
// root (`a/../../x`). Plain `startsWith('..')` only catches the leading case,
// so it's not enough for paths that later get resolved against the root.
export function posixPathEscapes(path) {
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)
}

export function splitNodeModulesPath(path) {
  const marker = 'node_modules/'
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  const after = idx + marker.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const name = parts.slice(0, pkgLen).join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}
