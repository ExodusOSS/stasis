// The artifact data model (`@exodus/stasis-core/bundle`, `/lockfile`, and the shard wire format)
// must stay loadable in any JS runtime: consumers parse and serialize artifacts in environments
// with no node:buffer, node:fs or process. This pins the module graph's static import specifiers
// so a Node builtin can't creep back in unnoticed -- artifact-util.js imports nothing at all.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const src = dirname(fileURLToPath(import.meta.resolve('@exodus/stasis-core/bundle')))

// Static dependency edges: `import ... 'spec'` (incl. multiline named imports and the bare form)
// and the `export * / export {..} from 'spec'` re-export forms. A misparse yields a wrong
// specifier, which the exact deepEqual below still fails on.
const importSpecifiers = (file) => {
  const text = readFileSync(join(src, file), 'utf8')
  const statements = /^import\b[^']*?'([^']+)'|^export\s*(?:\*|\{[^}]*\})[^']*?from\s*'([^']+)'/gmu
  return [...text.matchAll(statements)].map((m) => m[1] ?? m[2])
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
