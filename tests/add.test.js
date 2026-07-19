import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { addCommand } from '@exodus/stasis-core/bundle-cmd'

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

// --- addCommand: classification + split -------------------------------------

test('addCommand splits source files to bundleFile and declared resources to resourcesBundleFile', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/b.cjs', 'src/icon.svg', 'src/logo.png'] })

  const code = decode(join(tmp, 'dist/code.br'))
  const res = decode(join(tmp, 'dist/res.br'))

  // Source files -> the code bundle, each its own entry, path-inferred format, no imports.
  t.assert.deepEqual(Object.keys(code.modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual([...code.entries].toSorted(), ['src/a.js', 'src/b.cjs'])
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

test('addCommand is additive across runs (merges into each split bundle)', withTmp(async (t, tmp) => {
  seed(tmp)
  addCommand({ cwd: tmp, entries: ['src/a.js', 'src/icon.svg'] })
  addCommand({ cwd: tmp, entries: ['src/b.cjs', 'src/logo.png'] })
  t.assert.deepEqual(Object.keys(decode(join(tmp, 'dist/code.br')).modules.get('.').files).toSorted(), ['src/a.js', 'src/b.cjs'])
  t.assert.deepEqual(Object.keys(decode(join(tmp, 'dist/res.br')).modules.get('.').files).toSorted(), ['src/icon.svg', 'src/logo.png'])
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

// --- addCommand: config + classification errors -----------------------------

test('addCommand requires a stasis.config.json', withTmp(async (t, tmp) => {
  seed(tmp, null) // no config
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/a.js'] }), /requires a stasis\.config\.json/)
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

test('addCommand requires resourcesBundleFile to add a resource, bundleFile to add source', withTmp(async (t, tmp) => {
  seed(tmp, { bundleFile: 'dist/code.br', resources: ['svg'] }) // no resourcesBundleFile
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/icon.svg'] }), /must set "resourcesBundleFile"/)

  seed(tmp, { resourcesBundleFile: 'dist/res.br', resources: ['svg'] }) // no bundleFile
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/a.js'] }), /must set "bundleFile"/)
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
