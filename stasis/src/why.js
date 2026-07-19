import { moduleFileKey } from '@exodus/stasis-core/util'
import { parseFile } from './parse.js'

// `stasis audit --why` support: from an artifact's resolution graph (`imports`)
// and its per-consumer provenance (`reason`), explain WHY a vulnerable module is
// present by listing the cross-module import chains that reach it.
//
// A "path" is a chain of node_modules packages ending at the target module, e.g.
// `a -> b -> c`. The first-party (`src`) node is never shown: a chain is walked
// back through cross-module edges and stops at a HEAD -- a module that a src file
// imports directly, OR one nothing else in node_modules imports (the top of its
// dependency subtree). So `a -> b -> c` surfaces even when no src file imports
// `a` directly (a is the top of the chain), and `b -> c` surfaces additionally
// when `b` is itself imported by src.
//
// The reason PREFIX names, per chain, the top-level importers of its head: the
// consumers (`run`, `StasisWebpack`, ...) that recorded the src files importing
// the head module -- `run: a -> b -> c`. Two consumers importing the same head
// yield two lines. When the head is not imported from top-level at all (e.g. a
// `scope=node_modules` bundle has no src), the head's OWN file reasons are used
// instead. A bundle with a single consumer omits the `reason` map entirely;
// there every chain renders bare, with no prefix.

// Cap on paths enumerated per target to bound pathological graphs (many diamond
// dependencies compound into a combinatorial number of simple paths). Hitting it
// is surfaced as a marker line rather than silently dropped.
const PATH_CAP = 2000

// Index one parsed artifact: map every project-relative file to its owning module
// dir, record each dir's package identity + whether it's a node_modules dep, and
// keep each dir's file list (for the head's-own-reason fallback).
function moduleIndex(artifact) {
  const fileToDir = new Map()
  const dirInfo = new Map()
  const dirFiles = new Map()
  for (const [dir, { name, version, files }] of artifact.modules) {
    dirInfo.set(dir, { name: name ?? null, version: version ?? null, dep: dir.includes('node_modules') })
    const list = []
    for (const rel of Object.keys(files)) {
      const f = moduleFileKey(dir, rel)
      fileToDir.set(f, dir)
      list.push(f)
    }
    dirFiles.set(dir, list)
  }
  return { fileToDir, dirInfo, dirFiles }
}

// Flatten the imports graph (conditions -> parent -> specifier -> target) into
// deduped file-level edges [parentFile, targetFile]. A `--metro` target may be a
// { platform: file } map; each platform's file becomes its own edge.
function fileEdges(imports) {
  const edges = []
  const seen = new Set()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [, target] of specifiers) {
        const targets = target instanceof Map ? [...target.values()] : [target]
        for (const t of targets) {
          const key = `${parent}\0${t}`
          if (seen.has(key)) continue
          seen.add(key)
          edges.push([parent, t])
        }
      }
    }
  }
  return edges
}

// The global cross-module graph:
//   adjRev:       depDir -> Set(dep predecessor dir)  -- dep->dep edges, reversed
//   srcImporters: depDir -> Set(src file)             -- src->dep edges, keeping
//                                                        the importing src file
// Intra-module edges and edges targeting a src module are irrelevant to a chain
// INTO a dependency and are dropped.
function moduleGraph(edges, fileToDir, dirInfo) {
  const adjRev = new Map()
  const srcImporters = new Map()
  for (const [pf, tf] of edges) {
    const pd = fileToDir.get(pf)
    const td = fileToDir.get(tf)
    if (pd === undefined || td === undefined || pd === td) continue
    if (!dirInfo.get(td).dep) continue
    if (dirInfo.get(pd).dep) {
      let set = adjRev.get(td)
      if (set === undefined) adjRev.set(td, (set = new Set()))
      set.add(pd)
    } else {
      let set = srcImporters.get(td)
      if (set === undefined) srcImporters.set(td, (set = new Set()))
      set.add(pf)
    }
  }
  return { adjRev, srcImporters }
}

// Invert the reason map to file -> Set(consumer). null when the artifact carries
// no reason map (single-consumer bundle / lockfile) -> chains render bare.
function invertReason(reason) {
  if (!reason) return null
  const byFile = new Map()
  for (const [consumer, list] of Object.entries(reason)) {
    if (!Array.isArray(list)) continue
    for (const f of list) {
      let set = byFile.get(f)
      if (set === undefined) byFile.set(f, (set = new Set()))
      set.add(consumer)
    }
  }
  return byFile
}

// The consumers that prefix a chain headed by `head`: those that recorded the
// src files importing `head` (its top-level importers). When `head` has no
// top-level importer (not imported from src), fall back to the consumers that
// recorded `head`'s own files. Empty when the artifact has no reason map.
function reasonsForHead(head, { srcImporters, dirFiles, fileReasons }) {
  if (fileReasons === null) return []
  const importers = srcImporters.get(head)
  const sources = importers && importers.size > 0 ? importers : (dirFiles.get(head) ?? [])
  const consumers = new Set()
  for (const f of sources) {
    for (const c of fileReasons.get(f) ?? []) consumers.add(c)
  }
  return [...consumers]
}

// Every simple dep-only path that ends at `targetDir`, walking predecessors
// backward and emitting a path each time its head is a HEAD node (`isHead`).
// Returns dirs head-first; `truncated` flags the cap.
function pathsTo(adjRev, isHead, targetDir) {
  const results = []
  let truncated = false
  const walk = (node, suffix, inPath) => {
    if (results.length >= PATH_CAP) {
      truncated = true
      return
    }
    if (isHead(node)) results.push(suffix)
    for (const pred of adjRev.get(node) ?? []) {
      if (inPath.has(pred)) continue // no repeated module -> break cycles
      inPath.add(pred)
      walk(pred, [pred, ...suffix], inPath)
      inPath.delete(pred)
    }
  }
  walk(targetDir, [targetDir], new Set([targetDir]))
  return { results, truncated }
}

// Map each targeted package (`name@version`) to the set of `--why` lines for it.
// `targetKeys` (optional) restricts work to the packages that matter (the ones
// carrying advisories); omit it to compute for every node_modules package.
// Artifacts without a resolution graph (`imports`) contribute nothing.
export function collectWhy(files, targetKeys) {
  const byPkg = new Map()
  for (const file of files) {
    const artifact = parseFile(file)
    const imports = artifact.imports
    if (!imports || imports.size === 0) continue

    const { fileToDir, dirInfo, dirFiles } = moduleIndex(artifact)
    const edges = fileEdges(imports)
    const { adjRev, srcImporters } = moduleGraph(edges, fileToDir, dirInfo)
    const fileReasons = invertReason(artifact.reason)
    // A head tops a chain: a src file imports it directly, or nothing in
    // node_modules imports it (no dep predecessor).
    const isHead = (node) => srcImporters.has(node) || !adjRev.has(node)

    // Group target dirs by `name@version` (a package can appear at several dirs,
    // e.g. nested node_modules); paths from every matching dir are unioned.
    const dirsByKey = new Map()
    for (const [dir, info] of dirInfo) {
      if (!info.dep || !info.name || !info.version) continue
      const key = `${info.name}@${info.version}`
      if (targetKeys && !targetKeys.has(key)) continue
      let arr = dirsByKey.get(key)
      if (arr === undefined) dirsByKey.set(key, (arr = []))
      arr.push(dir)
    }
    if (dirsByKey.size === 0) continue

    for (const [key, dirs] of dirsByKey) {
      let set = byPkg.get(key)
      const add = (line) => {
        if (set === undefined) byPkg.set(key, (set = new Set()))
        set.add(line)
      }
      for (const targetDir of dirs) {
        const { results, truncated } = pathsTo(adjRev, isHead, targetDir)
        for (const p of results) {
          const chain = p.map((d) => dirInfo.get(d)?.name ?? d).join(' -> ')
          const reasons = reasonsForHead(p[0], { srcImporters, dirFiles, fileReasons })
          if (reasons.length === 0) add(chain)
          else for (const r of reasons.toSorted((a, b) => a.localeCompare(b))) add(`${r}: ${chain}`)
        }
        if (truncated) add(`… (${PATH_CAP}+ paths, truncated)`)
      }
    }
  }
  return byPkg
}
