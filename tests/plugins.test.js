// Direct unit coverage for the classification helpers in @exodus/stasis-core/util
// (pathExt / parseResourcesOption / classifyExtension). They're the SINGLE classifier
// shared by the bundler plugins (per-import, hot path) and State's `--fs` capture, so
// the contract here -- what's 'code' vs 'resource' vs 'unknown', what the resources
// allowlist accepts -- needs to be pinned.

import { test } from 'node:test'

import { CODE_EXTENSIONS, classifyExtension, parseResourcesOption, pathExt } from '@exodus/stasis-core/util'

test('pathExt: lowercased dot-less extension or empty string', (t) => {
  t.assert.equal(pathExt('foo.JS'), 'js')
  t.assert.equal(pathExt('foo.tsx'), 'tsx')
  t.assert.equal(pathExt('Makefile'), '', 'no extension -> empty string')
  t.assert.equal(pathExt('.eslintrc'), 'eslintrc',
    'leading-dot dotfile is interpreted as an extension (caller-visible quirk)')
  // Multi-dot: only the final segment is taken. `foo.d.ts` classifies as `ts`,
  // which means TypeScript declaration files are tracked as code (not resource).
  t.assert.equal(pathExt('foo.d.ts'), 'ts')
  t.assert.equal(pathExt('a/b/c.json'), 'json')
})

test('CODE_EXTENSIONS covers the JS/TS/JSON loader-format set', (t) => {
  for (const ext of ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'mts', 'cts']) {
    t.assert.ok(CODE_EXTENSIONS.has(ext), `expected ${ext} in CODE_EXTENSIONS`)
  }
})

test('parseResourcesOption: undefined returns an empty Set', (t) => {
  const out = parseResourcesOption('X', undefined)
  t.assert.ok(out instanceof Set)
  t.assert.equal(out.size, 0)
})

test('parseResourcesOption: empty array returns an empty Set', (t) => {
  const out = parseResourcesOption('X', [])
  t.assert.equal(out.size, 0)
})

test('parseResourcesOption: lowercases and strips a leading dot', (t) => {
  const out = parseResourcesOption('X', ['.PNG', 'SVG'])
  t.assert.deepEqual([...out].toSorted(), ['png', 'svg'])
})

test('parseResourcesOption: deduplicates entries silently (Set semantics)', (t) => {
  const out = parseResourcesOption('X', ['png', 'png', '.png'])
  t.assert.deepEqual([...out], ['png'])
})

test('parseResourcesOption: rejects non-array', (t) => {
  t.assert.throws(
    () => parseResourcesOption('X', 'png'),
    /X: resources must be an array of extension\/filename strings/
  )
  t.assert.throws(
    () => parseResourcesOption('X', { png: true }),
    /X: resources must be an array of extension\/filename strings/
  )
})

test('parseResourcesOption: rejects non-string entries', (t) => {
  t.assert.throws(
    () => parseResourcesOption('X', [42]),
    /X: resources entry must be a string, got number/
  )
})

test('parseResourcesOption: rejects dotted / whitespace / path / empty entries', (t) => {
  // A dotted entry can't match (a file with an extension is keyed by it, not its
  // basename); whitespace, path separators and empty strings are never valid. Dashes and
  // underscores ARE allowed now (extensionless filenames) -- see the accept test below.
  for (const bad of ['tar.gz', 'png ', 'a/b', '', '.']) {
    t.assert.throws(
      () => parseResourcesOption('X', [bad]),
      /is not a valid extension or filename/,
      `expected '${bad}' to be rejected`
    )
  }
})

test('parseResourcesOption: accepts extensions and extensionless filenames', (t) => {
  const out = parseResourcesOption('X', ['png', '.SVG', 'LICENSE', 'Makefile', '.eslintrc', 'license-mit', 'code_of_conduct'])
  t.assert.deepEqual(
    [...out].toSorted(),
    ['code_of_conduct', 'eslintrc', 'license', 'license-mit', 'makefile', 'png', 'svg']
  )
})

test('parseResourcesOption: rejects code extensions (already always tracked)', (t) => {
  for (const code of ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', '.json']) {
    t.assert.throws(
      () => parseResourcesOption('X', [code]),
      /is a code extension; remove it/,
      `expected '${code}' to be rejected as a code ext`
    )
  }
})

test('classifyExtension: code extensions classify as "code" regardless of resources', (t) => {
  const resources = parseResourcesOption('X', ['png'])
  t.assert.equal(classifyExtension('src/foo.js', resources), 'code')
  t.assert.equal(classifyExtension('foo.JSON', resources), 'code')
  t.assert.equal(classifyExtension('a/b/c.tsx', resources), 'code')
  // .d.ts declaration files fall under the .ts code extension (documented quirk).
  t.assert.equal(classifyExtension('types.d.ts', resources), 'code')
})

test('classifyExtension: allowlisted extensions classify as "resource"', (t) => {
  const resources = parseResourcesOption('X', ['png', 'svg'])
  t.assert.equal(classifyExtension('icon.png', resources), 'resource')
  t.assert.equal(classifyExtension('logo.SVG', resources), 'resource')
})

test('classifyExtension: an extensionless file matches a filename entry by basename', (t) => {
  const resources = parseResourcesOption('X', ['png', 'LICENSE', 'makefile'])
  // No extension -> keyed by basename (case-insensitive).
  t.assert.equal(classifyExtension('proj/LICENSE', resources), 'resource')
  t.assert.equal(classifyExtension('proj/license', resources), 'resource')
  t.assert.equal(classifyExtension('proj/Makefile', resources), 'resource')
  // A file WITH an extension is keyed by the extension, never the basename.
  t.assert.equal(classifyExtension('proj/license.txt', resources), 'unknown')
  // An undeclared extensionless file is still unknown.
  t.assert.equal(classifyExtension('proj/AUTHORS', resources), 'unknown')
})

test('classifyExtension: anything else classifies as "unknown"', (t) => {
  const resources = parseResourcesOption('X', ['png'])
  t.assert.equal(classifyExtension('foo.svg', resources), 'unknown',
    'extension not in allowlist -> unknown')
  t.assert.equal(classifyExtension('Makefile', resources), 'unknown',
    'no extension -> unknown')
  t.assert.equal(classifyExtension('foo.', resources), 'unknown')
})

test('classifyExtension: never returns undefined (contract)', (t) => {
  const resources = parseResourcesOption('X', [])
  // A handful of pathological inputs -- the contract is 'code' / 'resource' / 'unknown',
  // never undefined / throw.
  for (const p of ['', '.', '..', '/', 'a', 'a.', '.a', 'a.B', '.hidden']) {
    const r = classifyExtension(p, resources)
    t.assert.ok(r === 'code' || r === 'resource' || r === 'unknown', `unexpected: ${r} for ${p}`)
  }
})
