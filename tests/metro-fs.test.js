// Regression guard for the StasisMetro half of the --fs/sidecar coordination: metro's
// capture byte-read must go through the GENUINE reader (state-util.js's realReadFileSync),
// not a patched node:fs binding. Before the fix metro.js read via a NAMED
// `import { readFileSync } from 'node:fs'`, which `stasis run --fs`'s syncBuiltinESMExports()
// rebinds to the patched reader -- so the Metro serializer (running outside Node's
// module-load window) re-recorded the whole module graph into the preload/"main" bundle.
// (So this guard relies on installFsHooks calling syncBuiltinESMExports() -- the rebind that
// makes the pre-fix named import observable here; fs.js runs it regardless of --fs sync/async.)
// Unlike webpack, attestedBySidecar can't mask it: metro reads each module BEFORE addFile, so
// the sidecar hasn't attested it yet at read time -- the genuine reader is the only guard.
//
// White-box, like fs-sidecar.test.js (and for the same reasons): drive the REAL global fs
// hooks via installFsHooks (imported by relative path -- fs.js has no package export), in this
// file's own process (node --test isolates files), with a mock Metro graph fed to the plugin's
// serializer exactly as Metro would (mirrors tests/metro-run.helper.js). No real metro dep.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { StasisMetro } from '@exodus/stasis-plugins/metro'

import { installFsHooks } from '../stasis-core/src/fs.js'

test('--fs does not record the StasisMetro graph into main; the sidecar carries it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-fs-'))
  let active = null // the State the --fs hooks capture into (the preload/"main"); null => passthrough
  let aborted = null
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'metro-fs-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'entry.js'), "import './hello.js'\n")
    writeFileSync(join(dir, 'src', 'hello.js'), 'export const hello = 1\n')
    const entryPath = join(dir, 'src', 'entry.js')
    const helloPath = join(dir, 'src', 'hello.js')
    const entryURL = pathToFileURL(entryPath).toString()
    const helloURL = pathToFileURL(helloPath).toString()

    // main is the ambient preload (the --fs capture target); the metro plugin, given a
    // different bundleFile, resolves as its sidecar -- the real `stasis run` + plugin shape.
    // childProcess:true on the preload mirrors `stasis run --child-process`: StasisMetro now
    // requires it in a capture-that-writes mode (Metro transforms in worker processes), and the
    // Rule-6 sidecar inherits childProcess from the preload -- so we set it there, not on the
    // plugin (a sidecar copies the preload's value; resolvePluginState rejects a plugin value
    // that disagrees with the preload's).
    const main = new State(dir, { preload: true, scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'main.br'), childProcess: true })
    const metro = new StasisMetro({ scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'sidecar.br') })

    active = main
    installFsHooks({
      async: true,
      getState: () => active,
      markAborted: (err) => { aborted = err },
      isLoadingModule: () => false,
    })

    // A minimal Metro ReadOnlyGraph (see metro-run.helper.js): dependencies keyed by absolute
    // path, each module with `path` + a `dependencies` Map keyed by an opaque id whose value
    // carries { absolutePath, data: { name } }. The plugin reads module.path off disk.
    const mkMod = (modPath, deps = new Map()) => ({ path: modPath, dependencies: deps })
    const graph = {
      dependencies: new Map([
        [entryPath, mkMod(entryPath, new Map([['dep0', { absolutePath: helloPath, data: { name: './hello.js' } }]]))],
        [helloPath, mkMod(helloPath)],
      ]),
      entryPoints: new Set([entryPath]),
    }

    metro.serializerHook(graph)

    // The plugin captured the graph into its SIDECAR (so main attests it via the family)...
    t.assert.equal(main.attestedBySidecar(entryURL), true, 'sidecar should carry the entry')
    t.assert.equal(main.attestedBySidecar(helloURL), true, 'sidecar should carry the dep')
    // ...but --fs must NOT have re-recorded those graph reads into main itself. Pre-fix (named
    // node:fs import rebound by --fs), main.getFsStat would be 'file' here.
    t.assert.equal(main.getFsStat(entryURL), undefined, 'metro graph must not be recorded into main')
    t.assert.equal(main.getFsStat(helloURL), undefined, 'metro graph must not be recorded into main')

    t.assert.equal(aborted, null, 'no capture conflict should be raised')
  } finally {
    active = null // subsequent fs (incl. rmSync) passes through with no active state
    rmSync(dir, { recursive: true, force: true })
  }
})
