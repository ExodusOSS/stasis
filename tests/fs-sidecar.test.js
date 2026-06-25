// White-box integration for the --fs <-> bundler-plugin sidecar coordination implemented in
// stasis-core/src/fs.js. The fs.test.js unit covers attestedBySidecar / getFs*Family as State
// methods; this drives the GENUINE global fs hooks (installFsHooks) to prove the readFileSync /
// fs.promises.readFile wrappers actually consult the family in BOTH directions:
//   - CAPTURE: a read a write-mode sidecar attests (a bundler's module-graph file) is NOT
//     re-recorded into the preload/"main" bundle (the duplication this fix prevents).
//   - LOAD: a read of a graph file main doesn't carry is SERVED from a load-mode sidecar's
//     bundle via getFsFileFamily (#readSidecars) -- not a silent disk fallback. The
//     existence/canonical-path probes (existsSync/accessSync/realpathSync + async) serve from
//     the same family, so a check-then-read tool sees a sidecar-carried file too.
//
// installFsHooks is imported by RELATIVE path on purpose: fs.js is an internal module with no
// package export (installing process-global fs hooks is its whole job). node --test runs each
// test file in its own process, so the single global patch + syncBuiltinESMExports() here can't
// leak into sibling suites. The two tests share one install via a module-level `active` State
// the hooks read through getState; each test points it at the State under exercise and nulls it
// before teardown so setup/cleanup fs calls pass straight through.
import { test } from 'node:test'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

import { installFsHooks } from '../stasis-core/src/fs.js'

let active = null // the State the hooks see; null => passthrough (so setup/teardown fs is untouched)
let lastAbort = null
installFsHooks({
  async: true,
  getState: () => active,
  markAborted: (err) => { lastAbort = err },
  isLoadingModule: () => false,
})

test('capture: --fs skips recording sidecar-attested reads into main, records others (sync + async)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-fs-sidecar-'))
  lastAbort = null
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fs-sidecar-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, 'src'))
    const mk = (name, body) => { const p = join(dir, 'src', name); writeFileSync(p, body); return [p, pathToFileURL(p).toString()] }
    const [libPath, libURL] = mk('lib.js', 'export const x = 1\n')           // graph -> sidecar (sync read)
    const [helperPath, helperURL] = mk('helper.js', 'export const y = 2\n')  // non-graph -> main (sync read)
    const [lib2Path, lib2URL] = mk('lib2.js', 'export const x2 = 3\n')       // graph -> sidecar (async read)
    const [helper2Path, helper2URL] = mk('helper2.js', 'export const y2 = 4\n') // non-graph -> main (async read)
    const [lib3Path, lib3URL] = mk('lib3.js', 'export const x3 = 5\n')           // graph -> sidecar (callback read)
    const [helper3Path, helper3URL] = mk('helper3.js', 'export const y3 = 6\n') // non-graph -> main (callback read)

    const parent = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'main.br') })
    const sidecar = new State(dir, { parent, scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'sidecar.br') })
    // The plugin captures the bundler's graph into the sidecar (via the genuine reader, so its
    // own bookkeeping reads aren't seen by --fs). All graph files are attested by the sidecar.
    sidecar.addFile(libURL, { source: 'export const x = 1\n', isEntry: true })
    sidecar.addFile(lib2URL, { source: 'export const x2 = 3\n' })
    sidecar.addFile(lib3URL, { source: 'export const x3 = 5\n' })

    active = parent
    // SYNC: a program read of a sidecar-attested graph file returns real bytes but is NOT
    // recorded into main (the graph stays in the sidecar); a non-graph read IS recorded.
    t.assert.deepEqual(nodeFs.readFileSync(libPath), Buffer.from('export const x = 1\n'))
    t.assert.equal(parent.getFsStat(libURL), undefined, 'sidecar-attested read must not be recorded into main')
    t.assert.deepEqual(nodeFs.readFileSync(helperPath), Buffer.from('export const y = 2\n'))
    t.assert.equal(parent.getFsStat(helperURL), 'file', 'a non-graph read must be recorded into main')

    // ASYNC (--fs=async patches fs.promises.readFile too): the same split holds.
    t.assert.deepEqual(await nodeFs.promises.readFile(lib2Path), Buffer.from('export const x2 = 3\n'))
    t.assert.equal(parent.getFsStat(lib2URL), undefined, 'sidecar-attested async read must not be recorded into main')
    t.assert.deepEqual(await nodeFs.promises.readFile(helper2Path), Buffer.from('export const y2 = 4\n'))
    t.assert.equal(parent.getFsStat(helper2URL), 'file', 'a non-graph async read must be recorded into main')

    // CALLBACK form (fs.readFile, patched under --fs=async): the same capture-skip applies.
    // Resolve with the error-or-bytes (single resolve) so a failure surfaces in the deepEqual.
    const cbRead = (p) => new Promise((res) => nodeFs.readFile(p, (e, buf) => res(e ?? buf)))
    t.assert.deepEqual(await cbRead(lib3Path), Buffer.from('export const x3 = 5\n'))
    t.assert.equal(parent.getFsStat(lib3URL), undefined, 'sidecar-attested callback read must not be recorded into main')
    t.assert.deepEqual(await cbRead(helper3Path), Buffer.from('export const y3 = 6\n'))
    t.assert.equal(parent.getFsStat(helper3URL), 'file', 'a non-graph callback read must be recorded into main')
    t.assert.equal(lastAbort, null, 'no capture conflict should be raised')
  } finally {
    active = null
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load: --fs serves a load-mode sidecar\'s graph file through the real readFileSync hook (#readSidecars)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-fs-sidecar-load-'))
  const mainFile = join(dir, 'main.br')
  const sidecarFile = join(dir, 'sidecar.br')
  lastAbort = null
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fs-sidecar-load-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, 'src'))
    const mk = (name, body) => { const p = join(dir, 'src', name); writeFileSync(p, body); return [p, pathToFileURL(p).toString()] }
    const [libPath, libURL] = mk('lib.js', 'export const x = 1\n')        // graph -> sidecar (sync serve)
    const [lib2Path] = mk('lib2.js', 'export const x2 = 3\n')             // graph -> sidecar (async serve)
    const [helperPath] = mk('helper.js', 'export const y = 2\n')          // non-graph -> main (so main has code)

    // Capture + persist (active stays null: addFile/write read via the genuine reader, not the hook).
    const parent = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: mainFile })
    const sidecar = new State(dir, { parent, scope: 'full', lock: 'add', bundle: 'add', bundleFile: sidecarFile })
    sidecar.addFile(libURL, { source: 'export const x = 1\n', isEntry: true })
    sidecar.addFile(pathToFileURL(lib2Path).toString(), { source: 'export const x2 = 3\n' })
    parent.addFsFile(pathToFileURL(helperPath).toString(), Buffer.from('export const y = 2\n'))
    sidecar.write()
    parent.write()

    // Delete the graph files from disk: a served read now MUST come from the sidecar bundle,
    // never a disk fallback (a broken family-serve would throw ENOENT here).
    rmSync(libPath)
    rmSync(lib2Path)

    const loadParent = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile: mainFile })
    // Constructing the load-mode sidecar registers it into loadParent.#readSidecars.
    const loadSidecar = new State(dir, { parent: loadParent, scope: 'full', lock: 'frozen', bundle: 'load', bundleFile: sidecarFile })
    t.assert.deepEqual(loadSidecar.getFsFile(libURL), Buffer.from('export const x = 1\n')) // the sidecar carries it

    active = loadParent
    // SYNC serve through the real hook: getState()->loadParent (loadBundle) -> getFsFileFamily
    // -> #readSidecars -> the sidecar's bytes. If the serve site were wired to the own-only
    // getter (or the wrong registry), this would fall through to disk and throw ENOENT.
    t.assert.deepEqual(nodeFs.readFileSync(libPath), Buffer.from('export const x = 1\n'))
    // ASYNC serve through the real hook.
    t.assert.deepEqual(await nodeFs.promises.readFile(lib2Path), Buffer.from('export const x2 = 3\n'))

    // PROBES (existsSync/accessSync/realpathSync + async forms) must serve from the SAME family,
    // else a check-then-read tool -- e.g. @babel/core's existsSync(config)+realpath BEFORE
    // require() -- sees a sidecar-carried file as absent. Own-only probe getters would report
    // the disk-deleted file missing (false / ENOENT) even though readFileSync above serves it.
    t.assert.equal(nodeFs.existsSync(libPath), true, 'existsSync must see the sidecar-carried file')
    t.assert.equal(nodeFs.realpathSync(libPath), libPath, 'realpathSync must resolve the sidecar-carried file')
    nodeFs.accessSync(libPath, nodeFs.constants.F_OK) // read-only access on a carried file must not throw
    await nodeFs.promises.access(lib2Path, nodeFs.constants.F_OK) // async promise probe serves from the family too
    // Async-CALLBACK access/realpath and promise realpath must also serve from the family (a
    // disk-deleted, sidecar-carried file): own-only getters here would ENOENT on the deleted file.
    // Single-resolve with the error-or-value so a failure surfaces in the assertion below.
    const accessErr = await new Promise((res) => nodeFs.access(libPath, nodeFs.constants.F_OK, res))
    t.assert.ok(!accessErr, 'callback access must serve the sidecar-carried file (no error)')
    const cbRealpath = await new Promise((res) => nodeFs.realpath(libPath, (e, p) => res(e ?? p)))
    t.assert.equal(cbRealpath, libPath, 'callback realpath must resolve the sidecar-carried file')
    t.assert.equal(await nodeFs.promises.realpath(lib2Path), lib2Path, 'promises.realpath must resolve the sidecar-carried file')
    t.assert.equal(lastAbort, null, 'serving must not raise')
  } finally {
    active = null
    rmSync(dir, { recursive: true, force: true })
  }
})
