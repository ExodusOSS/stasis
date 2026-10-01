import { join } from 'node:path'

import { isTomlTable, readToml } from '../loaders/toml.js'

// What `soldeer install` (0.12.0) writes beside the dependencies folder after installing it
// (soldeer-core's update_config_libs and edit_remappings with RemappingsAction::Update): the
// remappings.txt it would write is written into the tree, which then serves it in place of the
// project's; a foundry.toml it would edit is refused, as is what this can't tell it would leave as
// it is. `view` is the project's root by paths from `/`, `root` its real path, for messages.

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u
// A requirement Soldeer takes as exact: a bare version (its `^` made `=`), or one written `=`.
const EXACT = /^=?\s*(\S+)$/u
const withoutBuild = (version) => version.replace(/\+.*$/u, '')

// A file's text as Soldeer reads it (a byte order mark kept), or undefined.
function textOf(view, path) {
  try {
    return view.stat(path).type === 'file' ? view.readFile(path).toString('utf8') : undefined
  } catch {
    return undefined
  }
}

// Rust's `Path::components` of a remapping's target, `.` kept only at the start.
function components(path) {
  const out = path.startsWith('/') ? ['/'] : []
  for (const [i, part] of path.split('/').entries()) {
    if (part !== '' && (part !== '.' || i === 0)) out.push(part)
  }
  return out
}

// Whether the folder `name` of a remapping's target (its dependencies folder and the one in it) is
// `dep`'s, as soldeer's path_matches tells, or null where only Rust's semver could tell.
function folderMatches(dep, name) {
  if (!name.startsWith(`${dep.name}-`)) return false
  const version = name.slice(dep.name.length + 1)
  if (version === dep.version) return true
  if (!SEMVER.test(version)) return version === dep.req
  const exact = EXACT.exec(dep.req.trim())?.[1]
  if (exact !== undefined && SEMVER.test(exact)) return withoutBuild(exact) === withoutBuild(version)
  return null
}

// The remappings Soldeer's update leaves, of `existing` (`[name, target]` pairs) and the config's
// dependencies, sorted as it sorts them (by their UTF-8 bytes).
function updatedRemappings(existing, deps, { regenerate, where }) {
  const items = deps.map((dep) => ({ dep, line: `${dep.remapped}=dependencies/${dep.folder}/` }))
  let lines
  if (regenerate || existing.length === 0) {
    lines = items.map(({ line }) => line)
  } else {
    lines = []
    let rest = existing
    for (const { dep, line } of items) {
      let found = false
      rest = rest.filter(([name, target]) => {
        const path = components(target).slice(0, 2)
        const folder = path.at(-1)
        const matches = folder === undefined || ['/', '.', '..'].includes(folder) ? false : folderMatches(dep, folder)
        if (matches === null) throw new Error(`${where}: "${name}=${target}" names ${folder}, which \`soldeer install\` may rewrite to dependencies/${dep.folder}`)
        if (!matches) return true
        lines.push(`${name}=${target.replaceAll(path.join('/').replace(/^\/\//u, '/'), `dependencies/${dep.folder}`)}`)
        found = true
        return false
      })
      if (!found) lines.push(line)
    }
    lines.push(...rest.map(([name, target]) => `${name}=${target}`))
  }
  return lines.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

// `[name, target]` of each remapping in `lines`, as Soldeer reads them: split at the first `=`, any
// line without one passed over.
const pairs = (lines) => lines.flatMap((line) => {
  const at = line.indexOf('=')
  return at === -1 ? [] : [[line.slice(0, at), line.slice(at + 1)]]
})

export function settleSoldeer(view, vfs, root) {
  const foundryText = textOf(view, '/foundry.toml')
  const foundry = foundryText === undefined ? undefined : readToml(foundryText)
  const configFile = isTomlTable(foundry?.dependencies) ? 'foundry.toml' : 'soldeer.toml'
  const config = configFile === 'foundry.toml' ? foundry : readToml(textOf(view, '/soldeer.toml') ?? '')
  const where = (file) => join(root, file)

  if (configFile === 'foundry.toml') {
    const libs = foundry.profile?.default?.libs
    if (!Array.isArray(libs) || !libs.includes('dependencies')) {
      throw new Error(`${where('foundry.toml')}: [profile.default] libs holds no "dependencies", which \`soldeer install\` adds`)
    }
  }

  const settings = { remappings_generate: true, remappings_regenerate: false, remappings_version: true, remappings_prefix: '', remappings_location: 'txt', ...config.soldeer }
  if (!settings.remappings_generate) return
  const locked = new Map(readToml(textOf(view, '/soldeer.lock') ?? '').dependencies?.map((entry) => [entry.name, entry.version]) ?? [])
  const deps = Object.entries(config.dependencies ?? {}).map(([name, value]) => {
    const req = typeof value === 'string' ? value : value.version
    const version = locked.get(name)
    const remapped = `${settings.remappings_prefix}${name}${settings.remappings_version ? `-${req.replaceAll('=', '')}` : ''}/`
    return { name, req, version, folder: `${name}-${version}`, remapped }
  })

  const remappingsTxt = textOf(view, '/remappings.txt')
  if (configFile === 'foundry.toml' && settings.remappings_location === 'config') {
    if (remappingsTxt !== undefined) throw new Error(`${where('remappings.txt')}: \`soldeer install\` removes it, as remappings_location is "config"`)
    for (const [name, profile] of Object.entries(isTomlTable(foundry.profile) ? foundry.profile : {})) {
      const current = Array.isArray(profile?.remappings) ? profile.remappings : undefined
      if (current === undefined && name !== 'default') continue
      const updated = updatedRemappings(pairs((current ?? []).filter((r) => typeof r === 'string')), deps, { regenerate: settings.remappings_regenerate, where: where('foundry.toml') })
      if (current === undefined || updated.length !== current.length || updated.some((r, i) => r !== current[i])) {
        throw new Error(`${where('foundry.toml')}: [profile.${name}] remappings are not as \`soldeer install\` leaves them`)
      }
    }
    return
  }

  const lines = (settings.remappings_regenerate ? '' : remappingsTxt ?? '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const existing = pairs(lines.map((line) => line.replace(/\r$/u, '')))
  const text = updatedRemappings(existing, deps, { regenerate: settings.remappings_regenerate, where: where('remappings.txt') }).map((line) => `${line}\n`).join('')
  if (text !== remappingsTxt) vfs.writeFile('/remappings.txt', text, { mode: remappingsTxt === undefined ? 0o644 : view.lstat('/remappings.txt').mode })
}
