// PHP include-graph loader, modelled on the Solidity loader in this directory.
//
// Produces a `{ sources, resolutions, missing }` triple by statically scanning
// `require` / `require_once` / `include` / `include_once` statements and
// following the ones whose path is a string literal. Three argument shapes are
// understood, covering the overwhelming majority of real-world includes:
//
//   require_once __DIR__ . '/lib/Foo.php';        // dir-relative (modern)
//   include      dirname(__FILE__) . '/Bar.php';  // dir-relative (legacy)
//   require      'helpers.php';                    // bare / include_path
//
// Like the Solidity loader, this is deliberately a *static* scan: it never
// executes PHP. Dynamic includes (`require $path;`, interpolated strings such
// as `require __DIR__ . "/{$name}.php";`, or multi-segment concatenations)
// cannot be resolved statically — they surface as unresolved imports, which
// `buildPhpBundle` turns into a hard error so a bundle is never silently
// produced with holes. Composer/PSR-4 autoloading (`use Foo\Bar;` resolved via
// `vendor/autoload.php`) is out of scope here; only explicit includes are
// followed, mirroring how the Solidity loader follows only explicit `import`s.

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Matches an include keyword followed by a single string-literal argument,
// optionally prefixed by `__DIR__ .` or `dirname(__FILE__) .`. The leading
// lookbehind keeps method calls (`$x->require(...)`), scope resolutions
// (`Foo::include(...)`) and longer identifiers from matching; the trailing
// `\b` stops `require` from matching inside `requireConfig`.
const PHP_INCLUDE_RE =
  /(?<![\w$>:])(?:require_once|require|include_once|include)\b\s*\(?\s*(__DIR__|dirname\s*\(\s*__FILE__\s*\))?\s*\.?\s*(['"])([^'"]+)\2/giu

// Extract the resolvable include specifiers from PHP source. Dir-relative
// includes are normalised to a `./`-prefixed specifier (the leading slash
// after `__DIR__` is a path separator, not an absolute-path marker) so
// `resolvePhpImport` can treat them like ordinary relative imports. Bare
// specifiers are returned verbatim.
export function extractPhpImports(content) {
  const specs = []
  for (const m of content.matchAll(PHP_INCLUDE_RE)) {
    const dirPrefix = m[1]
    const raw = m[3]
    if (dirPrefix) {
      const rel = raw.replace(/^\/+/u, '')
      specs.push(rel.startsWith('.') ? rel : `./${rel}`)
    } else {
      specs.push(raw)
    }
  }
  return specs
}

// Apply `segments` (already split on '/') on top of `fromFile`'s directory,
// collapsing '.'/'' and resolving '..'. Returns a baseDir-relative POSIX path,
// or null when traversal escapes above the project root (rather than clamping).
function applyToDir(fromFile, segments) {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const parts = [...(fromDir ? fromDir.split('/') : []), ...segments]
  const resolved = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

function isFileOnDisk(baseDir, rel) {
  try {
    return statSync(join(baseDir, rel)).isFile()
  } catch {
    return false
  }
}

// Resolve a PHP include specifier to a baseDir-relative POSIX path.
//   - `./x` / `../x` resolve against the including file's directory, exactly
//     like Solidity relative imports; escaping the root returns null.
//   - a bare specifier (`lib/Foo.php`, `helpers.php`) is ambiguous under PHP's
//     include_path, so it is disambiguated by what's actually on disk: a file
//     next to the including file wins, otherwise a project-root-relative match.
//     Both require `baseDir`; absolute specifiers are rejected outright.
// Returns null when no strategy resolves the include.
export function resolvePhpImport(specifier, fromFile, { baseDir } = {}) {
  if (specifier.startsWith('.')) {
    return applyToDir(fromFile, specifier.split('/'))
  }

  if (baseDir && !isAbsolute(specifier)) {
    const fileRel = applyToDir(fromFile, specifier.split('/'))
    if (fileRel && isFileOnDisk(baseDir, fileRel)) return fileRel

    const projRel = relative(baseDir, resolve(baseDir, specifier)).split(/[\\/]/u).join('/')
    if (projRel !== '' && !projRel.startsWith('..') && !isAbsolute(projRel) && isFileOnDisk(baseDir, projRel)) {
      return projRel
    }
  }

  return null
}

// Build the { sources, resolutions, missing } triple from a Map of already-
// loaded PHP sources. An include that resolves via the strategies above wins;
// as a final fallback an include specifier that matches a stored key verbatim
// is accepted. `missing` lists every (spec, from) pair that could not be
// resolved or that resolved to a file not loaded into `sources`.
export function buildPhpTree(sources, { baseDir } = {}) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractPhpImports(content)) {
      let resolved = resolvePhpImport(spec, path, { baseDir })
      if (resolved && !sources.has(resolved)) resolved = null
      if (!resolved && sources.has(spec)) resolved = spec
      if (resolved) {
        specMap.set(spec, resolved)
      } else {
        console.warn(`[loader.php] Missing import: ${spec} from ${path}`)
        missing.push({ spec, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the filesystem starting from `entries`, following resolved includes and
// reading each file exactly once. Files in the same wave are read in parallel;
// the next wave depends on the includes discovered in the previous one.
export async function collectPhpFilesFromDisk(baseDir, entries) {
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
            console.warn(`[loader.php] Missing import: ${relPath}`)
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
      for (const spec of extractPhpImports(content)) {
        const resolved = resolvePhpImport(spec, relPath, { baseDir })
        if (resolved) {
          if (!sources.has(resolved)) next.push(resolved)
        } else {
          console.warn(`[loader.php] Missing import: ${spec} from ${relPath}`)
        }
      }
    }
    await processWave(next)
  }

  await processWave(entries)
  return sources
}
