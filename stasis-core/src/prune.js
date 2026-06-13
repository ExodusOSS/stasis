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
import { sha512integrity } from './state.util.js' // also runs the posix-sep assertion
import { isPlainObject, posixPathEscapes, splitNodeModulesPath } from './util.js'

const LOCKFILE = 'stasis.lock.json'

// Fields we copy (sanitised) from a dependency's on-disk package.json into the
// minimised rewrite. Everything else -- scripts, dependencies, engines, config,
// ... -- is dropped: it isn't recorded in the lockfile, isn't needed to resolve
// or load the package, and (scripts especially) is pure attack surface in an
// installed tree. `name`/`version` are NOT read from disk; they come from the
// lockfile, which is the attested source of the package's identity.
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
  // pnpm exports its settings as `npm_config_*` env vars to hooks and
  // lifecycle scripts. When the global virtual store is enabled, node_modules
  // is dominated by symlinks into a shared store; pruning would walk past
  // most files (we skip symlinks) and the lockfile-vs-disk comparison stops
  // being meaningful. Reject before touching anything.
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
    if (!dir.includes('node_modules')) continue // workspace sources, not pnpm-managed
    knownDirs.add(dir)
    for (const [rel, hash] of Object.entries(files)) {
      expected.set(`${dir}/${rel}`, hash)
    }
  }
  return { expected, knownDirs }
}

// True when `ref` (a package.json file reference like "./a.js", "a/b", "./dir")
// names a file the lockfile records for this module, so a rewritten manifest
// never points resolution at a path prune is about to delete. A ref that
// escapes the module (`..`/absolute) is rejected outright -- it can never name a
// recorded file. A subpath pattern ("./*") can't be enumerated against a fixed
// file list, but the only files left after prune are the attested ones -- so a
// (non-escaping) pattern can only ever resolve onto an attested file -- and it's
// kept as-is. `exact` selects the resolution discipline for a concrete path:
// exports/imports targets are matched verbatim (Node applies no CommonJS
// extension/index resolution to them), whereas main/module/browser/bin get the
// legacy expansion (`main: "lib"` -> `lib/index.js`).
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.node']

function normalizeRef(ref) {
  if (typeof ref !== 'string' || ref === '') return null
  if (posixPathEscapes(ref)) return null // leading/embedded `..` above root, or absolute
  return posix.normalize(ref).replace(/^\.\//u, '')
}

function referencesPresentFile(ref, present, { exact = false } = {}) {
  const base = normalizeRef(ref)
  if (base === null) return false // non-string, empty, escaping, or absolute
  if (base.includes('*')) return true // subpath pattern: unverifiable, kept (see above)
  if (present.has(base)) return true
  if (exact) return false // exports/imports targets resolve verbatim -- no extension/index fallback
  for (const ext of EXTENSIONS) if (present.has(base + ext)) return true
  for (const ext of EXTENSIONS) if (present.has(`${base}/index${ext}`)) return true
  return false
}

// Real exports/imports trees nest only a few conditions deep; anything past this
// is a malformed or hostile manifest. We cap the recursion (rather than risk a
// stack overflow that would abort the whole prune and leave the offending
// package's unattested files in place) and drop the over-deep subtree.
const MAX_TARGET_DEPTH = 64

// Recursively filter an exports/imports/browser subtree down to the mappings
// whose targets are still present. `allowBare` keeps bare specifiers (imports
// may map "#x" to another package; browser may stub/redirect a bare module);
// `allowFalse` keeps `false` (browser/react-native module stubbing); `exact` is
// passed through to referencesPresentFile (exports/imports match verbatim). A
// `null` target (exports/imports blocking a subpath) is always kept. An object
// or array that filters down to nothing is dropped, so we never emit an empty
// `exports: {}` -- which would block every subpath rather than fall back to
// `main`.
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

// Printable ASCII only: rejects the C0 (incl. DEL) and C1 control ranges and all
// non-ASCII, so a copied `license` can't smuggle control or escape characters.
const isAscii = (s) => /^[\x20-\x7e]*$/u.test(s)

// `browser`/`react-native`: a string (an alternate entry, like `main`) or a map
// of source path / bare module -> replacement file or `false` (stub). Returns
// the filtered value, or undefined to drop the field.
function browserField(value, present) {
  if (typeof value === 'string') return referencesPresentFile(value, present) ? value : undefined
  if (isPlainObject(value)) {
    const r = filterTargets(value, present, { allowBare: true, allowFalse: true, exact: false })
    if (r.keep) return r.value
  }
  return undefined
}

// The fields that govern how a package's own files resolve and load: the module
// system flag (`type`), the entry points (`main`/`module`/`browser`/
// `react-native`), and the subpath maps (`exports`/`imports`). Shared by the
// package root and by nested markers -- a nested marker is exactly this subset.
// Every file reference is filtered to a present (attested) file: exports/imports
// match verbatim (`exact`), the entry fields get Node's extension/index expansion.
function resolutionFields(pkg, present) {
  const out = { __proto__: null }

  // Only the two values Node honours; a flipped/garbage `type` is dropped so it
  // falls back to the default rather than recategorising the package's .js files.
  if (pkg.type === 'module' || pkg.type === 'commonjs') out.type = pkg.type

  if (referencesPresentFile(pkg.main, present)) out.main = pkg.main
  // `module`: non-standard ESM entry that bundlers (webpack/rollup/esbuild)
  // prefer over `main`; kept on the same "points at a present file" basis.
  if (referencesPresentFile(pkg.module, present)) out.module = pkg.module

  // Legacy / framework entry points read via bundler `mainFields`: `jsnext:main`
  // and `jsnext` (in Vite's default list -- dropping them downgrades an older
  // dep ESM->CJS under Vite) and `source` (Parcel, Metro/React Native). String
  // entries, kept like main/module; inert for resolvers that don't read them.
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

// Compute the sanitised field set for a package *root* package.json (the dir is
// a module the lockfile records). `name`/`version` are authoritative from the
// lockfile; the rest are copied from `pkg` (the untrusted on-disk manifest)
// only after passing their field-specific guard. On top of the shared
// resolution fields, a root also carries `license` and the package-level
// `bin`/`sideEffects`.
function minimalRootFields(pkg, { name, version, present }) {
  const fields = resolutionFields(pkg, present)

  // A short, plain-ASCII license string is harmless metadata; anything else
  // (object/array SPDX forms, long or non-ASCII blobs) is dropped.
  if (typeof pkg.license === 'string' && isAscii(pkg.license) && Buffer.byteLength(pkg.license) < 64) {
    fields.license = pkg.license
  }

  // bin: a string (one command, named after the package) or a map of
  // command -> file. Keep only entries that point at a present file.
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

  // sideEffects: a boolean is kept verbatim; an array is filtered to entries
  // that are present files (glob patterns are kept, see referencesPresentFile).
  // A list that filters to empty is dropped rather than emitted as `[]`, which
  // would assert "no side effects" and over-eagerly tree-shake.
  if (typeof pkg.sideEffects === 'boolean') {
    fields.sideEffects = pkg.sideEffects
  } else if (Array.isArray(pkg.sideEffects)) {
    const se = pkg.sideEffects.filter((e) => referencesPresentFile(e, present))
    if (se.length > 0) fields.sideEffects = se
  }

  // name/version first, then the copied fields in a stable order.
  const out = { name, version }
  for (const key of ROOT_FIELD_ORDER) if (key in fields) out[key] = fields[key]
  return out
}

// A nested package.json (e.g. a `dist/cjs/package.json` that flips the module
// system for that subtree) carries no package identity, so we drop name/version
// and the package-level fields (license/bin/sideEffects) and keep exactly the
// resolution fields, filtered relative to this dir. Dropping them outright -- as
// the old prune did, since their dir isn't a recorded module and they aren't in
// the lockfile file list -- would silently revert this subtree's .js files to
// the package root's module system and break `require('pkg/subdir')` and
// `#imports` resolution within it.
function minimalNestedFields(pkg, present) {
  return resolutionFields(pkg, present)
}

// A symlink is left in place only if its real target stays inside node_modules
// -- which is prune's entire attestation perimeter: it walks and hashes only
// node_modules (buildExpected skips non-node_modules dirs), so a link reaching
// outside it -- even elsewhere under the bundle root, e.g. a workspace package
// linked in -- would keep bytes prune never walks or attests reachable from the
// pruned tree, breaking "only attested bytes remain". pnpm's public
// `node_modules/<pkg>` links into `node_modules/.pnpm/...`, whose real bytes we
// walk directly there, so the link itself needs no validation or deletion. An
// escaping link fails closed; because this runs during the planning walk,
// before any unlink/rewrite, it aborts prune without touching disk. A dangling
// link points at nothing and can't leak, so it's left as-is.
//
// (Deliberately NOT the loaders' assertRealPathWithinBase: that bounds at the
// bundle root and rethrows ENOENT, whereas here the boundary is the narrower
// node_modules and a dangling link is tolerated.)
function assertSymlinkInternal(nodeModules, realNodeModules, linkPath) {
  let real
  try {
    real = realpathSync(linkPath)
  } catch (err) {
    if (err.code === 'ENOENT') return // dangling link
    throw err
  }
  const rel = relative(realNodeModules, real)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return // inside node_modules
  throw new Error(
    `stasis prune: symlink escapes node_modules: ${relative(dirname(nodeModules), linkPath)} -> ${real}`,
  )
}

function* walkFiles(nodeModules) {
  if (!existsSync(nodeModules)) return
  const realNodeModules = realpathSync(nodeModules)
  const stack = [nodeModules]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        assertSymlinkInternal(nodeModules, realNodeModules, full)
        continue
      }
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) yield full
    }
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
  const nodeModules = join(root, 'node_modules')
  const lockfile = loadLockfile(root)
  const { expected, knownDirs } = buildExpected(lockfile)

  // Plan first, mutate later: walk the tree, validate every tracked file,
  // collect the deletion and package.json-rewrite lists, and verify nothing in
  // the lockfile is missing. Bail with a thrown error before touching disk on
  // any failure.
  const toRemove = []
  const toMinimize = []
  const validated = []
  const kept = []
  const seen = new Set()
  const mismatches = []

  for (const full of walkFiles(nodeModules)) {
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

    // package.json files aren't enumerated in the lockfile (their contents
    // aren't recorded), but they're load-bearing for resolution, so rather than
    // keep them verbatim we rewrite them down to the minimal, lockfile-derived
    // field set when they belong to a module the lockfile recognises. A
    // package.json that IS in the lockfile (imported directly, so its bytes are
    // attested) took the hash-validated branch above and is kept in full.
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
          // The package.json itself survives prune, so it's always a legal
          // self-reference target (e.g. `exports: { "./package.json": ... }`).
          const present = new Set([...Object.keys(files), 'package.json'])
          next = minimalRootFields(pkg, { name, version, present })
        } else {
          // A nested package.json's file references are relative to its own
          // dir, so re-base the module's recorded files onto it before filtering.
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
      // package.json under a dir the lockfile doesn't own falls through and is
      // pruned like any other untracked file.
    }

    // Defense-in-depth: the path must resolve inside node_modules (no
    // symlink escape, no `..` traversal) before we queue it for deletion.
    assert.ok(
      full === nodeModules || full.startsWith(`${nodeModules}${sep}`),
      `refusing to remove path outside node_modules: ${full}`,
    )
    toRemove.push(full)
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
    // Replace, never modify in place: a dependency's package.json is commonly a
    // hardlink into pnpm's content-addressable store, so it shares an inode with
    // every other project (and other versions) linked from that store. An
    // in-place write would mutate all of them. Write a fresh file and rename it
    // over the entry -- atomic, and it breaks the hardlink, leaving the store
    // copy untouched.
    const tmp = `${full}.stasis-${process.pid}-${i}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, full)
    minimized.push(rel)
  }

  const removed = []
  const touchedDirs = new Set()
  for (const full of toRemove) {
    unlinkSync(full)
    removed.push(relative(root, full))
    touchedDirs.add(dirname(full))
  }

  const sortedDirs = [...touchedDirs].toSorted((a, b) => b.length - a.length)
  for (const d of sortedDirs) pruneEmptyDirs(d, nodeModules)

  return { removed, validated, kept, minimized }
}
