// Rust loader: `{ sources, resolutions, missing }` from a crate's files.
//
// Reachability follows what rustc follows. A `mod foo;` declaration (incl. `#[path = …]` and
// `#[cfg_attr(…, path = …)]`) pulls a module file in, and a reference to a crate whose source is
// in-tree -- the package's own lib target, a Cargo `path` dependency, or a `cargo vendor`ed crate
// -- pulls that crate's root in. `crate::` / `self::` / `super::` / relative paths resolve against
// the per-crate module tree for the import graph but never widen the walk: a `use` can't add a
// file to a crate, only `mod` can. Registry dependencies that aren't vendored live outside the
// bundle root and are dropped.

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'
import { VENDOR_DIR, createCargoContext, isFile, isTestTargetPath, matchClose, normName, normalizeRel, splitTopLevel } from './cargo.js'

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
const EXTERN_CRATE_RE = /extern\s+crate\s+(?:r#)?(\w+)(?:\s+as\s+(?:r#)?(\w+))?\s*;/uy
// Expression-position paths: any `lead::…` path whose lead is lowercase (skipping `Type::assoc`
// associated-item paths) -- a `crate`/`self`/`super` keyword path, or one led by a module or
// crate name. Runs over the masked view, so string contents can't fake one.
const LEAD_PATH_RE = /\b([a-z_]\w*)(?:::\w+)+/gu
const ATTR_PATH_RE = /^\s*path\s*=\s*"([^"]*)"\s*$/u

const normalizeCfg = (pred) => pred.replaceAll(/\s+/gu, ' ').trim()

const FEATURE_CFG_RE = /^feature\s*=\s*"([^"]*)"$/u

// Three-valued evaluation of a cfg predicate: `false` when it can never hold in the build (so the
// item it gates is dead code for the bundle), `true` when it always does, `null` when the loader
// can't tell. `all`/`any`/`not` compose. `test` holds only in a test/bench target (`env.test`);
// `doctest` and `doc` never do when a program is built; `feature = "x"` is decided against
// `env.features`, the crate's resolved feature set (see cargo.js), and unknown without one; every
// other leaf (`unix`, `target_os = …`) depends on the target and stays unknown.
export function evalCfg(pred, env = {}) {
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'test') return env.test === true
    if (p === 'doctest' || p === 'doc') return false
    const feature = FEATURE_CFG_RE.exec(p)
    if (feature && env.features) return env.features.has(feature[1])
    return null
  }
  const args = splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean).map((a) => evalCfg(a, env))
  if (m[1] === 'not') return args.length === 1 && args[0] !== null ? !args[0] : null
  if (m[1] === 'all') return args.includes(false) ? false : (args.every((a) => a === true) ? true : null)
  return args.includes(true) ? true : (args.every((a) => a === false) ? false : null)
}

// Combine an item's cfg predicates (several `#[cfg]` attributes all apply) into one; null when ungated.
const joinCfgs = (preds) => (preds.length === 0 ? null : (preds.length === 1 ? preds[0] : `all(${preds.join(', ')})`))

const CFG_ATTR_RE = /^\s*cfg\s*\(([\s\S]*)\)\s*$/u

// One outer attribute's text (inside `#[…]`) → `cfg`: the predicate gating the item (`#[cfg(<pred>)]`;
// `test` for a `#[test]` fn; for `#[cfg_attr(<pred>, cfg(<inner>))]` the item is compiled unless
// pred holds and inner doesn't, i.e. `any(not(pred), inner)`; null when the item is unconditional
// -- a `cfg_attr` applying any other attribute, `doc(cfg(…))` included, gates nothing) and
// `paths`: the module file paths it names, `#[path = "…"]` outright (cfg null) or each
// `#[cfg_attr(<pred>, path = "…")]` under its predicate.
function parseAttr(text) {
  const path = ATTR_PATH_RE.exec(text)
  if (path) return { cfg: null, paths: [{ path: path[1], cfg: null }] }
  if (/^\s*test\s*$/u.test(text)) return { cfg: 'test', paths: [] }
  const cfg = CFG_ATTR_RE.exec(text)
  if (cfg) return { cfg: normalizeCfg(cfg[1]), paths: [] }
  const cfgAttr = /^\s*cfg_attr\s*\(([\s\S]*)\)\s*$/u.exec(text)
  if (cfgAttr) {
    const parts = splitTopLevel(cfgAttr[1])
    const pred = normalizeCfg(parts.shift() ?? '')
    const paths = []
    const inner = []
    for (const part of parts) {
      const m = ATTR_PATH_RE.exec(part)
      const c = CFG_ATTR_RE.exec(part)
      if (m) paths.push({ path: m[1], cfg: pred })
      else if (c) inner.push(normalizeCfg(c[1]))
    }
    return { cfg: inner.length === 0 ? null : `any(not(${pred}), ${joinCfgs(inner)})`, paths }
  }
  return { cfg: null, paths: [] }
}

// Flatten a `use` tree body (the text between `use` and `;`) into the paths it imports, as
// `{ segments, absolute, spec, binding }`: `a::{b::C, d::{E, F}}` → `a::b::C`, `a::d::E`, `a::d::F`;
// a glob or `self` inside a group names the group's own module; a leading `::` marks the path
// absolute (an external crate). `spec` is the flat path as it would be written; `binding` the name
// the import brings into scope (its last segment, or the `as` alias; null for a glob or `_`).
export function parseUseTree(body) {
  const tokens = [...body.matchAll(/::|[{},*]|\bas\b|(?:r#)?\w+/gu)].map((m) => m[0])
  const out = []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isIdent = (tok) => tok !== undefined && tok !== 'as' && /^(?:r#)?\w+$/u.test(tok)
  const emit = (segments, absolute, binding) => {
    if (segments.length > 0) {
      out.push({ segments, absolute, spec: `${absolute ? '::' : ''}${segments.join('::')}`, binding: binding === '_' ? null : binding })
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
      emit(prefix, absolute, null)
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
    emit(segments, absolute, alias ?? segments.at(-1))
  }
  parse([], false)
  return out
}

// Statically scan one file's items. An item whose cfg can never hold in the build (`#[cfg(test)]`,
// `#[test]`, `#[cfg(doc)]`, or a `#[cfg(feature = "x")]` with `x` off in the crate's resolved
// `features`) is skipped whole -- an inline `mod tests { … }` with everything in it, a `fn`'s
// body, a `use` -- so dead modules aren't bundled and the dependencies only dead code reaches for
// don't get pulled in. Returns
//   mods:         external `mod` declarations `{ name, inlinePath, cfg, conditional, paths }` --
//                 `inlinePath` is the chain of inline `mod x { … }` blocks it sits in, `cfg` the
//                 `#[cfg(…)]` predicate gating it (several → `all(…)`; null when ungated),
//                 `conditional` marks one that may not exist as an item (a cfg the loader can't
//                 decide, an inline ancestor so gated, or inside a macro invocation body), `paths`
//                 the explicit file paths its attributes name (see parseAttr), minus the
//                 `cfg_attr` variants whose predicate can't hold in the build;
//   refs:         path references `{ spec, segments, absolute, inlinePath, fromUse }` -- flattened
//                 `use` trees plus expression-position `crate::`/`self::`/`super::`/`lead::…` paths;
//   externCrates: `extern crate x [as y];` names, with their inlinePath;
//   bindings:     names the file's `use` items and `extern crate … as` aliases bring into scope --
//                 a path lead among them names an import, not a crate.
export function scanRustItems(content, { features = null, test = false } = {}) {
  const env = { features, test }
  const { code, masked } = lexRust(content)
  const n = masked.length
  const mods = []
  const uses = []
  const useSpans = [] // [start, end) of each `use` item's body, parsed as a tree below
  const deadSpans = [] // [start, end) of each skipped test/doc-only item
  const externCrates = []
  const bindings = new Set()
  const spans = [] // closed inline module blocks: { start, end, path }
  const stack = [] // open inline modules: { name, depth, conditional, start }
  let depth = 0
  let pending = [] // parsed outer attributes (parseAttr) waiting for their item
  // End of the outermost macro invocation body being scanned (`m! { … }`, `m!( … )`,
  // `macro_rules! m { … }`). Its tokens are macro input: a `mod x;` there only becomes an item if
  // the macro emits it (cfg_if! does; serde_with's generate_guide! turns it into an inline module
  // documented from a .md file), so such declarations are followed when their file exists and
  // tolerated when it doesn't -- the same footing as a `#[cfg]`-gated one.
  let macroUntil = -1

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
    while (at < n && WS_RE.test(masked[at])) at++
    return at
  }
  // The end of the item starting at `from`, without leaving its enclosing block: through a
  // top-level `;` or `,` (a field, variant or match arm), or its `{ … }` body; a `}` or `)`
  // closing the enclosing block is left for the main loop. Parentheses/brackets nest (a tuple
  // field's `(u8, u8)` comma isn't the item's end).
  const skipItem = (from) => {
    let nest = 0
    for (let k = from; k < n; k++) {
      const ch = masked[k]
      if (ch === '(' || ch === '[') nest++
      else if (ch === ')' || ch === ']') {
        if (--nest < 0) return k
      } else if (nest === 0) {
        if (ch === ';' || ch === ',') return k + 1
        if (ch === '}') return k
        if (ch === '{') return matchClose(masked, k) + 1
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
    if (ch === '#' && (masked[i + 1] === '[' || (masked[i + 1] === '!' && masked[i + 2] === '['))) {
      const outer = masked[i + 1] === '['
      const open = outer ? i + 1 : i + 2
      const close = matchClose(masked, open)
      // An inner `#![…]` attribute applies to the enclosing module, not to the next item.
      if (outer) pending.push(parseAttr(code.slice(open + 1, close)))
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
    // The cfg gating the item the pending attributes belong to (several `#[cfg]`s all apply).
    // `pub` is visibility, not the item: its attributes stay pending for the keyword after it.
    const cfg = word === 'pub' ? null : joinCfgs(pending.map((a) => a.cfg).filter((c) => c !== null))
    // An item gated on a cfg that never holds in the build is dead code for the bundle: skip it
    // whole -- a declaration through its `;`, a field or variant through its `,`, a body or block
    // through its `}` -- without recording anything in it.
    if (cfg !== null && evalCfg(cfg, env) === false) {
      pending = []
      const end = skipItem(i + word.length)
      deadSpans.push([i, end])
      i = end
      continue
    }
    // `name!` followed by a bracket opens a macro invocation body (`macro_rules! name` too).
    const bang = skipWs(i + word.length)
    if (masked[bang] === '!') {
      let open = skipWs(bang + 1)
      if (word === 'macro_rules') {
        const name = readWord(open)
        if (name !== null) open = skipWs(open + name.length)
      }
      if (masked[open] === '{' || masked[open] === '(' || masked[open] === '[') {
        macroUntil = Math.max(macroUntil, matchClose(masked, open))
      }
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
      const attrs = pending
      pending = []
      // Dead cfgs were skipped above; a decidable-true one (`not(test)`) is as firm as no cfg at all.
      const conditional = (cfg !== null && evalCfg(cfg, env) !== true) || stack.some((s) => s.conditional) || i < macroUntil
      if (masked[k] === ';') {
        // A `#[cfg_attr(<pred>, path = …)]` whose predicate can't hold names nothing in this build.
        const paths = attrs.flatMap((a) => a.paths).filter((p) => p.cfg === null || evalCfg(p.cfg, env) !== false)
        mods.push({ name, inlinePath: inlinePath(), cfg, conditional, paths })
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
      for (const p of parseUseTree(code.slice(i + 3, stop))) {
        uses.push({ ...p, inlinePath: ip })
        // A binding hides a crate name only when it is something else: `use std::io;` binds `io`,
        // but `use serde_json;` / `use rand::{self, Rng};` bind the crate itself under its own name.
        if (p.binding !== null && (p.segments.length > 1 || p.binding !== p.segments[0])) bindings.add(p.binding)
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
        externCrates.push({ name: m[1], inlinePath: inlinePath() })
        if (m[2] !== undefined) bindings.add(m[2])
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
    if (PATH_KEYWORDS.has(m[1])) keywordPaths.push(m)
    else if (!NON_CRATE_LEADS.has(m[1])) leadPaths.push(m)
  }
  for (const m of [...keywordPaths, ...leadPaths]) addRef(m[0], m[0].split('::'), false, inlineAt(m.index), false)
  return { mods, refs: [...refs.values()], externCrates, bindings }
}

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
// siblings. An entry not named main.rs/lib.rs also gets the non-root `<stem>/` rule as a
// fallback, so a glob-listed module file still resolves.
export function resolveModPath(modName, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [] } = {}) {
  const dirs = [getModuleDir(fromFile, { root: ownsDir(fromFile, { roots, pathLoaded }) })]
  if (roots?.has(fromFile)) dirs.push(getModuleDir(fromFile)) // the same dir for main.rs/lib.rs/mod.rs
  for (const dir of new Set(dirs)) {
    const base = [dir, ...inlinePath, modName].filter(Boolean).join('/')
    const found = firstFile([`${base}.rs`, `${base}/mod.rs`], { knownSources, baseDir })
    if (found) return found
  }
  return null
}

// Resolve a `#[path = "…"]` target the way rustc does: relative to the declaring file's directory,
// or -- inside inline modules -- to the file's module dir plus the inline module names. Absolute
// or root-escaping paths resolve to nothing (a read would refuse them anyway).
export function resolveExplicitModPath(explicitPath, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [] } = {}) {
  const dir = inlinePath.length === 0
    ? posix.dirname(fromFile)
    : [getModuleDir(fromFile, { root: ownsDir(fromFile, { roots, pathLoaded }) }), ...inlinePath].filter(Boolean).join('/')
  const rel = normalizeRel(dir, explicitPath)
  return rel === null ? null : firstFile([rel], { knownSources, baseDir })
}

// Every file a `mod` declaration can denote, as `{ cfg, file, explicit }`: an unconditional
// `#[path]` names one outright; otherwise each `#[cfg_attr(<pred>, path = …)]` names one under
// its predicate (`cfg`; the scanner already dropped the variants whose predicate can't hold in
// the build), and the default `<name>.rs`/`<name>/mod.rs` lookup is the fallback (`cfg` null).
// `explicit` marks a file a `#[path]` named (its own submodules then sit beside it).
export function resolveModDecl(decl, fromFile, opts = {}) {
  const o = { ...opts, inlinePath: decl.inlinePath }
  const unconditional = decl.paths.find((p) => p.cfg === null)
  if (unconditional) {
    const file = resolveExplicitModPath(unconditional.path, fromFile, o)
    return file ? [{ cfg: null, file, explicit: true }] : []
  }
  const out = []
  for (const { path, cfg } of decl.paths) {
    const file = resolveExplicitModPath(path, fromFile, o)
    if (file && !out.some((x) => x.file === file)) out.push({ cfg, file, explicit: true })
  }
  const fallback = resolveModPath(decl.name, fromFile, o)
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

// The crate a path's lead may name: null for a path keyword or a sysroot crate, and -- unless the
// path is absolute (`::name::…`) -- for a name the file imported (`bindings`: `use std::io;
// io::stdin()` names no crate `io`).
const crateLead = ({ segments, absolute }, bindings) => {
  const head = segments[0]
  return head === undefined || NON_CRATE_LEADS.has(head) || (!absolute && bindings.has(head)) ? null : head
}

// Resolve one path reference made in `file` to what it names in the bundle: a module file of the
// same crate (`{ kind: 'module', target }`) for `crate::`/`self::`/`super::` paths and for
// 2018-style relative paths whose lead is a child module of the current module; else an in-tree
// crate root (`{ kind: 'crate', name, target }`) via `resolveCrate`, or `{ kind: 'unresolved',
// name }` when the lead could name a crate (crateLead) but nothing in-tree did; null for anything
// else (an item in scope, std, a path above the crate root).
function resolvePathRef(ref, file, { trees, files, resolveCrate, bindings }) {
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
  const name = crateLead(ref, bindings)
  if (name === null) return null
  const target = resolveCrate(name, file)
  return target ? { kind: 'crate', name, target } : { kind: 'unresolved', name }
}

// Bundle import keys can't contain '/'; a cfg predicate practically never does, but fail safe.
const cfgKey = (cfg) => (cfg ?? '*').replaceAll('/', '|')

// Whether `rel` is compiled with `cfg(test)`: a file of a test/bench target (`tests/*.rs`,
// `benches/*.rs` and their modules), judged against its package dir when a Cargo context knows it.
const isTestTarget = (rel, ctx) => (ctx ? ctx.isTestTarget(rel) : isTestTargetPath('.', rel))

// Scan results per `sources` map, so the tree pass reuses the walk's scan of each file when it
// ran under the same build (the same feature set object and test flag).
const scanCache = new WeakMap()
function cachedScan(sources, path, content, build) {
  if (!scanCache.has(sources)) scanCache.set(sources, new Map())
  const cache = scanCache.get(sources)
  const hit = cache.get(path)
  if (hit && hit.features === build.features && hit.test === build.test) return hit.items
  const items = scanRustItems(content, build)
  cache.set(path, { ...build, items })
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
// informational, never fatal. A `cargo` context (cargo.js) may be passed in to share one
// between the walk and this pass; it also carries each crate's resolved features, which decide
// `#[cfg(feature = …)]`.
export function buildRustTree(sources, { roots = [], baseDir = null, cargo = null } = {}) {
  const ctx = cargo ?? (baseDir ? createCargoContext(baseDir, { entries: roots }) : null)
  const rootSet = crateRoots(sources, roots, ctx)
  const resolutions = new Map()
  const missing = []
  const unresolvedCrates = new Set()
  const scanned = new Map()
  for (const [path, content] of sources) {
    scanned.set(path, cachedScan(sources, path, content, { features: ctx?.featuresFor(path) ?? null, test: isTestTarget(path, ctx) }))
  }
  // Files a `#[path]` names own their directory (see getModuleDir), so find those before resolving
  // any default `mod` lookup; a path-loaded file may itself hold inline modules with `#[path]`s,
  // hence the loop to a fixed point.
  const pathLoaded = new Set()
  const modOpts = { knownSources: sources, roots: rootSet, pathLoaded }
  for (let grew = true; grew;) {
    grew = false
    for (const [path, items] of scanned) {
      for (const decl of items.mods) {
        if (decl.paths.length === 0) continue
        for (const t of resolveModDecl(decl, path, modOpts)) {
          if (t.explicit && !pathLoaded.has(t.file)) {
            pathLoaded.add(t.file)
            grew = true
          }
        }
      }
    }
  }
  for (const [path, items] of scanned) {
    // spec -> Map<cfg key, file>: each declaration's files under its cfg predicate ('*' when
    // ungated), so `#[cfg(unix)] #[path = "u.rs"] mod imp;` beside `#[cfg(windows)] #[path =
    // "w.rs"] mod imp;` keeps both files. The first declaration of a key wins.
    const byCfg = new Map()
    for (const decl of items.mods) {
      const spec = `mod ${[...decl.inlinePath, decl.name].join('::')}`
      const targets = resolveModDecl(decl, path, modOpts)
      if (targets.length === 0) {
        // conditional && unresolved: cfg-gated module, may be compiled out -- tolerated.
        if (!decl.conditional) {
          console.warn(`[loader.rust] Missing module: ${decl.name} from ${path}`)
          missing.push({ spec, from: path })
        }
        continue
      }
      const keyed = byCfg.get(spec) ?? byCfg.set(spec, new Map()).get(spec)
      for (const t of targets) {
        const key = cfgKey(t.cfg ?? decl.cfg)
        if (!keyed.has(key)) keyed.set(key, t.file)
      }
    }
    // A single file is a flat string; cfg variants stay a Map.
    const specMap = new Map()
    for (const [spec, keyed] of byCfg) specMap.set(spec, keyed.size === 1 ? keyed.values().next().value : keyed)
    resolutions.set(path, specMap)
  }

  const { trees, files } = buildModuleTrees(sources, resolutions, rootSet)
  for (const [path, items] of scanned) {
    const specMap = resolutions.get(path)
    // Only edges to bundled files, never to self, first spelling wins.
    const add = (spec, target) => {
      if (target && target !== path && sources.has(target) && !specMap.has(spec)) specMap.set(spec, target)
    }
    const resolveCrate = (name, from) => ctx?.resolveCrate(name, from) ?? resolveVendoredCrate(name, { knownSources: sources })
    // A crate name nothing in-tree satisfied -- sysroot crates aside, and an uppercase lead is an
    // `Enum::Variant` import, not a crate.
    const noteUnresolved = (name) => {
      if (!OTHER_SYSROOT_CRATES.has(name) && /^[a-z_]/u.test(name)) unresolvedCrates.add(name)
    }
    for (const ref of items.refs) {
      const r = resolvePathRef(ref, path, { trees, files, resolveCrate, bindings: items.bindings })
      if (r === null) continue
      if (r.kind === 'module') add(ref.spec, r.target)
      else if (r.kind === 'crate') add(`use ${r.name}`, r.target)
      // Only a `use` reliably says its lead names a crate (see scanRustItems' `fromUse`).
      else if (ref.fromUse) noteUnresolved(r.name)
    }
    for (const { name } of items.externCrates) {
      if (NON_CRATE_LEADS.has(name)) continue // `extern crate self as x;` / `extern crate alloc;`
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
// the walk (buildRustTree decides what is fatal). `cargo` (cargo.js) resolves crate names and
// carries each crate's features; one is created for `entries` when not passed in.
export async function collectRustFilesFromDisk(baseDir, entries, { cargo = null } = {}) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)
  const roots = new Set(entries)
  const pathLoaded = new Set() // files a `#[path]` named: their submodules sit beside them
  const ctx = cargo ?? createCargoContext(baseDir, { entries })
  const modOpts = { baseDir, roots, pathLoaded }

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
      const build = { features: ctx.featuresFor(relPath), test: isTestTarget(relPath, ctx) }
      const { mods, refs, externCrates, bindings } = cachedScan(sources, relPath, content, build)
      for (const decl of mods) {
        for (const { file, explicit } of resolveModDecl(decl, relPath, modOpts)) {
          if (explicit) pathLoaded.add(file)
          if (!sources.has(file)) next.push(file)
        }
      }
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

  const cargo = createCargoContext(baseDir, { entries: lines })
  const sources = await collectRustFilesFromDisk(baseDir, lines, { cargo })
  return buildRustTree(sources, { roots: lines, baseDir, cargo })
}
