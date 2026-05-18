import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state.util.js' // also runs the posix-sep assertion

const LOCKFILE = 'stasis.lock.json'

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

function* walkFiles(nodeModules) {
  if (!existsSync(nodeModules)) return
  const stack = [nodeModules]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      // Skip symlinks: pnpm's flat node_modules symlinks into .pnpm; the file
      // bytes are reachable via the symlink targets which we also walk
      // directly when we descend into .pnpm.
      if (entry.isSymbolicLink()) continue
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
  // collect the deletion list, and verify nothing in the lockfile is
  // missing. Bail with a thrown error before touching disk on any failure.
  const toRemove = []
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

    // Package.json files are kept (without hash validation, since they may
    // not be enumerated in the lockfile) only when their containing dir is
    // a module recorded in the lockfile. Stray package.jsons under
    // node_modules dirs that the lockfile doesn't know about get pruned
    // along with the rest of those modules.
    if (basename(rel) === 'package.json' && knownDirs.has(dirname(rel))) {
      kept.push(rel)
      continue
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

  const removed = []
  const touchedDirs = new Set()
  for (const full of toRemove) {
    unlinkSync(full)
    removed.push(relative(root, full))
    touchedDirs.add(dirname(full))
  }

  const sortedDirs = [...touchedDirs].toSorted((a, b) => b.length - a.length)
  for (const d of sortedDirs) pruneEmptyDirs(d, nodeModules)

  return { removed, validated, kept }
}
