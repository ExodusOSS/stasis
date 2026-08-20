// The artifact data model (`@exodus/stasis-core/bundle`, `/lockfile`, and the shard wire format)
// must stay loadable in any JS runtime: consumers parse and serialize artifacts in environments
// with no node:buffer or node:fs. This pins the module graph's import specifiers -- static
// imports, `export ... from` re-exports, and dynamic import() -- so a Node builtin can't creep
// back in unnoticed; artifact-util.js imports nothing at all.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const src = dirname(fileURLToPath(import.meta.resolve('@exodus/stasis-core/bundle')))

// Specifiers come from the AST (oxc-parser, resolved from @exodus/stasis's own dependencies the
// way stasis/src/scan.js loads it), not a regex: quoting style, indentation, or line breaks
// can't hide an edge from the parser the way they could from a line-anchored single-quote pattern.
const require = createRequire(import.meta.resolve('@exodus/stasis/lockfile'))
const { parseSync } = require('oxc-parser')

const importSpecifiers = (file) => {
  const text = readFileSync(join(src, file), 'utf8')
  const { module, errors } = parseSync(file, text)
  // A file oxc can't fully parse could hide edges in the unparsed region -- fail, don't skip.
  if (errors.length > 0) throw new Error(`parse errors in ${file}: ${errors.map((e) => e.message).join('; ')}`)
  const specs = module.staticImports.map((imp) => imp.moduleRequest.value)
  for (const exp of module.staticExports) {
    for (const entry of exp.entries) if (entry.moduleRequest) specs.push(entry.moduleRequest.value)
  }
  // A dynamic import() would defeat the pin as thoroughly as a static edge; oxc reports only the
  // request's span, so record its raw source text -- any occurrence fails the deepEqual below.
  for (const dyn of module.dynamicImports) {
    specs.push(text.slice(dyn.moduleRequest.start, dyn.moduleRequest.end))
  }
  return specs
}

test('the artifact data model imports no Node builtins', (t) => {
  t.assert.deepEqual(importSpecifiers('artifact-util.js'), [])
  for (const file of ['bundle.js', 'lockfile.js', 'shard.js']) {
    t.assert.deepEqual(importSpecifiers(file), ['./artifact-util.js'], file)
  }
})

test('util.js still serves the full helper set (re-export compatibility)', async (t) => {
  const util = await import('@exodus/stasis-core/util')
  // One representative from each moved group: formats, keys, merges, executable rules, converters.
  for (const name of ['KNOWN_FORMATS', 'moduleFileKey', 'mergeModuleMaps', 'narrowExecutable',
    'parseExecutable', 'serializeExecutable', 'posixPathEscapes', 'sortPaths', 'splitNodeModulesPath']) {
    t.assert.ok(name in util, `util.js re-exports ${name}`)
  }
})
