import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

import { isValidRepoField } from './bundle.js'
import { posixPathEscapes } from './artifact-util.js'
import { assertRealPathWithinBase, hasNodeModulesSegment, toPosix } from './util.js'

export function packageType(file) {
  const pkg = findPackageJSON(pathToFileURL(file).toString())
  if (!pkg) return null
  try {
    const type = JSON.parse(readFileSync(pkg, 'utf8')).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Nearest package.json (walking up) that identifies a bucket; pkgDir is relative to baseDir ("."
// at the root). Inside node_modules both name and version are required; a workspace package
// outside node_modules may omit version (the name alone claims the bucket, matching
// State#locateModule). Null if none.
export function findPackageMetadata(baseDir, fileRelPath) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name && (pkg.version || !hasNodeModulesSegment(toPosix(dir)))) {
          // `?? undefined` folds a literal `"version": null` into the one absent-version spelling.
          return { pkgDir: dir, name: pkg.name, version: pkg.version ?? undefined }
        }
      } catch { /* malformed -- keep walking */ }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const abs = resolve(cwd, e)
    const rel = toPosix(relative(baseDir, abs))
    // On Windows path.relative() returns an absolute path across drives (no leading '..'), so reject that form too.
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

// Bytes of a bundled module's `package.json`, or null to skip when it's absent on disk; non-UTF-8 aborts (never silently skipped).
export function readModuleManifest({ baseDir, realBase, rel } = {}) {
  const absolute = join(baseDir, rel)
  if (!existsSync(absolute)) return null
  assertRealPathWithinBase(realBase, baseDir, rel)
  const buf = readFileSync(absolute)
  if (!isUtf8(buf)) throw new Error(`package.json is not valid UTF-8: ${rel}`)
  return buf
}

// Never throws: a missing/unreadable/malformed file yields null.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// `owner/name` of a GitHub repository reference as package.json `repository` spells it: a git URL
// (https, ssh, scp-like `git@github.com:`, optional `git+` prefix and `.git` suffix), or the npm
// shorthands `github:owner/name` / bare `owner/name`. Credentials are never part of the result.
// Null for anything else (other hosts, gist:/gitlab:/bitbucket: shorthands).
export function parseGithubRepository(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:github:|(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:))?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  // Held to the bundle format's GitHub `owner/name` rules, so a detected value always serializes.
  const github = match && `${match[1]}/${match[2]}`
  return github && isValidRepoField('github', github) ? github : null
}

// Best-effort: the `origin` remote url from `.git/config` text, matched only in the exact shape git
// writes it (`[remote "origin"]` followed by a tab-indented `url = ` line). No git config parsing.
const GIT_ORIGIN_URL = '[remote "origin"]\n\turl = '
export function gitOriginUrl(text) {
  const at = text.indexOf(GIT_ORIGIN_URL)
  if (at === -1) return null
  const start = at + GIT_ORIGIN_URL.length
  const end = text.indexOf('\n', start)
  return text.slice(start, end === -1 ? undefined : end).trim() || null
}

// Snapshotted off the namespace before any --fs patch (see fs.js): detectRepo runs while a bundle is
// being written, and its own reads must never be captured into (or served from) it.
const { existsSync: realExistsSync, readFileSync: realReadFileSync } = fs

// `base` (a repo-relative dir, e.g. package.json `repository.directory`) joined with the POSIX
// `rel` below it, normalized; '' is the repo root.
// A path the bundle format would reject (escaping the repo) is undefined, dropping `directory`.
const joinRepoPath = (base, rel) => {
  const joined = posix.join(typeof base === 'string' ? toPosix(base) : '', rel)
  const directory = joined === '.' ? '' : joined.replace(/^\/+|\/+$/gu, '')
  return isValidRepoField('directory', directory) ? directory : undefined
}

// The detected `repo` block, without undefined fields.
const repoOf = (github, directory, commit) => ({
  github,
  ...(directory === undefined ? {} : { directory }),
  ...(commit === undefined ? {} : { commit }),
})

const readText = (file) => {
  try {
    return realReadFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// Best-effort: the commit HEAD points at in a plain `.git` dir -- a detached sha, else the branch's
// loose ref, else its `packed-refs` line. Undefined unless it is a full git sha.
function gitHeadCommit(gitDir) {
  const head = readText(join(gitDir, 'HEAD'))?.trim()
  if (!head) return undefined
  let commit = head
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length)
    if (!ref.startsWith('refs/') || posixPathEscapes(ref)) return undefined
    commit = readText(join(gitDir, ref))?.trim() ??
      readText(join(gitDir, 'packed-refs'))?.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0]
  }
  return isValidRepoField('commit', commit) ? commit : undefined
}

// From git: the nearest work tree root (a dir holding `.git`) at or above `start`; `github` from its
// `.git/config` origin remote, `directory` from `start`'s path below the root, `commit` from HEAD.
// Undefined without a work tree or a GitHub origin. Reads `.git` files only -- git never runs.
function gitRepo(start) {
  for (let cursor = start; ; cursor = dirname(cursor)) {
    if (realExistsSync(join(cursor, '.git'))) {
      const gitDir = join(cursor, '.git')
      const github = parseGithubRepository(gitOriginUrl(readText(join(gitDir, 'config')) ?? ''))
      if (!github) return undefined
      return repoOf(github, joinRepoPath('', toPosix(relative(cursor, start))), gitHeadCommit(gitDir))
    }
    if (dirname(cursor) === cursor) return undefined
  }
}

// From package.json: the nearest one at or above `start` declaring a `repository` (the walk stops
// at the work tree root); `github` from its URL/shorthand, `directory` from `repository.directory`
// combined with `start`'s path below that package.json. A non-GitHub repository yields undefined.
function packageRepo(start) {
  for (let cursor = start; ; cursor = dirname(cursor)) {
    let repository
    try {
      repository = JSON.parse(realReadFileSync(join(cursor, 'package.json'), 'utf8'))?.repository
    } catch { /* absent or malformed -- keep walking */ }
    const url = typeof repository === 'string' ? repository : repository?.url
    if (typeof url === 'string') {
      const github = parseGithubRepository(url)
      return github ? repoOf(github, joinRepoPath(repository.directory, toPosix(relative(cursor, start)))) : undefined
    }
    if (realExistsSync(join(cursor, '.git')) || dirname(cursor) === cursor) return undefined
  }
}

// Informational repo identity for a bundle rooted at `dir`, `{ github, directory?, commit? }` with
// `directory` being `dir`'s path within the repo ('' at its root). Git first (see gitRepo, the only
// source of `commit`), else package.json (see packageRepo). Every value is held to the bundle
// format's validation; undefined when neither names a GitHub repository. Never throws.
export function detectRepo(dir) {
  const start = resolve(dir)
  return gitRepo(start) ?? packageRepo(start)
}
