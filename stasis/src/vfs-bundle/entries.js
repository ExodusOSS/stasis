import { join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { isAutoExcludedDir } from '@exodus/stasis-core/util'
import { Vfs } from '@preventive/vfs'
import { checkVfsOptions, fieldResolverFor } from '../cmd/bundle.js'
import { foundrySourceDir } from '../loaders/foundry.js'
import { resolveTypescriptFallback, typescriptExportsTarget } from '../resolve-typescript.js'
import { checkKind, checkVersion, packageManagerOf, vfsHost } from './tree.js'

const JS = /\.[cm]?[jt]s$/u
// A path out of the package's directory, which may be the root of a subtree held alone.
const outward = (path) => /^(?:\/|\.\.(?:\/|$))/u.test(normalize(path))
// Node's own conditions for require() and for import, which the build's are added to.
const NODE_CONDITIONS = [['require', 'node', 'node-addons', 'module-sync'], ['import', 'node', 'node-addons', 'module-sync']]

// The entry points the package.json in `dir` names, as paths from `dir`, resolved as the JS build
// with the given options resolves: as Node does, `conditions` added, or with `mainFields` or
// `metro` through the build's field resolver, once per platform of `platforms` under `metro`; what
// that misses mapped as tsc maps it under `typescript`, as the build's fallback maps it. In
// that order: its own entry, as the build resolves `./` there (`main`, or the first of the main
// fields, else index); each subpath `exports` holds (but a pattern), as the package's name resolves
// for require() and for import, with the conditions the build adds (the RN ones under `metro`); and
// each `bin`. Only JS files in `dir` that are there, named from within it; none without a package.json.
export function packageEntries(host, dir, { conditions = [], mainFields, metro = false, platforms = [], jsx = false, typescript = false } = {}) {
  const real = host.realpath(dir)
  const manifest = join(real, 'package.json')
  const pkg = readJson(manifest, host)
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return []
  const found = new Set()
  const add = (file) => {
    const rel = file === undefined ? '' : relative(real, file)
    if (rel !== '' && !rel.startsWith('..') && JS.test(rel)) found.add(rel)
  }
  const passes = metro || mainFields !== undefined
    ? (metro ? platforms : [null]).map((platform) => fieldResolverFor(platform, { mainFields, metro, conditions, jsx, typescript, host }))
    : [{ extras: conditions, mainFields: ['main'] }]
  // Node's resolution of `specifier`, else under `typescript` the miss `mapped` as tsc maps it; a
  // real path either way, or undefined.
  const viaNode = (specifier, names, extras, mapped) => {
    const set = new Set([...names, ...extras])
    try {
      return host.resolve(manifest, specifier, set)
    } catch {
      const hit = typescript ? mapped(set) : null
      return hit === null ? undefined : host.realpath(hit)
    }
  }
  for (const { extras, mainFields: fields, resolver } of passes) {
    const entry = fields.map((name) => pkg[name]).find((value) => typeof value === 'string' && value !== '')
    if (entry !== undefined && outward(entry)) continue
    if (resolver === undefined) {
      add(viaNode('./', NODE_CONDITIONS[0], extras, (set) => resolveTypescriptFallback(manifest, './', { conditions: set, tsx: jsx, host })))
    } else {
      // A real path, as Node's resolution gives and the scan takes.
      const hit = resolver(manifest, './')
      if (hit?.url !== undefined) add(host.realpath(fileURLToPath(hit.url)))
    }
  }
  const { exports, name } = pkg
  const keyed = exports !== null && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
  const subpaths = keyed ? Object.keys(exports) : exports === undefined || exports === null ? [] : ['.']
  for (const subpath of typeof name === 'string' ? subpaths : []) {
    if (!subpath.startsWith('.') || subpath.includes('*') || subpath.endsWith('/')) continue
    const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`
    for (const { extras } of passes) {
      for (const names of NODE_CONDITIONS) add(viaNode(specifier, names, extras, (set) => typescriptExportsTarget(real, exports, subpath, { conditions: set, tsx: jsx, host })))
    }
  }
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin !== null && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : []
  for (const bin of bins) {
    if (typeof bin === 'string' && !outward(bin) && host.stat(join(real, bin))?.isFile()) add(host.realpath(join(real, bin)))
  }
  return [...found]
}

// Directories whose .sol files are none of a project's entry points: its tests, scripts and mocks,
// what it depends on or builds, and what no walk descends into.
const SKIPPED_DIRS = new Set(['test', 'tests', 'script', 'scripts', 'mock', 'mocks', 'lib', 'node_modules', 'dependencies', 'out', 'cache', 'artifacts', 'build'])
const isSkippedDir = (name) => SKIPPED_DIRS.has(name.toLowerCase()) || isAutoExcludedDir(name)
// A .sol file but a test or script by its name.
const isEntrySol = (entry) => entry.isFile() && entry.name.endsWith('.sol') && !/\.(?:t|s|test|spec)\.sol$/u.test(entry.name)

// The .sol files under the directory `rel` of `real` that are entry points by name, but those in a
// skipped directory; sorted. Links are not followed.
function solidityFiles(host, real, rel) {
  const out = []
  const walk = (sub) => {
    for (const entry of host.readdir(join(real, sub))) {
      const path = sub === '.' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) walk(path)
      } else if (isEntrySol(entry)) {
        out.push(path)
      }
    }
  }
  walk(rel)
  return out.toSorted()
}

// The entry points of the Soldeer project in `dir`, by name and layout, as paths from `dir`: its
// .sol files directly in it, then those under contracts/, then those under its source directory
// (its foundry.toml's default profile's `src`, else `src`); none of its tests, scripts or mocks,
// nor any in what it depends on or builds. A link to a directory is none.
export function solidityEntries(host, dir) {
  const real = host.realpath(dir)
  const isDirectory = (rel) => !outward(rel) && host.stat(join(real, rel))?.isDirectory() && host.readlink(join(real, rel)) === null
  const under = (rel) => (isDirectory(rel) ? solidityFiles(host, real, rel) : [])
  const src = normalize(foundrySourceDir(real, { host })).replace(/\/+$/u, '')
  const own = host.readdir(real).filter(isEntrySol).map((entry) => entry.name).toSorted()
  return [...new Set([...own, ...under('contracts'), ...(src === 'contracts' ? [] : under(src))])]
}

// By the kind of bundle a package manager builds: an entry its options are checked over before
// there are any, the entries the build takes where none are given, and what having none says.
export const KINDS = {
  js: { standIn: 'index.js', entries: packageEntries, none: 'has no package.json naming a JS entry point there' },
  sol: { standIn: 'index.sol', entries: solidityEntries, none: 'has no .sol entry point directly in it, under contracts/, or under its source directory' },
}

const EMPTY = vfsHost(new Vfs())

// The build's checks of `options` before anything is fetched, over an empty tree, which never
// decides them: for the package manager given, else for any; over the entries given, else over one
// of the kind the default ones are. -> the PACKAGE_MANAGERS entry of the one given
export function checkAhead(name, packageManager, options) {
  checkVersion(name, { packageManager, ...options })
  const pm = packageManager === undefined ? undefined : packageManagerOf(name, packageManager)
  const refusal = (entries) => {
    try {
      checkKind(name, checkVfsOptions(name, { ...options, entries, cwd: '/', host: EMPTY, fetched: false }), packageManager === undefined ? undefined : [packageManager])
      return null
    } catch (error) {
      return error
    }
  }
  const refusals = options.entries === undefined ? (pm === undefined ? Object.values(KINDS) : [KINDS[pm.kind]]).map(({ standIn }) => refusal([standIn])) : [refusal(options.entries)]
  if (!refusals.includes(null)) throw refusals[0]
  return pm
}
