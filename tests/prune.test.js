import { test } from 'node:test'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prune } from '../src/prune.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PRUNE_FIXTURE = join(fixtures, 'prune')
const EMPTY_FIXTURE = join(fixtures, 'prune-empty')

function stage(t, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'stasis-prune-'))
  cpSync(fixture, root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function withEnv(t, name, value) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  t.after(() => {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  })
}

test('keeps lockfile files, validates hashes, removes others, cleans empty dirs', (t) => {
  const root = stage(t, PRUNE_FIXTURE)

  const { validated, removed, kept } = prune({ root })

  // listed in the lockfile -> validated against the recorded hash
  t.assert.ok(validated.includes('node_modules/widget/index.js'))
  t.assert.ok(validated.includes('node_modules/widget/package.json'))
  t.assert.ok(validated.includes('node_modules/loose/index.js'))

  // package.json under a module dir that the lockfile lists, but not in
  // its `files` map -> kept unvalidated
  t.assert.ok(kept.includes('node_modules/loose/package.json'))
  t.assert.ok(!validated.includes('node_modules/loose/package.json'))

  // package.json under a module dir the lockfile does NOT list -> pruned
  t.assert.ok(removed.includes('node_modules/extra/package.json'))

  // untracked files everywhere -> pruned
  t.assert.ok(removed.includes('node_modules/widget/extra.js'))
  t.assert.ok(removed.includes('node_modules/extra/index.js'))
  t.assert.ok(removed.includes('node_modules/orphan/nested/file.txt'))

  t.assert.ok(existsSync(join(root, 'node_modules/widget/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/widget/package.json')))
  t.assert.ok(existsSync(join(root, 'node_modules/loose/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/loose/package.json')))
  t.assert.ok(!existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(!existsSync(join(root, 'node_modules/extra')))
  t.assert.ok(!existsSync(join(root, 'node_modules/orphan')))
})

test('throws when a tracked file has a wrong hash', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  writeFileSync(join(root, 'node_modules/widget/index.js'), 'export const x = 2\n')
  t.assert.throws(
    () => prune({ root }),
    /hash mismatch for 1 file\(s\):\n {2}node_modules\/widget\/index\.js: expected sha512-/u,
  )
})

test('does not touch the tree when validation fails', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  writeFileSync(join(root, 'node_modules/widget/index.js'), 'export const x = 2\n')
  t.assert.throws(() => prune({ root }))

  // Untracked files that would have been pruned must still exist.
  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/orphan/nested/file.txt')))
})

test('throws when a lockfile file is missing on disk', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  rmSync(join(root, 'node_modules/widget/index.js'))
  t.assert.throws(() => prune({ root }), /missing on disk/u)
})

test('does not touch the tree when a tracked file is missing on disk', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  rmSync(join(root, 'node_modules/widget/index.js'))
  t.assert.throws(() => prune({ root }))

  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/orphan/nested/file.txt')))
})

test('throws when stasis.lock.json is missing', (t) => {
  const root = stage(t, EMPTY_FIXTURE)
  t.assert.throws(() => prune({ root }), /stasis\.lock\.json not found/u)
})

test('throws when pnpm enableGlobalVirtualStore is enabled', (t) => {
  withEnv(t, 'npm_config_enable_global_virtual_store', 'true')
  const root = stage(t, PRUNE_FIXTURE)
  t.assert.throws(() => prune({ root }), /enableGlobalVirtualStore must be false/u)

  // Nothing on disk should have been touched.
  t.assert.ok(existsSync(join(root, 'node_modules/widget/extra.js')))
  t.assert.ok(existsSync(join(root, 'node_modules/extra/index.js')))
})

test('accepts pnpm enableGlobalVirtualStore explicitly set to false', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  withEnv(t, 'npm_config_enable_global_virtual_store', 'false')
  t.assert.doesNotThrow(() => prune({ root }))
})

test('accepts pnpm enableGlobalVirtualStore explicitly set to empty string', (t) => {
  const root = stage(t, PRUNE_FIXTURE)
  withEnv(t, 'npm_config_enable_global_virtual_store', '')
  t.assert.doesNotThrow(() => prune({ root }))
})
