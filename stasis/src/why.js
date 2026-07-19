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
// consumers (`run`, `webpack`, ...) that recorded the src files importing
// the head module -- `run: a -> b -> c`. Two consumers importing the same head
// yield two lines. When the head is not imported from top-level at all (e.g. a
// `scope=node_modules` bundle has no src), the head's OWN file reasons are used
// instead. A bundle with a single consumer omits the `reason` map entirely;
// there every chain renders bare, with no prefix.

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
    // `react-native` reads sibling packages' `package.json` manifests for metadata
    // (Haste/asset resolution), not as real dependencies -- don't let those edges
    // pull unrelated packages into the --why graph.
    if (dirInfo.get(pd).name === 'react-native' && tf.endsWith('/package.json')) continue
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
// backward and emitting a path each time its head is a HEAD node (`isHead`) or a
// terminal package (`isTerminal`). A terminal predecessor heads a chain and is
// never walked past. The target itself is ALWAYS walked up from, so a terminal
// package that IS the audited target still lists the chains that reach it.
// Returns dirs head-first; `truncated` flags the cap.
function pathsTo(adjRev, isHead, isTerminal, targetDir) {
  const results = []
  let truncated = false
  const push = (suffix) => {
    if (results.length >= PATH_CAP) {
      truncated = true
      return
    }
    results.push(suffix)
  }
  const walk = (node, suffix, inPath) => {
    if (results.length >= PATH_CAP) {
      truncated = true
      return
    }
    if (isHead(node)) push(suffix)
    for (const pred of adjRev.get(node) ?? []) {
      if (inPath.has(pred)) continue // no repeated module -> break cycles
      if (isTerminal(pred)) {
        push([pred, ...suffix]) // terminal head; don't walk past it
        continue
      }
      inPath.add(pred)
      walk(pred, [pred, ...suffix], inPath)
      inPath.delete(pred)
    }
  }
  walk(targetDir, [targetDir], new Set([targetDir]))
  return { results, truncated }
}

// Compress one reason bucket's chains (node-name arrays, all ending at the same
// target) into rendered lines. A chain that is a proper suffix of a longer one
// is redundant -- its full form already shows inside that longer chain -- so it
// collapses to `head -> ... -> target` (only when there is an interior to hide,
// i.e. length >= 3; a 1- or 2-node chain has nothing to elide and stays whole).
// Distinct chains can collapse to the same abbreviation, so rendered forms are
// deduped. Order places highly-reused chains (those that subsume the most
// others) first so the rest read as references to them, then alphabetically.
function compressChains(chains) {
  const chainKey = (c) => c.join('\0')
  const present = new Set(chains.map(chainKey))
  // Every proper suffix that occurs across the bucket; a chain is "covered" when
  // it is itself a proper suffix of some longer chain here.
  const properSuffixes = new Set()
  for (const c of chains) for (let i = 1; i < c.length; i++) properSuffixes.add(chainKey(c.slice(i)))
  const covered = (c) => properSuffixes.has(chainKey(c))
  // reuse(c) = how many other chains are a proper suffix OF c (c subsumes them).
  const reuse = (c) => {
    let n = 0
    for (let i = 1; i < c.length; i++) if (present.has(chainKey(c.slice(i)))) n += 1
    return n
  }
  const render = (c) => (covered(c) && c.length >= 3 ? `${c[0]} -> ... -> ${c[c.length - 1]}` : c.join(' -> '))
  const best = new Map() // rendered line -> highest reuse score seen for it
  for (const c of chains) {
    const line = render(c)
    const score = reuse(c)
    if (!best.has(line) || best.get(line) < score) best.set(line, score)
  }
  return [...best.keys()].toSorted((a, b) => best.get(b) - best.get(a) || a.localeCompare(b))
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
        const { results, truncated } = pathsTo(adjRev, isHead, isTerminal, targetDir)
        if (truncated) truncatedKeys.add(key)
        for (const p of results) {
          const nodes = p.map((d) => dirInfo.get(d)?.name ?? d)
          const reasons = reasonsForHead(p[0], { srcImporters, dirFiles, fileReasons })
          if (reasonFilter) {
            // Keep this chain only when the requested consumer accounts for it;
            // an unattributed (bare) chain can never match a named reason.
            if (reasons.includes(reasonFilter)) addChain(key, reasonFilter, nodes)
          } else if (reasons.length === 0) {
            addChain(key, '', nodes)
          } else {
            for (const r of reasons) addChain(key, r, nodes)
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
