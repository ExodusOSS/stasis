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
// The reasons shown for a flagged package are EXACTLY the ones that recorded the
// package itself -- the same set the non-`--why` column reports (see collectReasons).
// `--why` only adds, per reason, HOW that reason reaches it. So a consumer that
// imports a package but never recorded it (externalized it) is not one of its
// reasons and is never shown; and every reason that did record it appears, at least
// as a bare line.
//
// The per-reason PATH is file-level. A consumer "has" the edge `b -> c` only if it
// recorded the specific file in `b` that imports `c`, so a chain belongs to a
// consumer only when it recorded the file forming EVERY edge -- `metro: a -> b -> c`
// can't appear if the file importing `c` from `b` isn't metro's. Each reason's
// chains are enumerated on its own subgraph (only its edges), so it shows its
// MAXIMAL file-level path: if metro's edges only reach up to `b`, its line is the
// shorter `metro: b -> c`; a reason that recorded the package but never imports it
// through the graph shows a bare `metro: c`. A bundle with a single consumer omits
// the `reason` map entirely; there every chain renders bare, with no prefix.

// Cap on paths enumerated per target to bound pathological graphs (many diamond
// dependencies compound into a combinatorial number of simple paths). Hitting it
// is surfaced as a marker line rather than silently dropped.
const PATH_CAP = 2000

// Packages a chain never walks PAST: everything imports these build/runtime hubs,
// so continuing up from them just adds noise. When a chain reaches one it stops
// there, and the hub becomes the chain's head (`@babel/core -> a -> b -> c`),
// still prefixed with its own reason.
const TERMINAL_PACKAGES = new Set(['@babel/core', 'react-native', 'metro'])

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

// Per-reason cross-module subgraphs. Every import edge is a FILE edge (a specific
// file in the parent importing the target), and a consumer only "has" that edge if
// it recorded the PARENT file. So a chain belongs to a reason only when that reason
// bundled the file forming EVERY one of its edges. We build one subgraph per
// consumer (bucket) -- holding only the edges that consumer's files created -- and
// later enumerate that consumer's chains on it. With no reason map there is a single
// bucket '' holding the full graph (chains render bare). Each subgraph:
//   adjRev:       depDir -> Set(dep predecessor dir)  -- dep->dep edges, reversed
//   srcImporters: depDir -> Set(src file)             -- src->dep edges
// Intra-module edges and edges into a src module are dropped.
function bucketGraphs(edges, fileToDir, dirInfo, fileReasons) {
  const graphs = new Map()
  const graphFor = (bucket) => {
    let g = graphs.get(bucket)
    if (g === undefined) graphs.set(bucket, (g = { adjRev: new Map(), srcImporters: new Map() }))
    return g
  }
  for (const [pf, tf] of edges) {
    const pd = fileToDir.get(pf)
    const td = fileToDir.get(tf)
    if (pd === undefined || td === undefined || pd === td) continue
    // `react-native` reads sibling packages' `package.json` manifests for metadata
    // (Haste/asset resolution), not as real dependencies -- don't let those edges
    // pull unrelated packages into the --why graph.
    if (dirInfo.get(pd).name === 'react-native' && tf.endsWith('/package.json')) continue
    if (!dirInfo.get(td).dep) continue
    // The consumers this edge belongs to: those that recorded its parent file.
    const buckets = fileReasons === null ? [''] : (fileReasons.get(pf) ?? [])
    const dep = dirInfo.get(pd).dep
    for (const bucket of buckets) {
      const map = dep ? graphFor(bucket).adjRev : graphFor(bucket).srcImporters
      let set = map.get(td)
      if (set === undefined) map.set(td, (set = new Set()))
      set.add(dep ? pd : pf)
    }
  }
  if (fileReasons === null) graphFor('') // the bare bucket exists even with no edges
  return graphs
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

// dir -> Set(consumer): the consumers that recorded any of the dir's own files.
// null when the artifact has no reason map. Used to decide whether a bare target
// belongs to a reason that never imports it (a flagged package a bundler shipped).
function dirReasonsIndex(dirFiles, fileReasons) {
  if (fileReasons === null) return null
  const byDir = new Map()
  for (const [dir, files] of dirFiles) {
    let set
    for (const f of files) for (const c of fileReasons.get(f) ?? []) (set ??= new Set()).add(c)
    if (set !== undefined) byDir.set(dir, set)
  }
  return byDir
}

// Every simple dep-only path (within one reason's subgraph) that ends at
// `targetDir`, walking predecessors backward and emitting a path each time its
// head is a HEAD node (`isHead`) or a terminal package (`isTerminal`). A terminal
// node ALSO stops the walk -- the chain never goes past @babel/core / react-native
// / metro, and this applies to `targetDir` too: a terminal target is emitted bare
// (just `[targetDir]`), never climbed above. Its provenance instead comes from the
// reason whose subgraph this is. Returns dirs head-first; `truncated` flags the cap.
function pathsTo(adjRev, isHead, isTerminal, targetDir) {
  const results = []
  let truncated = false
  const walk = (node, suffix, inPath) => {
    if (results.length >= PATH_CAP) {
      truncated = true
      return
    }
    const terminal = isTerminal(node)
    if (isHead(node) || terminal) results.push(suffix)
    if (terminal) return // don't walk past @babel/core / react-native / metro
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

// Compress one reason bucket's chains (node-name arrays, all ending at the same
// target). Chains are emitted shortest-first (then alphabetically); each collapses
// at the earliest node whose remaining sub-path to the target is already
// recoverable from the lines above it, rendering `prefix -> node -> ... -> target`.
// A sub-path is recoverable once ANY emitted line shows its head node in the
// line's visible part -- a full line shows every node, a collapsed line its prefix
// down to the collapse point -- because from there the earlier lines spell out the
// rest. So a repeated tail is written out once and referenced with `...`
// everywhere else, transitively:
//   D -> C -> B -> A          (full)
//   P -> E -> D -> ... -> A   (D's tail is in the full line)
//   Q -> E -> ... -> A        (E's tail is now visible in P's line)
//   G -> F -> E -> ... -> A
//   H -> F -> ... -> A        (F's tail is visible in G's line)
// A collapse hides only nodes between the visible ones and the target, and lines
// that collapse to identical text are emitted once (a hub reached by several shown
// sub-paths yields a single `importer -> hub -> ... -> target` per importer).
function compressChains(chains) {
  const full = (c) => c.join(' -> ')
  const suffixKey = (c, i) => c.slice(i).join('\0')
  const uniq = [...new Map(chains.map((c) => [full(c), c])).values()]
  if (uniq.length <= 1) return uniq.map(full)
  const sorted = uniq.toSorted((a, b) => a.length - b.length || full(a).localeCompare(full(b)))
  const target = sorted[0][sorted[0].length - 1]

  const revealed = new Set() // sub-paths recoverable from lines already emitted
  const out = []
  const seen = new Set()
  const push = (line) => {
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  for (const c of sorted) {
    // Collapse at the longest proper tail (earliest position, >= 3 nodes so >= 1 is
    // hidden) that an earlier line already made recoverable.
    let at = -1
    for (let i = 1; c.length - i >= 3; i++) {
      if (revealed.has(suffixKey(c, i))) {
        at = i
        break
      }
    }
    // Index of the last node this line shows: all of them when full, the collapse
    // point otherwise.
    const visible = at === -1 ? c.length - 1 : at
    if (at === -1) push(full(c))
    else push(`${c.slice(0, at + 1).join(' -> ')} -> ... -> ${target}`)
    // Every sub-path headed by a node this line shows is now recoverable.
    for (let i = 0; i <= visible; i++) revealed.add(suffixKey(c, i))
  }
  return out
}

// Map each targeted package (`name@version`) to its ordered `--why` lines.
// `targetKeys` (optional) restricts work to the packages that matter (the ones
// carrying advisories); omit it to compute for every node_modules package.
// `reasonFilter` (optional, from --reason) keeps only chains attributed to that
// consumer, dropping every other chain (and bare, unattributed chains).
// Chains are deduplicated and compressed per reason bucket (see compressChains).
// Artifacts without a resolution graph (`imports`) contribute nothing.
export function collectWhy(files, targetKeys, reasonFilter = null) {
  // key -> reason bucket ('' = unattributed) -> Map(chainKey -> node-name array)
  const acc = new Map()
  const truncatedKeys = new Set()
  const bucketChains = (key, bucket) => {
    let buckets = acc.get(key)
    if (buckets === undefined) acc.set(key, (buckets = new Map()))
    let chains = buckets.get(bucket)
    if (chains === undefined) buckets.set(bucket, (chains = new Map()))
    return chains
  }
  const addChain = (key, bucket, nodes) => bucketChains(key, bucket).set(nodes.join('\0'), nodes)

  const EMPTY_GRAPH = { adjRev: new Map(), srcImporters: new Map() }

  for (const file of files) {
    const artifact = parseFile(file)
    const imports = artifact.imports
    if (!imports || imports.size === 0) continue

    const { fileToDir, dirInfo, dirFiles } = moduleIndex(artifact)
    const edges = fileEdges(imports)
    const fileReasons = invertReason(artifact.reason)
    const graphs = bucketGraphs(edges, fileToDir, dirInfo, fileReasons)
    const dirReasons = dirReasonsIndex(dirFiles, fileReasons)
    // Terminal packages end a chain regardless of what imports them.
    const isTerminal = (node) => TERMINAL_PACKAGES.has(dirInfo.get(node)?.name)

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
      for (const targetDir of dirs) {
        // The reasons to report are exactly the ones the FLAGGED package itself was
        // recorded under -- identical to the non-`--why` column (see collectReasons).
        // For each, enumerate that reason's MAXIMAL file-level chains on its own
        // subgraph; a reason that recorded the package but doesn't import it through
        // the graph still yields a bare line. A reason that IMPORTS the package but
        // never recorded it (externalized it) is not one of the package's reasons and
        // is not shown -- so the --why reason set matches non-`--why` exactly.
        const own = fileReasons === null ? [''] : (dirReasons.get(targetDir) ?? [])
        for (const bucket of own) {
          if (reasonFilter !== null && bucket !== reasonFilter) continue
          const { adjRev, srcImporters } = graphs.get(bucket) ?? EMPTY_GRAPH
          // A head tops a chain: a src file imports it directly, or nothing else
          // in this bucket's graph imports it.
          const isHead = (node) => srcImporters.has(node) || !adjRev.has(node)
          const { results, truncated } = pathsTo(adjRev, isHead, isTerminal, targetDir)
          if (truncated) truncatedKeys.add(key)
          for (const p of results) {
            const nodes = p.map((d) => dirInfo.get(d)?.name ?? d)
            addChain(key, reasonFilter !== null ? '' : bucket, nodes)
          }
        }
      }
    }
  }

  // Compress each bucket and render, bucket by bucket (buckets sorted so a
  // consumer's chains group together; bare '' sorts first).
  const byPkg = new Map()
  for (const [key, buckets] of acc) {
    const lines = []
    for (const bucket of [...buckets.keys()].toSorted((a, b) => a.localeCompare(b))) {
      for (const rendered of compressChains([...buckets.get(bucket).values()])) {
        lines.push(bucket ? `${bucket}: ${rendered}` : rendered)
      }
    }
    if (truncatedKeys.has(key)) lines.push(`… (${PATH_CAP}+ paths, truncated)`)
    byPkg.set(key, lines)
  }
  return byPkg
}
