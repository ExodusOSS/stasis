// A TOML reader for the subset build descriptions use -- Cargo.toml, Cargo.lock, .cargo/config,
// foundry.toml: tables, dotted keys, strings (basic, literal, multi-line), arrays and inline
// tables spread over lines, comments -- as a stream of logical lines or of (path, value) entries.
// No dates, no arithmetic, no full grammar: a value it can't read comes back as its raw text.

// --- Bracket helpers (shared with the Rust scanner) -----------------------------------

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

// --- Lines and entries ----------------------------------------------------------------

// `[table]` / `[[array-table]]` header → its name; `key = value` → key (quotes kept) and raw value.
export const TABLE_HEADER_RE = /^\[\[?\s*([^\]]+?)\s*\]\]?/u
export const KEY_VALUE_RE = /^([\w."'-]+)\s*=\s*([\s\S]+)$/u

// One physical line: `code` is the line without its `# comment`, `depth` its net bracket depth,
// both judged outside quoted strings (a `#`, `[` or `{` inside one is text).
function scanTomlLine(line) {
  let depth = 0
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === '#') return { code: line.slice(0, i), depth }
  }
  return { code: line, depth }
}

// Physical lines → logical lines: a `key = """` / `key = '''` multi-line string takes the lines
// up to its closing delimiter verbatim (a `[x]` inside a description is text, not a table), and a
// `key = [` / `key = {` whose brackets don't close on the line takes the following lines up to
// the close (multi-line arrays are how long `features` lists and `members` are written).
// Comments are dropped from the non-string lines. Each comes with the span of physical lines
// (`first`..`last`, 0-based) it took.
function* logicalLineSpans(text) {
  const raw = text.split('\n')
  for (let i = 0; i < raw.length; i++) {
    const first = i
    let { code: line, depth } = scanTomlLine(raw[i])
    const kv = KEY_VALUE_RE.exec(line.trim())
    if (kv) {
      const ml = /^("""|''')/u.exec(kv[2])
      if (ml && kv[2].indexOf(ml[1], 3) === -1) {
        line = raw[i]
        while (i + 1 < raw.length) {
          line += `\n${raw[++i]}`
          if (raw[i].includes(ml[1])) break
        }
      } else {
        while (depth > 0 && i + 1 < raw.length) {
          const next = scanTomlLine(raw[++i])
          line += `\n${next.code}`
          depth += next.depth
        }
      }
    }
    yield { line, first, last: i }
  }
}

export const logicalLines = (text) => [...logicalLineSpans(text)].map((l) => l.line)

// A dotted TOML key or table name -> its segments, quotes dropped (a quoted segment keeps its dots:
// `profile."ci.fast"` is ['profile', 'ci.fast']).
export function splitTomlKey(key) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of key) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '.') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

// Every `[header]` and `key = value` of a TOML text, in order, for readers of other TOML configs
// (foundry.toml): a header as `{ path, header: true }` (the table's segments), a pair as
// `{ path, header: false, value }` (the enclosing table's segments then the key's), each with the
// physical lines (`first`..`last`) it spans.
export function* tomlEntries(text) {
  let table = []
  for (const { line: raw, first, last } of logicalLineSpans(text)) {
    const line = raw.trim()
    const header = TABLE_HEADER_RE.exec(line)
    if (header) {
      table = splitTomlKey(header[1])
      yield { path: table, header: true, first, last }
      continue
    }
    const kv = KEY_VALUE_RE.exec(line)
    if (kv) yield { path: [...table, ...splitTomlKey(kv[1])], header: false, value: parseTomlValue(kv[2]), first, last }
  }
}

const TOML_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

// One TOML value: quoted string, bool, array (as an array), or a single-line inline table (as a
// plain object); anything else is returned raw.
export function parseTomlValue(raw) {
  const text = raw.trim()
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const delim = text.slice(0, 3)
    const end = text.indexOf(delim, 3)
    return (end === -1 ? text.slice(3) : text.slice(3, end)).replace(/^\n/u, '')
  }
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/u.exec(text)
    if (!m) return text
    return m[1].replaceAll(/\\(u[\dA-Fa-f]{4}|U[\dA-Fa-f]{8}|.)/gu, (_, e) => (e.length > 1 ? String.fromCodePoint(Number.parseInt(e.slice(1), 16)) : TOML_ESCAPES[e] ?? e))
  }
  if (text.startsWith("'")) {
    const m = /^'([^']*)'/u.exec(text)
    return m ? m[1] : text
  }
  if (text.startsWith('{')) {
    const end = matchClose(text, 0)
    const table = {}
    for (const part of splitTopLevel(text.slice(1, end))) {
      const kv = KEY_VALUE_RE.exec(part.trim())
      if (kv) table[kv[1].replaceAll(/["']/gu, '')] = parseTomlValue(kv[2])
    }
    return table
  }
  if (text.startsWith('[')) {
    const end = matchClose(text, 0)
    return splitTopLevel(text.slice(1, end)).map((p) => p.trim()).filter(Boolean).map(parseTomlValue)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}
