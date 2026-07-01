// Regression guard for the StasisWebpack half of the --fs/sidecar coordination: webpack's own
// afterResolve capture byte-read must go through the GENUINE reader (state-util.js's
// realReadFileSync), not a patched node:fs binding. If webpack.js read the module source via a
// rebindable `readFileSync` import, `stasis run --fs`'s syncBuiltinESMExports() would rebind it to
// the patched reader -- so the plugin's OWN capture read would re-record the module graph into the
// preload/"main" bundle (the exact bug fixed for metro). webpack's capture read runs BEFORE its
// addFile, so at read time the sidecar hasn't attested the file yet -- attestedBySidecar can't mask
// it and the genuine reader is the only guard (same as metro; see tests/metro-fs.test.js).
//
// White-box, like metro-fs.test.js: drive the REAL global fs hooks via installFsHooks (imported by
// relative path -- fs.js has no package export), in this file's own process (node --test isolates
// files), feeding the plugin's afterResolve hook the resolved-module data webpack would, via a
// minimal tapable-Hook shim. No real webpack dep.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { StasisWebpack } from '@exodus/stasis-plugins/webpack'

import { installFsHooks } from '../stasis-core/src/fs.js'

// Minimal tapable-Hook shim: the plugin only calls `.tap(name, fn)`; `.call(arg)` fires the
// collected fns, exactly as webpack would when the hook runs.
const mkHook = () => { const fns = []; return { tap: (_n, fn) => fns.push(fn), call: (arg) => { for (const fn of fns) fn(arg) } } }
// The compiler hooks the capture-mode plugin taps: normalModuleFactory (resolve capture),
// watchRun (one-shot vs watch write timing), and done (the write itself). Real webpack exposes
// all three on both v4 and v5; the stub must too, or apply() throws on the missing hook.
const compilerHooks = () => ({ normalModuleFactory: mkHook(), watchRun: mkHook(), done: mkHook() })

test('--fs does not record the StasisWebpack graph into main; the sidecar carries it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-webpack-fs-'))
  let active = null // the State the --fs hooks capture into (the preload/"main"); null => passthrough
  let aborted = null
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'webpack-fs-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'entry.js'), "import './hello.js'\n")
    writeFileSync(join(dir, 'src', 'hello.js'), 'export const hello = 1\n')
    const entryPath = join(dir, 'src', 'entry.js')
    const helloPath = join(dir, 'src', 'hello.js')
    const entryURL = pathToFileURL(entryPath).toString()
    const helloURL = pathToFileURL(helloPath).toString()

    // main is the ambient preload (the --fs capture target); the webpack plugin, given a different
    // bundleFile, resolves as its Rule-6 sidecar -- the real `stasis run` + plugin shape.
    const main = new State(dir, { preload: true, scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'main.br') })
    const webpack = new StasisWebpack({ scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'sidecar.br') })

    active = main
    installFsHooks({
      async: false, // webpack's capture read is sync; readFileSync is patched + ESM-rebound regardless
      getState: () => active,
      markAborted: (err) => { aborted = err },
      isLoadingModule: () => false,
    })

    // Drive the plugin's capture hooks as webpack would, without real webpack. inputFileSystem is a
    // stub: the plugin Proxy-wraps it at apply() time, but this test feeds afterResolve directly and
    // never reads through it.
    const compiler = { inputFileSystem: { readFile() {}, stat() {} }, hooks: compilerHooks() }
    const nmf = { hooks: { beforeResolve: mkHook(), afterResolve: mkHook() } }
    webpack.apply(compiler)
    compiler.hooks.normalModuleFactory.call(nmf) // wires the plugin's beforeResolve/afterResolve taps

    // afterResolve fires per resolved module: resourceResolveData.path is the resolved on-disk file,
    // contextInfo.issuer attributes the import edge (an entry has none). Shapes per webpack.js.
    nmf.hooks.afterResolve.call({ resourceResolveData: { path: entryPath }, rawRequest: './entry.js', contextInfo: {} })
    nmf.hooks.afterResolve.call({ resourceResolveData: { path: helloPath }, rawRequest: './hello.js', contextInfo: { issuer: entryPath } })

    // The plugin captured the graph into its SIDECAR (so main attests it via the family)...
    t.assert.equal(main.attestedBySidecar(entryURL), true, 'sidecar should carry the entry')
    t.assert.equal(main.attestedBySidecar(helloURL), true, 'sidecar should carry the dep')
    // ...but --fs (active=main) must NOT have re-recorded the plugin's own capture reads into main.
    // Pre-fix (webpack read via a rebindable node:fs readFileSync), main.getFsStat would be 'file'.
    t.assert.equal(main.getFsStat(entryURL), undefined, 'webpack graph must not be recorded into main')
    t.assert.equal(main.getFsStat(helloURL), undefined, 'webpack graph must not be recorded into main')
    t.assert.equal(aborted, null, 'no capture conflict should be raised')
  } finally {
    active = null // subsequent fs (incl. rmSync) passes through with no active state
    rmSync(dir, { recursive: true, force: true })
  }
})
