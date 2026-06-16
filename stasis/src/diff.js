import { sortPaths } from '@exodus/stasis-core/util'

// `@exodus/stasis/diff` — compare two already-parsed stasis artifacts
// (`Bundle`/`Lockfile` instances) and report what changed, at both the module
// (package) and the file level. Like `@exodus/stasis/sbom`, it never reads disk
// and pulls in no brotli (`node:zlib`) or crypto (`node:crypto`): the caller
// reads/decompresses the artifacts, hands over parsed instances, and — to
// compare a bundle's bytes against a lockfile's digests — supplies the hash
// function (see `hash` below). The CLI glue that reads files off disk and wires
// in `sha512integrity` lives in `src/cmd/diff.js`.
//
// The key to comparing across kinds — diffing a lockfile against a bundle — is
// that every artifact reduces to the same "digest space". A lockfile already
// records each file as an SRI digest (`sha512-…`); a bundle records the file's
// bytes, so we re-hash those bytes (via the injected `hash`) into the very
// digest a lockfile would have recorded. Code bundles store UTF-8 source text,
// resource bundles store base64-encoded blobs, so the hashing path depends on
// the artifact's kind.

const KINDS = new Set(['lockfile', 'code', 'resources'])

// Reduce one file's recorded value to the SRI digest a lockfile records for it.
// 'lockfile' values are already digests; 'code' bundle values are UTF-8 source
// strings; 'resources' bundle values are base64 blobs that must be decoded back
// to their raw bytes first so the digest matches what `stasis run` wrote. This
// is the "rehash the bundle" step that lets a bundle and a lockfile be compared,
// and the reason a `hash` function is required whenever a bundle is involved.
// `hash` takes a string or Buffer and returns the SRI digest (e.g. the
// `sha512integrity` the CLI injects); a lockfile needs none.
function digestOf(kind, value, hash) {
  if (kind === 'lockfile') return value
  if (typeof hash !== 'function') {
    throw new Error('diff: a `hash` function is required to compare a bundle (its bytes are re-hashed into a lockfile-style digest)')
  }
  if (kind === 'resources') return hash(Buffer.from(value, 'base64'))
  return hash(value)
}

// Project an artifact onto a uniform shape for diffing: its scope, plus a map of
// package dir -> { name, version, ecosystem, files: Map<rel, digest> }. `input`
// is `{ artifact, kind }` where `artifact` is a parsed Bundle/Lockfile and
// `kind` is one of 'lockfile' | 'code' | 'resources' (see parseFileWithKind).
// `hash` is the digest function used to re-hash a bundle's bytes; it is only
// consulted for code/resource bundles (a lockfile already holds digests).
export function normalizeArtifact(input, { hash } = {}) {
  const { artifact, kind } = input ?? {}
  if (!artifact || !KINDS.has(kind)) {
    throw new Error("diff: each input must be { artifact, kind } with kind 'lockfile' | 'code' | 'resources'")
  }
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, files }] of artifact.modules) {
    const digests = new Map()
    for (const [rel, value] of Object.entries(files)) digests.set(rel, digestOf(kind, value, hash))
    // v0 bundles record no name/version (null); normalize undefined to null too
    // so module-metadata comparisons have a single "unknown" sentinel.
    modules.set(dir, { name: name ?? null, version: version ?? null, ecosystem: ecosystem ?? null, files: digests })
  }
  return { scope: artifact.config?.scope ?? 'full', modules }
}

const projectPath = (dir, rel) => (dir === '.' ? rel : `${dir}/${rel}`)

// Diff two artifacts. `left`/`right` are each `{ artifact, kind }`; `left` is the
// baseline ("from"), `right` the comparison ("to"). Returns a structured report:
//
//   {
//     scope: { left, right },
//     modules: {
//       added:   [{ dir, name, version, ecosystem, files }],  // only in right
//       removed: [{ dir, name, version, ecosystem, files }],  // only in left
//       changed: [{ dir, name, versionChange?, nameChange? }] // in both, metadata differs
//     },
//     files: { added: [path], removed: [path], differing: [path] },
//     imports?: { attested: { left, right }, added, removed, changed }  // only with { imports: true }
//   }
//
// Modules are compared whole-package; files are compared within packages present
// on BOTH sides. A package that exists on only one side is reported once as an
// added/removed module (carrying its file count) rather than re-listing each of
// its files — so the two levels are complementary, not redundant. A module's
// `version`/`name` change is only reported when both sides record a (non-null)
// value, since a v0 bundle records neither.
//
// With `{ imports: true }` the diff also compares the artifacts' resolution
// graphs (the `imports` edges both lockfiles and bundles carry) and reports
// which edges were added, removed, or redirected — see `diffImports`. It is
// opt-in because the edge graph is verbose and not always attested.
//
// `hash` is the digest function used to re-hash bundle bytes (the CLI passes
// `sha512integrity`); it is required only when a code/resource bundle is one of
// the operands — a lockfile↔lockfile diff needs none.
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

    // Present on both sides: compare package metadata, then files within.
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

// The resolution edges an artifact attests, or null when it attests none. A
// resource bundle has no import graph; a lockfile predating resolution
// attestation records `imports === null` (distinct from an empty map). A code
// bundle always carries one (possibly empty).
function attestedImports({ artifact, kind }) {
  if (kind === 'resources') return null
  return artifact.imports ?? null
}

// Flatten an imports map (conditions -> parent -> specifier -> resolved file)
// into a flat Map keyed by a collision-free JSON tuple of [conditions, parent,
// specifier], so the two sides can be compared as edge sets.
function flattenEdges(imports) {
  const edges = new Map()
  for (const [conditions, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, target] of specifiers) {
        edges.set(JSON.stringify([conditions, parent, specifier]), { conditions, parent, specifier, target })
      }
    }
  }
  return edges
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpEdge = (a, b) => sortPaths(a.parent, b.parent) || cmpStr(a.specifier, b.specifier) || cmpStr(a.conditions, b.conditions)

// Diff the resolution graphs. An edge is keyed by (conditions, parent,
// specifier); the value is the resolved file. Reports:
//   added   — an edge only the right artifact records
//   removed — an edge only the left artifact records
//   changed — same (conditions, parent, specifier) resolving to a different file
//             (a redirect — the kind of change a byte/format diff can't see)
// When either side does not attest imports at all (a resource bundle, or a
// legacy lockfile), the comparison is skipped and `attested` flags why, rather
// than reporting one side's whole graph as added/removed.
export function diffImports(left, right) {
  const li = attestedImports(left)
  const ri = attestedImports(right)
  const attested = { left: li !== null, right: ri !== null }
  if (li === null || ri === null) return { attested, added: [], removed: [], changed: [] }

  const L = flattenEdges(li)
  const R = flattenEdges(ri)
  const added = []
  const removed = []
  const changed = []
  for (const key of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(key)
    const r = R.get(key)
    if (l && !r) removed.push({ conditions: l.conditions, parent: l.parent, specifier: l.specifier, from: l.target })
    else if (!l && r) added.push({ conditions: r.conditions, parent: r.parent, specifier: r.specifier, to: r.target })
    else if (l.target !== r.target) {
      changed.push({ conditions: l.conditions, parent: l.parent, specifier: l.specifier, from: l.target, to: r.target })
    }
  }
  added.sort(cmpEdge)
  removed.sort(cmpEdge)
  changed.sort(cmpEdge)
  return { attested, added, removed, changed }
}

// True when the diff records any module-, file-, or (when present) import-level
// change. Scope alone is informational (a scope difference shows up as the
// modules/files only one side records) and does not, on its own, count as a
// difference. Imports that can't be compared (one side doesn't attest them)
// contribute nothing — their add/remove/change lists are empty.
export function hasDifferences(diff) {
  const { modules, files, imports } = diff
  let n =
    modules.added.length + modules.removed.length + modules.changed.length +
    files.added.length + files.removed.length + files.differing.length
  if (imports) n += imports.added.length + imports.removed.length + imports.changed.length
  return n > 0
}

const KIND_LABEL = { lockfile: 'lockfile', code: 'code bundle', resources: 'resource bundle' }
const plural = (n) => (n === 1 ? '' : 's')
const ident = ({ name, version }) => (name ? (version ? `${name}@${version}` : name) : '')

// Diff markers. `~` reads too close to `-` in a terminal, so a changed/redirected
// entry is marked `*` (distinct from `-` removed / `+` added).
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

// `parent  'specifier' [conditions]` — conditions are shown only when not the
// wildcard `*`, to keep the common case uncluttered.
const edgeLabel = (e) => `${e.parent}  '${e.specifier}'${e.conditions === '*' ? '' : ` [${e.conditions}]`}`

// Render the `--stat` summary of a diff (module + file change lists with
// counts, plus the import-edge changes when the diff carries them), in the
// spirit of `git diff --stat`: it reports *what* changed, not the differing
// text itself, and the whole report — including the trailing differ/no-differ
// line — goes to stdout. `labels` is `{ left, right, leftKind, rightKind }` for
// the header. Lines use `-` (only in left / baseline), `+` (only in right),
// `*` (changed in place). Returns a string ending in a newline.
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
  // Counts cover files *within modules present on both sides*; files inside a
  // wholly added/removed module are summarized by its module entry above (with
  // a file count), not re-counted here — so name the scope to avoid misreading
  // "0 removed" when a whole package vanished.
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
      for (const e of im.removed) lines.push(`  ${REMOVED} ${edgeLabel(e)} -> ${e.from}`)
      for (const e of im.added) lines.push(`  ${ADDED} ${edgeLabel(e)} -> ${e.to}`)
      for (const e of im.changed) lines.push(`  ${CHANGED} ${edgeLabel(e)}  ${e.from} -> ${e.to}`)
    }
  }

  lines.push('')
  lines.push(hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
