import { moduleFileKey } from '@exodus/stasis-core/util'
import { advisories } from './apis/npm/index.js'
import semver from './apis/npm/semver.cjs'
import { parseFile } from './parse.js'

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

export function flattenAdvisories(result, packages = [], reasonsByPkg = new Map()) {
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
      // Union the reasons of every affected version this row covers (the same
      // versions listed in `installed`), sorted for a stable, `, `-joined cell.
      const reasons = new Set()
      for (const v of affected) {
        for (const r of reasonsByPkg.get(`${pkg}@${v}`) ?? []) reasons.add(r)
      }
      rows.push({
        package: pkg,
        installed: affected.join(', '),
        vulnerable: range,
        severity: adv.severity ?? '',
        title: adv.title ?? '',
        url: adv.url ?? '',
        reason: [...reasons].toSorted().join(', '),
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

export function formatTable(rows, columns) {
  if (rows.length === 0) return ''
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  const pad = (s, w) => s.padEnd(w)
  const line = (l, m, r, fill) => l + widths.map((w) => fill.repeat(w + 2)).join(m) + r
  const row = (vals) => '│ ' + vals.map((v, i) => pad(cell(v), widths[i])).join(' │ ') + ' │'
  return [
    line('┌', '┬', '┐', '─'),
    row(columns),
    line('├', '┼', '┤', '─'),
    ...rows.map((r) => row(columns.map((c) => r[c]))),
    line('└', '┴', '┘', '─'),
  ].join('\n')
}

export async function audit(files) {
  const packages = collectPackages(files)
  if (packages.length === 0) {
    return { packages, advisories: {}, rows: [] }
  }
  const result = await advisories(packages)
  const reasons = collectReasons(files)
  const rows = flattenAdvisories(result, packages, reasons)
  return { packages, advisories: result, rows }
}

export function printAuditReport({ packages, rows }, { out = process.stdout, err = process.stderr } = {}) {
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
  // Surface the reason column only when at least one advisory maps to a bundle
  // consumer; lockfiles (and single-consumer bundles) carry no reason provenance.
  if (rows.some((r) => r.reason)) columns.splice(3, 0, 'reason')
  out.write(formatTable(rows, columns) + '\n')
}
