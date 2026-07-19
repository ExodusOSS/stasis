// Bash loader: `{ sources, resolutions, missing }` from a set of scripts. A
// .sh/.bash reference landing INSIDE the bundle root must resolve to an in-set
// script, else it lands in `missing`; everything else (PATH commands, `$VAR`
// paths, absolute/escaping paths) is best-effort and dropped. A dynamically
// sourced path can be pinned by a `# shellcheck source=...` directive.

import { realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// The capture class excludes backtick/`(`/`)` so a ref inside a command
// substitution (`` `source x.sh` ``, `$(bash x.sh)`) doesn't swallow the closing delimiter.

// `source script.sh`, `. script.sh`, `. ./script.sh`
const SOURCE_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:source|\.)\s+["']?([^\s"';&|#`()]+)["']?/gu

// `bash`/`sh script.sh`, incl. `/usr/bin/env bash`, `/bin/sh`, `/usr/bin/bash`.
const EXEC_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:ba)?sh\s+["']?([^\s"';&|#`()]+)["']?/gu

// Direct invocation: `./script.sh`, `../lib/helper.bash`, `/path/to/script.sh`
const DIRECT_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*["']?(\.\.?\/[^\s"';&|#`()]+\.(?:sh|bash))["']?/gu

// Dependency hint comment: `# Depends on: example.sh`
const COMMENT_RE = /^# Depends on: ([^ ]+\.(?:sh|bash))( |$)/gmu

// shellcheck `source=` directive: `# shellcheck source=../lib/config.sh`, the
// explicit way to point at a dynamically sourced (`$VAR`) file. Resolved relative
// to the script. `source=/dev/null` is shellcheck's "don't follow" sentinel, ignored below.
const SHELLCHECK_SOURCE_RE = /#\s*shellcheck\s[^\n]*?\bsource=["']?([^\s"'#]+)["']?/gu

// Extract candidate file references. `$VAR` expansions and `-flags` are dropped
// (never bundle-able); resolveBashCall decides which of the rest name a real file.
export function extractBashCalls(content) {
  const calls = new Set()
  for (const re of [SOURCE_RE, EXEC_RE, DIRECT_RE, COMMENT_RE, SHELLCHECK_SOURCE_RE]) {
    for (const m of content.matchAll(re)) {
      const ref = m[1]
      if (ref.includes('$') || ref.startsWith('-') || ref === '/dev/null') continue
      calls.add(ref)
    }
  }
  return [...calls]
}

// Resolve a bash reference to a baseDir-relative POSIX path. Existence is checked
// against `knownFiles` (tree mode) or the filesystem under `baseDir` (walk mode);
// with neither, only path computation happens. Handling differs by kind (below).
export function resolveBashCall(ref, fromFile, { knownFiles, baseDir } = {}) {
  const present = (p) => {
    if (!p) return false
    if (knownFiles) return knownFiles.has(p)
    if (baseDir) {
      try {
        return statSync(join(baseDir, p)).isFile()
      } catch {
        return false
      }
    }
    return false
  }

  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const resolveRel = (r) => {
    const parts = [...(fromDir ? fromDir.split('/') : []), ...r.split('/')]
    const out = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') {
        if (out.length === 0) return null // escapes baseDir
        out.pop()
      } else {
        out.push(part)
      }
    }
    return out.join('/') || null
  }

  // Absolute → project-relative, accepted only if it exists (so `/etc/...` is dropped).
  if (ref.startsWith('/')) {
    const stripped = ref.replace(/^\/+/u, '')
    return present(stripped) ? stripped : null
  }

  // Path with a slash → computed against the caller's dir; existence deferred to the caller.
  if (ref.includes('/')) return resolveRel(ref)

  // Bare name → only accept a real file.
  const sibling = resolveRel(ref)
  if (present(sibling)) return sibling
  if (sibling !== ref && present(ref)) return ref
  if (knownFiles) {
    for (const known of knownFiles) {
      const base = known.includes('/') ? known.slice(known.lastIndexOf('/') + 1) : known
      if (base === ref) return known
    }
  }
  return null
}

// True for `.sh`/`.bash` refs; an extensionless `source ./env` isn't flagged missing when absent.
const hasShellScriptExt = (ref) => ref.endsWith('.sh') || ref.endsWith('.bash')

// Build the triple from already-loaded scripts. A ref is `missing` (fatal) only
// when it resolves INSIDE the bundle root but wasn't collected (a dangling
// `source ./lib.sh`); null-resolving refs are external and tolerated, and
// self-refs/non-script exts are dropped silently.
export function buildBashTree(sources) {
  const knownFiles = new Set(sources.keys())
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const ref of extractBashCalls(content)) {
      // Slash branch returns an unchecked in-bundle path, so a non-null target not
      // in knownFiles is a genuine dangling dep; a null target is external.
      const target = resolveBashCall(ref, path, { knownFiles })
      if (target && knownFiles.has(target)) {
        if (target !== path) specMap.set(ref, target) // drop self-references
      } else if (target && hasShellScriptExt(ref)) {
        console.warn(`[loader.bash] Missing file: ${ref} from ${path}`)
        missing.push({ spec: ref, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk from `entries` following resolved refs, reading each script once; a ref
// missing on disk warns and is skipped without aborting the walk.
export async function collectBashFilesFromDisk(baseDir, entries) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          assertRealPathWithinBase(realBase, baseDir, relPath)
          return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.bash] Missing file: ${relPath}`)
            return null
          }
          // A slash ref can resolve to a directory (`source ./lib`) → EISDIR; skip, don't abort.
          if (err.code === 'EISDIR') {
            console.warn(`[loader.bash] Skipping directory reference: ${relPath}`)
            return null
          }
          throw err
        }
      })
    )
    const next = []
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content] = entry
      sources.set(relPath, content)
      for (const ref of extractBashCalls(content)) {
        const resolved = resolveBashCall(ref, relPath, { baseDir })
        if (resolved && !sources.has(resolved)) next.push(resolved)
      }
    }
    await processWave(next)
  }

  await processWave(entries)
  return sources
}

// Reject absolute and `..`-escaping paths in a `.sh.txt` listing so it can't
// read files outside the listing's own directory.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level entry: reads the scripts named in a `.sh.txt` listing (relative to
// it). Unlike loadRust, the listing is authoritative — bash sourcing is too
// dynamic to walk — so exactly the listed files are read, resolutions computed among them.
export async function loadBash(shTxtFile) {
  const baseDir = dirname(resolve(shTxtFile))
  const listing = await readFile(shTxtFile, 'utf8')
  const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^\.\//u, ''))
  if (lines.length === 0) throw new Error(`Empty bash listing: ${shTxtFile}`)

  if (!lines.every((line) => ['', '.sh', '.bash'].includes(extname(line)))) {
    throw new Error(`Bash listing must only contain .sh/.bash files: ${shTxtFile}`)
  }
  for (const line of lines) assertWithinBase(baseDir, line, 'Entry path')

  const realBase = realpathSync(baseDir)
  const reads = await Promise.all(
    lines.map(async (relPath) => {
      assertRealPathWithinBase(realBase, baseDir, relPath)
      return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
    }),
  )
  return buildBashTree(new Map(reads))
}
