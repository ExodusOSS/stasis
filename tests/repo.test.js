import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { detectRepo, gitOriginUrl, parseGithubRepository } from '@exodus/stasis-core/bundle-util'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-repo-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const writeGitConfig = (dir, text) => {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), text)
}

const ORIGIN = (url) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`

test('parseGithubRepository accepts package.json repository spellings of a GitHub repo', (t) => {
  for (const url of [
    'https://github.com/ExodusOSS/stasis',
    'https://github.com/ExodusOSS/stasis.git',
    'git+https://github.com/ExodusOSS/stasis.git',
    'git+ssh://git@github.com/ExodusOSS/stasis.git',
    'git@github.com:ExodusOSS/stasis.git',
    'https://user:token@github.com/ExodusOSS/stasis',
    'github:ExodusOSS/stasis',
    'ExodusOSS/stasis',
  ]) {
    t.assert.equal(parseGithubRepository(url), 'ExodusOSS/stasis', url)
  }
  for (const url of [
    'https://gitlab.com/a/b', 'gitlab:a/b', 'bitbucket:a/b', 'https://github.com/a/b/tree/main',
    '../b', '', undefined, null, 42,
  ]) {
    t.assert.equal(parseGithubRepository(url), null, String(url))
  }
})

test('gitOriginUrl reads only the origin remote in the shape git writes it', (t) => {
  t.assert.equal(gitOriginUrl(ORIGIN('git@github.com:a/b.git')), 'git@github.com:a/b.git')
  t.assert.equal(gitOriginUrl('[remote "upstream"]\n\turl = git@github.com:a/b.git\n'), null)
  t.assert.equal(gitOriginUrl('[core]\n\tbare = false\n'), null)
  t.assert.equal(gitOriginUrl('[remote "origin"]\n\turl = https://github.com/a/b'), 'https://github.com/a/b')
})

test('detectRepo reads package.json repository, combining its directory with a subdir', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { name: 'root', repository: { type: 'git', url: 'git+https://github.com/o/n.git' } })
  mkdirSync(join(tmp, 'packages', 'a', 'src'), { recursive: true })
  writeJson(join(tmp, 'packages', 'a', 'package.json'), {
    name: 'a', repository: { type: 'git', url: 'https://github.com/o/n', directory: 'packages/a' },
  })
  mkdirSync(join(tmp, 'packages', 'b'), { recursive: true })
  writeJson(join(tmp, 'packages', 'b', 'package.json'), { name: 'b' })

  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: '' }, 'repo root: empty directory')
  t.assert.deepEqual(detectRepo(join(tmp, 'packages', 'a')), { github: 'o/n', directory: 'packages/a' })
  t.assert.deepEqual(detectRepo(join(tmp, 'packages', 'a', 'src')), { github: 'o/n', directory: 'packages/a/src' },
    'a subdir below the declaring package.json is combined with repository.directory')
  t.assert.deepEqual(detectRepo(join(tmp, 'packages', 'b')), { github: 'o/n', directory: 'packages/b' },
    'a package.json without repository defers to the nearest one above')
}))

test('detectRepo normalizes repository.directory and accepts the string shorthand', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory: './pkg/' } })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: 'pkg' })
  writeJson(join(tmp, 'package.json'), { repository: 'o/n' })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: '' })
}))

test('detectRepo treats a non-GitHub package.json repository as authoritative', withTmp((t, tmp) => {
  writeGitConfig(tmp, ORIGIN('git@github.com:o/n.git'))
  writeJson(join(tmp, 'package.json'), { repository: 'https://gitlab.com/o/n' })
  t.assert.equal(detectRepo(tmp), undefined)
}))

test('detectRepo falls back to the .git/config origin remote', withTmp((t, tmp) => {
  writeGitConfig(tmp, ORIGIN('git@github.com:o/n.git'))
  mkdirSync(join(tmp, 'sub', 'dir'), { recursive: true })
  writeJson(join(tmp, 'sub', 'package.json'), { name: 'sub' })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: '' })
  t.assert.deepEqual(detectRepo(join(tmp, 'sub', 'dir')), { github: 'o/n', directory: 'sub/dir' })

  writeGitConfig(tmp, '[remote "upstream"]\n\turl = git@github.com:o/n.git\n')
  t.assert.equal(detectRepo(tmp), undefined, 'only origin is consulted')
  writeGitConfig(tmp, ORIGIN('https://gitlab.com/o/n'))
  t.assert.equal(detectRepo(tmp), undefined, 'a non-GitHub origin yields nothing')
}))

test('detectRepo stops at the work tree root', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { repository: 'outer/repo' })
  const inner = join(tmp, 'inner')
  mkdirSync(join(inner, '.git'), { recursive: true }) // no config: nothing to read
  t.assert.equal(detectRepo(inner), undefined)
}))

test('Bundle carries repo through serialize/parse, withReason, withRepo and merge', (t) => {
  const repo = { github: 'o/n', directory: 'pkg' }
  const base = new Bundle({ config: { scope: 'node_modules' } })
  t.assert.equal(JSON.parse(base.serialize()).repo, undefined, 'omitted when unknown')

  const stamped = base.withRepo(repo)
  const json = JSON.parse(stamped.serialize())
  t.assert.deepEqual(json.repo, repo)
  t.assert.deepEqual(Object.keys(json).slice(0, 3), ['version', 'config', 'repo'])
  t.assert.deepEqual(Bundle.parse(stamped.serialize()).repo, repo)
  t.assert.deepEqual(stamped.withReason('bundle').repo, repo)
  t.assert.equal(stamped.withRepo(undefined), stamped, 'withRepo(undefined) keeps the current repo')

  const other = { github: 'o/other', directory: '' }
  t.assert.deepEqual(stamped.merge(base).repo, repo, 'merge keeps the existing repo when the incoming has none')
  t.assert.deepEqual(stamped.merge(base.withRepo(other)).repo, other, 'the incoming repo wins')

  // Informational: a malformed repo block is dropped, never fatal.
  const bad = JSON.stringify({ ...JSON.parse(base.serialize()), repo: { github: 1 } })
  t.assert.equal(Bundle.parse(bad).repo, undefined)
})

test('State records repo in the bundle but not in the lockfile', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0', repository: { url: 'https://github.com/o/n', directory: 'app' } })
  writeFileSync(join(tmp, 'index.js'), 'export {}\n')
  const state = new State(tmp, { bundle: 'replace', lock: 'replace', scope: 'full' })
  t.assert.deepEqual(JSON.parse(state.sourceData).repo, { github: 'o/n', directory: 'app' })
  t.assert.equal(JSON.parse(state.lockData).repo, undefined)
}))

test('stasis bundle records repo, combining a subdir cwd with repository.directory', withTmp(async (t, tmp) => {
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0', repository: { url: 'https://github.com/o/n', directory: 'app' } })
  const sub = join(tmp, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'main.sh'), '#!/bin/sh\necho hi\n')
  await bundleCommand({ cwd: sub, entries: ['main.sh'], output: 'out.br', lockfile: undefined })
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(join(sub, 'out.br'))).toString('utf8'))
  t.assert.deepEqual(bundle.repo, { github: 'o/n', directory: 'app/sub' })
}))
