// A TOML 1.0 reader for the build descriptions the loaders take -- Cargo.toml, Cargo.lock,
// foundry.toml -- as the document's `[header]`s and `key = value` pairs in order, each with the
// table path it lands at. It reads the whole grammar and refuses what isn't TOML: a bad escape, an
// unterminated string, text after a value, a missing comma, a bare word where a value goes, a key
// or table defined twice, a number with a leading zero ... each is a TomlError naming the file and
// line, never a guessed value. Values are JavaScript ones: strings, numbers (an integer past 2^53
// is a BigInt), booleans, arrays and inline tables (as null-prototype objects); a date or time is
// checked and kept as its text.

// --- Bracket helpers (for the Rust scanner) ----------------------------------------------

// Index of the bracket closing the one opened at `open`, or the last index when unbalanced.
export function matchClose(text, open) {
  const close = { '[': ']', '(': ')', '{': '}' }[text[open]]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return text.length - 1
}

// Split on commas outside brackets/braces/parentheses/strings.
export function splitTopLevel(text) {
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
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

// --- The reader -----------------------------------------------------------------------------

export class TomlError extends Error {
  constructor(message, file, line) {
    super(`${file === null ? `line ${line}` : `${file}:${line}`}: ${message}`)
    this.name = 'TomlError'
    this.file = file
    this.line = line
  }
}

// Sticky patterns, matched at the reader's position. A scalar must end where a value can: at
// whitespace, a line end, `,`, `]`, `}`, a comment or the end of the text.
const END = String.raw`(?=[ \t\r\n,\]}#]|$)`
const WS_RE = /[ \t]*/uy
const NEWLINE_RE = /\r?\n/uy
const BARE_KEY_RE = /[\w-]+/uy
const BARE_KEY_FULL_RE = /^[\w-]+$/u
// The control characters TOML bans outside escapes (tab excepted); multi-line strings allow LF too.
const CONTROL = String.raw`\u0000-\u0008\u000A-\u001F\u007F`
const CONTROL_MULTILINE = String.raw`\u0000-\u0008\u000B-\u001F\u007F`
const COMMENT_RE = new RegExp(`#[^${CONTROL}]*`, 'uy')
const BAD_TOKEN_RE = /[^ \t\r\n,\]}#]*/uy
const BOOL_RE = new RegExp(String.raw`(?:true|false)${END}`, 'uy')
const NUMBER_RE = new RegExp(String.raw`([+-]?(?:0|[1-9](?:_?\d)*))(\.\d(?:_?\d)*)?([Ee][+-]?\d(?:_?\d)*)?${END}`, 'uy')
const RADIX_RE = new RegExp(String.raw`0(?:x([\dA-Fa-f](?:_?[\dA-Fa-f])*)|o([0-7](?:_?[0-7])*)|b([01](?:_?[01])*))${END}`, 'uy')
const SPECIAL_FLOAT_RE = new RegExp(String.raw`([+-]?)(inf|nan)${END}`, 'uy')
const TIME = String.raw`(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?`
const DATETIME_RE = new RegExp(String.raw`(\d{4})-(\d{2})-(\d{2})(?:[Tt ]${TIME}(?:[Zz]|[+-](\d{2}):(\d{2}))?)?${END}`, 'uy')
const LOCAL_TIME_RE = new RegExp(`${TIME}${END}`, 'uy')
// Runs of ordinary text inside each kind of string: not its quote, not an escape in the basic
// kinds, and no control character but tab (and LF in the multi-line kinds; CR is handled by hand
// so that only CRLF passes).
const PLAIN_BASIC_RE = new RegExp(String.raw`[^"\\${CONTROL}]+`, 'uy')
const PLAIN_LITERAL_RE = new RegExp(`[^'${CONTROL}]+`, 'uy')
const PLAIN_MULTILINE_BASIC_RE = new RegExp(String.raw`[^"\\${CONTROL_MULTILINE}]+`, 'uy')
const PLAIN_MULTILINE_LITERAL_RE = new RegExp(`[^'${CONTROL_MULTILINE}]+`, 'uy')
// `\` at the end of a line in a multi-line basic string: it and the whitespace up to the next
// non-blank character are dropped.
const LINE_ENDING_BACKSLASH_RE = /[ \t]*\r?\n[ \t\r\n]*/uy
const HEX_RE = /^[\dA-Fa-f]+$/u
const ESCAPES = new Map([['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['"', '"'], ['\\', '\\']])

const isLineEnd = (ch) => ch === undefined || ch === '\n' || ch === '\r'

function validDate(year, month, day) {
  const t = new Date(0)
  t.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  return t.getUTCMonth() === Number(month) - 1 && t.getUTCDate() === Number(day)
}
const validTime = (hour, minute, second, offsetHour = '0', offsetMinute = '0') =>
  Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59

// The reader's picture of a table at `path`: `children` by key, where a leaf holds its `value` and
// an array of tables its `items`; `explicit` once a `[header]` defined it, `dotted` once a dotted
// key passed through it (neither may then be defined again by a header).
const tableNode = (path) => ({ path, children: new Map(), value: undefined, items: null, explicit: false, dotted: false })
const isTable = (node) => node.explicit || node.dotted || node.children.size > 0

const dotted = (path) => path.map((seg) => (BARE_KEY_FULL_RE.test(seg) ? seg : JSON.stringify(seg))).join('.')

// An inline table's contents as a plain (null-prototype) object.
function toObject(node) {
  const out = Object.create(null)
  for (const [key, child] of node.children) out[key] = child.value === undefined ? toObject(child) : child.value
  return out
}

class Reader {
  constructor(text, file) {
    this.text = text
    this.file = file
    this.pos = text.startsWith('﻿') ? 1 : 0 // a byte-order mark is skipped, as cargo and forge do
    this.root = tableNode([])
    this.lineStarts = [0]
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.lineStarts.push(i + 1)
  }

  // The 0-based line holding `pos`.
  lineOf(pos) {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  fail(message, at = this.pos) {
    throw new TomlError(message, this.file, this.lineOf(at) + 1)
  }

  peek(offset = 0) {
    return this.text[this.pos + offset]
  }

  eof() {
    return this.pos >= this.text.length
  }

  // The sticky `re` matched at the position (or null); `take` also moves past the match.
  match(re) {
    re.lastIndex = this.pos
    return re.exec(this.text)
  }

  take(re) {
    const m = this.match(re)
    if (m) this.pos += m[0].length
    return m
  }

  ws() {
    this.take(WS_RE)
  }

  // At the end of the text or of a line (LF or CRLF; a lone CR is a control character).
  atLineEnd() {
    const ch = this.peek()
    return ch === undefined || ch === '\n' || (ch === '\r' && this.peek(1) === '\n')
  }

  // A `# comment` up to its line end.
  comment() {
    this.take(COMMENT_RE)
    if (!this.atLineEnd()) this.fail('control character in a comment')
  }

  // Whitespace, comments and line ends: what may sit between entries and between array items.
  blank() {
    for (;;) {
      this.ws()
      const ch = this.peek()
      if (ch === '#') this.comment()
      else if (ch === '\n') this.pos++
      else if (ch === '\r' && this.peek(1) === '\n') this.pos += 2
      else return
    }
  }

  // After a header or a pair, only whitespace and a comment may follow on the line.
  endOfLine(what) {
    this.ws()
    if (this.peek() === '#') this.comment()
    else if (!this.atLineEnd()) this.fail(`unexpected text after ${what}`)
  }

  // A key -- bare, quoted or dotted: `a.b."c.d"` → ['a', 'b', 'c.d'] -- and the whitespace after it.
  key() {
    const segments = []
    for (;;) {
      const ch = this.peek()
      if (ch === '"') segments.push(this.basicString())
      else if (ch === "'") segments.push(this.literalString())
      else {
        const bare = this.take(BARE_KEY_RE)
        if (!bare) this.fail('expected a key')
        segments.push(bare[0])
      }
      this.ws()
      if (this.peek() !== '.') return segments
      this.pos++
      this.ws()
    }
  }

  // `key = value`, defined under `table`.
  pair(table) {
    const at = this.pos
    const segments = this.key()
    if (this.peek() !== '=') this.fail('expected "=" after the key')
    this.pos++
    this.ws()
    const value = this.value([...table.path, ...segments])
    this.define(table, segments, value, at)
    return { segments, value }
  }

  // The value at the position; `path` is the key it is for (named in messages).
  value(path) {
    const ch = this.peek()
    if (ch === '"') return this.text.startsWith('"""', this.pos) ? this.multilineString('"') : this.basicString()
    if (ch === "'") return this.text.startsWith("'''", this.pos) ? this.multilineString("'") : this.literalString()
    if (ch === '[') return this.array(path)
    if (ch === '{') return this.inlineTable(path)
    return this.scalar()
  }

  // true/false, a number, or a date/time (kept as its text).
  scalar() {
    const at = this.pos
    let m = this.take(BOOL_RE)
    if (m) return m[0] === 'true'
    m = this.take(NUMBER_RE)
    if (m) {
      const digits = m[0].replaceAll('_', '')
      if (m[2] !== undefined || m[3] !== undefined) return Number(digits)
      const int = Number(digits)
      return Number.isSafeInteger(int) ? int : BigInt(digits)
    }
    m = this.take(RADIX_RE)
    if (m) {
      const big = BigInt(`0${m[0][1]}${(m[1] ?? m[2] ?? m[3]).replaceAll('_', '')}`)
      return big <= Number.MAX_SAFE_INTEGER ? Number(big) : big
    }
    m = this.take(SPECIAL_FLOAT_RE)
    if (m) return m[2] === 'nan' ? Number.NaN : (m[1] === '-' ? -Infinity : Infinity)
    m = this.take(DATETIME_RE)
    if (m) {
      const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = m
      if (!validDate(year, month, day) || (hour !== undefined && !validTime(hour, minute, second, offsetHour, offsetMinute))) this.fail(`invalid date "${m[0]}"`, at)
      return m[0]
    }
    m = this.take(LOCAL_TIME_RE)
    if (m) {
      if (!validTime(m[1], m[2], m[3])) this.fail(`invalid time "${m[0]}"`, at)
      return m[0]
    }
    const bad = this.match(BAD_TOKEN_RE)[0]
    return this.fail(bad === '' ? 'expected a value' : `invalid value "${bad}"`)
  }

  // `"..."`: escapes decoded; it must close on its line.
  basicString() {
    const at = this.pos
    this.pos++
    let out = ''
    for (;;) {
      const run = this.take(PLAIN_BASIC_RE)
      if (run) out += run[0]
      const ch = this.peek()
      if (ch === '"') {
        this.pos++
        return out
      }
      if (ch === '\\') {
        this.pos++
        out += this.escape()
      } else if (isLineEnd(ch)) this.fail('unterminated string', at)
      else this.fail('control character in a string')
    }
  }

  // The escape after a `\`.
  escape() {
    const ch = this.peek()
    if (ch === 'u' || ch === 'U') {
      const len = ch === 'u' ? 4 : 8
      const hex = this.text.slice(this.pos + 1, this.pos + 1 + len)
      if (hex.length !== len || !HEX_RE.test(hex)) this.fail(`invalid escape "\\${ch}${hex}"`)
      const code = Number.parseInt(hex, 16)
      if ((code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff) this.fail(`"\\${ch}${hex}" is not a Unicode scalar value`)
      this.pos += 1 + len
      return String.fromCodePoint(code)
    }
    const out = ch === undefined ? undefined : ESCAPES.get(ch)
    if (out === undefined) this.fail(`invalid escape "\\${ch ?? ''}"`)
    this.pos++
    return out
  }

  // `'...'`: as written; it must close on its line.
  literalString() {
    const at = this.pos
    this.pos++
    const run = this.take(PLAIN_LITERAL_RE)
    const ch = this.peek()
    if (ch === "'") {
      this.pos++
      return run ? run[0] : ''
    }
    if (isLineEnd(ch)) this.fail('unterminated string', at)
    return this.fail('control character in a string')
  }

  // `"""…"""` / `'''…'''`: a line end right after the opening delimiter is dropped, a `\` ending a
  // line of the basic kind drops the whitespace up to the next character, and up to two quotes
  // right before the closing delimiter belong to the text.
  multilineString(quote) {
    const at = this.pos
    const delim = quote.repeat(3)
    const plain = quote === '"' ? PLAIN_MULTILINE_BASIC_RE : PLAIN_MULTILINE_LITERAL_RE
    this.pos += 3
    this.take(NEWLINE_RE)
    let out = ''
    for (;;) {
      const run = this.take(plain)
      if (run) out += run[0]
      if (this.text.startsWith(delim, this.pos)) {
        this.pos += 3
        for (let extra = 0; extra < 2 && this.peek() === quote; extra++) {
          out += quote
          this.pos++
        }
        return out
      }
      const ch = this.peek()
      if (ch === quote) {
        out += ch
        this.pos++
      } else if (ch === '\\' && quote === '"') {
        this.pos++
        if (!this.take(LINE_ENDING_BACKSLASH_RE)) out += this.escape()
      } else if (ch === '\r' && this.peek(1) === '\n') {
        out += '\r\n'
        this.pos += 2
      } else if (ch === undefined) this.fail('unterminated string', at)
      else this.fail('control character in a string')
    }
  }

  // `[ v, v, ]`: items may spread over lines, with comments; a trailing comma is fine.
  array(path) {
    const at = this.pos
    this.pos++
    const items = []
    for (;;) {
      this.blank()
      if (this.peek() === ']') {
        this.pos++
        return items
      }
      if (this.eof()) this.fail('unterminated array', at)
      items.push(this.value(path))
      this.blank()
      const ch = this.peek()
      if (ch === ',') this.pos++
      else if (ch === ']') {
        this.pos++
        return items
      } else if (ch === undefined) this.fail('unterminated array', at)
      else this.fail('expected a comma or "]" after the array item')
    }
  }

  // `{ k = v, k = v }` on one line; no trailing comma; keys may be dotted; none twice.
  inlineTable(path) {
    const at = this.pos
    this.pos++
    const table = tableNode(path)
    this.ws()
    if (this.peek() === '}') {
      this.pos++
      return toObject(table)
    }
    for (;;) {
      if (this.atLineEnd()) this.fail('unterminated inline table', at)
      this.pair(table)
      this.ws()
      const ch = this.peek()
      if (ch === '}') {
        this.pos++
        return toObject(table)
      }
      if (ch === ',') {
        this.pos++
        this.ws()
        if (this.peek() === '}') this.fail('trailing comma in an inline table')
      } else if (isLineEnd(ch)) this.fail('unterminated inline table', at)
      else this.fail('expected a comma or "}" after the inline table entry')
    }
  }

  // The child `key` of `node`, made if new.
  child(node, key) {
    let child = node.children.get(key)
    if (!child) {
      child = tableNode([...node.path, key])
      node.children.set(key, child)
    }
    return child
  }

  // `segments = value` under `table`: the prefix segments are tables a dotted key may open or pass
  // through (not a value, an array of tables, or a table a header defined); the last one is new.
  define(table, segments, value, at) {
    let node = table
    for (const seg of segments.slice(0, -1)) {
      const child = this.child(node, seg)
      if (child.value !== undefined || child.items) this.fail(`"${dotted(child.path)}" is not a table`, at)
      if (child.explicit) this.fail(`table [${dotted(child.path)}] is already defined by a header`, at)
      child.dotted = true
      node = child
    }
    const last = segments.at(-1)
    if (node.children.has(last)) this.fail(`duplicate key "${dotted([...node.path, last])}"`, at)
    this.child(node, last).value = value
  }

  // `[segments]` / `[[segments]]` → the table its entries land in. The prefix segments may pass
  // through tables of any kind (an array of tables by its last item); the last must be new, or
  // for `[[x]]` the array of tables to append to.
  header(segments, array, at) {
    let node = this.root
    for (const seg of segments.slice(0, -1)) {
      const child = this.child(node, seg)
      if (child.value !== undefined) this.fail(`"${dotted(child.path)}" is not a table`, at)
      node = child.items ? child.items.at(-1) : child
    }
    const child = this.child(node, segments.at(-1))
    if (child.value !== undefined) this.fail(`"${dotted(child.path)}" is already defined as a value`, at)
    if (array) {
      if (!child.items && isTable(child)) this.fail(`"${dotted(child.path)}" is not an array of tables`, at)
      child.items ??= []
      const item = tableNode(child.path)
      item.explicit = true
      child.items.push(item)
      return item
    }
    if (child.items || child.explicit || child.dotted) this.fail(`duplicate table [${dotted(child.path)}]`, at)
    child.explicit = true
    return child
  }

  // The document's entries in order, each with the physical lines (`first`..`last`, 0-based) it spans.
  document() {
    const entries = []
    let table = this.root
    let tablePath = []
    for (;;) {
      this.blank()
      if (this.eof()) return entries
      const at = this.pos
      const first = this.lineOf(at)
      if (this.peek() === '[') {
        const array = this.peek(1) === '['
        this.pos += array ? 2 : 1
        this.ws()
        const segments = this.key()
        const close = array ? ']]' : ']'
        if (!this.text.startsWith(close, this.pos)) this.fail(`expected "${close}" to close the table header`)
        this.pos += close.length
        table = this.header(segments, array, at)
        tablePath = segments
        this.endOfLine('the table header')
        entries.push({ path: segments, header: true, first, last: first })
      } else {
        const { segments, value } = this.pair(table)
        const last = this.lineOf(this.pos - 1)
        this.endOfLine('the value')
        entries.push({ path: [...tablePath, ...segments], header: false, value, first, last })
      }
    }
  }
}

// Every `[header]` and `key = value` of a TOML text in order: a header as `{ path, header: true }`
// (the table's segments), a pair as `{ path, header: false, value }` (the enclosing table's segments
// then the key's), each with the physical lines (`first`..`last`, 0-based) it spans. Throws a
// TomlError naming `file` and the line on anything that isn't TOML.
export function tomlEntries(text, { file = null } = {}) {
  return new Reader(text, file).document()
}
