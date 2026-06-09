// Bash loader: produces a `{ sources, resolutions, missing }` triple from a
// set of shell scripts, mirroring the Solidity loader's interface (see
// ./solidity.js). A relative/project-relative reference to a .sh/.bash file
// must resolve to an in-set script — when it doesn't, it lands in `missing`
// so the bundle builder can reject the dangling dependency. Everything else
// is best-effort and dropped: a line like `grep "$x" file`, `bash "$SCRIPT"`,
// an extensionless `source ./env`, or an absolute `source /etc/x.sh` names a
// command, dynamic path, or external file, none of which is bundle-able.

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

// `source script.sh`, `. script.sh`, `. ./script.sh`
const SOURCE_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:source|\.)\s+["']?([^\s"';&|#]+)["']?/gu

// `bash script.sh`, `sh script.sh`, `/usr/bin/env bash script.sh`, etc.
const EXEC_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:\/usr\/bin\/env\s+)?(?:ba)?sh\s+["']?([^\s"';&|#]+)["']?/gu

// Direct invocation: `./script.sh`, `../lib/helper.bash`, `/path/to/script.sh`
const DIRECT_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*["']?(\.\.?\/[^\s"';&|#]+\.(?:sh|bash))["']?/gu

// Dependency hint comment: `# Depends on: example.sh`
const COMMENT_RE = /^# Depends on: ([^ ]+\.(?:sh|bash))( |$)/gmu

// Extract every file-like reference from a script's text. Variable
// expansions (`$VAR`, `${VAR}`, `$HOME/x.sh`) and flags (`-c`) are dropped
// here — they are never bundle-able file paths. The remaining strings are
// candidate references; resolveBashCall decides which name a real file.
export function extractBashCalls(content) {
  const calls = new Set()
  for (const re of [SOURCE_RE, EXEC_RE, DIRECT_RE, COMMENT_RE]) {
    for (const m of content.matchAll(re)) {
      const ref = m[1]
      if (ref.includes('$') || ref.startsWith('-')) continue
      calls.add(ref)
    }
  }
  return [...calls]
}

// Resolve a bash reference to a baseDir-relative POSIX path. Existence is
// checked against `knownFiles` (tree mode, used once every script is in
// hand) or the filesystem under `baseDir` (walk mode, while discovering the
// graph); with neither, only path computation happens and unvalidated names
// return null.
//
// Reference kinds are treated differently:
//   - absolute (`/x`): mapped to project-relative by stripping the leading
//     slash, accepted only if that file actually exists in the set/on disk
//     (so system paths like /etc/profile.d/x.sh are dropped, not bundled).
//   - relative / project-relative WITH a slash (`./x`, `../x`, `lib/x.sh`):
//     resolved against the caller's directory and returned as a computed
//     path WITHOUT an existence check — the walk's readFile surfaces a
//     missing target and the tree drops it, mirroring the Solidity loader.
//     Traversal above baseDir returns null rather than clamping.
//   - bare name (`helper.sh`, but also `grep`, `node`): could be a sibling
//     script or a PATH command, so it is accepted only when it names a real
//     file — caller's dir, then project root, then (knownFiles only) any
//     in-set file by basename.
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

  // Absolute → project-relative, validated.
  if (ref.startsWith('/')) {
    const stripped = ref.replace(/^\/+/u, '')
    return present(stripped) ? stripped : null
  }

  // Path with a slash → computed, validation deferred to the caller.
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

// A reference is a *local* script when it names a .sh/.bash file by a
// relative or project-relative path (not an absolute/system one). These must
// resolve to a bundled script; anything else — PATH commands, extensionless
// sources, absolute `/etc/...` paths, `$VAR` paths — is best-effort.
const isLocalScriptRef = (ref) =>
  !ref.startsWith('/') && (ref.endsWith('.sh') || ref.endsWith('.bash'))

// Build the { sources, resolutions, missing } triple from a Map of
// already-loaded scripts. Resolutions only ever point at other in-set files;
// a relative/project-relative .sh/.bash reference that resolves to nothing is
// recorded in `missing` (the bundle builder treats it as fatal). Everything
// else that doesn't resolve — PATH commands, $VAR paths, extensionless
// sources, absolute system paths — is omitted, as are self-references.
export function buildBashTree(sources) {
  const knownFiles = new Set(sources.keys())
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const ref of extractBashCalls(content)) {
      let resolved = resolveBashCall(ref, path, { knownFiles })
      // The slash-bearing relative branch returns an unvalidated path; drop
      // it here when it doesn't name a collected file (Solidity-style).
      if (resolved && !knownFiles.has(resolved)) resolved = null
      if (resolved) {
        if (resolved !== path) specMap.set(ref, resolved) // drop self-references
      } else if (isLocalScriptRef(ref)) {
        console.warn(`[loader.bash] Missing file: ${ref} from ${path}`)
        missing.push({ spec: ref, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem from `entries`, following resolved source/exec/direct
// references and reading each reachable script exactly once. Files in the
// same wave are read in parallel; the next wave depends on references found
// in the previous one. A reference that resolves to a path missing on disk
// warns and is skipped (the graph stays partial but the walk continues);
// unresolved references (commands, dynamic paths) are silently ignored.
export async function collectBashFilesFromDisk(baseDir, entries) {
  const sources = new Map()

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          return [relPath, await readFile(join(baseDir, relPath), 'utf8')]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.bash] Missing file: ${relPath}`)
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

// Reject absolute paths and `..`-escaping paths in a `.sh.txt` listing so a
// malicious or sloppy listing can't trick the loader into reading arbitrary
// files outside the listing's own directory.
function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = relative(baseDir, resolve(baseDir, candidate)).split(/[\\/]/u).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// High-level: takes a `.sh.txt` listing file whose lines are the scripts to
// load (`.sh`, `.bash`, or extensionless), resolved relative to the listing.
// Unlike loadSolidity, the listing is the authoritative manifest — bash
// sourcing is too dynamic to walk reliably — so exactly the listed files are
// read and resolutions are computed among them. Returns { sources, resolutions }.
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

  const reads = await Promise.all(
    lines.map(async (relPath) => [relPath, await readFile(join(baseDir, relPath), 'utf8')]),
  )
  return buildBashTree(new Map(reads))
}
