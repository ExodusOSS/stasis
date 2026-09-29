// Rust loader: `{ sources, resolutions, missing }` from a crate's files.
//
// Reachability follows what rustc follows. A `mod foo;` declaration (incl. `#[path = …]` and
// `#[cfg_attr(…, path = …)]`) pulls a module file in, and a reference to a crate whose source is
// in-tree -- the package's own lib target, a Cargo `path` dependency, or a `cargo vendor`ed crate
// -- pulls that crate's root in. `crate::` / `self::` / `super::` / relative paths resolve against
// the per-crate module tree for the import graph but never widen the walk: a `use` can't add a
// file to a crate, only `mod` can. Registry dependencies that aren't vendored live outside the
// bundle root and are dropped.

import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'
import { TARGET_CFG_KEYS, TARGET_UNIT, VENDOR_DIR, createCargoContext, evalCfg, isFile, isTestTargetPath, normName, normalizeCfg, normalizeRel } from './cargo.js'
import { matchClose, splitTopLevel } from './toml.js'

// Leads of the expression-position paths anchored on the module tree rather than on a name.
const PATH_KEYWORDS = new Set(['crate', 'self', 'super'])

// Path keywords, and the sysroot crates every build links: a path whose lead is one of these
// never names an in-tree crate.
const NON_CRATE_LEADS = new Set([...PATH_KEYWORDS, 'std', 'core', 'alloc'])

// The other sysroot crates a program may name (`extern crate proc_macro;`, `test::Bencher`):
// never in-tree, so never worth reporting as unresolved.
const OTHER_SYSROOT_CRATES = new Set(['proc_macro', 'test'])

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
  // Each view is assembled from chunks: the source up to a blanked range, then the range with
  // every line replaced by as many spaces as it has UTF-16 units (a char may be two), so indexes
  // stay those of `content`.
  const code = []
  const masked = []
  let codeAt = 0
  let maskedAt = 0
  const blanks = (start, end) => content.slice(start, end).split('\n').map((line) => ' '.repeat(line.length)).join('\n')
  const blankMasked = (start, end) => {
    masked.push(content.slice(maskedAt, start), blanks(start, end))
    maskedAt = end
  }
  const blankBoth = (start, end) => {
    code.push(content.slice(codeAt, start), blanks(start, end))
    codeAt = end
    blankMasked(start, end)
  }

  let i = 0
  while (i < n) {
    const ch = content[i]
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i)
      const end = eol === -1 ? n : eol
      blankBoth(i, end)
      i = end
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const start = i
      let depth = 0
      do {
        if (content[i] === '/' && content[i + 1] === '*') {
          depth++
          i += 2
        } else if (content[i] === '*' && content[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      } while (i < n && depth > 0)
      blankBoth(start, Math.min(i, n))
      continue
    }
    const lit = stringStart(content, i)
    if (lit) {
      const start = lit.open + 1 // past the `b`/`c`/`r#` prefix and the opening quote
      if (lit.raw === null) {
        i = start
        while (i < n && content[i] !== '"') i += content[i] === '\\' ? 2 : 1 // an escape takes two
        blankMasked(start, Math.min(i, n))
        i++ // closing quote
      } else {
        const close = `"${'#'.repeat(lit.raw)}`
        let end = content.indexOf(close, start)
        if (end === -1) end = n
        blankMasked(start, end)
        i = end + close.length
      }
      continue
    }
    if (ch === "'") {
      const end = charLiteralEnd(content, i)
      if (end !== -1) {
        blankMasked(i + 1, end)
        i = end + 1
        continue
      }
    }
    i++
  }
  code.push(content.slice(codeAt))
  masked.push(content.slice(maskedAt))
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
const WS_RE = /\s/u
// First word of an item or statement that runs to its `;` or `{ … }` body, whatever commas its
// generics, arguments or `where` clause hold; anything else (a field, a variant, a match arm)
// ends at a top-level comma. Weak keywords a field may be named after (`default`, `union`) are
// left out on purpose.
const ITEM_KEYWORDS = new Set(['fn', 'impl', 'struct', 'enum', 'trait', 'type', 'const', 'static', 'mod', 'use', 'extern', 'macro_rules', 'unsafe', 'async', 'let'])
// Macros whose literal string argument names a file relative to the invoking one: Rust source
// spliced in (`include!`), or an asset embedded as text / bytes. Only a literal can be followed;
// `concat!(env!("OUT_DIR"), …)` is build output.
const INCLUDE_MACROS = new Set(['include', 'include_str', 'include_bytes'])
// Macros whose body is a template of code for some other crate (a proc macro's output): nothing
// in it is an item, import or path of the crate holding it.
const TEMPLATE_MACROS = new Set(['quote', 'quote_spanned', 'parse_quote', 'parse_quote_spanned'])
// An include macro's argument: a string literal (plain, with escapes, or raw with any number of
// `#`s), or `concat!(env!("CARGO_MANIFEST_DIR"), "<literal>")`, a path from the package root.
const STRING_LITERAL_RE = /^\s*(?:"((?:[^"\\]|\\[\s\S])*)"|r(#*)"([\s\S]*?)"\2)\s*$/u
const MANIFEST_DIR_CONCAT_RE = /^\s*concat!\s*\(\s*env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*([\s\S]*?),?\s*\)\s*$/u
// An include macro opening inside an attribute's text: `#![doc = include_str!("../README.md")]`.
const INCLUDE_IN_ATTR_RE = /\b(include|include_str|include_bytes)!\s*(?=[([{])/gu
// Items a module defines by name, for `pub struct X` behind a glob; `mod`, `use`, `extern crate`
// and `macro_rules!` have their own records.
const DEFINING_KEYWORDS = new Set(['struct', 'enum', 'union', 'trait', 'type', 'fn', 'const', 'static'])
// Of those, the items in the value namespace: never a path's lead or prefix (a `fn log` beside
// `use log::info` hides no crate).
const VALUE_KEYWORDS = new Set(['fn', 'const', 'static'])

// The path an include macro's argument names: `{ path, base }` (`base`: `file` for a path relative
// to the invoking file, `manifest` for one from the package root), or null when it isn't one the
// loader can follow (`concat!(env!("OUT_DIR"), …)` is build output).
function includeArg(text) {
  const manifest = MANIFEST_DIR_CONCAT_RE.exec(text)
  const lit = STRING_LITERAL_RE.exec(manifest ? manifest[1] : text)
  if (!lit) return null
  const path = lit[1] === undefined ? lit[3] : unescapeString(lit[1])
  return manifest ? { path: path.replace(/^\/+/u, ''), base: 'manifest' } : { path, base: 'file' }
}

// The value of a plain string literal's body: `\\`, `\"`, `\'`, `\n`, `\r`, `\t`, `\0`,
// `\x41`, `\u{1F600}` and a backslash-newline continuation.
function unescapeString(body) {
  return body.replaceAll(/\\(?:u\{([0-9a-fA-F]{1,6})\}|x([0-9a-fA-F]{2})|\n\s*|(.))/gsu, (m, u, x, c) => {
    if (u !== undefined) return String.fromCodePoint(Number.parseInt(u, 16))
    if (x !== undefined) return String.fromCharCode(Number.parseInt(x, 16))
    if (c === undefined) return ''
    return { n: '\n', r: '\r', t: '\t', 0: '\0' }[c] ?? c
  })
}
const EXTERN_CRATE_RE = /extern\s+crate\s+(?:r#)?(\w+)(?:\s+as\s+(?:r#)?(\w+))?\s*;/uy
const MACRO_EXPORT_RE = /^\s*macro_export\s*(?:\([\s\S]*\))?\s*$/u
// Expression-position paths: any `lead::…` path whose lead is lowercase (skipping `Type::assoc`
// associated-item paths) -- a `crate`/`self`/`super` keyword path, or one led by a module or
// crate name. Runs over the masked view, so string contents can't fake one.
const LEAD_PATH_RE = /\b([a-z_]\w*)(?:::\w+)+/gu
const ATTR_PATH_RE = /^\s*path\s*=\s*"([^"]*)"\s*$/u

// Combine an item's cfg predicates (several `#[cfg]` attributes all apply) into one; null when ungated.
const joinCfgs = (preds) => (preds.length === 0 ? null : (preds.length === 1 ? preds[0] : `all(${preds.join(', ')})`))

const CFG_ATTR_RE = /^\s*cfg\s*\(([\s\S]*)\)\s*$/u

// One outer attribute's text (inside `#[…]`) → `cfg`: the predicate gating the item (`#[cfg(<pred>)]`;
// `test` for a `#[test]` fn; for `#[cfg_attr(<pred>, cfg(<inner>))]` the item is compiled unless
// pred holds and inner doesn't, i.e. `any(not(pred), inner)`; null when the item is unconditional
// -- a `cfg_attr` applying any other attribute, `doc(cfg(…))` included, gates nothing);
// `paths`: the module file paths it names, `#[path = "…"]` outright (cfg null) or each
// `#[cfg_attr(<pred>, path = "…")]` under its predicate; `pred`: a `cfg_attr`'s own predicate
// (null for any other attribute) -- when it can't hold, the whole attribute applies nothing;
// `macroExport`: true for `#[macro_export]` / `#[macro_export(local_inner_macros)]`, outright or
// under a `cfg_attr` (the macro then lives at the crate root, as `$crate::name!`); `includes`: the
// files an include macro in the text names (`#[doc = include_str!("../README.md")]`, or from the
// package root with `concat!(env!("CARGO_MANIFEST_DIR"), …)`; see includeArg). `masked` is the same
// text with string contents blanked (lexRust), for matching the macro's brackets.
function parseAttr(text, masked = text) {
  const includes = []
  for (const m of masked.matchAll(INCLUDE_IN_ATTR_RE)) {
    const open = m.index + m[0].length
    const arg = includeArg(text.slice(open + 1, matchClose(masked, open)))
    if (arg !== null) includes.push({ kind: m[1], ...arg })
  }
  if (MACRO_EXPORT_RE.test(text)) return { cfg: null, paths: [], pred: null, includes, macroExport: true }
  if (/^\s*macro_use\s*$/u.test(text)) return { cfg: null, paths: [], pred: null, includes, macroUse: true }
  const path = ATTR_PATH_RE.exec(text)
  if (path) return { cfg: null, paths: [{ path: path[1], cfg: null }], pred: null, includes }
  if (/^\s*test\s*$/u.test(text)) return { cfg: 'test', paths: [], pred: null, includes }
  const cfg = CFG_ATTR_RE.exec(text)
  if (cfg) return { cfg: normalizeCfg(cfg[1]), paths: [], pred: null, includes }
  const cfgAttr = /^\s*cfg_attr\s*\(([\s\S]*)\)\s*$/u.exec(text)
  if (cfgAttr) {
    const parts = splitTopLevel(cfgAttr[1])
    const pred = normalizeCfg(parts.shift() ?? '')
    const paths = []
    const inner = []
    let macroExport = false
    for (const part of parts) {
      const m = ATTR_PATH_RE.exec(part)
      const c = CFG_ATTR_RE.exec(part)
      if (m) paths.push({ path: m[1], cfg: pred })
      else if (c) inner.push(normalizeCfg(c[1]))
      else if (MACRO_EXPORT_RE.test(part)) macroExport = true
    }
    return { cfg: inner.length === 0 ? null : `any(not(${pred}), ${joinCfgs(inner)})`, paths, pred, includes, macroExport }
  }
  return { cfg: null, paths: [], pred: null, includes }
}

// An attribute that applies nothing in this build (a `cfg_attr` whose predicate can't hold).
const INERT_ATTR = { cfg: null, paths: [], pred: null, includes: [] }

// The visibility a `pub(…)` restriction spells, from the text between its parentheses: `crate`,
// `self`, `super`, or `in <path>` (normalized to `in a::b`); a bare `pub` is `crate` -- the loader
// never follows a path into another crate's tree, so `pub` and `pub(crate)` are one to it.
function parseVisibility(restriction) {
  const r = restriction.trim().replaceAll(/\s+/gu, ' ')
  if (r === 'crate' || r === 'self' || r === 'super') return r
  if (r.startsWith('in ')) return `in ${r.slice(3).replaceAll(' ', '')}`
  return 'crate'
}

// Flatten a `use` tree body (the text between `use` and `;`) into the paths it imports, as
// `{ segments, absolute, spec, binding, glob }`: `a::{b::C, d::{E, F}}` → `a::b::C`, `a::d::E`,
// `a::d::F`; a glob (`glob` true) or `self` inside a group names the group's own module; a leading
// `::` marks the path absolute (an external crate). `spec` is the flat path as it would be
// written; `binding` the name the import brings into scope (its last segment, or the `as` alias;
// null for a glob or `_`).
export function parseUseTree(body) {
  const tokens = [...body.matchAll(/::|[{},*]|\bas\b|(?:r#)?\w+/gu)].map((m) => m[0])
  const out = []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isIdent = (tok) => tok !== undefined && tok !== 'as' && /^(?:r#)?\w+$/u.test(tok)
  const emit = (segments, absolute, binding, glob) => {
    if (segments.length > 0) {
      out.push({ segments, absolute, spec: `${absolute ? '::' : ''}${segments.join('::')}`, binding: binding === '_' ? null : binding, glob })
    }
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
      emit(prefix, absolute, null, true)
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
    let alias = null
    if (peek() === 'as') {
      next()
      alias = isIdent(peek()) ? next().replace(/^r#/u, '') : null
    }
    // `use a::{self, b}`: `self` names the group's own module.
    if (prefix.length > 0 && segments.length === prefix.length + 1 && segments.at(-1) === 'self') segments.pop()
    emit(segments, absolute, alias ?? segments.at(-1), false)
  }
  parse([], false)
  return out
}

// Statically scan one file's items. An item whose cfg can never hold in the build (`#[cfg(test)]`,
// `#[test]`, `#[cfg(doc)]`, a `#[cfg(feature = "x")]` with `x` off in the crate's resolved
// `features`, a `#[cfg(windows)]` when `target` -- the build target's cfg set, see evalCfg -- says
// otherwise) is skipped whole -- an inline `mod tests { … }` with everything in it, a `fn`'s
// body, a `use` -- so dead modules aren't bundled and the dependencies only dead code reaches for
// don't get pulled in. Returns
//   mods:         external `mod` declarations `{ name, inlinePath, inlineDirs, cfg, conditional,
//                 paths, noDefault, vis, macroUse, macro }` -- `inlinePath` is the chain of inline
//                 `mod x { … }` blocks it sits in, `inlineDirs` the directories those stand for
//                 (each its name, or its own `#[path = "…"]`, which may be empty), `vis` its
//                 visibility (see imports), `macroUse` a `#[macro_use]` on it, `macro` the macro
//                 invocation it sits in (if any), `noDefault` that a `#[cfg_attr(…, path)]` variant
//                 always applies so the default file lookup never happens, `cfg` the
//                 `#[cfg(…)]` predicate gating it (several → `all(…)`; null when ungated),
//                 `conditional` marks one that may not exist as an item (a cfg the loader can't
//                 decide, an inline ancestor so gated, or inside a macro invocation body), `paths`
//                 the explicit file paths its attributes name (see parseAttr), minus the
//                 `cfg_attr` variants whose predicate can't hold in the build, `at` where the
//                 declaration is written and `offset` where it stands (textual macro scope: what a
//                 mounted file sees) -- the same, unless it sits in a `macro_rules!` body
//                 (`template`, that macro's name): then the macro's first bare invocation in
//                 this file, Infinity for none;
//   refs:         path references `{ spec, segments, absolute, inlinePath, fromUse, macroCall }` --
//                 flattened `use` trees plus expression-position `crate::`/`self::`/`super::`/
//                 `lead::…` paths (`macroCall`: one invoked, `$crate::name!(…)`);
//   externCrates: `extern crate x [as y];` as `{ name, alias, inlinePath }`;
//   defined:      the items the file defines by name, `{ name, inlinePath, vis, cfg }`: a `struct`,
//                 `enum`, `union`, `trait`, `type`, `fn`, `const` or `static` at module level (not
//                 an `impl`'s or trait's associated item, nor a `macro_rules!` template's) -- what
//                 a glob into the module brings in; `cfg` the predicate gating it (see mods);
//   bindings:     names the file's `use` items and `extern crate … as` aliases bring into scope --
//                 a path lead among them names an import, not a crate;
//   imports:      the `use` items, and `extern crate` declarations as the imports they amount to
//                 (`extern crate serde_core as s` ≡ `use ::serde_core as s`; `extern crate self as
//                 x` ≡ `use crate as x`): `{ segments, absolute, binding, glob, inlinePath, vis,
//                 cfg, macro }` -- what a path written in that module may be anchored on, and, as
//                 far as `vis` reaches (null: private to the module; `crate`; `super`; `self`; `in
//                 a::b`), what a path from another module may continue along, i.e. a re-export;
//                 `cfg` gates it (see mods), `macro` is the invocation body it sits in, if any (one
//                 in a `macro_rules!` template is the invoking module's, not this one's);
//   macros:       `macro_rules!` definitions `{ name, exported, includes, calls, offset, template, gate }` -- an
//                 exported one is `$crate::name!` from anywhere in the crate, and lives in this
//                 file; `includes` are the include macros in its body, which rustc resolves
//                 relative to each file that invokes the macro; one written in another
//                 `macro_rules!`'s body (`template`, its name) is defined where that one is invoked
//                 (`offset`: the first bare invocation in this file, Infinity for none), as is a
//                 `mod` there;
//   invocations:  the names of the macros invoked by bare name (`ready!(…)`) outside `macro_rules!`
//                 templates -- for an edge to the file of a `macro_rules!` defined elsewhere in
//                 the crate; `calls` has each name's invocation offsets, in order (textual scope
//                 is decided at the call); a template's own bare calls are its definition's
//                 `calls`, made wherever it is invoked;
//   includes:     `include!` / `include_str!` / `include_bytes!` invocations outside macro
//                 definitions, `{ kind, path, base, conditional }` -- a file to carry, named
//                 relative to this one (`base` `file`) or to the package root (`manifest`, for
//                 `concat!(env!("CARGO_MANIFEST_DIR"), …)`); `unfollowed` counts the ones whose
//                 argument names no file the loader can follow (`concat!(env!("OUT_DIR"), …)`);
//   inlineModules: the paths of the inline `mod x { … }` blocks, for the module tree, and
//                 `inlineModuleVis`, each path (`a::b`) → its visibility;
//   skipped:      the template macros (see `templates` below) whose bodies were skipped.
// A file whose inner `#![cfg(<pred>)]` can never hold is compiled empty: the scan is empty too.
// `templates` names the macros whose bodies are token templates for another crate's code (quote!)
// and are skipped whole: TEMPLATE_MACROS, less the ones the file's package defines itself. The
// build (see evalCfg): `features` on for certain and `maybeFeatures` on maybe, `test`, the
// platform's cfg set `target`; or `units`, one such build per way the file is compiled.
export function scanRustItems(content, { features = null, maybeFeatures = null, test = false, target = null, units = null, templates = TEMPLATE_MACROS } = {}) {
  const env = units === null ? { features, maybeFeatures, test, target } : { units: units.map((u) => ({ ...u, test })) }
  const { code, masked } = lexRust(content)
  const n = masked.length
  const mods = []
  const uses = []
  const imports = []
  const macros = []
  const invocations = new Set()
  const calls = new Map() // macro name → the offsets of its bare invocations, in order
  const includes = []
  const defined = []
  const skipped = new Set() // the template macros whose bodies were skipped
  let unfollowed = 0
  const useSpans = [] // [start, end) of each `use` item's body, parsed as a tree below
  const deadSpans = [] // [start, end) of each skipped test/doc-only item
  const externCrates = []
  const bindings = new Set()
  const spans = [] // closed inline module blocks: { start, end, path, vis }
  const stack = [] // open inline modules: { name, dir, depth, conditional, start, vis }
  // `impl … { }` and `trait … { }` bodies, `{ start, end, depth }`: a `fn`, `const` or `type` at
  // their depth is an associated item, not one of the module's. `extern "C" { }` blocks the same
  // way: what they declare is the module's. Both are met in source order and nest or lie apart,
  // so each list is a stack: the ones the scan has left are popped off its end.
  const assocBlocks = []
  const foreignBlocks = []
  const openBlocks = (blocks, at) => {
    while (blocks.length > 0 && blocks.at(-1).end < at) blocks.pop()
    return blocks
  }
  // The `macro_rules!` names this file defines: a `quote!` of its own is no template.
  const localMacros = new Set([...masked.matchAll(/\bmacro_rules!\s*([A-Za-z_]\w*)/gu)].map((m) => m[1]))
  let depth = 0
  let pending = [] // parsed outer attributes (parseAttr) waiting for their item
  let attrStart = 0 // where the first pending attribute begins: a dead item is dead from there
  let visNext = null // the previous token was a `pub` visibility (parseVisibility): the coming item has it
  // Open blocks a live `#[cfg]` gates -- `if #[cfg(unix)] { mod imp; }` in a `cfg_if!` body, a
  // `#[cfg(x)] mod m { mod a; }` -- as `{ depth, cfg }`: everything declared inside is gated too.
  const cfgScopes = []
  const scopeCfgs = () => cfgScopes.map((s) => s.cfg)
  // The cfg of a `#[cfg(…)] name! { … }`: it gates the invocation, so everything the body
  // declares (mio's `#[cfg(unix)] cfg_os_poll! { mod unix; }`); taken up by the body's `{`.
  let macroBodyCfg = null
  // A chain of cfg-gated branches, `if #[cfg(a)] { … } else if #[cfg(b)] { … } else { … }` (a
  // `cfg_if!` body): a branch applies only when the cfgs of those before it don't hold, so its
  // block is gated on `all(not(a), b)` -- dead outright once an earlier cfg is known to hold.
  // Open chains by the depth of their branch blocks (a `cfg_if!` inside a `cfg_if!` branch is a
  // chain of its own): depth → the cfgs of the branches so far.
  const chains = new Map()
  // The word right before `pos` (skipping whitespace) and where it starts, or null.
  const wordBefore = (pos) => {
    let k = pos - 1
    while (k >= 0 && WS_RE.test(masked[k])) k--
    const end = k + 1
    while (k >= 0 && isWordChar(masked[k])) k--
    return k + 1 < end ? { word: masked.slice(k + 1, end), start: k + 1 } : null
  }
  // The cfg a `{` at `i` opens its block under, when the block is a branch of a cfg chain: its own
  // (`own`, from the attributes right after the `if`) and the negation of every earlier branch's;
  // null for any other block. Records the branch on its chain.
  const branchCfg = (i, own) => {
    const lead = wordBefore(pending.length > 0 ? attrStart : i)
    if (lead === null || (lead.word !== 'if' && lead.word !== 'else')) return null
    const continuing = lead.word === 'else' || wordBefore(lead.start)?.word === 'else'
    const negations = continuing ? chains.get(depth + 1) ?? [] : []
    if (own === null && negations.length === 0) return null
    chains.set(depth + 1, own === null ? negations : [...negations, own])
    return joinCfgs([...negations.map((c) => `not(${c})`), ...(own === null ? [] : [own])])
  }
  // After a branch block at `blockDepth` closed at `end`: its chain goes on only if an `else` follows.
  const endBranch = (end, blockDepth) => {
    if (chains.has(blockDepth) && readWord(skipWs(end)) !== 'else') chains.delete(blockDepth)
  }
  // End of the outermost macro invocation body being scanned (`m! { … }`, `m!( … )`,
  // `macro_rules! m { … }`). Its tokens are macro input: a `mod x;` there only becomes an item if
  // the macro emits it (cfg_if! does; serde_with's generate_guide! turns it into an inline module
  // documented from a .md file), so such declarations are followed when their file exists and
  // tolerated when it doesn't -- the same footing as a `#[cfg]`-gated one. `macroName` is that
  // macro's name: what stands for the cfg a `mod` it emits is under (tokio's `cfg_has_atomic_u64!
  // { mod imp; }` beside `cfg_not_has_atomic_u64! { mod imp; }`).
  let macroUntil = -1
  let macroName = null
  // The `macro_rules!` being defined (its name) while inside its body: what it declares (serde's
  // `crate_root! { … mod de; … }`) appears where the macro is invoked, not where it is defined, so
  // such a `mod` takes the offset of the macro's first bare invocation in this file (`calls`).
  let templateName = null

  const inlinePath = () => stack.map((s) => s.name)
  const closeTo = (targetDepth, at) => {
    while (stack.length > 0 && stack.at(-1).depth > targetDepth) {
      const top = stack.pop()
      spans.push({ start: top.start, end: at, path: [...inlinePath(), top.name], vis: top.vis })
    }
  }
  // Whether an item at `at` (depth `d`) sits directly in an `impl`/`trait` body.
  const isAssociated = (at, d) => openBlocks(assocBlocks, at).some((b) => b.start < at && b.depth === d)
  // Whether an item at `at` is at its module's own level: the module body (a file's, an inline
  // module's), a `#[cfg]`-gated block or an `extern "C" { }` block there, or a macro invocation's
  // body (libc's `s! { … }`); not a `fn` body.
  const atModuleLevel = (at) => {
    if (at < macroUntil) return true
    const base = stack.length > 0 ? stack.at(-1).depth : 0
    return depth === base || cfgScopes.some((s) => s.depth === depth) || openBlocks(foreignBlocks, at).some((b) => b.start < at && b.depth === depth)
  }
  // The `{` opening the body of the item starting at `from` (an `impl`/`trait` header may hold
  // generics, bounds and a `where` clause), or -1 when a `;` ends it first.
  const bodyOpen = (from) => {
    let nest = 0
    for (let k = from; k < n; k++) {
      const ch = masked[k]
      if (ch === '(' || ch === '[' || ch === '<') nest++
      else if (ch === ')' || ch === ']' || (ch === '>' && masked[k - 1] !== '-' && masked[k - 1] !== '=')) nest = Math.max(0, nest - 1)
      else if (nest === 0 && ch === '{') return k
      else if (nest === 0 && ch === ';') return -1
    }
    return -1
  }
  const readWord = (at) => {
    WORD_RE.lastIndex = at
    const m = WORD_RE.exec(masked)
    return m ? m[0] : null
  }
  const skipWs = (at) => {
    while (at < n && WS_RE.test(masked[at])) at++
    return at
  }
  const skipWsBack = (at) => {
    while (at >= 0 && WS_RE.test(masked[at])) at--
    return at
  }
  // The end of the item starting at `from`, without leaving its enclosing block: through a
  // top-level `;` or its `{ … }` body, or -- for a field, variant or match arm (`itemLike`
  // false) -- a top-level `,`; a `}` or `)` closing the enclosing block is left for the main
  // loop. Parentheses/brackets nest (a tuple field's `(u8, u8)` comma isn't the field's end), and
  // so does a generic argument list -- a `<` right after a name or `::` (`HashMap<K, V>`, `f::<T>`)
  // up to its `>` (the `>` of `->` / `=>` is not one) -- so the comma in `Result<A, B>` isn't
  // either. An item (`fn f<'a, T>(…) -> R where T: Tr, { … }`, `impl<A, B> …`) never ends at a
  // comma at all. A dead statement or arm whose value is an `if` (`elseChain`: anything but a bare
  // `{ … }` block) takes its `else` branches with it; a dead bare block does not: in `cfg_if! { if
  // #[cfg(a)] { … } else { … } }` the `else` is what applies when the cfg doesn't.
  // A `let` (`toSemicolon`) runs to its `;` whatever blocks its initializer holds.
  const skipItem = (from, itemLike, { elseChain = false, toSemicolon = false } = {}) => {
    let nest = 0
    let angle = 0
    for (let k = from; k < n; k++) {
      const ch = masked[k]
      if (ch === '(' || ch === '[') nest++
      else if (ch === ')' || ch === ']') {
        if (--nest < 0) return k
      } else if (nest === 0) {
        if (ch === ';') return k + 1
        if (ch === '}') return k
        if (ch === '{') {
          const close = matchClose(masked, k)
          if (toSemicolon) {
            k = close
            continue
          }
          const after = skipWs(close + 1)
          if (!elseChain || readWord(after) !== 'else') return close + 1
          k = after + 3
          continue
        }
        if (ch === '<' && (angle > 0 || isWordChar(masked[k - 1]) || masked[k - 1] === ':')) angle++
        else if (ch === '>' && angle > 0 && masked[k - 1] !== '-' && masked[k - 1] !== '=') angle--
        else if (ch === ',' && angle === 0 && !itemLike) return k + 1
      }
    }
    return n
  }

  let i = 0
  while (i < n) {
    const ch = masked[i]
    if (WS_RE.test(ch)) {
      i++
      continue
    }
    if (i >= macroUntil) macroName = null
    if (ch === '#' && (masked[i + 1] === '[' || (masked[i + 1] === '!' && masked[i + 2] === '['))) {
      const outer = masked[i + 1] === '['
      const open = outer ? i + 1 : i + 2
      const close = matchClose(masked, open)
      if (outer) {
        const attr = parseAttr(code.slice(open + 1, close), masked.slice(open + 1, close))
        // `#[cfg_attr(<pred>, derive(serde::Serialize))]` with pred never holding applies nothing:
        // the paths in its text are dead code too, and so is whatever else it would apply.
        const inert = attr.pred !== null && evalCfg(attr.pred, env) === false
        if (inert) deadSpans.push([i, close + 1])
        if (pending.length === 0) attrStart = i
        pending.push(inert ? INERT_ATTR : attr)
      } else {
        // An inner `#![…]` attribute applies to the enclosing module, not to the next item. A
        // `#![cfg(<pred>)]` that can't hold empties that module: the whole file at the top, else
        // the inline module it opens.
        const attr = parseAttr(code.slice(open + 1, close), masked.slice(open + 1, close))
        // (An inner attribute inside a macro invocation's body is the macro's business.)
        if (attr.cfg !== null && evalCfg(attr.cfg, env) === false && i >= macroUntil) {
          if (depth === 0) return { mods: [], refs: [], externCrates: [], bindings: new Set(), imports: [], macros: [], invocations: new Set(), calls: new Map(), includes: [], unfollowed: 0, defined: [], inlineModules: [], inlineModuleVis: new Map(), skipped }
          const top = stack.at(-1)
          if (top !== undefined && top.depth === depth) {
            const end = matchClose(masked, top.start - 1)
            deadSpans.push([i, end])
            pending = []
            i = end
            continue
          }
        }
        // `#![doc = include_str!("../README.md")]`: the module's own include, applied here.
        const conditional = stack.some((s) => s.conditional) || i < macroUntil
        for (const inc of attr.includes) includes.push({ ...inc, conditional })
        pending = []
      }
      i = close + 1
      continue
    }
    // The cfg gating the item the pending attributes belong to (several `#[cfg]`s all apply,
    // and so does every enclosing block's). `pub` is visibility, not the item: its attributes
    // stay pending for the keyword after it.
    const word = readWord(i)
    const attrCfg = word === 'pub' ? null : joinCfgs(pending.map((a) => a.cfg).filter((c) => c !== null))
    // A `{` opening a branch of a cfg chain is gated on the earlier branches' cfgs not holding too.
    const own = ch === '{' ? branchCfg(i, attrCfg) ?? attrCfg : attrCfg
    const cfg = joinCfgs(own === null ? scopeCfgs() : [...scopeCfgs(), own])
    // An item gated on a cfg that never holds in the build is dead code for the bundle: skip it
    // whole -- from its first attribute (a `#[derive(serde::Serialize)]` on it names nothing
    // live) through a declaration's `;`, a field's or variant's `,`, or a body's or block's `}`
    // -- without recording anything in it, whatever token starts it: a keyword or a name, a
    // `{ … }` block statement, a `(a, b)` / `[a, ..]` pattern or tuple type, a `&x`, `*x` or literal.
    if (cfg !== null && evalCfg(cfg, env) === false) {
      pending = []
      visNext = null
      const end = skipItem(word === null ? i : i + word.length, word !== null && ITEM_KEYWORDS.has(word), { elseChain: ch !== '{', toSemicolon: word === 'let' })
      deadSpans.push([attrStart, end])
      if (ch === '{') endBranch(end, depth + 1)
      i = end
      continue
    }
    // The item is live, so the includes its attributes name (`#[doc = include_str!("docs/x.md")]`)
    // are too; a `pub` keeps them pending for the keyword after it.
    if (word !== 'pub' && pending.length > 0) {
      const conditional = (cfg !== null && evalCfg(cfg, env) !== true) || stack.some((s) => s.conditional) || i < macroUntil
      for (const a of pending) {
        for (const inc of a.includes) includes.push({ ...inc, conditional })
        a.includes = []
      }
    }
    if (ch === '{') {
      depth++
      const gate = own ?? macroBodyCfg
      macroBodyCfg = null
      if (gate !== null) cfgScopes.push({ depth, cfg: gate })
      pending = []
      i++
      continue
    }
    if (ch === '}') {
      depth--
      closeTo(depth, i)
      while (cfgScopes.length > 0 && cfgScopes.at(-1).depth > depth) cfgScopes.pop()
      endBranch(i + 1, depth + 1)
      pending = []
      i++
      continue
    }
    const vis = visNext
    visNext = null
    if (word === null) {
      pending = []
      i++
      continue
    }
    // `name!` followed by a bracket opens a macro invocation body (`macro_rules! name` too).
    const bang = skipWs(i + word.length)
    const pathQualified = masked[i - 1] === ':' && masked[i - 2] === ':'
    if (masked[bang] === '!') {
      let open = skipWs(bang + 1)
      if (word === 'macro_rules') {
        const name = readWord(open)
        if (name !== null) {
          open = skipWs(open + name.length)
          const gate = GATE_MACRO_RE.test(name) && masked[open] === '{' ? gatePredicate(code, masked, open, matchClose(masked, open)) : undefined
          macros.push({ name, exported: pending.some((a) => a.macroExport === true), includes: [], calls: new Set(), offset: i, at: i, template: i < macroUntil && macroName === 'macro_rules' ? templateName : null, gate })
          if (i >= macroUntil) templateName = name
        }
      }
      if (masked[open] === '{' || masked[open] === '(' || masked[open] === '[') {
        const close = matchClose(masked, open)
        if (templates.has(word) && !localMacros.has(word)) {
          // serde_derive's `quote! { use #path as _serde; … _serde::__private::Ok(…) }`, bare or as
          // `quote::quote! { … }`: skipped whole. (A crate's own `macro_rules! quote` is no template.)
          deadSpans.push([i, close + 1])
          skipped.add(word)
          pending = []
          i = close + 1
          continue
        }
        if (i >= macroUntil) macroName = word
        // (A cfg on a `macro_rules!` definition gates the definition, not what its template
        // declares wherever it is invoked -- an approximation kept from before.)
        if (own !== null && masked[open] === '{' && word !== 'macro_rules') macroBodyCfg = own
        if (word !== 'macro_rules') {
          // Invoked by bare name; `$crate::name!` / `serde_json::json!` is a path (a ref). One in a
          // `macro_rules!` template is the template's (`calls` on the definition): rustc resolves
          // it where the macro is invoked, not where it is written -- and a recursive arm's
          // `m!(…)` is no invocation of this file's.
          if (!pathQualified) {
            if (i < macroUntil && macroName === 'macro_rules' && macros.length > 0) macros.at(-1).calls.add(word)
            else {
              invocations.add(word)
              ;(calls.get(word) ?? calls.set(word, []).get(word)).push(i)
            }
          }
          if (INCLUDE_MACROS.has(word)) {
            const text = code.slice(open + 1, close)
            const arg = includeArg(text)
            const conditional = (cfg !== null && evalCfg(cfg, env) !== true) || stack.some((s) => s.conditional) || i < macroUntil
            // Inside a `macro_rules!` body the path is relative to whichever file invokes the
            // macro: recorded on the definition, resolved per invoking file. Build output
            // (`concat!(env!("OUT_DIR"), …)`) is nobody's to follow; any other unreadable argument
            // is counted, for a warning.
            if (arg === null) unfollowed += /\bOUT_DIR\b/u.test(text) ? 0 : 1
            else if (i < macroUntil && macroName === 'macro_rules' && macros.length > 0) macros.at(-1).includes.push({ kind: word, ...arg })
            else includes.push({ kind: word, ...arg, conditional })
          }
        }
        macroUntil = Math.max(macroUntil, close)
      }
    }
    // An `impl`/`trait` body holds associated items, an `extern "C" { }` block the module's own
    // (an `extern "C" fn f() { }` is a fn, with a body of its own).
    if (word === 'impl' || word === 'trait') {
      const open = bodyOpen(i + word.length)
      if (open !== -1) assocBlocks.push({ start: open, end: matchClose(masked, open), depth: depth + 1 })
    } else if (word === 'extern' && readWord(bang) !== 'crate') {
      let k = bang
      if (masked[k] === '"') k = skipWs(masked.indexOf('"', k + 1) + 1)
      if (masked[k] === '{') foreignBlocks.push({ start: k, end: matchClose(masked, k), depth: depth + 1 })
    }
    // An item the module defines by name (`pub struct sigset_t`, inside libc's `s! { … }` or an
    // `extern "C" { }` block too), at the module's own level -- not a `fn`'s local item, nor an
    // `impl`/`trait` body's associated one, nor a `macro_rules!` template's (that is some invoking
    // module's item); `const fn` / `static mut` / lazy_static's `static ref` are not items named
    // `fn` / `mut` / `ref`.
    if (DEFINING_KEYWORDS.has(word) && atModuleLevel(i) && !isAssociated(i, depth) && !(i < macroUntil && macroName === 'macro_rules') && !(word === 'const' && masked[skipWsBack(i - 1)] === '*')) {
      let at = skipWs(i + word.length)
      if (masked.startsWith('mut ', at) || masked.startsWith('ref ', at)) at = skipWs(at + 3)
      if (masked.startsWith('r#', at)) at += 2
      const name = readWord(at)
      const next = name === null ? null : masked[skipWs(at + name.length)]
      // `ns`: a `fn`, `const` or `static` lives in the value namespace and can't lead a path
      // (`*const libc::c_char`, a raw pointer type, is no item at all; a `fn log` beside
      // `use log::info` hides no crate).
      if (name !== null && !ITEM_KEYWORDS.has(name) && (word !== 'union' || next === '{' || next === '<')) defined.push({ name, inlinePath: inlinePath(), vis, cfg, macro: i < macroUntil ? macroName : null, ns: VALUE_KEYWORDS.has(word) ? 'value' : 'type' })
    }
    if (word === 'pub') {
      // Visibility sits between an item's attributes and its keyword; `pub(crate)` etc. included.
      i = skipWs(i + 3)
      visNext = 'crate'
      if (masked[i] === '(') {
        const close = matchClose(masked, i)
        visNext = parseVisibility(masked.slice(i + 1, close))
        i = close + 1
      }
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
      const attrs = pending
      pending = []
      // Dead cfgs were skipped above; a decidable-true one (`not(test)`) is as firm as no cfg at all.
      const conditional = (cfg !== null && evalCfg(cfg, env) !== true) || stack.some((s) => s.conditional) || i < macroUntil
      if (masked[k] === ';') {
        // rustc applies the first `#[path]` / `#[cfg_attr(<pred>, path = …)]` whose predicate holds.
        // A variant whose predicate can't hold names nothing in this build; one whose predicate
        // holds ends the list -- outright the `#[path]` when nothing undecided precedes it -- and
        // either way the default `<name>.rs` lookup never happens.
        const live = attrs.flatMap((a) => a.paths).filter((p) => p.cfg === null || evalCfg(p.cfg, env) !== false)
        const applies = live.findIndex((p) => p.cfg === null || evalCfg(p.cfg, env) === true)
        const paths = applies === -1 ? live : (applies === 0 ? [{ path: live[0].path, cfg: null }] : live.slice(0, applies + 1))
        mods.push({
          name, inlinePath: inlinePath(), inlineDirs: stack.map((s) => s.dir), cfg, conditional, paths, noDefault: applies !== -1, vis,
          macroUse: attrs.some((a) => a.macroUse === true), macro: i < macroUntil ? macroName : null, offset: i, at: i,
          template: i < macroUntil && macroName === 'macro_rules' ? templateName : null,
        })
        i = k + 1
        continue
      }
      if (masked[k] === '{') {
        // `#[path = "dir"] mod m { mod a; }` finds `a` under `dir/`, not `m/`; solana-program's
        // `#[path = ""] mod non_bpf_modules { mod account_keys; }` right beside the file.
        const dir = attrs.flatMap((a) => a.paths).find((p) => p.cfg === null)?.path ?? name
        depth++
        if (own !== null) cfgScopes.push({ depth, cfg: own })
        stack.push({ name, dir, depth, conditional, start: k + 1, vis })
        i = k + 1
        continue
      }
      i = k
      continue
    }
    if (word === 'use') {
      const end = masked.indexOf(';', i + 3)
      const stop = end === -1 ? n : end
      const body = code.slice(i + 3, stop)
      // A `use` item's tree starts with a name, `::`, `{` or -- in a `macro_rules!` template --
      // `$crate`. Anything else is the word in macro input (syn's `Token![use]`), and a tree
      // interpolating a metavariable (`use $m::X;`, quote's `use #path as _serde;`; a raw
      // identifier's `r#` is no interpolation) is a template for code the loader can't place:
      // neither is an import of this file.
      if (!/^\s*[A-Za-z_{:$]/u.test(body) || /(?<!\br)#|\$(?!crate\b)/u.test(body)) {
        pending = []
        i += 3
        continue
      }
      const ip = inlinePath()
      const macro = i < macroUntil ? macroName : null
      // `use $crate::…` in a `macro_rules!` template imports into whichever module invokes the macro.
      const template = macro === 'macro_rules' && /\$crate\b/u.test(body)
      for (const p of parseUseTree(body)) {
        uses.push({ ...p, inlinePath: ip })
        const im = { segments: p.segments, absolute: p.absolute, binding: p.binding, glob: p.glob, inlinePath: ip, vis, cfg, macro, template }
        imports.push(im)
        if (hidesCrate(im)) bindings.add(p.binding)
      }
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
        const ip = inlinePath()
        externCrates.push({ name: m[1], alias: m[2] ?? null, inlinePath: ip })
        if (m[2] !== undefined) bindings.add(m[2])
        // `extern crate self as x;` names this crate's root; any other, a crate by its own name.
        const selfCrate = m[1] === 'self'
        imports.push({ segments: [selfCrate ? 'crate' : m[1]], absolute: !selfCrate, binding: m[2] ?? m[1], glob: false, inlinePath: ip, vis, cfg, macro: i < macroUntil ? macroName : null })
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
  // A `mod` or `macro_rules!` a `macro_rules!` template declares stands where the macro is first
  // invoked here (serde's `crate_root! { … macro_rules! tri { … } … mod de; … }`).
  for (const m of [...mods, ...macros]) if (m.template !== null) m.offset = calls.get(m.template)?.[0] ?? Infinity

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
  // crate (an expression path's lead is as likely a module or an imported item). `macroCall`
  // marks an invoked path (`$crate::span!(…)`): it names a macro, not the module of that name.
  const addRef = (spec, segments, absolute, ip, fromUse, macroCall) => {
    const key = `${ip.join('::')}\0${spec}\0${macroCall ? '!' : ''}`
    if (!refs.has(key)) refs.set(key, { spec, segments, absolute, inlinePath: ip, fromUse, macroCall })
  }
  for (const u of uses) addRef(u.spec, u.segments, u.absolute, u.inlinePath, true, false)
  // Expression-position paths: scan everything outside `use` items (the tree parser owns those;
  // a regex over `use syn::{parse::Parse}` would take `parse::Parse` for a local module path) and
  // outside skipped test/doc-only items (a `quickcheck::quickcheck(…)` in a `#[test]` fn body
  // must not pull the vendored dev-dependency in): blank those spans, keeping offsets.
  let exprs = ''
  let at = 0
  for (const [start, end] of [...useSpans, ...deadSpans].toSorted((a, b) => a[0] - b[0])) {
    const from = Math.max(start, at)
    if (end <= from) continue
    exprs += masked.slice(at, from) + ' '.repeat(end - from)
    at = end
  }
  exprs += masked.slice(at)
  // Keyword paths (`crate::`/`self::`/`super::`) first, then paths led by a module or crate name.
  const keywordPaths = []
  const leadPaths = []
  for (const m of exprs.matchAll(LEAD_PATH_RE)) {
    // `$trait::fmt(…)` in a `macro_rules!` template: the lead is a metavariable, not a name;
    // `$crate::…` is the one interpolation that names something (this crate).
    if (exprs[m.index - 1] === '$' && m[1] !== 'crate') continue
    if (PATH_KEYWORDS.has(m[1])) keywordPaths.push(m)
    else if (!NON_CRATE_LEADS.has(m[1])) leadPaths.push(m)
  }
  for (const m of [...keywordPaths, ...leadPaths]) {
    let after = m.index + m[0].length
    while (after < n && WS_RE.test(exprs[after])) after++
    const macroCall = exprs[after] === '!' && exprs[after + 1] !== '='
    addRef(m[0], m[0].split('::'), false, inlineAt(m.index), false, macroCall)
  }
  const inlineModuleVis = new Map()
  for (const s of spans) if (!inlineModuleVis.has(s.path.join('::'))) inlineModuleVis.set(s.path.join('::'), s.vis)
  const inlineModules = [...inlineModuleVis.keys()].map((p) => p.split('::'))
  return { mods, refs: [...refs.values()], externCrates, bindings, imports, macros, invocations, calls, includes, unfollowed, defined, inlineModules, inlineModuleVis, skipped }
}

// Whether a `use` import binds a name that is not the crate of that name: `use std::io;` binds
// `io`, but `use serde_json;` / `use rand::{self, Rng};` bind the crate itself under its own name.
const hidesCrate = (im) => im.binding !== null && (im.segments.length > 1 || im.binding !== im.segments[0])

// --- Module files -----------------------------------------------------------------------

// Directory holding this file's submodules, per Rust's path rules: siblings for crate roots,
// mod.rs and files loaded through `#[path = …]` (rustc treats those like mod.rs), else under a
// `<stem>/` subdir. `root` marks a crate root by role (an entry such as `src/bin/tool.rs` or
// `tests/it.rs`) rather than by name.
export function getModuleDir(filePath, { root = false } = {}) {
  const lastSlash = filePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
  if (root || ROOT_NAMES.has(name) || name === 'mod.rs') return dir
  const stem = name.replace(/\.rs$/u, '')
  return dir ? `${dir}/${stem}` : stem
}

// Whether `file` owns its directory for submodule lookup: a crate root by role, or a file a
// `#[path]` attribute loaded (`pathLoaded`).
const ownsDir = (file, { roots, pathLoaded }) => roots?.has(file) === true || pathLoaded?.has(file) === true

function firstFile(candidates, { knownSources, baseDir }) {
  if (knownSources) return candidates.find((c) => knownSources.has(c)) ?? null
  if (baseDir) return candidates.find((c) => isFile(join(baseDir, c))) ?? null
  return null
}

// Resolve `mod <name>;` declared in `fromFile` (inside the inline modules `inlinePath`) to its
// file, trying `<dir>/<name>.rs` then `<dir>/<name>/mod.rs`. `roots` are the files walked as crate
// roots (the entries) and `pathLoaded` the files a `#[path]` loaded: their submodules are
// siblings. Both also get the non-root `<stem>/` rule as a fallback: a glob-listed module file
// still resolves, and so does a file that a plain `mod` mounts as well as a `#[path]` (each mount
// is its own module to rustc; the loader keeps one resolution, whichever file exists).
export function resolveModPath(modName, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const owns = ownsDir(fromFile, { roots, pathLoaded })
  const dirs = [getModuleDir(fromFile, { root: owns })]
  if (owns) dirs.push(getModuleDir(fromFile)) // the same dir for main.rs/lib.rs/mod.rs
  for (const dir of new Set(dirs)) {
    // An inline module's `#[path = "…"]` may climb (`..`): normalized, and held to `boundary`
    // like any explicit path (resolveExplicitModPath).
    const base = normalizeRel(dir, [...inlinePath, modName].filter(Boolean).join('/'))
    if (base === null || (boundary !== null && !withinDir(base, boundary))) continue
    const found = firstFile([`${base}.rs`, `${base}/mod.rs`], { knownSources, baseDir })
    if (found) return found
  }
  return null
}

// Resolve a `#[path = "…"]` target the way rustc does: relative to the declaring file's directory,
// or -- inside inline modules -- to the file's module dir plus the inline module names. Absolute
// or root-escaping paths resolve to nothing (a read would refuse them anyway).
export function resolveExplicitModPath(explicitPath, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const dir = inlinePath.length === 0
    ? posix.dirname(fromFile)
    : [getModuleDir(fromFile, { root: ownsDir(fromFile, { roots, pathLoaded }) }), ...inlinePath].filter(Boolean).join('/')
  const rel = normalizeRel(dir, explicitPath)
  if (rel === null || (boundary !== null && !withinDir(rel, boundary))) return null
  return firstFile([rel], { knownSources, baseDir })
}

// Whether project-relative `rel` lies in directory `dir` (`.`: anywhere in the bundle root).
const withinDir = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`)

// The directory a file's `#[path]`, include and build-script paths may reach into: a published
// crate never legitimately names a file outside its own package, so a file of a vendored one is
// held to that package's directory (`vendor/<crate>`); the project's own code -- the root package,
// workspace members, path dependencies -- may reach anywhere in the bundle root (`.`).
function boundaryOf(file, ctx) {
  return ctx?.isVendored(file) === true ? ctx.packageInfo(file).dir : '.'
}

// Resolve an include macro's argument (scanRustItems' `{ kind, path, base }`) named in `file` to a
// project-relative path: relative to the file, or to its package's root for a
// `concat!(env!("CARGO_MANIFEST_DIR"), …)` path; null when it escapes the bundle root, or the
// package when the file is a vendored crate's (boundaryOf).
function includeTarget(inc, file, ctx) {
  const dir = inc.base === 'manifest' ? ctx?.packageInfo(file)?.dir ?? null : posix.dirname(file)
  if (dir === null) return null
  const rel = normalizeRel(dir, inc.path)
  if (rel === null || !withinDir(rel, boundaryOf(file, ctx))) {
    console.warn(`[loader.rust] Refusing include outside its package: ${inc.path} from ${file}`)
    return null
  }
  return rel
}

// Every file a `mod` declaration can denote, as `{ cfg, file, explicit }`: an unconditional
// `#[path]` names one outright; otherwise each `#[cfg_attr(<pred>, path = …)]` names one under
// its predicate (`cfg`), and the default `<name>.rs`/`<name>/mod.rs` lookup is the fallback (`cfg`
// null). A variant whose predicate can't hold in the build is dropped: the scanner already did so
// for the build it scanned under, and `opts.features` / `opts.test` / `opts.target`, when given,
// describe one here. `explicit` marks a file a `#[path]` named (its own submodules then sit
// beside it). The inline modules the declaration sits in contribute their directories
// (`inlineDirs`: an inline module's own `#[path]` replaces its name, an empty one adds nothing),
// else their names.
export function resolveModDecl(decl, fromFile, opts = {}) {
  const o = { ...opts, inlinePath: decl.inlineDirs ?? decl.inlinePath }
  const env = opts.features === undefined && opts.test === undefined && opts.target === undefined
    ? null
    : { features: opts.features ?? null, test: opts.test === true, target: opts.target ?? null }
  const unconditional = decl.paths.find((p) => p.cfg === null)
  if (unconditional) {
    const file = resolveExplicitModPath(unconditional.path, fromFile, o)
    return file ? [{ cfg: null, file, explicit: true }] : []
  }
  const out = []
  for (const { path, cfg } of decl.paths) {
    if (env !== null && evalCfg(cfg, env) === false) continue
    const file = resolveExplicitModPath(path, fromFile, o)
    if (file && !out.some((x) => x.file === file)) out.push({ cfg, file, explicit: true })
  }
  // A variant that always applies (`decl.noDefault`) leaves no build for the default lookup.
  const fallback = decl.noDefault === true ? null : resolveModPath(decl.name, fromFile, o)
  if (fallback && !out.some((x) => x.file === fallback)) out.push({ cfg: null, file: fallback, explicit: false })
  return out
}

// Resolve a crate name to its vendored root (`vendor/<dir>/src/lib.rs`) among already-loaded
// sources, or null. `use` names underscore but the vendor dir may hyphenate, so try both.
export function resolveVendoredCrate(crateName, { knownSources } = {}) {
  const norm = normName(crateName)
  for (const dir of norm.includes('_') ? [norm, norm.replaceAll('_', '-')] : [norm]) {
    const lib = `${VENDOR_DIR}/${dir}/src/lib.rs`
    if (knownSources?.has(lib)) return lib
  }
  return null
}

// --- Module trees -----------------------------------------------------------------------

// The files walked as crate roots: every file named main.rs/lib.rs (a vendored crate's root, the
// lib beside a bin, …), every file a manifest names as its lib target (`[lib] path =
// "src/other.rs"`, given a Cargo context), then every explicit root (entry) that was loaded. Roots
// by name/manifest come first so their trees claim the files they reach (buildModuleTrees) before
// a glob-listed module file, an entry only by role, claims itself.
export function crateRoots(sources, explicit = [], cargo = null) {
  const roots = new Set()
  for (const path of sources.keys()) {
    if (isNamedRoot(path) || cargo?.isLibRoot(path) === true) roots.add(path)
  }
  for (const r of explicit) if (sources.has(r)) roots.add(r)
  return roots
}

// One module tree per crate root -- `trees`: root file → Map<modulePath, file> -- built by
// following `mod` edges breadth-first from `crate`, plus `files`: file → `{ root, modulePath }`
// (first root to reach a file claims it). A file is reached under one module path per `mod` spec
// (`mod a::b` for a declaration inside inline module `a`); a cfg-variant Map target contributes
// every variant under the same path, the first naming the module's file in the tree.
// `inlineModules` (file → the paths of its inline `mod x { … }` blocks, from scanRustItems) puts
// those modules in the tree too, owned by the file holding them -- unless a `mod` of the same
// name names a file (`#[cfg(unix)] mod imp;` beside `#[cfg(not(unix))] mod imp { … }`): the file
// is the more telling target, the inline body's is where the path was written anyway. Each file's
// entry also carries `leaves`, the cfg leaves (cfgLeaves) of every `mod` on the way down to it --
// the declaration's own cfg and the gate macro it sits in (`mountCfgs`: file → spec → target
// file → its declarations' `{ cfg, macro }`; a file declared under several is compiled under any
// one of them: an `any` leaf, see cfgLeaves and gateLeaves; `gatesOf`: file → the gate macros
// of its package, see gateLeaves) and, for a `mod` with several files, a `variant` leaf naming
// which (two variants of one `mod` never both apply) -- and `parent`, the file that mounted it.
export function buildModuleTrees(sources, resolutions, roots, inlineModules = null, mountCfgs = null, gatesOf = null) {
  const trees = new Map()
  const files = new Map()
  const variantsOf = (target) => (target instanceof Map ? [...target] : [['*', target]])
  const mountLeaves = (decls, path) => (decls === undefined ? [] : anyOf(decls.map(({ cfg, macro, via }) => [...cfgLeaves(cfg), ...gateLeaves(macro, gatesOf?.(path)), ...mountLeaves(via, path)])))
  const mounted = (path, spec, sub, key, file, several, leaves) => [
    ...leaves,
    ...mountLeaves(mountCfgs?.get(path)?.get(spec)?.get(file), path),
    ...(several ? [{ key: 'variant', site: sub, value: key.replace(/#\d+$/u, ''), neg: false }] : []),
  ]
  for (const root of roots) {
    if (!sources.has(root)) continue
    const tree = new Map([['crate', root]])
    trees.set(root, tree)
    const seen = new Set()
    const queue = [[root, 'crate', 0, [], null]]
    for (let qi = 0; qi < queue.length; qi++) {
      const [path, modulePath, depth, leaves, parent] = queue[qi]
      if (!files.has(path)) files.set(path, { root, modulePath, leaves, parent })
      if (seen.has(path) || depth >= MAX_MODULE_DEPTH) continue
      seen.add(path)
      // Module files first, then the inline modules that hold nested declarations, then the other
      // inline modules: a `mod imp;` file beats a `mod imp { … }` of the same name however the
      // declarations are ordered.
      const specs = [...(resolutions.get(path) ?? [])]
      for (const [spec, target] of specs) {
        if (!spec.startsWith('mod ')) continue
        const parts = spec.slice(4).split('::')
        if (parts.length > 1) continue
        const sub = `${modulePath}::${parts[0]}`
        const variants = variantsOf(target)
        for (const [key, file] of variants) {
          if (!tree.has(sub)) tree.set(sub, file)
          queue.push([file, sub, depth + 1, mounted(path, spec, sub, key, file, variants.length > 1, leaves), path])
        }
      }
      for (const [spec, target] of specs) {
        // An `include!`d file's tokens are this module's: it is walked under the same module path.
        if (spec.startsWith('include ')) {
          queue.push([target, modulePath, depth + 1, leaves, path])
          continue
        }
        if (!spec.startsWith('mod ')) continue
        const parts = spec.slice(4).split('::')
        if (parts.length === 1) continue
        // `mod a::b::name`: `a` and `a::b` are inline modules whose bodies live in this file, so
        // paths into them (`a::b::x`, `super::` from `name`) resolve to it.
        for (let k = 1; k < parts.length; k++) {
          const inline = `${modulePath}::${parts.slice(0, k).join('::')}`
          if (!tree.has(inline)) tree.set(inline, path)
        }
        const sub = `${modulePath}::${spec.slice(4)}`
        const variants = variantsOf(target)
        for (const [key, file] of variants) {
          if (!tree.has(sub)) tree.set(sub, file)
          queue.push([file, sub, depth + 1, mounted(path, spec, sub, key, file, variants.length > 1, leaves), path])
        }
      }
      for (const inline of inlineModules?.get(path) ?? []) {
        for (let k = 1; k <= inline.length; k++) {
          const key = `${modulePath}::${inline.slice(0, k).join('::')}`
          if (!tree.has(key)) tree.set(key, path)
        }
      }
    }
  }
  return { trees, files }
}

// The crate a path's lead may name: null for a path keyword or a sysroot crate, and -- unless the
// path is absolute (`::name::…`) -- for a name the file imported (`bindings`: `use std::io;
// io::stdin()` names no crate `io`).
const crateLead = ({ segments, absolute }, bindings) => {
  const head = segments[0]
  return head === undefined || NON_CRATE_LEADS.has(head) || (!absolute && bindings.has(head)) ? null : head
}

// --- Path resolution ------------------------------------------------------------------------
//
// A path is resolved against its crate's module tree, module by module. Where a segment names no
// module of the one reached, the imports written in that module may provide the name: a `use`
// binding it outright, or a glob (`pub use inner::*`) when the module the glob names -- one of
// this crate -- provides it in turn. What a name leads to is a property of (module, name) and of
// how much of the module's imports the asking module may see, so it is computed once per crate
// and shared by every path resolved (`ctx.provided`): resolution stays linear in the number of
// paths, whatever the fan-out of the crate's re-exports.
//
// Results: `{ kind: 'module', modulePath, file }` for a module of the crate; `{ kind: 'item',
// file }` for anything else the crate's files hold (an item of the module reached, a name a
// `use` brought in from the sysroot -- as far as the bundle is concerned it lives where the `use`
// is); `{ kind: 'crate', name, file }` for another in-tree crate; null when nothing here answers.
// A result that went through an import at the top level carries `via: { modulePath, consumed,
// through }`: the module whose import was followed first, how many of the path's own segments
// named modules up to it, and the file holding that import.

// The module a visibility (scanRustItems' `vis`) written in module `modulePath` reaches: the
// crate root for `pub` / `pub(crate)`, the module itself for a private item or `pub(self)`, its
// parent for `pub(super)`, the ancestor a `pub(in …)` names (`crate::a`, `super::…`, `self`) --
// when it is one; rustc rejects any other, so that reads as `crate`.
function visibilityScope(vis, modulePath) {
  if (vis === null || vis === 'self') return modulePath
  if (vis === 'crate') return 'crate'
  const parent = modulePath.includes('::') ? modulePath.slice(0, modulePath.lastIndexOf('::')) : 'crate'
  if (vis === 'super') return parent
  const segments = vis.slice(3).split('::')
  let cur
  if (segments[0] === 'crate') cur = ['crate']
  else if (segments[0] === 'self') cur = modulePath.split('::')
  else if (segments[0] === 'super') cur = parent.split('::')
  else return 'crate'
  let i = 1
  while (segments[i] === 'super' && cur.length > 1) {
    cur.pop()
    i++
  }
  const scope = [...cur, ...segments.slice(i)].join('::')
  return modulePath === scope || modulePath.startsWith(`${scope}::`) ? scope : 'crate'
}

// --- cfg compatibility -----------------------------------------------------------------------
//
// Which of a module's several files, imports or glob sources a path written under some cfgs can
// mean: libc's `crate::c_int` from a file under `#[cfg(unix)] mod unix;` is not the one
// `#[cfg(target_os = "fuchsia")] pub use fuchsia::*;` brings in, mio's `sys::Waker` from a file in
// one `cfg_if!` branch is not the `pub use` in another. Each file carries the leaves of the cfgs
// it was mounted under (buildModuleTrees), each import and item those of its own cfg on top; two
// leaf sets that can't hold together are exclusive, and such a candidate is skipped.

// The conjunctive leaves of a cfg predicate, `{ key, value, neg }`: `all(unix, not(feature =
// "std"))` → `unix` and `!feature="std"`; `not(any(a, b))` → `!a`, `!b`. An `any(…)` of
// alternatives that each decide something is one leaf, `{ key: 'any', alts }`, holding when any
// alternative (a conjunction of leaves) does -- `any(target_os = "linux", target_os = "l4re")`
// can't hold along with `target_os = "aix"` -- as is a negated `all(…)`; one with an alternative
// that decides nothing (`any(unix, libc_core_cvoid)`) decides nothing itself.
function cfgLeaves(pred) {
  if (pred === null || pred === undefined) return []
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    const kv = /^([\w-]+)\s*(?:=\s*"([^"]*)")?$/u.exec(p)
    return kv ? [{ key: kv[1], value: kv[2] ?? null, neg: false }] : []
  }
  const parts = splitTopLevel(m[2]).filter((part) => part.trim() !== '').map(cfgLeaves)
  if (m[1] === 'all') return parts.flat()
  if (m[1] === 'any') return anyOf(parts)
  return parts.length === 1 ? negated(parts[0]) : []
}
// The leaves holding when any of `alts` (conjunctions) does: the one alternative when there is
// one (the same twice counts once), an `any` leaf of them, nothing when one decides nothing.
const anyOf = (alts) => {
  const uniq = new Map()
  for (const alt of alts) {
    if (alt.length === 0) return []
    uniq.set(alt.map(leafKey).toSorted().join('&'), alt)
  }
  const list = [...uniq.values()]
  if (list.length <= 1) return list[0] ?? []
  return [{ key: 'any', value: null, neg: false, alts: list }]
}
// The leaves of a conjunction's negation: one leaf flips, an `any` leaf's negation is every
// alternative's, several leaves negate to any of their negations.
const negated = (leaves) => {
  if (leaves.length === 0) return []
  if (leaves.length > 1) return anyOf(leaves.map((l) => negated([l])))
  const [l] = leaves
  return l.alts === undefined ? [{ ...l, neg: !l.neg }] : l.alts.flatMap(negated)
}

// A cfg gate macro: `cfg_<x>!` (tokio's `cfg_io_uring! { … }`, mio's `cfg_os_poll! { … }`)
// wraps each item of its body in the cfg its definition writes -- `($($item:item)*) => { $(
// #[cfg(feature = "rt")] $item )* }` -- read from that definition (gatePredicate); `cfg_if!` is
// read branch by branch, any other macro's body is no gate.
const GATE_MACRO_RE = /^cfg_(?!if$)\w+$/u
// The cfg a gate macro's definition puts on what it wraps: the `#[cfg(…)]` attributes of its
// transcribers (their conjunction), when every arm writes the same ones; null when an arm writes
// none or the arms differ -- a gate the loader can't see into. `code` and `masked` are the lexed
// views, `open`/`close` the braces of the `macro_rules!` body.
function gatePredicate(code, masked, open, close) {
  let seen = null
  for (let i = masked.indexOf('=>', open); i !== -1 && i < close; i = masked.indexOf('=>', i + 2)) {
    let start = i + 2
    while (/\s/u.test(masked[start] ?? '')) start++
    if (!'{(['.includes(masked[start] ?? ' ')) continue
    const end = matchClose(masked, start)
    const preds = []
    for (const m of masked.slice(start, end).matchAll(/#\s*\[\s*cfg\s*\(/gu)) {
      const paren = start + m.index + m[0].length - 1
      preds.push(normalizeCfg(code.slice(paren + 1, matchClose(masked, paren))))
    }
    if (preds.length === 0) return null
    const uniq = [...new Set(preds)].toSorted()
    const pred = uniq.length === 1 ? uniq[0] : `all(${uniq.join(', ')})`
    if (seen !== null && seen !== pred) return null
    seen = pred
    i = end
  }
  return seen
}
// The leaves of what a gate macro's body declares: its definition's cfg (`gates`: macro name →
// predicate, null when unreadable, see gatePredicate), else a leaf of its own name -- which holds
// along with anything and is never certain: `cfg_x!` and `cfg_not_x!` are not taken for each
// other's negation by their names alone.
function gateLeaves(macro, gates = null) {
  if (macro === null || macro === undefined || !GATE_MACRO_RE.test(macro)) return []
  const pred = gates?.get(macro)
  return typeof pred === 'string' ? cfgLeaves(pred) : [{ key: `${macro}!`, value: null, neg: false }]
}

// Keys a target has one value of: `target_os = "linux"` and `target_os = "macos"` never both hold
// (`feature`, `target_family` and `target_has_atomic` may take several).
const SINGLE_VALUED_CFG_KEYS = new Set(['target_os', 'target_arch', 'target_env', 'target_vendor', 'target_abi', 'target_pointer_width', 'target_endian', 'panic'])
// Operating systems whose targets are not `unix`.
const NON_UNIX_OS = new Set(['windows', 'none', 'uefi', 'wasi', 'solana', 'cuda', 'xous', 'zkvm', 'psp', 'unknown'])
const isWindowsLeaf = (l) => (l.key === 'windows' && l.value === null) || ((l.key === 'target_os' || l.key === 'target_family') && l.value === 'windows')
const isUnixLeaf = (l) => (l.key === 'unix' && l.value === null) || (l.key === 'target_family' && l.value === 'unix')

// Whether two leaf lists (conjunctions) can't hold at once: a leaf and its negation; two values of
// a single-valued key; two variants of one `mod` (`variant` leaves, see buildModuleTrees); Windows
// against unix; an `any` leaf none of whose alternatives can hold with the other. Asked once per
// pair of leaf sets (compatible), over what `prepared` gathers of each list.
function cfgExclusive(a, b) {
  const pa = prepared(a)
  const pb = prepared(b)
  for (const k of pa.negKeys) if (pb.keys.has(k)) return true
  for (const [k, v] of pa.values) {
    const w = pb.values.get(k)
    if (w !== undefined && w !== v) return true
  }
  if ((pa.windows && (pb.unix || pb.otherOs)) || (pb.windows && (pa.unix || pa.otherOs)) || (pa.unix && pb.nonUnixOs) || (pb.unix && pa.nonUnixOs)) return true
  for (const x of pa.anys) if (x.alts.every((alt) => cfgExclusive(alt, b))) return true
  for (const y of pb.anys) if (y.alts.every((alt) => cfgExclusive(a, alt))) return true
  return false
}
// What cfgExclusive asks of a leaf list, gathered once and kept on it: its plain leaves' keys and
// their negations', the value each positive single-valued key (and `mod` variant site) takes --
// `MANY` for several, which nothing holds along with -- its Windows / unix standing (a
// `target_os` other than windows, `otherOs`; one of the non-unix ones, `nonUnixOs`) and its `any`
// leaves.
const MANY = Symbol('many')
function prepared(leaves) {
  if (leaves.prep !== undefined) return leaves.prep
  const prep = { keys: new Set(), negKeys: [], values: new Map(), anys: [], windows: false, unix: false, otherOs: false, nonUnixOs: false }
  for (const l of leaves) {
    if (l.alts !== undefined) {
      prep.anys.push(l)
      continue
    }
    const k = leafKey(l)
    prep.keys.add(k)
    prep.negKeys.push(l.neg ? k.slice(1) : `!${k}`)
    if (l.neg) continue
    if (l.value !== null && (SINGLE_VALUED_CFG_KEYS.has(l.key) || l.key === 'variant')) {
      const site = l.key === 'variant' ? `variant@${l.site}` : l.key
      prep.values.set(site, prep.values.has(site) && prep.values.get(site) !== l.value ? MANY : l.value)
    }
    if (isWindowsLeaf(l)) prep.windows = true
    if (isUnixLeaf(l)) prep.unix = true
    if (l.key === 'target_os' && l.value !== null) {
      if (l.value !== 'windows') prep.otherOs = true
      if (NON_UNIX_OS.has(l.value)) prep.nonUnixOs = true
    }
  }
  leaves.prep = prep
  return prep
}

// A stable text for one leaf; an `any` leaf's names its alternatives.
const leafKey = (l) => (l.alts === undefined ? `${l.neg ? '!' : ''}${l.key}${l.site === undefined ? '' : `@${l.site}`}${l.value === null ? '' : `=${l.value}`}` : `any(${l.alts.map((alt) => alt.map(leafKey).toSorted().join('&')).toSorted().join(',')})`)

// Leaf sets are interned per tree (`sets`: key → `{ leaves, key }`), one object per distinct set:
// the union of the cfgs along a chain of globs stays small however long the chain, and the
// compatibility verdict for a pair of sets is looked up by key, not computed again.
const NO_LEAVES = { leaves: [], key: '' }
function leafSet(leaves, sets) {
  if (leaves.length === 0) return NO_LEAVES
  const uniq = new Map()
  for (const l of leaves) uniq.set(leafKey(l), l)
  const key = [...uniq.keys()].toSorted().join('|')
  return sets.get(key) ?? sets.set(key, { leaves: [...uniq.values()], key }).get(key)
}
// A union is asked for again and again along a closure (a glob's leaves with each candidate's): kept
// on the first set, by the second's key.
const unionLeaves = (a, b, sets) => {
  if (a.key === '') return b
  if (b.key === '' || b.key === a.key) return a
  const unions = (a.unions ??= new Map())
  return unions.get(b.key) ?? unions.set(b.key, leafSet([...a.leaves, ...b.leaves], sets)).get(b.key)
}
// The leaves holding when either of two sets does (a module two glob paths reach): an `any` of
// the two -- of their alternatives, when one is an `any` leaf already.
const eitherLeaves = (a, b, sets) => {
  if (a.key === b.key) return a
  if (a.key === '' || b.key === '') return NO_LEAVES
  const altsOf = (s) => (s.leaves.length === 1 && s.leaves[0].alts !== undefined ? s.leaves[0].alts : [s.leaves])
  return leafSet(anyOf([...altsOf(a), ...altsOf(b)]), sets)
}

// The leaf set of an `asker` -- `{ file, set, keys, compat, sure, doubt }`, the file a path was
// written in, its set the leaves it was mounted under plus, when the build's target is known, the
// target's cfgs (`unix`, `target_os = "linux"`, …: what every file of the build is compiled
// under) -- against a candidate's: exclusive candidates are skipped; no asker (an internal query)
// skips nothing. The verdict is kept per pair of sets in `compat`, shared by the askers of one set.
const compatible = (asker, set) => {
  if (asker === undefined || set.key === '') return true
  let verdict = asker.compat.get(set.key)
  if (verdict === undefined) {
    verdict = !cfgExclusive(asker.set.leaves, set.leaves)
    asker.compat.set(set.key, verdict)
  }
  return verdict
}
// Whether a leaf list can't hold in the asker's build (scanRustItems' build, see buildOf): one of
// its leaves the build decides is false -- a feature that is off, a platform the build isn't --
// or an `any` leaf each of whose alternatives is. What a gate macro's cfg wraps (tokio's
// `cfg_rt! { … }` with `rt` off) is then taken last (`dead`, see pick): after any candidate the
// build may compile, and only when there is none -- a path written behind the same gate, whose
// code the build doesn't compile either, means what it would mean where it compiles. For an
// asker whose own leaves can't hold (`deadHere`) the build says nothing.
const EVALUABLE_CFG_KEYS = new Set([...TARGET_CFG_KEYS, 'feature', 'test', 'doc', 'doctest'])
const leafFalse = (l, build) => {
  if (l.alts !== undefined) return l.alts.every((alt) => alt.some((m) => leafFalse(m, build)))
  if (!EVALUABLE_CFG_KEYS.has(l.key)) return false
  const pred = l.value === null ? l.key : `${l.key} = "${l.value}"`
  return evalCfg(l.neg ? `not(${pred})` : pred, build) === false
}
const deadUnder = (leaves, build) => build !== undefined && leaves.some((l) => leafFalse(l, build))
const deadFor = (asker, set) => {
  if (asker === undefined || asker.deadHere || set.key === '') return false
  let verdict = asker.dead.get(set.key)
  if (verdict === undefined) {
    verdict = deadUnder(set.leaves, asker.build)
    asker.dead.set(set.key, verdict)
  }
  return verdict
}
// Whether every leaf of a candidate's set is among the asker's own (`keys`, by leafKey): the two
// are certainly compiled together, not merely possibly (compatible). libc's aix/mod.rs, mounted
// under `target_os = "aix"`, asks `crate::fsid_t`: the aix glob's, under that same leaf, is the
// answer, rather than the first platform's whose cfg is an `any(…)` nothing rules out. Kept per
// pair in `sure`. An `any` leaf holds when one of its alternatives does, and so does the negation
// of a custom cfg (`not(loom)`: presumably off, see doubtful). An asker under no cfg holds nothing
// else: for it, candidates under cfgs of their own are each only maybe the answer, and all of
// them are (see withAlternatives), not the first in written order.
const holds = (l, keys, custom) => keys.has(leafKey(l)) || (l.alts === undefined ? l.neg && custom(l.key) : l.alts.some((alt) => alt.every((m) => holds(m, keys, custom))))
const entailed = (asker, set) => {
  if (asker === undefined || set.key === '') return true
  let verdict = asker.sure.get(set.key)
  if (verdict === undefined) {
    verdict = set.leaves.every((l) => holds(l, asker.keys, asker.custom))
    asker.sure.set(set.key, verdict)
  }
  return verdict
}
// The cfgs rustc and cargo set: anything else in a positive leaf is a custom `--cfg` (`loom`,
// `docsrs`, `tokio_unstable`, mio's `mio_unsupported_force_poll_poll`), off in a default build
// unless a build script or the rustflags set it -- so a candidate under one is `doubtful`: taken
// after a compatible candidate under none (never ruled out: the loader doesn't know the build's
// flags). One the asker's package may set (its build script prints `cargo:rustc-cfg=<name>`, a
// rustflags `--cfg` names it: cargo.js cfgsSetFor) is no custom cfg for it: neither doubtful nor
// presumed off; nor is any when its build script may print one the loader can't read (`asker.
// custom`, see customFor). An `any` leaf is doubtful when each alternative is, or can't hold with
// the asker. A gate macro's leaf (`cfg_x!`) and a `mod` variant's are neither, nor is a leaf the
// asker holds itself (a file under `#[cfg(loom)]` takes the loom candidates).
const KNOWN_CFG_KEYS = new Set([...TARGET_CFG_KEYS, 'feature', 'test', 'doctest', 'doc', 'debug_assertions', 'overflow_checks', 'panic', 'proc_macro', 'miri', 'sanitize', 'target_feature', 'target_thread_local', 'ub_checks', 'relocation_model', 'fmt_debug', 'clippy', 'rustfmt', 'variant'])
const customKey = (key) => !KNOWN_CFG_KEYS.has(key) && !key.endsWith('!')
// The custom-cfg test of an asker whose build may set `settable` (`{ names, any }`), one per object.
const customMemo = new WeakMap()
const NO_CUSTOM = () => false
const customFor = (settable) => {
  if (settable === undefined || settable === null) return customKey
  if (settable.any) return NO_CUSTOM
  if (settable.names.size === 0) return customKey
  if (!customMemo.has(settable)) customMemo.set(settable, (key) => customKey(key) && !settable.names.has(key))
  return customMemo.get(settable)
}
const doubtfulLeaf = (l, askerLeaves, custom) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.every((alt) => cfgExclusive(alt, askerLeaves) || alt.some((m) => doubtfulLeaf(m, askerLeaves, custom))))
// Whether a leaf list has any custom cfg at all -- else no asker finds it doubtful (kept on the
// set for the plain test, which most askers share).
const hasCustom = (leaves, custom) => leaves.some((l) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.some((alt) => hasCustom(alt, custom))))
const doubtful = (asker, set) => {
  if (asker === undefined || set.key === '') return false
  if (set.custom === undefined) set.custom = hasCustom(set.leaves, customKey)
  if (!set.custom) return false
  let verdict = asker.doubt.get(set.key)
  if (verdict === undefined) {
    verdict = set.leaves.some((l) => !holds(l, asker.keys, asker.custom) && doubtfulLeaf(l, asker.set.leaves, asker.custom))
    asker.doubt.set(set.key, verdict)
  }
  return verdict
}

// --- memoization -----------------------------------------------------------------------------

// Memoization with cycle detection (globClosure; the same bookkeeping serves globSource, pick and
// the candidate lists). A query asked again while it is being computed -- an import cycle: a
// glob into a module whose own globs lead back -- reads as `empty`, and the entry in progress is
// marked hit (`ctx.hits`, by its depth on the stack of computations under way, `ctx.walking`).
// Whatever is computed on top of such a read may be short and is not kept, so a later query from
// elsewhere in the cycle computes it afresh. The entry that was hit is kept once complete, but
// may be short itself (it read nothing for its own name) -- it is marked `cyclic`, with its
// `compute`, for stabilizeClosures to run again once every entry is in place.
function memoized(memo, key, ctx, compute, { empty }) {
  const hit = memo.get(key)
  if (hit !== undefined) {
    if (hit.depth !== undefined) {
      ctx.hits.add(hit.depth)
      return empty
    }
    return hit.value
  }
  const depth = ctx.walking++
  memo.set(key, { depth })
  const value = compute()
  const cyclic = ctx.hits.delete(depth)
  ctx.walking--
  if (minHit(ctx) < depth) memo.delete(key)
  else memo.set(key, cyclic ? { value, cyclic, compute } : { value })
  return value
}

// Recompute the glob closures that were computed short of a cycle (memoized), each against the
// others as they now stand, until none grows: with every entry complete, a closure is the union
// of its globs' targets and their settled closures, whatever the order the queries came in. The
// lookups made meanwhile (glob sources, imports' answers, candidate lists) are dropped first, as
// they may rest on the short closures. True when anything changed -- the paths resolved so far must be resolved
// again.
function stabilizeClosures(ctx) {
  const cyclic = []
  for (const memo of ctx.closures.values()) for (const entry of memo.values()) if (entry.cyclic === true) cyclic.push(entry)
  if (cyclic.length === 0) return false
  const reset = () => {
    ctx.provided.clear()
    ctx.opaque.clear()
    ctx.opaqueGlobs.clear()
    for (const byModule of ctx.imports.values()) {
      for (const of of byModule.values()) {
        for (const im of [...of.globs, ...[...of.named.values()].flat()]) {
          delete im.source
          delete im.answers
        }
      }
    }
  }
  let changed = false
  for (let round = 0; round < MAX_STABILIZE_ROUNDS; round++) {
    reset()
    let grew = false
    for (const entry of cyclic) {
      const again = entry.compute()
      if (again.length !== entry.value.length) {
        entry.value = again
        grew = true
      }
    }
    if (!grew) break
    changed = true
  }
  reset()
  return changed
}
const MAX_STABILIZE_ROUNDS = 8

// The shallowest computation under way that was cycled back to, Infinity for none.
function minHit(ctx) {
  let min = Infinity
  for (const d of ctx.hits) if (d < min) min = d
  return min
}

// Number of leading module-path segments `a` and `b` share (`crate::a::b` / `crate::a::c` → 2).
function commonDepth(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  let depth = 0
  while (i < n && a[i] === b[i]) {
    if (a[i] === ':' && a[i + 1] === ':') {
      depth++
      i += 2
    } else {
      i++
    }
  }
  // The segment the match stopped in counts when it is whole in both: each ends there or goes on
  // with a `::`.
  const wholeA = i === a.length || a.startsWith('::', i)
  const wholeB = i === b.length || b.startsWith('::', i)
  return wholeA && wholeB ? depth + 1 : depth
}

// What the imports written in module `at` make of `name`, as seen from module `from` (`from`
// decides which imports apply: a `pub(in scope)` one to a path written inside `scope`, a plain
// `use` to one written in `at` or below). A `use` binding the name outright is followed (bound);
// else the modules of this crate the module's globs reach (globClosure) are searched for it, each
// as seen from the module whose glob named it: as a child module, an item it defines, or through
// a `use` of its own. A glob into the sysroot or into another crate provides nothing: it can't be
// told what it brings in, and claiming everything would hide the crate's own edges. `asker` is
// the file the path was written in, with its cfg leaves (see cfg compatibility): an import, item
// or glob source exclusive with them is passed over. The candidates are listed once per (at,
// name, what `from` may see) -- providedAll -- and the asker picks among them.
function provided(root, at, name, from, ctx, asker, typesOnly = false) {
  return pick(providedAll(root, at, name, commonDepth(from, at), ctx), root, ctx, asker, typesOnly) // scopes are ancestors of `at`: `from` is inside those this deep or shallower
}

// The answer of the first of `candidates` (see providedAll: in written order) whose cfgs the
// asker's entail (entailed) -- else the first compatible with them under no custom cfg, else the
// first compatible at all (doubtful) -- and, for a path's lead or
// prefix (`typesOnly`), in the type namespace: a `fn log` can't lead `log::info`. A child module,
// item or macro answers as it is; an import answers what it leads to (followImport, on the
// asker's behalf, so its cfgs hold along the whole chain), resolved when first asked and then
// kept on the import per asker -- unless the answer came out of an import cycle still being
// resolved (see memoized). An import being followed that is met again leads back to itself (`use
// log;` in every platform file of a module asks the module for `log`, which is these imports):
// nothing here. An import that leads nowhere the bundle can see is passed over, and -- when it is
// a path, not a crate named outright (`use serde;`) -- stands in as the last resort: the name is
// an item here, as far as the bundle knows. A value where a type is wanted (`typesOnly`: a `fn`
// defined here, an import of one) is passed over too, and when nothing else answers, the answer
// is VALUE_ONLY rather than nothing: the name is taken, but not in this namespace.
function pick(candidates, root, ctx, asker, typesOnly = false) {
  let unseen = null
  const maybes = [] // the compatible answers under no doubt, for when none is entailed (see withAlternatives)
  let doubted = null // the first compatible answer under a doubtful cfg, for when there is nothing else
  let lastResort = null // the first under a cfg the asker's build can't compile (see deadUnder)
  let valueOnly = false // a candidate passed over for being a value where a type is wanted
  for (let i = 0; ; i++) {
    const c = candidates.get(i)
    if (c === undefined) break
    if (!compatible(asker, c.leaves)) continue
    if (typesOnly && c.ns === 'value') {
      valueOnly = true
      continue
    }
    const dead = deadFor(asker, c.leaves)
    const doubt = !dead && doubtful(asker, c.leaves)
    const sure = !dead && !doubt && entailed(asker, c.leaves)
    if ((doubt || dead) && (maybes.length > 0 || doubted !== null)) continue
    if (dead && lastResort !== null) continue
    let r
    if (c.import === undefined) {
      r = c.answer
    } else {
      const im = c.import
      if (im.following !== undefined) {
        ctx.hits.add(im.following)
        continue
      }
      const key = `${asker?.set.key ?? ''}\0${typesOnly}`
      r = im.answers?.get(key)
      if (r === undefined) {
        const depth = ctx.walking++
        im.following = depth
        r = followImport(im, root, ctx, asker, typesOnly)
        im.following = undefined
        ctx.walking--
        ctx.hits.delete(depth)
        if (minHit(ctx) > depth) (im.answers ??= new Map()).set(key, r)
      }
      if (r === null) {
        if (im.segments.length > 1) unseen ??= c
        continue
      }
      if (r === VALUE_ONLY) {
        valueOnly = true
        continue
      }
    }
    if (sure) return { ...r, through: c.through }
    if (dead) lastResort = { ...r, through: c.through }
    else if (doubt) doubted = { ...r, through: c.through }
    else maybes.push({ answer: { ...r, through: c.through }, leaves: c.leaves })
  }
  if (maybes.length > 0) return withAlternatives(maybes, asker)
  if (doubted !== null) return doubted
  if (lastResort !== null) return lastResort
  if (unseen !== null) return { kind: 'item', file: unseen.import.file, through: unseen.through }
  return valueOnly ? VALUE_ONLY : null
}

// A leaf list as cfg text, for a key: `all(unix, feature = "std")`, `not(loom)`, `any(…)`, a gate
// macro by name (`cfg_x!`); a `mod` variant's leaf by the key of the variant (its cfg, or its
// macro), and only when nothing else tells the candidates apart. Null for no leaves.
const leafText = (l) => {
  if (l.alts !== undefined) return `any(${l.alts.map((alt) => cfgTextOf(alt) ?? '*').join(', ')})`
  const plain = l.value === null ? l.key : `${l.key} = "${l.value}"`
  return l.neg ? `not(${plain})` : plain
}
function cfgTextOf(leaves) {
  const own = leaves.filter((l) => l.key !== 'variant')
  // What a variant is, rather than all it isn't: its positive leaves (a `cfg_if!` branch's own
  // cfg, not the negations of the branches before it), else its `any(…)` of positive ones.
  const positive = own.filter((l) => l.alts === undefined && !l.neg)
  const anyPositive = own.filter((l) => l.alts !== undefined && l.alts.every((alt) => alt.every((m) => m.alts === undefined && !m.neg)))
  const shown = positive.length + anyPositive.length > 0 ? [...positive, ...anyPositive] : (own.length > 0 ? own : leaves)
  if (shown.length === 0) return null
  const texts = [...new Set(shown.map((l) => (l.key === 'variant' ? l.value : leafText(l))))].toSorted()
  return texts.length === 1 ? texts[0] : `all(${texts.join(', ')})`
}

// The answer of several candidates none of which the asker's cfgs entail (pick, definedIn): each
// applies under cfgs of its own -- a file under no platform cfg asking libc's `crate::sockaddr`,
// defined per platform -- so the first in written order is no answer. The first, carrying
// `alternatives`: cfg key → file, each distinct file under the leaves of its first candidate
// that the asker doesn't hold itself (a module a path goes on through takes the first; only a
// path's target is recorded as the lot). One file, or a module first: that answer alone.
function withAlternatives(found, asker) {
  const [first] = found
  const files = new Set(found.map((f) => f.answer.file).filter((f) => f !== undefined))
  if (found.length === 1 || files.size < 2 || first.answer.kind === 'module') return first.answer
  const alternatives = new Map()
  const seen = new Set()
  for (const { answer, leaves } of found) {
    if (answer.file === undefined || seen.has(answer.file)) continue
    seen.add(answer.file)
    const base = cfgKey(cfgTextOf(leaves.leaves.filter((l) => asker === undefined || !asker.keys.has(leafKey(l)))))
    let key = base
    for (let k = 2; alternatives.has(key); k++) key = `${base}#${k}`
    alternatives.set(key, answer.file)
  }
  return { ...first.answer, alternatives }
}

// Every candidate module `at`'s imports offer for `name` as seen `seeing` levels into it, in
// written order -- `{ answer | import, through, leaves }`: what its `use` items bind (as imports
// to follow, see pick), then what each module its globs reach has (hasAll), under the glob's cfg
// leaves too. The list depends on the crate's structure alone, so it is built once per (at,
// name, seeing) and shared by every asker, who picks the first candidate compatible with its own
// cfgs -- and built lazily (Lazy): a closure holds hundreds of modules, and the first few usually
// answer. A list built while the closure was still being resolved (an import cycle, see
// memoized) is not kept.
function providedAll(root, at, name, seeing, ctx) {
  const memo = ctx.provided.get(root) ?? ctx.provided.set(root, new Map()).get(root)
  const key = `${at}\0${name}\0${seeing}`
  let list = memo.get(key)
  if (list === undefined) {
    const depth = ctx.walking++
    const closure = globClosure(root, at, seeing, ctx)
    ctx.walking--
    list = new Lazy(function* () {
      yield* importsOf(root, at, name, seeing, ctx)
      // Of the closure's modules (hundreds, in libc), only the ones with something of the name
      // (`having`), in closure order.
      const having = ctx.having.get(root)?.get(name)
      if (having === undefined) return
      const positions = []
      for (const module of having) for (const i of closureIndex(closure).get(module) ?? NONE) positions.push(i)
      for (const i of positions.toSorted((x, y) => x - y)) {
        const reached = closure[i]
        for (const c of hasAll(root, reached.module, name, reached.seeing, ctx)) yield { ...c, through: reached.through, leaves: unionLeaves(reached.leaves, c.leaves, ctx.leafSets) }
      }
    }(), ctx)
    if (minHit(ctx) >= depth) memo.set(key, list)
  }
  return list
}

// A closure's entries by module (one may be reached at several depths), kept on the closure.
function closureIndex(closure) {
  if (closure.index === undefined) {
    closure.index = new Map()
    closure.forEach((e, i) => (closure.index.get(e.module) ?? closure.index.set(e.module, []).get(e.module)).push(i))
  }
  return closure.index
}

// A list materialized from a generator as far as it is read (`get(i)`, undefined past the end).
// Read again while its generator is producing an element (the element's own lookups led back to
// the same question), it ends there for that reader, and the computation under way is marked hit
// (see memoized) so nothing computed on that short view is kept.
class Lazy {
  constructor(gen, ctx) {
    this.gen = gen
    this.ctx = ctx
    this.out = []
    this.running = -1
  }

  get(i) {
    if (this.running !== -1) {
      this.ctx.hits.add(this.running)
      return undefined
    }
    while (i >= this.out.length) {
      this.running = this.ctx.walking
      let next
      try {
        next = this.gen.next()
      } finally {
        this.running = -1
      }
      if (next.done) return undefined
      this.out.push(next.value)
    }
    return this.out[i]
  }

  * [Symbol.iterator]() {
    for (let i = 0; ; i++) {
      const c = this.get(i)
      if (c === undefined) return
      yield c
    }
  }
}

// Everything module `at` has under `name` for one seeing `seeing` levels into it -- what a glob
// into the module brings in -- as candidates in written order: a child module (visible that far),
// the items it defines (the module's own tree file first: an inline `mod imp { }` under one cfg
// beside a `mod imp;` file under another may both define it), at the crate root a `#[macro_export]`
// macro (an item of the root's namespace: zerocopy's `use super::*;` from the root brings
// `into_inner!` in), and its `use` items binding the name (importsOf).
function hasAll(root, at, name, seeing, ctx) {
  // Asked for every module a closure reaches, most of which have nothing of the name.
  const child = ctx.children.get(root)?.get(at)?.has(name) === true
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  const macro = at === 'crate' ? ctx.macros.get(root)?.get(name) : undefined
  const imports = importsOf(root, at, name, seeing, ctx)
  if (!child && defs === undefined && macro === undefined && imports.length === 0) return NONE
  const out = []
  if (child) {
    const sub = `${at}::${name}`
    if ((ctx.modScope.get(root)?.get(sub) ?? 1) <= seeing) out.push({ answer: { kind: 'module', modulePath: sub, file: ctx.trees.get(root).get(sub) }, leaves: NO_LEAVES })
  }
  if (defs !== undefined) {
    const own = ctx.trees.get(root).get(at)
    for (const d of defs) if (d.scopeDepth <= seeing && d.file === own) out.push({ answer: { kind: 'item', file: d.file }, leaves: d.leaves, ns: d.ns })
    for (const d of defs) if (d.scopeDepth <= seeing && d.file !== own) out.push({ answer: { kind: 'item', file: d.file }, leaves: d.leaves, ns: d.ns })
  }
  if (macro !== undefined) out.push({ answer: { kind: 'item', file: macro }, leaves: NO_LEAVES })
  out.push(...imports)
  return out
}
const NONE = Object.freeze([])

// The file in which module `at` defines item `name` (a `struct`, `fn`, … visible `seeing` levels
// in, under cfgs the asker's allow; in the type namespace when `typesOnly`, see pick), or null --
// or `{ file, alternatives }` when several files define it, none for certain (see
// withAlternatives; itemAt makes an answer of either).
function definedIn(root, at, name, seeing, ctx, asker, typesOnly = false) {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  if (defs === undefined) return null
  const own = ctx.trees.get(root).get(at)
  // Ranked as pick ranks candidates -- sure, then compatible under no custom cfg, then doubtful,
  // then dead in the asker's build -- the module's own tree file first within a rank, else the
  // first written.
  // Several of the middle rank, none sure: each applies under its own cfgs (see withAlternatives).
  let best = null
  let bestRank = Infinity
  const maybes = []
  for (const d of defs) {
    if (d.scopeDepth > seeing || !compatible(asker, d.leaves) || (typesOnly && d.ns === 'value')) continue
    const tier = deadFor(asker, d.leaves) ? 3 : (doubtful(asker, d.leaves) ? 2 : (entailed(asker, d.leaves) ? 0 : 1))
    if (tier === 1) maybes.push({ answer: { kind: 'item', file: d.file }, leaves: d.leaves })
    const rank = tier * 2 + (d.file === own ? 0 : 1)
    if (rank < bestRank) {
      best = d.file
      bestRank = rank
      if (rank === 0) break
    }
  }
  if (bestRank >= 2 && bestRank < 4 && maybes.length > 1) {
    const r = withAlternatives([...maybes.filter((m) => m.answer.file === best), ...maybes.filter((m) => m.answer.file !== best)], asker)
    if (r.alternatives !== undefined) return { file: best, alternatives: r.alternatives }
  }
  return best
}

// What module `at` (spread over the files of cfg variants, `#[cfg_attr(unix, path = …)]`) makes
// of `name` for a path written in `file`, that file's own imports first: its `use` binding the
// name, then its own globs; only then the module's imports at large (providedAll). For a module
// held in one file the two agree, so the shortcut is taken only when they may not. Memoized like
// providedAll: a `use log;` in such a file asks for `log` in its own module, which is this import.
function providedFrom(root, at, name, ctx, file, asker, typesOnly = false) {
  const of = ctx.imports.get(root)?.get(at)
  const several = of !== undefined && [...of.globs, ...[...of.named.values()].flat()].some((im) => im.file !== file)
  if (!several) return provided(root, at, name, at, ctx, asker, typesOnly)
  const memo = ctx.provided.get(root) ?? ctx.provided.set(root, new Map()).get(root)
  const seeing = at.split('::').length
  const key = `${at}\0${name}\0@${file}`
  let list = memo.get(key)
  if (list === undefined) {
    // Resolving this file's glob sources may ask this very question (`pub use sibling::*;` beside
    // `use super::*;`): while the list is in the making it reads as nothing, and is not kept then.
    const depth = ctx.walking++
    memo.set(key, { depth })
    const own = [] // this file's globs, with their sources
    for (const im of of.globs) {
      if (im.file !== file) continue
      const source = globSource(im, root, ctx)
      if (source?.kind === 'module') own.push([im, source.modulePath])
    }
    const cyclic = ctx.hits.delete(depth)
    ctx.walking--
    list = new Lazy(function* () {
      yield* importsOf(root, at, name, seeing, ctx, file)
      for (const [im, module] of own) {
        const sees = commonDepth(at, module)
        for (const c of hasAll(root, module, name, sees, ctx)) yield { ...c, through: im.file, leaves: unionLeaves(im.leaves, c.leaves, ctx.leafSets) }
        for (const c of providedAll(root, module, name, sees, ctx)) yield { ...c, through: im.file, leaves: unionLeaves(im.leaves, c.leaves, ctx.leafSets) }
      }
      yield* providedAll(root, at, name, seeing, ctx)
    }(), ctx)
    if (!cyclic && minHit(ctx) >= depth) memo.set(key, list)
    else memo.delete(key)
  } else if (list.depth !== undefined) {
    ctx.hits.add(list.depth)
    return null
  }
  return pick(list, root, ctx, asker, typesOnly)
}

// The `use` items of module `at` binding `name`, visible to one seeing `seeing` levels into it,
// as candidates to follow (pick), in written order, each with the file holding the import as
// `through`. Several may bind it (`#[cfg(unix)] use a::X;` beside `#[cfg(windows)] use b::X;`).
// `onlyFile` restricts to the imports written in that file: the module may be spread over cfg
// variants (`#[cfg_attr(unix, path = …)]`), each binding the name its own way, and a path written
// in one of them means that one's.
function importsOf(root, at, name, seeing, ctx, onlyFile) {
  const named = ctx.imports.get(root)?.get(at)?.named.get(name)
  if (named === undefined) return NONE
  const out = []
  for (const im of named) {
    if (im.scopeDepth > seeing || (onlyFile !== undefined && im.file !== onlyFile)) continue
    out.push({ import: im, through: im.file, leaves: im.leaves })
  }
  return out
}

// The modules of this crate that the globs of module `at` visible to one seeing `seeing` levels
// into it reach, transitively (a glob's target module's own globs, as seen from the module whose
// glob named it), depth-first in written order, each `{ module, seeing, through }`: how deep the
// module naming it sees into it, and the file holding the glob of `at` it was reached through.
// Computed once per (at, seeing), a settled closure of a module reached standing in for walking
// on from it; a closure asked for while it is being computed (a glob into a module whose own
// imports name the glob's source) is a cycle, and reads as empty.
function globClosure(root, at, seeing, ctx) {
  const memo = ctx.closures.get(root) ?? ctx.closures.set(root, new Map()).get(root)
  const key = `${at}\0${seeing}`
  return memoized(memo, key, ctx, () => {
    const modules = []
    const seen = new Map([[key, null]]) // (module, seeing) → its entry
    // `leaves`: the cfgs of the globs walked through to get here, all of which must hold (a leaf
    // set). A module reached again by another path (libc's `mod primitives`, glob re-exported
    // under a dozen cfgs) is reachable under either -- and so is everything its own globs reach,
    // so a path that widens an entry is walked on from it (`widened`); one that adds nothing ends.
    const add = (k, entry) => {
      const known = seen.get(k)
      if (known === undefined) {
        seen.set(k, entry)
        modules.push(entry)
        return 'new'
      }
      if (known === null) return 'same'
      const either = eitherLeaves(known.leaves, entry.leaves, ctx.leafSets)
      if (either === known.leaves) return 'same'
      known.leaves = either
      return 'widened'
    }
    const reach = (module, sees, through, leaves) => {
      const k = `${module}\0${sees}`
      if (add(k, { module, seeing: sees, through, leaves }) === 'same') return
      const settled = memo.get(k)
      if (settled !== undefined && settled.depth === undefined) {
        // Already transitive: no walking on from any of them.
        for (const m of settled.value) add(`${m.module}\0${m.seeing}`, { module: m.module, seeing: m.seeing, through, leaves: unionLeaves(leaves, m.leaves, ctx.leafSets) })
        return
      }
      for (const im of ctx.imports.get(root)?.get(module)?.globs ?? []) {
        if (im.scopeDepth > sees) continue
        const source = globSource(im, root, ctx)
        if (source?.kind === 'module') reach(source.modulePath, commonDepth(module, source.modulePath), through ?? im.file, unionLeaves(leaves, im.leaves, ctx.leafSets))
      }
    }
    for (const im of ctx.imports.get(root)?.get(at)?.globs ?? []) {
      if (im.scopeDepth > seeing) continue
      const source = globSource(im, root, ctx)
      if (source?.kind === 'module') reach(source.modulePath, commonDepth(at, source.modulePath), im.file, im.leaves)
    }
    return modules
  }, { empty: [] })
}

// What a glob imports from (followImport), asked once per glob rather than once per closure it
// is part of -- unless the answer came out of an import cycle still being resolved.
function globSource(im, root, ctx) {
  if (im.source !== undefined) return im.source
  const depth = ctx.walking++
  const source = followImport(im, root, ctx)
  ctx.walking--
  if (minHit(ctx) >= depth) im.source = source
  return source
}

// What an import leads to: its path resolved as written in its module, else the crate its lead
// names -- the sysroot's (`use core::fmt`: an item, living here as far as the bundle knows), an
// in-tree one, or null for one that isn't (nor anything the tree can model).
function followImport(im, root, ctx, asker, typesOnly = false) {
  if (!im.absolute) {
    const r = walkPath(im.segments, root, im.module, ctx, { file: im.file, asker, typesOnly })
    if (r !== null) return r
  }
  const head = im.segments[0]
  if (NON_CRATE_LEADS.has(head)) return { kind: 'item', file: im.file }
  const target = ctx.resolveCrate(head, im.file)
  return target ? { kind: 'crate', name: head, file: target } : null
}

// An item answer for what definedIn found.
const itemAt = (def) => (typeof def === 'string' ? { kind: 'item', file: def } : { kind: 'item', file: def.file, alternatives: def.alternatives })

// walkPath's answer for a path naming a value-namespace item (a `fn`, `const` or `static`) where
// a type or module is wanted: as a prefix (`log::info!` beside a `fn log`), or as the target of
// an import followed as one (`use crate::util::log; log::info!`). Nothing here -- and not an
// item of the module either: the lead may still name a crate.
const VALUE_ONLY = Object.freeze({ kind: 'value' })
// Whether module `at` defines `name` only in the value namespace.
const onlyValues = (root, at, name, ctx) => {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  return defs !== undefined && defs.every((d) => d.ns === 'value')
}

// Resolve `segments`, a path written in module `from` of `root`'s crate, when its lead anchors it
// there: `crate::`, `self::`, `super::`, a child module of `from`, a name `from`'s imports provide
// (`use gen::consts; pub use consts::*;`, `extern crate serde_core as s; s::Value`), or -- for a
// bare name -- a `macro_rules!` of the file (`macro_rules! helper { … } pub(crate) use helper;`).
// Null when it doesn't (an item in scope, a crate: the caller looks the lead up as one).
// Then module by module; a segment naming no module is looked up in the module reached, and the
// walk goes on from a module that provides, or ends at whatever else it provides. A segment
// nothing provides is an item of the module reached, in the file defining it when that is known.
// At the crate root a final segment may name a `#[macro_export]` macro, which lives in the file
// defining it: `$crate::name!` names the macro before anything else (`macroCall`), any other path
// the module or import of that name first. In the module the path is written in, `file`'s own
// imports come first: the module's other files, if any, are cfg variants (providedFrom). `asker`
// (see cfg compatibility) rules out what can't be compiled together with the path.
function walkPath(segments, root, from, ctx, { macroCall = false, file, asker, typesOnly = false } = {}) {
  const tree = ctx.trees.get(root)
  const head = segments[0]
  // A segment with more after it names a module or type-namespace item: a `fn log` doesn't lead
  // `log::info!`, the crate does (`typed`, see pick) -- the last one too when the caller wants a
  // type (`typesOnly`: an import followed as a path's prefix).
  const lookup = (at, name, typed) => (at === from && file !== undefined ? providedFrom(root, at, name, ctx, file, asker, typed) : provided(root, at, name, from, ctx, asker, typed))
  let cur = from.split('::')
  let i = 0
  let via
  if (head === 'crate') {
    cur = ['crate']
    i = 1
  } else if (head === 'self') {
    i = 1
  } else if (head !== 'super' && !tree.has(`${from}::${head}`)) {
    const typed = segments.length > 1 || typesOnly
    const p = lookup(from, head, typed)
    if (p === null || p === VALUE_ONLY) {
      // An item of the module itself (`enum Kind { … } use Kind::*;`), or a macro of the file.
      const own = definedIn(root, from, head, Infinity, ctx, asker, typed)
      if (own !== null) return itemAt(own)
      if (typed && (p === VALUE_ONLY || onlyValues(root, from, head, ctx))) return VALUE_ONLY
      return segments.length === 1 && file !== undefined && ctx.fileMacros.get(file)?.has(head) === true ? { kind: 'item', file } : null
    }
    via = { modulePath: from, consumed: 0, through: p.through }
    if (p.kind !== 'module') return { ...p, via }
    cur = p.modulePath.split('::')
    i = 1
  }
  while (segments[i] === 'super') {
    cur.pop()
    i++
    if (cur.length === 0) return null
  }
  while (i < segments.length) {
    const at = cur.join('::')
    const name = segments[i]
    const last = i === segments.length - 1
    const macro = at === 'crate' && last ? ctx.macros.get(root)?.get(name) : undefined
    if (macro !== undefined && macroCall) return { kind: 'item', file: macro, via }
    const child = `${at}::${name}`
    const typed = !last || typesOnly
    let p
    if (tree.has(child)) {
      // A child module the asker's build presumably doesn't compile -- under a cfg off in it, or
      // a custom one (doubtful): serde's docsrs-only `mod de` beside the `pub use serde_core::de`
      // of every other build -- gives way to what else the module has of the name, if anything.
      const set = ctx.files.get(tree.get(child))?.leaves
      p = set !== undefined && (deadFor(asker, set) || doubtful(asker, set)) ? lookup(at, name, typed) : null
      if (p === null || p === VALUE_ONLY) {
        cur.push(name)
        i++
        continue
      }
    } else p = lookup(at, name, typed)
    if (p === null || p === VALUE_ONLY) {
      if (macro !== undefined) return { kind: 'item', file: macro, via }
      const def = definedIn(root, at, name, Infinity, ctx, asker, typed)
      if (def !== null) return { ...itemAt(def), via }
      if (typed && (p === VALUE_ONLY || onlyValues(root, at, name, ctx))) return VALUE_ONLY
      return { kind: 'item', file: tree.get(at), via }
    }
    via ??= { modulePath: at, consumed: i, through: p.through }
    if (p.kind !== 'module') return { ...p, via }
    cur = p.modulePath.split('::')
    i++
  }
  const modulePath = cur.join('::')
  return { kind: 'module', modulePath, file: tree.get(modulePath), via }
}

// Whether a glob in module `at`, or in a module its globs reach, may bring `lead` in without the
// loader seeing it -- a glob into a crate that isn't in-tree (`use syn::*;` brings syn's
// `punctuated` module in) -- or does bring it in from another in-tree crate: from the module the
// glob's path names there (`use tokio::sync::*;` brings tokio's `sync::mpsc` in), what it has
// (hasAll) or its own globs may bring in, in turn. Then a lead nothing here explains is not one to
// report as a missing crate. A glob the loader sees through -- into a module of this crate, an
// enum, the sysroot, or an in-tree crate's module without the name -- explains nothing, and no
// glob brings in its own crate's name. Memoized per (at, lead); asked again while being answered
// (globs between two crates leading back), it reads as no. Only the globs leading out of the
// crate matter (opaqueGlobsOf), so a closure of hundreds costs a lookup per such glob.
// The globs of `root`'s crate that lead out of it -- into a crate that isn't in-tree (source
// null) or into another in-tree one -- by module, with their sources, found once per crate (and
// again after stabilizeClosures): the few of a closure's hundreds of modules globMayProvide has
// to look at.
function opaqueGlobsOf(root, ctx) {
  let index = ctx.opaqueGlobs.get(root)
  if (index === undefined) {
    index = new Map()
    for (const [module, of] of ctx.imports.get(root) ?? []) {
      for (const im of of.globs) {
        if (NON_CRATE_LEADS.has(im.segments[0])) continue
        const source = globSource(im, root, ctx)
        if (source === null || source.kind === 'crate') (index.get(module) ?? index.set(module, []).get(module)).push({ im, source })
      }
    }
    ctx.opaqueGlobs.set(root, index)
  }
  return index
}

function globMayProvide(root, at, lead, ctx) {
  const memo = ctx.opaque.get(root) ?? ctx.opaque.set(root, new Map()).get(root)
  const key = `${at}\0${lead}`
  if (memo.has(key)) return memo.get(key)
  memo.set(key, false)
  // The globs leading out of the crate that `at` sees -- its own and its closure's, at the depth
  // each module is seen (a module may be reached at several) -- gathered once per `at`: the ones
  // into crates not in-tree by the crate name they bring nothing of (their own), the ones into
  // in-tree crates with their sources.
  const reachKey = `${at}\0`
  let reach = memo.get(reachKey)
  if (reach === undefined) {
    const seeing = at.split('::').length
    const closure = globClosure(root, at, seeing, ctx)
    const positions = closureIndex(closure)
    reach = { unseen: new Map(), crates: [] }
    for (const [module, globs] of opaqueGlobsOf(root, ctx)) {
      let sees = module === at ? seeing : -1
      for (const i of positions.get(module) ?? NONE) sees = Math.max(sees, closure[i].seeing)
      if (sees === -1) continue
      for (const { im, source } of globs) {
        if (im.scopeDepth > sees) continue
        if (source === null) reach.unseen.set(im.segments[0], (reach.unseen.get(im.segments[0]) ?? 0) + 1)
        else reach.crates.push({ im, source })
      }
    }
    memo.set(reachKey, reach)
  }
  // What another crate's module `module` (root `file`) makes visible under `lead`, as far as the
  // bundle sees: anything, for a crate not in-tree; else what the module has, what its `pub`
  // globs bring in from its own crate (providedAll), or may from a third.
  const inCrate = (file, module) => !ctx.trees.has(file) || hasAll(file, module, lead, 1, ctx).length > 0 || providedAll(file, module, lead, 1, ctx).get(0) !== undefined || globMayProvide(file, module, lead, ctx)
  let answer = false
  let unseen = 0
  for (const [name, count] of reach.unseen) if (name !== lead) unseen += count
  if (unseen > 0) answer = true
  for (const { im, source } of reach.crates) {
    if (answer || im.segments[0] === lead) break
    // The glob's path on from the crate it names (`sync` of `use tokio::sync::*;`), when the
    // lead itself named the crate (no `via`: the path wasn't anchored in this crate first).
    const rest = source.via === undefined ? im.segments.slice(1) : []
    const there = rest.length === 0 || !ctx.trees.has(source.file) ? { kind: 'module', modulePath: 'crate' } : walkPath(['crate', ...rest], source.file, 'crate', ctx)
    if ((there?.kind === 'module' && inCrate(source.file, there.modulePath)) || (there?.kind === 'crate' && inCrate(there.file, 'crate'))) answer = true
  }
  memo.set(key, answer)
  return answer
}

// Resolve one path reference made in `file` to what it names in the bundle (see walkPath): a
// module or item of the same crate, an in-tree crate (`{ kind: 'crate', name, file }`, through
// `resolveCrate` when the lead names one, by its own name or as the crate root's `extern crate x
// as y;` aliases it, `::y::…` included -- this crate's own root for `extern crate self as y;`),
// an exported macro named by a one-segment path written at the crate root, where such a macro is
// an item (`pub use anyhow as format_err;` in the anyhow crate's lib.rs; a child module reaches it
// as `crate::anyhow`), or `{ kind: 'unresolved', name }` when the lead could name a crate
// (crateLead) but nothing in-tree did; null for anything else (an item in scope, std, a path
// above the crate root, a name a glob into another crate may well provide). `bindings` are the names `file`'s imports bind -- in whichever namespace: one bound
// only as a value (`use crate::util::log;` of a `fn log`) doesn't keep `log::info!` from naming
// the crate.
const NO_BINDINGS = new Set()
function resolvePathRef(ref, file, bindings, ctx) {
  const { segments, absolute, inlinePath } = ref
  if (segments.length === 0) return null
  const here = ctx.files.get(file)
  const from = here ? [here.modulePath, ...inlinePath].join('::') : null
  let valueOnly = false
  if (!absolute && here) {
    const r = walkPath(segments, here.root, from, ctx, { macroCall: ref.macroCall, file, asker: here.asker })
    if (r === VALUE_ONLY) valueOnly = true // the lead is bound here, but as a value: `log::…` names the crate
    else if (r !== null) return r
  }
  const lead = crateLead(ref, valueOnly ? NO_BINDINGS : bindings)
  if (lead === null) return null
  const name = ctx.externPrelude.get(here?.root)?.get(lead) ?? lead
  if (name === 'self') {
    const r = walkPath(['crate', ...segments.slice(1)], here.root, from, ctx, { macroCall: ref.macroCall, file, asker: here.asker })
    return r === VALUE_ONLY ? null : r
  }
  const target = ctx.resolveCrate(name, file)
  if (target) return { kind: 'crate', name, file: target }
  const macro = segments.length === 1 && from === 'crate' ? ctx.macros.get(here.root)?.get(lead) : undefined
  if (macro !== undefined) return { kind: 'item', file: macro }
  // A glob into a crate that isn't in-tree (`use serde::*;`) may bring the lead in -- unless the
  // package declares a dependency of that name, which the lead then is (see declaresCrate): one
  // missing from the bundle is reported whatever the globs beside it.
  return here && !ctx.declaresCrate(name, file) && globMayProvide(here.root, from, lead, ctx) ? null : { kind: 'unresolved', name }
}

// `map`: root → name → Set<module>, noting `module` under (root, name).
const note = (map, root, name, module) => {
  const byName = map.get(root) ?? map.set(root, new Map()).get(root)
  ;(byName.get(name) ?? byName.set(name, new Set()).get(name)).add(module)
}

// Bundle import keys can't contain '/'; a cfg predicate practically never does, but fail safe.
const cfgKey = (cfg) => (cfg ?? '*').replaceAll('/', '|')

// Whether `rel` is compiled with `cfg(test)`: a file of a test/bench target (`tests/*.rs`,
// `benches/*.rs` and their modules), judged against its package dir when a Cargo context knows it.
const isTestTarget = (rel, ctx) => (ctx ? ctx.isTestTarget(rel) : isTestTargetPath('.', rel))

// The files a macro is in effect invoked from, by name: those invoking it by bare name
// (`invokers`: name → files), and -- since a bare call in a `macro_rules!` template is made where
// that macro is invoked (`templateCalls`: name → the names its definitions' templates call) --
// those invoking a macro whose template calls it, on up: what rustc resolves the macro's include
// paths against, the outermost call site.
function effectiveInvokers(name, invokers, templateCalls, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const out = new Set(invokers.get(name) ?? [])
  for (const [caller, called] of templateCalls) if (called.has(name)) for (const f of effectiveInvokers(caller, invokers, templateCalls, seen)) out.add(f)
  return out
}

// The compile units a file is compiled as (see cargo.js unitKey): what `units` recorded, else
// the target's alone.
const DEFAULT_UNITS = new Set([TARGET_UNIT])
const unitsOf = (units, rel) => units?.get(rel) ?? DEFAULT_UNITS

// The build `rel` is scanned under (scanRustItems' options): per unit it is compiled as, its
// crate's features in that unit's feature context -- on for certain, and on maybe -- and the cfg
// set of the platform the unit compiles for, as far as the Cargo context `ctx` knows them; and
// whether it is test code. A build script is compiled for the host, whose cfgs the loader knows
// only when the target is the host; a crate built both for the target and, as a
// build-dependency, for the host is scanned under both. Interned per (package, test flag,
// units), so a scan of the same build is reused (cachedScan compares identity).
const buildMemo = new WeakMap() // ctx -> key -> build
const NO_CTX = {}
function buildOf(rel, ctx, units = null) {
  const test = isTestTarget(rel, ctx)
  const set = unitsOf(units, rel)
  const key = `${ctx?.packageInfo(rel)?.dir ?? ''}\0${test}\0${[...set].toSorted().join()}`
  const memo = buildMemo.get(ctx ?? NO_CTX) ?? buildMemo.set(ctx ?? NO_CTX, new Map()).get(ctx ?? NO_CTX)
  if (!memo.has(key)) {
    const one = (unit) => ({ features: ctx?.featuresFor(rel, unit) ?? null, maybeFeatures: ctx?.maybeFeaturesFor(rel, unit) ?? null, target: ctx?.platformOf(unit)?.cfgs ?? null })
    const each = [...set].map(one)
    memo.set(key, each.length === 1 ? { ...each[0], test } : { units: each, test })
  }
  return memo.get(key)
}

// Scan results per `sources` map, so the tree pass reuses the walk's scan of each file when it
// ran under the same build (one interned object, see buildOf) on the same content (a caller may
// edit a file in a map it reuses).
const scanCache = new WeakMap()
function cachedScan(sources, path, content, build, templates = undefined) {
  if (!scanCache.has(sources)) scanCache.set(sources, new Map())
  const cache = scanCache.get(sources)
  const key = templates === undefined ? path : `${path}\0${[...templates].join()}` // a rescan with fewer templates, kept beside the plain scan
  const hit = cache.get(key)
  if (hit && hit.content === content && hit.build === build) return hit.items
  const items = scanRustItems(content, templates === undefined ? build : { ...build, templates })
  cache.set(key, { build, content, items })
  return items
}

// Build the triple from already-loaded sources. Two-phase: resolve `mod` edges (defining each
// crate root's module tree), then path references against it. An unconditional `mod` with no
// file → `missing` (fatal); cfg-gated/unresolved/self refs are omitted. `roots` are the entries
// (crate roots by role; main.rs/lib.rs are roots by name regardless); `baseDir` enables crate
// resolution through Cargo.toml (own lib, path deps), else only vendored crates already in
// `sources` resolve. Spec shapes in `resolutions`: `mod <name>` (`mod a::<name>` inside inline
// module `a`) → file, or a Map<cfg predicate | '*', file> when `#[cfg_attr(…, path)]` variants or
// same-name `#[cfg]`-gated declarations name different files; `<path as written>` → module file;
// `use <crate>` → crate root. `unresolvedCrates` names the crates `use`/`extern crate` referenced
// that nothing in-tree satisfied (registry deps that weren't vendored, typically) --
// informational, never fatal. `wantedRoots` are in-tree crate roots the paths named that
// `sources` lacks (the walk took their names for bound items): loaded and built again, they
// complete the bundle. A `cargo` context (cargo.js) may be passed in to share one
// between the walk and this pass; it also carries each crate's resolved features, which decide
// `#[cfg(feature = …)]`, and the build target's cfg set when one was given, which decides
// `#[cfg(unix)]` and the like. `units`: file → the compile units it is compiled as (see
// collectRustFilesFromDisk); `wantedUnits` gives each wanted root's, for the walk.
export function buildRustTree(sources, { roots = [], baseDir = null, cargo = null, formats = null, units = null } = {}) {
  const ctx = cargo ?? (baseDir ? createCargoContext(baseDir, { entries: roots }) : null)
  const rootSet = crateRoots(sources, roots, ctx)
  const resolutions = new Map()
  const missing = []
  const scanned = new Map()
  for (const [path, content] of sources) {
    if (formats?.has(path)) continue // an `include_str!` / `include_bytes!` asset: carried, not Rust
    scanned.set(path, cachedScan(sources, path, content, buildOf(path, ctx, units)))
  }
  // A package with a `macro_rules!` of a template macro's name (its own `quote!`, in whichever of
  // its files) invokes that one everywhere in the package: no template there, so the files of the
  // package that skipped a body of that name are scanned again with the name dropped from the set
  // (the package: the Cargo context's; without one, a vendored crate's `vendor/<dir>`, else the
  // bundle's).
  const packageOf = (path) => (ctx ? ctx.packageInfo(path)?.dir ?? '.' : path.startsWith(`${VENDOR_DIR}/`) ? path.split('/', 2).join('/') : '.')
  const ownTemplates = new Map() // package → the template names it defines
  for (const [path, items] of scanned) {
    for (const m of items.macros) if (TEMPLATE_MACROS.has(m.name)) (ownTemplates.get(packageOf(path)) ?? ownTemplates.set(packageOf(path), new Set()).get(packageOf(path))).add(m.name)
  }
  const reducedTemplates = new Map() // per package's own set: TEMPLATE_MACROS less those, one object
  for (const [path, items] of scanned) {
    const own = items.skipped.size > 0 ? ownTemplates.get(packageOf(path)) : undefined
    if (own === undefined || own.isDisjointFrom(items.skipped)) continue
    const templates = reducedTemplates.get(own) ?? reducedTemplates.set(own, new Set([...TEMPLATE_MACROS].filter((name) => !own.has(name)))).get(own)
    scanned.set(path, cachedScan(sources, path, sources.get(path), buildOf(path, ctx, units), templates))
  }
  // Bare macro invocations per file, for what a `macro_rules!` body holds: rustc expands it where
  // the macro is invoked -- through the templates that call it, the outermost (effectiveInvokers).
  const invokers = new Map()
  const templateCalls = new Map()
  for (const [path, items] of scanned) {
    for (const name of items.invocations) (invokers.get(name) ?? invokers.set(name, new Set()).get(name)).add(path)
    for (const m of items.macros) for (const name of m.calls) (templateCalls.get(m.name) ?? templateCalls.set(m.name, new Set()).get(m.name)).add(name)
  }
  // A `mod` a `macro_rules!` template declares is declared in each module invoking the macro, and
  // its file found from there (serde_core's src/crate_root.rs holds `crate_root! { … pub mod de;
  // … }`, which lib.rs invokes: src/de/mod.rs). Only its own package's invocations count -- a
  // macro of the same name elsewhere is likely another -- and one nothing there invokes by bare
  // name (`crate::m!()` only) stays beside its definition. A hosted `mod` stands at the host's
  // first invocation (`offset`), for textual macro scope, and keeps the file defining it
  // (`definedIn`): the host's cfgs on mounting that file are its own too (serde's lib.rs mounts
  // core/crate_root.rs under `#[cfg(docsrs)]`).
  const hosted = new Map() // file → the template `mod`s it declares by invoking their macros
  const hostedAway = new Set() // the template `mod`s that moved to their invokers
  for (const [path, items] of scanned) {
    for (const decl of items.mods) {
      if (decl.template === null) continue
      const hosts = [...effectiveInvokers(decl.template, invokers, templateCalls)].filter((f) => packageOf(f) === packageOf(path))
      if (hosts.length === 0) continue
      hostedAway.add(decl)
      for (const f of hosts) (hosted.get(f) ?? hosted.set(f, []).get(f)).push({ ...decl, offset: scanned.get(f).calls.get(decl.template)?.[0] ?? Infinity, definedIn: path })
    }
  }
  const modsOf = (path) => [...scanned.get(path).mods.filter((d) => !hostedAway.has(d)), ...(hosted.get(path) ?? [])]
  // An `include!`d file's items join the includer's module (buildModuleTrees), but a `mod` it
  // declares resolves beside the included file itself, as rustc does: like a `#[path]`-loaded
  // file, it owns its directory (pathLoaded).
  const pathLoaded = new Set()
  for (const [path, items] of scanned) {
    for (const inc of items.includes) {
      if (inc.kind !== 'include') continue
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) pathLoaded.add(file)
    }
  }
  // Files a `#[path]` names own their directory too (see getModuleDir), so find those before
  // resolving any default `mod` lookup; a path-loaded file may itself hold inline modules with
  // `#[path]`s, hence the loop to a fixed point.
  const modOpts = { knownSources: sources, roots: rootSet, pathLoaded }
  const declsOf = (path, decl) => resolveModDecl(decl, path, { ...modOpts, boundary: boundaryOf(path, ctx) })
  for (let grew = true; grew;) {
    grew = false
    for (const path of scanned.keys()) {
      for (const decl of modsOf(path)) {
        if (decl.paths.length === 0) continue
        for (const t of declsOf(path, decl)) {
          if (t.explicit && !pathLoaded.has(t.file)) {
            pathLoaded.add(t.file)
            grew = true
          }
        }
      }
    }
  }
  // The include macros a `macro_rules!` body holds name files relative to each file in effect
  // invoking the macro, recorded there, as `include_str <path>`. Every definition of a name counts
  // (two `macro_rules! m` in two files: both bodies' assets).
  const includeEdges = new Map() // file → [{ kind, path, base, conditional }] from macro templates it invokes
  for (const [, items] of scanned) {
    for (const m of items.macros) {
      if (m.includes.length === 0) continue
      for (const f of effectiveInvokers(m.name, invokers, templateCalls)) {
        const list = includeEdges.get(f) ?? includeEdges.set(f, []).get(f)
        for (const inc of m.includes) list.push({ ...inc, conditional: true })
      }
    }
  }
  // file → spec → target file → the declarations mounting it, each its cfg (null for an ungated
  // one), the macro body it sits in and -- for a hosted template `mod` -- the declarations here
  // mounting the file defining it (`via`), for the cfg leaves each file carries (buildModuleTrees).
  const mountCfgs = new Map()
  for (const [path, items] of scanned) {
    // spec -> Map<cfg key, file>: each declaration's files under its cfg predicate ('*' when
    // ungated; `<macro>!` for one a macro emits under a cfg the loader can't see, tokio's
    // `cfg_has_atomic_u64! { mod imp; }`), so `#[cfg(unix)] #[path = "u.rs"] mod imp;` beside
    // `#[cfg(windows)] #[path = "w.rs"] mod imp;` keeps both files. The first declaration of a
    // key wins; another file under the same key gets the key numbered (`*#2`) rather than lost.
    const byCfg = new Map()
    const cfgsHere = mountCfgs.set(path, new Map()).get(path)
    for (const decl of modsOf(path)) {
      const spec = `mod ${[...decl.inlinePath, decl.name].join('::')}`
      const targets = declsOf(path, decl)
      if (targets.length === 0) {
        // conditional && unresolved: cfg-gated module, may be compiled out -- tolerated.
        if (!decl.conditional) {
          console.warn(`[loader.rust] Missing module: ${decl.name} from ${path}`)
          missing.push({ spec, from: path })
        }
        continue
      }
      const keyed = byCfg.get(spec) ?? byCfg.set(spec, new Map()).get(spec)
      const byFile = cfgsHere.get(spec) ?? cfgsHere.set(spec, new Map()).get(spec)
      for (const t of targets) {
        const cfg = t.cfg ?? decl.cfg ?? null
        const base = cfgKey(cfg ?? (decl.macro === null ? null : `${decl.macro}!`))
        let key = base
        for (let k = 2; keyed.has(key) && keyed.get(key) !== t.file; k++) key = `${base}#${k}`
        if (!keyed.has(key)) keyed.set(key, t.file)
        const via = decl.definedIn === undefined ? undefined : [...cfgsHere.values()].flatMap((m) => m.get(decl.definedIn) ?? [])
        ;(byFile.get(t.file) ?? byFile.set(t.file, []).get(t.file)).push({ cfg, macro: decl.macro, via })
      }
    }
    // A single file is a flat string -- also when every cfg names the same file (libc's `mod
    // primitives` under a dozen); cfg variants stay a Map.
    const specMap = new Map()
    for (const [spec, keyed] of byCfg) {
      const distinct = new Set(keyed.values())
      specMap.set(spec, distinct.size === 1 ? distinct.values().next().value : keyed)
    }
    // `include!("generated/consts.rs")` and the asset macros name a file relative to this one (or
    // to the package root), the ones in a macro body it invokes relative to this one too.
    for (const inc of [...items.includes, ...(includeEdges.get(path) ?? [])]) {
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) specMap.set(`${inc.kind} ${inc.path}`, file)
      else if (!inc.conditional) console.warn(`[loader.rust] Missing include: ${inc.path} from ${path}`)
    }
    if (items.unfollowed > 0) console.warn(`[loader.rust] ${items.unfollowed} include${items.unfollowed === 1 ? '' : 's'} in ${path} name${items.unfollowed === 1 ? 's' : ''} a path the loader can't follow (not a literal)`)
    resolutions.set(path, specMap)
  }

  // Each package's gate macros (`cfg_x!`), by name: the cfg its definition wraps items in, or null
  // when that can't be read -- or when the package defines the name twice, differently.
  const gatesByPackage = new Map()
  for (const [path, items] of scanned) {
    for (const m of items.macros) {
      if (m.gate === undefined) continue
      const gates = gatesByPackage.get(packageOf(path)) ?? gatesByPackage.set(packageOf(path), new Map()).get(packageOf(path))
      gates.set(m.name, gates.has(m.name) && gates.get(m.name) !== m.gate ? null : m.gate)
    }
  }
  const gatesOf = (path) => gatesByPackage.get(packageOf(path)) ?? null
  const { trees, files } = buildModuleTrees(sources, resolutions, rootSet, new Map([...scanned].map(([p, items]) => [p, items.inlineModules])), mountCfgs, gatesOf)
  // What each file asks as: itself, with the cfg leaves it was mounted under (see cfg
  // compatibility), as an interned leaf set (leafSets: every set of this tree, by key).
  const leafSets = new Map()
  const askerSets = new Map() // per leaf set, build and settable cfgs: what every asker of those shares
  const ids = new WeakMap()
  let nextId = 0
  const idOf = (object) => ids.get(object) ?? ids.set(object, nextId++).get(object)
  // With a file's platform known, its cfgs hold for the file: a `unix` asker never takes a
  // `windows` candidate, a `target_os = "linux"` one prefers the `any(android, linux, …)` branch
  // (see compatible). The platform is the target's for code compiled for it, the host's for a
  // build script (known only when the target is the host); a file compiled for both platforms
  // asks under the cfgs they share, which the loader knows only when they are one.
  const platformLeaves = new Map() // cfg set -> its leaf set
  const leavesOfCfgs = (cfgs) => platformLeaves.get(cfgs) ?? platformLeaves.set(cfgs, leafSet([...cfgs].flatMap((cfg) => {
    const m = /^([\w-]+)(?:="([^"]*)")?$/u.exec(cfg)
    return m && TARGET_CFG_KEYS.has(m[1]) ? [{ key: m[1], value: m[2] ?? null, neg: false }] : []
  }), leafSets)).get(cfgs)
  const platformCfgsOf = (path) => {
    const each = new Set([...unitsOf(units, path)].map((u) => ctx?.platformOf(u)?.cfgs ?? null))
    return each.size === 1 ? [...each][0] : null
  }
  for (const [path, f] of files) {
    f.leaves = leafSet(f.leaves, leafSets)
    const cfgs = platformCfgsOf(path)
    const set = cfgs === null ? f.leaves : unionLeaves(f.leaves, leavesOfCfgs(cfgs), leafSets)
    // What the askers of one leaf set, build and settable cfgs share (one object each).
    const build = buildOf(path, ctx, units)
    const settable = ctx?.cfgsSetFor(path) ?? null
    const sharedKey = `${set.key}\0${idOf(build)}\0${settable === null ? '' : idOf(settable)}`
    const shared = askerSets.get(sharedKey) ?? askerSets.set(sharedKey, { keys: new Set(set.leaves.map(leafKey)), compat: new Map(), sure: new Map(), doubt: new Map(), dead: new Map(), build, deadHere: deadUnder(set.leaves, build), custom: customFor(settable) }).get(sharedKey)
    f.asker = { file: path, set, ...shared }
  }
  // Per crate root, each module's child modules by name (every module's parent is in its tree).
  const children = new Map()
  for (const [root, tree] of trees) {
    const byParent = new Map()
    for (const modulePath of tree.keys()) {
      const cut = modulePath.lastIndexOf('::')
      if (cut === -1) continue
      const parent = modulePath.slice(0, cut)
      ;(byParent.get(parent) ?? byParent.set(parent, new Set()).get(parent)).add(modulePath.slice(cut + 2))
    }
    children.set(root, byParent)
  }
  // Per crate root, what a path may continue along where a segment names no module: the imports
  // of each module (by module path: `named` by the name each binds, and `globs`; each with the
  // `file` holding it, its `module`, how deep in the tree the module its visibility reaches sits,
  // `scopeDepth`: 1 for a `pub`, the module's own depth for a plain `use`, and its cfg `leaves`:
  // its file's plus its own cfg's), the items each module defines (`defined`: module → name →
  // [{ file, scopeDepth, ns, leaves }], `ns` the namespace: `value` for a fn/const/static, which no
  // path continues past, `type` for the rest), how far each module's own visibility reaches (`modScope`:
  // module → scopeDepth, for what a glob may bring in) and the `#[macro_export]` macros (by name →
  // file). `fileMacros` is file → the `macro_rules!` names it defines. `externPrelude` (root →
  // alias → crate) holds the root's `extern crate x as y;`, in scope crate-wide.
  const imports = new Map()
  const defined = new Map()
  const modScope = new Map()
  const macros = new Map()
  const fileMacros = new Map()
  const externPrelude = new Map()
  const perRoot = (map, root) => map.get(root) ?? map.set(root, new Map()).get(root)
  const scopeDepthOf = (vis, modulePath) => visibilityScope(vis, modulePath).split('::').length
  // Bare `name!` invocations resolve in textual scope, as rustc has it: a `macro_rules!` is in
  // scope from its definition to the end of its file, in the files the `mod`s after it mount (and
  // theirs, on down), and -- when its module is mounted with `#[macro_use]` -- in the mounting
  // file after that `mod`, and on from there. `mounts` is file → `{ parent, offset }`, the `mod`
  // (or `include!`) that first mounted it; `macroUseMods` file → its `#[macro_use] mod`s, each
  // `{ offset, files }`.
  const mounts = new Map()
  const macroUseMods = new Map()
  const filesOf = (target) => (target instanceof Map ? [...target.values()] : [target])
  // In tree order (`files`: each crate's, from its root down, the variants of a `mod` in the order
  // declared), whatever order the sources came in: among several files defining or importing a
  // name for one module, the first is the tree's own, and the answers are the same for any order
  // the caller lists the files in.
  for (const [path, here] of files) {
    const items = scanned.get(path)
    if (items === undefined) continue
    for (const im of items.imports) {
      // A `use $crate::…` in a `macro_rules!` template is the invoking module's, wherever that is.
      // (A `use` without `$crate` in one is kept: serde wraps its whole root in a macro, whose
      // `mod lib { pub use core::fmt; … }` is what every file's `use crate::lib::*` names.)
      if (im.template === true) continue
      const modulePath = [here.modulePath, ...im.inlinePath].join('::')
      const byModule = perRoot(imports, here.root)
      const of = byModule.get(modulePath) ?? byModule.set(modulePath, { named: new Map(), globs: [] }).get(modulePath)
      const entry = { ...im, file: path, module: modulePath, scopeDepth: scopeDepthOf(im.vis, modulePath), leaves: unionLeaves(here.leaves, leafSet([...cfgLeaves(im.cfg), ...gateLeaves(im.macro, gatesOf(path))], leafSets), leafSets) }
      if (im.glob) of.globs.push(entry)
      else if (im.binding !== null) (of.named.get(im.binding) ?? of.named.set(im.binding, []).get(im.binding)).push(entry)
    }
    for (const d of items.defined) {
      const modulePath = [here.modulePath, ...d.inlinePath].join('::')
      const byModule = perRoot(defined, here.root)
      const names = byModule.get(modulePath) ?? byModule.set(modulePath, new Map()).get(modulePath)
      ;(names.get(d.name) ?? names.set(d.name, []).get(d.name)).push({ file: path, scopeDepth: scopeDepthOf(d.vis, modulePath), ns: d.ns, leaves: unionLeaves(here.leaves, leafSet([...cfgLeaves(d.cfg), ...gateLeaves(d.macro, gatesOf(path))], leafSets), leafSets) })
    }
    const scopes = perRoot(modScope, here.root)
    const specMap = resolutions.get(path)
    for (const decl of modsOf(path)) {
      const parent = [here.modulePath, ...decl.inlinePath].join('::')
      const modulePath = `${parent}::${decl.name}`
      if (!scopes.has(modulePath)) scopes.set(modulePath, scopeDepthOf(decl.vis, parent))
      const target = specMap.get(`mod ${[...decl.inlinePath, decl.name].join('::')}`)
      if (target === undefined) continue
      const mountedFiles = filesOf(target).filter((f) => f !== path)
      const mount = { parent: path, offset: decl.offset, at: decl.at }
      for (const f of mountedFiles) if (!mounts.has(f)) mounts.set(f, mount)
      if (decl.macroUse && mountedFiles.length > 0) (macroUseMods.get(mount.parent) ?? macroUseMods.set(mount.parent, []).get(mount.parent)).push({ offset: mount.offset, at: mount.at, files: mountedFiles })
    }
    for (const [spec, target] of specMap) {
      if (spec.startsWith('include ') && !mounts.has(target) && target !== path) mounts.set(target, { parent: path, offset: Infinity, at: Infinity })
    }
    for (const [inline, vis] of items.inlineModuleVis) {
      const modulePath = `${here.modulePath}::${inline}`
      if (!scopes.has(modulePath)) scopes.set(modulePath, scopeDepthOf(vis, modulePath.slice(0, modulePath.lastIndexOf('::'))))
    }
    fileMacros.set(path, new Set(items.macros.map((m) => m.name)))
    for (const m of items.macros) {
      if (!m.exported) continue
      const byName = perRoot(macros, here.root)
      if (!byName.has(m.name)) byName.set(m.name, path)
    }
    if (here.modulePath === 'crate') {
      const prelude = perRoot(externPrelude, here.root)
      for (const e of items.externCrates) {
        // `extern crate self as x;` puts this crate's root in the prelude as `x` (kept as `self`).
        const named = e.name === 'self' ? e.alias !== null : !NON_CRATE_LEADS.has(e.name)
        if (e.inlinePath.length === 0 && named && !prelude.has(e.alias ?? e.name)) prelude.set(e.alias ?? e.name, e.name)
      }
    }
  }
  // The macros a file mounted with `#[macro_use]` hands the file mounting it: its own and, in
  // turn, its own `#[macro_use] mod`s' (name → defining file).
  const exportsMemo = new Map()
  const macroExports = (file, guard = new Set()) => {
    if (exportsMemo.has(file)) return exportsMemo.get(file)
    if (guard.has(file)) return new Map()
    guard.add(file)
    const out = new Map()
    for (const { files: mountedFiles } of macroUseMods.get(file) ?? []) for (const f of mountedFiles) for (const [name, where] of macroExports(f, guard)) out.set(name, where)
    for (const name of fileMacros.get(file) ?? []) out.set(name, file)
    exportsMemo.set(file, out)
    return out
  }
  // A file's macro events in source order, each `{ offset, at, macros }` (name → defining file):
  // its own `macro_rules!` and what its `#[macro_use] mod`s hand it. `offset` is where an item
  // stands, `at` where it is written: the same for most, the invocation and the place in the
  // template for what a `macro_rules!` emits (serde's `crate_root! { … macro_rules! tri { … } …
  // pub mod de; … }`: `tri` is in scope in `de`, both standing at the invocation).
  const eventsMemo = new Map()
  const fileEvents = (file) => {
    let events = eventsMemo.get(file)
    if (events === undefined) {
      events = [
        ...(scanned.get(file)?.macros ?? []).map((m) => ({ offset: m.offset, at: m.at, macros: new Map([[m.name, file]]) })),
        ...(macroUseMods.get(file) ?? []).map((u) => ({ offset: u.offset, at: u.at, macros: new Map(u.files.flatMap((f) => [...macroExports(f)])) })),
      ].toSorted((a, b) => a.offset - b.offset || a.at - b.at)
      eventsMemo.set(file, events)
    }
    return events
  }
  const before = (e, offset, at) => e.offset < offset || (e.offset === offset && e.at < at)
  // The macros in textual scope in `file` before position (`offset`, `at`) -- (Infinity,
  // Infinity): its end -- on top of `scope`, what it sees from above: the later definition of a
  // name shadows the earlier, whichever kind each is.
  const textualScope = (file, offset, at, scope) => {
    const out = new Map(scope)
    for (const e of fileEvents(file)) {
      if (!before(e, offset, at)) break
      for (const [name, where] of e.macros) out.set(name, where)
    }
    return out
  }
  // The file defining the macro `name` in scope at (`offset`, `at`) in `file`: the last event
  // before that point defining it, else what the file sees from above (`scope`); a definition
  // later in the file doesn't reach an earlier call.
  const macroAt = (file, name, offset, at, scope) => {
    const events = fileEvents(file)
    for (let i = events.length - 1; i >= 0; i--) {
      if (!before(events[i], offset, at)) continue
      const where = events[i].macros.get(name)
      if (where !== undefined) return where
    }
    return scope.get(name)
  }
  // What a file sees from above: what its parent sees from above, and the parent's textual scope
  // at the `mod` mounting it.
  const inheritedMemo = new Map()
  const inherited = (file, guard = new Set()) => {
    if (inheritedMemo.has(file)) return inheritedMemo.get(file)
    const mount = mounts.get(file)
    if (mount === undefined || guard.has(file)) return new Map()
    guard.add(file)
    const out = textualScope(mount.parent, mount.offset, mount.at, inherited(mount.parent, guard))
    inheritedMemo.set(file, out)
    return out
  }
  // Crate names resolve per package (a path dep's, a rename), so per file; the same (name, file)
  // comes up once per reference to the crate, and every glob import's source resolution asks.
  const crates = new Map()
  const resolveCrate = (name, from) => {
    const key = `${name}\0${from}`
    if (!crates.has(key)) crates.set(key, ctx?.resolveCrate(name, from) ?? resolveVendoredCrate(name, { knownSources: sources }))
    return crates.get(key)
  }
  // One context for every path of every file: `provided` memoizes across them (see walkPath).
  // Per crate root, name → the modules with anything of the name (a child module, an item, an
  // import binding it; the root for an exported macro): what hasAll may answer for.
  const having = new Map()
  for (const [root, byParent] of children) for (const [parent, names] of byParent) for (const name of names) note(having, root, name, parent)
  for (const [root, byModule] of defined) for (const [module, names] of byModule) for (const name of names.keys()) note(having, root, name, module)
  for (const [root, byModule] of imports) for (const [module, of] of byModule) for (const name of of.named.keys()) note(having, root, name, module)
  for (const [root, byName] of macros) for (const name of byName.keys()) note(having, root, name, 'crate')
  const declaresCrate = (name, from) => ctx?.declaresCrate?.(name, from) === true
  const pathCtx = { trees, children, files, resolveCrate, declaresCrate, imports, defined, modScope, macros, fileMacros, externPrelude, leafSets, having, provided: new Map(), closures: new Map(), opaque: new Map(), opaqueGlobs: new Map(), walking: 0, hits: new Set() }
  // Every path of every file, on top of the `mod` / include edges (`resolutions`): once, and once
  // more when the first pass left glob closures short of an import cycle (stabilizeClosures).
  const resolveAll = () => {
    const out = new Map()
    const unresolved = new Set()
    const wanted = new Map() // root -> the units it is wanted as
    for (const [path, items] of scanned) {
      const specMap = new Map(resolutions.get(path))
      out.set(path, specMap)
      resolveFile(path, items, specMap, unresolved, wanted)
    }
    return { out, unresolved, wanted }
  }
  const resolveFile = (path, items, specMap, unresolved, wanted) => {
    // Only edges to bundled files, never to self, first spelling wins. A target with
    // `alternatives` (withAlternatives) is recorded as the cfg-keyed map of them -- as a `mod`
    // with cfg variants is -- less the asking file and files not bundled; one file left is a plain edge.
    const add = (spec, target, alternatives) => {
      if (specMap.has(spec)) return
      if (alternatives !== undefined) {
        const keyed = new Map([...alternatives].filter(([, f]) => f !== path && sources.has(f)))
        const distinct = new Set(keyed.values())
        if (distinct.size > 1) {
          specMap.set(spec, keyed)
          return
        }
        if (distinct.size === 1) [target] = distinct
      }
      if (target && target !== path && sources.has(target)) specMap.set(spec, target)
    }
    // A crate resolved to a root the walk didn't load (its name was bound in the walking file as
    // a value, see resolvePathRef), or loaded as fewer units than this file names it as: the
    // caller may load it and build again.
    const addCrate = (name, target) => {
      if (target && ctx) {
        const want = new Set([...unitsOf(units, path)].map((u) => ctx.unitOfCrate(target, u)))
        const have = sources.has(target) ? unitsOf(units, target) : new Set()
        if (!want.isSubsetOf(have)) for (const u of want) (wanted.get(target) ?? wanted.set(target, new Set()).get(target)).add(u)
      } else if (target && !sources.has(target)) wanted.set(target, DEFAULT_UNITS)
      add(`use ${name}`, target)
    }
    // A crate name nothing in-tree satisfied -- sysroot crates aside, and an uppercase lead is an
    // `Enum::Variant` import, not a crate.
    const noteUnresolved = (name) => {
      if (!OTHER_SYSROOT_CRATES.has(name) && /^[a-z_]/u.test(name)) unresolved.add(name)
    }
    const here = files.get(path)
    const via = new Map() // file → the prefix of a path that went through an import of a module there
    for (const ref of items.refs) {
      const r = resolvePathRef(ref, path, items.bindings, pathCtx)
      if (r === null) continue
      if (r.kind === 'crate') addCrate(r.name, r.file)
      else if (r.kind === 'unresolved') {
        // Only a `use` reliably says its lead names a crate (see scanRustItems' `fromUse`).
        if (ref.fromUse) noteUnresolved(r.name)
        continue
      } else add(ref.macroCall ? `${ref.spec}!` : ref.spec, r.file, r.alternatives) // `crate::helper!()` beside `crate::helper()`: two edges
      // The module an import was followed from, when the path's own segments name it (`super`,
      // `crate::util`) and its file is neither this one nor the crate root, which every file of
      // the crate hangs off anyway.
      const v = r.via
      if (v && v.consumed > 0 && v.through !== path && v.through !== here.root && v.through !== r.file && !via.has(v.through)) {
        via.set(v.through, ref.segments.slice(0, v.consumed).join('::'))
      }
    }
    for (const { name } of items.externCrates) {
      if (NON_CRATE_LEADS.has(name)) continue // `extern crate self as x;` / `extern crate alloc;`
      const target = resolveCrate(name, path)
      if (target) addCrate(name, target)
      else noteUnresolved(name)
    }
    // A macro invoked by bare name and defined by `macro_rules!` in textual scope (see mounts):
    // this file's own, what the files above hand down (bytes' `fmt_impl!`, from fmt/mod.rs in
    // fmt/debug.rs), what a `#[macro_use] mod` of this file brings in (tokio's `ready!`, from
    // macros/ready.rs), and -- in the crate root's file, whose items they are -- the exported ones;
    // else one the module's imports bring in by path (`use crate::combinator::dispatch;`, a `use
    // super::*` from the root). (A `macro_rules! vec` in some sibling file of the crate is not
    // what `vec!` names.)
    if (here !== undefined) {
      const above = inherited(path)
      const exported = here.modulePath === 'crate' ? macros.get(here.root) : undefined
      // The file defining the macro `name` a bare call at `offset` names.
      const macroFileAt = (name, offset) => {
        const inScope = macroAt(path, name, offset, offset, above) ?? exported?.get(name)
        if (inScope !== undefined) return inScope
        const byPath = walkPath([name], here.root, here.modulePath, pathCtx, { macroCall: true, file: path, asker: here.asker })?.file
        return byPath !== undefined && fileMacros.get(byPath)?.has(name) === true ? byPath : undefined // a file that defines a macro of that name, not a `fn write` beside `write!`
      }
      for (const [name, offsets] of items.calls) {
        // Scope is decided at each call: a `macro_rules!` later in the file doesn't shadow what an
        // earlier `#[macro_use] mod` handed an earlier call. The bare calls in the invoked
        // macro's template, and in theirs on down, are made here too -- resolved in this file's
        // scope at this call, as rustc expands them.
        const found = new Set()
        for (const offset of offsets) {
          const seen = new Set()
          const expand = (called) => {
            if (seen.has(called)) return
            seen.add(called)
            const macroFile = macroFileAt(called, offset)
            if (macroFile === undefined) return
            found.add(`${called}!\0${macroFile}`)
            for (const m of scanned.get(macroFile)?.macros ?? []) if (m.name === called) for (const inner of m.calls) expand(inner)
          }
          expand(name)
        }
        for (const edge of found) {
          const cut = edge.indexOf('\0')
          add(edge.slice(0, cut), edge.slice(cut + 1))
        }
      }
    }
    // A module whose import a path went through is a dependency of the file too, whatever the
    // import led to (bitflags' `$crate::__private::serde::Serialize` needs the root's `__private`
    // as much as serde). When nothing else in the file points at that module's file, the path's
    // prefix naming the module records it (`crate::__private` → lib.rs); the bare crate root is
    // implied by the module tree.
    const targets = new Set()
    for (const t of specMap.values()) for (const f of t instanceof Map ? t.values() : [t]) targets.add(f)
    for (const [owner, spec] of via) if (!targets.has(owner)) add(spec, owner)
  }
  let { out, unresolved, wanted } = resolveAll()
  if (stabilizeClosures(pathCtx)) ({ out, unresolved, wanted } = resolveAll())
  return { sources, resolutions: out, missing, unresolvedCrates: unresolved, wantedRoots: [...wanted.keys()], wantedUnits: wanted }
}

// --- Disk walk --------------------------------------------------------------------------

// Walk from `entries` (the crate roots), following `mod` declarations and references to in-tree
// crates, reading each reachable file once; a missing file warns and is skipped without aborting
// the walk (buildRustTree decides what is fatal). `cargo` (cargo.js) resolves crate names and
// carries each crate's features; one is created for `entries` when not passed in. Pass `sources`
// to walk further roots into an earlier walk's map (files already there are not read again, but
// are gone through again when they are now compiled as more units). `units`: file → the compile
// units it is compiled as (cargo.js unitKey), filled in as the walk goes -- an entry the map
// doesn't name is the target's; what a file declares or includes is compiled as that file is,
// and a crate it names as the Cargo context says (unitOfCrate: a proc-macro crate, or a crate
// named from code built for the host, is built for the host).
export async function collectRustFilesFromDisk(baseDir, entries, { cargo = null, formats = null, sources = new Map(), units = new Map() } = {}) {
  const realBase = realpathSync(baseDir)
  const roots = new Set(entries)
  const pathLoaded = new Set() // files a `#[path]` named: their submodules sit beside them
  const assets = new Map() // files an `include_str!` / `include_bytes!` names: carried as they are, not scanned
  const rustFiles = new Set(entries) // files named as Rust source (a `mod`, an `include!`): scanned, never an asset
  const ctx = cargo ?? createCargoContext(baseDir, { entries })
  const modOpts = { baseDir, roots, pathLoaded }
  // file → the directory it must really lie in (boundaryOf, from the file that named it): a
  // vendored crate's files stay in its package, symlinks included.
  const boundaries = new Map(entries.map((e) => [e, boundaryOf(e, ctx)]))
  // An include macro in a `macro_rules!` body names a file relative to each file invoking the
  // macro -- through the templates that call it, the outermost (effectiveInvokers): definitions
  // and invocations arrive in any order, so each side is kept and paired. Every definition of a
  // name counts (two `macro_rules! m` in two files: both bodies' assets).
  const templateIncludes = new Map() // macro name → its bodies' includes
  const templateMods = new Map() // macro name → its bodies' `mod`s, each `{ decl, from }` (see buildRustTree)
  const templateCalls = new Map() // macro name → the names its bodies call by bare name
  const invokers = new Map() // macro name → the files invoking it by bare name
  // A package defining a `macro_rules!` of a template macro's name (its own `quote!`) invokes that
  // one everywhere in the package (see buildRustTree): its files are scanned without the name in
  // the template set -- again, for the ones scanned before the definition was met.
  const packageOf = (rel) => ctx.packageInfo(rel)?.dir ?? '.'
  const ownTemplates = new Map() // package → the template names it defines
  const skippedIn = new Map() // package → its files that skipped a template body
  const reduced = new Map() // per package's own set: TEMPLATE_MACROS less those, one object
  const scanFor = (relPath, content) => {
    const own = ownTemplates.get(packageOf(relPath))
    const build = buildOf(relPath, ctx, units)
    if (own === undefined) return cachedScan(sources, relPath, content, build)
    const set = reduced.get(own) ?? reduced.set(own, new Set([...TEMPLATE_MACROS].filter((name) => !own.has(name)))).get(own)
    return cachedScan(sources, relPath, content, build, set)
  }
  // Record `file` as compiled as each of `more` too; whether that is news.
  const addUnits = (file, more) => {
    const have = units.get(file)
    if (have === undefined) {
      units.set(file, new Set(more))
      return true
    }
    if (more.isSubsetOf(have)) return false
    for (const u of more) have.add(u)
    return true
  }
  for (const e of entries) addUnits(e, unitsOf(units, e))
  // Files already walked that are now compiled as more units: gone through again (their build
  // changed, and so may what they name, and as what).
  const revisit = new Set(entries.filter((e) => sources.has(e) && !formats?.has(e)))

  // What a Rust file names, queued for the next wave: compiled as the naming file is -- as its
  // units, a crate as unitOfCrate says (`as`) -- and, for a vendored crate's, within its package
  // (`within`).
  let next = []
  const queue = (from, file, { rust, within = boundaryOf(from, ctx), as = unitsOf(units, from) }) => {
    if (rust) {
      rustFiles.add(file)
      // Named as Rust source after being carried as an asset: read again, as source.
      if (assets.delete(file) && sources.has(file)) {
        sources.delete(file)
        formats?.delete(file)
      }
    }
    if (!boundaries.has(file)) boundaries.set(file, within)
    const grew = addUnits(file, as)
    if (!sources.has(file)) next.push(file)
    else if (grew && rust && !formats?.has(file)) revisit.add(file)
  }
  // An include macro's file, relative to `from` (the file it is written in, or one invoking the
  // macro whose body it is in).
  const includeFrom = (inc, from) => {
    const file = includeTarget(inc, from, ctx)
    if (file === null || file === from) return
    // A FIFO or device named would hang the read; a missing file is the tree pass's to report.
    if (!sources.has(file) && !isFile(join(baseDir, file))) return
    if (inc.kind === 'include') {
      pathLoaded.add(file) // its own `mod`s resolve beside it, as rustc has it
      queue(from, file, { rust: true })
    } else if (!rustFiles.has(file) && !sources.has(file)) {
      assets.set(file, inc.kind)
      queue(from, file, { rust: false })
    }
  }
  // A `mod` declaration's files, relative to `from` (the file it is written in, or one invoking
  // the macro whose body it is in).
  const modFrom = (decl, from) => {
    for (const { file, explicit } of resolveModDecl(decl, from, { ...modOpts, boundary: boundaryOf(from, ctx) })) {
      if (explicit) pathLoaded.add(file)
      queue(from, file, { rust: true })
    }
  }
  // The files of `from`'s package in effect invoking macro `name`: where its template's `mod`s
  // are declared (see buildRustTree).
  const hostsOf = (name, from) => [...effectiveInvokers(name, invokers, templateCalls)].filter((f) => packageOf(f) === packageOf(from))
  // The include macros of every template, relative to every file in effect invoking it; its
  // `mod`s relative to those of its own package.
  const expandTemplates = () => {
    for (const [name, incs] of templateIncludes) {
      for (const f of effectiveInvokers(name, invokers, templateCalls)) for (const inc of incs) includeFrom(inc, f)
    }
    for (const [name, decls] of templateMods) for (const { decl, from } of decls.values()) for (const f of hostsOf(name, from)) modFrom(decl, f)
  }

  // A template's `mod`s that nothing in its package invokes by bare name stand beside its
  // definition (see buildRustTree): walked once nothing else is left to, and what they name after.
  const placed = new Set()
  const placeUninvoked = () => {
    for (const [name, decls] of templateMods) {
      for (const { decl, from } of decls.values()) {
        if (placed.has(decl) || hostsOf(name, from).length > 0) continue
        placed.add(decl)
        modFrom(decl, from)
      }
    }
  }

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0 && revisit.size === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          assertRealPathWithinBase(realBase, baseDir, relPath)
          // A vendored crate's file must really lie in its package: a symlink out of it (to the
          // project's `.env`, say) is refused like an include naming the target outright.
          const within = boundaries.get(relPath)
          if (within !== undefined && within !== '.') {
            const rel = relative(realpathSync(join(baseDir, within)), realpathSync(join(baseDir, relPath))).split(/[\\/]/u).join('/')
            if (rel.startsWith('..') || isAbsolute(rel)) {
              console.warn(`[loader.rust] Refusing file outside its package: ${relPath} (a link out of ${within})`)
              return null
            }
          }
          // Rust source (a module, a build script, an `include!`d file) and an `include_str!` asset
          // are UTF-8 text, or rustc rejects them: one that isn't is refused, never carried with
          // its bytes replaced. An `include_bytes!` asset is any bytes, carried as base64 if need be.
          const kind = assets.get(relPath)
          const buf = await readFile(join(baseDir, relPath))
          const utf8 = isUtf8(buf)
          if (!utf8 && kind !== 'include_bytes') throw new Error(`${kind === undefined ? 'Rust source' : 'include_str! file'} is not valid UTF-8: ${relPath}`)
          if (kind === undefined) return [relPath, buf.toString('utf8'), false]
          formats?.set(relPath, utf8 ? 'resource' : 'resource:base64')
          return [relPath, utf8 ? buf.toString('utf8') : buf.toString('base64'), true]
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
    next = []
    // What a Rust file names, queued (see queue). Run again for a file whose package turned out
    // to define a template macro (below): the file's `quote!` bodies are its own then.
    const handle = (relPath, content) => {
      const here = unitsOf(units, relPath)
      const items = scanFor(relPath, content)
      const { mods, refs, externCrates, bindings, includes, macros, invocations } = items
      const pkg = packageOf(relPath)
      if (items.skipped.size > 0) (skippedIn.get(pkg) ?? skippedIn.set(pkg, new Set()).get(pkg)).add(relPath)
      for (const m of macros) {
        if (!TEMPLATE_MACROS.has(m.name)) continue
        const own = ownTemplates.get(pkg) ?? ownTemplates.set(pkg, new Set()).get(pkg)
        if (own.has(m.name)) continue
        own.add(m.name)
        for (const f of skippedIn.get(pkg) ?? []) if (f !== relPath) handle(f, sources.get(f))
      }
      // An `include!`d file's `mod` declarations resolve beside that file (it is in `pathLoaded`
      // from when it was queued), within its package.
      // A template's `mod`s wait for the files invoking it (expandTemplates).
      for (const decl of mods) {
        if (decl.template === null) modFrom(decl, relPath)
        else (templateMods.get(decl.template) ?? templateMods.set(decl.template, new Map()).get(decl.template)).set(`${relPath}\0${decl.at}`, { decl, from: relPath })
      }
      // `include!("x.rs")` splices Rust source (scanned next wave, under this module); the asset
      // macros name a file to carry as it is. A build-output path (`concat!(env!("OUT_DIR"), …)`)
      // never gets here. A template's include macros are resolved once the wave is in
      // (expandTemplates), against the files invoking it.
      for (const inc of includes) includeFrom(inc, relPath)
      for (const m of macros) {
        if (m.includes.length > 0) {
          const list = templateIncludes.get(m.name) ?? templateIncludes.set(m.name, []).get(m.name)
          for (const inc of m.includes) if (!list.some((x) => x.kind === inc.kind && x.path === inc.path && x.base === inc.base)) list.push(inc)
        }
        for (const name of m.calls) (templateCalls.get(m.name) ?? templateCalls.set(m.name, new Set()).get(m.name)).add(name)
      }
      for (const name of invocations) (invokers.get(name) ?? invokers.set(name, new Set()).get(name)).add(relPath)
      // A reference to an in-tree crate pulls its root in (a crate root by role, whatever its
      // name -- `[lib] path` may point anywhere); the root's own `mod` edges follow next wave.
      const leads = new Set()
      for (const e of externCrates) if (!NON_CRATE_LEADS.has(e.name)) leads.add(e.name)
      for (const r of refs) {
        const name = crateLead(r, bindings)
        if (name !== null) leads.add(name)
      }
      for (const name of leads) {
        const lib = ctx.resolveCrate(name, relPath)
        if (!lib) continue
        roots.add(lib)
        queue(relPath, lib, { rust: true, within: boundaryOf(lib, ctx), as: new Set([...here].map((u) => ctx.unitOfCrate(lib, u))) })
      }
    }
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content, asset] = entry
      sources.set(relPath, content)
      if (!asset) handle(relPath, content)
    }
    for (;;) {
      expandTemplates()
      if (revisit.size === 0) break
      const again = [...revisit]
      revisit.clear()
      for (const relPath of again) handle(relPath, sources.get(relPath))
    }
    if (next.length === 0) placeUninvoked()
    const following = next
    await processWave(following)
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

  const cargo = createCargoContext(baseDir, { entries: lines })
  const formats = new Map()
  const sources = await collectRustFilesFromDisk(baseDir, lines, { cargo, formats })
  return { ...buildRustTree(sources, { roots: lines, baseDir, cargo, formats }), formats }
}
