import { isUtf8 } from 'node:buffer'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
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
// State#locateModule). Null if none. A malformed one is walked past, or with `strict` throws
// (its files would otherwise land in the parent package); `check`, `host`: see readPackageJson.
export function findPackageMetadata(baseDir, fileRelPath, { strict = false, check, host = diskHost } = {}) {
  let dir = dirname(fileRelPath)
  while (true) {
    const pkg = readPackageJson(baseDir, toPosix(join(dir, 'package.json')), { strict, check, host })
    if (pkg?.name && (pkg.version || !hasNodeModulesSegment(toPosix(dir)))) {
      // `?? undefined` folds a literal `"version": null` into the one absent-version spelling.
      return { pkgDir: dir, name: pkg.name, version: pkg.version ?? undefined }
    }
    if (dir === '.' || dir === '/' || dir === '') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// The error codes that mean nothing is at a path.
export const NO_ENTRY = new Set(['ENOENT', 'ENOTDIR'])

// `file`'s bytes, or null when there's no file (a directory counts as none). It's opened without
// blocking and read only when it's a regular file: a FIFO, a socket, a device or a link to one
// (`/dev/stdin`) throws, naming it `label`, rather than stalling or reading the process's input.
export function readRegularFileOrNull(file, label) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    if (NO_ENTRY.has(err.code) || err.code === 'EISDIR') return null
    if (err.code === 'ENXIO') throw new Error(`${label}: not a regular file`, { cause: err }) // a socket
    throw err
  }
  try {
    const stat = fstatSync(fd)
    if (stat.isDirectory()) return null
    if (!stat.isFile()) throw new Error(`${label}: not a regular file`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

// The package.json at `rel` (under `baseDir`), parsed (a leading byte-order mark skipped, as npm
// and Node skip it), read through `host`; null when there's none (a directory counts as none), or
// when it doesn't parse or isn't a regular file -- unless `strict`, then that throws, saying where
// with the parser's line and column but never its message, which quotes the text (a file that isn't
// JSON may be anything, a secret included). `check(rel)`, when given, sees the path before it is
// read, and may throw to refuse it.
export function readPackageJson(baseDir, rel, { strict = false, check, host = diskHost } = {}) {
  const file = join(baseDir, rel)
  const stat = host.stat(file)
  if (stat === null || stat.isDirectory()) return null
  check?.(rel)
  try {
    // A FIFO, a socket or a device (or a link to one) is never read: it could stall the bundle.
    if (!stat.isFile()) throw new Error(`${rel}: not a regular file`)
    const bytes = host.readFile(file)
    // Strict, it's read as the file's own text or not at all; lenient lookups decode it as they always
    // have (a stray byte as U+FFFD).
    if (strict && !isUtf8(bytes)) throw new Error(`${rel}: not valid UTF-8`)
    return parseJson(bytes.toString('utf8').replace(/^\uFEFF/u, ''), rel)
  } catch (err) {
    if (strict) throw err
    return null
  }
}

// JSON.parse, throwing where the text breaks (the parser's line and column) but never the parser's
// message, which quotes the text.
function parseJson(text, rel) {
  try {
    return JSON.parse(text)
  } catch (err) {
    const at = /\(line \d+ column \d+\)/u.exec(err.message)?.[0]
    // eslint-disable-next-line preserve-caught-error -- the parser's error quotes the file
    throw new Error(`${rel} is not valid JSON${at ? ` ${at}` : ''}`)
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
