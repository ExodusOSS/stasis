import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

const SHA1 = 'a'.repeat(40)
const SHA256 = '0123456789abcdef'.repeat(4)
const base = (repo) => new Bundle({ config: { scope: 'node_modules' }, repo })
const withRepoJSON = (repo) => JSON.stringify({ ...JSON.parse(base().serialize()), repo })

test('Bundle omits repo when unset', (t) => {
  t.assert.equal(base().repo, undefined)
  t.assert.equal(JSON.parse(base().serialize()).repo, undefined)
})

test('Bundle round-trips repo right after config, in canonical key order', (t) => {
  const repo = { commit: SHA1, directory: 'packages/app', github: 'ExodusOSS/stasis' }
  const json = JSON.parse(base(repo).serialize())
  t.assert.deepEqual(Object.keys(json).slice(0, 3), ['version', 'config', 'repo'])
  t.assert.deepEqual(Object.keys(json.repo), ['github', 'directory', 'commit'])
  t.assert.deepEqual(Bundle.parse(JSON.stringify(json)).repo, { github: 'ExodusOSS/stasis', directory: 'packages/app', commit: SHA1 })
  t.assert.deepEqual(Bundle.parse(withRepoJSON({ github: 'o/n', directory: '', commit: SHA256 })).repo,
    { github: 'o/n', directory: '', commit: SHA256 })
})

test('Bundle repo fields are each optional', (t) => {
  for (const repo of [{ github: 'o/n' }, { directory: 'a/b' }, { commit: SHA1 }, { github: 'o/n', commit: SHA1 }]) {
    t.assert.deepEqual(Bundle.parse(withRepoJSON(repo)).repo, repo)
  }
})

test('Bundle accepts GitHub owner/name at the length limits', (t) => {
  const owner = 'a'.repeat(39)
  const name = 'n'.repeat(100)
  for (const github of [`${owner}/${name}`, 'a-b-c/x.y_z-1', 'A1/.github', 'o/..x']) {
    t.assert.equal(Bundle.parse(withRepoJSON({ github })).repo.github, github)
  }
})

test('Bundle rejects an invalid repo block on parse and on construction', (t) => {
  const bad = [
    'not-an-object',
    null,
    [],
    { github: 'o/n', branch: 'main' },
    { github: 'o' },
    { github: 'o/n/x' },
    { github: '/n' },
    { github: 'o/' },
    { github: '-o/n' },
    { github: 'o-/n' },
    { github: 'o--p/n' },
    { github: 'o_p/n' },
    { github: `${'a'.repeat(40)}/n` },
    { github: `o/${'n'.repeat(101)}` },
    { github: 'o/.' },
    { github: 'o/..' },
    { github: 'o/n m' },
    { github: 42 },
    { directory: 42 },
    { directory: '/abs' },
    { directory: '../up' },
    { directory: 'a/../../up' },
    { commit: 'A'.repeat(40) },
    { commit: 'a'.repeat(39) },
    { commit: 'a'.repeat(41) },
    { commit: 'g'.repeat(40) },
    { commit: 'abc1234' },
    { commit: 42 },
  ]
  for (const repo of bad) {
    t.assert.throws(() => Bundle.parse(withRepoJSON(repo)), undefined, `parse: ${JSON.stringify(repo)}`)
    t.assert.throws(() => base(repo), undefined, `constructor: ${JSON.stringify(repo)}`)
  }
})

test('Bundle carries repo through withReason, and merge prefers the incoming one', (t) => {
  const a = { github: 'o/a', directory: '' }
  const b = { github: 'o/b', directory: 'x', commit: SHA1 }
  const stamped = base(a)
  t.assert.deepEqual(stamped.withReason('bundle').repo, a)
  t.assert.deepEqual(stamped.merge(base()).repo, a, 'kept when the incoming bundle has none')
  t.assert.deepEqual(stamped.merge(base(b)).repo, b, 'the incoming bundle wins')
  t.assert.deepEqual(base().merge(stamped).repo, a)
})

test('repo never reaches a lockfile', (t) => {
  const lock = new Lockfile({ config: { scope: 'node_modules' } })
  t.assert.equal(JSON.parse(lock.serialize()).repo, undefined)
})
