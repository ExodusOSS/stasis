// PHP include-graph + Composer-autoload loader. Statically scans PHP (never runs
// it) into `{ sources, resolutions, missing }`. Literal includes are strict
// (unresolved -> `missing`); Composer-autoloaded class refs are best-effort
// (unresolved -> silently skipped).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// Cap concurrent reads per wave to avoid EMFILE on large directory globs.
const READ_CONCURRENCY = 64

// End index (exclusive) of the heredoc/nowdoc opener at `start`, or `start` if
// not a valid opener. Consumes to EOF when unterminated.
function heredocEnd(code, start) {
  const n = code.length
  let j = start + 3
  while (j < n && (code[j] === ' ' || code[j] === '\t')) j++
  const quote = code[j] === '"' || code[j] === "'" ? code[j++] : ''
  let label = ''
  while (j < n && /\w/u.test(code[j])) label += code[j++]
  if (label === '') return start
  if (quote && code[j] === quote) j++
  let p = code.indexOf('\n', j)
  if (p === -1) return n
  p += 1
  while (p <= n) {
    let q = p
    while (q < n && (code[q] === ' ' || code[q] === '\t')) q++
    if (code.startsWith(label, q)) {
      const after = code[q + label.length]
      if (after === undefined || !/\w/u.test(after)) {
        const nl = code.indexOf('\n', q)
        return nl === -1 ? n : nl
      }
    }
    const nl = code.indexOf('\n', p)
    if (nl === -1) return n
    p = nl + 1
  }
  return n
}

// Blank everything that isn't executable PHP (comments, heredocs/nowdocs, and
// unless `keepStrings` string literals) to spaces, preserving newlines so byte
// offsets stay aligned with the input. `#[` (a PHP 8 attribute) is left intact.
function maskNonCode(code, keepStrings) {
  const n = code.length
  const blank = (s) => s.replace(/[^\n]/gu, ' ')
  let out = ''
  let i = 0
  while (i < n) {
    const c = code[i]
    if ((c === '/' && code[i + 1] === '/') || (c === '#' && code[i + 1] !== '[')) {
      let end = code.indexOf('\n', i)
      if (end === -1) end = n
      out += blank(code.slice(i, end))
      i = end
    } else if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out += blank(code.slice(i, end))
      i = end
    } else if (c === '<' && code[i + 1] === '<' && code[i + 2] === '<') {
      const end = heredocEnd(code, i)
      if (end === i) { out += c; i++ } else { out += blank(code.slice(i, end)); i = end }
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === c) { j++; break }
        j++
      }
      out += keepStrings ? code.slice(i, j) : blank(code.slice(i, j))
      i = j
    } else {
      out += c
      i++
    }
  }
  return out
}

// Blank comments/heredocs, keep string literals (include paths live in strings).
function maskCommentsAndHeredocs(content) {
  return maskNonCode(content, true)
}

// Scan string literals -> { start, end, value, quote } with PHP single-quote
// unescaping (only `\\` and the closing quote are escapes; other backslashes
// literal -- good enough for path values).
function stringLiterals(code) {
  const out = []
  let i = 0
  while (i < code.length) {
    const q = code[i]
    if (q === "'" || q === '"') {
      let j = i + 1
      let value = ''
      while (j < code.length) {
        const c = code[j]
        if (c === '\\') {
          const next = code[j + 1]
          value += next === '\\' || next === q ? next : c + (next ?? '')
          j += next === undefined ? 1 : 2
          continue
        }
        if (c === q) { j++; break }
        value += c
        j++
      }
      out.push({ start: i, end: j, value, quote: q })
      i = j
    } else {
      i++
    }
  }
  return out
}

// Include keyword. The lookbehind rejects method/scope-resolution calls
// (`$x->require`, `Foo::include`); the trailing `\b` stops matching inside
// `requireConfig`. String-literal matches are filtered out by the caller.
const PHP_INCLUDE_KEYWORD_RE = /(?<![\w$>:])(?:require_once|require|include_once|include)\b/gidu

// Directory anchor (sticky): `__DIR__`/`dirname(__FILE__)` (file's own dir) or
// `dirname(__DIR__[, N])` (N parent levels up).
const PHP_DIR_ANCHOR_RE = /__DIR__\b|dirname\s*\(\s*(__FILE__|__DIR__)\s*(?:,\s*(\d+)\s*)?\)/y
// Anchor starts, for scanning path literals anywhere (not just after `require`).
const PHP_DIR_ANCHOR_FIND_RE = /(?<![\w$>])(?:__DIR__\b|dirname\s*\(\s*(?:__FILE__|__DIR__))/gu

// Laravel path helpers resolving a string arg relative to the project root (or a
// fixed subdirectory); they name real PHP files the framework require()s.
const PHP_PATH_HELPERS = new Map([
  ['base_path', ''],
  ['app_path', 'app'],
  ['config_path', 'config'],
  ['database_path', 'database'],
  ['lang_path', 'lang'],
  ['public_path', 'public'],
  ['resource_path', 'resources'],
  ['storage_path', 'storage'],
])
const PHP_PATH_HELPER_FIND_RE =
  /(?<![\w$>:])(base_path|app_path|config_path|database_path|lang_path|public_path|resource_path|storage_path)\s*\(/giu

// Interpolation markers inside a double-quoted string (`$var`, `${...}`,
// `{$...}`). Single-quoted strings never interpolate, so a `$` there is literal.
const PHP_INTERPOLATION_RE = /\$[A-Za-z_{]|\{\$/u

function skipWs(code, pos) {
  while (pos < code.length && /\s/u.test(code[pos])) pos++
  return pos
}

// If a directory anchor starts at `pos`, return { end, up } (up = parent levels
// above the file's dir; 0 for `__DIR__`/`dirname(__FILE__)`); else null.
function matchDirAnchor(code, pos) {
  PHP_DIR_ANCHOR_RE.lastIndex = pos
  const m = PHP_DIR_ANCHOR_RE.exec(code)
  if (!m) return null
  const up = m[1] === '__DIR__' ? (m[2] ? Number(m[2]) : 1) : 0
  return { end: PHP_DIR_ANCHOR_RE.lastIndex, up }
}

// Normalise an include path to a specifier. Dir-relative paths get a `./` prefix
// with the leading separator stripped; empty means the file's own dir (`.`).
function normalizeIncludePath(raw, dirRelative) {
  if (!dirRelative) return raw
  const rel = raw.replace(/^\/+/u, '')
  if (rel === '') return '.'
  return rel.startsWith('.') ? rel : `./${rel}`
}

// Parse an include/path argument at `start`: an optional directory anchor then a
// concatenation chain of string literals (static literals fold together). Goes
// `dynamic` at the first variable/function/constant/interpolation; `prefix` is
// the static path up to there. Returns null with neither anchor nor static string.
function parseArgPath(code, start, strings) {
  const stringAt = (pos) => strings.find(({ start: s }) => s === pos)
  let i = start
  let dirRelative = false
  let up = 0
  const anchor = matchDirAnchor(code, i)
  if (anchor) {
    i = skipWs(code, anchor.end)
    dirRelative = true
    up = anchor.up
    if (code[i] !== '.') return null
    i = skipWs(code, i + 1)
  }

  let prefix = '/..'.repeat(up)
  let dynamic = false
  let sawStatic = false
  for (;;) {
    const lit = stringAt(i)
    if (!lit) { dynamic = true; break }
    const interp = lit.quote === '"' ? lit.value.search(PHP_INTERPOLATION_RE) : -1
    if (interp >= 0) { prefix += lit.value.slice(0, interp); sawStatic = true; dynamic = true; break }
    prefix += lit.value
    sawStatic = true
    i = skipWs(code, lit.end)
    if (code[i] === '.') { i = skipWs(code, i + 1); continue }
    break
  }
  if (!dirRelative && !sawStatic) return null
  return { dirRelative, up, prefix, dynamic, sawStatic }
}

// Scan `require`/`include` statements, classifying each as a concrete `file` or
// -- when the path is dynamic but has a static directory prefix -- a `dir` whose
// `.php` files are all bundled (any could be the runtime target).
function scanIncludes(content) {
  const code = maskCommentsAndHeredocs(content)
  const strings = stringLiterals(code)
  const inString = (pos) => strings.some(({ start, end }) => pos > start && pos < end)

  const out = []
  for (const m of code.matchAll(PHP_INCLUDE_KEYWORD_RE)) {
    if (inString(m.index)) continue
    let i = skipWs(code, m.index + m[0].length)
    if (code[i] === '(') i = skipWs(code, i + 1)
    const arg = parseArgPath(code, i, strings)
    if (!arg) continue
    const { dirRelative, up, prefix, dynamic, sawStatic } = arg

    if (!dynamic) {
      if (sawStatic) out.push({ kind: 'file', spec: normalizeIncludePath(prefix, dirRelative) })
      continue
    }
    // Dynamic path: fall back to the static dir prefix; a bare path with no separator has none.
    if (!dirRelative && !prefix.includes('/')) continue
    const lastSlash = prefix.lastIndexOf('/')
    let dir = lastSlash >= 0 ? prefix.slice(0, lastSlash) : ''
    if (dir === '' && up > 0) dir = '/..'.repeat(up)
    out.push({ kind: 'dir', spec: normalizeIncludePath(dir, dirRelative) })
  }
  return out
}

// Dir-anchored static `.php` path literals anywhere in the file (not just after
// `require`) -- frameworks pass these to code that require()s them internally.
// Best-effort: bundled only if they resolve to an existing file.
function scanPathLiterals(content) {
  const code = maskCommentsAndHeredocs(content)
  const strings = stringLiterals(code)
  const inString = (pos) => strings.some(({ start, end }) => pos > start && pos < end)
  const stringAt = (pos) => strings.find(({ start }) => start === pos)

  const out = []
  // Dir-anchored literals: `__DIR__ . '/x.php'` (resolve against the file).
  for (const m of code.matchAll(PHP_DIR_ANCHOR_FIND_RE)) {
    if (inString(m.index)) continue
    const arg = parseArgPath(code, m.index, strings)
    if (!arg || arg.dynamic || !arg.sawStatic || !arg.dirRelative) continue
    const spec = normalizeIncludePath(arg.prefix, true)
    if (spec.endsWith('.php')) out.push({ spec, anchor: 'file' })
  }
  // Laravel path helpers: `base_path('routes/web.php')` (resolve against project root).
  for (const m of code.matchAll(PHP_PATH_HELPER_FIND_RE)) {
    if (inString(m.index)) continue
    const lit = stringAt(skipWs(code, m.index + m[0].length))
    if (!lit || (lit.quote === '"' && PHP_INTERPOLATION_RE.test(lit.value))) continue
    const sub = PHP_PATH_HELPERS.get(m[1].toLowerCase())
    const arg = lit.value.replace(/^\/+/u, '')
    const spec = sub ? `${sub}/${arg}` : arg
    if (spec.endsWith('.php')) out.push({ spec, anchor: 'root' })
  }
  return out
}

// Statically-resolvable include specifiers (concrete files). See scanIncludes.
export function extractPhpImports(content) {
  return scanIncludes(content).filter((e) => e.kind === 'file').map((e) => e.spec)
}

// Directory specifiers for dynamic includes; every `.php` file directly inside is
// a candidate target.
export function extractPhpImportDirs(content) {
  return scanIncludes(content).filter((e) => e.kind === 'dir').map((e) => e.spec)
}

// `.php` path literals used outside a `require` -- dir-anchored (`anchor: 'file'`)
// or via a Laravel path helper (`anchor: 'root'`). De-duplicated; best-effort.
export function extractPhpPathRefs(content) {
  const seen = new Set()
  return scanPathLiterals(content).filter(({ spec, anchor }) => {
    const key = `${anchor}:${spec}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Apply `segments` on `fromFile`'s directory, resolving '.'/'..'. Returns a
// baseDir-relative POSIX path, or null when traversal escapes the root.
function applyToDir(fromFile, segments) {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const parts = [...(fromDir ? fromDir.split('/') : []), ...segments]
  const resolved = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

function isFileOnDisk(baseDir, rel) {
  try {
    return statSync(join(baseDir, rel)).isFile()
  } catch {
    return false
  }
}

function isDirOnDisk(baseDir, rel) {
  try {
    return statSync(join(baseDir, rel)).isDirectory()
  } catch {
    return false
  }
}

// Resolve a directory specifier to an existing baseDir-relative dir, or null.
// `./`/`../` resolve against the including file; a bare spec tries file- then
// project-relative.
export function resolvePhpDir(spec, fromFile, baseDir) {
  if (spec.startsWith('.')) {
    const rel = applyToDir(fromFile, spec.split('/'))
    return rel !== null && isDirOnDisk(baseDir, rel) ? rel : null
  }
  if (baseDir && !isAbsolute(spec)) {
    const fileRel = applyToDir(fromFile, spec.split('/'))
    if (fileRel && isDirOnDisk(baseDir, fileRel)) return fileRel
    const projRel = relative(baseDir, resolve(baseDir, spec)).split(/[\\/]/u).join('/')
    if (projRel !== '' && !projRel.startsWith('..') && !isAbsolute(projRel) && isDirOnDisk(baseDir, projRel)) {
      return projRel
    }
  }
  return null
}

// The `.php` files directly in `dir` (baseDir-relative). Non-recursive: recursing
// could pull in an unbounded subtree.
function listPhpFiles(baseDir, dir) {
  try {
    return readdirSync(join(baseDir, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.php'))
      .map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
  } catch {
    return []
  }
}

// Resolve a PHP include specifier to a baseDir-relative POSIX path. `./`/`../`
// resolve against the including file (escaping the root -> null); a bare specifier
// tries a file next to the includer, then project-root-relative. Absolute
// specifiers are rejected. Returns null when nothing resolves.
export function resolvePhpImport(specifier, fromFile, { baseDir } = {}) {
  if (specifier.startsWith('.')) {
    return applyToDir(fromFile, specifier.split('/'))
  }

  if (baseDir && !isAbsolute(specifier)) {
    const fileRel = applyToDir(fromFile, specifier.split('/'))
    if (fileRel && isFileOnDisk(baseDir, fileRel)) return fileRel

    const projRel = relative(baseDir, resolve(baseDir, specifier)).split(/[\\/]/u).join('/')
    if (projRel !== '' && !projRel.startsWith('..') && !isAbsolute(projRel) && isFileOnDisk(baseDir, projRel)) {
      return projRel
    }
  }

  return null
}

// Normalise a project-root-relative autoload path to POSIX baseDir-relative, or
// null when it escapes root. Re-derives via resolve() so interior `..` escapes
// (`src/foo/../../../secret.php`) are caught -- a leading-`..`/absolute check
// alone would let files outside the project into the bundle.
function normalizeProjectRel(baseDir, p) {
  const rel = relative(baseDir, resolve(baseDir, p.replace(/\\/gu, '/'))).split(/[\\/]/u).join('/')
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

// Evaluate a generated-autoload path expr (`$baseDir . '/src'`, a bare quoted
// string) given the `$baseDir`/`$vendorDir` values. Returns null on anything
// unrecognised (function call, unknown variable) rather than guessing.
function evalPathExpr(expr, vars) {
  const s = expr.trim().replace(/,+$/u, '').trim()
  let out = ''
  let consumed = 0
  const re = /\$(\w+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\.|\s+/gy
  let m
  while ((m = re.exec(s)) !== null) {
    // A sticky regex resets lastIndex to 0 when exec() returns null, so track how
    // far we parsed instead of reading lastIndex after the loop.
    consumed = re.lastIndex
    if (m[1] !== undefined) {
      if (vars[m[1]] === undefined) return null
      out += vars[m[1]]
    } else if (m[2] !== undefined) {
      out += m[2].replace(/\\(['\\])/gu, '$1')
    } else if (m[3] !== undefined) {
      out += m[3]
    }
  }
  if (consumed !== s.length) return null
  return out
}

// Parse a Composer generated `autoload_*.php` map (one entry per line). `multi`
// true -> psr-4/psr-0 (key -> dirs[]); false -> classmap/files (key -> file).
// PHP single-quote escapes in keys are unfolded.
function parseGeneratedMap(content, vars, multi) {
  const out = new Map()
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*'((?:\\.|[^'\\])*)'\s*=>\s*(.+?),?\s*$/u)
    if (!m) continue
    const key = m[1].replace(/\\(['\\])/gu, '$1')
    if (multi) {
      const am = m[2].match(/^array\s*\(([\s\S]*)\)$/u)
      if (!am) continue
      const dirs = []
      for (const piece of am[1].split(',')) {
        const abs = evalPathExpr(piece, vars)
        if (abs) dirs.push(abs)
      }
      out.set(key, dirs)
    } else {
      const abs = evalPathExpr(m[2], vars)
      if (abs) out.set(key, abs)
    }
  }
  return out
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Build the autoload config for `baseDir`, merging the root composer.json
// `autoload`(+dev) with the generated `vendor/composer/autoload_*` maps. All
// paths normalised to POSIX baseDir-relative (escapers dropped). Returns
// `{ psr4, psr0, classmap, files }`, or null when no Composer config is found.
export function loadComposerAutoload(baseDir) {
  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'

  const psr4 = new Map()
  const psr0 = new Map()
  const classmap = new Map()
  const files = new Set()
  let found = false

  const addPrefixDirs = (map, prefix, paths) => {
    const list = Array.isArray(paths) ? paths : [paths]
    const dirs = []
    for (const p of list) {
      const rel = normalizeProjectRel(baseDir, String(p))
      if (rel !== null) dirs.push(rel)
    }
    const prev = map.get(prefix) ?? []
    map.set(prefix, [...new Set([...prev, ...dirs])])
  }

  // Root composer.json autoload (+ dev). PSR-4 keys keep their trailing '\'.
  for (const block of [composerJson?.autoload, composerJson?.['autoload-dev']]) {
    if (!block || typeof block !== 'object') continue
    found = true
    for (const [prefix, paths] of Object.entries(block['psr-4'] ?? {})) addPrefixDirs(psr4, prefix, paths)
    for (const [prefix, paths] of Object.entries(block['psr-0'] ?? {})) addPrefixDirs(psr0, prefix, paths)
    for (const f of block.files ?? []) {
      const rel = normalizeProjectRel(baseDir, String(f))
      if (rel) files.add(rel)
    }
  }

  // Generated maps. `$vendorDir` = <baseDir>/<vendorDir>, `$baseDir` = <baseDir>.
  const composerGenDir = join(baseDir, vendorDir, 'composer')
  const vars = { baseDir: resolve(baseDir), vendorDir: resolve(baseDir, vendorDir) }
  const toRel = (abs) => {
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
  }
  const mergePrefixMap = (file, target) => {
    if (!existsSync(file)) return
    found = true
    for (const [prefix, dirs] of parseGeneratedMap(readFileSync(file, 'utf8'), vars, true)) {
      const rels = dirs.map(toRel).filter((d) => d !== null).map((d) => d.replace(/\/+$/u, ''))
      const prev = target.get(prefix) ?? []
      target.set(prefix, [...new Set([...prev, ...rels])])
    }
  }
  mergePrefixMap(join(composerGenDir, 'autoload_psr4.php'), psr4)
  mergePrefixMap(join(composerGenDir, 'autoload_namespaces.php'), psr0)

  const classmapFile = join(composerGenDir, 'autoload_classmap.php')
  if (existsSync(classmapFile)) {
    found = true
    for (const [fqcn, abs] of parseGeneratedMap(readFileSync(classmapFile, 'utf8'), vars, false)) {
      const rel = toRel(abs)
      if (rel) classmap.set(fqcn.replace(/^\\+/u, ''), rel)
    }
  }
  const filesFile = join(composerGenDir, 'autoload_files.php')
  if (existsSync(filesFile)) {
    found = true
    for (const [, abs] of parseGeneratedMap(readFileSync(filesFile, 'utf8'), vars, false)) {
      const rel = toRel(abs)
      if (rel) files.add(rel)
    }
  }

  if (!found) return null
  return { psr4, psr0, classmap, files: [...files] }
}

// Resolve a FQCN to a baseDir-relative file via the autoload config, mirroring
// Composer's lookup order: classmap, then longest PSR-4 prefix, then PSR-0. Only
// returns a path that exists on disk (an absent prefix match isn't bundled as a hole).
export function resolveClassFile(fqcn, autoload, baseDir) {
  if (!autoload || !fqcn) return null
  const name = fqcn.replace(/^\\+/u, '')
  if (!name) return null

  const exact = autoload.classmap.get(name)
  if (exact && isFileOnDisk(baseDir, exact)) return exact

  // PSR-4: try every matching prefix longest-first (Composer falls back from a
  // longer prefix whose file is absent to a shorter one, incl. the `""` prefix).
  for (const [prefix, dirs] of matchingPrefixes(autoload.psr4, name)) {
    const sub = name.slice(prefix.length).replace(/\\/gu, '/')
    for (const dir of dirs) {
      const file = dir ? `${dir}/${sub}.php` : `${sub}.php`
      if (isFileOnDisk(baseDir, file)) return file
    }
  }

  // PSR-0: namespace separators AND underscores in the class name map to
  // directory separators; the namespace prefix is kept under the mapped dir.
  for (const [, dirs] of matchingPrefixes(autoload.psr0, name)) {
    const lastNs = name.lastIndexOf('\\')
    const nsPart = lastNs === -1 ? '' : name.slice(0, lastNs).replace(/\\/gu, '/')
    const clsPart = (lastNs === -1 ? name : name.slice(lastNs + 1)).replace(/_/gu, '/')
    const sub = `${nsPart ? `${nsPart}/` : ''}${clsPart}.php`
    for (const dir of dirs) {
      const file = dir ? `${dir}/${sub}` : sub
      if (isFileOnDisk(baseDir, file)) return file
    }
  }

  return null
}

// [prefix, dirs] entries whose prefix is a prefix of `name`, longest first --
// prefer the most specific mapping, fall back to shorter (and the `""` fallback).
function matchingPrefixes(map, name) {
  return [...map].filter(([prefix]) => name.startsWith(prefix)).toSorted((a, b) => b[0].length - a[0].length)
}

// Read installed-package versions from `vendor/composer/installed.json` (the
// authoritative source; a package's own composer.json usually omits `version`).
// Handles the Composer 2 ({ packages }) and Composer 1 (flat array) shapes.
function loadInstalledVersions(baseDir, vendorDir) {
  const json = readJsonIfExists(join(baseDir, vendorDir, 'composer', 'installed.json'))
  const byDir = new Map()
  const byName = new Map()
  const packages = Array.isArray(json) ? json : (json?.packages ?? [])
  for (const p of packages) {
    if (!p?.name || !p.version) continue
    byName.set(p.name, p.version)
    // install-path is relative to vendor/composer; default layout is vendor/<name>.
    const abs = p['install-path']
      ? resolve(baseDir, vendorDir, 'composer', p['install-path'])
      : resolve(baseDir, vendorDir, p.name)
    const rel = relative(baseDir, abs).split(/[\\/]/u).join('/')
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) byDir.set(rel, p.version)
  }
  return { byDir, byName }
}

// Walk up from a bundled file to the nearest named composer.json, returning
// { pkgDir, name, version } (pkgDir "." for the root; version from installed.json
// by dir/name, else composer.json `version`, else `fallbackVersion`). Null if none.
function findComposerPackage(baseDir, fileRelPath, installed, fallbackVersion) {
  let dir = dirname(fileRelPath)
  for (;;) {
    const cj = readJsonIfExists(join(baseDir, dir, 'composer.json'))
    if (cj?.name) {
      const version = installed.byDir.get(dir) ?? installed.byName.get(cj.name) ?? cj.version ?? fallbackVersion
      return { pkgDir: dir, name: cj.name, version }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Group bundled PHP sources into per-package buckets keyed by the nearest
// composer.json's directory (vendor deps get their own; workspace files and
// orphans -> the root "." bucket with the placeholder identity). Returns a
// Map<dir, { name, version, files }>.
export function bucketizePhpSources(baseDir, sources, fallbackName, fallbackVersion) {
  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'
  const installed = loadInstalledVersions(baseDir, vendorDir)

  const modules = new Map()
  const ensureBucket = (dir, name, version, ecosystem) => {
    if (!modules.has(dir)) {
      modules.set(dir, ecosystem === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, ecosystem, files: Object.create(null) })
    }
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const pkg = findComposerPackage(baseDir, path, installed, fallbackVersion)
    if (pkg) {
      const rel = pkg.pkgDir === '.' ? path : path.slice(pkg.pkgDir.length + 1)
      // Below the root package = an installed Composer dependency, tagged
      // `composer`; the root "." bucket is workspace code and stays ecosystem-less.
      const ecosystem = pkg.pkgDir === '.' ? undefined : 'composer'
      ensureBucket(pkg.pkgDir, pkg.name, pkg.version, ecosystem).files[rel] = content
    } else {
      ensureBucket('.', fallbackName, fallbackVersion).files[path] = content
    }
  }
  return modules
}

// Laravel auto-registers service providers nothing references statically. Returns
// discoverable provider files (from composer.json + installed.json
// `extra.laravel.providers`, autoload-resolved) plus bootstrap/providers.php as
// extra collection roots. Best-effort: unresolvable classes skipped.
export function loadLaravelProviderFiles(baseDir, autoload) {
  const files = new Set()
  if (existsSync(join(baseDir, 'bootstrap', 'providers.php'))) files.add('bootstrap/providers.php')
  if (!autoload) return [...files]

  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'
  const installed = readJsonIfExists(join(baseDir, vendorDir, 'composer', 'installed.json'))
  const installedPackages = Array.isArray(installed) ? installed : (installed?.packages ?? [])

  const fqcns = new Set(composerJson?.extra?.laravel?.providers ?? [])
  for (const pkg of installedPackages) {
    for (const fqcn of pkg?.extra?.laravel?.providers ?? []) fqcns.add(fqcn)
  }
  for (const fqcn of fqcns) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file) files.add(file)
  }
  return [...files]
}

// Names excluded from class-reference scanning: pseudo-types, scalar/special
// types, and keywords that can sit before `$var`/`::` or after `new` and would
// otherwise be mistaken for a class reference (`return $x`, `new class`, …).
const RESERVED = new Set([
  'self', 'static', 'parent', 'this',
  'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'void',
  'array', 'callable', 'iterable', 'object', 'mixed', 'null', 'false', 'true',
  'never', 'numeric',
  'return', 'echo', 'print', 'clone', 'yield', 'throw', 'global', 'and', 'or', 'xor',
  'as', 'else', 'elseif', 'do', 'class', 'fn', 'match', 'enddeclare', 'endforeach',
  'endif', 'endswitch', 'endwhile', 'endfor',
])

// Blank heredocs, comments AND string literals (unlike maskCommentsAndHeredocs,
// which keeps strings) so class-reference scans don't trip over text inside them.
function stripPhp(content) {
  return maskNonCode(content, false)
}

// Add the FQCN for a class reference `raw` given namespace `ns` and the `use`-alias
// map, mirroring PHP name resolution: leading `\` = fully-qualified; a first
// segment matching an alias expands through it; else relative to `ns`.
function addRef(set, raw, ns, aliasMap) {
  const n = raw.trim().replace(/^\?/u, '') // drop a nullable-type marker (`?Foo`)
  if (!n || !/^\\?[A-Za-z_][\w\\]*$/u.test(n)) return
  if (n.startsWith('\\')) {
    set.add(n.replace(/^\\+/u, ''))
    return
  }
  const first = n.split('\\')[0]
  if (!n.includes('\\')) {
    if (RESERVED.has(n.toLowerCase())) return
    if (aliasMap.has(n)) set.add(aliasMap.get(n))
    else set.add(ns ? `${ns}\\${n}` : n)
  } else if (aliasMap.has(first)) {
    set.add(`${aliasMap.get(first)}\\${n.slice(first.length + 1)}`)
  } else {
    set.add(ns ? `${ns}\\${n}` : n)
  }
}

// Parse a `use` body (between `use` and `;`) into entries, handling comma lists
// and group syntax (`Pre\{A, B as C}`). Returns `[{ name, short }]` (short = the
// alias or last segment).
function parseUseBody(body) {
  const grouped = body.match(/^([\w\\]+\\)\{([\s\S]*)\}$/u)
  const entries = grouped
    ? grouped[2].split(',').map((p) => `${grouped[1]}${p.trim()}`)
    : body.split(',')
  const out = []
  for (const entry of entries) {
    const [name, alias] = entry.trim().split(/\s+as\s+/iu).map((s) => s.trim())
    if (!name || !/^\\?[\w\\]+$/u.test(name)) continue
    const fqcn = name.replace(/^\\+/u, '')
    out.push({ name, short: alias || fqcn.split('\\').pop() })
  }
  return out
}

// Position of the first class/interface/trait/enum declaration -- the end of the
// import region (a `use` before it is an alias import; after it, an in-body trait
// use that loads the trait). `::class`/member accesses excluded via the
// lookbehind. Infinity when there's no class-like declaration.
function firstDeclPos(stripped) {
  const m = stripped.match(/(?<![:\w$\\>])\b(?:class|interface|trait|enum)\b/iu)
  return m ? m.index : Infinity
}

// Collect the FQCNs a PHP file actually depends on. A `use` import only aliases
// and loads nothing, so it is NOT a dependency; only real reference sites pull a
// file in (new/extends/implements/instanceof/catch/`Foo::bar`/attributes/type
// hints/FQNs, plus in-body `use Trait;`).
export function phpClassDependencies(content) {
  const stripped = stripPhp(content)
  const nsMatch = stripped.match(/\bnamespace\s+([\w\\]+)/u)
  const ns = nsMatch ? nsMatch[1].replace(/^\\+|\\+$/gu, '') : ''
  const set = new Set()

  // `use` before the first declaration builds the alias map; a `use` after it is
  // an in-body trait use, counted as a reference.
  const declAt = firstDeclPos(stripped)
  const aliasMap = new Map()
  const traitRefs = []
  for (const m of stripped.matchAll(/\buse\s+(?!\()(function\s+|const\s+)?([\s\S]*?);/giu)) {
    if (m[1]) continue
    const entries = parseUseBody(m[2].trim())
    if (m.index < declAt) {
      for (const e of entries) aliasMap.set(e.short, e.name.replace(/^\\+/u, ''))
    } else {
      for (const e of entries) traitRefs.push(e.name)
    }
  }

  const add = (raw) => addRef(set, raw, ns, aliasMap)
  for (const raw of traitRefs) add(raw)

  for (const m of stripped.matchAll(/(?<![\w$\\])new\s+(\\?[\w\\]+)/giu)) add(m[1])
  for (const m of stripped.matchAll(/(?<![\w$\\])instanceof\s+(\\?[\w\\]+)/giu)) add(m[1])
  for (const m of stripped.matchAll(/(?<![\w$\\])(\\?[\w\\]+)\s*::/giu)) add(m[1])
  for (const m of stripped.matchAll(/#\[\s*(\\?[\w\\]+)/giu)) add(m[1])

  // class/interface/trait/enum headers: pull names out of extends/implements.
  for (const m of stripped.matchAll(/\b(?:class|interface|trait|enum)\b[^{;]*?\{/giu)) {
    const header = m[0]
    const ext = header.match(/\bextends\s+([\w\\\s,?]+?)(?:\bimplements\b|\{)/iu)
    if (ext) for (const nm of ext[1].split(',')) add(nm)
    const impl = header.match(/\bimplements\s+([\w\\\s,?]+?)\{/iu)
    if (impl) for (const nm of impl[1].split(',')) add(nm)
  }

  // catch (A | B $e): capture the type list up to `$var`. The lazy `[^)]*?` (no
  // second whitespace quantifier) keeps matching linear on adversarial input.
  for (const m of stripped.matchAll(/\bcatch\s*\(([^)]*?)\$\w+/giu)) {
    for (const nm of m[1].split('|')) add(nm)
  }

  // parameter/property type hints: `Type $var`, incl. `?Type`, variadic, by-ref,
  // and union/intersection `A|B`/`A&B` (each member counts). Only one whitespace
  // quantifier is unbounded (inner `\s*` gated behind `[&.]`) to avoid
  // catastrophic backtracking against adversarial input.
  for (const m of stripped.matchAll(/(?<![\w$\\])([?\w\\|&]+)\s+(?:[&.]+\s*)?\$\w+/giu)) {
    for (const nm of m[1].split(/[|&]/u)) add(nm)
  }
  // return types: `): Type`, incl. nullable and union/intersection `): A|B`.
  for (const m of stripped.matchAll(/\)\s*:\s*([?\w\\|&]+)/giu)) {
    for (const nm of m[1].split(/[|&]/u)) add(nm)
  }

  return set
}

// Resolve each autoloaded class a file references to a baseDir-relative file that
// exists and is in `sources`. Best-effort: unresolvable refs skipped.
function autoloadEdges(content, autoload, baseDir, sources) {
  const edges = new Map()
  if (!autoload) return edges
  for (const fqcn of phpClassDependencies(content)) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file && (sources === null || sources.has(file))) edges.set(fqcn, file)
  }
  return edges
}

// Build `{ sources, resolutions, missing }` from already-loaded PHP sources.
// Explicit includes are strict (unresolvable -> `missing`); Composer-autoloaded
// class refs (when `autoload` is given) are best-effort and never added to
// `missing`. Fallback: a specifier matching a stored key verbatim is accepted.
export function buildPhpTree(sources, { baseDir, autoload = null } = {}) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractPhpImports(content)) {
      let resolved = resolvePhpImport(spec, path, { baseDir })
      if (resolved && !sources.has(resolved)) resolved = null
      if (!resolved && sources.has(spec)) resolved = spec
      if (resolved) {
        specMap.set(spec, resolved)
      } else {
        console.warn(`[loader.php] Missing import: ${spec} from ${path}`)
        missing.push({ spec, from: path })
      }
    }
    for (const [fqcn, file] of autoloadEdges(content, autoload, baseDir, sources)) {
      specMap.set(fqcn, file)
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem from `entries` (plus Composer `files` autoload entries),
// following resolved includes and autoloaded class refs, reading each file once.
// Same-wave files are read in parallel; the next wave depends on the previous.
export async function collectPhpFilesFromDisk(baseDir, entries, { autoload = null } = {}) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)

  const readOne = async (relPath) => {
    try {
      assertRealPathWithinBase(realBase, baseDir, relPath)
      return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
    } catch (err) {
      // ENOENT (no file) / EISDIR (specifier resolved to a directory): not a
      // loadable file -- warn and skip rather than crash (buildPhpTree surfaces
      // the unresolved edge for real includes).
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        console.warn(`[loader.php] Missing import: ${relPath}`)
        return null
      }
      throw err
    }
  }

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    // Bounded batches: a wave can be huge (a dynamic include's directory glob),
    // and an unbounded Promise.all would open every file at once and crash EMFILE.
    const reads = []
    for (let k = 0; k < toLoad.length; k += READ_CONCURRENCY) {
      // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential to cap open files
      reads.push(...(await Promise.all(toLoad.slice(k, k + READ_CONCURRENCY).map(readOne))))
    }
    const next = []
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content] = entry
      sources.set(relPath, content)
      for (const spec of extractPhpImports(content)) {
        const resolved = resolvePhpImport(spec, relPath, { baseDir })
        if (resolved) {
          if (!sources.has(resolved)) next.push(resolved)
        } else {
          console.warn(`[loader.php] Missing import: ${spec} from ${relPath}`)
        }
      }
      // Dynamic includes with a static dir prefix: the exact file is known only
      // at runtime, so bundle every `.php` file in that directory as a candidate.
      for (const dirSpec of extractPhpImportDirs(content)) {
        const dir = resolvePhpDir(dirSpec, relPath, baseDir)
        if (!dir) continue
        for (const file of listPhpFiles(baseDir, dir)) {
          if (!sources.has(file)) next.push(file)
        }
      }
      // `.php` path literals outside a require (route/config files passed to a
      // framework). Best-effort: bundle only if they resolve to an existing file.
      for (const { spec, anchor } of extractPhpPathRefs(content)) {
        const resolved = anchor === 'root'
          ? normalizeProjectRel(baseDir, spec)
          : resolvePhpImport(spec, relPath, { baseDir })
        if (resolved && isFileOnDisk(baseDir, resolved) && !sources.has(resolved)) next.push(resolved)
      }
      // Autoloaded class references (best-effort): enqueue whatever resolves.
      for (const [, file] of autoloadEdges(content, autoload, baseDir, null)) {
        if (!sources.has(file)) next.push(file)
      }
    }
    await processWave(next)
  }

  // Composer `files` autoload entries load unconditionally, so they're graph roots too.
  await processWave([...entries, ...(autoload?.files ?? [])])
  return sources
}
