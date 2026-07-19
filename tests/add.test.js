import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { addCommand } from '@exodus/stasis-core/add'

const here = dirname(fileURLToPath(import.meta.url))
const stasisCli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')

const cleanEnv = (() => {
  const { EXODUS_STASIS_LOCK: _l, EXODUS_STASIS_SCOPE: _s, EXODUS_STASIS_BUNDLE: _b, EXODUS_STASIS_BUNDLE_FILE: _bf, EXODUS_STASIS_DEBUG: _d, ...rest } = process.env
  return rest
})()

const runCli = (cli, args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-add-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CONFIG = { bundleFile: 'dist/code.br', resourcesBundleFile: 'dist/res.br', resources: ['svg', 'png'] }

// A small ESM project + a stasis.config.json declaring the two split targets and the allowlist.
const seed = (tmp, config = CONFIG) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  if (config) writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify(config))
  mkdirSync(join(tmp, 'src'), { recursive: true })
  mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(tmp, 'src', 'b.cjs'), 'module.exports = 2\n')
  writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg/>\n')
  writeFileSync(join(tmp, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]))
  writeFileSync(join(tmp, 'src', 'data.txt'), 'hi\n')
  writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }))
  writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), 'module.exports = 3\n')
}

const decode = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))

// Write a modern (imports+formats attesting) stasis.lock.json attesting the given workspace files
// -- `files` is a list of [rel, format]. Integrities are hashed from disk so `add` can merge in.
const writeLock = (tmp, files) => {
  const bucket = { name: 'app', version: '1.0.0', files: Object.create(null) }
  const formats = new Map()
  const entries = new Set()
  for (const [rel, fmt] of files) {
    bucket.files[rel] = sha512integrity(readFileSync(join(tmp, rel)))
    formats.set(rel, fmt)
    if (fmt !== 'resource' && fmt !== 'resource:base64') entries.add(rel)
  }
  const lock = new Lockfile({ config: { scope: 'full' }, entries, modules: new Map([['.', bucket]]), imports: new Map(), formats })
  writeFileSync(join(tmp, 'stasis.lock.json'), lock.serialize())
}

// --- addCommand: classification + split -------------------------------------

test('addCommand splits source files to bundleFile and declared resources to resourcesBundleFile', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/b.cjs', 'src/icon.svg', 'src/logo.png'] })

  const code = decode(join(tmp, 'dist/code.br'))
  const res = decode(join(tmp, 'dist/res.br'))

  // Source files -> the code bundle, path-inferred format, no imports. `add` records NO entries
  // (attested files aren't entry points), unlike the deep `bundle`.
  t.assert.deepEqual(Object.keys(code.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.equal(code.entries.size, 0, 'add files are attested, never entries')
  t.assert.equal(code.formats.get('src/a.js'), 'module') // package "type": "module"
  t.assert.equal(code.formats.get('src/b.cjs'), 'commonjs')
  t.assert.equal(code.imports.size, 0)

  // Declared resources -> the resources bundle: no entries, resource formats, binary base64.
  t.assert.deepEqual(Object.keys(res.modules.get('.').files).toSorted(), ['src/icon.svg', 'src/logo.png'])
  t.assert.equal(res.entries.size, 0, 'a resources bundle has no entries')
  t.assert.equal(res.imports.size, 0)
  t.assert.equal(res.formats.get('src/icon.svg'), 'resource')
  t.assert.equal(res.formats.get('src/logo.png'), 'resource:base64')
  t.assert.equal(res.modules.get('.').files['src/logo.png'], Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]).toString('base64'))
}))

test('addCommand classifies Xcode project-bundle inputs the Metro packager excludes (pbxproj/xcworkspacedata)', withTmp(async (t, tmp) => {
  // The packager skips `.xcodeproj`/`.xcworkspace` as IDE metadata, but a user can attest their
  // text inputs explicitly with `stasis add` -- project.pbxproj (an old-style plist) as 'pbxproj'
  // and the workspace descriptor as 'xml'. Both are CODE, so they land in the code bundle.
  seed(tmp)
  mkdirSync(join(tmp, 'ios', 'App.xcodeproj', 'project.xcworkspace'), { recursive: true })
  writeFileSync(join(tmp, 'ios', 'App.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n{ archiveVersion = 1; }\n')
  writeFileSync(join(tmp, 'ios', 'App.xcodeproj', 'project.xcworkspace', 'contents.xcworkspacedata'), '<Workspace/>\n')
  addCommand({ cwd: tmp, entries: ['ios/App.xcodeproj/project.pbxproj', 'ios/App.xcodeproj/project.xcworkspace/contents.xcworkspacedata'] })

  const code = decode(join(tmp, 'dist/code.br'))
  t.assert.equal(code.formats.get('ios/App.xcodeproj/project.pbxproj'), 'pbxproj')
  t.assert.equal(code.formats.get('ios/App.xcodeproj/project.xcworkspace/contents.xcworkspacedata'), 'xml')
  t.assert.ok(!existsSync(join(tmp, 'dist/res.br')), 'both are code -> no resources bundle written')
}))

test('addCommand classifies the native build-input vocabulary as code (shared with the Metro capture)', withTmp(async (t, tmp) => {
  // `stasis add` recognizes the same native formats the packager does (via nativeSourceFormat),
  // so a user can attest a native file by hand and get the right tag -- no `resources` allowlist
  // needed. Unlike the packager, `add` has no deep-walk/exclusion; it attests what it's handed.
  seed(tmp)
  mkdirSync(join(tmp, 'ios'), { recursive: true })
  mkdirSync(join(tmp, 'android'), { recursive: true })
  writeFileSync(join(tmp, 'ios', 'RNThing.podspec'), 'Pod::Spec.new {}\n')
  writeFileSync(join(tmp, 'ios', 'RNThing.swift'), 'import Foundation\n')
  writeFileSync(join(tmp, 'ios', 'RNThing.mm'), '@implementation X @end\n')
  writeFileSync(join(tmp, 'ios', 'Podfile'), "pod 'X'\n")
  writeFileSync(join(tmp, 'android', 'build.gradle'), 'apply plugin: "x"\n')
  writeFileSync(join(tmp, 'android', 'AndroidManifest.xml'), '<manifest/>\n')
  writeFileSync(join(tmp, 'gradlew'), '#!/usr/bin/env sh\nexec gradle "$@"\n')
  writeFileSync(join(tmp, '.env'), 'API_URL=x\n')
  writeFileSync(join(tmp, 'apple-app-site-association'), '{ "applinks": {} }\n')

  const entries = ['ios/RNThing.podspec', 'ios/RNThing.swift', 'ios/RNThing.mm', 'ios/Podfile',
    'android/build.gradle', 'android/AndroidManifest.xml', 'gradlew', '.env', 'apple-app-site-association']
  addCommand({ cwd: tmp, entries })

  const code = decode(join(tmp, 'dist/code.br'))
  const fmt = (rel) => code.formats.get(rel)
  t.assert.equal(fmt('ios/RNThing.podspec'), 'podspec')
  t.assert.equal(fmt('ios/RNThing.swift'), 'swift')
  t.assert.equal(fmt('ios/RNThing.mm'), 'objcpp')
  t.assert.equal(fmt('ios/Podfile'), 'podfile')
  t.assert.equal(fmt('android/build.gradle'), 'gradle')
  t.assert.equal(fmt('android/AndroidManifest.xml'), 'xml')
  t.assert.equal(fmt('gradlew'), 'shell')
  t.assert.equal(fmt('.env'), 'env')
  t.assert.equal(fmt('apple-app-site-association'), 'json')
  // All are code -> all entries, none in a resources bundle.
  t.assert.ok(!existsSync(join(tmp, 'dist/res.br')), 'native build inputs are code, not resources')
}))

test('addCommand attributes packed files to the `add` consumer in `reason`', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/icon.svg'] })
  const code = decode(join(tmp, 'dist/code.br'))
  t.assert.deepEqual(Object.keys(code.reason), ['add'], 'add attributes under `add`, not `bundle`')
  t.assert.deepEqual(code.reason.add.toSorted(), ['src/a.js'])
  const res = decode(join(tmp, 'dist/res.br'))
  t.assert.deepEqual(Object.keys(res.reason), ['add'])
  t.assert.deepEqual(res.reason.add.toSorted(), ['src/icon.svg'])
}))

test('addCommand is additive across runs (merges into each split bundle)', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/icon.svg'] })
  addCommand({ cwd: tmp, entries: ['src/b.cjs', 'src/logo.png'] })
  t.assert.deepEqual(Object.keys(decode(join(tmp, 'dist/code.br')).modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual(Object.keys(decode(join(tmp, 'dist/res.br')).modules.get('.').files).toSorted(), ['src/icon.svg', 'src/logo.png'])
}))

test('addCommand preserves an existing bundle’s entries and adds none of its own', withTmp(async (t, tmp) => {
  seed(tmp, { bundleFile: 'dist/code.br' })
  // A pre-existing bundle that declares src/a.js as an entry, as a deep `stasis bundle` would.
  const prior = new Bundle({
    config: { scope: 'full' },
    entries: new Set(['src/a.js']),
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': readFileSync(join(tmp, 'src/a.js'), 'utf8') } }]]),
    formats: new Map([['src/a.js', 'module']]),
    imports: new Map(),
  })
  mkdirSync(join(tmp, 'dist'), { recursive: true })
  writeFileSync(join(tmp, 'dist/code.br'), brotliCompressSync(prior.serialize()))

  addCommand({ cwd: tmp, entries: ['src/b.cjs'] })
  const code = decode(join(tmp, 'dist/code.br'))
  t.assert.deepEqual(Object.keys(code.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual([...code.entries], ['src/a.js'], 'the deep entry is preserved; add adds none')
}))

test('addCommand expands a directory entry to the files under it (recursive glob)', withTmp(async (t, tmp) => {
  seed(tmp)
  rmSync(join(tmp, 'src', 'data.txt')) // undeclared -- would be refused if swept in
  mkdirSync(join(tmp, 'src', 'nested'), { recursive: true }) // prove the glob recurses
  writeFileSync(join(tmp, 'src', 'nested', 'c.mjs'), 'export const c = 3\n')
  addCommand({ cwd: tmp, entries: ['src'] })

  // Every file under src/ is classified and split, at any depth.
  t.assert.deepEqual(
    Object.keys(decode(join(tmp, 'dist/code.br')).modules.get('.').files).toSorted(),
    ['src/a.js', 'src/b.cjs', 'src/nested/c.mjs'],
  )
  t.assert.deepEqual(
    Object.keys(decode(join(tmp, 'dist/res.br')).modules.get('.').files).toSorted(),
    ['src/icon.svg', 'src/logo.png'],
  )
}))

test('addCommand refuses an undeclared file swept in by a directory entry', withTmp(async (t, tmp) => {
  seed(tmp) // src/data.txt is present and .txt is not declared
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src'] }), /src\/data\.txt is neither a recognized source file nor a declared resource/)
}))

test('addCommand buckets a node_modules file into its own npm package bucket', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'node_modules/dep/index.js'] })
  const code = decode(join(tmp, 'dist/code.br'))
  t.assert.deepEqual([...code.modules.keys()].toSorted(), ['.', 'node_modules/dep'])
  const dep = code.modules.get('node_modules/dep')
  t.assert.equal(dep.name, 'dep')
  t.assert.equal(dep.version, '2.0.0')
  t.assert.equal(dep.ecosystem, 'npm')
}))

test('addCommand only writes the bundle for the kind of files given', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js'] }) // code only
  t.assert.ok(existsSync(join(tmp, 'dist/code.br')))
  t.assert.ok(!existsSync(join(tmp, 'dist/res.br')), 'no resources bundle when no resources were added')
}))

// --- addCommand: lockfile update --------------------------------------------

test('addCommand updates an existing stasis.lock.json (one lockfile covers both split targets)', withTmp(async (t, tmp) => {
  seed(tmp)
  // Present lockfile already attesting src/a.js; add merges the new files' integrities in.
  writeLock(tmp, [['src/a.js', 'module']])
  addCommand({ cwd: tmp, entries: ['src/b.cjs', 'src/icon.svg'] })

  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepEqual(Object.keys(lock.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs', 'src/icon.svg'])
  // Integrity is hashed from the raw bytes (so a frozen run reading disk matches).
  t.assert.equal(lock.modules.get('.').files['src/b.cjs'], sha512integrity(readFileSync(join(tmp, 'src/b.cjs'))))
  t.assert.equal(lock.formats.get('src/b.cjs'), 'commonjs')
  t.assert.equal(lock.formats.get('src/icon.svg'), 'resource')
  // add adds no entries: only the pre-existing src/a.js stays an entry (src/b.cjs is attested, not an entry).
  t.assert.deepEqual([...lock.entries].toSorted(), ['src/a.js'])
}))

test('addCommand never creates a lockfile when none is present', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js'] })
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')), 'no lockfile is created')
}))

test('addCommand refuses to update a lockfile when the same path attests different bytes', withTmp(async (t, tmp) => {
  seed(tmp)
  writeLock(tmp, [['src/a.js', 'module']])
  writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 999\n') // bytes now differ from the lockfile
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/a.js'] }), /content mismatch|integrity/i)
}))

// --- addCommand: config + classification errors -----------------------------

test('addCommand requires a stasis.config.json', withTmp(async (t, tmp) => {
  seed(tmp, null) // no config
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/a.js'] }), /requires a stasis\.config\.json/)
}))

test('addCommand overrides a payload-free stat:file record already in the target bundle', withTmp(async (t, tmp) => {
  seed(tmp, { bundleFile: 'dist/code.br' })
  // Simulate a prior `stasis run --fs` capture: the target bundle attests src/a.js as a
  // bytes-free stat:file record. Adding the real file must upgrade it, not conflict.
  const prior = new Bundle({ config: { scope: 'full' }, formats: new Map([['src/a.js', 'stat:file']]) })
  mkdirSync(join(tmp, 'dist'), { recursive: true })
  writeFileSync(join(tmp, 'dist/code.br'), brotliCompressSync(prior.serialize()))
  addCommand({ cwd: tmp, entries: ['src/a.js'] })
  const code = decode(join(tmp, 'dist/code.br'))
  t.assert.equal(code.formats.get('src/a.js'), 'module', 'the real format supersedes the stat record')
  t.assert.equal(code.modules.get('.').files['src/a.js'], 'export const a = 1\n')
}))

test('addCommand refuses a file that is neither source nor a declared resource', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.throws(
    () => addCommand({ cwd: tmp, entries: ['src/data.txt'] }),
    /src\/data\.txt is neither a recognized source file nor a declared resource/,
  )
}))

test('addCommand rejects a config whose two split targets resolve to the same file', withTmp(async (t, tmp) => {
  // Distinct as strings ('./dist/x.br' vs 'dist/x.br') but the same canonical path -- the
  // code and resources bundles have incompatible shapes, so one file can't be both.
  seed(tmp, { bundleFile: 'dist/x.br', resourcesBundleFile: './dist/x.br', resources: ['svg'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/a.js'] }), /must name distinct paths/)
}))

test('addCommand defaults a missing bundleFile to stasis.code.br', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['svg'] }) // config present, but no bundleFile / resourcesBundleFile
  addCommand({ cwd: tmp, entries: ['src/a.js'] })
  const code = decode(join(tmp, 'stasis.code.br'))
  t.assert.deepEqual(Object.keys(code.modules.get('.').files), ['src/a.js'])
  t.assert.equal(code.formats.get('src/a.js'), 'module')
}))

test('addCommand without a resourcesBundleFile writes resources into bundleFile (non-split)', withTmp(async (t, tmp) => {
  seed(tmp, { bundleFile: 'dist/code.br', resources: ['svg', 'png'] }) // no resourcesBundleFile
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/icon.svg', 'src/logo.png'] })
  t.assert.ok(!existsSync(join(tmp, 'dist/res.br')), 'no separate resources bundle in non-split mode')
  // Code and declared resources coexist in the one bundle; add records no entries.
  const bundle = decode(join(tmp, 'dist/code.br'))
  t.assert.deepEqual(Object.keys(bundle.modules.get('.').files).toSorted(), ['src/a.js', 'src/icon.svg', 'src/logo.png'])
  t.assert.equal(bundle.entries.size, 0, 'add files are attested, never entries')
  t.assert.equal(bundle.formats.get('src/icon.svg'), 'resource')
  t.assert.equal(bundle.formats.get('src/logo.png'), 'resource:base64')
}))

test('addCommand rejects a missing file, an escaping path, and a symlink escaping the root', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.throws(() => addCommand({ cwd: tmp, entries: [] }), /at least one file/)
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/nope.js'] }), /file not found: src\/nope\.js/)
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['../outside.js'] }), /Entry escapes baseDir/)

  const outside = mkdtempSync(join(tmpdir(), 'stasis-outside-'))
  try {
    writeFileSync(join(outside, 'secret.js'), 'export const s = 1\n')
    symlinkSync(join(outside, 'secret.js'), join(tmp, 'link.js'))
    t.assert.throws(() => addCommand({ cwd: tmp, entries: ['link.js'] }), /symlink escaping bundle root/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

// --- CLI: stasis-core add ---------------------------------------------------

test('CLI (stasis-core): add splits into the configured bundles', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(coreCli, ['add', 'src/a.js', 'src/icon.svg'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis-core\] add: \+1 source \(1 total\) -> dist\/code\.br; \+1 resource \(1 total\) -> dist\/res\.br/)
  t.assert.ok(existsSync(join(tmp, 'dist/code.br')) && existsSync(join(tmp, 'dist/res.br')))
}))

test('CLI (stasis-core): add expands a directory argument', withTmp(async (t, tmp) => {
  seed(tmp)
  rmSync(join(tmp, 'src', 'data.txt'))
  const r = runCli(coreCli, ['add', 'src'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.deepEqual(
    Object.keys(decode(join(tmp, 'dist/code.br')).modules.get('.').files).toSorted(),
    ['src/a.js', 'src/b.cjs'],
  )
}))

test('CLI (stasis-core): add with no file, an option, or no config errors', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.equal(runCli(coreCli, ['add'], { cwd: tmp }).status, 1)
  const opt = runCli(coreCli, ['add', '--output=x', 'src/a.js'], { cwd: tmp })
  t.assert.equal(opt.status, 1)
  t.assert.match(opt.stderr, /add takes no options/)

  rmSync(join(tmp, 'stasis.config.json'))
  const noCfg = runCli(coreCli, ['add', 'src/a.js'], { cwd: tmp })
  t.assert.equal(noCfg.status, 1)
  t.assert.match(noCfg.stderr, /requires a stasis\.config\.json/)
}))

// --- CLI: stasis add --------------------------------------------------------

test('CLI (stasis): add delegates to the same core implementation', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['add', 'src/b.cjs', 'src/logo.png'], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /\[stasis\] add:/)
  t.assert.equal(decode(join(tmp, 'dist/code.br')).formats.get('src/b.cjs'), 'commonjs')
  t.assert.equal(decode(join(tmp, 'dist/res.br')).formats.get('src/logo.png'), 'resource:base64')
}))

test('CLI (stasis): the deep bundle command no longer accepts --shallow', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['bundle', '--shallow', 'src/a.js'], { cwd: tmp })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Unknown option|Error/)
}))
