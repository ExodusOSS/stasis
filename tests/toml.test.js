import { test } from 'node:test'

import { TomlError, isTomlTable, readToml } from '../stasis/src/loaders/toml.js'

// The parser is @preventive/lockfile's, tested there; these pin what the loaders rely on.

test('readToml names the file and line of text that is not TOML', (t) => {
  t.assert.throws(() => readToml('[a]\n\nb = "x', 'foundry.toml'), (err) => {
    t.assert.ok(err instanceof TomlError)
    t.assert.equal(err.message, 'foundry.toml: unterminated string at line 3')
    t.assert.equal(err.line, 2) // counting from zero, as the parser's own error does
    return true
  })
  t.assert.throws(() => readToml('b = "x'), { name: 'TomlError', message: 'unterminated string at line 1' })
})

test('readToml refuses what the build descriptions the loaders read may not hold', (t) => {
  const refuses = (text, message) => t.assert.throws(() => readToml(text, 'Cargo.toml'), { name: 'TomlError', message })
  refuses('a = 1\na = 2\n', /^Cargo\.toml: duplicate key "a" at line 2$/u)
  refuses('[a]\nx = 1\n[a]\n', /^Cargo\.toml: .* at line 3$/u)
  refuses('d = 1979-05-27\n', /^Cargo\.toml: .* at line 1$/u) // a local date: in no file the loaders read
  refuses('﻿a = 1\n', /^Cargo\.toml: a byte order mark is not read at line 1$/u)
  refuses('a = "�"\n', /^Cargo\.toml: U\+FFFD is not supported/u) // where a lenient decoder replaced bytes
})

test('readToml gives the table tree the loaders walk', (t) => {
  const doc = readToml([
    '[package]', 'name = "app"', 'version.workspace = true', '',
    '[dependencies]', 'serde = { version = "1", features = ["derive"] }', '',
    '[dependencies.log]', 'version = "0.4"', '',
    '[[package.metadata.list]]', 'n = 1', '[[package.metadata.list]]', 'n = 9223372036854775807', '',
    '[profile]', 'f = 1.0', '__proto__ = "a key like any other"', '',
  ].join('\n'))
  t.assert.ok(isTomlTable(doc) && isTomlTable(doc.package) && isTomlTable(doc.package.version))
  t.assert.equal(Object.getPrototypeOf(doc.dependencies.serde), null)
  // however a table is spelled out, it is one table
  t.assert.deepEqual(JSON.parse(JSON.stringify(doc.dependencies)), { serde: { version: '1', features: ['derive'] }, log: { version: '0.4' } })
  t.assert.deepEqual(doc.package.metadata.list.map((x) => x.n), [1, 9223372036854775807n]) // past 2^53: a BigInt
  t.assert.deepEqual([doc.profile.f.text, Number(doc.profile.f), isTomlTable(doc.profile.f)], ['1.0', 1, false]) // a float is an object, not a table
  t.assert.equal(doc.profile.__proto__, 'a key like any other')
  t.assert.equal(isTomlTable([]), false)
})
