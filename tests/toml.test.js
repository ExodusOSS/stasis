import { test } from 'node:test'

import { TomlError, tomlEntries } from '../stasis/src/loaders/toml.js'

// The value of `v = <text>`.
const value = (text) => tomlEntries(`v = ${text}\n`)[0].value

// `text` is refused with a TomlError whose message matches `message`, at `line` (1-based).
const refuses = (t, text, message, line = 1) => t.assert.throws(() => tomlEntries(text), { name: 'TomlError', message, line })

test('tomlEntries refuses what is not TOML, naming the file and line', (t) => {
  // strings
  refuses(t, 's = "\\uD800"', /"\\uD800" is not a Unicode scalar value/u)
  refuses(t, 's = "\\U00110000"', /"\\U00110000" is not a Unicode scalar value/u)
  refuses(t, 's = "a\\qb"', /invalid escape "\\q"/u)
  refuses(t, 's = "a\\eb"', /invalid escape "\\e"/u)
  refuses(t, 's = "\\u12"', /invalid escape "\\u12"/u)
  refuses(t, 's = "abc', /unterminated string/u)
  refuses(t, "s = 'abc", /unterminated string/u)
  refuses(t, 's = """abc\n\n', /unterminated string/u)
  refuses(t, 'x = 1\ns = "abc\n', /unterminated string/u, 2)
  refuses(t, 's = "a\u0001b"', /control character in a string/u)
  refuses(t, "s = 'a\rb'", /unterminated string/u)
  // trailing text
  refuses(t, 's = "a" junk', /unexpected text after the value/u)
  refuses(t, 'n = 1 b = 2', /unexpected text after the value/u)
  refuses(t, '[a] junk', /unexpected text after the table header/u)
  refuses(t, '[a', /expected "\]" to close the table header/u)
  refuses(t, '[[a]', /expected "\]\]" to close the table header/u)
  // arrays and inline tables
  refuses(t, 'a = ["a" "b"]', /expected a comma or "\]" after the array item/u)
  refuses(t, 'a = ["a", b]', /invalid value "b"/u)
  refuses(t, 'a = [1,,2]', /expected a value/u)
  refuses(t, 'a = [\n  1,\n  2', /unterminated array/u)
  refuses(t, 't = { a = 1, a = 2 }', /duplicate key "t\.a"/u)
  refuses(t, 't = { a = "x"', /unterminated inline table/u)
  refuses(t, 't = { a = 1, }', /trailing comma in an inline table/u)
  refuses(t, 't = { a = 1\n}', /unterminated inline table/u)
  refuses(t, 't = { a = 1 b = 2 }', /expected a comma or "\}" after the inline table entry/u)
  // keys and tables defined twice
  refuses(t, 'a = 1\na = 2', /duplicate key "a"/u, 2)
  refuses(t, '[a]\nx = 1\n[a]\ny = 2', /duplicate table \[a\]/u, 3)
  refuses(t, '[a]\n[a.b]\n[a]', /duplicate table \[a\]/u, 3)
  refuses(t, 'a.b = 1\n[a]', /duplicate table \[a\]/u, 2)
  refuses(t, '[a]\nb.c = 1\n[a.b]', /duplicate table \[a\.b\]/u, 3)
  refuses(t, '[a.b]\n[a]\nb.c = 1', /table \[a\.b\] is already defined by a header/u, 3)
  refuses(t, 'a = 1\na.b = 2', /"a" is not a table/u, 2)
  refuses(t, 'a = { b = 1 }\na.c = 2', /"a" is not a table/u, 2)
  refuses(t, 'a = {}\n[a.b]', /"a" is not a table/u, 2)
  refuses(t, 'a = 1\n[a]', /"a" is already defined as a value/u, 2)
  refuses(t, '[[a]]\n[a]', /duplicate table \[a\]/u, 2)
  refuses(t, '[a]\n[[a]]', /"a" is not an array of tables/u, 2)
  refuses(t, 'a = []\n[[a]]', /"a" is already defined as a value/u, 2)
  // malformed keys and values
  refuses(t, '= 1', /expected a key/u)
  refuses(t, 'a', /expected "=" after the key/u)
  refuses(t, 'a =', /expected a value/u)
  refuses(t, '[]', /expected a key/u)
  refuses(t, '[a.]', /expected a key/u)
  refuses(t, 'n = 01', /invalid value "01"/u)
  refuses(t, 'n = 1__0', /invalid value "1__0"/u)
  refuses(t, 'n = 1_', /invalid value "1_"/u)
  refuses(t, 'f = 1.', /invalid value "1\."/u)
  refuses(t, 'f = .5', /invalid value "\.5"/u)
  refuses(t, 'n = -0x1', /invalid value "-0x1"/u)
  refuses(t, 'b = True', /invalid value "True"/u)
  refuses(t, 'd = 1979-02-30', /invalid date "1979-02-30"/u)
  refuses(t, 'd = 1979-05-27T25:00:00', /invalid date/u)
  refuses(t, 'd = 07:60:00', /invalid time "07:60:00"/u)
  refuses(t, 'a = 1 # c\u0001', /control character in a comment/u)
  refuses(t, 'a = 1\rb = 2', /unexpected text after the value/u)
  // the file and line are in the message and on the error
  t.assert.throws(() => tomlEntries('[a]\n\nb = "x', { file: 'foundry.toml' }), (err) => {
    t.assert.ok(err instanceof TomlError)
    t.assert.equal(err.message, 'foundry.toml:3: unterminated string')
    t.assert.deepEqual([err.file, err.line], ['foundry.toml', 3])
    return true
  })
  t.assert.throws(() => tomlEntries('b = "x'), { message: 'line 1: unterminated string' })
})

test('tomlEntries reads TOML values as JavaScript ones', (t) => {
  // numbers
  t.assert.deepEqual(['3', '-17', '+0', '1_000', '0x1f', '0xDEAD_beef', '0o17', '0b1010', '6.626e-34', '1e3', '-2.5', '1_0.0_1e1_0'].map(value), [3, -17, 0, 1000, 31, 0xdeadbeef, 15, 10, 6.626e-34, 1000, -2.5, 10.01e10])
  t.assert.deepEqual(['inf', '+inf', '-inf'].map(value), [Infinity, Infinity, -Infinity])
  t.assert.ok(Number.isNaN(value('nan')))
  t.assert.equal(value('9223372036854775807'), 9223372036854775807n) // past 2^53: a BigInt keeps it exact
  t.assert.equal(value('9007199254740991'), 9007199254740991)
  t.assert.deepEqual(value('[1, "a", true]'), [1, 'a', true])
  // booleans
  t.assert.deepEqual([value('true'), value('false')], [true, false])
  // strings
  t.assert.equal(value('"a\\"b\\\\c\\td\\u00e9\\U0001F600"'), 'a"b\\c\td\u00e9\u{1F600}')
  t.assert.equal(value("'C:\\path\\\"quoted\"'"), 'C:\\path\\"quoted"')
  t.assert.equal(value('"""\nRoses are red\nViolets are blue"""'), 'Roses are red\nViolets are blue')
  t.assert.equal(value('"""The quick brown \\\n\n  fox jumps over \\\n    the lazy dog."""'), 'The quick brown fox jumps over the lazy dog.')
  t.assert.equal(value('"""Here are fifteen quotation marks: ""\\"""\\"""\\"""\\"""\\"."""'), 'Here are fifteen quotation marks: """"""""""""""".')
  t.assert.equal(value('"""a""""'), 'a"')
  t.assert.equal(value("'''\n'a' and ''b''\n'''"), "'a' and ''b''\n")
  t.assert.equal(value("''''a''''"), "'a'")
  // arrays: over lines, with comments and a trailing comma
  t.assert.deepEqual(value('[\n  "a", # first\n  # between\n  "b-c",\n  \'d\',\n]'), ['a', 'b-c', 'd'])
  t.assert.deepEqual(value('[]'), [])
  t.assert.deepEqual(value('[[1, 2], [{ x = 1 }, { x = 2 }]]'), [[1, 2], [{ x: 1 }, { x: 2 }]])
  // inline tables, dotted keys inside them
  t.assert.deepEqual(value('{ version = "1", features = ["x", "y"], optional = true, default-features = false }'), {
    version: '1', features: ['x', 'y'], optional: true, 'default-features': false,
  })
  t.assert.deepEqual(value('{ a.b = 1, a.c = 2, "d.e" = { f = 3 } }'), { a: { b: 1, c: 2 }, 'd.e': { f: 3 } })
  t.assert.deepEqual(value('{}'), {})
  t.assert.equal(Object.getPrototypeOf(value('{ __proto__ = 1 }')), null) // a key is only a key
  // dates and times, checked, kept as their text
  t.assert.deepEqual(['1979-05-27', '1979-05-27T07:32:00Z', '1979-05-27 00:32:00.999-07:00', '07:32:00', '2000-02-29'].map(value), [
    '1979-05-27', '1979-05-27T07:32:00Z', '1979-05-27 00:32:00.999-07:00', '07:32:00', '2000-02-29',
  ])
})

test('tomlEntries yields headers and pairs with their table paths and line spans', (t) => {
  const text = [
    '# a comment', 'top = 1', '', '[a] # trailing',
    'x.y = "z"', 'list = [', '  1,', '  2,', ']',
    '[[arr]]', 'name = "one"', '[[arr]]', 'name = "two"', '[arr.sub]', 'k = 2',
    '[profile."ci.fast"]', 'remappings = ["@f/=lib/\\u0066/"]', '[a.deeper]', 'w = true', '',
  ].join('\n')
  t.assert.deepEqual(tomlEntries(text), [
    { path: ['top'], header: false, value: 1, first: 1, last: 1 },
    { path: ['a'], header: true, first: 3, last: 3 },
    { path: ['a', 'x', 'y'], header: false, value: 'z', first: 4, last: 4 },
    { path: ['a', 'list'], header: false, value: [1, 2], first: 5, last: 8 },
    { path: ['arr'], header: true, first: 9, last: 9 },
    { path: ['arr', 'name'], header: false, value: 'one', first: 10, last: 10 },
    { path: ['arr'], header: true, first: 11, last: 11 },
    { path: ['arr', 'name'], header: false, value: 'two', first: 12, last: 12 },
    { path: ['arr', 'sub'], header: true, first: 13, last: 13 },
    { path: ['arr', 'sub', 'k'], header: false, value: 2, first: 14, last: 14 },
    { path: ['profile', 'ci.fast'], header: true, first: 15, last: 15 },
    { path: ['profile', 'ci.fast', 'remappings'], header: false, value: ['@f/=lib/f/'], first: 16, last: 16 },
    { path: ['a', 'deeper'], header: true, first: 17, last: 17 },
    { path: ['a', 'deeper', 'w'], header: false, value: true, first: 18, last: 18 },
  ])
  // CRLF line ends, a leading BOM, and an empty document
  t.assert.deepEqual(tomlEntries('\uFEFFa = 1\r\n[t]\r\nb = "x" # c\r\n').map((e) => e.path.join('.')), ['a', 't', 't.b'])
  t.assert.deepEqual(tomlEntries(''), [])
  t.assert.deepEqual(tomlEntries('# only a comment\n\n'), [])
})

test('tomlEntries applies TOML\'s rules on what may be defined again', (t) => {
  // a super-table may follow its sub-tables; dotted keys may open sub-tables a later header extends
  t.assert.equal(tomlEntries('[a.b]\nx = 1\n[a]\ny = 2\n').length, 4)
  t.assert.equal(tomlEntries('[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true\n').length, 5)
  t.assert.equal(tomlEntries('a.b = 1\n[a.c]\nd = 2\n').length, 3)
  // each `[[x]]` item is its own table: the same sub-tables and keys under each
  t.assert.equal(tomlEntries('[[a]]\nx = 1\n[a.b]\ny = 2\n[[a]]\nx = 3\n[a.b]\ny = 4\n').length, 8)
  // a table opened implicitly by a header can't become an array of tables, and vice versa
  refuses(t, '[a.b]\n[[a]]', /"a" is not an array of tables/u, 2)
  refuses(t, '[[a]]\n[a.b]\n[[a.b]]', /"a\.b" is not an array of tables/u, 3)
  refuses(t, '[a.b.c]\n[a]\nb.d = 1\n[a.b]', /duplicate table \[a\.b\]/u, 4)
})
