import { moduleFileKey } from '@exodus/stasis-core/util'
import { advisories } from './apis/npm/index.js'
import semver from './apis/npm/semver.cjs'
import { parseFile } from './parse.js'
import { collectWhy } from './why.js'

// Only audit installed dependencies; workspace/first-party packages live under
// non-`node_modules` keys in .modules (Lockfile/Bundle merge sources in) and
// shouldn't be sent to the public registry — they leak names and produce noise.
export function collectPackagesFromFile(file) {
  const out = []
  for (const [dir, { name, version }] of parseFile(file).modules) {
    if (!dir.includes('node_modules')) continue
    if (name && version) out.push({ name, version })
  }
  return out
}

export function collectPackages(files) {
  const seen = new Set()
  const out = []
  for (const file of files) {
    for (const { name, version } of collectPackagesFromFile(file)) {
      const key = `${name}@${version}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, version })
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version))
}

// Map each audited node_modules package (`name@version`) to the set of bundle
// consumers ("reasons") that recorded any of its files. Only bundles carry a
// `reason` map -- lockfiles (and single-consumer bundles) omit it, contributing
// nothing. The reason map is { consumer: [project-relative file, ...] }; we
// resolve each file back to its owning package via the module file listing.
export function collectReasons(files) {
  const byPkg = new Map()
  for (const file of files) {
    const artifact = parseFile(file)
    const reason = artifact.reason
    if (!reason) continue
    const fileToPkg = new Map()
    for (const [dir, { name, version, files: modFiles }] of artifact.modules) {
      if (!dir.includes('node_modules') || !name || !version) continue
      for (const rel of Object.keys(modFiles)) {
        fileToPkg.set(moduleFileKey(dir, rel), `${name}@${version}`)
      }
    }
    for (const [consumer, list] of Object.entries(reason)) {
      if (!Array.isArray(list)) continue
      for (const f of list) {
        const key = fileToPkg.get(f)
        if (key === undefined) continue
        let set = byPkg.get(key)
        if (set === undefined) byPkg.set(key, (set = new Set()))
        set.add(consumer)
      }
    }
  }
  return byPkg
}

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, none: 5 }

// Build a row's `reason` cell by unioning over exactly the affected versions it
// covers. Without `--why` that's the `, `-joined set of bundle consumers; with
// `--why` it's the newline-joined `consumer: a -> b -> c` import-path lines
// (which REPLACE the consumer list). Both are sorted for a stable cell.
function reasonCell(pkg, affected, reasonsByPkg, whyByPkg) {
  const parts = new Set()
  const source = whyByPkg ?? reasonsByPkg
  for (const v of affected) {
    for (const p of source.get(`${pkg}@${v}`) ?? []) parts.add(p)
  }
  // --why: `consumer: path` lines, one per row, ordered so a consumer's chains
  // group together (localeCompare puts e.g. `run` before `StasisWebpack`).
  // Otherwise: the `, `-joined consumer set, in the original stable order.
  if (whyByPkg) return [...parts].toSorted((a, b) => a.localeCompare(b)).join('\n')
  return [...parts].toSorted().join(', ')
}

export function flattenAdvisories(result, packages = [], reasonsByPkg = new Map(), whyByPkg = null) {
  const installed = new Map()
  for (const { name, version } of packages) {
    if (!installed.has(name)) installed.set(name, [])
    installed.get(name).push(version)
  }
  const rows = []
  for (const [pkg, list] of Object.entries(result)) {
    if (!Array.isArray(list)) continue
    const installedVersions = installed.get(pkg) ?? []
    for (const adv of list) {
      const range = adv.vulnerable_versions ?? ''
      const affected = range
        ? installedVersions.filter((v) => semver.satisfies(v, range))
        : installedVersions
      // npm occasionally returns advisories whose vulnerable range matches none
      // of the versions we submitted; drop them so the table (and the CLI exit
      // code) reflect only real hits.
      if (installedVersions.length > 0 && affected.length === 0) continue
      rows.push({
        package: pkg,
        installed: affected.join(', '),
        vulnerable: range,
        severity: adv.severity ?? '',
        title: adv.title ?? '',
        url: adv.url ?? '',
        reason: reasonCell(pkg, affected, reasonsByPkg, whyByPkg),
      })
    }
  }
  rows.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99
    const sb = SEVERITY_ORDER[b.severity] ?? 99
    if (sa !== sb) return sa - sb
    if (a.package !== b.package) return a.package < b.package ? -1 : 1
    return a.title < b.title ? -1 : 1
  })
  return rows
}

// Line breaks in npm advisory titles would otherwise break the box layout.
// Covers LF, bare CR (and CRLF), and U+2028 / U+2029 line/paragraph separators.
const cell = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ')

// Split a value into the physical lines a cell occupies. Non-multiline columns
// collapse every line break to a space via `cell` (one line). A column named in
// `multiline` (the `--why` reason column) keeps intentional `\n` breaks -- one
// physical line per entry -- while still flattening stray CR/separators in each.
const cellLines = (v, multiline) =>
  multiline ? String(v ?? '').split('\n').map((s) => cell(s)) : [cell(v)]

export function formatTable(rows, columns, { multiline = [] } = {}) {
  if (rows.length === 0) return ''
  const ml = new Set(multiline)
  const linesOf = (obj) => columns.map((c) => cellLines(obj[c], ml.has(c)))
  const header = columns.map((c) => [c])
  const body = rows.map((r) => linesOf(r))
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...body.map((cells) => Math.max(0, ...cells[i].map((l) => l.length))))
  )
  const pad = (s, w) => s.padEnd(w)
  const line = (l, m, r, fill) => l + widths.map((w) => fill.repeat(w + 2)).join(m) + r
  // A row spans as many physical lines as its tallest cell; shorter cells pad
  // out with blanks so the borders stay aligned.
  const render = (cells) => {
    const height = Math.max(...cells.map((c) => c.length))
    const out = []
    for (let i = 0; i < height; i++) {
      out.push('│ ' + cells.map((c, j) => pad(c[i] ?? '', widths[j])).join(' │ ') + ' │')
    }
    return out.join('\n')
  }
  return [
    line('┌', '┬', '┐', '─'),
    render(header),
    line('├', '┼', '┤', '─'),
    ...body.map(render),
    line('└', '┴', '┘', '─'),
  ].join('\n')
}

export async function audit(files, { why = false } = {}) {
  const packages = collectPackages(files)
  if (packages.length === 0) {
    return { packages, advisories: {}, rows: [], why }
  }
  const result = await advisories(packages)
  // `--why` REPLACES the consumer list with per-consumer import paths, so only
  // one of the two is computed. Restrict the (potentially expensive) path search
  // to the packages that actually carry an advisory.
  let rows
  if (why) {
    const vulnerable = new Set(
      Object.entries(result).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([name]) => name)
    )
    const targetKeys = new Set(
      packages.filter((p) => vulnerable.has(p.name)).map((p) => `${p.name}@${p.version}`)
    )
    rows = flattenAdvisories(result, packages, undefined, collectWhy(files, targetKeys))
  } else {
    rows = flattenAdvisories(result, packages, collectReasons(files))
  }
  return { packages, advisories: result, rows, why }
}

export function printAuditReport({ packages, rows, why = false }, { out = process.stdout, err = process.stderr } = {}) {
  err.write(`Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}\n`)
  if (packages.length === 0) {
    err.write('No node_modules entries found in the input files\n')
    return
  }
  if (rows.length === 0) {
    err.write('No advisories found\n')
    return
  }
  const columns = ['severity', 'package', 'installed', 'vulnerable', 'title', 'url']
  // Surface the reason column only when at least one advisory has provenance:
  // the bundle consumers that recorded it, or (with --why) the import paths that
  // reach it. Lockfiles / single-consumer bundles without either leave it off.
  if (rows.some((r) => r.reason)) columns.splice(3, 0, 'reason')
  // Under --why the reason cell is a list of `consumer: path` lines; let it span
  // multiple physical rows instead of collapsing to one.
  out.write(formatTable(rows, columns, { multiline: why ? ['reason'] : [] }) + '\n')
}
