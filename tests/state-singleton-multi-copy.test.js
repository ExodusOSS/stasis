// Regression: the top-level (preload) State must be a PROCESS-WIDE singleton even
// when a second, DISTINCT copy of stasis-core's state.js is loaded in the same
// process -- e.g. a dependency that ships its own nested
// node_modules/@exodus/stasis-core. Pre-fix the singleton lived in a module-local
// `let preload`, so the second copy saw `State.preload === undefined` and would
// happily construct a SECOND top-level State -- two "singletons" in one process,
// each with its own (racing) write-on-exit. The fix keeps a process-wide registry of
// ALL live States on a globalThis Set (cross-realm `Symbol.for`), shared by every
// state.js copy; the preload is the unique member flagged isPreload.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const stasisCoreDir = join(here, '..', 'stasis-core')

test('the preload is one singleton across two distinct state.js copies in a process', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-multicopy-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  writeFileSync(join(tmp, 'package.json'),
    JSON.stringify({ name: 'multi-copy', version: '0.0.0', private: true, type: 'module' }))

  // Two genuinely separate copies of stasis-core. Distinct on-disk paths -> distinct
  // ESM module instances (and distinct State classes), but both reach the same global
  // registry (a Set at `Symbol.for('@exodus/stasis-core/states')` on globalThis), so they
  // coordinate through it. copyA is imported by relative path; copyB resolves as the
  // package dependency (mirrors a dep loading its own nested stasis-core).
  cpSync(stasisCoreDir, join(tmp, 'copyA'), { recursive: true })
  cpSync(stasisCoreDir, join(tmp, 'node_modules', '@exodus', 'stasis-core'), { recursive: true })

  writeFileSync(join(tmp, 'entry.js'), [
    "import { State as StateA } from './copyA/src/state.js'",
    "import { State as StateB } from '@exodus/stasis-core/state'",
    "import { pathToFileURL } from 'node:url'",
    "import { writeFileSync as wf } from 'node:fs'",
    '',
    '// Sanity: these are genuinely two different module instances.',
    "if (StateA === StateB) throw new Error('FAIL: expected two distinct State copies')",
    '',
    '// Copy A constructs the one top-level State.',
    'const a = new StateA(process.cwd(), { preload: true })',
    '',
    '// Identity: copy B must observe the copy-A preload (process-wide singleton),',
    '// not its own empty module-local slot.',
    "if (StateB.preload !== a) throw new Error('FAIL: copy B does not observe copy A preload')",
    '',
    '// Uniqueness: copy B must REFUSE to mint a second top-level State.',
    'let threw = false',
    'try { new StateB(process.cwd(), { preload: true }) } catch { threw = true }',
    "if (!threw) throw new Error('FAIL: copy B allowed a second preload')",
    '',
    '// Cross-copy coordination (the bundled-stasis-core scenario): copy B can run as a',
    "// sidecar of copy A's preload -- DIFFERENT State classes, SAME version -- and shares",
    "// copy A's maps by reference. The version match is what makes this sound.",
    "const side = new StateB(process.cwd(), { parent: a, lock: 'add', bundle: 'add', bundleFile: process.cwd() + '/side.br' })",
    "if (side.parent !== a) throw new Error('FAIL: cross-copy sidecar parent mismatch')",
    "if (side.hashes !== a.hashes) throw new Error('FAIL: cross-copy sidecar does not share parent maps')",
    '',
    "// Cross-copy bundle serialization (regression): a sidecar's bundle getters compute per-file",
    "// formats via the parent's reconciledFormats(), which MUST be the parent's PUBLIC method --",
    "// a #private call is brand-checked and throws (TypeError) across the two distinct State copies.",
    "wf(process.cwd() + '/app.js', 'export const x = 1\\n')",
    "side.addFile(pathToFileURL(process.cwd() + '/app.js').toString(), { source: 'export const x = 1\\n', isEntry: true })",
    "const sideBundle = side.codeBundle.serialize()",
    "if (!sideBundle.includes('javascript:module')) throw new Error('FAIL: cross-copy sidecar bundle missing the reconciled format')",
    '',
    "// And a version SKEW across copies must be rejected (versions must match exactly).",
    'let skewThrew = false',
    "try { new StateB(process.cwd(), { parent: { version: '0.0.0-skew' }, lock: 'add', bundle: 'add', bundleFile: process.cwd() + '/skew.br' }) }",
    'catch (e) { skewThrew = /must exactly match parent version/.test(e.message) }',
    "if (!skewThrew) throw new Error('FAIL: a version-skewed parent was not rejected')",
    '',
    '// Cross-copy write-path collision: independent writers in the two copies claiming the',
    '// SAME explicit path conflict, via the shared global registry (no preload needed).',
    "const shared = process.cwd() + '/shared.br'",
    "new StateA(process.cwd(), { lock: 'ignore', bundle: 'add', bundleFile: shared })",
    'let collided = false',
    "try { new StateB(process.cwd(), { lock: 'ignore', bundle: 'add', bundleFile: shared }) }",
    'catch (e) { collided = /already claimed/.test(e.message) }',
    "if (!collided) throw new Error('FAIL: cross-copy write-path collision not detected')",
    '',
    "console.log('OK')",
    '',
  ].join('\n'))

  const r = spawnSync(process.execPath, ['entry.js'], { encoding: 'utf-8', cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /OK/)
})
