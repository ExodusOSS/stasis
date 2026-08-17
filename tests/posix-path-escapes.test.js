// posixPathEscapes is a security predicate (every parser's root-escape gate), rewritten as a
// dependency-free segment walk so artifact-util.js loads without node:path. This differentially
// tests the walk against the posix.normalize-based implementation it replaced, over an exhaustive
// segment enumeration plus the adversarial forms the parsers rely on it to reject.
import { posix } from 'node:path'
import { test } from 'node:test'

import { posixPathEscapes } from '@exodus/stasis-core/util'

// The previous implementation, verbatim: the walk must agree with it on every input.
const reference = (path) => {
  if (!path.includes('..') && !posix.isAbsolute(path)) return false
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)
}

test('posixPathEscapes matches the posix.normalize verdict on an exhaustive enumeration', (t) => {
  // Every path of up to 4 segments drawn from lookalikes of '..' and '.', real names, and the
  // empty segment ('//'), each also tested in absolute and trailing-slash form.
  const segments = ['a', '..', '.', '', '...', '..a', 'a..', 'a.b', 'node_modules', '@s']
  const cases = ['']
  let layer = ['']
  for (let len = 0; len < 4; len++) {
    layer = layer.flatMap((p) => segments.map((s) => (p === '' ? s : `${p}/${s}`)))
    cases.push(...layer)
  }
  for (const path of cases) {
    for (const candidate of [path, `/${path}`, `${path}/`]) {
      t.assert.equal(posixPathEscapes(candidate), reference(candidate), JSON.stringify(candidate))
    }
  }
})

test('posixPathEscapes rejects and accepts the documented forms', (t) => {
  // The escapes the parsers must fail closed on.
  for (const path of ['..', '../x', 'a/../../x', 'a/b/../../..', '/etc/passwd', '/', '../']) {
    t.assert.equal(posixPathEscapes(path), true, path)
  }
  // In-root forms that must keep parsing, incl. '' (a directory capture keyed at a module root)
  // and backslashes (ordinary characters in posix artifact keys, never separators).
  for (const path of ['', '.', 'a', 'a/..', 'a/../b', '..a/b', 'a..', 'a\\..\\..', 'node_modules/x/i.js']) {
    t.assert.equal(posixPathEscapes(path), false, path)
  }
})
