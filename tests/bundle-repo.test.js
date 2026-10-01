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
  t.assert.deepEqual(Bundle.parse(withRepoJSON({ github: 'o/n', root: true, commit: SHA256 })).repo,
    { github: 'o/n', root: true, commit: SHA256 })
})

test('Bundle accepts URL-safe repo directories', (t) => {
  for (const directory of ['a', 'packages/@scope/pkg-1.0_x', 'a/b~c/d+e', '.github/workflows', '..a/b..', 'x'.repeat(1024)]) {
    t.assert.equal(Bundle.parse(withRepoJSON({ directory })).repo.directory, directory)
  }
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
    { github: `${'a-'.repeat(20)}a/n` },
    { github: `o/${'n'.repeat(101)}` },
    { github: 'o/.' },
    { github: 'o/..' },
    { github: 'o/n m' },
    { github: 42 },
    { directory: 42 },
    { directory: '/abs' },
    { directory: '../up' },
    { directory: 'a/../../up' },
    { directory: '..\\outside' },
    { directory: 'a\\b' },
    { directory: 'C:\\x' },
    { directory: 'C:/x' },
    { directory: 'c:' },
    { directory: '\\\\server\\share' },
    { directory: 'with space' },
    { directory: '' },
    { root: false },
    { root: 'yes' },
    { directory: 'a', root: true },
    { directory: 'a%2Fb' },
    { directory: 'a#b' },
    { directory: 'a?b' },
    { directory: 'a:b' },
    { directory: 'é' },
    { directory: 'x'.repeat(1025) },
    { directory: '.' },
    { directory: './a' },
    { directory: 'a//b' },
    { directory: 'a/' },
    { directory: 'a/../b' },
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

test('Bundle carries repo through withReason, and merge keeps only agreeing fields', (t) => {
  const full = { github: 'o/n', directory: 'x', commit: SHA1 }
  const stamped = base(full)
  t.assert.deepEqual({ ...stamped.withReason('bundle').repo }, full)
  t.assert.deepEqual({ ...stamped.merge(base(full)).repo }, full, 'agreeing: kept as is')
  t.assert.deepEqual({ ...stamped.merge(base({ ...full, commit: SHA256 })).repo }, { github: 'o/n', directory: 'x' },
    'same repo and dir, another commit: only the commit is dropped')
  t.assert.deepEqual({ ...stamped.merge(base({ ...full, directory: 'y' })).repo }, { github: 'o/n', commit: SHA1 },
    'another dir: only the directory is dropped')
  t.assert.deepEqual({ ...stamped.merge(base({ github: 'o/n' })).repo }, { github: 'o/n' }, 'a field one side lacks is dropped')
  t.assert.equal(stamped.merge(base({ ...full, github: 'o/other' })).repo, undefined, 'another repo: reset')
  const atRoot = { github: 'o/n', root: true, commit: SHA1 }
  t.assert.deepEqual({ ...base(atRoot).merge(base(atRoot)).repo }, atRoot, 'root agreeing: kept')
  t.assert.deepEqual({ ...base(atRoot).merge(base(full)).repo }, { github: 'o/n', commit: SHA1 },
    'root vs a directory: both dropped, like disagreeing directories')
  t.assert.equal(stamped.merge(base()).repo, undefined, 'added from an undetected place: reset')
  t.assert.equal(base().merge(stamped).repo, undefined, 'added into a bundle without repo: reset, never overwritten')
  t.assert.deepEqual({ ...stamped.merge(base({ ...full, github: 'O/N' })).repo }, full,
    'GitHub names are case-insensitive: the existing spelling is kept')
  t.assert.equal(base({}).repo, undefined, 'an empty block is no block')
  t.assert.equal(JSON.parse(base({}).serialize()).repo, undefined)
})

test('repo never reaches a lockfile', (t) => {
  const lock = new Lockfile({ config: { scope: 'node_modules' } })
  t.assert.equal(JSON.parse(lock.serialize()).repo, undefined)
})

test('Bundle validates a directly assigned repo', (t) => {
  const bundle = base()
  t.assert.throws(() => { bundle.repo = { github: 'o/n', directory: 'with space' } }, /invalid bundle repo\.directory/u)
  t.assert.throws(() => { bundle.repo = { github: 42 } }, /invalid bundle repo\.github/u)
  t.assert.equal(bundle.repo, undefined, 'a rejected value is not stored')
  bundle.repo = { commit: SHA1, github: 'o/n', directory: 'ok' }
  t.assert.deepEqual(Object.keys(bundle.repo), ['github', 'directory', 'commit'], 'normalized on assignment')
  t.assert.deepEqual(JSON.parse(bundle.serialize()).repo, { github: 'o/n', directory: 'ok', commit: SHA1 })
  bundle.repo = {}
  t.assert.equal(bundle.repo, undefined)
})
