// Minimal YAML reader for the subset pnpm writes into pnpm-lock.yaml (and pnpm-workspace.yaml):
// block mappings and sequences by indentation, single-line flow collections (`{a: b}` / `[a, b]`),
// plain / single-quoted / double-quoted scalars, literal (`|`) and folded (`>`) block scalars, and
// `#` comments. Anchors, aliases, tags, multi-document streams and complex keys are rejected: a
// lockfile is machine-written, so anything outside this subset is a malformed input, not a case to
// guess at. Values are typed the way js-yaml (pnpm's writer) types them: `true`/`false`, `null`/`~`,
// and plain scalars spelling a JSON number become numbers; everything else stays a string.

class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `${message} (line ${line})`)
    this.name = 'YamlError'
  }
}

// Index of the first `#` that starts a comment (preceded by whitespace or at column 0, outside
// quotes), or -1. Quote tracking is needed because `#` is legal inside a quoted scalar.
function commentStart(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      // A quote only opens a scalar at a value/key boundary; mid-word quotes (e.g. in URLs) are literal.
      const prev = i === 0 ? ' ' : text[i - 1]
      if (/[\s:,[{-]/u.test(prev)) quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/u.test(text[i - 1]))) return i
  }
  return -1
}

function stripComment(text) {
  const at = commentStart(text)
  return (at === -1 ? text : text.slice(0, at)).trimEnd()
}

function unescapeDouble(body, line) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = body[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '0': out += '\0'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case ' ': out += ' '; break
      case 'x': out += String.fromCodePoint(Number.parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break
      case 'u': out += String.fromCodePoint(Number.parseInt(body.slice(i + 1, i + 5), 16)); i += 4; break
      case 'U': out += String.fromCodePoint(Number.parseInt(body.slice(i + 1, i + 9), 16)); i += 8; break
      default: throw new YamlError(`Unsupported escape \\${n ?? ''}`, line)
    }
  }
  return out
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u

// Type a plain (unquoted) scalar the way js-yaml's default schema does for the values pnpm emits.
function typePlain(text) {
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~' || text === '') return null
  if (NUMBER.test(text)) return Number(text)
  return text
}

// Parse one scalar token that is the whole `text` (already comment-stripped and trimmed).
function parseScalar(text, line) {
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError('Unterminated single-quoted scalar', line)
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new YamlError('Unterminated double-quoted scalar', line)
    return unescapeDouble(text.slice(1, -1), line)
  }
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new YamlError(`Unsupported YAML feature in scalar '${text}'`, line)
  }
  return typePlain(text)
}

// Split a flow collection body on top-level commas (quotes and nested brackets respected).
function splitFlow(body, line) {
  const items = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      const prev = i === 0 ? ' ' : body[i - 1]
      if (/[\s:,[{]/u.test(prev)) quote = c
    } else if (c === '[' || c === '{') {
      depth++
    } else if (c === ']' || c === '}') {
      depth--
      if (depth < 0) throw new YamlError('Unbalanced flow collection', line)
    } else if (c === ',' && depth === 0) {
      items.push(body.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0 || quote) throw new YamlError('Unbalanced flow collection', line)
  items.push(body.slice(start))
  return items.map((s) => s.trim()).filter((s, idx, arr) => !(s === '' && idx === arr.length - 1))
}

// Index of the mapping separator `:` in a single-line `key: value` (or `key:`), honouring quoted keys;
// -1 when the text is not a mapping entry. A `:` counts only when followed by whitespace or the end
// (so `tarball: https://x` splits before `https`, never inside the URL).
function keySeparator(text) {
  let i = 0
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0]
    for (i = 1; i < text.length; i++) {
      if (q === '"' && text[i] === '\\') { i++; continue }
      if (text[i] === q) {
        if (q === "'" && text[i + 1] === "'") { i++; continue }
        break
      }
    }
    if (i >= text.length) return -1
    i++
    while (i < text.length && text[i] === ' ') i++
    return text[i] === ':' && (i + 1 === text.length || /\s/u.test(text[i + 1])) ? i : -1
  }
  for (i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || /\s/u.test(text[i + 1]))) return i
    // A flow collection or a quoted scalar starting the text is a value, never a key.
    if (i === 0 && (text[i] === '[' || text[i] === '{')) return -1
  }
  return -1
}

function parseFlow(text, line) {
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new YamlError('Unterminated flow mapping', line)
    const out = Object.create(null)
    for (const item of splitFlow(text.slice(1, -1), line)) {
      const sep = keySeparator(item)
      if (sep === -1) {
        // A bare key in a flow mapping (`{a, b}`) maps to null.
        out[String(parseScalar(item, line))] = null
        continue
      }
      const key = parseScalar(item.slice(0, sep).trim(), line)
      out[String(key)] = parseValue(item.slice(sep + 1).trim(), line)
    }
    return out
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlError('Unterminated flow sequence', line)
    return splitFlow(text.slice(1, -1), line).map((item) => parseValue(item, line))
  }
  return parseScalar(text, line)
}

// A complete single-line value: flow collection or scalar.
function parseValue(text, line) {
  if (text.startsWith('{') || text.startsWith('[')) return parseFlow(text, line)
  return parseScalar(text, line)
}

export function parseYaml(source) {
  const rawLines = source.split(/\r?\n/u)
  // Pre-split into significant lines: [indent, text (comment-stripped, no leading indent), lineNo].
  const lines = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    if (raw.startsWith('%') || raw === '---' || raw === '...') {
      if (raw.startsWith('%')) continue // directive: ignore
      continue // document markers: single-document input, ignore
    }
    if (raw.includes('\t') && /^\s*\t/u.test(raw)) throw new YamlError('Tabs are not allowed for indentation', i + 1)
    const indent = raw.length - raw.trimStart().length
    const body = raw.slice(indent)
    lines.push({ indent, text: body, raw, line: i + 1 })
  }

  let pos = 0

  const isBlank = (l) => stripComment(l.text) === ''

  const skipBlank = () => {
    while (pos < lines.length && isBlank(lines[pos])) pos++
  }

  // Block scalar (`|` / `>`) whose header is `header` (e.g. '|-', '>+', '|2'); body lines follow at
  // an indentation greater than `parentIndent`.
  const parseBlockScalar = (header, parentIndent, line) => {
    const m = /^([|>])([+-]?)(\d*)([+-]?)$/u.exec(header)
    if (!m) throw new YamlError(`Invalid block scalar header '${header}'`, line)
    const folded = m[1] === '>'
    const chomp = m[2] || m[4] || ''
    const explicitIndent = m[3] ? Number(m[3]) : null
    const body = []
    let blockIndent = explicitIndent === null ? null : parentIndent + explicitIndent
    while (pos < lines.length) {
      const l = lines[pos]
      if (l.raw.trim() === '') {
        body.push('')
        pos++
        continue
      }
      if (l.indent <= parentIndent) break
      if (blockIndent === null) blockIndent = l.indent
      if (l.indent < blockIndent) break
      body.push(l.raw.slice(blockIndent))
      pos++
    }
    // Trailing blank lines are subject to chomping.
    let trailing = 0
    while (body.length > 0 && body.at(-1) === '') { body.pop(); trailing++ }
    let text
    if (folded) {
      text = ''
      for (let i = 0; i < body.length; i++) {
        const cur = body[i]
        if (i === 0) { text = cur; continue }
        const prev = body[i - 1]
        if (cur === '' || prev === '' || cur.startsWith(' ') || prev.startsWith(' ')) text += `\n${cur}`
        else text += ` ${cur}`
      }
    } else {
      text = body.join('\n')
    }
    if (chomp === '-') return text
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`
    return body.length === 0 ? '' : `${text}\n`
  }

  // Parse the value that follows `key:` on the same line (`inline`), or a nested block on the
  // following lines when `inline` is empty. `parentIndent` is the indentation of the owning line.
  const parseInlineOrBlock = (inline, parentIndent, line) => {
    if (inline === '') {
      skipBlank()
      if (pos < lines.length && lines[pos].indent > parentIndent) return parseBlock(lines[pos].indent)
      // A sequence may sit at the SAME indentation as its parent key (`key:\n- a`).
      if (pos < lines.length && lines[pos].indent === parentIndent && /^-(?:\s|$)/u.test(lines[pos].text)) {
        return parseBlock(parentIndent)
      }
      return null
    }
    if (inline.startsWith('|') || inline.startsWith('>')) return parseBlockScalar(inline, parentIndent, line)
    if (inline.startsWith('&') || inline.startsWith('*') || inline.startsWith('!')) {
      throw new YamlError(`Unsupported YAML feature '${inline}'`, line)
    }
    if (inline.startsWith('{') || inline.startsWith('[')) {
      // A flow collection may continue over following lines until it balances.
      let text = inline
      while (!flowBalanced(text)) {
        if (pos >= lines.length) throw new YamlError('Unterminated flow collection', line)
        text += ` ${stripComment(lines[pos].text)}`
        pos++
      }
      return parseFlow(text, line)
    }
    return parseScalar(inline, line)
  }

  const flowBalanced = (text) => {
    let depth = 0
    let quote = null
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === '\\' && quote === '"') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") {
        const prev = i === 0 ? ' ' : text[i - 1]
        if (/[\s:,[{]/u.test(prev)) quote = c
      } else if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
    }
    return depth === 0 && quote === null
  }

  // Parse the block node whose first line sits at `indent`.
  const parseBlock = (indent) => {
    skipBlank()
    if (pos >= lines.length) return null
    const first = lines[pos]
    if (first.indent !== indent) throw new YamlError('Bad indentation', first.line)
    const firstText = stripComment(first.text)
    if (/^-(?:\s|$)/u.test(firstText)) return parseSequence(indent)
    if (keySeparator(firstText) !== -1) return parseMapping(indent)
    // A lone scalar / flow value on its own line (e.g. a block scalar continuation is handled above).
    pos++
    return parseInlineOrBlock(firstText, indent - 1, first.line)
  }

  const parseSequence = (indent) => {
    const out = []
    while (true) {
      skipBlank()
      if (pos >= lines.length) break
      const l = lines[pos]
      if (l.indent < indent) break
      if (l.indent > indent) throw new YamlError('Bad indentation in sequence', l.line)
      const text = stripComment(l.text)
      if (!/^-(?:\s|$)/u.test(text)) break
      pos++
      const rest = text.slice(1).trimStart()
      if (rest === '') {
        out.push(parseInlineOrBlock('', indent, l.line))
        continue
      }
      // `- key: value` starts an inline mapping whose further keys are indented past the dash.
      if (keySeparator(rest) !== -1 && !rest.startsWith('{') && !rest.startsWith('[') && !rest.startsWith('"') && !rest.startsWith("'")) {
        const itemIndent = indent + (text.length - rest.length)
        // Re-inject the remainder as a line at the item indentation so parseMapping sees it whole.
        lines.splice(pos, 0, { indent: itemIndent, text: rest, raw: `${' '.repeat(itemIndent)}${rest}`, line: l.line })
        out.push(parseMapping(itemIndent))
        continue
      }
      out.push(parseInlineOrBlock(rest, indent, l.line))
    }
    return out
  }

  const parseMapping = (indent) => {
    const out = Object.create(null)
    while (true) {
      skipBlank()
      if (pos >= lines.length) break
      const l = lines[pos]
      if (l.indent < indent) break
      if (l.indent > indent) throw new YamlError('Bad indentation in mapping', l.line)
      const text = stripComment(l.text)
      if (/^-(?:\s|$)/u.test(text)) break
      const sep = keySeparator(text)
      if (sep === -1) throw new YamlError(`Expected a 'key: value' entry, got '${text}'`, l.line)
      if (text.startsWith('?')) throw new YamlError('Complex mapping keys are not supported', l.line)
      const rawKey = text.slice(0, sep).trim()
      const key = String(parseScalar(rawKey, l.line))
      if (key === '<<') throw new YamlError('Merge keys are not supported', l.line)
      pos++
      const value = parseInlineOrBlock(text.slice(sep + 1).trim(), indent, l.line)
      if (Object.hasOwn(out, key)) throw new YamlError(`Duplicate key '${key}'`, l.line)
      out[key] = value
    }
    return out
  }

  skipBlank()
  if (pos >= lines.length) return null
  const result = parseBlock(lines[pos].indent)
  skipBlank()
  if (pos < lines.length) throw new YamlError('Unexpected content after the document', lines[pos].line)
  return result
}
