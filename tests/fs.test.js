// Unit coverage for the `stasis run --fs` State API: addFsFile / addFsDir capture
// and getFsFile / getFsDir serve, plus the moduleFileKey edge for a directory
// captured at a module root. Exercised in-process (no loader / spawn) by capturing
// into a write-mode State, persisting, and reloading a load-mode State from the
// same files -- the same round-trip the CLI does, but granular and deterministic.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'
import { moduleFileKey } from '@exodus/stasis-core/util'

// A non-UTF-8 payload -> resource:base64; valid UTF-8 text -> resource; .json ->
// code (the json loader format); a directory listing -> directory.
const BINARY = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42])

const withProject = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-fs-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fs-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'message.txt'), 'hello\n')
    writeFileSync(join(dir, 'assets', 'data.json'), '{ "k": "v" }\n')
    writeFileSync(join(dir, 'assets', 'blob.bin'), BINARY)
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fileURL = (root, ...parts) => pathToFileURL(join(root, ...parts)).toString()

test('moduleFileKey joins like before for real files, keys a module-root listing at the dir', (t) => {
  t.assert.equal(moduleFileKey('.', 'src/foo.js'), 'src/foo.js')
  t.assert.equal(moduleFileKey('node_modules/x', 'index.js'), 'node_modules/x/index.js')
  // rel === '' is only produced by a directory capture whose path is the bucket
  // itself -- never `${dir}/`, which would break the flat-key round-trip.
  t.assert.equal(moduleFileKey('node_modules/x', ''), 'node_modules/x')
  // The workspace root keys at '.' (not ''): join('.', '') === '.' is what the
  // lockfile hash absorb derives on load, so '' would be written but never found.
  t.assert.equal(moduleFileKey('.', ''), '.')
})

test('addFsFile classifies by extension against the resources allowlist', withProject((t, dir) => {
  // txt + bin are declared resources here; .json is always code. The same
  // classifyExtension the bundler plugins use decides each.
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br'), resources: ['bin', 'txt'] })

  state.addFsFile(fileURL(dir, 'assets', 'message.txt'), Buffer.from('hello\n'))
  state.addFsFile(fileURL(dir, 'assets', 'data.json'), Buffer.from('{ "k": "v" }\n'))
  state.addFsFile(fileURL(dir, 'assets', 'blob.bin'), BINARY)

  // .txt -> resource (raw UTF-8, in this.resources); .json -> json code (in
  // this.sources); binary -> resource:base64 (in this.resources).
  t.assert.equal(state.formats.get('assets/message.txt'), 'resource')
  t.assert.equal(state.formats.get('assets/data.json'), 'json')
  t.assert.equal(state.formats.get('assets/blob.bin'), 'resource:base64')
  t.assert.equal(state.resources.get('assets/message.txt'), 'hello\n')
  t.assert.equal(state.sources.get('assets/data.json'), '{ "k": "v" }\n')
  t.assert.equal(state.resources.get('assets/blob.bin'), BINARY.toString('base64'))
  // Hashed like any other file, so the lockfile attests it.
  t.assert.match(state.hashes.get('assets/blob.bin'), /^sha512-/)
}))

test('addFsFile throws on an undeclared (non-code, non-allowlisted) extension', withProject((t, dir) => {
  // No allowlist: a .dat read is neither code nor a declared resource. Recording it as
  // a resource would silently widen the attested set, so it throws -- the --fs hook
  // turns this into a tainted, nothing-written run.
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })
  writeFileSync(join(dir, 'assets', 'thing.dat'), 'payload\n')
  t.assert.throws(
    () => state.addFsFile(fileURL(dir, 'assets', 'thing.dat'), Buffer.from('payload\n')),
    /neither code nor a declared resource/
  )
}))

test('addFsFile records an allowlisted extensionless filename (LICENSE) as a resource', withProject((t, dir) => {
  // A `resources` entry can be a bare filename; a file with no extension is matched by
  // its basename. LICENSE is declared here, so the fs-read is captured as a resource.
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br'), resources: ['LICENSE'] })
  writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
  state.addFsFile(fileURL(dir, 'LICENSE'), Buffer.from('MIT\n'))
  t.assert.equal(state.formats.get('LICENSE'), 'resource')
  t.assert.equal(state.resources.get('LICENSE'), 'MIT\n')
  t.assert.match(state.hashes.get('LICENSE'), /^sha512-/)
}))

test('addFsFile records a .jsx fs-read as code, never a resource', withProject((t, dir) => {
  // .jsx/.tsx are code extensions with no Node loader format. The old fs-capture set
  // omitted them, so they fell through to the resource branch and tripped addFile's
  // code-can't-be-a-resource guard. Now classifyExtension calls them code: hashed +
  // stored in this.sources, no format imposed.
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })
  writeFileSync(join(dir, 'comp.jsx'), 'export const C = () => null\n')
  state.addFsFile(fileURL(dir, 'comp.jsx'), Buffer.from('export const C = () => null\n'))
  t.assert.equal(state.sources.get('comp.jsx'), 'export const C = () => null\n')
  t.assert.equal(state.resources.has('comp.jsx'), false)
  t.assert.equal(state.formats.get('comp.jsx'), undefined, 'no Node loader format for .jsx')
  t.assert.match(state.hashes.get('comp.jsx'), /^sha512-/)
}))

test('addFsDir stores a sorted JSON listing as a directory payload, integrity over the JSON', withProject((t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })

  // Pass the names out of order: the stored content must be sorted.
  state.addFsDir(fileURL(dir, 'assets'), ['message.txt', 'blob.bin', 'data.json'])

  t.assert.equal(state.formats.get('assets'), 'directory')
  t.assert.equal(state.resources.get('assets'), '["blob.bin","data.json","message.txt"]')
  t.assert.match(state.hashes.get('assets'), /^sha512-/)
  // getFsDir round-trips the listing (and re-asserts the hash via getFile).
  t.assert.deepEqual(state.getFsDir(fileURL(dir, 'assets')), ['blob.bin', 'data.json', 'message.txt'])
}))

test('addFsDir is idempotent for an identical listing regardless of input order', withProject((t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })
  state.addFsDir(fileURL(dir, 'assets'), ['a', 'b'])
  t.assert.doesNotThrow(() => state.addFsDir(fileURL(dir, 'assets'), ['b', 'a']))
}))

test('getFsFile / getFsDir distinguish files from directories and miss cleanly', withProject((t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br'), resources: ['bin', 'txt'] })
  state.addFsFile(fileURL(dir, 'assets', 'message.txt'), Buffer.from('hello\n'))
  state.addFsDir(fileURL(dir, 'assets'), ['message.txt', 'data.json', 'blob.bin'])

  // A captured file yields its raw bytes as a Buffer.
  t.assert.deepEqual(state.getFsFile(fileURL(dir, 'assets', 'message.txt')), Buffer.from('hello\n'))
  // readFileSync of a captured directory must not return the listing.
  t.assert.equal(state.getFsFile(fileURL(dir, 'assets')), undefined)
  // readdirSync of a captured file must not return a listing.
  t.assert.equal(state.getFsDir(fileURL(dir, 'assets', 'message.txt')), undefined)
  // Uncaptured paths miss (the hook then falls back to a real disk read).
  t.assert.equal(state.getFsFile(fileURL(dir, 'assets', 'data.json')), undefined)
  t.assert.equal(state.getFsDir(fileURL(dir, 'nope')), undefined)
}))

test('fs captures round-trip through a written bundle into a load-mode State', withProject((t, dir) => {
  const bundleFile = join(dir, 'snapshot.br')
  const cap = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile, resources: ['bin', 'txt'] })
  cap.addFsFile(fileURL(dir, 'assets', 'message.txt'), Buffer.from('hello\n'))
  cap.addFsFile(fileURL(dir, 'assets', 'blob.bin'), BINARY)
  cap.addFsDir(fileURL(dir, 'assets'), ['message.txt', 'blob.bin', 'data.json'])
  cap.write()

  // Reload from the persisted lockfile + bundle, frozen so getFile re-verifies hashes.
  const load = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile })
  t.assert.deepEqual(load.getFsFile(fileURL(dir, 'assets', 'message.txt')), Buffer.from('hello\n'))
  t.assert.deepEqual(load.getFsFile(fileURL(dir, 'assets', 'blob.bin')), BINARY)
  t.assert.deepEqual(load.getFsDir(fileURL(dir, 'assets')), ['blob.bin', 'data.json', 'message.txt'])
  t.assert.equal(load.formats.get('assets'), 'directory')
}))

test('addFsDir resolves the owning package for directories named/under node_modules', withProject((t, dir) => {
  // Regression: findPackageJSON of a directory URL is unreliable -- for a path
  // involving node_modules it can return a `node_modules/` DIRECTORY (then read as
  // a file -> EISDIR) or undefined. #nearestPackageJsonFor walks up instead, so a
  // readdir of node_modules (or a nested one, or a package root) buckets cleanly.
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }))
  mkdirSync(join(dir, 'src', 'node_modules'), { recursive: true }) // a nested node_modules (the reported case)
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })

  t.assert.doesNotThrow(() => state.addFsDir(fileURL(dir, 'node_modules'), ['dep']))
  t.assert.equal(state.formats.get('node_modules'), 'directory')
  // a node_modules PACKAGE ROOT -> bucketed under the dep itself (rel='')
  t.assert.doesNotThrow(() => state.addFsDir(fileURL(dir, 'node_modules', 'dep'), ['package.json']))
  t.assert.equal(state.formats.get('node_modules/dep'), 'directory')
  // a nested src/node_modules -- findPackageJSON returned this dir itself (EISDIR) before the fix
  t.assert.doesNotThrow(() => state.addFsDir(fileURL(dir, 'src', 'node_modules'), []))
  t.assert.equal(state.formats.get('src/node_modules'), 'directory')
}))

test('addFsDir resolves the bucket for a directory captured AT a package/project root', withProject((t, dir) => {
  // Regression: a readdir of a bucket root (the project root here, but equally a
  // node_modules package root) used to throw inside #locateModule. #nearestPackageJsonFor
  // walks up to the owning package.json and moduleFileKey keys the listing at the bucket.
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })
  t.assert.doesNotThrow(() => state.addFsDir(pathToFileURL(dir).toString(), ['package.json', 'assets']))
  // The root directory keys its listing at '.' (the '.' bucket root) -- the same key
  // the lockfile hash absorb derives on load (join('.', '') === '.'), never ''.
  t.assert.equal(state.formats.get('.'), 'directory')
  t.assert.equal(state.resources.get('.'), '["assets","package.json"]')
  t.assert.match(state.hashes.get('.'), /^sha512-/)
  t.assert.deepEqual(state.getFsDir(pathToFileURL(dir).toString()), ['assets', 'package.json'])
  t.assert.equal(state.getFsStat(pathToFileURL(dir).toString()), 'directory')
}))

test('a project-root readdir capture round-trips through a written lockfile + bundle', withProject((t, dir) => {
  // Regression (the reported case): the root listing was recorded under ''
  // (relative(root, root)), while a loading State re-derived its hash key from the
  // lockfile as join('.', '') === '.'. So at load the format said 'directory' under
  // '' but the integrity lookup found nothing, and serving the root readdir crashed.
  // Both sides now key the project root at '.'.
  const bundleFile = join(dir, 'snapshot.br')
  const rootURL = pathToFileURL(dir).toString()
  const cap = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile })
  cap.addFsDir(rootURL, ['package.json', 'assets'])
  cap.write()

  // On disk: the format keys at '.', the hash lives at rel '' inside the '.' bucket.
  const lock = JSON.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf8'))
  t.assert.equal(lock.formats['.'], 'directory')
  t.assert.match(lock.sources['.'].files[''], /^sha512-/)

  // Reload frozen so getFsDir's getFile re-verifies the integrity under the SAME key.
  const load = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile })
  t.assert.equal(load.hashes.get('.'), lock.sources['.'].files[''])
  t.assert.equal(load.formats.get('.'), 'directory')
  t.assert.deepEqual(load.getFsDir(rootURL), ['assets', 'package.json'])
  t.assert.equal(load.getFsStat(rootURL), 'directory')
  t.assert.equal(load.getFsFile(rootURL), undefined, 'a readFileSync of the root must not serve the listing')
}))

test('legacy artifacts keying the root listing at \'\' are normalized to "." on load', withProject((t, dir) => {
  // Artifacts written BEFORE the '.' normalization carry the root listing's format
  // under '' (the files entry itself -- rel '' in the '.' bucket -- is unchanged).
  // Lockfile.parse / Bundle.parse normalize the legacy key so those keep serving.
  const bundleFile = join(dir, 'snapshot.br')
  const rootURL = pathToFileURL(dir).toString()
  const cap = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile })
  cap.addFsDir(rootURL, ['package.json', 'assets'])
  cap.write()

  // Rewrite both artifacts to the pre-normalization shape: format keyed at ''.
  const relabel = ({ '.': root, ...rest }) => ({ '': root, ...rest })
  const lockPath = join(dir, 'stasis.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.formats = relabel(lock.formats)
  writeFileSync(lockPath, JSON.stringify(lock))
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(bundleFile)).toString('utf8'))
  bundle.formats = relabel(bundle.formats)
  writeFileSync(bundleFile, brotliCompressSync(JSON.stringify(bundle)))

  const load = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile })
  t.assert.equal(load.formats.get('.'), 'directory') // normalized on parse
  t.assert.deepEqual(load.getFsDir(rootURL), ['assets', 'package.json'])
  t.assert.equal(load.getFsStat(rootURL), 'directory')
}))

test('addFsFile records a type-less .js without a format so the loader stays authoritative', withProject((t, dir) => {
  // package.json has type:"module" here, but the point is order-independence: a
  // type-less .js the loader detects as ESM ('module') must not collide with the
  // commonjs default addFile would otherwise impose for a no-format call. addFsFile
  // records the bytes with inferFormat:false (no format), so a later loader-style
  // addFile(format:'module') for the SAME file is a clean no-conflict upsert.
  writeFileSync(join(dir, 'lib.js'), 'export const x = 1\n')
  const url = fileURL(dir, 'lib.js')
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })

  state.addFsFile(url, Buffer.from('export const x = 1\n')) // fs read first (the harder order)
  t.assert.equal(state.formats.get('lib.js'), undefined, 'no format imposed by the fs read')
  // getFsFile still serves the bytes even with no recorded format.
  t.assert.deepEqual(state.getFsFile(url), Buffer.from('export const x = 1\n'))
  // The loader records the authoritative format afterwards -- must not conflict.
  t.assert.doesNotThrow(() => state.addFile(url, { source: 'export const x = 1\n', format: 'module' }))
  t.assert.equal(state.formats.get('lib.js'), 'module')
}))

test('getFsStat classifies recorded files and directories, undefined otherwise', withProject((t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br'), resources: ['bin', 'txt'] })
  state.addFsFile(fileURL(dir, 'assets', 'message.txt'), Buffer.from('hello\n'))
  state.addFsDir(fileURL(dir, 'assets'), ['message.txt'])
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets', 'message.txt')), 'file')
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets')), 'directory')
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets', 'nope.txt')), undefined)
}))

test('getFsStat reports ancestor directories implied by a recorded file', withProject((t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br'), resources: ['bin', 'txt'] })
  mkdirSync(join(dir, 'assets', 'sub'))
  writeFileSync(join(dir, 'assets', 'sub', 'deep.txt'), 'x\n')
  // Only the file is recorded -- the intermediate dir 'assets/sub' is never readdir'd.
  state.addFsFile(fileURL(dir, 'assets', 'sub', 'deep.txt'), Buffer.from('x\n'))
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets', 'sub', 'deep.txt')), 'file')
  // ...yet every ancestor dir (and the project root) is provably a directory.
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets', 'sub')), 'directory')
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets')), 'directory')
  t.assert.equal(state.getFsStat(pathToFileURL(dir).toString()), 'directory') // root
  t.assert.equal(state.getFsStat(fileURL(dir, 'assets', 'other')), undefined) // not implied
}))

test('--fs skips capturing a write-mode sidecar\'s graph file (attestedBySidecar / #sidecars)', withProject((t, dir) => {
  // The split a `bundleFile` plugin produces during CAPTURE: a parent (preload/"main")
  // bundle + a write-mode sidecar (StasisWebpack/StasisEsbuild/StasisMetro). The plugin
  // captures the bundler's MODULE GRAPH into the sidecar; --fs must NOT re-record those
  // graph reads into main, which is what attestedBySidecar (consulting the write-mode
  // contributors in #sidecars) gates.
  const parent = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'main.br') })
  const sidecar = new State(dir, { parent, scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'sidecar.br') })

  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'lib.js'), 'export const x = 1\n') // addFile canonicalizes against disk
  const libURL = fileURL(dir, 'src', 'lib.js')     // a graph file the plugin captured -> sidecar
  const dataURL = fileURL(dir, 'src', 'data.txt')  // a file no sidecar owns (e.g. a --fs read)
  sidecar.addFile(libURL, { source: 'export const x = 1\n', isEntry: true })

  // attestedBySidecar: true only for a file a WRITE-mode SIDECAR carries (so --fs skips
  // re-capturing the graph into main); a parent-only / unknown path is false (--fs records
  // it as usual).
  t.assert.equal(parent.attestedBySidecar(libURL), true)
  t.assert.equal(parent.attestedBySidecar(dataURL), false)

  // The serve path (getFs*Family) consults #readSidecars only -- a WRITE-mode sidecar isn't
  // there (it's a lockfile contributor; at load the bundler serves the graph through its own
  // loader, not --fs). So at capture the family-serve doesn't see it; the load-mode
  // round-trip below exercises the serving path.
  t.assert.equal(parent.getFsStatFamily(libURL), undefined)
  t.assert.equal(parent.getFsFileFamily(libURL), undefined)
}))

test('--fs serves a load-mode sidecar\'s graph file via the family (getFs*Family / #readSidecars)', withProject((t, dir) => {
  const mainFile = join(dir, 'main.br')
  const sidecarFile = join(dir, 'sidecar.br')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'lib.js'), 'export const x = 1\n')    // graph file -> sidecar
  writeFileSync(join(dir, 'src', 'helper.js'), 'export const y = 2\n') // a non-graph --fs read -> main
  const libURL = fileURL(dir, 'src', 'lib.js')
  const helperURL = fileURL(dir, 'src', 'helper.js')

  // Capture: the bundler's graph file goes into the SIDECAR (an entry), while a non-graph
  // --fs read lands in MAIN (mirrors the real split: main always carries the bundler's own
  // dev/runtime reads). Persist both -- the parent's lockfile unions the sidecar's edges.
  const parent = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: mainFile })
  const sidecar = new State(dir, { parent, scope: 'full', lock: 'add', bundle: 'add', bundleFile: sidecarFile })
  sidecar.addFile(libURL, { source: 'export const x = 1\n', isEntry: true })
  parent.addFsFile(helperURL, Buffer.from('export const y = 2\n'))
  sidecar.write()
  parent.write()

  // Reload both in load mode. The load-mode sidecar registers into the parent's READ-ONLY
  // #readSidecars (not #sidecars), so getFs*Family serves its bytes while it never feeds the
  // lockfile.
  const loadParent = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile: mainFile })
  const loadSidecar = new State(dir, { parent: loadParent, scope: 'full', lock: 'frozen', bundle: 'load', bundleFile: sidecarFile })

  // main carries the non-graph read directly; the graph file is absent from main but served
  // through the family from the load-mode sidecar.
  t.assert.deepEqual(loadParent.getFsFile(helperURL), Buffer.from('export const y = 2\n'))
  t.assert.equal(loadParent.getFsFile(libURL), undefined)            // not in main
  t.assert.equal(loadParent.getFsStat(libURL), undefined)            // ...nor stat-able from main alone
  t.assert.equal(loadParent.getFsStatFamily(libURL), 'file')          // but the family has it
  t.assert.deepEqual(loadParent.getFsFileFamily(libURL), Buffer.from('export const x = 1\n'))
  t.assert.deepEqual(loadSidecar.getFsFile(libURL), Buffer.from('export const x = 1\n')) // the sidecar itself carries it

  // attestedBySidecar is a CAPTURE concern (write-mode contributors); at load there are none.
  t.assert.equal(loadParent.attestedBySidecar(libURL), false)
}))
