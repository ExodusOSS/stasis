import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseYaml } from './yaml.js'
import { DEFAULT_REGISTRY, DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH } from './dep-path.js'

// The pnpm settings that shape a node_modules layout or a tarball fetch, read the way pnpm reads
// them: the user `~/.npmrc`, then the workspace's `pnpm-workspace.yaml` (pnpm 10 moved settings
// there, camelCase), then the project `.npmrc` (kebab-case ini), later sources overriding earlier
// ones. Everything else pnpm knows is ignored. Defaults are pnpm 10's.

export const DEFAULT_SETTINGS = Object.freeze({
  nodeLinker: 'isolated',
  virtualStoreDir: 'node_modules/.pnpm',
  virtualStoreDirMaxLength: DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH,
  hoist: true,
  hoistPattern: ['*'],
  publicHoistPattern: [],
  shamefullyHoist: false,
  hoistWorkspacePackages: true,
  registry: DEFAULT_REGISTRY,
})

// kebab-case (.npmrc) -> the camelCase key used in pnpm-workspace.yaml and here.
const KEBAB_TO_CAMEL = new Map([
  ['node-linker', 'nodeLinker'],
  ['virtual-store-dir', 'virtualStoreDir'],
  ['virtual-store-dir-max-length', 'virtualStoreDirMaxLength'],
  ['hoist', 'hoist'],
  ['hoist-pattern', 'hoistPattern'],
  ['public-hoist-pattern', 'publicHoistPattern'],
  ['shamefully-hoist', 'shamefullyHoist'],
  ['hoist-workspace-packages', 'hoistWorkspacePackages'],
  ['registry', 'registry'],
])
const LIST_KEYS = new Set(['hoistPattern', 'publicHoistPattern'])
const BOOL_KEYS = new Set(['hoist', 'shamefullyHoist', 'hoistWorkspacePackages'])

// `${VAR}` expansion, as npm/pnpm apply to .npmrc values.
function expandEnv(value, env) {
  return value.replaceAll(/\$\{([^}]+)\}/gu, (m, name) => (env[name] === undefined ? m : env[name]))
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

// Parse an .npmrc (ini): `key=value`, `key[]=item` list entries, `#`/`;` comments. Returns a Map
// key -> string | string[] (raw, unexpanded keys; values env-expanded).
export function parseNpmrc(text, { env = process.env } = {}) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    let key = line.slice(0, eq).trim()
    const value = expandEnv(unquote(line.slice(eq + 1).trim()), env)
    if (key.endsWith('[]')) {
      key = key.slice(0, -2)
      const list = out.get(key)
      if (Array.isArray(list)) list.push(value)
      else out.set(key, [value])
    } else {
      out.set(key, value)
    }
  }
  return out
}

function readMaybe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  }
}

function coerce(key, value, source) {
  if (LIST_KEYS.has(key)) {
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
    if (Array.isArray(value)) return value.map(String)
    throw new Error(`${source}: ${key} must be a list`)
  }
  if (BOOL_KEYS.has(key)) {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error(`${source}: ${key} must be true or false`)
  }
  if (key === 'virtualStoreDirMaxLength') {
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${source}: virtual-store-dir-max-length must be a positive integer`)
    return n
  }
  return String(value)
}

export function loadPnpmSettings({ root, env = process.env, home = homedir() } = {}) {
  const settings = { ...DEFAULT_SETTINGS, scopedRegistries: new Map(), auth: new Map() }

  const applyNpmrc = (file) => {
    const text = readMaybe(file)
    if (text === null) return
    for (const [key, value] of parseNpmrc(text, { env })) {
      const camel = KEBAB_TO_CAMEL.get(key)
      if (camel) {
        settings[camel] = coerce(camel, value, file)
      } else if (key.startsWith('@') && key.endsWith(':registry')) {
        settings.scopedRegistries.set(key.slice(0, -':registry'.length), String(value))
      } else if (key.startsWith('//')) {
        // `//host/path/:_authToken=...` / `//host/path/:_auth=...` (npm's registry-scoped credentials).
        const colon = key.lastIndexOf(':')
        if (colon === -1) continue
        const prefix = key.slice(0, colon)
        const field = key.slice(colon + 1)
        if (field === '_authToken' || field === '_auth') {
          const cur = settings.auth.get(prefix) ?? {}
          cur[field] = String(value)
          settings.auth.set(prefix, cur)
        }
      }
    }
  }

  const applyWorkspaceYaml = (file) => {
    const text = readMaybe(file)
    if (text === null) return
    const doc = parseYaml(text)
    if (doc === null || typeof doc !== 'object') return
    for (const camel of KEBAB_TO_CAMEL.values()) {
      if (doc[camel] !== undefined && doc[camel] !== null) settings[camel] = coerce(camel, doc[camel], file)
    }
  }

  if (home) applyNpmrc(join(home, '.npmrc'))
  applyWorkspaceYaml(join(root, 'pnpm-workspace.yaml'))
  applyNpmrc(join(root, '.npmrc'))

  if (settings.shamefullyHoist) settings.publicHoistPattern = ['*']
  if (!settings.hoist) settings.hoistPattern = []
  return settings
}

// The registry a package name resolves from (`@scope:registry` first).
export function registryFor(settings, name) {
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'))
    const scoped = settings.scopedRegistries.get(scope)
    if (scoped) return scoped
  }
  return settings.registry
}

// Authorization header for a tarball URL, from the longest matching `//host/path/` credential.
export function authHeadersFor(settings, url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const nerf = `//${u.host}${u.pathname}`
  let best = null
  for (const [prefix, creds] of settings.auth) {
    const p = prefix.endsWith('/') ? prefix : `${prefix}/`
    if (nerf.startsWith(p) && (best === null || p.length > best.prefix.length)) best = { prefix: p, creds }
  }
  if (!best) return undefined
  if (best.creds._authToken) return { authorization: `Bearer ${best.creds._authToken}` }
  if (best.creds._auth) return { authorization: `Basic ${best.creds._auth}` }
  return undefined
}
