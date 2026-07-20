import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js' // also runs the posix-sep assertion
import { hasNodeModulesSegment, isPlainObject, moduleFileKey, posixPathEscapes, splitNodeModulesPath } from './util.js'

const LOCKFILE = 'stasis.lock.json'

// Fields copied (sanitised) from a dependency's on-disk package.json into the minimised rewrite.
// Everything else is dropped -- unneeded to resolve/load, and (scripts especially) attack surface.
// `name`/`version` are NOT read from disk; they come from the lockfile, the attested identity.
const ROOT_FIELD_ORDER = [
  'license',
  'type',
  'main',
  'module',
  'jsnext:main',
  'jsnext',
  'source',
  'browser',
  'react-native',
  'bin',
  'sideEffects',
  'exports',
  'imports',
]

function assertGlobalVirtualStoreDisabled() {
  // With pnpm's global virtual store enabled, node_modules is dominated by symlinks into a shared
  // store; prune skips symlinks, so the lockfile-vs-disk comparison stops being meaningful.
  const env = process.env.npm_config_enable_global_virtual_store
  if (env !== undefined && env !== 'false' && env !== '') {
    throw new Error(
      `stasis prune: enableGlobalVirtualStore must be false, got ${JSON.stringify(env)}`,
    )
  }
}

function loadLockfile(root) {
  const path = join(root, LOCKFILE)
  assert.ok(existsSync(path), `stasis prune: ${LOCKFILE} not found at ${path}`)
  return Lockfile.parse(readFileSync(path, 'utf8'))
}

function buildExpected(lockfile) {
  const expected = new Map()
  const knownDirs = new Set()
  for (const [dir, { files }] of lockfile.modules) {
    if (!hasNodeModulesSegment(dir)) continue // workspace sources, not pnpm-managed
    knownDirs.add(dir)
    for (const [rel, hash] of Object.entries(files)) {
      // moduleFileKey (not `${dir}/${rel}`): a package ROOT readdir records rel === '', whose
      // trailing-slash join would wrongly demand a file at `node_modules/<pkg>/`.
      const file = moduleFileKey(dir, rel)
      // A `directory` entry is a hash-attested JSON listing, not a file on disk; excluding it
      // avoids demanding a regular file there ("missing on disk").
      if (lockfile.formats?.get(file) === 'directory') continue
      expected.set(file, hash)
    }
  }
  return { expected, knownDirs }
}

// True when `ref` names a file the lockfile records, so a rewritten manifest never points
// resolution at a path prune is about to delete. An escaping ref is rejected; a subpath pattern
// ("./*") is unverifiable but kept. `exact` picks the resolution discipline: exports/imports match
// verbatim, main/module/browser/bin get the legacy extension/index expansion.
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.node']

function normalizeRef(ref) {
  if (typeof ref !== 'string' || ref === '') return null
  if (posixPathEscapes(ref)) return null
  return posix.normalize(ref).replace(/^\.\//u, '')
}

function referencesPresentFile(ref, present, { exact = false } = {}) {
  const base = normalizeRef(ref)
  if (base === null) return false
  if (base.includes('*')) return true // subpath pattern: unverifiable, kept (see above)
  if (present.has(base)) return true
  if (exact) return false // exports/imports targets resolve verbatim -- no extension/index fallback
  for (const ext of EXTENSIONS) if (present.has(base + ext)) return true
  for (const ext of EXTENSIONS) if (present.has(`${base}/index${ext}`)) return true
  return false
}

// Real exports/imports trees nest only a few deep; cap the recursion and drop the over-deep
// subtree rather than risk a stack overflow that aborts the whole prune.
const MAX_TARGET_DEPTH = 64

// Recursively filter an exports/imports/browser subtree to mappings whose targets are present.
// `allowBare` keeps bare specifiers, `allowFalse` keeps `false` (stubbing), `exact` passes through.
// A `null` target is always kept. An object/array filtering to nothing is dropped, so we never emit
// an empty `exports: {}` -- which would block every subpath instead of falling back to `main`.
function filterTargets(value, present, opts, depth = 0) {
  if (depth > MAX_TARGET_DEPTH) return { keep: false }
  const { allowBare, allowFalse, exact } = opts
  if (value === null) return { keep: true, value: null }
  if (value === false) return allowFalse ? { keep: true, value: false } : { keep: false }
  if (typeof value === 'string') {
    if (value.startsWith('.')) {
      return referencesPresentFile(value, present, { exact }) ? { keep: true, value } : { keep: false }
    }
    return allowBare ? { keep: true, value } : { keep: false }
  }
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const r = filterTargets(item, present, opts, depth + 1)
      if (r.keep) out.push(r.value)
    }
    return out.length > 0 ? { keep: true, value: out } : { keep: false }
  }
  if (isPlainObject(value)) {
    const out = {}
    let any = false
    for (const [k, v] of Object.entries(value)) {
      const r = filterTargets(v, present, opts, depth + 1)
      if (r.keep) {
        out[k] = r.value
        any = true
      }
    }
    return any ? { keep: true, value: out } : { keep: false }
  }
  return { keep: false }
}

// Printable ASCII only, so a copied `license` can't smuggle control or escape characters.
const isAscii = (s) => /^[\x20-\x7e]*$/u.test(s)

// `browser`/`react-native`: a string (alternate entry) or a map of path/module -> replacement or
// `false` (stub). Returns the filtered value, or undefined to drop the field.
function browserField(value, present) {
  if (typeof value === 'string') return referencesPresentFile(value, present) ? value : undefined
  if (isPlainObject(value)) {
    const r = filterTargets(value, present, { allowBare: true, allowFalse: true, exact: false })
    if (r.keep) return r.value
  }
  return undefined
}

// Fields governing how a package's own files resolve and load (`type`, entry points, `exports`/
// `imports`). Every file reference is filtered to a present (attested) file: exports/imports match
// verbatim (`exact`), entry fields get Node's extension/index expansion.
function resolutionFields(pkg, present) {
  const out = { __proto__: null }

  // Only the two values Node honours; a garbage `type` is dropped so it falls back to the default
  // rather than recategorising the package's .js files.
  if (pkg.type === 'module' || pkg.type === 'commonjs') out.type = pkg.type

  if (referencesPresentFile(pkg.main, present)) out.main = pkg.main
  // `module`: non-standard ESM entry bundlers prefer over `main`; kept on the same basis.
  if (referencesPresentFile(pkg.module, present)) out.module = pkg.module

  // Legacy/framework entry points read via bundler `mainFields`: dropping `jsnext`/`jsnext:main`
  // downgrades an older dep ESM->CJS under Vite; `source` is Parcel/Metro. Kept like main/module.
  for (const field of ['jsnext:main', 'jsnext', 'source']) {
    if (referencesPresentFile(pkg[field], present)) out[field] = pkg[field]
  }

  for (const field of ['browser', 'react-native']) {
    const v = browserField(pkg[field], present)
    if (v !== undefined) out[field] = v
  }

  const exp = filterTargets(pkg.exports, present, { allowBare: false, allowFalse: false, exact: true })
  if (exp.keep) out.exports = exp.value
  const imp = filterTargets(pkg.imports, present, { allowBare: true, allowFalse: false, exact: true })
  if (imp.keep) out.imports = imp.value

  return out
}

// Sanitised field set for a package *root* package.json. `name`/`version` are authoritative from
// the lockfile; the rest are copied from the untrusted on-disk `pkg` only after a field-specific
// guard. Beyond the resolution fields, a root also carries `license` and `bin`/`sideEffects`.
function minimalRootFields(pkg, { name, version, present }) {
  const fields = resolutionFields(pkg, present)

  // A short, plain-ASCII license string is harmless metadata; anything else is dropped.
  if (typeof pkg.license === 'string' && isAscii(pkg.license) && Buffer.byteLength(pkg.license) < 64) {
    fields.license = pkg.license
  }

  // bin: a string or a map of command -> file. Keep only entries that point at a present file.
  if (typeof pkg.bin === 'string') {
    if (referencesPresentFile(pkg.bin, present)) fields.bin = pkg.bin
  } else if (isPlainObject(pkg.bin)) {
    const bin = {}
    let any = false
    for (const [cmd, target] of Object.entries(pkg.bin)) {
      if (typeof target === 'string' && referencesPresentFile(target, present)) {
        bin[cmd] = target
        any = true
      }
    }
    if (any) fields.bin = bin
  }

  // sideEffects: a boolean is kept verbatim; an array is filtered to present files. A list filtering
  // to empty is dropped, not emitted as `[]` -- which would assert "no side effects" and over-tree-shake.
  if (typeof pkg.sideEffects === 'boolean') {
    fields.sideEffects = pkg.sideEffects
  } else if (Array.isArray(pkg.sideEffects)) {
    const se = pkg.sideEffects.filter((e) => referencesPresentFile(e, present))
    if (se.length > 0) fields.sideEffects = se
  }

  const out = { name, version }
  for (const key of ROOT_FIELD_ORDER) if (key in fields) out[key] = fields[key]
  return out
}

// A nested package.json (e.g. `dist/cjs/package.json` flipping the module system for that subtree)
// carries no package identity, so keep only the resolution fields, filtered relative to this dir.
// Dropping it outright would silently revert this subtree's .js files to the root's module system.
function minimalNestedFields(pkg, present) {
  return resolutionFields(pkg, present)
}

const PNPM_WORKSPACE = 'pnpm-workspace.yaml'

// A pnpm workspace root is marked by a pnpm-workspace.yaml. In a workspace, prune covers every
// package's node_modules and widens the symlink-containment boundary from node_modules to the whole
// workspace (a dep legitimately links to a sibling package's source dir). Otherwise it stays at node_modules.
function isPnpmWorkspaceRoot(root) {
  return existsSync(join(root, PNPM_WORKSPACE))
}

// Every node_modules directory in the workspace. Don't descend into a node_modules once found (prune
// walks its internals) nor into dotdirs, and never leave `root`.
function discoverNodeModulesDirs(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        // Only a real node_modules dir is a prune target. A symlinked one is skipped; if the
        // lockfile records files under it, prune fails closed ("missing on disk").
        if (entry.isDirectory()) found.push(full)
        continue // don't descend; prune walks node_modules internals itself
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return found
}

// A symlink is left in place only if its real target stays inside `boundary` -- prune's containment
// perimeter; a link reaching outside would keep bytes prune never walks. An escaping link fails
// closed during the planning walk, before any unlink/rewrite. A dangling link can't leak, left as-is.
// (Deliberately NOT the loaders' assertRealPathWithinBase, which rethrows ENOENT.)
function assertSymlinkInternal({ root, realBoundary, label }, linkPath) {
  let real
  try {
    real = realpathSync(linkPath)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  const rel = relative(realBoundary, real)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error(`stasis prune: symlink escapes ${label}: ${relative(root, linkPath)} -> ${real}`)
}

function* walkFiles(nmRoot, ctx) {
  if (!existsSync(nmRoot)) return
  const stack = [nmRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        assertSymlinkInternal(ctx, full)
        continue
      }
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) yield full
    }
  }
}

// Walk every node_modules root, tagging each file with the root it came from so
// deletion and empty-dir pruning stay scoped to that node_modules.
function* walkAll(nmRoots, ctx) {
  for (const nmRoot of nmRoots) {
    for (const full of walkFiles(nmRoot, ctx)) yield { full, nmRoot }
  }
}

function pruneEmptyDirs(dir, stopAt) {
  while (dir.startsWith(stopAt) && dir !== stopAt && existsSync(dir)) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      rmdirSync(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export function prune({ root = process.cwd() } = {}) {
  assertGlobalVirtualStoreDisabled()
  root = resolve(root)
  const workspace = isPnpmWorkspaceRoot(root)
  const nmRoots = workspace ? discoverNodeModulesDirs(root) : [join(root, 'node_modules')]
  const boundary = workspace ? root : join(root, 'node_modules')
  const ctx = {
    root,
    realBoundary: existsSync(boundary) ? realpathSync(boundary) : boundary,
    label: workspace ? 'the workspace' : 'node_modules',
  }
  const lockfile = loadLockfile(root)
  const { expected, knownDirs } = buildExpected(lockfile)

  // Plan first, mutate later: validate every tracked file and collect the deletion/rewrite lists,
  // bailing with a thrown error before touching disk on any failure.
  const toRemove = []
  const toMinimize = []
  const validated = []
  const kept = []
  const seen = new Set()
  const mismatches = []

  for (const { full, nmRoot } of walkAll(nmRoots, ctx)) {
    const rel = relative(root, full)
    const expectedHash = expected.get(rel)
    if (expectedHash !== undefined) {
      seen.add(rel)
      const actual = sha512integrity(readFileSync(full))
      if (actual === expectedHash) {
        validated.push(rel)
        kept.push(rel)
      } else {
        mismatches.push({ rel, expected: expectedHash, actual })
      }
      continue
    }

    // package.json files aren't enumerated in the lockfile but are load-bearing for resolution, so
    // we rewrite them to the minimal, lockfile-derived field set when they belong to a recognised
    // module. One that IS in the lockfile took the hash-validated branch above and is kept in full.
    if (basename(rel) === 'package.json') {
      const owner = splitNodeModulesPath(rel)
      if (owner && knownDirs.has(owner.dir)) {
        const raw = readFileSync(full, 'utf8')
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        const pkg = isPlainObject(parsed) ? parsed : {}
        let next
        if (dirname(rel) === owner.dir) {
          const { name, version, files } = lockfile.modules.get(owner.dir)
          // The package.json itself survives prune, so it's always a legal self-reference target.
          const present = new Set([...Object.keys(files), 'package.json'])
          next = minimalRootFields(pkg, { name, version, present })
        } else {
          // A nested package.json's file references are relative to its own dir, so re-base the
          // module's recorded files onto it before filtering.
          const { files } = lockfile.modules.get(owner.dir)
          const prefix = `${relative(owner.dir, dirname(rel))}/`
          const present = new Set(['package.json'])
          for (const f of Object.keys(files)) {
            if (f.startsWith(prefix)) present.add(f.slice(prefix.length))
          }
          next = minimalNestedFields(pkg, present)
        }
        const newText = `${JSON.stringify(next, undefined, 2)}\n`
        kept.push(rel)
        if (newText !== raw) toMinimize.push({ full, rel, text: newText })
        continue
      }
    }

    // Defense-in-depth: the path must resolve inside the node_modules we're walking before we
    // queue it for deletion, so prune never deletes anything outside a node_modules.
    assert.ok(
      full.startsWith(`${nmRoot}${sep}`),
      `refusing to remove path outside node_modules: ${full}`,
    )
    toRemove.push({ full, nmRoot })
  }

  const missing = []
  for (const [rel] of expected) {
    if (!seen.has(rel)) missing.push(rel)
  }

  if (mismatches.length > 0) {
    const lines = mismatches.map(({ rel, expected: exp, actual }) =>
      `  ${rel}: expected ${exp}, got ${actual}`).join('\n')
    throw new Error(`stasis prune: hash mismatch for ${mismatches.length} file(s):\n${lines}`)
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).join(', ')
    const suffix = missing.length > 5 ? `, ... (${missing.length} total)` : ''
    throw new Error(`stasis prune: files listed in lockfile are missing on disk: ${sample}${suffix}`)
  }

  const minimized = []
  for (const [i, { full, rel, text }] of toMinimize.entries()) {
    // Replace, never modify in place: a dependency's package.json is commonly a hardlink into
    // pnpm's store, so an in-place write would mutate every project sharing that inode. Write a
    // fresh file and rename over: atomic, and it breaks the hardlink.
    const tmp = `${full}.stasis-${process.pid}-${i}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, full)
    minimized.push(rel)
  }

  const removed = []
  const touchedDirs = new Map() // dir -> the node_modules root under it (prune stops there)
  for (const { full, nmRoot } of toRemove) {
    unlinkSync(full)
    removed.push(relative(root, full))
    touchedDirs.set(dirname(full), nmRoot)
  }

  const sortedDirs = [...touchedDirs.keys()].toSorted((a, b) => b.length - a.length)
  for (const d of sortedDirs) pruneEmptyDirs(d, touchedDirs.get(d))

  return { removed, validated, kept, minimized }
}
