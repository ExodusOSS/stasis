// Bash loader: produces a `{ sources, resolutions, missing }` triple from a
// set of shell scripts, mirroring the Solidity loader's interface (see
// ./solidity.js). A reference to a .sh/.bash file by a path that lands INSIDE
// the bundle root (`./lib.sh`, `dir/lib.sh`) must resolve to an in-set script;
// when it doesn't it lands in `missing` so the bundle builder can reject the
// dangling dependency. Everything else is best-effort and dropped: PATH
// commands (`grep`), `$VAR` paths, extensionless `source ./env`, absolute
// `source /etc/x.sh`, and `../` paths that escape the root — none is bundle-able.
// A `source "${VAR}/x.sh"` whose path can't be evaluated statically is picked
// up from its `# shellcheck source=...` directive when one is present.

import { realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// The capture class excludes `` ` ``, `(`, `)` (on top of whitespace, quotes,
// `;`, `&`, `|`, `#`) so a reference inside a command substitution —
// `` `source x.sh` `` or `$(bash x.sh)` — doesn't swallow the closing delimiter
// into the path (which would silently drop the edge from the bundle).

// `source script.sh`, `. script.sh`, `. ./script.sh`
const SOURCE_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:source|\.)\s+["']?([^\s"';&|#`()]+)["']?/gu

// `bash script.sh`, `sh script.sh`, `/usr/bin/env bash script.sh`,
// `/bin/sh script.sh`, `/usr/bin/bash script.sh`, etc.
const EXEC_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:ba)?sh\s+["']?([^\s"';&|#`()]+)["']?/gu

// Direct invocation: `./script.sh`, `../lib/helper.bash`, `/path/to/script.sh`
const DIRECT_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*["']?(\.\.?\/[^\s"';&|#`()]+\.(?:sh|bash))["']?/gu

// Dependency hint comment: `# Depends on: example.sh`
const COMMENT_RE = /^# Depends on: ([^ ]+\.(?:sh|bash))( |$)/gmu

// shellcheck `source=` directive: `# shellcheck source=../lib/config.sh`
// (optionally alongside other directives, e.g. `# shellcheck disable=SC1091 source=lib/x.sh`).
// This is the standard, explicit way to tell tooling where a dynamically
// sourced file lives — e.g. `source "${LIB_DIR}/config.sh"`, whose path is a
// `$VAR` expansion that can't be evaluated statically. The path is resolved
// relative to the script (matching shellcheck's default). `source=/dev/null`
// is shellcheck's "don't follow this source" sentinel and is ignored below.
const SHELLCHECK_SOURCE_RE = /#\s*shellcheck\s[^\n]*?\bsource=["']?([^\s"'#]+)["']?/gu

// Extract every file-like reference from a script's text. Variable
// expansions (`$VAR`, `${VAR}`, `$HOME/x.sh`) and flags (`-c`) are dropped
// here — they are never bundle-able file paths; a `source "${VAR}/x.sh"` whose
// real location can't be computed statically should carry a `# shellcheck
// source=` directive instead. The remaining strings are candidate references;
// resolveBashCall decides which name a real file.
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
//     missing target and the tree flags or drops it, mirroring the Solidity
//     loader. Traversal above baseDir returns null rather than clamping, so
//     an escaping `../x.sh` is treated as external (never flagged missing).
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

// A `.sh`/`.bash` extension marks a reference as a shell script (as opposed to
// an extensionless `source ./env`, which we don't treat as a missing script
// when absent).
const hasShellScriptExt = (ref) => ref.endsWith('.sh') || ref.endsWith('.bash')

// Build the { sources, resolutions, missing } triple from a Map of
// already-loaded scripts. A reference is recorded in `missing` (which the
// bundle builder treats as fatal) only when it resolves to a path INSIDE the
// bundle root that wasn't collected — i.e. a dangling `source ./lib.sh`.
// References that resolve to null are external and tolerated: bare names
// (PATH commands / runtime-cwd scripts), absolute `/etc/...` paths, `$VAR`
// paths, and `../` paths that escape the root — none can live in the bundle.
// Self-references and non-script extensions are dropped without flagging.
export function buildBashTree(sources) {
  const knownFiles = new Set(sources.keys())
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const ref of extractBashCalls(content)) {
      // In tree mode the slash branch returns a computed in-bundle path
      // without checking existence, so a non-null target that isn't a known
      // file is a genuine dangling local dependency; a null target is external.
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

// Walk the filesystem from `entries`, following resolved source/exec/direct
// references and reading each reachable script exactly once. Files in the
// same wave are read in parallel; the next wave depends on references found
// in the previous one. A reference that resolves to a path missing on disk
// warns and is skipped (the graph stays partial but the walk continues);
// unresolved references (commands, dynamic paths) are silently ignored.
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
          // A slash-bearing ref can resolve to a directory (e.g. `source ./lib`);
          // readFile then throws EISDIR. Skip it rather than aborting the walk.
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
// read and resolutions are computed among them. Returns { sources, resolutions, missing }.
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
