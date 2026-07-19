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
//   Native build inputs (analysis-only, not runnable by Node; the Metro native capture
//     attests them for the CocoaPods/Gradle toolchain, so they carry a source tag rather
//     than being lumped into 'resource') — java, kotlin, gradle, objc, objcpp, c, cpp,
//     c-header, cpp-header, ruby, podspec, podfile, podfile-lock, template, xml
//   Resources (asset payloads) — resource (raw UTF-8), resource:base64 (binary)
//   Filesystem captures (`stasis run --fs`) — directory (a JSON-serialized,
//     sorted `fs.readdirSync` listing; a resource-like raw-UTF-8 payload), and the
//     payload-free stat records stat:file / stat:directory (an `fs.lstatSync`/
//     `fs.statSync` capture: attests only that the path existed with that KIND —
//     no bytes, no hash, no module-files entry — so isFile()/isDirectory() answer
//     from the bundle at load; see isStatFormat below)
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
  'java',
  'kotlin',
  'gradle',
  'objc',
  'objcpp',
  'c',
  'cpp',
  'c-header',
  'cpp-header',
  'ruby',
  'podspec',
  'podfile',
  'podfile-lock',
  'template',
  'xml',
  'resource',
  'resource:base64',
  'directory',
  'stat:file',
  'stat:directory',
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

// The payload-free stat-record formats (`stasis run --fs` lstatSync/statSync captures).
// A stat record attests a path's KIND (file vs directory) without any content, so it
// lives ONLY in the `formats` maps — never in a module's hashed `files`, never as a
// bundle payload. It is deliberately WEAK: real content recorded for the same path (a
// read, a readdir listing, an import) supersedes it — see State's addFile/addFsDir
// stale-record drop and #mergedFormats' upgrade rule.
export const isStatFormat = (format) => format === 'stat:file' || format === 'stat:directory'

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

// Compiled / installed / prebuilt native artifacts a package ships or generates on install
// (e.g. react-native-skia's prebuilt Skia `libs/` -- hundreds of MiB of .a/.xcframework). These
// are build OUTPUTS, not source, and typically non-deterministic across installs, so the native
// capture skips them entirely -- bundling neither their bytes nor an integrity (a frozen run
// would otherwise flake on regenerated blobs). Matched by suffix on a file OR directory name, so
// an Apple `*.framework`/`*.xcframework` bundle (a directory of a binary + headers) is skipped
// whole rather than descended into and captured header-by-header.
const NATIVE_ARTIFACT_EXTS = new Set([
  'a', 'so', 'o', 'obj', 'dylib', 'lib', 'dll', 'exe', 'pdb', // native objects / libraries
  'aar', 'jar', 'class', 'dex', // JVM / Android build output
  'node', // Node native addon
  'framework', 'xcframework', 'dsym', // Apple binary bundle directories
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', // opaque archives
])
export function isNativeArtifact(name) {
  return NATIVE_ARTIFACT_EXTS.has(pathExt(name))
}

// A CocoaPods podspec manifest. React Native ships these in scattered subdirs
// (third-party-podspecs/, Libraries/*/) that `react-native config` never enumerates, so the
// native capture discovers them by name rather than by a fixed location.
export function isPodspec(name) {
  return name.endsWith('.podspec') || name.endsWith('.podspec.json')
}

// Native (React Native) build-input files that are CODE, not asset resources: the
// authored/versioned source a native build compiles or reads (as opposed to the
// generated binaries and image/font assets a package ships). Unlike CODE_EXTENSIONS
// these aren't runnable by Node, so each carries a source-language format TAG (like
// solidity/php/bash/rust) rather than a Node loader format -- the Metro native capture
// records them as code under that tag instead of lumping them into 'resource'. Keyed by
// lowercase, dot-less extension (pathExt); every value here is also in KNOWN_FORMATS.
const NATIVE_CODE_FORMATS = new Map([
  ['java', 'java'], // Java source
  ['kt', 'kotlin'], // Kotlin source
  ['gradle', 'gradle'], // Gradle build script
  ['m', 'objc'], // Objective-C source
  ['mm', 'objcpp'], // Objective-C++ source
  ['c', 'c'], // C source
  ['cpp', 'cpp'], // C++ source
  ['c++', 'cpp'], // C++ source (alt spelling)
  ['h', 'c-header'], // C/C++/Objective-C header
  ['hpp', 'cpp-header'], // C++ header
  ['h++', 'cpp-header'], // C++ header (alt spelling)
  ['rb', 'ruby'], // Ruby (podspec helpers, CocoaPods scripts)
  ['podspec', 'podspec'], // CocoaPods spec
  ['template', 'template'], // build-input template
  ['xml', 'xml'], // e.g. AndroidManifest.xml
])

// Native build-input files recognized by exact (lowercased) BASENAME rather than extension:
// CocoaPods' Podfile (a Ruby DSL with no extension) and its Podfile.lock (whose `.lock`
// extension is too generic to key on -- yarn.lock/Gemfile.lock are unrelated resources).
const NATIVE_CODE_FILENAMES = new Map([
  ['podfile', 'podfile'],
  ['podfile.lock', 'podfile-lock'],
])

// The source-language format tag for a native build-input file, or undefined when it
// isn't one of the recognized native-code kinds (so the caller records it as a resource
// instead). Exact basename first (Podfile / Podfile.lock), then extension; a `.podspec.json`
// has extension `json` (a code extension handled by the normal loader path) and never
// resolves to a tag here.
export function nativeCodeFormat(name) {
  return NATIVE_CODE_FILENAMES.get(basename(name).toLowerCase()) ?? NATIVE_CODE_FORMATS.get(pathExt(name))
}

// Files `pod install` READS while LOADING podspecs, beyond the podspec itself: the Ruby helpers a
// podspec `require`s (react-native's hermes-engine.podspec -> hermes-utils.rb; the Podfile ->
// scripts/*.rb) and the package.json podspecs parse for the version. Captured alongside podspecs
// so every podspec can load from the artifact -- NOT the native source those podspecs later
// compile. `name` is a basename (package.json is matched exactly).
export function isNativeManifest(name) {
  return isPodspec(name) || pathExt(name) === 'rb' || name === 'package.json'
}

// React Native CORE subdirectories captured IN FULL (native source too, not just the podspec-load
// surface) with a metro bundle: build inputs the native build compiles from react-native itself
// that live outside the autolinked-dependency model and aren't reachable from the JS graph.
// A stasis-vetted fixed list (like the metro plugin's AUTO_INCLUDES), project-relative to the
// react-native package root; a dir that doesn't exist in a given react-native version is skipped.
//   - ReactCommon/yoga: the Yoga layout engine's C++ sources + cmake/CMakeLists.txt.
//   - sdks/hermes-engine: the hermes-engine podspec dir (podspec + its Ruby helpers + configs).
//   - scripts: the CocoaPods integration the Podfile drives (react_native_pods.rb, cocoapods/*,
//     the Xcode build-phase shell scripts).
export const RN_CORE_INCLUDE_DIRS = ['ReactCommon/yoga', 'sdks/hermes-engine', 'scripts']

// Individual react-native CORE files captured with a metro bundle (project-relative to the
// react-native package root; a missing one is skipped). Named rather than folded into an include
// DIR because their directory also holds huge prebuilt binaries we must NOT capture:
//   - sdks/.hermesversion: the Hermes revision hermes-utils.rb reads at podspec-load time. It
//     sits directly under sdks/, which also contains sdks/hermesc/* (prebuilt compiler binaries).
export const RN_CORE_INCLUDE_FILES = ['sdks/.hermesversion']

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

// --- Artifact merge helpers -------------------------------------------------
// Shared by Bundle.merge and Lockfile.merge (`stasis bundle --add`): both grow an
// artifact already on disk by unioning a freshly built one into it. Bundles and
// lockfiles carry the same module/import/format shapes -- a bundle stores each
// file's CONTENT where a lockfile stores its integrity HASH -- but the merge rule is
// identical: an overlapping entry must match exactly, and a genuine conflict throws
// rather than letting the newer artifact silently mask what the existing one
// attested. Keeping the union logic here stops the two `merge` methods from drifting.

// Value-equality for one import-edge target: a plain resolved-file string, or a
// { platform: file } Map (a `--metro` per-platform edge). Different kinds, or any
// differing platform->file pair, are unequal.
function importTargetsEqual(a, b) {
  const aMap = a instanceof Map
  if (aMap !== (b instanceof Map)) return false
  if (!aMap) return a === b
  if (a.size !== b.size) return false
  for (const [platform, file] of a) if (b.get(platform) !== file) return false
  return true
}

const fmtTarget = (t) => (t instanceof Map ? `{${[...t].map(([p, f]) => `${p}: ${f}`).join(', ')}}` : t)

// Merge two import maps (conditions -> parent -> specifier -> target) into a fresh
// Map. An edge present on both sides must resolve to the same target; a real redirect
// conflict throws. `label` tags the error for the calling artifact.
export function mergeImportMaps(a, b, label) {
  const out = new Map()
  const absorb = (imports) => {
    for (const [conditions, byParent] of imports) {
      let outByParent = out.get(conditions)
      if (outByParent === undefined) out.set(conditions, (outByParent = new Map()))
      for (const [parent, specs] of byParent) {
        let outSpecs = outByParent.get(parent)
        if (outSpecs === undefined) outByParent.set(parent, (outSpecs = new Map()))
        for (const [spec, target] of specs) {
          if (outSpecs.has(spec)) {
            assert(importTargetsEqual(outSpecs.get(spec), target),
              `${label}: import '${spec}' from '${parent}' resolves differently ('${fmtTarget(outSpecs.get(spec))}' vs '${fmtTarget(target)}')`)
          } else {
            outSpecs.set(spec, target instanceof Map ? new Map(target) : target)
          }
        }
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
}

// Merge two per-file format maps (file -> Node format string) into a fresh Map. A
// file present on both sides must carry the same format; a conflict throws.
export function mergeFormatMaps(a, b, label) {
  const out = new Map()
  const absorb = (formats) => {
    for (const [file, format] of formats) {
      const existing = out.get(file)
      if (existing !== undefined) {
        assert(existing === format, `${label}: format conflict for '${file}' ('${existing}' vs '${format}')`)
      } else {
        out.set(file, format)
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
}

// Merge two per-package module maps (dir -> { name, version, ecosystem?, files })
// into a fresh Map. Overlapping buckets must agree on name/version/ecosystem, and a
// file present in both must carry the identical value (source bytes for a bundle,
// integrity hash for a lockfile) -- a real divergence throws rather than letting the
// newer artifact silently mask what the existing one attested. `label` tags every
// message. Result `files` objects are null-prototype (like the parsers'), so a
// `__proto__` file name is a plain own key.
export function mergeModuleMaps(a, b, label) {
  const out = new Map()
  const absorb = (modules) => {
    for (const [dir, info] of modules) {
      const existing = out.get(dir)
      if (existing === undefined) {
        out.set(dir, {
          name: info.name,
          version: info.version,
          ...(info.ecosystem === undefined ? {} : { ecosystem: info.ecosystem }),
          files: Object.assign(Object.create(null), info.files),
        })
        continue
      }
      assert(existing.name === info.name,
        `${label}: module '${dir}' name mismatch ('${existing.name}' vs '${info.name}')`)
      assert(existing.version === info.version,
        `${label}: module '${dir}' version mismatch ('${existing.version}' vs '${info.version}')`)
      assert(existing.ecosystem === info.ecosystem,
        `${label}: module '${dir}' ecosystem mismatch ('${existing.ecosystem ?? '(none)'}' vs '${info.ecosystem ?? '(none)'}')`)
      for (const [rel, value] of Object.entries(info.files)) {
        if (Object.hasOwn(existing.files, rel)) {
          assert(existing.files[rel] === value, `${label}: content mismatch for '${moduleFileKey(dir, rel)}'`)
        } else {
          existing.files[rel] = value
        }
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
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
