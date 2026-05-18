import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

import { advisories } from './apis/npm/index.js'
import semver from './apis/npm/semver.cjs'
import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'

function parseFile(file) {
  const buf = readFileSync(file)
  // Sniff: lockfiles are JSON text starting with `{`; bundles are brotli binary.
  // Routing avoids reporting a Bundle assertion as a JSON-parse error (or vice
  // versa) when the file is well-formed but invalid.
  if (buf[0] === 0x7b /* '{' */) {
    try {
      return Lockfile.parse(buf.toString('utf8'))
    } catch (cause) {
      throw new Error(`Failed to parse stasis lockfile: ${file}`, { cause })
    }
  }
  try {
    return Bundle.parseCode(brotliDecompressSync(buf).toString('utf8'))
  } catch (cause) {
    throw new Error(`Failed to parse stasis bundle: ${file}`, { cause })
  }
}

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
  return out.sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version))
}

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, none: 5 }

export function flattenAdvisories(result, packages = []) {
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

// Newlines in npm advisory titles would otherwise break the box layout.
const cell = (v) => String(v ?? '').replace(/\r?\n/gu, ' ')

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
  const rows = flattenAdvisories(result, packages)
  return { packages, advisories: result, rows }
}

export function printAuditReport({ packages, rows }, { out = process.stdout, err = process.stderr } = {}) {
  err.write(`Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}\n`)
  if (rows.length === 0) {
    err.write('No advisories found\n')
    return
  }
  out.write(formatTable(rows, ['severity', 'package', 'installed', 'vulnerable', 'title', 'url']) + '\n')
}
