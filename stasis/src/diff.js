import { sortPaths } from '@exodus/stasis-core/util'

// `@exodus/stasis/diff` — compare two parsed stasis artifacts (Bundle/Lockfile) at the module and
// file level. Never reads disk. Comparing across kinds works by reducing every file to the same
// digest space: a lockfile already holds SRI digests; a bundle holds bytes, re-hashed via the
// injected `hash` — so a `hash` function is required whenever a bundle is an operand. Per-file
// encoding (resource:base64 vs text) is read from the bundle's `formats` map.

const KINDS = new Set(['lockfile', 'bundle'])

// Reduce one file's recorded value to an SRI digest: lockfile values already are digests; a
// bundle's are re-hashed, with a `resource:base64` file decoded to bytes first (others hash as text).
function digestOf(kind, format, value, hash) {
  if (kind === 'lockfile') return value
  if (typeof hash !== 'function') {
    throw new Error('diff: a `hash` function is required to compare a bundle (its bytes are re-hashed into a lockfile-style digest)')
  }
  if (format === 'resource:base64') return hash(Buffer.from(value, 'base64'))
  return hash(value)
}

// Project an artifact onto a uniform shape: scope + Map<dir, { name, version, ecosystem,
// files: Map<rel, digest> }>. `input` is { artifact, kind }; `hash` re-hashes bundle bytes only.
export function normalizeArtifact(input, { hash } = {}) {
  const { artifact, kind } = input ?? {}
  if (!artifact || !KINDS.has(kind)) {
    throw new Error("diff: each input must be { artifact, kind } with kind 'lockfile' | 'bundle'")
  }
  const formats = artifact.formats ?? new Map()
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, files }] of artifact.modules) {
    const digests = new Map()
    for (const [rel, value] of Object.entries(files)) {
      const full = dir === '.' ? rel : `${dir}/${rel}`
      digests.set(rel, digestOf(kind, formats.get(full), value, hash))
    }
    // v0 bundles record no name/version; normalize undefined -> null for a single "unknown" sentinel.
    modules.set(dir, { name: name ?? null, version: version ?? null, ecosystem: ecosystem ?? null, files: digests })
  }
  return { scope: artifact.config?.scope ?? 'full', modules }
}

const projectPath = (dir, rel) => (dir === '.' ? rel : `${dir}/${rel}`)

// Diff two `{ artifact, kind }` operands (`left` = baseline/"from", `right` = "to"). Modules are
// compared whole-package; files only within packages present on BOTH sides (a one-sided package is
// reported once as an added/removed module, not per-file). A version/name change is reported only
// when both sides record a non-null value. `{ imports: true }` also diffs the resolution graphs
// (opt-in; verbose). `hash` is required only when a bundle is an operand.
export function diffArtifacts(left, right, { imports = false, hash } = {}) {
  const L = normalizeArtifact(left, { hash })
  const R = normalizeArtifact(right, { hash })

  const modulesAdded = []
  const modulesRemoved = []
  const modulesChanged = []
  const filesAdded = []
  const filesRemoved = []
  const filesDiffering = []

  const dirs = new Set([...L.modules.keys(), ...R.modules.keys()])
  for (const dir of dirs) {
    const l = L.modules.get(dir)
    const r = R.modules.get(dir)
    if (l && !r) {
      modulesRemoved.push({ dir, name: l.name, version: l.version, ecosystem: l.ecosystem, files: l.files.size })
      continue
    }
    if (!l && r) {
      modulesAdded.push({ dir, name: r.name, version: r.version, ecosystem: r.ecosystem, files: r.files.size })
      continue
    }

    const change = { dir, name: r.name ?? l.name }
    if (l.version !== null && r.version !== null && l.version !== r.version) {
      change.versionChange = { from: l.version, to: r.version }
    }
    if (l.name !== null && r.name !== null && l.name !== r.name) {
      change.nameChange = { from: l.name, to: r.name }
    }
    if (change.versionChange || change.nameChange) modulesChanged.push(change)

    const rels = new Set([...l.files.keys(), ...r.files.keys()])
    for (const rel of rels) {
      const lh = l.files.get(rel)
      const rh = r.files.get(rel)
      const path = projectPath(dir, rel)
      if (lh !== undefined && rh === undefined) filesRemoved.push(path)
      else if (lh === undefined && rh !== undefined) filesAdded.push(path)
      else if (lh !== rh) filesDiffering.push(path)
    }
  }

  const byDir = (a, b) => sortPaths(a.dir, b.dir)
  modulesAdded.sort(byDir)
  modulesRemoved.sort(byDir)
  modulesChanged.sort(byDir)
  filesAdded.sort(sortPaths)
  filesRemoved.sort(sortPaths)
  filesDiffering.sort(sortPaths)

  const result = {
    scope: { left: L.scope, right: R.scope },
    modules: { added: modulesAdded, removed: modulesRemoved, changed: modulesChanged },
    files: { added: filesAdded, removed: filesRemoved, differing: filesDiffering },
  }
  if (imports) result.imports = diffImports(left, right)
  return result
}

// The resolution graph an artifact attests, or null when it attests none (a legacy lockfile
// predating attestation); a bundle always carries a possibly-empty map.
function attestedImports({ artifact }) {
  return artifact.imports ?? null
}

// Collapse an imports map (conditions -> parent -> specifier -> target) to (parent, specifier) ->
// Set<target>, unioning over conditions: a static bundle keys every edge under "*" while a runtime
// lockfile uses precise sets, so keying on conditions would report identical resolutions as
// removed+added. Folding conditions away makes them compare equal.
function resolutionsOf(imports) {
  const byPair = new Map()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, target] of specifiers) {
        const key = JSON.stringify([parent, specifier])
        let entry = byPair.get(key)
        if (!entry) byPair.set(key, (entry = { parent, specifier, targets: new Set() }))
        // A `--metro` edge target may be a { platform: file } map; fold each platform's file into the set.
        if (target instanceof Map) for (const f of target.values()) entry.targets.add(f)
        else entry.targets.add(target)
      }
    }
  }
  return byPair
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpPair = (a, b) => sortPaths(a.parent, b.parent) || cmpStr(a.specifier, b.specifier)
const sortedTargets = (set) => [...set].toSorted(sortPaths)
const sameTargets = (a, b) => a.size === b.size && [...a].every((t) => b.has(t))

// Diff resolution graphs at the (parent, specifier) level (conditions folded away — see
// resolutionsOf). Reports added/removed and changed (resolved on both sides to different targets —
// a redirect a byte diff can't see). When either side doesn't attest imports, the diff is skipped
// and `attested` flags why, rather than reporting one whole graph as added/removed.
export function diffImports(left, right) {
  const li = attestedImports(left)
  const ri = attestedImports(right)
  const attested = { left: li !== null, right: ri !== null }
  if (li === null || ri === null) return { attested, added: [], removed: [], changed: [] }

  const L = resolutionsOf(li)
  const R = resolutionsOf(ri)
  const added = []
  const removed = []
  const changed = []
  for (const key of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(key)
    const r = R.get(key)
    if (l && !r) removed.push({ parent: l.parent, specifier: l.specifier, from: sortedTargets(l.targets) })
    else if (!l && r) added.push({ parent: r.parent, specifier: r.specifier, to: sortedTargets(r.targets) })
    else if (!sameTargets(l.targets, r.targets)) {
      changed.push({ parent: l.parent, specifier: l.specifier, from: sortedTargets(l.targets), to: sortedTargets(r.targets) })
    }
  }
  added.sort(cmpPair)
  removed.sort(cmpPair)
  changed.sort(cmpPair)
  return { attested, added, removed, changed }
}

// True when the diff records any module-, file-, or import-level change. Scope alone is
// informational and doesn't count (unattested imports contribute empty lists).
export function hasDifferences(diff) {
  const { modules, files, imports } = diff
  let n =
    modules.added.length + modules.removed.length + modules.changed.length +
    files.added.length + files.removed.length + files.differing.length
  if (imports) n += imports.added.length + imports.removed.length + imports.changed.length
  return n > 0
}

const KIND_LABEL = { lockfile: 'lockfile', bundle: 'bundle' }
const plural = (n) => (n === 1 ? '' : 's')
const ident = ({ name, version }) => (name ? (version ? `${name}@${version}` : name) : '')

// Diff markers: `*` (changed) — `~` reads too close to `-` in a terminal.
const REMOVED = '-'
const ADDED = '+'
const CHANGED = '*'

function describeModuleChange({ name, versionChange, nameChange }) {
  const segs = []
  if (versionChange) segs.push(`${versionChange.from} -> ${versionChange.to}`)
  if (nameChange) segs.push(`name ${nameChange.from} -> ${nameChange.to}`)
  return `${name ? `${name} ` : ''}${segs.join(', ')}`
}

const moduleLine = (mark, x) => {
  const id = ident(x)
  return `  ${mark} ${x.dir}${id ? `  ${id}` : ''} (${x.files} file${plural(x.files)})`
}

// `parent  'specifier'` — an edge is identified by importer + specifier (conditions folded away).
const edgeLabel = (e) => `${e.parent}  '${e.specifier}'`
const targetList = (files) => files.join(', ')

// Render the `--stat` summary (module + file change lists with counts, plus import-edge changes
// when present); reports what changed, not the text. `labels` is { left, right, leftKind, rightKind }.
// Returns a string ending in a newline.
export function formatDiffStat(diff, { left = '(left)', right = '(right)', leftKind, rightKind } = {}) {
  const { modules: m, files: f, imports: im, scope } = diff
  const lines = ['stasis diff --stat']
  const label = (kind) => (kind ? `${KIND_LABEL[kind]}, ` : '')
  lines.push(`  ${REMOVED} ${left} (${label(leftKind)}scope=${scope.left})`)
  lines.push(`  ${ADDED} ${right} (${label(rightKind)}scope=${scope.right})`)
  if (scope.left !== scope.right) {
    lines.push(`  note: scopes differ (${scope.left} vs ${scope.right}); files only the full-scope artifact records show as removed/added`)
  }

  lines.push('')
  lines.push(`Modules: ${m.added.length} added, ${m.removed.length} removed, ${m.changed.length} changed`)
  for (const x of m.removed) lines.push(moduleLine(REMOVED, x))
  for (const x of m.added) lines.push(moduleLine(ADDED, x))
  for (const x of m.changed) lines.push(`  ${CHANGED} ${x.dir}  ${describeModuleChange(x)}`)

  lines.push('')
  // Counts cover only files within modules present on both sides; a wholly added/removed module's
  // files are summarized by its module entry above — hence the "within shared modules" label.
  lines.push(`Files (within shared modules): ${f.added.length} added, ${f.removed.length} removed, ${f.differing.length} differing`)
  for (const p of f.removed) lines.push(`  ${REMOVED} ${p}`)
  for (const p of f.added) lines.push(`  ${ADDED} ${p}`)
  for (const p of f.differing) lines.push(`  ${CHANGED} ${p}`)

  if (im) {
    lines.push('')
    if (!im.attested.left || !im.attested.right) {
      const which = !im.attested.left && !im.attested.right
        ? 'neither artifact attests'
        : `${im.attested.left ? right : left} does not attest`
      lines.push(`Imports: ${which} resolutions; skipping import diff`)
    } else {
      lines.push(`Imports: ${im.added.length} added, ${im.removed.length} removed, ${im.changed.length} changed`)
      for (const e of im.removed) lines.push(`  ${REMOVED} ${edgeLabel(e)} -> ${targetList(e.from)}`)
      for (const e of im.added) lines.push(`  ${ADDED} ${edgeLabel(e)} -> ${targetList(e.to)}`)
      for (const e of im.changed) lines.push(`  ${CHANGED} ${edgeLabel(e)}  ${targetList(e.from)} -> ${targetList(e.to)}`)
    }
  }

  lines.push('')
  lines.push(hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
