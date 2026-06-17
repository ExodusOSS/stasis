import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'

// Explicit `lockFile` config: when set, State reads + writes the lockfile at that
// exact path instead of the default `<root>/stasis.lock.json`. Used by plugins to
// run with a lockfile fully separate from any ambient preload's.

const withTmp = (label, fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), `stasis-lock-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  return fn(t, dir)
}

test('write emits the lockfile at config.lockFile', withTmp('write', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  const lockPath = join(dir, 'sub', 'plugin.lock.json')

  const st = new State(dir, { lock: 'add', lockFile: lockPath, bundle: 'none' })
  st.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  st.write()

  t.assert.ok(existsSync(lockPath), 'lockfile written at the explicit path')
  t.assert.ok(!existsSync(join(dir, 'stasis.lock.json')), 'no default-path lockfile')
  const data = JSON.parse(readFileSync(lockPath, 'utf-8'))
  t.assert.equal(data.sources?.['.']?.name, 'fx', 'lockfile carries the workspace bucket')
}))

test('load reads the lockfile from config.lockFile, ignoring the default path', withTmp('load', (t, dir) => {
  writeFileSync(join(dir, 'entry.js'), 'export const a = 1\n')
  const lockPath = join(dir, 'sub', 'plugin.lock.json')

  // Capture phase writes to lockPath.
  const cap = new State(dir, { lock: 'add', lockFile: lockPath, bundle: 'none' })
  cap.addFile(pathToFileURL(join(dir, 'entry.js')).toString(), { format: 'module', isEntry: true })
  cap.write()

  // Plant a stale stasis.lock.json at the default path with bogus content. The explicit
  // lockFile must take precedence -- the default-path file is ignored.
  writeFileSync(join(dir, 'stasis.lock.json'), JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['bogus.js'],
    sources: { '.': { name: 'fx', version: '0.0.0', files: { 'bogus.js': 'sha512-AAAA' } } },
    modules: {},
    formats: { 'bogus.js': 'module' },
    imports: {},
  }))

  const st = new State(dir, { lock: 'frozen', lockFile: lockPath, bundle: 'none' })
  t.assert.ok(st.hashes.has('entry.js'), 'real lockfile loaded from explicit path')
  t.assert.ok(!st.hashes.has('bogus.js'), 'stale default-path lockfile was not consulted')
}))

test('frozen mode against an absent explicit lockFile fails closed', withTmp('frozen-absent', (t, dir) => {
  const lockPath = join(dir, 'never-written.lock.json')
  // The default stasis.lock.json is also absent. Frozen mode must refuse to run.
  t.assert.throws(() => new State(dir, { lock: 'frozen', lockFile: lockPath, bundle: 'none' }),
    /No lockfile, but attempting to run in frozen mode/)
}))

test('lock=none with lockFile is rejected at Config construction', withTmp('lock-none', (t, dir) => {
  t.assert.throws(() => new State(dir, { lock: 'none', bundle: 'load', bundleFile: join(dir, 'b.br'), lockFile: join(dir, 'x.lock.json') }),
    /lockFile requires an active lock mode/)
}))

test('an unrelated stasis.lock.json at the root does not gate root-detection when lockFile is set', withTmp('no-root-snap', (t, dir) => {
  // Make stasis.lock.json present at the dir but config.lockFile points elsewhere.
  // The presence of the default file used to mark this dir as the root (loaded=true) and
  // process it; with lockFile, root-detection should ignore it -- our test asserts that
  // the explicit-path file's content is loaded, not the default one.
  writeFileSync(join(dir, 'stasis.lock.json'), JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['ghost.js'],
    sources: { '.': { name: 'fx', version: '0.0.0', files: { 'ghost.js': 'sha512-BBBB' } } },
    modules: {},
    formats: { 'ghost.js': 'module' },
    imports: {},
  }))
  const lockPath = join(dir, 'real.lock.json')
  writeFileSync(lockPath, JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: ['real.js'],
    sources: { '.': { name: 'fx', version: '0.0.0', files: { 'real.js': 'sha512-CCCC' } } },
    modules: {},
    formats: { 'real.js': 'module' },
    imports: {},
  }))

  const st = new State(dir, { lock: 'frozen', lockFile: lockPath, bundle: 'none' })
  t.assert.ok(st.hashes.has('real.js'))
  t.assert.ok(!st.hashes.has('ghost.js'))
}))
