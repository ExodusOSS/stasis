import { join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { fieldResolverFor } from '../cmd/bundle.js'
import { resolveTypescriptFallback, typescriptExportsTarget } from '../resolve-typescript.js'

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
