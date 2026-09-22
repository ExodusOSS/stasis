// Rust loader: `{ sources, resolutions, missing }` from a crate's files.
//
// Reachability follows what rustc follows. A `mod foo;` declaration (incl. `#[path = …]` and
// `#[cfg_attr(…, path = …)]`) pulls a module file in, and a reference to a crate whose source is
// in-tree -- the package's own lib target, a Cargo `path` dependency, or a `cargo vendor`ed crate
// -- pulls that crate's root in. `crate::` / `self::` / `super::` / relative paths resolve against
// the per-crate module tree for the import graph but never widen the walk: a `use` can't add a
// file to a crate, only `mod` can. Registry dependencies that aren't vendored live outside the
// bundle root and are dropped.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// `cargo vendor` copies external crates in-tree under this dir.
const VENDOR_DIR = 'vendor'

// A path whose lead is one of these never names an external crate.
const NON_CRATE_LEADS = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc'])

// Files rustc treats as crate roots by name; every entry is one by role (see crateRoots).
const ROOT_NAMES = new Set(['main.rs', 'lib.rs'])

// Cap on `mod`-chain depth when building a module tree: with the `seen` set it bounds cycles
// and the O(depth²) growth of joined module-path strings on absurd input.
const MAX_MODULE_DEPTH = 1000

const baseName = (p) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)
const isNamedRoot = (p) => ROOT_NAMES.has(baseName(p))
const isWordChar = (ch) => ch !== undefined && /\w/u.test(ch)

// --- Lexing -----------------------------------------------------------------------------

// Single left-to-right pass over Rust source producing two same-length views (newlines kept, so
// lines and offsets stay aligned with the input): `code` blanks comments only; `masked` blanks
// comments AND the contents of string/char literals. Block comments nest; a `//` inside a string
// is not a comment and a `/*` inside a `//` comment opens nothing -- rules a pair of regexes gets
// wrong in both directions (a commented-out `mod` taken for a real one, or real ones swallowed).
export function lexRust(content) {
  const n = content.length
  // Both views start as the source (split by UTF-16 unit, so indexes match `content[i]`) and get blanked in place.
  const code = content.split('')
  const masked = content.split('')
  const blankBoth = (i) => {
    const c = content[i] === '\n' ? '\n' : ' '
    code[i] = c
    masked[i] = c
  }
  const blankMasked = (i) => {
    masked[i] = content[i] === '\n' ? '\n' : ' '
  }

  let i = 0
  while (i < n) {
    const ch = content[i]
    if (ch === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') blankBoth(i++)
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      let depth = 0
      do {
        if (content[i] === '/' && content[i + 1] === '*') {
          depth++
          blankBoth(i++)
          blankBoth(i++)
        } else if (content[i] === '*' && content[i + 1] === '/') {
          depth--
          blankBoth(i++)
          blankBoth(i++)
        } else {
          blankBoth(i++)
        }
      } while (i < n && depth > 0)
      continue
    }
    const lit = stringStart(content, i)
    if (lit) {
      i = lit.open + 1 // past the `b`/`c`/`r#` prefix and the opening quote
      if (lit.raw === null) {
        while (i < n && content[i] !== '"') {
          if (content[i] === '\\' && i + 1 < n) blankMasked(i++)
          blankMasked(i++)
        }
        i++ // closing quote
      } else {
        const close = `"${'#'.repeat(lit.raw)}`
        let end = content.indexOf(close, i)
        if (end === -1) end = n
        while (i < end) blankMasked(i++)
        i += close.length
      }
      continue
    }
    if (ch === "'") {
      const end = charLiteralEnd(content, i)
      if (end !== -1) {
        i++
        while (i < end) blankMasked(i++)
        i++
        continue
      }
    }
    i++
  }
  return { code: code.join(''), masked: masked.join('') }
}

// If a string literal starts at `i` -- counting a `b`/`c` byte/C-string prefix and the raw
// marker `r`/`r#…#` -- return `{ open, raw }` where `open` indexes the opening quote and `raw` is
// a raw string's `#` count (null for a plain one); else null. A prefix must not be the tail of
// an identifier (`bar"` is not a prefix).
function stringStart(content, i) {
  if (content[i] === '"') return { open: i, raw: null }
  let j = i
  if ((content[j] === 'b' || content[j] === 'c') && (content[j + 1] === '"' || content[j + 1] === 'r')) j++
  if (content[j] !== 'r' && content[j] !== '"') return null
  if (isWordChar(content[i - 1])) return null
  if (content[j] === '"') return { open: j, raw: null }
  let k = j + 1
  while (content[k] === '#') k++
  return content[k] === '"' ? { open: k, raw: k - j - 1 } : null
}

// Index of the quote closing a char literal opening at `i` (`'x'`, `'\n'`, `'\u{1F600}'`), or -1
// when the quote starts a lifetime/label (`'a`), which has no closing quote.
function charLiteralEnd(content, i) {
  if (content[i + 1] === '\\') {
    let j = i + 2
    if (content[j] === 'u' && content[j + 1] === '{') {
      const close = content.indexOf('}', j)
      if (close === -1 || close - j > 10) return -1
      j = close + 1
    } else {
      j += 1
    }
    return content[j] === "'" ? j : -1
  }
  if (content[i + 1] === undefined || content[i + 1] === "'") return -1
  if (content[i + 2] === "'") return i + 2
  // An astral char is two UTF-16 units.
  const cp = content.codePointAt(i + 1)
  return cp > 0xff_ff && content[i + 3] === "'" ? i + 3 : -1
}

// --- Item scanning ----------------------------------------------------------------------

const WORD_RE = /[A-Za-z_]\w*/uy
const EXTERN_CRATE_RE = /extern\s+crate\s+(?:r#)?(\w+)(?:\s+as\s+(?:r#)?\w+)?\s*;/uy
// Expression-position paths anchored on a keyword, and any `lead::…` path whose lead is lowercase
// (skipping `Type::assoc` associated-item paths). Both run over the masked view, so string
// contents can't fake one.
const KEYWORD_PATH_RE = /\b(?:crate|self|super)(?:::\w+)+/gu
const LEAD_PATH_RE = /\b([a-z_]\w*)(?:::\w+)+/gu
const ATTR_PATH_RE = /^\s*path\s*=\s*"([^"]*)"\s*$/u

// Index of the bracket closing the one opened at `open`, or the last index when unbalanced.
function matchClose(text, open) {
  const close = { '[': ']', '(': ')', '{': '}' }[text[open]]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return text.length - 1
}

// Split on commas outside parentheses/brackets/strings.
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

// One outer attribute's text (inside `#[…]`) → whether it gates the item on a config that may be
// off, and the module file paths it names: `#[path = "…"]` outright (cfg null), or each
// `#[cfg_attr(<pred>, path = "…")]` under its predicate.
function parseAttr(text) {
  const path = ATTR_PATH_RE.exec(text)
  if (path) return { conditional: false, paths: [{ path: path[1], cfg: null }] }
  const cfgAttr = /^\s*cfg_attr\s*\(([\s\S]*)\)\s*$/u.exec(text)
  if (cfgAttr) {
    const parts = splitTopLevel(cfgAttr[1])
    const pred = (parts.shift() ?? '').replaceAll(/\s+/gu, ' ').trim()
    const paths = []
    for (const part of parts) {
      const m = ATTR_PATH_RE.exec(part)
      if (m) paths.push({ path: m[1], cfg: pred })
    }
    return { conditional: true, paths }
  }
  return { conditional: /^\s*cfg\s*\(/u.test(text), paths: [] }
}

// Flatten a `use` tree body (the text between `use` and `;`) into the paths it imports, as
// `{ segments, absolute, spec }`: `a::{b::C, d::{E, F}}` → `a::b::C`, `a::d::E`, `a::d::F`; a
// glob or `self` inside a group names the group's own module; `as` renames are dropped; a leading
// `::` marks the path absolute (an external crate). `spec` is the flat path as it would be written.
export function parseUseTree(body) {
  const tokens = [...body.matchAll(/::|[{},*]|\bas\b|(?:r#)?\w+/gu)].map((m) => m[0])
  const out = []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isIdent = (tok) => tok !== undefined && tok !== 'as' && /^(?:r#)?\w+$/u.test(tok)
  const emit = (segments, absolute) => {
    if (segments.length > 0) out.push({ segments, absolute, spec: `${absolute ? '::' : ''}${segments.join('::')}` })
  }
  const parse = (prefix, absolute) => {
    let tok = peek()
    if (tok === '::' && prefix.length === 0) {
      next()
      absolute = true
      tok = peek()
    }
    if (tok === '{') {
      next()
      while (pos < tokens.length && peek() !== '}') {
        const before = pos
        parse(prefix, absolute)
        if (peek() === ',') next()
        if (pos === before) next() // malformed: make progress
      }
      next()
      return
    }
    if (tok === '*') {
      next()
      emit(prefix, absolute)
      return
    }
    if (!isIdent(tok)) return
    const segments = [...prefix]
    for (;;) {
      tok = next()
      if (!isIdent(tok)) return
      segments.push(tok.replace(/^r#/u, ''))
      if (peek() !== '::') break
      next()
      if (peek() === '{' || peek() === '*') {
        parse(segments, absolute)
        return
      }
    }
    if (peek() === 'as') {
      next()
      next()
    }
    // `use a::{self, b}`: `self` names the group's own module.
    if (prefix.length > 0 && segments.length === prefix.length + 1 && segments.at(-1) === 'self') segments.pop()
    emit(segments, absolute)
  }
  parse([], false)
  return out
}

// Statically scan one file's items. Returns
//   mods:         external `mod` declarations `{ name, inlinePath, conditional, paths }` -- `inlinePath`
//                 is the chain of inline `mod x { … }` blocks it sits in, `conditional` marks a
//                 `#[cfg(…)]`/`#[cfg_attr(…)]`-gated one (or an inline ancestor so gated), `paths`
//                 the explicit file paths its attributes name (see parseAttr);
//   refs:         path references `{ spec, segments, absolute, inlinePath }` -- flattened `use` trees
//                 plus expression-position `crate::`/`self::`/`super::`/`lead::…` paths;
//   externCrates: `extern crate x [as y];` names, with their inlinePath.
export function scanRustItems(content) {
  const { code, masked } = lexRust(content)
  const n = masked.length
  const mods = []
  const uses = []
  const useSpans = [] // [start, end) of each `use` item's body, parsed as a tree below
  const externCrates = []
  const spans = [] // closed inline module blocks: { start, end, path }
  const stack = [] // open inline modules: { name, depth, conditional, start }
  let depth = 0
  let pending = [] // outer attributes waiting for their item

  const inlinePath = () => stack.map((s) => s.name)
  const closeTo = (targetDepth, at) => {
    while (stack.length > 0 && stack.at(-1).depth > targetDepth) {
      const top = stack.pop()
      spans.push({ start: top.start, end: at, path: [...inlinePath(), top.name] })
    }
  }
  const readWord = (at) => {
    WORD_RE.lastIndex = at
    const m = WORD_RE.exec(masked)
    return m ? m[0] : null
  }
  const skipWs = (at) => {
    while (at < n && /\s/u.test(masked[at])) at++
    return at
  }

  let i = 0
  while (i < n) {
    const ch = masked[i]
    if (/\s/u.test(ch)) {
      i++
      continue
    }
    if (ch === '#' && (masked[i + 1] === '[' || (masked[i + 1] === '!' && masked[i + 2] === '['))) {
      const outer = masked[i + 1] === '['
      const open = outer ? i + 1 : i + 2
      const close = matchClose(masked, open)
      // An inner `#![…]` attribute applies to the enclosing module, not to the next item.
      if (outer) pending.push(code.slice(open + 1, close))
      else pending = []
      i = close + 1
      continue
    }
    if (ch === '{') {
      depth++
      pending = []
      i++
      continue
    }
    if (ch === '}') {
      depth--
      closeTo(depth, i)
      pending = []
      i++
      continue
    }
    const word = readWord(i)
    if (word === null) {
      pending = []
      i++
      continue
    }
    if (word === 'pub') {
      // Visibility sits between an item's attributes and its keyword; `pub(crate)` etc. included.
      i = skipWs(i + 3)
      if (masked[i] === '(') i = matchClose(masked, i) + 1
      continue
    }
    if (word === 'mod') {
      let j = skipWs(i + 3)
      if (masked.startsWith('r#', j)) j += 2
      const name = readWord(j)
      if (name === null) {
        pending = []
        i = j
        continue
      }
      const k = skipWs(j + name.length)
      const attrs = pending.map(parseAttr)
      pending = []
      const conditional = attrs.some((a) => a.conditional) || stack.some((s) => s.conditional)
      if (masked[k] === ';') {
        mods.push({ name, inlinePath: inlinePath(), conditional, paths: attrs.flatMap((a) => a.paths) })
        i = k + 1
        continue
      }
      if (masked[k] === '{') {
        depth++
        stack.push({ name, depth, conditional, start: k + 1 })
        i = k + 1
        continue
      }
      i = k
      continue
    }
    if (word === 'use') {
      const end = masked.indexOf(';', i + 3)
      const stop = end === -1 ? n : end
      const ip = inlinePath()
      for (const p of parseUseTree(code.slice(i + 3, stop))) uses.push({ ...p, inlinePath: ip })
      useSpans.push([i, stop])
      pending = []
      i = stop + 1
      continue
    }
    if (word === 'extern') {
      EXTERN_CRATE_RE.lastIndex = i
      const m = EXTERN_CRATE_RE.exec(masked)
      pending = []
      if (m) {
        externCrates.push({ name: m[1], inlinePath: inlinePath() })
        i = EXTERN_CRATE_RE.lastIndex
        continue
      }
      i += word.length
      continue
    }
    pending = []
    i += word.length
  }
  closeTo(0, n)

  // Innermost inline module enclosing an offset (spans nest, so the longest path wins).
  const inlineAt = (offset) => {
    let best = null
    for (const s of spans) {
      if (s.start <= offset && offset < s.end && (best === null || s.path.length > best.path.length)) best = s
    }
    return best ? best.path : []
  }
  const refs = new Map()
  // `fromUse` marks a path written in a `use` item -- the reliable signal that its lead names a
  // crate (an expression path's lead is as likely a module or an imported item).
  const addRef = (spec, segments, absolute, ip, fromUse) => {
    const key = `${ip.join('::')}\0${spec}`
    if (!refs.has(key)) refs.set(key, { spec, segments, absolute, inlinePath: ip, fromUse })
  }
  for (const u of uses) addRef(u.spec, u.segments, u.absolute, u.inlinePath, true)
  // Expression-position paths: scan everything outside `use` items (the tree parser owns those;
  // a regex over `use syn::{parse::Parse}` would take `parse::Parse` for a local module path).
  let exprs = masked
  if (useSpans.length > 0) {
    const chars = masked.split('')
    for (const [start, end] of useSpans) chars.fill(' ', start, end)
    exprs = chars.join('')
  }
  for (const m of exprs.matchAll(KEYWORD_PATH_RE)) addRef(m[0], m[0].split('::'), false, inlineAt(m.index), false)
  for (const m of exprs.matchAll(LEAD_PATH_RE)) {
    if (!NON_CRATE_LEADS.has(m[1])) addRef(m[0], m[0].split('::'), false, inlineAt(m.index), false)
  }
  return { mods, refs: [...refs.values()], externCrates }
}

// --- Module files -----------------------------------------------------------------------

// Directory holding this file's submodules, per Rust's path rules: siblings for crate roots
// and mod.rs, else under a `<stem>/` subdir. `root` marks a crate root by role (an entry such as
// `src/bin/tool.rs` or `tests/it.rs`) rather than by name.
export function getModuleDir(filePath, { root = false } = {}) {
  const lastSlash = filePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
  if (root || ROOT_NAMES.has(name) || name === 'mod.rs') return dir
  const stem = name.replace(/\.rs$/u, '')
  return dir ? `${dir}/${stem}` : stem
}

function firstFile(candidates, { knownSources, baseDir }) {
  if (knownSources) return candidates.find((c) => knownSources.has(c)) ?? null
  if (baseDir) {
    for (const c of candidates) {
      try {
        if (statSync(join(baseDir, c)).isFile()) return c
      } catch { /* missing -- try the next candidate */ }
    }
  }
  return null
}

// Resolve `mod <name>;` declared in `fromFile` (inside the inline modules `inlinePath`) to its
// file, trying `<dir>/<name>.rs` then `<dir>/<name>/mod.rs`. `roots` are the files walked as crate
// roots (the entries): their submodules are siblings. An entry not named main.rs/lib.rs also
// gets the non-root `<stem>/` rule as a fallback, so a glob-listed module file still resolves.
export function resolveModPath(modName, fromFile, { knownSources, baseDir, roots, inlinePath = [] } = {}) {
  const isRoot = roots?.has(fromFile) === true
  const dirs = [getModuleDir(fromFile, { root: isRoot })]
  if (isRoot && !isNamedRoot(fromFile) && baseName(fromFile) !== 'mod.rs') dirs.push(getModuleDir(fromFile))
  for (const dir of new Set(dirs)) {
    const base = [dir, ...inlinePath, modName].filter(Boolean).join('/')
    const found = firstFile([`${base}.rs`, `${base}/mod.rs`], { knownSources, baseDir })
    if (found) return found
  }
  return null
}

// Project-relative `sub` under `dir`, normalized; null when it escapes the bundle root.
function normalizeRel(dir, sub) {
  if (isAbsolute(sub) || posix.isAbsolute(sub)) return null
  const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, sub))
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return null
  return rel
}

// Resolve a `#[path = "…"]` target the way rustc does: relative to the declaring file's directory,
// or -- inside inline modules -- to the file's module dir plus the inline module names. Absolute
// or root-escaping paths resolve to nothing (a read would refuse them anyway).
export function resolveExplicitModPath(explicitPath, fromFile, { knownSources, baseDir, roots, inlinePath = [] } = {}) {
  const dir = inlinePath.length === 0
    ? posix.dirname(fromFile)
    : [getModuleDir(fromFile, { root: roots?.has(fromFile) === true }), ...inlinePath].filter(Boolean).join('/')
  const rel = normalizeRel(dir, explicitPath)
  return rel === null ? null : firstFile([rel], { knownSources, baseDir })
}

// Every file a `mod` declaration can denote, as `{ cfg, file }`: an unconditional `#[path]` names
// one outright; otherwise each `#[cfg_attr(<pred>, path = …)]` names one under its predicate
// (`cfg`), and the default `<name>.rs`/`<name>/mod.rs` lookup is the fallback (`cfg` null).
export function resolveModDecl(decl, fromFile, opts = {}) {
  const o = { ...opts, inlinePath: decl.inlinePath }
  const unconditional = decl.paths.find((p) => p.cfg === null)
  if (unconditional) {
    const file = resolveExplicitModPath(unconditional.path, fromFile, o)
    return file ? [{ cfg: null, file }] : []
  }
  const out = []
  for (const { path, cfg } of decl.paths) {
    const file = resolveExplicitModPath(path, fromFile, o)
    if (file && !out.some((x) => x.file === file)) out.push({ cfg, file })
  }
  const fallback = resolveModPath(decl.name, fromFile, o)
  if (fallback && !out.some((x) => x.file === fallback)) out.push({ cfg: null, file: fallback })
  return out
}

// --- Cargo manifests --------------------------------------------------------------------

function readFileOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// One TOML value: quoted string, bool, or a single-line inline table (as a plain object); anything
// else is returned raw. Trailing comments are dropped.
function parseTomlValue(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/u.exec(text)
    return m ? m[1].replaceAll(/\\(.)/gu, '$1') : text
  }
  if (text.startsWith("'")) {
    const m = /^'([^']*)'/u.exec(text)
    return m ? m[1] : text
  }
  if (text.startsWith('{')) {
    const end = matchClose(text, 0)
    const table = {}
    for (const part of splitTopLevel(text.slice(1, end))) {
      const kv = /^\s*([\w."'-]+)\s*=\s*([\s\S]+)$/u.exec(part)
      if (kv) table[kv[1].replaceAll(/["']/gu, '')] = parseTomlValue(kv[2])
    }
    return table
  }
  const bare = text.replace(/\s+#.*$/u, '')
  if (bare === 'true') return true
  if (bare === 'false') return false
  return bare
}

const DEP_TABLE_RE = /^(?:target\..+\.)?(?:dependencies|dev-dependencies|build-dependencies)(?:\.(.+))?$/u

// Minimal Cargo.toml reader (line-based TOML subset: table headers, `key = value`, single-line
// inline tables, dotted keys) covering what crate resolution and bucketing need: the package
// identity, the lib target's name/path, `path` dependencies (incl. workspace-inherited ones)
// and the workspace tables they inherit from. Dependency keys are normalized to the `use` spelling
// (`-` → `_`).
export function parseCargoManifest(text) {
  const manifest = {
    package: null, // { name, version, versionFromWorkspace }
    lib: { name: null, path: null },
    deps: new Map(), // use-name -> { path, package, workspace }
    workspaceDeps: new Map(),
    workspacePackage: { version: null },
    isWorkspace: false,
  }
  const depOf = (map, name) => {
    const key = name.replaceAll('-', '_')
    if (!map.has(key)) map.set(key, {})
    return map.get(key)
  }
  const setDepFields = (dep, table) => {
    if (typeof table !== 'object') return // `foo = "1.2"`: a registry dep, nothing in-tree
    if (typeof table.path === 'string') dep.path = table.path
    if (typeof table.package === 'string') dep.package = table.package
    if (table.workspace === true) dep.workspace = true
  }
  let table = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/u.exec(line)
    if (header) {
      table = header[1].trim()
      if (table === 'workspace') manifest.isWorkspace = true
      continue
    }
    const kv = /^([\w."'-]+)\s*=\s*(.+)$/u.exec(line)
    if (!kv) continue
    const key = kv[1].replaceAll(/["']/gu, '')
    const value = parseTomlValue(kv[2])
    if (table === 'package') {
      manifest.package ??= { name: null, version: null, versionFromWorkspace: false }
      if (key === 'name' && typeof value === 'string') manifest.package.name = value
      else if (key === 'version' && typeof value === 'string') manifest.package.version = value
      else if ((key === 'version' && value?.workspace === true) || (key === 'version.workspace' && value === true)) {
        manifest.package.versionFromWorkspace = true
      }
    } else if (table === 'lib') {
      if (key === 'name' && typeof value === 'string') manifest.lib.name = value
      else if (key === 'path' && typeof value === 'string') manifest.lib.path = value
    } else if (table === 'workspace.package') {
      if (key === 'version' && typeof value === 'string') manifest.workspacePackage.version = value
    } else {
      const ws = table.startsWith('workspace.')
      const m = DEP_TABLE_RE.exec(ws ? table.slice('workspace.'.length) : table)
      if (!m) continue
      const map = ws ? manifest.workspaceDeps : manifest.deps
      // `[dependencies.foo]` sub-table: each line is one field of `foo`; else each line is one dep.
      if (m[1]) setDepFields(depOf(map, m[1]), { [key]: value })
      else setDepFields(depOf(map, key), value)
    }
  }
  if (manifest.package && !manifest.package.name) manifest.package = null
  return manifest
}

// Per-bundle Cargo manifest lookup (memoized per directory) and crate-name resolution against
// in-tree sources. `baseDir` is the bundle root; every path in and out is project-relative POSIX.
export function createCargoContext(baseDir) {
  const manifests = new Map()
  const readManifest = (dir) => {
    if (!manifests.has(dir)) {
      const text = readFileOrNull(join(baseDir, dir, 'Cargo.toml'))
      manifests.set(dir, text === null ? null : { dir, ...parseCargoManifest(text) })
    }
    return manifests.get(dir)
  }
  const isFile = (rel) => {
    try {
      return statSync(join(baseDir, rel)).isFile()
    } catch {
      return false
    }
  }
  // Manifests at or above `dir`, nearest first, up to the bundle root.
  const manifestsAbove = function* (dir) {
    for (;;) {
      const m = readManifest(dir)
      if (m) yield m
      if (dir === '.' || dir === '') return
      dir = posix.dirname(dir)
    }
  }
  const packageFor = (fileRel) => {
    for (const m of manifestsAbove(posix.dirname(fileRel))) if (m.package) return m
    return null
  }
  const workspaceFor = (dir) => {
    for (const m of manifestsAbove(dir)) if (m.isWorkspace) return m
    return null
  }
  // The manifest's lib target root when it is on disk (`[lib] path`, default `src/lib.rs`).
  const libPath = (m) => {
    const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
    return rel !== null && isFile(rel) ? rel : null
  }
  const libName = (m) => (m.lib.name ?? m.package?.name ?? '').replaceAll('-', '_')
  const version = (m) => {
    if (m.package.versionFromWorkspace) return workspaceFor(m.dir)?.workspacePackage.version ?? '0.0.0'
    return m.package.version ?? '0.0.0'
  }

  // `cargo vendor` layout: `vendor/<dir>/`, where the dir may hyphenate a snake_case crate name.
  const resolveVendored = (norm) => {
    for (const dir of norm.includes('_') ? [norm, norm.replaceAll('_', '-')] : [norm]) {
      const vdir = `${VENDOR_DIR}/${dir}`
      const m = readManifest(vdir)
      const lib = m ? libPath(m) : (isFile(`${vdir}/src/lib.rs`) ? `${vdir}/src/lib.rs` : null)
      if (lib) return lib
    }
    return null
  }

  return {
    // Identity of the package owning `fileRel` -- `{ dir, name, version }` from the nearest
    // Cargo.toml with a [package] -- or null when no manifest claims it.
    packageInfo(fileRel) {
      const m = packageFor(fileRel)
      return m ? { dir: m.dir, name: m.package.name, version: version(m) } : null
    },
    // Whether `fileRel` is the lib target root of the package owning it (a crate root by role,
    // whatever its name).
    isLibRoot(fileRel) {
      const m = packageFor(fileRel)
      return m !== null && libPath(m) === fileRel
    },
    // Resolve a crate name as used in source (`use name::…`, `extern crate name`) from `fromFile`
    // to a crate root in-tree: the owning package's own lib, one of its `path` dependencies
    // (incl. `workspace = true` ones, whose path is relative to the workspace root), or a vendored
    // crate. Null for anything else (a registry dep, std, a name that isn't a crate).
    resolveCrate(name, fromFile) {
      const norm = name.replaceAll('-', '_')
      const m = packageFor(fromFile)
      if (m) {
        if (libName(m) === norm) {
          const lib = libPath(m)
          if (lib && lib !== fromFile) return lib
        }
        let dep = m.deps.get(norm)
        let relTo = m.dir
        if (dep?.workspace) {
          const ws = workspaceFor(m.dir)
          dep = ws?.workspaceDeps.get(norm) ?? null
          relTo = ws?.dir
        }
        if (dep?.path) {
          const depDir = normalizeRel(relTo, dep.path)
          const dm = depDir === null ? null : readManifest(depDir)
          const lib = dm ? libPath(dm) : null
          if (lib) return lib
        }
      }
      return resolveVendored(norm)
    },
  }
}

// Resolve a crate name to its vendored root (`vendor/<dir>/src/lib.rs`) among already-loaded
// sources, or null. `use` names underscore but the vendor dir may hyphenate, so try both.
export function resolveVendoredCrate(crateName, { knownSources, vendorDir = VENDOR_DIR } = {}) {
  const norm = crateName.replaceAll('-', '_')
  for (const dir of norm.includes('_') ? [norm, norm.replaceAll('_', '-')] : [norm]) {
    const lib = `${vendorDir}/${dir}/src/lib.rs`
    if (knownSources?.has(lib)) return lib
  }
  return null
}

// --- Module trees -----------------------------------------------------------------------

// The files walked as crate roots: every explicit root (entry) that was loaded, every file named
// main.rs/lib.rs (a vendored crate's root, the lib beside a bin, …) and, given a Cargo context,
// every file a manifest names as its lib target (`[lib] path = "src/other.rs"`).
export function crateRoots(sources, explicit = [], cargo = null) {
  const roots = new Set()
  for (const r of explicit) if (sources.has(r)) roots.add(r)
  for (const path of sources.keys()) {
    if (isNamedRoot(path) || cargo?.isLibRoot(path) === true) roots.add(path)
  }
  return roots
}

// One module tree per crate root -- `trees`: root file → Map<modulePath, file> -- built by
// following `mod` edges breadth-first from `crate`, plus `files`: file → `{ root, modulePath }`
// (first root to reach a file claims it). A file is reached under one module path per `mod` spec
// (`mod a::b` for a declaration inside inline module `a`); a cfg-variant Map target contributes
// every variant under the same path.
export function buildModuleTrees(sources, resolutions, roots) {
  const trees = new Map()
  const files = new Map()
  for (const root of roots) {
    if (!sources.has(root)) continue
    const tree = new Map()
    trees.set(root, tree)
    const seen = new Set()
    const queue = [[root, 'crate', 0]]
    for (let qi = 0; qi < queue.length; qi++) {
      const [path, modulePath, depth] = queue[qi]
      if (!tree.has(modulePath)) tree.set(modulePath, path)
      if (!files.has(path)) files.set(path, { root, modulePath })
      if (seen.has(path) || depth >= MAX_MODULE_DEPTH) continue
      seen.add(path)
      for (const [spec, target] of resolutions.get(path) ?? []) {
        if (!spec.startsWith('mod ')) continue
        // `mod a::b::name`: `a` and `a::b` are inline modules whose bodies live in this file, so
        // paths into them (`a::b::x`, `super::` from `name`) resolve to it.
        const parts = spec.slice(4).split('::')
        for (let k = 1; k < parts.length; k++) {
          const inline = `${modulePath}::${parts.slice(0, k).join('::')}`
          if (!tree.has(inline)) tree.set(inline, path)
        }
        const sub = `${modulePath}::${spec.slice(4)}`
        for (const file of target instanceof Map ? target.values() : [target]) queue.push([file, sub, depth + 1])
      }
    }
  }
  return { trees, files }
}

// Resolve `crate::a::b::Item` to the deepest module prefix that names a file (trailing item
// names aren't modules); null when none does.
export function resolveUsePath(usePath, moduleTree) {
  const parts = usePath.split('::')
  for (let i = parts.length; i >= 1; i--) {
    const modulePath = parts.slice(0, i).join('::')
    if (moduleTree.has(modulePath)) return moduleTree.get(modulePath)
  }
  return null
}

// Resolve one path reference made in `file` to what it names in the bundle: a module file of the
// same crate (`{ kind: 'module', target }`) for `crate::`/`self::`/`super::` paths and for
// 2018-style relative paths whose lead is a child module of the current module; else an in-tree
// crate root (`{ kind: 'crate', name, target }`) via `resolveCrate`; null for anything else (an
// item in scope, std, a registry crate, a path above the crate root).
function resolvePathRef(ref, file, { trees, files, resolveCrate }) {
  const { segments, absolute, inlinePath } = ref
  if (segments.length === 0) return null
  const head = segments[0]
  const here = files.get(file)
  if (!absolute && here) {
    const tree = trees.get(here.root)
    const current = [...here.modulePath.split('::'), ...inlinePath]
    let cur = null
    let idx = 0
    if (head === 'crate') {
      cur = ['crate']
      idx = 1
    } else if (head === 'self') {
      cur = current
      idx = 1
    } else if (head === 'super') {
      cur = current
    } else if (tree.has([...current, head].join('::'))) {
      cur = current
    }
    if (cur) {
      while (segments[idx] === 'super') {
        cur.pop()
        idx++
        if (cur.length === 0) return null
      }
      const target = resolveUsePath([...cur, ...segments.slice(idx)].join('::'), tree)
      return target ? { kind: 'module', target } : null
    }
  }
  if (NON_CRATE_LEADS.has(head)) return null
  const target = resolveCrate(head, file)
  return target ? { kind: 'crate', name: head, target } : null
}

// Bundle import keys can't contain '/'; a cfg predicate practically never does, but fail safe.
const cfgKey = (cfg) => (cfg ?? '*').replaceAll('/', '|')

// Crates rustc supplies from the sysroot; never in-tree, never worth reporting as unresolved.
const SYSROOT_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test'])

// Build the triple from already-loaded sources. Two-phase: resolve `mod` edges (defining each
// crate root's module tree), then path references against it. An unconditional `mod` with no
// file → `missing` (fatal); cfg-gated/unresolved/self refs are omitted. `roots` are the entries
// (crate roots by role; main.rs/lib.rs are roots by name regardless); `baseDir` enables crate
// resolution through Cargo.toml (own lib, path deps), else only vendored crates already in
// `sources` resolve. Spec shapes in `resolutions`: `mod <name>` (`mod a::<name>` inside inline
// module `a`) → file, or a Map<cfg predicate | '*', file> when `#[cfg_attr(…, path)]` variants
// differ; `<path as written>` → module file; `use <crate>` → crate root. `unresolvedCrates` names
// the crates `use`/`extern crate` referenced that nothing in-tree satisfied (registry deps that
// weren't vendored, typically) -- informational, never fatal.
export function buildRustTree(sources, { roots = [], baseDir = null } = {}) {
  const cargo = baseDir ? createCargoContext(baseDir) : null
  const rootSet = crateRoots(sources, roots, cargo)
  const resolutions = new Map()
  const missing = []
  const unresolvedCrates = new Set()
  const scanned = new Map()
  for (const [path, content] of sources) {
    const items = scanRustItems(content)
    scanned.set(path, items)
    const specMap = new Map()
    for (const decl of items.mods) {
      const spec = `mod ${[...decl.inlinePath, decl.name].join('::')}`
      const targets = resolveModDecl(decl, path, { knownSources: sources, roots: rootSet })
      if (targets.length === 0) {
        // conditional && unresolved: cfg-gated module, may be compiled out -- tolerated.
        if (!decl.conditional) {
          console.warn(`[loader.rust] Missing module: ${decl.name} from ${path}`)
          missing.push({ spec, from: path })
        }
        continue
      }
      specMap.set(spec, targets.length === 1 ? targets[0].file : new Map(targets.map((t) => [cfgKey(t.cfg), t.file])))
    }
    resolutions.set(path, specMap)
  }

  const { trees, files } = buildModuleTrees(sources, resolutions, rootSet)
  for (const [path, items] of scanned) {
    const specMap = resolutions.get(path)
    // Only edges to bundled files, never to self, first spelling wins.
    const add = (spec, target) => {
      if (target && target !== path && sources.has(target) && !specMap.has(spec)) specMap.set(spec, target)
    }
    const resolveCrate = (name, from) => cargo?.resolveCrate(name, from) ?? resolveVendoredCrate(name, { knownSources: sources })
    // A crate name (lowercase lead; `Enum::Variant` imports aren't crates) nothing in-tree satisfied.
    const noteUnresolved = (name) => {
      if (!NON_CRATE_LEADS.has(name) && !SYSROOT_CRATES.has(name) && /^[a-z_]/u.test(name)) unresolvedCrates.add(name)
    }
    for (const ref of items.refs) {
      const r = resolvePathRef(ref, path, { trees, files, resolveCrate })
      if (r?.kind === 'module') add(ref.spec, r.target)
      else if (r?.kind === 'crate') add(`use ${r.name}`, r.target)
      else if (r === null && ref.fromUse) noteUnresolved(ref.segments[0])
    }
    for (const { name } of items.externCrates) {
      const target = resolveCrate(name, path)
      if (target) add(`use ${name}`, target)
      else noteUnresolved(name)
    }
  }
  return { sources, resolutions, missing, unresolvedCrates }
}

// --- Disk walk --------------------------------------------------------------------------

// Walk from `entries` (the crate roots), following `mod` declarations and references to in-tree
// crates, reading each reachable file once; a missing file warns and is skipped without aborting
// the walk (buildRustTree decides what is fatal).
export async function collectRustFilesFromDisk(baseDir, entries) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)
  const roots = new Set(entries)
  const cargo = createCargoContext(baseDir)

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          assertRealPathWithinBase(realBase, baseDir, relPath)
          return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.rust] Missing file: ${relPath}`)
            return null
          }
          // resolveModPath gates on isFile so a dir is normally never queued; guard EISDIR anyway.
          if (err.code === 'EISDIR') {
            console.warn(`[loader.rust] Skipping directory reference: ${relPath}`)
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
      const { mods, refs, externCrates } = scanRustItems(content)
      for (const decl of mods) {
        for (const { file } of resolveModDecl(decl, relPath, { baseDir, roots })) {
          if (!sources.has(file)) next.push(file)
        }
      }
      // A reference to an in-tree crate pulls its root in (a crate root by role, whatever its
      // name -- `[lib] path` may point anywhere); the root's own `mod` edges follow next wave.
      const leads = new Set(externCrates.map((e) => e.name))
      for (const r of refs) if (!NON_CRATE_LEADS.has(r.segments[0])) leads.add(r.segments[0])
      for (const name of leads) {
        const lib = cargo.resolveCrate(name, relPath)
        if (!lib) continue
        roots.add(lib)
        if (!sources.has(lib)) next.push(lib)
      }
    }
    await processWave(next)
  }

  await processWave(entries)
  return sources
}

// Reject absolute paths and `..`-escaping paths in a `.rs.txt` listing so a
// malicious or sloppy listing can't read files outside the listing's own dir.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level entry: reads a `.rs.txt` listing of crate roots (relative to the listing), then
// walks `mod` declarations and in-tree crate references from there.
export async function loadRust(rsTxtFile) {
  const baseDir = dirname(resolve(rsTxtFile))
  const listing = await readFile(rsTxtFile, 'utf8')
  const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^\.\//u, ''))
  if (lines.length === 0) throw new Error(`Empty Rust listing: ${rsTxtFile}`)

  if (!lines.every((line) => extname(line) === '.rs')) {
    throw new Error(`Rust listing must only contain .rs files: ${rsTxtFile}`)
  }
  for (const line of lines) assertWithinBase(baseDir, line, 'Entry path')

  const sources = await collectRustFilesFromDisk(baseDir, lines)
  return buildRustTree(sources, { roots: lines, baseDir })
}
