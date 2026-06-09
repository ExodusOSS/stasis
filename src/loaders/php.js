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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

// --- Shared lexing helpers ---------------------------------------------------

// One alternation covering everything that is not executable code: heredocs/
// nowdocs, single/double-quoted strings, and `/* */` // and `#` comments.
// String alternatives precede the comment ones so a `//` inside a string isn't
// mistaken for a comment; `#` excludes `#[` so PHP 8 attributes survive.
const NON_CODE_RE =
  /<<<\s*(['"]?)(\w+)\1\r?\n[\s\S]*?\r?\n[ \t]*\2\b|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*/gu

// Mask everything that is not executable code so the include scan only sees
// real code: comments/heredocs become spaces, and string *interiors* are
// replaced with `x` (keeping the surrounding quotes). Length and newlines are
// preserved, so match offsets still index into the original `content`. Blanking
// string interiors -- rather than keeping or dropping whole strings -- means a
// `'require'`/`'include'` array value (common in method blacklists) has no
// keyword left to match AND can't have its greedy span swallow the real include
// that follows, while a genuine `require '...path...'` keeps its quotes so the
// real path can be recovered from `content` via the match's group offsets.
function maskForKeywords(content) {
  return content.replace(NON_CODE_RE, (seg) =>
    seg[0] === "'" || seg[0] === '"'
      ? `${seg[0]}${seg.slice(1, -1).replace(/[^\n]/gu, 'x')}${seg[seg.length - 1]}`
      : seg.replace(/[^\n]/gu, ' '),
  )
}

// --- Explicit includes -------------------------------------------------------

// Matches an include keyword followed by a single string-literal argument,
// optionally prefixed by `__DIR__ .` or `dirname(__FILE__) .`. The leading
// lookbehind keeps method calls (`$x->require(...)`), scope resolutions
// (`Foo::include(...)`) and longer identifiers from matching; the trailing
// `\b` stops `require` from matching inside `requireConfig`. The `d` flag
// exposes capture offsets so the path can be read from the unmasked source.
const PHP_INCLUDE_RE =
  /(?<![\w$>:])(?:require_once|require|include_once|include)\b\s*\(?\s*(__DIR__|dirname\s*\(\s*__FILE__\s*\))?\s*\.?\s*(['"])([^'"]+)\2/gidu

// Extract the resolvable include specifiers from PHP source. The scan runs over
// a masked copy (comments/heredocs blanked, string interiors `x`-ed out) so
// keywords inside strings or comments are never matched; the actual path is
// then read from the original `content` at the matched group's offsets. Dir-
// relative includes are normalised to a `./`-prefixed specifier (the leading
// slash after `__DIR__` is a path separator, not an absolute-path marker) so
// `resolvePhpImport` can treat them like ordinary relative imports. Bare
// specifiers are returned verbatim.
export function extractPhpImports(content) {
  const code = maskForKeywords(content)
  const specs = []
  for (const m of code.matchAll(PHP_INCLUDE_RE)) {
    const [start, end] = m.indices[3]
    const raw = content.slice(start, end).replace(/\\(['\\])/gu, '$1')
    if (m[1]) {
      const rel = raw.replace(/^\/+/u, '')
      specs.push(rel.startsWith('.') ? rel : `./${rel}`)
    } else {
      specs.push(raw)
    }
  }
  return specs
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
function normalizeProjectRel(p) {
  const rel = p.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (rel === '' || rel === '.') return ''
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
  const vendorDir = normalizeProjectRel(composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'

  const psr4 = new Map() // prefix (trailing '\') -> dirs[]
  const psr0 = new Map() // prefix -> dirs[]
  const classmap = new Map() // FQCN -> file
  const files = new Set() // baseDir-relative file
  let found = false

  const addPrefixDirs = (map, prefix, paths) => {
    const list = Array.isArray(paths) ? paths : [paths]
    const dirs = []
    for (const p of list) {
      const rel = normalizeProjectRel(String(p))
      if (rel !== null) dirs.push(rel)
    }
    const prev = map.get(prefix) ?? []
    map.set(prefix, [...prev, ...dirs])
  }

  // Root composer.json autoload (+ dev). PSR-4 keys keep their trailing '\'.
  for (const block of [composerJson?.autoload, composerJson?.['autoload-dev']]) {
    if (!block || typeof block !== 'object') continue
    found = true
    for (const [prefix, paths] of Object.entries(block['psr-4'] ?? {})) addPrefixDirs(psr4, prefix, paths)
    for (const [prefix, paths] of Object.entries(block['psr-0'] ?? {})) addPrefixDirs(psr0, prefix, paths)
    for (const f of block.files ?? []) {
      const rel = normalizeProjectRel(String(f))
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
      target.set(prefix, [...prev, ...rels])
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

  let best = null
  for (const [prefix, dirs] of autoload.psr4) {
    if (name.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, dirs }
  }
  if (best) {
    const sub = name.slice(best.prefix.length).replace(/\\/gu, '/')
    for (const dir of best.dirs) {
      const file = dir ? `${dir}/${sub}.php` : `${sub}.php`
      if (isFileOnDisk(baseDir, file)) return file
    }
  }

  let best0 = null
  for (const [prefix, dirs] of autoload.psr0) {
    if (name.startsWith(prefix) && (!best0 || prefix.length > best0.prefix.length)) best0 = { prefix, dirs }
  }
  if (best0) {
    // PSR-0: namespace separators AND underscores in the class name map to
    // directory separators; the namespace prefix is kept under the mapped dir.
    const lastNs = name.lastIndexOf('\\')
    const nsPart = lastNs === -1 ? '' : name.slice(0, lastNs).replace(/\\/gu, '/')
    const clsPart = (lastNs === -1 ? name : name.slice(lastNs + 1)).replace(/_/gu, '/')
    const sub = `${nsPart ? `${nsPart}/` : ''}${clsPart}.php`
    for (const dir of best0.dirs) {
      const file = dir ? `${dir}/${sub}` : sub
      if (isFileOnDisk(baseDir, file)) return file
    }
  }

  return null
}

// --- Class-reference extraction ----------------------------------------------

const RESERVED = new Set([
  // pseudo-types / class-context keywords
  'self', 'static', 'parent', 'this',
  // scalar + special type names
  'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'void',
  'array', 'callable', 'iterable', 'object', 'mixed', 'null', 'false', 'true',
  'never', 'numeric',
  // statement keywords that can sit immediately before a `$var` and would
  // otherwise be mistaken for a type hint (`return $x`, `echo $x`, …)
  'return', 'echo', 'print', 'clone', 'yield', 'throw', 'global', 'and', 'or', 'xor',
])

// Blank out PHP heredocs/nowdocs, comments AND string literals (collapsing each
// to a single space) so class-reference scans don't trip over namespace-like
// text, braces, or keywords inside them. Unlike `maskCommentsAndHeredocs`, this
// also removes string contents -- class references never live in strings.
function stripPhp(content) {
  return content.replace(NON_CODE_RE, ' ')
}

// Add the FQCN for a class reference written as `raw` in a file whose namespace
// is `ns`, given the file's `use`-alias map. Mirrors PHP name resolution: a
// leading `\` is fully-qualified; a first segment matching an alias expands
// through it; otherwise an unqualified/qualified name is relative to the
// current namespace.
function addRef(set, raw, ns, aliasMap) {
  const n = raw.trim()
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

  // catch (A | B $e)
  for (const m of stripped.matchAll(/\bcatch\s*\(\s*([^)$]*?)\s*\$/giu)) {
    for (const nm of m[1].split('|')) add(nm)
  }

  // parameter / property type hints: `Type $var` (also `?Type`, `Type ...$var`).
  for (const m of stripped.matchAll(/(?<![\w$\\])(\\?[\w\\]+)\s+&?\s*(?:\.\.\.)?\s*\$\w+/giu)) add(m[1])
  // return types: `): Type` / `): ?Type`.
  for (const m of stripped.matchAll(/\)\s*:\s*\??\s*(\\?[\w\\]+)/giu)) add(m[1])

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

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
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
      })
    )
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
