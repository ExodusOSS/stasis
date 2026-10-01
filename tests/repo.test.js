import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { addCommand } from '@exodus/stasis-core/add'
import { detectRepo, githubHomepageDirectory, gitOriginUrl, parseGithubRepository } from '@exodus/stasis-core/bundle-util'
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

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA2 = 'fedcba9876543210fedcba9876543210fedcba98'
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

  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', root: true }, 'repo root: root: true')
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
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', root: true })
}))

test('detectRepo treats a non-GitHub package.json repository as authoritative', withTmp((t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  writeJson(join(tmp, 'package.json'), { repository: 'https://gitlab.com/o/n' })
  t.assert.equal(detectRepo(tmp), undefined)
}))

test('detectRepo prefers git over package.json, and only git yields commit', withTmp((t, tmp) => {
  writeGitConfig(tmp, ORIGIN('git@github.com:o/git.git'))
  writeFileSync(join(tmp, '.git', 'HEAD'), `${SHA}\n`)
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/pkg', directory: 'elsewhere' } })
  mkdirSync(join(tmp, 'sub', 'dir'), { recursive: true })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/git', root: true, commit: SHA })
  t.assert.deepEqual(detectRepo(join(tmp, 'sub', 'dir')), { github: 'o/git', directory: 'sub/dir', commit: SHA })

  writeGitConfig(tmp, '[remote "upstream"]\n\turl = git@github.com:o/git.git\n')
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/pkg', directory: 'elsewhere' },
    'only origin is consulted; without it, package.json is used (no commit)')
  writeGitConfig(tmp, ORIGIN('https://gitlab.com/o/n'))
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/pkg', directory: 'elsewhere' }, 'a non-GitHub origin falls back too')
}))

test('detectRepo reads the commit from a branch ref, loose or packed', withTmp((t, tmp) => {
  writeGitConfig(tmp, ORIGIN('https://github.com/o/n'))
  const git = join(tmp, '.git')
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', root: true }, 'an unborn branch has no commit')

  writeFileSync(join(git, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${SHA2} refs/heads/main\n`)
  t.assert.equal(detectRepo(tmp).commit, SHA2, 'packed-refs')
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(git, 'refs', 'heads', 'main'), `${SHA}\n`)
  t.assert.equal(detectRepo(tmp).commit, SHA, 'a loose ref wins over packed-refs')

  writeFileSync(join(git, 'refs', 'heads', 'main'), 'not-a-sha\n')
  t.assert.equal(detectRepo(tmp).commit, undefined, 'an invalid sha is left out')
  writeFileSync(join(git, 'HEAD'), 'ref: ../../escape\n')
  t.assert.equal(detectRepo(tmp).commit, undefined, 'a ref outside refs/ is not followed')
}))

test('detectRepo stops at the work tree root', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { repository: 'outer/repo' })
  const inner = join(tmp, 'inner')
  mkdirSync(join(inner, '.git'), { recursive: true }) // no config: nothing to read
  t.assert.equal(detectRepo(inner), undefined)
}))

test('detectRepo leaves out values the bundle format would reject', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { repository: 'https://github.com/bad_owner/n' })
  t.assert.equal(detectRepo(tmp), undefined, 'an owner GitHub would not allow')
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory: '../outside' } })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n' }, 'a directory escaping the repo is dropped')
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory: '/abs' } })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: 'abs' }, 'a leading slash is stripped')
}))

test('stasis add records the detected repo', withTmp(async (t, tmp) => {
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0', repository: 'github:o/n' })
  writeJson(join(tmp, 'stasis.config.json'), {})
  writeFileSync(join(tmp, 'index.js'), 'export {}\n')
  addCommand({ cwd: tmp, entries: ['index.js'] })
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, 'stasis.code.br'))).toString('utf8'))
  t.assert.deepEqual({ ...bundle.repo }, { github: 'o/n', root: true })
}))

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

test('stasis bundle of JS from a workspace subdir records the State root, which its paths are relative to', withTmp(async (t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  writeJson(join(tmp, 'package.json'), { name: 'root', private: true, repository: 'https://github.com/o/n' })
  const a = join(tmp, 'packages', 'a')
  mkdirSync(a, { recursive: true })
  writeJson(join(a, 'package.json'), { name: 'a', version: '1.0.0', type: 'module' })
  writeFileSync(join(a, 'index.js'), 'export {}\n')
  await bundleCommand({ cwd: a, entries: ['index.js'], output: 'out.br', lockfile: undefined })
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(join(a, 'out.br'))).toString('utf8'))
  t.assert.deepEqual(bundle.entries, ['packages/a/index.js'])
  t.assert.deepEqual(bundle.repo, { github: 'o/n', root: true })
}))

test('githubHomepageDirectory reads the dir of a GitHub tree homepage for the same repo', (t) => {
  t.assert.equal(githubHomepageDirectory('https://github.com/a/g/tree/master/c/d', 'a/g'), 'c/d')
  t.assert.equal(githubHomepageDirectory('https://github.com/A/G/tree/main/c/d/#readme', 'a/g'), 'c/d/')
  t.assert.equal(githubHomepageDirectory('https://github.com/a/g/tree/main/with%20space', 'a/g'), 'with space')
  t.assert.equal(githubHomepageDirectory('https://github.com/a/g/tree/main/c', 'a/other'), undefined, 'another repo')
  t.assert.equal(githubHomepageDirectory('https://github.com/a/g#readme', 'a/g'), undefined, 'the repo root')
  t.assert.equal(githubHomepageDirectory('https://example.com/a/g/tree/main/c', 'a/g'), undefined)
  t.assert.equal(githubHomepageDirectory(undefined, 'a/g'), undefined)
})

test('detectRepo takes directory from homepage when repository.directory is unset', withTmp((t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  const pkg = join(tmp, 'c', 'd')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  writeJson(join(pkg, 'package.json'), {
    repository: 'git+https://github.com/a/g.git', homepage: 'https://github.com/a/g/tree/master/c/d#readme',
  })
  t.assert.deepEqual(detectRepo(pkg), { github: 'a/g', directory: 'c/d' })
  t.assert.deepEqual(detectRepo(join(pkg, 'src')), { github: 'a/g', directory: 'c/d/src' })

  writeJson(join(pkg, 'package.json'), {
    repository: { url: 'github:a/g', directory: 'explicit' }, homepage: 'https://github.com/a/g/tree/master/c/d',
  })
  t.assert.deepEqual(detectRepo(pkg), { github: 'a/g', directory: 'explicit' }, 'repository.directory wins')
  writeJson(join(pkg, 'package.json'), { repository: 'a/g', homepage: 'https://github.com/x/y/tree/master/c/d' })
  t.assert.deepEqual(detectRepo(pkg), { github: 'a/g', root: true }, 'a homepage for another repo is ignored')
}))

test('detectRepo follows a linked worktree `.git` file to its git and common dirs', withTmp((t, tmp) => {
  const main = join(tmp, 'main')
  writeGitConfig(main, ORIGIN('git@github.com:o/n.git'))
  const wtGit = join(main, '.git', 'worktrees', 'wt')
  mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(wtGit, { recursive: true })
  writeFileSync(join(main, '.git', 'refs', 'heads', 'feature'), `${SHA}\n`)
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n')
  writeFileSync(join(wtGit, 'commondir'), '../..\n')
  const wt = join(tmp, 'wt')
  mkdirSync(join(wt, 'sub'), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
  t.assert.deepEqual(detectRepo(join(wt, 'sub')), { github: 'o/n', directory: 'sub', commit: SHA })
}))

test('stasis bundle of JS does not fall back to a cwd repo below the State root', withTmp(async (t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  writeJson(join(tmp, 'package.json'), { name: 'root', private: true })
  const a = join(tmp, 'packages', 'a')
  mkdirSync(a, { recursive: true })
  writeJson(join(a, 'package.json'), { name: 'a', version: '1.0.0', type: 'module', repository: { url: 'github:o/n', directory: 'packages/a' } })
  writeFileSync(join(a, 'index.js'), 'export {}\n')
  await bundleCommand({ cwd: a, entries: ['index.js'], output: 'out.br', lockfile: undefined })
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(join(a, 'out.br'))).toString('utf8'))
  t.assert.deepEqual(bundle.entries, ['packages/a/index.js'])
  t.assert.equal(bundle.repo, undefined)
}))

test('State adding to a bundle keeps only repo fields that agree with detection', withTmp((t, tmp) => {
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0' })
  const writeExisting = (repo) =>
    writeFileSync(join(tmp, 'stasis.code.br'), brotliCompressSync(new Bundle({ config: { scope: 'full' }, repo }).serialize()))
  const written = () => JSON.parse(new State(tmp, { bundle: 'add', lock: 'replace', scope: 'full' }).sourceData).repo
  const recorded = { github: 'o/n', root: true, commit: SHA }

  mkdirSync(join(tmp, '.git')) // a work tree with no GitHub origin: nothing detected
  writeExisting(recorded)
  t.assert.equal(written(), undefined, 'undetected place: reset')

  writeGitConfig(tmp, ORIGIN('git@github.com:o/n.git'))
  writeFileSync(join(tmp, '.git', 'HEAD'), `${SHA}\n`)
  writeExisting(recorded)
  t.assert.deepEqual(written(), recorded, 'agreeing: kept')
  writeFileSync(join(tmp, '.git', 'HEAD'), `${SHA2}\n`)
  t.assert.deepEqual(written(), { github: 'o/n', root: true }, 'another commit: only the commit is dropped')
  writeGitConfig(tmp, ORIGIN('git@github.com:o/other.git'))
  t.assert.equal(written(), undefined, 'another repo: reset, not overwritten')
  writeExisting(undefined)
  t.assert.equal(written(), undefined, 'adding to a bundle without repo: not overwritten')

  rmSync(join(tmp, 'stasis.code.br'))
  t.assert.deepEqual(written(), { github: 'o/other', root: true, commit: SHA2 }, 'a fresh bundle records the detected repo')
}))

test('detectRepo turns a Windows-style repository.directory into a POSIX path', withTmp((t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory: 'packages\\a' } })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n', directory: 'packages/a' })
  writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory: '..\\outside' } })
  t.assert.deepEqual(detectRepo(tmp), { github: 'o/n' }, 'an escaping one is dropped')
}))

test('both halves of a split bundle record the repo', withTmp(async (t, tmp) => {
  writeGitConfig(tmp, ORIGIN('git@github.com:o/n.git'))
  writeFileSync(join(tmp, '.git', 'HEAD'), `${SHA}\n`)
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0' })
  writeJson(join(tmp, 'stasis.config.json'), { bundleFile: 'code.br', resourcesBundleFile: 'res.br', resources: ['txt'] })
  writeFileSync(join(tmp, 'index.js'), 'export {}\n')
  writeFileSync(join(tmp, 'notes.txt'), 'hi\n')
  const repo = { github: 'o/n', root: true, commit: SHA }
  const read = (file) => Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, file))).toString('utf8'))

  addCommand({ cwd: tmp, entries: ['index.js', 'notes.txt'] })
  t.assert.deepEqual({ ...read('code.br').repo }, repo, 'stasis add: code half')
  t.assert.deepEqual({ ...read('res.br').repo }, repo, 'stasis add: resources half')

  const state = new State(tmp, { bundle: 'replace', lock: 'replace', scope: 'full' })
  t.assert.deepEqual({ ...state.codeBundle.repo }, repo, 'State: code half')
  t.assert.deepEqual({ ...state.resourcesBundle.repo }, repo, 'State: resources half')
}))

test('detectRepo strips ./ and trailing slashes from repository.directory', withTmp((t, tmp) => {
  mkdirSync(join(tmp, '.git'))
  mkdirSync(join(tmp, 'sub'))
  const dirOf = (directory, at = tmp) => {
    writeJson(join(tmp, 'package.json'), { repository: { url: 'github:o/n', directory } })
    return detectRepo(at)
  }
  for (const directory of ['./', '.', '', '/', 'a/../', './a/../', './/']) {
    t.assert.deepEqual(dirOf(directory), { github: 'o/n', root: true }, JSON.stringify(directory))
  }
  t.assert.deepEqual(dirOf('./packages/a/'), { github: 'o/n', directory: 'packages/a' })
  t.assert.deepEqual(dirOf('packages//a///'), { github: 'o/n', directory: 'packages/a' })
  t.assert.deepEqual(dirOf('./', join(tmp, 'sub')), { github: 'o/n', directory: 'sub' })
}))

test('State adding to a split bundle merges each half with its own repo', withTmp((t, tmp) => {
  writeGitConfig(tmp, ORIGIN('git@github.com:o/n.git'))
  writeFileSync(join(tmp, '.git', 'HEAD'), `${SHA2}\n`)
  writeJson(join(tmp, 'package.json'), { name: 'app', version: '1.0.0' })
  writeJson(join(tmp, 'stasis.config.json'), { bundleFile: join(tmp, 'add-code.br'), resourcesBundleFile: join(tmp, 'add-res.br'), resources: ['txt'] })
  const write = (file, repo) =>
    writeFileSync(join(tmp, file), brotliCompressSync(new Bundle({ config: { scope: 'full' }, repo }).serialize()))
  write('add-code.br', { github: 'o/n', root: true, commit: SHA }) // code from commit SHA
  write('add-res.br', undefined) // resources from an undetected place
  const state = new State(tmp, { bundle: 'add', lock: 'replace', scope: 'full' })
  t.assert.deepEqual({ ...state.codeBundle.repo }, { github: 'o/n', root: true }, 'code: another commit drops just the commit')
  t.assert.equal(state.resourcesBundle.repo, undefined, 'resources: its own (absent) repo is not overwritten')
}))
