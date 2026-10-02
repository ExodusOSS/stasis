// Incremental JSON parser over UTF-8 bytes, holding only the value being built and one token in flight.
// Exactly JSON.parse(Buffer.concat(chunks).toString('utf8')) for any chunking (json-stream.test.js checks it),
// so a bundle read in a stream can't parse differently from one read whole. Pure: no Node builtins.
// Not mirrored: Node 24+'s JSON.parse can return a stale escaped key cached by an earlier call (a V8 bug).

const QUOTE = 0x22
const BACKSLASH = 0x5c

// What the next significant byte may be.
const VALUE = 0 // any value: the top level, after ':' or after an array's ','
const ARRAY_FIRST = 1 // after '[': a value or ']'
const OBJECT_FIRST = 2 // after '{': a key or '}'
const KEY = 3 // after an object's ',': a key
const COLON = 4
const AFTER = 5 // after a member or element: ',' or the container's closer
const DONE = 6 // the top-level value is complete: whitespace only
// Inside a token that can straddle chunks.
const STRING = 7
const NUMBER = 8
const LITERAL = 9

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u
const LITERALS = new Map([['true', true], ['false', false], ['null', null]])

const isWhitespace = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09
// The bytes a number can span; NUMBER_RE checks its grammar once it ends.
const isNumberByte = (b) => (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2b || b === 0x2e || b === 0x65 || b === 0x45
const isLetter = (b) => b >= 0x61 && b <= 0x7a

const hasControlByte = (bytes) => {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] < 0x20) return true
  return false
}

const indexOrEnd = (bytes, byte, from) => {
  const at = bytes.indexOf(byte, from)
  return at === -1 ? bytes.length : at
}

const concat = (parts) => {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export class JsonStreamParser {
  // ignoreBOM keeps a leading U+FEFF, as Buffer#toString does; no UTF-8 sequence spans a quote, so per-string decoding is exact.
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  #onString
  #state = VALUE
  #stack = [] // open containers, innermost last
  #path = [] // #path[d]: the key or index #stack[d]'s in-flight member lands at
  #result
  #offset = 0 // bytes consumed by earlier writes, for error positions
  #closed = false
  // Cached indexOf results in the current chunk (-1: not searched yet; its length: none left).
  #nextQuote = -1
  #nextBackslash = -1
  #tokenStart = 0
  #isKey = false
  #parts = [] // copied bytes of a string straddling chunks
  #escaped = false
  #pendingEscape = false // a chunk ended on a string's backslash
  #word = '' // a number or literal straddling chunks

  // onString(value, path) sees each string value (never a key) and its return is stored instead.
  // `path` is the live key/index path: read it, never keep or mutate it.
  constructor({ onString } = {}) {
    this.#onString = onString
  }

  // A chunk may be reused once write() returns: the bytes of a token left open are copied.
  write(bytes) {
    if (this.#closed) throw new Error('JsonStreamParser: write after end or failure')
    if (!ArrayBuffer.isView(bytes)) throw new TypeError('JsonStreamParser: write() takes a Uint8Array')
    // A plain Uint8Array view: a Buffer's slice() doesn't copy, and its indexOf/subarray are slower.
    const view = bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    try {
      this.#consume(view)
    } catch (error) {
      this.#closed = true
      throw error
    }
    this.#offset += view.length
  }

  end() {
    if (this.#closed) throw new Error('JsonStreamParser: end after end or failure')
    this.#closed = true
    if (this.#state === NUMBER || this.#state === LITERAL) this.#finishWord()
    if (this.#state !== DONE) throw new SyntaxError(`Unexpected end of JSON input at byte ${this.#offset}`)
    const result = this.#result
    this.#result = undefined
    return result
  }

  #fail(message, i) {
    throw new SyntaxError(`${message} at byte ${this.#offset + i}`)
  }

  #consume(bytes) {
    const n = bytes.length
    this.#nextQuote = -1
    this.#nextBackslash = -1
    let i = 0
    while (i < n) {
      const state = this.#state
      if (state === STRING) {
        i = this.#string(bytes, i)
      } else if (state === NUMBER || state === LITERAL) {
        i = this.#scanWord(bytes, i)
      } else if (isWhitespace(bytes[i])) {
        i += 1
      } else {
        i = this.#structural(bytes[i], i)
      }
    }
  }

  #structural(b, i) {
    const state = this.#state
    const isArray = Array.isArray(this.#stack.at(-1))
    if ((state === AFTER || state === ARRAY_FIRST || state === OBJECT_FIRST) && b === (isArray ? 0x5d : 0x7d)) {
      this.#close()
      return i + 1
    }
    if (state === AFTER) {
      if (b !== 0x2c) this.#fail(`Unexpected byte 0x${b.toString(16)} after a value`, i)
      this.#state = isArray ? VALUE : KEY
      return i + 1
    }
    if (state === COLON) {
      if (b !== 0x3a) this.#fail(`Expected ':' after a key, got byte 0x${b.toString(16)}`, i)
      this.#state = VALUE
      return i + 1
    }
    if (state === OBJECT_FIRST || state === KEY) {
      if (b !== QUOTE) this.#fail(`Expected a string key, got byte 0x${b.toString(16)}`, i)
      this.#startToken(STRING, i)
      this.#isKey = true
      return i + 1
    }
    if (state === DONE) this.#fail(`Unexpected byte 0x${b.toString(16)} after the JSON value`, i)
    // VALUE or ARRAY_FIRST
    if (isArray) this.#path[this.#stack.length - 1] = this.#stack.at(-1).length
    if (b === QUOTE) {
      this.#startToken(STRING, i)
      this.#isKey = false
      return i + 1
    }
    if (b === 0x7b || b === 0x5b) {
      this.#stack.push(b === 0x7b ? {} : [])
      this.#path.push(undefined)
      this.#state = b === 0x7b ? OBJECT_FIRST : ARRAY_FIRST
      return i + 1
    }
    if (b === 0x2d || (b >= 0x30 && b <= 0x39)) {
      this.#startToken(NUMBER, i)
      return i
    }
    if (b === 0x74 || b === 0x66 || b === 0x6e) {
      this.#startToken(LITERAL, i)
      return i
    }
    return this.#fail(`Unexpected byte 0x${b.toString(16)} where a value was expected`, i)
  }

  #startToken(state, i) {
    this.#state = state
    this.#tokenStart = this.#offset + i
  }

  #string(bytes, start) {
    const n = bytes.length
    let i = start
    if (this.#pendingEscape) {
      this.#pendingEscape = false
      i += 1
    }
    for (;;) {
      if (this.#nextQuote < i) this.#nextQuote = indexOrEnd(bytes, QUOTE, i)
      if (this.#nextBackslash < i) this.#nextBackslash = indexOrEnd(bytes, BACKSLASH, i)
      const quote = this.#nextQuote
      const backslash = this.#nextBackslash
      if (backslash < quote) {
        this.#escaped = true
        if (backslash + 1 === n) {
          this.#pendingEscape = true
          break
        }
        i = backslash + 2
      } else if (quote === n) {
        break
      } else {
        this.#finishString(bytes.subarray(start, quote))
        return quote + 1
      }
    }
    this.#parts.push(bytes.slice(start))
    return n
  }

  #finishString(tail) {
    let bytes = tail
    if (this.#parts.length > 0) {
      this.#parts.push(tail)
      bytes = concat(this.#parts)
      this.#parts = []
    }
    let value = this.#decoder.decode(bytes)
    if (this.#escaped) {
      // JSON.parse handles the escapes, and rejects raw control bytes.
      this.#escaped = false
      try {
        value = JSON.parse(`"${value}"`)
      } catch (cause) {
        throw new SyntaxError(`Bad string at byte ${this.#tokenStart}`, { cause })
      }
    } else if (hasControlByte(bytes)) {
      throw new SyntaxError(`Bad control character in string at byte ${this.#tokenStart}`)
    }
    if (this.#isKey) {
      this.#path[this.#path.length - 1] = value
      this.#state = COLON
    } else {
      this.#value(this.#onString === undefined ? value : this.#onString(value, this.#path))
    }
  }

  #scanWord(bytes, i) {
    const n = bytes.length
    const isNumber = this.#state === NUMBER
    let j = i
    while (j < n && (isNumber ? isNumberByte(bytes[j]) : isLetter(bytes[j]))) j += 1
    this.#word += this.#decoder.decode(bytes.subarray(i, j))
    if (j === n) return n
    this.#finishWord()
    return j
  }

  #finishWord() {
    const word = this.#word
    this.#word = ''
    if (this.#state === NUMBER) {
      if (!NUMBER_RE.test(word)) throw new SyntaxError(`Bad number at byte ${this.#tokenStart}`)
      this.#value(Number(word))
    } else {
      if (!LITERALS.has(word)) throw new SyntaxError(`Bad literal at byte ${this.#tokenStart}`)
      this.#value(LITERALS.get(word))
    }
  }

  #close() {
    this.#path.pop()
    this.#value(this.#stack.pop())
  }

  #value(value) {
    const depth = this.#stack.length
    if (depth === 0) {
      this.#result = value
      this.#state = DONE
      return
    }
    const container = this.#stack[depth - 1]
    const key = this.#path[depth - 1]
    if (Array.isArray(container)) {
      container.push(value)
    } else if (key === '__proto__') {
      // JSON.parse defines an own data property; assignment would hit Object.prototype's setter.
      Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true })
    } else {
      container[key] = value
    }
    this.#state = AFTER
  }
}
