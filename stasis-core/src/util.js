import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { basename, isAbsolute, join, posix, relative } from 'node:path'

// Snapshot realpathSync before `stasis run --fs` patches fs.realpathSync: the patched wrapper
// doesn't throw ENOENT, which would defeat assertRealPathWithinBase's reliance on that throw.
const { realpathSync } = fs

const sep = '/'

// KNOWN_FORMATS (the union of the category sets below) is the finite universe of `format` strings;
// parsers reject anything outside it, so a tampered/forward-incompatible artifact fails closed.
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

// JS-shaped code extensions. NODE_EXT_FORMATS fixes the format by extension; JS_UNRESOLVED_EXTS
// (.js/.ts type/syntax-dependent, .jsx/.tsx bundler-transformed) return null from classifyFormat.
const NODE_EXT_FORMATS = new Map([
  ['mjs', 'module'], ['cjs', 'commonjs'], ['json', 'json'],
  ['mts', 'module-typescript'], ['cts', 'commonjs-typescript'],
])
const JS_UNRESOLVED_EXTS = new Set(['js', 'ts', 'jsx', 'tsx'])
export const CODE_EXTENSIONS = new Set([...NODE_EXT_FORMATS.keys(), ...JS_UNRESOLVED_EXTS])

// The payload-free stat-record formats (`--fs` lstat/stat): attest a path's KIND, no content, so
// they live only in `formats` maps. Deliberately weak -- real content for the same path supersedes.
export const isStatFormat = (format) => STAT_FORMATS.has(format)

// Kind a format attests ('directory' vs 'file'). Gates reconcileFormat so a stat record only
// reconciles with a real format of the SAME kind.
const formatKind = (format) => (format === 'directory' || format === 'stat:directory' ? 'directory' : 'file')

// Reconcile a newly-seen `format` against `currentFormat`, returning the winner or throwing on
// conflict. A weak 'stat:*' record yields to a real format of the SAME kind and never displaces
// one; two real formats, or a stat vs a real format of the OTHER kind, conflict.
export function reconcileFormat(format, currentFormat, name) {
  if (format === currentFormat) return format
  const stat = isStatFormat(format)
  const currentStat = isStatFormat(currentFormat)
  if (stat !== currentStat && formatKind(format) === formatKind(currentFormat)) {
    return stat ? currentFormat : format
  }
  throw new Error(`format conflict for '${name}' ('${currentFormat}' vs '${format}')`)
}

// Lowercased, dot-less extension of a path, or '' if none.
export function pathExt(filePath) {
  const m = /\.([^./\\]+)$/.exec(filePath)
  return m ? m[1].toLowerCase() : ''
}

// A `.env` secrets file by BASENAME: `.env` itself or the `.env.*` family (`.env.local`,
// `.env.production`), plus any file whose final extension is `.env` (`web.env`, `.abc.env` --
// Docker Compose env_file / reversed-dotenv conventions, secret-bearing all the same). Basename
// alone can't key the whole family (pathExt('.env.local') is 'local'), and extension alone misses
// `.env.*`, so both rules apply. Automated capture paths skip these (never bake a secret in);
// `stasis add .env` still captures (classifyFormat is unchanged).
export function isDotEnvFile(name) {
  const base = basename(name).toLowerCase()
  return base === '.env' || base.startsWith('.env.') || pathExt(base) === 'env'
}

// Validate + normalize a `resources` allowlist into a Set of lowercase entries: each a bare
// extension (`png`) or extensionless filename (`LICENSE`). A dotted entry (`data.bin`) is rejected
// -- a file with an extension is keyed by it, so it would never match; declare the extension.
// Code extensions are rejected too (always tracked).
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

// Parse a brotli-quality string (0..11). `${n}` must round-trip to the input, so non-canonical
// Number()-coercible forms ('5.0', '05', ' 5 ') throw instead of selecting an unintended quality.
export function parseBrotliQuality(name, value) {
  const n = Number(value)
  if (`${n}` !== value || !isBrotliQuality(n)) {
    throw new RangeError(`${name} must be an integer 0..11 (got '${value}')`)
  }
  return n
}

// The JS-graph bundlers' policy view over classifyFormat. Returns 'code', 'resource' (allowlisted
// asset), or 'unknown'. Only JS-family code counts as 'code'; native/source formats don't.
export function classifyExtension(filePath, resources) {
  // null (js-family) + NODE_FORMATS (fixed mjs/cjs/json/*-ts) == exactly the JS-graph code set.
  const format = classifyFormat(filePath)
  if (format === null || NODE_FORMATS.has(format)) return 'code'
  if (resources.has(pathExt(filePath) || basename(filePath).toLowerCase())) return 'resource'
  return 'unknown'
}

// Compiled/prebuilt native artifacts and non-source directory bundles, typically non-deterministic
// across installs, so the native capture skips them entirely (neither bytes nor integrity). Matched
// by suffix on a file OR directory name (e.g. an Apple `*.framework` or `*.xcodeproj` bundle dir).
const NATIVE_ARTIFACT_EXTS = new Set([
  'a', 'so', 'o', 'obj', 'dylib', 'lib', 'dll', 'exe', 'pdb',
  'aar', 'jar', 'class', 'dex',
  'node',
  'framework', 'xcframework', 'dsym',
  'xcodeproj', 'xcworkspace',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
])
export function isNativeArtifact(name) {
  return NATIVE_ARTIFACT_EXTS.has(pathExt(name))
}

// A CocoaPods podspec manifest, discovered by name (RN scatters them in subdirs `react-native config` misses).
export function isPodspec(name) {
  return name.endsWith('.podspec') || name.endsWith('.podspec.json')
}

// Non-JS code formats by extension (pathExt): the extension half of classifyFormat alongside
// NODE_EXT_FORMATS. Every value is in KNOWN_FORMATS.
const CODE_EXT_FORMATS = new Map([
  ['sol', 'solidity'],
  ['php', 'php'],
  ['sh', 'shell'], ['bash', 'shell'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['gradle', 'gradle'],
  ['m', 'objc'],
  ['mm', 'objcpp'],
  ['swift', 'swift'],
  ['c', 'c'],
  ['cc', 'cpp'], ['cxx', 'cpp'], ['cpp', 'cpp'], ['c++', 'cpp'],
  ['h', 'c-header'],
  ['hh', 'cpp-header'], ['hxx', 'cpp-header'], ['hpp', 'cpp-header'], ['h++', 'cpp-header'],
  ['rb', 'ruby'],
  ['cmake', 'cmake'],
  ['podspec', 'podspec'],
  ['template', 'template'],
  ['xml', 'xml'],
  ['plist', 'xml'],
  ['xcprivacy', 'xml'],
  ['xcscheme', 'xml'],
  ['storyboard', 'xml'],
  ['entitlements', 'xml'],
  ['env', 'env'],
  // pbxproj / *.xcworkspacedata live inside the `.xcodeproj`/`.xcworkspace` bundle dirs the Metro
  // capture excludes, so only `stasis add`/`--fs` reach them; tagged here so every path agrees.
  ['pbxproj', 'pbxproj'],
  ['xcworkspacedata', 'xml'],
])

// Code formats by exact (lowercased) basename, for names an extension can't key (Podfile.lock's
// `.lock` and CMakeLists.txt's `.txt` are too generic). package.json / `*.podspec.json` handled in
// classifyFormat directly.
const CODE_NAME_FORMATS = new Map([
  ['podfile', 'podfile'],
  ['podfile.lock', 'podfile-lock'],
  ['cmakelists.txt', 'cmake'],
  ['gradlew', 'shell'],
  ['appfile', 'fastlane'],
  ['fastfile', 'fastlane'],
  ['apple-app-site-association', 'json'],
])

// A POSIX shell shebang on an extensionless, UTF-8 file -> 'shell'. Only the first line is
// inspected; a non-shell one falls through to the extension/name rules.
const SHELL_SHEBANG = /^#![^\n]*\b(?:bash|sh)\b/u
function isShellShebang(content) {
  if (!Buffer.isBuffer(content) || !isUtf8(content)) return false
  const head = content.subarray(0, 256).toString('utf8')
  const nl = head.indexOf('\n')
  return SHELL_SHEBANG.test(nl === -1 ? head : head.slice(0, nl))
}

// Files a native package ships that are NOT build inputs -- docs/legal, editor/lint/CI/tooling
// config, logs/maps, JS-tooling lockfiles, IDE project metadata -- excluded from the Metro native
// capture (a module is built by the APP's Gradle/CocoaPods, so its own wrapper/IDE files are
// standalone-dev only). `.bat` (Windows batch) is excluded off Windows; `win32` defaults to the host.
const NATIVE_EXCLUDE_EXTS = new Set(['md', 'log', 'map'])
const NATIVE_EXCLUDE_NAMES = new Set([
  'license', 'licence', 'third-party-licenses', // license / legal text (US + UK spelling)
  '.prettierrc', '.gitattributes', '.flowconfig', '.eslintignore', '.releaserc', '.clang-format',
  '.buckconfig', '.watchmanconfig', '.editorconfig', 'circle.yml', '.swiftlint.yml', // editor / lint / CI config
  'yarn.lock', // JS dep lockfile (a native build never reads it)
  '.project', // Eclipse IDE project metadata (Gradle doesn't read it)
  'gradle-wrapper.properties', // a module's own Gradle wrapper -- the APP's wrapper drives the build
])
export function isExcludedNativeFile(name, { win32 = process.platform === 'win32' } = {}) {
  const base = basename(name).toLowerCase()
  if (NATIVE_EXCLUDE_NAMES.has(base)) return true
  const ext = pathExt(name)
  if (NATIVE_EXCLUDE_EXTS.has(ext)) return true
  return !win32 && ext === 'bat'
}

// A native-module toplevel directory for a platform we're not capturing (e.g. `windows/` off Windows).
export function isExcludedNativeDir(name, { win32 = process.platform === 'win32' } = {}) {
  return !win32 && name === 'windows'
}

// The single name->format classifier every capture path is a policy view of. Returns a concrete
// format when the name determines one; null for a JS-family file whose format is type/syntax
// dependent (.js/.ts) or none (.jsx/.tsx); undefined when the name isn't recognized code.
export function classifyFormat(name, { content } = {}) {
  const base = basename(name).toLowerCase()
  // package.json / JSON podspecs are 'json' by name, checked before the extension rules so a
  // `*.podspec.json` isn't shadowed.
  if (base === 'package.json' || base.endsWith('.podspec.json')) return 'json'
  // A `*.cmake.in` is a CMake configure_file template (build input); keyed by its compound suffix
  // because pathExt only sees the trailing `.in`.
  if (base.endsWith('.cmake.in')) return 'cmake'
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return byName
  const ext = pathExt(name)
  if (JS_UNRESOLVED_EXTS.has(ext)) return null
  const byExt = NODE_EXT_FORMATS.get(ext) ?? CODE_EXT_FORMATS.get(ext)
  if (byExt !== undefined) return byExt
  if (ext === '' && isShellShebang(content)) return 'shell'
  return undefined
}

// The Metro native capture's policy view. Returns { action, format }: 'code' (a native build
// input), 'skip' (excluded noise, or a JS-family file matched BY EXTENSION -- Metro owns those),
// or 'resource' (anything else). `content` (optional) enables the shell-shebang rule.
export function classifyNativeCapture(name, { win32 = process.platform === 'win32', content } = {}) {
  if (isExcludedNativeFile(name, { win32 })) return { action: 'skip' }
  // `.env`/`.env.*` carry secrets: an automated capture must never sweep them in. classifyFormat
  // still tags `.env` as 'env', so an explicit `stasis add .env` keeps working.
  if (isDotEnvFile(name)) return { action: 'skip' }
  const base = basename(name).toLowerCase()
  // Name-matched code is always a native build input, even when its tag is a Node format the JS
  // graph would otherwise own.
  if (base === 'package.json' || base.endsWith('.podspec.json')) return { action: 'code', format: 'json' }
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return { action: 'code', format: byName }
  // JS-family by extension: Metro's module graph owns it.
  if (CODE_EXTENSIONS.has(pathExt(name))) return { action: 'skip' }
  const format = classifyFormat(name, { content })
  if (format !== undefined) return { action: 'code', format }
  return { action: 'resource' }
}

// Files `pod install` reads while loading podspecs (Ruby helpers a podspec `require`s, package.json
// for the version). Captured alongside podspecs -- NOT the native source those podspecs compile.
export function isNativeManifest(name) {
  return isPodspec(name) || pathExt(name) === 'rb' || name === 'package.json'
}

// React Native CORE subdirectories captured IN FULL (native source too) with a metro bundle:
// build inputs unreachable from the JS graph. A fixed list, project-relative; a missing dir is skipped.
export const RN_CORE_INCLUDE_DIRS = ['ReactCommon/yoga', 'sdks/hermes-engine', 'scripts']

// Individual react-native CORE files captured with a metro bundle. Named rather than folded into
// an include DIR because their directory also holds huge prebuilt binaries we must NOT capture.
export const RN_CORE_INCLUDE_FILES = ['sdks/.hermesversion']

export function extSetsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const ext of a) if (!b.has(ext)) return false
  return true
}

// Flat project-relative key for file `rel` inside module dir `dir`. The `rel === ''` branch (a
// `directory` capture whose path IS a module root) keys the bare dir -- never `${dir}/`, which a
// trailing-slash join would wrongly produce, breaking the round-trip (the workspace root keys at '.').
export function moduleFileKey(dir, rel) {
  if (rel === '') return dir
  return dir === '.' ? rel : `${dir}/${rel}`
}

// Resolve `baseDir/relPath` through symlinks and confirm the real target stays within `realBase`.
// Throws on a symlink escaping the bundle root (a crafted `link.sh -> /etc/passwd` must not pull an
// external file into an attestable bundle). realpathSync surfaces ENOENT, which loaders treat as "missing".
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

// True when a POSIX path escapes the root once normalized (leading `..`, absolute, or a mid-path
// `..` that pops above the root). Plain `startsWith('..')` catches only the leading case.
export function posixPathEscapes(path) {
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)
}

// Shared by Bundle.merge and Lockfile.merge: union a freshly built artifact into an on-disk one.
// The merge rule is identical -- an overlapping entry must match exactly, a genuine conflict throws
// rather than letting the newer artifact silently mask what the existing one attested.

// Value-equality for one import-edge target: a resolved-file string, or a { platform: file } Map.
function importTargetsEqual(a, b) {
  const aMap = a instanceof Map
  if (aMap !== (b instanceof Map)) return false
  if (!aMap) return a === b
  if (a.size !== b.size) return false
  for (const [platform, file] of a) if (b.get(platform) !== file) return false
  return true
}

const fmtTarget = (t) => (t instanceof Map ? `{${[...t].map(([p, f]) => `${p}: ${f}`).join(', ')}}` : t)

// Merge two import maps (conditions -> parent -> specifier -> target). An edge on both sides must
// resolve to the same target; a redirect conflict throws.
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
      // reconcileFormat supersedes a weak 'stat:*' with a real format and throws on conflict.
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

// Merge two per-package module maps into a fresh Map. Overlapping buckets must agree on
// name/version/ecosystem, and a file in both must carry the identical value -- a divergence throws.
// Result `files` objects are null-prototype, so a `__proto__` file name is a plain own key.
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

// True when `node_modules` appears as a full path SEGMENT in `path` -- at the start or right after
// a `/`, and terminated by a `/` or the end -- NOT as a bare substring (`foo_node_modules/dep` is
// a source dir, not a dependency bucket). Shared segment-aware gate for the module-bucket
// classification across state/bundle/lockfile/prune/add; paths here are always POSIX ('/'-joined).
export function hasNodeModulesSegment(path) {
  return path.split('/').includes('node_modules')
}

// Locate the LAST (deepest) segment-aligned `node_modules/` marker in `path`. Returns its start
// index, or -1. `lastIndexOf` alone would also match a bare substring (`foo_node_modules/`), so a
// candidate only counts when it starts the path or follows a `/`.
function lastNodeModulesMarker(path) {
  const marker = 'node_modules/'
  let idx = path.length
  while ((idx = path.lastIndexOf(marker, idx - 1)) !== -1) {
    if (idx === 0 || path[idx - 1] === '/') return idx
  }
  return -1
}

export function splitNodeModulesPath(path) {
  const marker = 'node_modules/'
  const idx = lastNodeModulesMarker(path)
  if (idx === -1) return null
  const after = idx + marker.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const name = parts.slice(0, pkgLen).join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}
