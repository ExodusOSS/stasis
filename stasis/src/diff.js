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
// digest a lockfile would have recorded. A bundle stores code and 'resource'
// files as UTF-8 text and 'resource:base64' files as base64 blobs, so the
// hashing path is decided PER FILE from the bundle's `formats` map -- not
// from a whole-bundle kind.

const KINDS = new Set(['lockfile', 'bundle'])

// Reduce one file's recorded value to the SRI digest a lockfile records for it.
// 'lockfile' values are already digests; a bundle's values are file bytes that
// must be re-hashed. The encoding is now per-file (one bundle holds both code and
// resources): a 'resource:base64' file is a base64 blob decoded back to raw bytes
// first, while code files and raw-UTF-8 'resource' files hash as their string. This
// is the "rehash the bundle" step that lets a bundle and a lockfile be compared,
// and the reason a `hash` function is required whenever a bundle is involved.
// `hash` takes a string or Buffer and returns the SRI digest (e.g. the
// `sha512integrity` the CLI injects); a lockfile needs none.
function digestOf(kind, format, value, hash) {
  if (kind === 'lockfile') return value
  if (typeof hash !== 'function') {
    throw new Error('diff: a `hash` function is required to compare a bundle (its bytes are re-hashed into a lockfile-style digest)')
  }
  if (format === 'resource:base64') return hash(Buffer.from(value, 'base64'))
  return hash(value)
}

// Project an artifact onto a uniform shape for diffing: its scope, plus a map of
// package dir -> { name, version, ecosystem, files: Map<rel, digest> }. `input`
// is `{ artifact, kind }` where `artifact` is a parsed Bundle/Lockfile and `kind`
// is 'lockfile' | 'bundle' (see parseFileWithKind). `hash` is the digest function
// used to re-hash a bundle's bytes; it is only consulted for bundles (a lockfile
// already holds digests). Per-file encoding is read from the bundle's `formats`.
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
// `sha512integrity`); it is required only when a bundle is one of
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

// The resolution graph an artifact attests, or null when it attests none. A
// unified bundle always carries a (possibly empty) `imports` Map, so it attests
// its resolution set -- empty for a resources-only bundle. A lockfile predating
// resolution attestation records `imports === null` and attests none.
function attestedImports({ artifact }) {
  return artifact.imports ?? null
}

// Collapse an imports map (conditions -> parent -> specifier -> target) to a map
// of (parent, specifier) -> Set<target>, unioning over every conditions key.
// We diff at this *resolution* level — "what does this import resolve to?" —
// rather than at the raw (conditions, parent, specifier) edge key, because the
// two sides label conditions differently: a statically built bundle records
// every edge under the wildcard "*", while a runtime lockfile records precise
// condition sets like "node, import". Keying on conditions would then report a
// byte-identical resolution as removed (the "*" edge) + added (the precise
// edge); folding conditions away makes them compare equal. This mirrors how the
// loader reconciles "*" against precise sets when verifying a resolution
// (state.js #assertAttestedResolution): the final target is what matters, not
// how the edge is keyed.
function resolutionsOf(imports) {
  const byPair = new Map()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, target] of specifiers) {
        const key = JSON.stringify([parent, specifier])
        let entry = byPair.get(key)
        if (!entry) byPair.set(key, (entry = { parent, specifier, targets: new Set() }))
        entry.targets.add(target)
      }
    }
  }
  return byPair
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpPair = (a, b) => sortPaths(a.parent, b.parent) || cmpStr(a.specifier, b.specifier)
const sortedTargets = (set) => [...set].toSorted(sortPaths)
const sameTargets = (a, b) => a.size === b.size && [...a].every((t) => b.has(t))

// Diff the resolution graphs at the (parent, specifier) level (see
// `resolutionsOf` for why conditions are folded away). Each side maps a
// (parent, specifier) to the set of files it resolves to (usually one). Reports:
//   added   — a (parent, specifier) only the right artifact resolves
//   removed — a (parent, specifier) only the left artifact resolves
//   changed — resolved on both sides, but to a different set of targets (a
//             redirect — the kind of change a byte/format diff can't see)
// `from`/`to` are sorted arrays of target files. When either side does not
// attest imports at all (a legacy lockfile predating `imports`), the
// comparison is skipped and `attested` flags why, rather than reporting one
// side's whole graph as added/removed.
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

const KIND_LABEL = { lockfile: 'lockfile', bundle: 'bundle' }
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

// `parent  'specifier'` — conditions are folded away (see resolutionsOf), so an
// edge is identified by the importing file and the specifier it resolved.
const edgeLabel = (e) => `${e.parent}  '${e.specifier}'`
const targetList = (files) => files.join(', ')

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
      for (const e of im.removed) lines.push(`  ${REMOVED} ${edgeLabel(e)} -> ${targetList(e.from)}`)
      for (const e of im.added) lines.push(`  ${ADDED} ${edgeLabel(e)} -> ${targetList(e.to)}`)
      for (const e of im.changed) lines.push(`  ${CHANGED} ${edgeLabel(e)}  ${targetList(e.from)} -> ${targetList(e.to)}`)
    }
  }

  lines.push('')
  lines.push(hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
