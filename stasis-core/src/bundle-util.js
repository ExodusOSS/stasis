import { isUtf8 } from 'node:buffer'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { isValidRepoField } from './bundle.js'
import { posixPathEscapes } from './artifact-util.js'
import { diskHost } from './host.js'
import { assertRealPathWithinBase, hasNodeModulesSegment, toPosix } from './util.js'

// Text as Node reads a package.json: UTF-8, past a byte order mark.
const utf8 = new TextDecoder()
export const packageJSONText = (bytes) => utf8.decode(bytes)

export function packageType(file, host = diskHost) {
  const pkg = host.findPackageJSON(file)
  if (!pkg) return null
  try {
    const type = JSON.parse(packageJSONText(host.readFile(pkg))).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Nearest package.json (walking up) that identifies a bucket; pkgDir is relative to baseDir ("."
// at the root). Inside node_modules both name and version are required; a workspace package
// outside node_modules may omit version (the name alone claims the bucket, matching
// State#locateModule). Null if none.
export function findPackageMetadata(baseDir, fileRelPath, host = diskHost) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkgPath = join(baseDir, dir, 'package.json')
    if (host.stat(pkgPath)?.isFile()) {
      try {
        const pkg = JSON.parse(packageJSONText(host.readFile(pkgPath)))
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

// Bytes of a bundled module's `package.json`, or null to skip when it's absent; non-UTF-8 aborts (never silently skipped).
export function readModuleManifest({ baseDir, realBase, rel, host = diskHost } = {}) {
  const absolute = join(baseDir, rel)
  if (host.stat(absolute) === null) return null
  assertRealPathWithinBase(realBase, baseDir, rel, host)
  const buf = host.readFile(absolute)
  if (!isUtf8(buf)) throw new Error(`package.json is not valid UTF-8: ${rel}`)
  return buf
}

// Never throws: a missing/unreadable/malformed file yields null.
export function readJson(file, host = diskHost) {
  try {
    return JSON.parse(packageJSONText(host.readFile(file)))
  } catch {
    return null
  }
}

// `owner/name` from a package.json `repository` (GitHub URL or shorthand), else null.
export function parseGithubRepository(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:github:|(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:))?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  // Must also pass the bundle format's `github` check.
  const github = match && `${match[1]}/${match[2]}`
  return github && isValidRepoField('github', github) ? github : null
}

// Best-effort `origin` url: literal match of git's own `.git/config` layout, no parsing.
const GIT_ORIGIN_URL = '[remote "origin"]\n\turl = '
export function gitOriginUrl(text) {
  const at = text?.indexOf(GIT_ORIGIN_URL) ?? -1
  if (at === -1) return null
  const start = at + GIT_ORIGIN_URL.length
  const end = text.indexOf('\n', start)
  return text.slice(start, end === -1 ? undefined : end).trim() || null
}

// The text of `file`, or null. Read through `host` (never the --fs-patched fs), it is never captured.
export const readText = (host, file) => {
  try {
    return host.readFile(file).toString('utf8')
  } catch {
    return null
  }
}

// Dir of a `https://github.com/<github>/tree/<branch>/<dir>` homepage (one-segment branch).
export function githubHomepageDirectory(homepage, github) {
  if (typeof homepage !== 'string') return undefined
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/tree\/[^/#?]+\/([^#?]+)/iu.exec(homepage.trim())
  if (!match || match[1].toLowerCase() !== github.toLowerCase()) return undefined
  try {
    return decodeURIComponent(match[2])
  } catch {
    return undefined
  }
}

// `base` joined with `rel` as `{ root: true }`, `{ directory }`, or `{}` if not a valid `directory`.
const repoLocation = (base, rel) => {
  const directory = posix.join(typeof base === 'string' ? toPosix(base) : '', rel).replace(/^\/+|\/+$/gu, '')
  if (directory === '' || directory === '.') return { root: true } // `./`, `a/../`, trailing slashes
  return isValidRepoField('directory', directory) ? { directory } : {}
}

// Git and common dirs, following a worktree/submodule `.git` file.
function gitDirs(dotGit, host) {
  const pointer = readText(host, dotGit) // null for a `.git` directory (EISDIR)
  const gitDir = pointer?.startsWith('gitdir: ') ? resolve(dirname(dotGit), pointer.slice('gitdir: '.length).trim()) : dotGit
  const common = readText(host, join(gitDir, 'commondir'))?.trim()
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
}

// HEAD's commit: detached sha, loose ref, or packed-refs; undefined unless a valid sha.
function gitHeadCommit({ gitDir, commonDir }, host) {
  const head = readText(host, join(gitDir, 'HEAD'))?.trim()
  if (!head) return undefined
  let commit = head
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length)
    if (!ref.startsWith('refs/') || posixPathEscapes(ref)) return undefined
    commit = readText(host, join(commonDir, ref))?.trim() ??
      readText(host, join(commonDir, 'packed-refs'))?.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0]
  }
  return isValidRepoField('commit', commit) ? commit : undefined
}

// Bundle `repo` for `dir`: git origin/HEAD at the work tree root, else nearest package.json `repository`.
export function detectRepo(dir, host = diskHost) {
  const start = resolve(dir)
  let pkg = null // null: no package.json `repository` seen yet; undefined: one seen, not GitHub
  for (let cursor = start; ; cursor = dirname(cursor)) {
    const rel = toPosix(relative(cursor, start))
    if (pkg === null) {
      const { repository, homepage } = readJson(join(cursor, 'package.json'), host) ?? {}
      const url = typeof repository === 'string' ? repository : repository?.url
      if (typeof url === 'string') {
        const github = parseGithubRepository(url)
        // Often unset; fall back to a GitHub tree `homepage`.
        const base = typeof repository.directory === 'string' ? repository.directory : githubHomepageDirectory(homepage, github ?? '')
        pkg = github ? { github, ...repoLocation(base, rel) } : undefined
      }
    }
    const dotGit = join(cursor, '.git')
    if (host.stat(dotGit) !== null) {
      const dirs = gitDirs(dotGit, host)
      const github = parseGithubRepository(gitOriginUrl(readText(host, join(dirs.commonDir, 'config'))))
      if (github) return stripUndefined({ github, ...repoLocation('', rel), commit: gitHeadCommit(dirs, host) })
      return pkg ?? undefined
    }
    if (dirname(cursor) === cursor) return pkg ?? undefined
  }
}

const stripUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
