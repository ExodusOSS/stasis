import { sha512integrity } from '@exodus/stasis-core/state.util'
import { sortPaths } from '@exodus/stasis-core/util'

// `@exodus/stasis/diff` — compare two already-parsed stasis artifacts
// (`Bundle`/`Lockfile` instances) and report what changed, at both the module
// (package) and the file level. Like `@exodus/stasis/sbom`, this module is free
// of disk/transport concerns: the caller reads/decompresses the artifacts and
// hands over parsed instances. The CLI glue that reads files off disk (and so
// pulls in brotli) lives in `src/cmd/diff.js`.
//
// The key to comparing across kinds — diffing a lockfile against a bundle — is
// that every artifact reduces to the same "digest space". A lockfile already
// records each file as an SRI digest (`sha512-…`); a bundle records the file's
// bytes, so we re-hash those bytes into the very digest a lockfile would have
// recorded. Code bundles store UTF-8 source text, resource bundles store
// base64-encoded blobs, so the hashing path depends on the artifact's kind.

const KINDS = new Set(['lockfile', 'code', 'resources'])

// Reduce one file's recorded value to the SRI digest a lockfile records for it.
// 'lockfile' values are already digests; 'code' bundle values are UTF-8 source
// strings; 'resources' bundle values are base64 blobs that must be decoded back
// to their raw bytes first so the digest matches what `stasis run` wrote. This
// is the "rehash the bundle" step that lets a bundle and a lockfile be compared.
function digestOf(kind, value) {
  if (kind === 'lockfile') return value
  if (kind === 'resources') return sha512integrity(Buffer.from(value, 'base64'))
  return sha512integrity(value)
}

// Project an artifact onto a uniform shape for diffing: its scope, plus a map of
// package dir -> { name, version, ecosystem, files: Map<rel, digest> }. `input`
// is `{ artifact, kind }` where `artifact` is a parsed Bundle/Lockfile and
// `kind` is one of 'lockfile' | 'code' | 'resources' (see parseFileWithKind).
export function normalizeArtifact(input) {
  const { artifact, kind } = input ?? {}
  if (!artifact || !KINDS.has(kind)) {
    throw new Error("diff: each input must be { artifact, kind } with kind 'lockfile' | 'code' | 'resources'")
  }
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, files }] of artifact.modules) {
    const digests = new Map()
    for (const [rel, value] of Object.entries(files)) digests.set(rel, digestOf(kind, value))
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
//     files: { added: [path], removed: [path], differing: [path] }
//   }
//
// Modules are compared whole-package; files are compared within packages present
// on BOTH sides. A package that exists on only one side is reported once as an
// added/removed module (carrying its file count) rather than re-listing each of
// its files — so the two levels are complementary, not redundant. A module's
// `version`/`name` change is only reported when both sides record a (non-null)
// value, since a v0 bundle records neither.
export function diffArtifacts(left, right) {
  const L = normalizeArtifact(left)
  const R = normalizeArtifact(right)

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

  return {
    scope: { left: L.scope, right: R.scope },
    modules: { added: modulesAdded, removed: modulesRemoved, changed: modulesChanged },
    files: { added: filesAdded, removed: filesRemoved, differing: filesDiffering },
  }
}

// True when the diff records any module- or file-level change. Scope alone is
// informational (a scope difference shows up as the modules/files only one side
// records) and does not, on its own, count as a difference.
export function hasDifferences(diff) {
  const { modules, files } = diff
  return (
    modules.added.length + modules.removed.length + modules.changed.length +
    files.added.length + files.removed.length + files.differing.length
  ) > 0
}

const KIND_LABEL = { lockfile: 'lockfile', code: 'code bundle', resources: 'resource bundle' }
const plural = (n) => (n === 1 ? '' : 's')
const ident = ({ name, version }) => (name ? (version ? `${name}@${version}` : name) : '')

function describeModuleChange({ name, versionChange, nameChange }) {
  const segs = []
  if (versionChange) segs.push(`${versionChange.from} -> ${versionChange.to}`)
  if (nameChange) segs.push(`name ${nameChange.from} -> ${nameChange.to}`)
  return `${name ? `${name} ` : ''}${segs.join(', ')}`
}

// Render the `--stat` summary of a diff (module + file change lists with
// counts), in the spirit of `git diff --stat`: it reports *what* changed, not
// the differing text itself. `labels` is `{ left, right, leftKind, rightKind }`
// for the header. Lines use `-` (only in left / baseline), `+` (only in right),
// `~` (changed in place). Returns a string ending in a newline.
export function formatDiffStat(diff, { left = '(left)', right = '(right)', leftKind, rightKind } = {}) {
  const { modules: m, files: f, scope } = diff
  const lines = ['stasis diff --stat']
  const label = (kind) => (kind ? `${KIND_LABEL[kind]}, ` : '')
  lines.push(`  - ${left} (${label(leftKind)}scope=${scope.left})`)
  lines.push(`  + ${right} (${label(rightKind)}scope=${scope.right})`)
  if (scope.left !== scope.right) {
    lines.push(`  note: scopes differ; files only the ${scope.left === 'full' ? left : right} scope records show as removed/added`)
  }

  lines.push('')
  lines.push(`Modules: ${m.added.length} added, ${m.removed.length} removed, ${m.changed.length} changed`)
  for (const x of m.removed) lines.push(`  - ${x.dir}  ${ident(x)} (${x.files} file${plural(x.files)})`)
  for (const x of m.added) lines.push(`  + ${x.dir}  ${ident(x)} (${x.files} file${plural(x.files)})`)
  for (const x of m.changed) lines.push(`  ~ ${x.dir}  ${describeModuleChange(x)}`)

  lines.push('')
  lines.push(`Files: ${f.added.length} added, ${f.removed.length} removed, ${f.differing.length} differing`)
  for (const p of f.removed) lines.push(`  - ${p}`)
  for (const p of f.added) lines.push(`  + ${p}`)
  for (const p of f.differing) lines.push(`  ~ ${p}`)

  lines.push('')
  lines.push(hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
