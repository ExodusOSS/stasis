import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'

import { isTypeDeclaration } from '@exodus/stasis-core/util'

// tsc-style module resolution (`--typescript`), shared by BOTH JS resolvers -- scan.js's built-in
// Node resolver and resolve-fields.js's legacy-field resolver -- so the flag means one thing
// everywhere: when normal resolution misses and tsc would land on an on-disk TypeScript source,
// complete the miss with that file. It never rewrites a resolution that succeeded, so an on-disk
// `.js` always beats its `.ts` twin. The rules, in the shapes they apply to:
//   - extension substitution: `./x.js` -> `./x.ts` (`.jsx` -> `.tsx` under --jsx, `.mjs` -> `.mts`,
//     `.cjs` -> `.cts`) -- tsc never rewrites specifiers, so TS sources import each other by their
//     OUTPUT names, and the specifier names a file that only exists as its TS source;
//   - extension/index completion for an extensionless path (`./util` -> `./util.ts`,
//     `./dir` -> `./dir/index.ts`), incl. through a directory's package.json `main`;
//   - the same substitution applied to manifest-declared targets: a package `main`, an `exports`
//     target, a `#name` `imports` target naming a compiled file whose only on-disk form is TS;
//   - tsconfig `compilerOptions.paths` aliases (see loadTsconfigPaths), consulted for bare
//     specifiers nothing else resolved.
// This module also homes the generic manifest helpers (readJson/locatePackage/nearestPackage)
// both resolvers share -- it is the dependency-free lower layer, importing from neither.

// tsc's extension substitution table: the JS output extensions mapped back to the TS source
// siblings that may sit on disk in their place. `.tsx` entries apply only when the caller can
// carry/parse .tsx (i.e. --jsx). JS_OUTPUT_EXTS is derived, so the two cannot drift.
const TS_SIBLING_EXTS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])
export const JS_OUTPUT_EXTS = new Set(TS_SIBLING_EXTS.keys())

// The TS source siblings of a path/specifier naming a JS output extension (./x.js -> ./x.ts).
// Returns [] for a non-substitutable name (extensionless, already-TS, .json, unknown, dotfile --
// extname sees no extension in './.js', matching the extensionless gates downstream). Candidates
// spelling a type declaration (./x.d.js -> ./x.d.ts) are returned too: every probe site refuses
// declarations (types-only, erased at runtime), so the screen lives at probe time, once.
export function typescriptSiblings(name, { tsx = false } = {}) {
  const ext = extname(name)
  const exts = TS_SIBLING_EXTS.get(ext)
  if (!exts) return []
  const stem = name.slice(0, -ext.length)
  return exts.filter((e) => tsx || e !== '.tsx').map((e) => `${stem}${e}`)
}

// Extensions that never take the appended-`.ts` completion: JS outputs (substitution territory)
// and the extensions a resolver could already land on directly. Anything else (`./x.service`) is
// completed like an extensionless name, matching tsc's candidate list.
const NO_COMPLETION_EXTS = new Set([...JS_OUTPUT_EXTS, '.ts', '.tsx', '.mts', '.cts', '.json'])

export function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null // absent / unreadable -- no manifest here
  }
  // A manifest that EXISTS but is malformed must fail closed (Node throws rather than resolving past it).
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
}

// Nearest node_modules/<pkg> up from `fromDir` (handles @scope/name). Returns { pkgDir, subpath }
// (subpath '' = bare package import), or null if not installed up the tree.
export function locatePackage(fromDir, spec) {
  const parts = spec.split('/')
  const pkgLen = spec.startsWith('@') ? 2 : 1
  if (parts.length < pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const pkgName = parts.slice(0, pkgLen).join('/')
  const subpath = parts.slice(pkgLen).join('/')
  let dir = fromDir
  while (true) {
    // Skip a dir literally named node_modules (basename, not endsWith — `my-node_modules` must not match).
    if (basename(dir) !== 'node_modules') {
      const pkgDir = join(dir, 'node_modules', pkgName)
      if (isDir(pkgDir)) return { pkgDir, subpath }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Nearest package.json at/above `file`'s dir — the package whose fields (browser/RN map, imports)
// govern the file's own imports.
export function nearestPackage(file) {
  let dir = dirname(file)
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (isFile(pkgPath)) {
      const pkg = readJson(pkgPath)
      if (pkg) return { pkgDir: dir, pkg }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// A probe candidate is a target only if it names a real file that is not a type declaration
// (a `.d.ts` is types-only, erased at runtime -- tsc records it for types, never for emit).
const probe = (p) => (!isTypeDeclaration(p) && isFile(p) ? p : null)

// LOAD_INDEX with TS completions: dir/index.ts (+ index.tsx under tsx). Node/tsc already probed
// the .js/.json indexes before the fallback ever runs.
function probeIndex(dir, exts) {
  for (const ext of exts) {
    const hit = probe(join(dir, `index${ext}`))
    if (hit) return hit
  }
  return null
}

// Probe an absolute `base` the way tsc completes a missed path: the literal file (manifest-declared
// targets are never probed by Node, so a paths/main target can hit literally), its TS siblings,
// the appended-extension completion, and -- when `dir` allows and `base` is a directory -- the
// directory's package.json `main` (substituted + completed like any path, mirroring Node's
// LOAD_AS_DIRECTORY) then its index. `dirOnly` skips the file rules for specs Node treats as
// directory-only ('.', '..', a trailing '/'), so './' never probes the pathological '.ts' dotfile.
// `completion`/`dir` are off for exports/imports targets: Node requires those to name exact files,
// so only substitution applies (matching tsc's node16 rules).
export function probeTypescriptTarget(base, { tsx = false, dirOnly = false, completion = true, dir = true } = {}) {
  const exts = tsx ? ['.ts', '.tsx'] : ['.ts']
  if (!dirOnly) {
    const literal = probe(base)
    if (literal) return literal
    for (const cand of typescriptSiblings(base, { tsx })) {
      const hit = probe(cand)
      if (hit) return hit
    }
    if (completion && !NO_COMPLETION_EXTS.has(extname(base))) {
      for (const ext of exts) {
        const hit = probe(`${base}${ext}`)
        if (hit) return hit
      }
    }
  }
  if (dir && isDir(base)) {
    const pkg = readJson(join(base, 'package.json'))
    const main = typeof pkg?.main === 'string' && pkg.main.length > 0 ? pkg.main : null
    if (main) {
      // LOAD_AS_FILE(main) with substitution/completion, then LOAD_INDEX(main); a broken main
      // falls through to the package index, like Node.
      const entry = resolvePath(base, main)
      const hit = probeTypescriptTarget(entry, { tsx, dir: false }) ?? probeIndex(entry, exts)
      if (hit) return hit
    }
    return probeIndex(base, exts)
  }
  return null
}

// --- package `exports`/`imports` map resolution (candidate generation) ---

// Expand a target value (string | array | conditions object | null) to the target strings the
// active `conditions` select, wildcard-substituted. Mirrors Node's PACKAGE_TARGET_RESOLVE closely
// enough for fallback candidates: a conditions object commits to its FIRST matching key ('default'
// always matches); an array contributes its entries in order (the probe decides).
function expandTarget(value, wildcard, conditions) {
  if (typeof value === 'string') {
    return [wildcard == null ? value : value.replaceAll('*', wildcard)]
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => expandTarget(v, wildcard, conditions))
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'default' || conditions.has(key)) return expandTarget(v, wildcard, conditions)
    }
  }
  return [] // null (an explicit block) or no matching condition
}

// Resolve `key` through an exports/imports-shaped map: exact key first (a key containing '*' is
// never exact), else the best '*' pattern -- longest prefix, then longest key, exactly Node's
// PATTERN_KEY_COMPARE order -- with the matched wildcard substituted into the targets.
function resolveMapKey(map, key, conditions) {
  if (Object.hasOwn(map, key) && !key.includes('*')) return expandTarget(map[key], null, conditions)
  let best = null
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf('*')
    if (star === -1 || pattern.indexOf('*', star + 1) !== -1) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue
    if (best === null || prefix.length > best.prefix.length
      || (prefix.length === best.prefix.length && pattern.length > best.pattern.length)) {
      best = { pattern, prefix, suffix }
    }
  }
  if (!best) return []
  const wildcard = key.slice(best.prefix.length, key.length - best.suffix.length)
  return expandTarget(map[best.pattern], wildcard, conditions)
}

// A './' map target is only followed when it stays inside the package, like Node's
// PACKAGE_TARGET_RESOLVE invalid-target rules ('..' hops and node_modules re-entry are refused).
function validRelativeTarget(target) {
  return target.startsWith('./')
    && !target.split('/').some((seg) => seg === '..' || seg === 'node_modules')
}

// Candidate targets for `subpathKey` ('.', './sub', or '#name') through a package's exports or
// imports map. Exports sugar (a bare string/array/conditions object) is the '.' target.
function manifestTargets(map, subpathKey, conditions) {
  if (map == null) return []
  let byKey = map
  if (typeof map !== 'object' || Array.isArray(map)
    || Object.keys(map).every((k) => !k.startsWith('.') && !k.startsWith('#'))) {
    if (subpathKey !== '.') return []
    byKey = { '.': map }
  }
  return resolveMapKey(byKey, subpathKey, conditions).filter((t) => validRelativeTarget(t))
}

// --- tsconfig `compilerOptions.paths` ---

// tsconfig.json is JSONC: strip // and /* */ comments and trailing commas (never inside string
// literals), then JSON.parse. A config that exists but does not parse must fail closed.
function parseJsonc(text, file) {
  if (text.charCodeAt(0) === 0xFE_FF) text = text.slice(1) // BOM
  let out = ''
  let pendingComma = -1 // index in `out` of a comma that may turn out to be trailing
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
      pendingComma = -1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = (nl === -1 ? text.length : nl) - 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === ',') {
      pendingComma = out.length
    } else if (c === '}' || c === ']') {
      if (pendingComma !== -1) out = `${out.slice(0, pendingComma)}${out.slice(pendingComma + 1)}`
      pendingComma = -1
    } else if (pendingComma !== -1 && !/\s/u.test(c)) {
      pendingComma = -1
    }
    out += c
  }
  try {
    return JSON.parse(out)
  } catch (cause) {
    throw new Error(`Invalid tsconfig: ${file}`, { cause })
  }
}

// Resolve an `extends` target like tsc: relative/absolute against the extending file (with the
// implied .json), bare through node_modules (the spelled path, its .json twin, or the package's
// tsconfig.json). A named base that cannot be found fails closed -- its options are load-bearing.
function resolveExtendsTarget(fromFile, target) {
  if (target.startsWith('./') || target.startsWith('../') || isAbsolute(target)) {
    const p = resolvePath(dirname(fromFile), target)
    if (isFile(p)) return p
    if (isFile(`${p}.json`)) return `${p}.json`
  } else {
    const req = createRequire(fromFile)
    for (const cand of [target, `${target}.json`, `${target}/tsconfig.json`]) {
      try {
        return req.resolve(cand)
      } catch { /* not this spelling -- try the next */ }
    }
  }
  throw new Error(`tsconfig extends target not found: '${target}' (from ${fromFile})`)
}

// Effective { paths, pathsDir, baseUrl } across the `extends` chain: bases apply in order, the
// extending file overrides them; `paths` replaces wholesale (tsc never deep-merges it) and
// remembers its declaring dir; `baseUrl` is resolved against its declaring file.
function loadConfigChain(file, seen) {
  if (seen.has(file)) throw new Error(`tsconfig extends cycle at ${file}`)
  seen.add(file)
  const raw = parseJsonc(readFileSync(file, 'utf8'), file)
  const acc = {}
  for (const base of [].concat(raw?.extends ?? [])) {
    Object.assign(acc, loadConfigChain(resolveExtendsTarget(file, base), seen))
  }
  const co = raw?.compilerOptions ?? {}
  if (typeof co.baseUrl === 'string') acc.baseUrl = resolvePath(dirname(file), co.baseUrl)
  if (co.paths != null) {
    acc.paths = co.paths
    acc.pathsDir = dirname(file)
  }
  return acc
}

// Load a tsconfig's `compilerOptions.paths` into a matcher, following `extends`. Returns null when
// `file` is null or the effective config declares no paths. matchPaths(spec) returns the absolute
// substituted targets of the BEST-matching key -- exact match first, else the '*' pattern with the
// longest matched prefix, exactly one key, its targets in order (tsc tries no other key when they
// all miss) -- resolved against `baseUrl`, or against the declaring config's dir without one
// (TS 4.1 paths-without-baseUrl). Only `extends`/`baseUrl`/`paths` are read; malformed shapes
// (a non-array value, more than one '*' in a key or target) fail closed like tsc's config errors.
export function loadTsconfigPaths(file) {
  if (file == null) return null
  const { paths, pathsDir, baseUrl } = loadConfigChain(file, new Set())
  if (paths == null || typeof paths !== 'object' || Object.keys(paths).length === 0) return null
  const starCount = (s) => s.split('*').length - 1
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string')) {
      throw new Error(`tsconfig paths['${key}'] must be an array of strings (${file})`)
    }
    for (const t of [key, ...targets]) {
      if (starCount(t) > 1) throw new Error(`tsconfig paths pattern '${t}' has more than one '*' (${file})`)
    }
  }
  const base = baseUrl ?? pathsDir
  return {
    matchPaths(spec) {
      let targets = null
      if (Object.hasOwn(paths, spec) && !spec.includes('*')) {
        targets = paths[spec].map((t) => ({ target: t, wildcard: null }))
      } else {
        let best = null
        for (const key of Object.keys(paths)) {
          const star = key.indexOf('*')
          if (star === -1) continue
          const prefix = key.slice(0, star)
          const suffix = key.slice(star + 1)
          if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
          if (best === null || prefix.length > best.prefix.length) best = { key, prefix, suffix }
        }
        if (!best) return []
        const wildcard = spec.slice(best.prefix.length, spec.length - best.suffix.length)
        targets = paths[best.key].map((t) => ({ target: t, wildcard }))
      }
      return targets.map(({ target, wildcard }) =>
        resolvePath(base, wildcard == null ? target : target.replace('*', wildcard)))
    },
  }
}

// The tsconfig `--typescript` reads: an explicit `--tsconfig` path must exist (fail closed on a
// typo); with none given, the project root's tsconfig.json applies when present, like tsc's own
// discovery from a directory.
export function discoverTsconfig(baseDir, explicit) {
  if (explicit != null) {
    const p = resolvePath(baseDir, explicit)
    if (!isFile(p)) throw new Error(`tsconfig not found: ${explicit}`)
    return p
  }
  const p = join(baseDir, 'tsconfig.json')
  return isFile(p) ? p : null
}

// --- the fallback dispatcher ---

// Specs Node resolves as a directory only ('.', '..', a './..'-style tail, a trailing '/'):
// the file rules are skipped for them, exactly as Node skips LOAD_AS_FILE.
const DIR_ONLY_SPEC = /(?:^|\/)\.{1,2}$|\/$/u

// tsconfig paths map first-party aliases; a dependency's own bare imports must never be hijacked
// by the app's aliases (tsc doesn't resolve node_modules files' imports through the app config).
const IN_NODE_MODULES = /(?:^|[\\/])node_modules[\\/]/u

// Resolve `spec` from `parentFile` the way tsc would complete a resolution BOTH Node and the
// legacy-field resolver missed. Returns the absolute path of the on-disk source, or null.
// `conditions` gates exports/imports maps (same set the failed resolution used); `tsx` widens the
// substitutions to .tsx; `paths` is a loadTsconfigPaths matcher (or null). Dispatch by shape:
//   '#name'        -> the parent package's `imports` targets, substitution only;
//   relative/abs   -> path substitution/completion (+ directory main/index);
//   bare           -> tsconfig paths aliases first (tsc consults them before node_modules), then
//                     the named package: its `exports` targets (substitution only) when it has
//                     them, else its `main`/index (bare root) or subpath (substitution/completion).
export function resolveTypescriptFallback(parentFile, spec, { conditions = new Set(), tsx = false, paths = null } = {}) {
  if (spec.startsWith('#')) {
    const scope = nearestPackage(parentFile)
    if (!scope?.pkg.imports) return null
    for (const target of manifestTargets(scope.pkg.imports, spec, conditions)) {
      const hit = probeTypescriptTarget(resolvePath(scope.pkgDir, target), { tsx, completion: false, dir: false })
      if (hit) return hit
    }
    return null
  }
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || isAbsolute(spec)) {
    const base = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
    return probeTypescriptTarget(base, { tsx, dirOnly: DIR_ONLY_SPEC.test(spec) })
  }
  if (paths && !IN_NODE_MODULES.test(parentFile)) {
    for (const target of paths.matchPaths(spec)) {
      const hit = probeTypescriptTarget(target, { tsx, dirOnly: target.endsWith('/') })
      if (hit) return hit
    }
  }
  const loc = locatePackage(dirname(parentFile), spec)
  if (!loc) return null
  const pkg = readJson(join(loc.pkgDir, 'package.json')) ?? {}
  if (pkg.exports != null) {
    // `exports` fully governs a bare import (main is not a fallback); targets name exact files.
    const key = loc.subpath === '' ? '.' : `./${loc.subpath}`
    for (const target of manifestTargets(pkg.exports, key, conditions)) {
      const hit = probeTypescriptTarget(resolvePath(loc.pkgDir, target), { tsx, completion: false, dir: false })
      if (hit) return hit
    }
    return null
  }
  if (loc.subpath === '') {
    // Bare package root: LOAD_AS_DIRECTORY only (never `node_modules/dep.ts`).
    return probeTypescriptTarget(loc.pkgDir, { tsx, dirOnly: true })
  }
  return probeTypescriptTarget(join(loc.pkgDir, loc.subpath), { tsx, dirOnly: DIR_ONLY_SPEC.test(spec) })
}
