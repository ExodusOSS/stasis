// resolvePluginState + write-path collision behavior when NO preload is active in the
// process. Kept in its own file so the preload registry stays empty -- once a preload is
// constructed in a process it can't be cleared.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePluginState } from '@exodus/stasis-core/plugins'
import { State } from '@exodus/stasis-core/state'

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-no-preload-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
  return dir
}

test('rule 1: lockfile mode without preload is a hard throw', (t) => {
  const dir = fixture()
  try {
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'add' }, dir),
      /lockfile mode 'add' requires a stasis preload/
    )
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'frozen' }, dir),
      /lockfile mode 'frozen' requires a stasis preload/
    )
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'replace' }, dir),
      /lockfile mode 'replace' requires a stasis preload/
    )
    t.assert.throws(
      () => resolvePluginState('Test', {}, dir),
      /the default lockfile mode \('add'\) requires a stasis preload/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rule 7: lock=none + bundle=none returns noop', (t) => {
  const dir = fixture()
  try {
    const r = resolvePluginState('Test', { lock: 'none', bundle: 'none' }, dir)
    t.assert.equal(r.isNoop, true)
    t.assert.equal(r.state, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rule 7 partial opt-out: { lock: "none" } alone (bundle implicit) is a preload-aware throw, not a Config error', (t) => {
  const dir = fixture()
  try {
    // Previously this fell through to Config's generic
    // `stasis needs a lockfile or a bundle` RangeError, with no signal that the
    // user's intent (opt out) was almost-but-not-quite satisfied. The plugin
    // resolver now catches the partial case explicitly.
    t.assert.throws(
      () => resolvePluginState('Test', { lock: 'none' }, dir),
      /to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none'/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rule 7 partial opt-out: { bundle: "none" } alone (lock implicit) is a preload-aware throw, not a Rule 1 throw', (t) => {
  const dir = fixture()
  try {
    // Without this catch, lock defaults to 'add' and Rule 1 throws about the
    // default lockfile mode -- which is technically true but misleading when
    // the user actually wanted to opt out via bundle='none'.
    t.assert.throws(
      () => resolvePluginState('Test', { bundle: 'none' }, dir),
      /to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none'/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lock=none paired with an active bundle mode is NOT a partial opt-out (bundle-as-trust-root)', (t) => {
  // Config explicitly supports lock='none' + bundle=('load' | 'frozen' | 'add'):
  // the bundle is the trust root, no sibling lockfile required. The partial-
  // opt-out catch must NOT misclaim this as "you wanted to opt out" -- the
  // call must fall through to constructing a standalone State.
  const dir = fixture()
  try {
    for (const bundle of ['load', 'frozen', 'add', 'replace']) {
      // We don't care whether the State construction itself succeeds (it may
      // throw later for missing bundleFile or whatever); we only care that the
      // resolver doesn't intercept with the partial-opt-out message.
      const callable = () => resolvePluginState('Test', { lock: 'none', bundle }, dir)
      try { callable() } catch (err) {
        t.assert.doesNotMatch(err.message, /to opt out/,
          `lock=none + bundle=${bundle} must not be treated as a partial opt-out`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two write-mode States collide on the same write path even with NO preload', (t) => {
  // Collision detection is driven by the process-wide State registry, not by a preload:
  // two write-intent States targeting the same explicit bundle path conflict even though
  // neither is a preload (and none exists). This is the cross-State guard working without
  // the old preload dependency -- and, via the globalThis registry, across stasis-core
  // copies too.
  const dir = fixture()
  try {
    const bundleFile = join(dir, 'shared.br')
    const first = new State(dir, { lock: 'ignore', bundle: 'add', bundleFile })
    t.assert.ok(first, 'first writer constructs')
    t.assert.equal(State.preload, undefined, 'no preload is involved')
    t.assert.throws(
      () => new State(dir, { lock: 'ignore', bundle: 'add', bundleFile }),
      /already claimed/
    )
    // A distinct path is fine.
    t.assert.doesNotThrow(() => new State(dir, { lock: 'ignore', bundle: 'add', bundleFile: join(dir, 'other.br') }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
