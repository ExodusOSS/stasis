import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { basename, isAbsolute, join, posix, relative } from 'node:path'

// Snapshot realpathSync at module-eval, BEFORE `stasis run --fs` patches fs.realpathSync.
// The patch repoints a live `import { realpathSync }` binding to the bundle-serving wrapper,
// which by design does NOT throw ENOENT for a recorded-but-absent path -- silently defeating
// assertRealPathWithinBase's reliance on that throw. Stasis's own reads stay on the genuine
// builtin, like state.js / state-util.js / fs.js do for the other patched readers.
const { realpathSync } = fs

const sep = '/'

// --- Format vocabulary --------------------------------------------------------
// KNOWN_FORMATS is the finite universe of `format` strings; parsers reject anything outside it, so
// a tampered/forward-incompatible artifact fails closed. It's the union of the category sets below
// -- the single partition every consumer's policy derives from:
//   NODE_FORMATS             Node can execute/import; the runtime loader serves ONLY these.
//   SOURCE_LANGUAGE_FORMATS  analysis-only code, never run by Node (solidity/php/shell/rust).
//   NATIVE_BUILD_FORMATS     React Native build inputs (code, not Node-executable). pbxproj is here
//                            but reached only via `stasis add`/`--fs` -- the packager excludes the
//                            `.xcodeproj`/`.xcworkspace` bundles it lives in.
//   RESOURCE_FORMATS         asset payloads (resource = raw UTF-8, resource:base64 = binary).
//   STAT_FORMATS             payload-free `--fs` lstat/stat records (existence + KIND, no bytes).
//   'directory'              a sorted `fs.readdirSync` listing (`--fs`).
// Adding a format is a schema change: add it to the right category, + to NODE_FORMATS if Node
// should serve it from a bundle.
export const NODE_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])
export const SOURCE_LANGUAGE_FORMATS = new Set(['solidity', 'php', 'shell', 'rust'])
export const NATIVE_BUILD_FORMATS = new Set([
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header',
  'ruby', 'cmake', 'podspec', 'podfile', 'podfile-lock', 'template', 'xml', 'env', 'fastlane', 'pbxproj',
])
export const RESOURCE_FORMATS = new Set(['resource', 'resource:base64'])
export const STAT_FORMATS = new Set(['stat:file', 'stat:directory'])
export const KNOWN_FORMATS = new Set([
  ...NODE_FORMATS,
  ...SOURCE_LANGUAGE_FORMATS,
  ...NATIVE_BUILD_FORMATS,
  ...RESOURCE_FORMATS,
  'directory',
  ...STAT_FORMATS,
])

// JS-shaped code extensions (dot-less, lowercase), split by how the Node loader format is found:
// NODE_EXT_FORMATS fixes it by extension (mjs/cjs/json + TS variants); JS_UNRESOLVED_EXTS don't
// (.js/.ts depend on package.json `type`/syntax, .jsx/.tsx are bundler-transformed), so classifyFormat
// returns null for those four. CODE_EXTENSIONS (their union) is the one "is this JS-graph code" answer:
// classifyExtension counts these as code; parseResourcesOption / State's resource:true guard reject them.
const NODE_EXT_FORMATS = new Map([
  ['mjs', 'module'], ['cjs', 'commonjs'], ['json', 'json'],
  ['mts', 'module-typescript'], ['cts', 'commonjs-typescript'],
])
const JS_UNRESOLVED_EXTS = new Set(['js', 'ts', 'jsx', 'tsx'])
export const CODE_EXTENSIONS = new Set([...NODE_EXT_FORMATS.keys(), ...JS_UNRESOLVED_EXTS])

// The payload-free stat-record formats (`stasis run --fs` lstatSync/statSync captures). A stat
// record attests a path's KIND (file vs directory) with no content, so it lives ONLY in the
// `formats` maps -- never in a module's hashed `files` or as a bundle payload. Deliberately WEAK:
// real content recorded for the same path supersedes it -- see State's addFile/addFsDir stale-record
// drop and #mergedFormats' upgrade rule.
export const isStatFormat = (format) => STAT_FORMATS.has(format)

// Kind a format attests: 'directory' for a real readdir listing or a stat:directory record,
// 'file' for a stat:file record and every real *file* format. Gates reconcileFormat so a stat
// record only reconciles with a real format of the SAME kind.
const formatKind = (format) => (format === 'directory' || format === 'stat:directory' ? 'directory' : 'file')

// Reconcile a newly-seen `format` for a path against its `currentFormat`, returning the winner or
// throwing on conflict (`name` identifies the path). A weak 'stat:*' record yields to a real format
// of the SAME kind and never displaces one -- stat:file <-> a real file format, stat:directory <->
// a real 'directory' listing. Two real formats, a stat kind flip (stat:file vs stat:directory), or
// a stat vs a real format of the OTHER kind are conflicts. Shared by state.js (upsertFormat /
// #mergedFormats) and the artifact merges (mergeFormatMaps -> Bundle/Lockfile.merge).
export function reconcileFormat(format, currentFormat, name) {
  if (format === currentFormat) return format
  const stat = isStatFormat(format)
  const currentStat = isStatFormat(currentFormat)
  if (stat !== currentStat && formatKind(format) === formatKind(currentFormat)) {
    return stat ? currentFormat : format // the real format wins; the weak stat record yields
  }
  throw new Error(`format conflict for '${name}' ('${currentFormat}' vs '${format}')`)
}

// Lowercased, dot-less extension of a path, or '' if none.
export function pathExt(filePath) {
  const m = /\.([^./\\]+)$/.exec(filePath)
  return m ? m[1].toLowerCase() : ''
}

// Validates + normalizes a `resources` allowlist (option, --resources flag, env var, or config)
// into a Set of lowercase entries. Each entry is a bare extension (`png`, `.png`) or an
// extensionless filename (`LICENSE`, `Makefile`); classifyExtension matches by extension, falling
// back to basename when there's none. A dotted entry (`data.bin`) is rejected -- a file with an
// extension is keyed by it, so the entry would never match; declare the extension (`bin`) instead.
// Code extensions are rejected too (always tracked). Throwing surfaces misconfig immediately rather
// than as silent capture drift. `resources` may be an array or undefined.
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

// Parse an EXODUS_STASIS_BROTLI_QUALITY / --brotli-quality string into a brotli quality (0..11).
// `${n}` must round-trip to the input, so non-canonical Number()-coercible forms ('5.0', '05', ' 5 ')
// throw instead of silently selecting an unintended quality. The single parser for env var + CLIs.
export function parseBrotliQuality(name, value) {
  const n = Number(value)
  if (`${n}` !== value || !isBrotliQuality(n)) {
    throw new RangeError(`${name} must be an integer 0..11 (got '${value}')`)
  }
  return n
}

// The JS-graph bundlers' policy view over classifyFormat (webpack/esbuild/Metro). Returns 'code',
// 'resource' (allowlisted asset -- by extension, or basename when it has none), or 'unknown' (caller
// rejects). Only JS-family code counts as 'code'; a native/source format is resource-or-unknown like
// any other non-JS file. `stasis run --fs` classifies WIDER (State.addFsFile follows the full vocabulary).
export function classifyExtension(filePath, resources) {
  // null (js-family) + NODE_FORMATS (fixed mjs/cjs/json/*-ts) == exactly the JS-graph code set.
  const format = classifyFormat(filePath)
  if (format === null || NODE_FORMATS.has(format)) return 'code'
  if (resources.has(pathExt(filePath) || basename(filePath).toLowerCase())) return 'resource'
  return 'unknown'
}

// Compiled / prebuilt native artifacts a package ships or generates on install (e.g. react-native-skia's
// prebuilt Skia `libs/` -- hundreds of MiB of .a/.xcframework), plus non-source directory BUNDLES that
// aren't a CocoaPods/Gradle build input. These are build outputs / IDE metadata, typically
// non-deterministic across installs, so the native capture skips them entirely -- neither bytes nor
// integrity (a frozen run would otherwise flake on regenerated blobs). Matched by suffix on a file OR
// directory name, so an Apple `*.framework` bundle or a module's `*.xcodeproj`/`*.xcworkspace` (CocoaPods
// compiles the podspec's source_files, never the module's own Xcode project) is skipped whole.
const NATIVE_ARTIFACT_EXTS = new Set([
  'a', 'so', 'o', 'obj', 'dylib', 'lib', 'dll', 'exe', 'pdb', // native objects / libraries
  'aar', 'jar', 'class', 'dex', // JVM / Android build output
  'node', // Node native addon
  'framework', 'xcframework', 'dsym', // Apple binary bundle directories
  'xcodeproj', 'xcworkspace', // Xcode project/workspace bundle dirs -- IDE metadata, not build input
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', // opaque archives
])
export function isNativeArtifact(name) {
  return NATIVE_ARTIFACT_EXTS.has(pathExt(name))
}

// A CocoaPods podspec manifest. React Native ships these in scattered subdirs that `react-native
// config` never enumerates, so the native capture discovers them by name rather than by location.
export function isPodspec(name) {
  return name.endsWith('.podspec') || name.endsWith('.podspec.json')
}

// Non-JS code formats by lowercase, dot-less extension (pathExt): analysis-only source languages +
// React Native native build inputs. With NODE_EXT_FORMATS, the extension half of classifyFormat;
// every value is in KNOWN_FORMATS.
const CODE_EXT_FORMATS = new Map([
  // Source languages (also emitted by `stasis bundle`'s dedicated per-language bundlers).
  ['sol', 'solidity'], // Solidity
  ['php', 'php'], // PHP
  ['sh', 'shell'], ['bash', 'shell'], // shell scripts
  ['rs', 'rust'], // Rust
  // React Native native build inputs: read by CocoaPods/Xcode/Gradle, never by Node.
  ['java', 'java'], // Java source
  ['kt', 'kotlin'], // Kotlin source
  ['kts', 'kotlin'], // Kotlin build script (*.gradle.kts)
  ['gradle', 'gradle'], // Gradle build script
  ['m', 'objc'], // Objective-C source
  ['mm', 'objcpp'], // Objective-C++ source
  ['swift', 'swift'], // Swift source
  ['c', 'c'], // C source
  ['cc', 'cpp'], ['cxx', 'cpp'], ['cpp', 'cpp'], ['c++', 'cpp'], // C++ source (+ alt spellings)
  ['h', 'c-header'], // C/C++/Objective-C header
  ['hh', 'cpp-header'], ['hxx', 'cpp-header'], ['hpp', 'cpp-header'], ['h++', 'cpp-header'], // C++ headers
  ['rb', 'ruby'], // Ruby (podspec helpers, CocoaPods scripts)
  ['cmake', 'cmake'], // CMake build script
  ['podspec', 'podspec'], // CocoaPods spec (Ruby DSL)
  ['template', 'template'], // build-input template
  ['xml', 'xml'], // e.g. AndroidManifest.xml
  ['plist', 'xml'], // Apple property list (XML)
  ['xcprivacy', 'xml'], // Apple privacy manifest (XML plist)
  ['xcscheme', 'xml'], // Xcode scheme (XML)
  ['storyboard', 'xml'], // Interface Builder storyboard (XML)
  ['entitlements', 'xml'], // Apple entitlements (XML plist)
  ['env', 'env'], // dotenv config
  ['pbxproj', 'pbxproj'], // Xcode project file (old-style plist) -- see NB below
  ['xcworkspacedata', 'xml'], // Xcode workspace descriptor (XML) -- see NB below
  // NB: project.pbxproj / *.xcworkspacedata live inside the `.xcodeproj`/`.xcworkspace` bundle dirs
  // the Metro capture excludes (isNativeArtifact), so only `stasis add` / `--fs` reach them; tagged
  // here (the one vocabulary) so every path agrees on the format.
])

// Code formats by exact (lowercased) BASENAME, for names an extension can't key: Podfile,
// Podfile.lock (`.lock` too generic), CMakeLists.txt (`.txt` too generic), gradlew, Appfile/Fastfile,
// apple-app-site-association. package.json / `*.podspec.json` are handled in classifyFormat directly.
const CODE_NAME_FORMATS = new Map([
  ['podfile', 'podfile'],
  ['podfile.lock', 'podfile-lock'],
  ['cmakelists.txt', 'cmake'],
  ['gradlew', 'shell'],
  ['appfile', 'fastlane'],
  ['fastfile', 'fastlane'],
  ['apple-app-site-association', 'json'],
])

// A POSIX shell shebang (`#!/bin/sh`, `#!/usr/bin/env bash`) on an EXTENSIONLESS, UTF-8 file ->
// 'shell' (classifyFormat's no-extension arm). Only the first line's interpreter is inspected; a
// non-shell one falls through to the extension/name rules.
const SHELL_SHEBANG = /^#![^\n]*\b(?:bash|sh)\b/u
function isShellShebang(content) {
  if (!Buffer.isBuffer(content) || !isUtf8(content)) return false
  const head = content.subarray(0, 256).toString('utf8')
  const nl = head.indexOf('\n')
  return SHELL_SHEBANG.test(nl === -1 ? head : head.slice(0, nl))
}

// Files a native package ships that are NOT build inputs -- docs, editor/lint/CI/tooling config,
// changelogs, logs. Excluded from the Metro native capture so the bundle carries only what the
// CocoaPods/Gradle build consumes. `.bat` (Windows batch) is excluded off Windows; `win32` defaults
// to the capturing host's platform. md: docs.  log: build/test logs.  map: source maps (JS output).
const NATIVE_EXCLUDE_EXTS = new Set(['md', 'log', 'map'])
const NATIVE_EXCLUDE_NAMES = new Set([
  'license', '.prettierrc', '.gitattributes', '.flowconfig', '.eslintignore', '.releaserc',
  '.clang-format', '.buckconfig', '.watchmanconfig',
])
export function isExcludedNativeFile(name, { win32 = process.platform === 'win32' } = {}) {
  const base = basename(name).toLowerCase()
  if (NATIVE_EXCLUDE_NAMES.has(base)) return true
  const ext = pathExt(name)
  if (NATIVE_EXCLUDE_EXTS.has(ext)) return true
  return !win32 && ext === 'bat' // Windows batch scripts aren't a build input off Windows
}

// A native-module TOPLEVEL directory platform-specific to a platform we're not capturing:
// react-native-windows' `windows/`, skipped off Windows. `win32` defaults to the host's platform.
export function isExcludedNativeDir(name, { win32 = process.platform === 'win32' } = {}) {
  return !win32 && name === 'windows'
}

// THE single name->format classifier -- the one authority every capture path is a policy view of.
// Given a file NAME (+ bytes as `content` for the extensionless-shell case), returns a concrete
// format when the name determines one; null for a JS-family file whose Node format is
// package-`type`/syntax dependent (.js/.ts) or none (.jsx/.tsx); or undefined when the name isn't
// recognized code. FORMAT only -- each caller layers its own policy (run executes only NODE_FORMATS,
// classifyExtension keeps the JS-graph narrow, `--fs` follows this wholesale, classifyNativeCapture
// adds the Metro skip/resource rules).
export function classifyFormat(name, { content } = {}) {
  const base = basename(name).toLowerCase()
  // package.json / JSON podspecs are 'json' by name (a `*.podspec.json` is both, and Node reads it
  // as JSON) -- checked before the extension rules so it isn't shadowed.
  if (base === 'package.json' || base.endsWith('.podspec.json')) return 'json'
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return byName
  const ext = pathExt(name)
  if (JS_UNRESOLVED_EXTS.has(ext)) return null
  const byExt = NODE_EXT_FORMATS.get(ext) ?? CODE_EXT_FORMATS.get(ext)
  if (byExt !== undefined) return byExt
  if (ext === '' && isShellShebang(content)) return 'shell'
  return undefined
}

// The Metro native capture's policy view (StasisMetro AND `stasis bundle --metro`) -- one decision
// for how a build-input file is recorded, so the sites can't drift. Returns { action, format }:
//   - 'code' + tag: a native build input for the CODE bundle.
//   - 'skip': excluded noise (isExcludedNativeFile), or a JS-family file matched BY EXTENSION
//     (Metro owns those). Name-matched files are the exception -- build inputs, so they ride 'code'.
//   - 'resource': anything else (State derives resource vs resource:base64 from the bytes).
// A code file must be UTF-8 (callers assert it). `content` (optional) enables the shell-shebang rule.
export function classifyNativeCapture(name, { win32 = process.platform === 'win32', content } = {}) {
  if (isExcludedNativeFile(name, { win32 })) return { action: 'skip' }
  const base = basename(name).toLowerCase()
  // Name-matched code is always a native build input, even when its tag is a Node format the JS
  // graph would otherwise own (package.json / JSON podspecs -> json; gradlew -> shell; ...).
  if (base === 'package.json' || base.endsWith('.podspec.json')) return { action: 'code', format: 'json' }
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return { action: 'code', format: byName }
  // JS-family BY EXTENSION (.js/.ts/.jsx/.tsx + mjs/cjs/json/mts/cts): Metro's module graph owns it.
  if (CODE_EXTENSIONS.has(pathExt(name))) return { action: 'skip' }
  // Extension-matched native/source code, or the extensionless shell-shebang case.
  const format = classifyFormat(name, { content })
  if (format !== undefined) return { action: 'code', format }
  return { action: 'resource' }
}

// Files `pod install` READS while LOADING podspecs, beyond the podspec itself: the Ruby helpers a
// podspec `require`s (hermes-engine.podspec -> hermes-utils.rb; Podfile -> scripts/*.rb) and the
// package.json podspecs parse for the version. Captured alongside podspecs so every podspec loads
// from the artifact -- NOT the native source those podspecs later compile. `name` is a basename.
export function isNativeManifest(name) {
  return isPodspec(name) || pathExt(name) === 'rb' || name === 'package.json'
}

// React Native CORE subdirectories captured IN FULL (native source too) with a metro bundle: build
// inputs the native build compiles from react-native itself, outside the autolinked-dependency model
// and unreachable from the JS graph. A stasis-vetted fixed list, project-relative to the react-native
// package root; a dir missing in a given version is skipped.
//   - ReactCommon/yoga: the Yoga layout engine's C++ sources + cmake/CMakeLists.txt.
//   - sdks/hermes-engine: the hermes-engine podspec dir (podspec + its Ruby helpers + configs).
//   - scripts: the CocoaPods integration the Podfile drives (react_native_pods.rb, cocoapods/*,
//     the Xcode build-phase shell scripts).
export const RN_CORE_INCLUDE_DIRS = ['ReactCommon/yoga', 'sdks/hermes-engine', 'scripts']

// Individual react-native CORE files captured with a metro bundle (project-relative; a missing one
// is skipped). Named rather than folded into an include DIR because their directory also holds huge
// prebuilt binaries we must NOT capture:
//   - sdks/.hermesversion: the Hermes revision hermes-utils.rb reads at podspec-load time; sits
//     under sdks/, which also holds sdks/hermesc/* (prebuilt compiler binaries).
export const RN_CORE_INCLUDE_FILES = ['sdks/.hermesversion']

// Set-equality for parsed resources allowlists. Coordinates a plugin's `resources` option against
// an active preload's, and the env var against an explicit option in Config.
export function extSetsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const ext of a) if (!b.has(ext)) return false
  return true
}

// Flat project-relative key for file `rel` inside module dir `dir`, inverse of the bucketing
// State/Bundle apply. The `rel === ''` branch is reached only by a `directory` capture whose path
// IS a module root (e.g. `fs.readdirSync` of a package or the project root): the flat key is the
// dir -- never `${dir}/`, which a trailing-slash join would wrongly produce, breaking the round-trip.
// The workspace root keys at '.', NOT '' (join('.', '') === '.' is what lockfile re-absorb derives,
// so a '' key would be written but never found again on load). Otherwise `rel` is a real basename,
// matching the historical `dir === '.' ? rel : `${dir}/${rel}`` exactly.
export function moduleFileKey(dir, rel) {
  if (rel === '') return dir
  return dir === '.' ? rel : `${dir}/${rel}`
}

// Resolve `baseDir/relPath` through symlinks and confirm the real target stays within `realBase`
// (the caller-resolved real path of baseDir). Throws on a symlink that escapes the bundle root: a
// crafted in-tree symlink (`link.sh -> /etc/passwd`) must not pull an external file into a
// self-contained, attestable bundle. The textual path guards elsewhere don't catch this -- they
// never resolve symlinks. realpathSync surfaces ENOENT for a missing path, which loaders' disk
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

// True when a POSIX, project-relative path escapes the root once normalized: a leading `..`, an
// absolute path, or a mid-path `..` that pops above the root (`a/../../x`). Plain `startsWith('..')`
// catches only the leading case, so it's not enough for paths later resolved against the root.
export function posixPathEscapes(path) {
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)
}

// --- Artifact merge helpers -------------------------------------------------
// Shared by Bundle.merge and Lockfile.merge (`stasis bundle --add`): both grow an on-disk artifact
// by unioning a freshly built one into it. Bundles and lockfiles carry the same
// module/import/format shapes (a bundle stores each file's CONTENT where a lockfile stores its
// integrity HASH), but the merge rule is identical: an overlapping entry must match exactly, a
// genuine conflict throws rather than letting the newer artifact silently mask what the existing
// one attested. Kept here so the two `merge` methods can't drift.

// Value-equality for one import-edge target: a plain resolved-file string, or a { platform: file }
// Map (a `--metro` per-platform edge). Different kinds, or any differing platform->file pair, are unequal.
function importTargetsEqual(a, b) {
  const aMap = a instanceof Map
  if (aMap !== (b instanceof Map)) return false
  if (!aMap) return a === b
  if (a.size !== b.size) return false
  for (const [platform, file] of a) if (b.get(platform) !== file) return false
  return true
}

const fmtTarget = (t) => (t instanceof Map ? `{${[...t].map(([p, f]) => `${p}: ${f}`).join(', ')}}` : t)

// Merge two import maps (conditions -> parent -> specifier -> target) into a fresh Map. An edge on
// both sides must resolve to the same target; a real redirect conflict throws. `label` tags the error.
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
      const currentFormat = out.get(file)
      if (currentFormat === undefined) {
        out.set(file, format)
        continue
      }
      // reconcileFormat lets a real format supersede a weak 'stat:*' record (and vice versa),
      // and throws on a genuine conflict; tag it with the merge label for context.
      try {
        out.set(file, reconcileFormat(format, currentFormat, file))
      } catch (cause) {
        throw new Error(`${label}: ${cause.message}`, { cause })
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
}

// Merge two per-package module maps (dir -> { name, version, ecosystem?, files }) into a fresh Map.
// Overlapping buckets must agree on name/version/ecosystem, and a file in both must carry the
// identical value (bytes for a bundle, hash for a lockfile) -- a real divergence throws. `label`
// tags every message. Result `files` objects are null-prototype, so a `__proto__` file name is a
// plain own key.
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
