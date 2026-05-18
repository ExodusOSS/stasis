import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { State } from '../src/state.js'
import { Lockfile } from '../src/lockfile.js'

// Cross-scope load: lockfile carries scope=full (with `entries` + `sources`),
// State runs as scope=node_modules. Only node_modules entries should populate
// state.modules; `entries` and source dirs from the lockfile are discarded.
// Lockfile.parse still validates the full lockfile contents (including the
// source dirs) -- that's what the malformed-source-dir test below pins.

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-load-mixed-scope')
const state = new State(root)

test('state runs node_modules scope, lockfile parses as full', (t) => {
  t.assert.equal(state.config.scope, 'node_modules')
  t.assert.equal(state.config.full, false)
})

test('only node_modules dirs populate state.modules; source dirs are discarded', (t) => {
  t.assert.ok(state.modules.has('node_modules/widget'))
  t.assert.ok(!state.modules.has('.'), 'source dir from lockfile must not leak when state is nm-scope')
  t.assert.equal(state.modules.size, 1)
})

test('lockfile `entries` is not loaded when state is node_modules scope', (t) => {
  t.assert.equal(state.entries.size, 0)
})

test('hashes index only node_modules files, not source-dir files', (t) => {
  t.assert.equal(state.hashes.get('node_modules/widget/index.js'), 'sha512-mod-bbb')
  t.assert.equal(state.hashes.has('src/entry.js'), false)
})

test('Lockfile.parse validates source-dir paths even when caller will discard them', (t) => {
  // The refactor lifted these checks into Lockfile.parse unconditionally; before
  // the extraction they were gated on State's own scope and the malformed source
  // dir would have been silently skipped under nm-scope state.
  const malformed = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: [],
    sources: { '../escape': { name: 'x', version: '0', files: { 'a.js': 'sha512-x' } } },
    modules: {},
  })
  t.assert.throws(() => Lockfile.parse(malformed))
})

test('Lockfile.parse validates per-file paths in source dirs', (t) => {
  const malformed = JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'x', version: '0', files: { '../escape.js': 'sha512-x' } } },
    modules: {},
  })
  t.assert.throws(() => Lockfile.parse(malformed))
})
