import { readFileSync } from 'node:fs'

import { advisories } from './apis/npm/index.js'
import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'

const isPackageJsonPath = (p) => p === 'package.json' || p.endsWith('/package.json')

function extractFromLockfile(lockfile) {
  const out = []
  for (const { name, version } of lockfile.modules.values()) {
    if (name && version) out.push({ name, version })
  }
  return out
}

function extractFromBundle(bundle) {
  const out = []
  for (const [path, source] of bundle.sources) {
    if (!isPackageJsonPath(path)) continue
    const { name, version } = JSON.parse(source)
    if (name && version) out.push({ name, version })
  }
  return out
}

export function collectPackagesFromFile(file) {
  const buf = readFileSync(file)
  try {
    return extractFromBundle(Bundle.parseCode(buf))
  } catch {
    try {
      return extractFromLockfile(Lockfile.parse(buf.toString('utf8')))
    } catch (cause) {
      throw new Error(`Unrecognised file (not a stasis lockfile or bundle): ${file}`, { cause })
    }
  }
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
  return out.sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1))
}

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 }

export function flattenAdvisories(result) {
  const rows = []
  for (const [pkg, list] of Object.entries(result)) {
    if (!Array.isArray(list)) continue
    for (const adv of list) {
      rows.push({
        package: pkg,
        vulnerable: adv.vulnerable_versions ?? '',
        severity: adv.severity ?? '',
        title: adv.title ?? '',
        url: adv.url ?? '',
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

export function formatTable(rows, columns) {
  if (rows.length === 0) return ''
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const pad = (s, w) => String(s).padEnd(w)
  const line = (l, m, r, fill) => l + widths.map((w) => fill.repeat(w + 2)).join(m) + r
  const row = (vals) => '│ ' + vals.map((v, i) => pad(v, widths[i])).join(' │ ') + ' │'
  return [
    line('┌', '┬', '┐', '─'),
    row(columns),
    line('├', '┼', '┤', '─'),
    ...rows.map((r) => row(columns.map((c) => r[c] ?? ''))),
    line('└', '┴', '┘', '─'),
  ].join('\n')
}

export async function audit(files) {
  const packages = collectPackages(files)
  if (packages.length === 0) {
    return { packages, advisories: {}, rows: [] }
  }
  const result = await advisories(packages)
  const rows = flattenAdvisories(result)
  return { packages, advisories: result, rows }
}

export function printAuditReport({ packages, rows }, { out = process.stdout, err = process.stderr } = {}) {
  err.write(`Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}\n`)
  if (rows.length === 0) {
    err.write('No advisories found\n')
    return
  }
  out.write(formatTable(rows, ['severity', 'package', 'vulnerable', 'title', 'url']) + '\n')
}
