// PHP include-graph + Composer-autoload loader, modelled on the Solidity loader
// in this directory.
//
// Produces a `{ sources, resolutions, missing }` triple by statically scanning
// PHP source. Two dependency mechanisms are followed, neither of which executes
// any PHP:
//
//  1. Explicit includes -- `require` / `require_once` / `include` /
//     `include_once` with a string-literal path. Three argument shapes are
//     understood:
//        require_once __DIR__ . '/lib/Foo.php';        // dir-relative (modern)
//        include      dirname(__FILE__) . '/Bar.php';  // dir-relative (legacy)
//        require      'helpers.php';                    // bare / include_path
//     These are treated as *strict*: an unresolved include is reported in
//     `missing` and makes `buildPhpBundle` refuse to emit a bundle, because a
//     literal require with no target is a real, load-time error.
//
//  2. Composer autoloading -- classes pulled in lazily by the autoloader
//     `require 'vendor/autoload.php'` registers. Those class files are never
//     named in a literal `require`, so the include scan alone misses them.
//     When a `composer.json` (or generated `vendor/composer/autoload_*.php`
//     map) is present, we read the PSR-4 / PSR-0 / classmap / files autoload
//     config, extract the classes each file actually *references* (a `use`
//     statement only creates an alias and loads nothing, so it is not itself a
//     dependency -- references come from `new`/`extends`/`implements`/
//     `instanceof`/`catch`, `Foo::bar`, type hints, attributes, fully-qualified
//     names, and in-body trait `use`), resolve each to a file the same way
//     Composer's ClassLoader would, and follow it. This is
//     deliberately *best-effort*: PHP class loading is dynamic in the general
//     case (`new $class`, reflection), and most unresolved references are
//     built-in/global classes (`\Exception`, `\DateTime`) or extension classes
//     that live in no autoload map -- so an unresolved class reference is
//     silently skipped rather than treated as a missing dependency.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// Max files read concurrently per wave, to avoid EMFILE on large directory globs.
const READ_CONCURRENCY = 64

// --- Shared lexing helpers ---------------------------------------------------

// End index (exclusive) of the heredoc/nowdoc opening at `start` (`<<<`), or
// `start` itself if it isn't a valid opener. Consumes to EOF when unterminated.
// Recognises the indented closing label (PHP 7.3+) and the leading quote of
// nowdoc/quoted-heredoc labels.
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

// Single linear pass that blanks everything which is not executable PHP code:
// `//`/`#` line comments, `/* */` block comments, heredocs/nowdocs, and (unless
// `keepStrings`) string literals. Each consumed character becomes a space
// (newlines preserved), so the output is the same length as the input and byte
// offsets stay aligned. Strings are scanned in the same loop as comments, so a
// `//`/`#` inside a string is never mistaken for a comment, and `#[` (a PHP 8
// attribute) is left intact. A hand-written scanner (rather than one big regex)
// keeps this strictly linear -- immune to the catastrophic backtracking a regex
// suffers on unterminated strings/heredocs in adversarial input.
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

// Comments/heredocs blanked, string literals kept (include paths live in
// strings). See maskNonCode.
function maskCommentsAndHeredocs(content) {
  return maskNonCode(content, true)
}

// Scan code for string literals, returning each as { start, end, value } with
// PHP single-quote-style unescaping (only `\\` and the closing quote are
// escapes; every other backslash is literal -- good enough for path values).
// Knowing the real boundaries means quote pairing is never guessed: an include
// keyword sitting inside a string is recognisable, and a string can't be
// mis-paired with a quote belonging to the next concatenated string.
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

// --- Explicit includes -------------------------------------------------------

// Locates an include keyword. The leading lookbehind keeps method calls
// (`$x->require(...)`), scope resolutions (`Foo::include(...)`) and longer
// identifiers from matching; the trailing `\b` stops `require` from matching
// inside `requireConfig`. Matches inside string literals are filtered out by
// the caller using the real string spans.
const PHP_INCLUDE_KEYWORD_RE = /(?<![\w$>:])(?:require_once|require|include_once|include)\b/gidu

// Directory anchor at a position (sticky): `__DIR__` or `dirname(__FILE__)`
// (both = the file's own directory), or `dirname(__DIR__[, N])` (N parent levels
// up -- the idiom for locating bootstrap/vendor/config relative to a file).
const PHP_DIR_ANCHOR_RE = /__DIR__\b|dirname\s*\(\s*(__FILE__|__DIR__)\s*(?:,\s*(\d+)\s*)?\)/y
// Anchor starts, for scanning path literals anywhere (not just after `require`).
const PHP_DIR_ANCHOR_FIND_RE = /(?<![\w$>])(?:__DIR__\b|dirname\s*\(\s*(?:__FILE__|__DIR__))/gu

// Laravel path helpers that resolve a string argument relative to the project
// root (or a fixed subdirectory). `base_path('routes/web.php')`,
// `config_path('app.php')`, … name real PHP files that the framework require()s.
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
// above the file's directory: 0 for `__DIR__`/`dirname(__FILE__)`, N for
// `dirname(__DIR__[, N])`); otherwise null.
function matchDirAnchor(code, pos) {
  PHP_DIR_ANCHOR_RE.lastIndex = pos
  const m = PHP_DIR_ANCHOR_RE.exec(code)
  if (!m) return null
  const up = m[1] === '__DIR__' ? (m[2] ? Number(m[2]) : 1) : 0
  return { end: PHP_DIR_ANCHOR_RE.lastIndex, up }
}

// Normalise an include path to a specifier. Dir-relative paths (`__DIR__ . …`)
// get a `./` prefix and have the leading separator stripped; an empty
// dir-relative path means "the file's own directory" (`.`).
function normalizeIncludePath(raw, dirRelative) {
  if (!dirRelative) return raw
  const rel = raw.replace(/^\/+/u, '')
  if (rel === '') return '.'
  return rel.startsWith('.') ? rel : `./${rel}`
}

// Parse an include/path argument starting at `start`: an optional directory
// anchor (`__DIR__`/`dirname(...)`), then a concatenation chain of string
// literals. Consecutive *static* literals are concatenated (`__DIR__ . '/a' .
// '/b.php'` -> one static path); the chain becomes `dynamic` at the first
// variable/function/constant or `"…$interp…"`. Parent levels from the anchor
// (`dirname(__DIR__, N)`) are folded in as leading `/..`. Returns null when
// there's neither an anchor nor any static string. The accumulated `prefix` is
// the static path up to the first dynamic piece.
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
    if (code[i] !== '.') return null // anchor not concatenated with a path
    i = skipWs(code, i + 1)
  }

  let prefix = '/..'.repeat(up)
  let dynamic = false
  let sawStatic = false
  for (;;) {
    const lit = stringAt(i)
    if (!lit) { dynamic = true; break } // variable/constant/function -> dynamic
    const interp = lit.quote === '"' ? lit.value.search(PHP_INTERPOLATION_RE) : -1
    if (interp >= 0) { prefix += lit.value.slice(0, interp); sawStatic = true; dynamic = true; break }
    prefix += lit.value
    sawStatic = true
    i = skipWs(code, lit.end)
    if (code[i] === '.') { i = skipWs(code, i + 1); continue } // concatenated -> keep going
    break
  }
  if (!dirRelative && !sawStatic) return null
  return { dirRelative, up, prefix, dynamic, sawStatic }
}

// Scan PHP `require`/`include` statements, classifying each as a concrete file
// or -- when the path is built dynamically but has a static directory prefix --
// a directory whose `.php` files should all be bundled (any could be the runtime
// target, e.g. Laravel's `require __DIR__ . "/.../components/$view.php"`). Works
// on comment/heredoc-masked code and real string-literal boundaries (never regex
// quote-pairing); keyword matches inside a string are skipped.
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
    // Dynamic path: fall back to the static directory prefix (up to the last
    // separator). A bare path with no separator has no usable directory.
    if (!dirRelative && !prefix.includes('/')) continue
    const lastSlash = prefix.lastIndexOf('/')
    let dir = lastSlash >= 0 ? prefix.slice(0, lastSlash) : ''
    if (dir === '' && up > 0) dir = '/..'.repeat(up) // `dirname(__DIR__) . $x` -> parent dir
    out.push({ kind: 'dir', spec: normalizeIncludePath(dir, dirRelative) })
  }
  return out
}

// Dir-anchored static `.php` path literals anywhere in the file (not only after
// `require`/`include`). Frameworks pass file paths as arguments for code that
// `require`s them internally -- e.g. Laravel's `->withRouting(web: __DIR__ .
// '/../routes/web.php', …)`. These are best-effort: bundled only if they resolve
// to a file that exists (see collectPhpFilesFromDisk), so a path that's just a
// string and never loaded does no harm.
function scanPathLiterals(content) {
  const code = maskCommentsAndHeredocs(content)
  const strings = stringLiterals(code)
  const inString = (pos) => strings.some(({ start, end }) => pos > start && pos < end)
  const stringAt = (pos) => strings.find(({ start }) => start === pos)

  const out = []
  // Dir-anchored literals: `__DIR__ . '/x.php'` (anchor: resolve against the file).
  for (const m of code.matchAll(PHP_DIR_ANCHOR_FIND_RE)) {
    if (inString(m.index)) continue
    const arg = parseArgPath(code, m.index, strings)
    if (!arg || arg.dynamic || !arg.sawStatic || !arg.dirRelative) continue
    const spec = normalizeIncludePath(arg.prefix, true)
    if (spec.endsWith('.php')) out.push({ spec, anchor: 'file' })
  }
  // Laravel path helpers: `base_path('routes/web.php')` etc. (anchor: resolve
  // against the project root, with the helper's fixed subdirectory prefixed).
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

// Directory specifiers for dynamic includes whose path has a static directory
// prefix; every `.php` file directly in such a directory is a candidate target.
export function extractPhpImportDirs(content) {
  return scanIncludes(content).filter((e) => e.kind === 'dir').map((e) => e.spec)
}

// `.php` path literals used outside a `require`/`include` -- dir-anchored
// (`__DIR__ . '/x.php'`, `anchor: 'file'`) or via a Laravel path helper
// (`base_path('routes/x.php')`, `anchor: 'root'`). Frameworks pass these to code
// that require()s them. De-duplicated; best-effort (bundled only if they exist).
export function extractPhpPathRefs(content) {
  const seen = new Set()
  return scanPathLiterals(content).filter(({ spec, anchor }) => {
    const key = `${anchor}:${spec}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Apply `segments` (already split on '/') on top of `fromFile`'s directory,
// collapsing '.'/'' and resolving '..'. Returns a baseDir-relative POSIX path,
// or null when traversal escapes above the project root (rather than clamping).
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

// Resolve a directory specifier (from a dynamic include's static prefix) to an
// existing baseDir-relative directory, or null. `./`/`../` resolve against the
// including file; a bare spec tries file-relative then project-relative.
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

// The `.php` files directly in `dir` (baseDir-relative), as baseDir-relative
// paths. Non-recursive: a dynamic include like `.../$view.php` targets a file in
// the directory itself, and recursing could pull in an unbounded subtree.
function listPhpFiles(baseDir, dir) {
  try {
    return readdirSync(join(baseDir, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.php'))
      .map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
  } catch {
    return []
  }
}

// Resolve a PHP include specifier to a baseDir-relative POSIX path.
//   - `./x` / `../x` resolve against the including file's directory, exactly
//     like Solidity relative imports; escaping the root returns null.
//   - a bare specifier (`lib/Foo.php`, `helpers.php`) is ambiguous under PHP's
//     include_path, so it is disambiguated by what's actually on disk: a file
//     next to the including file wins, otherwise a project-root-relative match.
//     Both require `baseDir`; absolute specifiers are rejected outright.
// Returns null when no strategy resolves the include.
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

// --- Composer autoload config ------------------------------------------------

// Normalise an autoload directory/file path that is relative to the project
// root to a POSIX baseDir-relative path, or null when it escapes the root.
// Resolves against baseDir and re-derives the relative path so that *interior*
// `..` segments (e.g. `src/foo/../../../secret.php`) that escape the root are
// rejected -- a leading-`..`/absolute check alone would let those through and
// read files outside the project into the bundle.
function normalizeProjectRel(baseDir, p) {
  const rel = relative(baseDir, resolve(baseDir, p.replace(/\\/gu, '/'))).split(/[\\/]/u).join('/')
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

// Evaluate a generated-autoload path expression like `$baseDir . '/src'` or
// `$vendorDir . '/a/b'` or a bare quoted string, given the absolute values of
// the `$baseDir` / `$vendorDir` variables. Returns the absolute path string,
// or null when the expression contains anything we don't understand (a
// function call, an unknown variable) so we skip it rather than guess.
function evalPathExpr(expr, vars) {
  const s = expr.trim().replace(/,+$/u, '').trim()
  let out = ''
  let consumed = 0
  const re = /\$(\w+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\.|\s+/gy
  let m
  while ((m = re.exec(s)) !== null) {
    // A sticky regex resets lastIndex to 0 once exec() finally returns null,
    // so track how far we actually parsed instead of reading lastIndex after
    // the loop.
    consumed = re.lastIndex
    if (m[1] !== undefined) {
      if (vars[m[1]] === undefined) return null
      out += vars[m[1]]
    } else if (m[2] !== undefined) {
      out += m[2].replace(/\\(['\\])/gu, '$1')
    } else if (m[3] !== undefined) {
      out += m[3]
    }
    // '.' (concatenation) and whitespace contribute nothing
  }
  if (consumed !== s.length) return null
  return out
}

// Parse one of Composer's generated `vendor/composer/autoload_*.php` maps.
// They are `@generated`, one entry per line:
//   'Prefix\\' => array($baseDir . '/src'),        // multi=true  (psr-4/psr-0)
//   'Fully\\Qualified\\Class' => $baseDir . '/X.php' // multi=false (classmap/files)
// Returns a Map of key -> (dirs[] when multi, file when not). PHP single-quote
// escapes (`\\`, `\'`) in keys are unfolded to real characters.
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

// Build the autoload resolution config for a project rooted at `baseDir`.
// Merges, when present:
//   - the root composer.json `autoload` + `autoload-dev` (psr-4/psr-0/files;
//     paths are relative to the project root)
//   - the generated `vendor/composer/autoload_{psr4,namespaces,classmap,files}.php`
//     maps (cover the root AND every installed dependency; the authoritative
//     source once `composer install`/`dump-autoload` has run)
// All directory/file paths are normalised to POSIX baseDir-relative; anything
// escaping the root is dropped (it can't be bundled). Returns
// `{ psr4, psr0, classmap, files }` or null when no Composer config is found.
export function loadComposerAutoload(baseDir) {
  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'

  const psr4 = new Map() // prefix (trailing '\') -> dirs[]
  const psr0 = new Map() // prefix -> dirs[]
  const classmap = new Map() // FQCN -> file
  const files = new Set() // baseDir-relative file
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

// Resolve a fully-qualified class name to a baseDir-relative file via the
// autoload config, mirroring Composer's ClassLoader lookup order: exact
// classmap hit, then longest-matching PSR-4 prefix, then longest-matching
// PSR-0 prefix. Only returns a path that actually exists on disk (so a PSR-4
// prefix match for a class whose file is absent doesn't get bundled as a hole).
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

// All [prefix, dirs] entries of a PSR map whose prefix is a prefix of `name`,
// longest first -- so resolution prefers the most specific mapping but falls
// back to shorter ones (and the `""` fallback) when a file isn't present.
function matchingPrefixes(map, name) {
  return [...map].filter(([prefix]) => name.startsWith(prefix)).toSorted((a, b) => b[0].length - a[0].length)
}

// --- Per-package bucketing ---------------------------------------------------

// Read installed-package versions from `vendor/composer/installed.json` -- the
// authoritative source, since a package's own composer.json usually omits
// `version` (Composer derives it at install time). Handles both the Composer 2
// shape ({ packages: [...] }) and the Composer 1 flat array. Returns maps from
// install dir (baseDir-relative) and from package name to version.
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

// Walk up from a bundled file to the nearest composer.json with a `name`,
// returning { pkgDir, name, version } (pkgDir baseDir-relative, "." for the
// root package). Version comes from installed.json (by dir, then by name),
// falling back to composer.json's own `version`, then `fallbackVersion`.
// Returns null when no named composer.json sits at or above the file.
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

// Group bundled PHP sources into per-package buckets keyed by the directory of
// the nearest composer.json: vendor dependencies land in their own
// `vendor/<vendor>/<pkg>` bucket (name + version from composer.json /
// installed.json), workspace files in the root package's "." bucket. Files with
// no named composer.json above them (e.g. Composer's generated autoloader glue,
// or a project without a composer.json) fall back to "." with the given
// placeholder identity. Returns a Map<dir, { name, version, files }>.
export function bucketizePhpSources(baseDir, sources, fallbackName, fallbackVersion) {
  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'
  const installed = loadInstalledVersions(baseDir, vendorDir)

  const modules = new Map()
  const ensureBucket = (dir, name, version, origin) => {
    if (!modules.has(dir)) {
      modules.set(dir, origin === undefined
        ? { name, version, files: Object.create(null) }
        : { name, version, origin, files: Object.create(null) })
    }
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const pkg = findComposerPackage(baseDir, path, installed, fallbackVersion)
    if (pkg) {
      const rel = pkg.pkgDir === '.' ? path : path.slice(pkg.pkgDir.length + 1)
      // Anything below the root composer package is an installed Composer
      // dependency (vendor/<vendor>/<pkg>); tag it `composer`. The root "."
      // bucket is the workspace's own code and stays origin-less.
      const origin = pkg.pkgDir === '.' ? undefined : 'composer'
      ensureBucket(pkg.pkgDir, pkg.name, pkg.version, origin).files[rel] = content
    } else {
      ensureBucket('.', fallbackName, fallbackVersion).files[path] = content
    }
  }
  return modules
}

// Laravel auto-registers service providers that nothing references statically:
// vendor packages declare them under `extra.laravel.providers` (aggregated into
// vendor/composer/installed.json), and the app lists its own in
// bootstrap/providers.php (Laravel 11) or composer.json's `extra.laravel`. Those
// providers do real work in boot() -- publishing config, loading routes/views,
// merging config -- referencing files (`config_path(...)`, `__DIR__ . '/...'`)
// that would otherwise never be reached. Returns the baseDir-relative files of
// every discoverable provider class (resolved via the autoload maps) plus
// bootstrap/providers.php when present, to seed as extra collection roots.
// Best-effort: unresolvable classes (and a missing autoload config) are skipped.
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

// --- Class-reference extraction ----------------------------------------------

const RESERVED = new Set([
  // pseudo-types / class-context keywords
  'self', 'static', 'parent', 'this',
  // scalar + special type names
  'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'void',
  'array', 'callable', 'iterable', 'object', 'mixed', 'null', 'false', 'true',
  'never', 'numeric',
  // statement / expression keywords that can sit before a `$var`, after `new`,
  // or before `::` and would otherwise be mistaken for a class reference
  // (`return $x`, `echo $x`, `foreach (… as $x)`, `new class`, `match ($x)`, …)
  'return', 'echo', 'print', 'clone', 'yield', 'throw', 'global', 'and', 'or', 'xor',
  'as', 'else', 'elseif', 'do', 'class', 'fn', 'match', 'enddeclare', 'endforeach',
  'endif', 'endswitch', 'endwhile', 'endfor',
])

// Blank out PHP heredocs/nowdocs, comments AND string literals so class-
// reference scans don't trip over namespace-like text, braces, or keywords
// inside them. Unlike `maskCommentsAndHeredocs`, this also removes string
// contents -- class references never live in strings.
function stripPhp(content) {
  return maskNonCode(content, false)
}

// Add the FQCN for a class reference written as `raw` in a file whose namespace
// is `ns`, given the file's `use`-alias map. Mirrors PHP name resolution: a
// leading `\` is fully-qualified; a first segment matching an alias expands
// through it; otherwise an unqualified/qualified name is relative to the
// current namespace.
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

// Parse the body of a `use` statement (everything between `use` and `;`,
// already trimmed) into its entries. Handles comma lists (`A, B as C`) and
// group syntax (`Pre\{A, B as C}`). Returns `[{ name, short }]` where `name` is
// the symbol as written (sans alias) and `short` is the alias or last segment.
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

// Position of the first class/interface/trait/enum declaration keyword. PHP
// requires `use` *imports* to appear before any declaration, so this marks the
// end of the import region: a `use` before it is an import (an alias that loads
// nothing), while a `use` after it is a trait use inside a class body (which
// does load the trait). `::class` and member accesses are excluded via the
// lookbehind. Returns Infinity for a file with no class-like declaration.
// Cheaper and more robust than brace-matching -- no nested-brace bookkeeping,
// and heredocs are already stripped out.
function firstDeclPos(stripped) {
  const m = stripped.match(/(?<![:\w$\\>])\b(?:class|interface|trait|enum)\b/iu)
  return m ? m.index : Infinity
}

// Collect the set of fully-qualified class names a PHP file actually depends
// on. A `use` import only creates an alias and loads nothing, so it is NOT a
// dependency on its own -- only classes referenced at a real site pull a file
// in: new / extends / implements / instanceof / catch / `Foo::bar` / attributes
// / parameter+return type hints / fully-qualified names, plus in-body
// `use Trait;` (which does load the trait).
export function phpClassDependencies(content) {
  const stripped = stripPhp(content)
  const nsMatch = stripped.match(/\bnamespace\s+([\w\\]+)/u)
  const ns = nsMatch ? nsMatch[1].replace(/^\\+|\\+$/gu, '') : ''
  const set = new Set()

  // Classify `use` statements: those before the first declaration are imports
  // (alias map only); those after are trait uses inside a class body, which
  // count as references.
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

  // catch (A | B $e): capture the type list up to the `$var`. A single lazy
  // `[^)]*?` (no second whitespace quantifier) keeps this linear even when a
  // long blanked run sits inside the parens with no `$var`.
  for (const m of stripped.matchAll(/\bcatch\s*\(([^)]*?)\$\w+/giu)) {
    for (const nm of m[1].split('|')) add(nm)
  }

  // parameter / property type hints: `Type $var`, incl. nullable `?Type`,
  // variadic `Type ...$var`, by-ref `Type &$var`, and union/intersection
  // `A|B`/`A&B $var` (each member counts). The separator before `$var` is one
  // `\s+` plus an optional `&`/`...` run -- written so only a single whitespace
  // quantifier is unbounded (the inner `\s*` is gated behind a required `[&.]`),
  // which avoids catastrophic backtracking when a token is followed by a long
  // blanked run (comment/heredoc/string) with no `$var` after it.
  for (const m of stripped.matchAll(/(?<![\w$\\])([?\w\\|&]+)\s+(?:[&.]+\s*)?\$\w+/giu)) {
    for (const nm of m[1].split(/[|&]/u)) add(nm)
  }
  // return types: `): Type`, incl. nullable and union/intersection `): A|B`.
  for (const m of stripped.matchAll(/\)\s*:\s*([?\w\\|&]+)/giu)) {
    for (const nm of m[1].split(/[|&]/u)) add(nm)
  }

  return set
}

// --- Tree / disk collection --------------------------------------------------

// Resolve every autoloaded class a file references to a baseDir-relative file
// path that exists on disk and is already part of `sources`. Best-effort:
// unresolvable references (builtins, extensions, dynamic) are skipped.
function autoloadEdges(content, autoload, baseDir, sources) {
  const edges = new Map()
  if (!autoload) return edges
  for (const fqcn of phpClassDependencies(content)) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file && (sources === null || sources.has(file))) edges.set(fqcn, file)
  }
  return edges
}

// Build the { sources, resolutions, missing } triple from a Map of already-
// loaded PHP sources. Explicit includes are strict (an unresolvable one is
// recorded in `missing`); Composer-autoloaded class references, when an
// `autoload` config is supplied, are recorded best-effort and never added to
// `missing`. As a final include fallback, a specifier that matches a stored
// key verbatim is accepted.
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

// Walk the filesystem starting from `entries` (plus any Composer `files`
// autoload entries), following resolved includes and autoloaded class
// references, reading each file exactly once. Files in the same wave are read
// in parallel; the next wave depends on what the previous one referenced.
export async function collectPhpFilesFromDisk(baseDir, entries, { autoload = null } = {}) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)

  const readOne = async (relPath) => {
    try {
      assertRealPathWithinBase(realBase, baseDir, relPath)
      return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
    } catch (err) {
      // ENOENT: target doesn't exist. EISDIR: a specifier resolved to a
      // directory (e.g. an extensionless `require __DIR__ . '/dir'`). Both
      // mean "not a loadable file" -- warn and skip rather than crash; the
      // unresolved edge is surfaced later by buildPhpTree for real includes.
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
    // Read in bounded batches: a single wave can be huge (e.g. a dynamic
    // include's directory glob over thousands of files), and an unbounded
    // Promise.all would open every file at once and crash with EMFILE.
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
      // Dynamic includes with a static directory prefix (e.g.
      // `require __DIR__ . "/views/$view.php"`): the exact file is only known at
      // runtime, so bundle every `.php` file in that directory as a candidate.
      for (const dirSpec of extractPhpImportDirs(content)) {
        const dir = resolvePhpDir(dirSpec, relPath, baseDir)
        if (!dir) continue
        for (const file of listPhpFiles(baseDir, dir)) {
          if (!sources.has(file)) next.push(file)
        }
      }
      // `.php` path literals not in a require (e.g. route/config files passed
      // to a framework). Dir-anchored refs resolve against the file; Laravel
      // helper refs (`base_path(...)`) against the project root. Best-effort:
      // bundle only if they resolve to a file that exists.
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

  // `files` autoload entries are required unconditionally by Composer, so they
  // are roots of the graph alongside the caller's entries.
  await processWave([...entries, ...(autoload?.files ?? [])])
  return sources
}
