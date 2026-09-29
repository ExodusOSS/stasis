// TOML for the build descriptions the loaders take -- Cargo.toml, Cargo.lock, foundry.toml -- read
// by @preventive/lockfile's strict TOML 1.0 parser into a tree of tables, and refused where it
// isn't TOML, or isn't the TOML those files are written in: a bad escape, an unterminated string, a
// key or table defined twice, a local date, U+FFFD where a lenient decoder replaced bytes ... each a
// TomlError naming the file and line, never a guessed value.

import { TomlError, parseToml } from '@preventive/lockfile/toml.js'

export { TomlError }

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

// The table tree of TOML `text` (parseToml): tables are null-prototype objects, arrays arrays, and
// values strings, booleans, numbers (an integer past 2^53 a BigInt), TomlFloat and TomlDateTime.
// Throws a TomlError on anything else, naming `file` when given.
export function readToml(text, file = null) {
  try {
    return parseToml(text)
  } catch (err) {
    if (file === null || !(err instanceof TomlError)) throw err
    const named = new TomlError(`${file}: ${err.message}`)
    named.line = err.line
    throw named
  }
}

// Whether a TOML value is a table (a TomlFloat or TomlDateTime is an object too).
export const isTomlTable = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null
