import { assert, fileSetToObject, fromEntries, sortPaths } from './util.js'

const VERSION = 0

const normalize = ({ name, version, files }) =>
  ({ name, version, files: fromEntries(Object.entries(files)) })

export class Lockfile {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules

  constructor({ config = { scope: 'full' }, entries, modules } = {}) {
    assert(['node_modules', 'full'].includes(config.scope))
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
  }

  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))

    const full = json.config.scope === 'full'
    assert(!!json.entries === full)
    assert(!!json.sources === full)
    assert(json.modules)

    const modules = new Map(
      Object.entries(json.modules).map(([dir, info]) => [dir, normalize(info)])
    )
    for (const [dir] of modules) assert(dir.includes('node_modules'))

    let entries = new Set()
    if (full) {
      assert(Array.isArray(json.entries))
      entries = new Set(json.entries)
      for (const [dir, info] of Object.entries(json.sources)) {
        assert(!dir.includes('node_modules'))
        modules.set(dir, normalize(info))
      }
    }

    for (const [dir, { files }] of modules) {
      assert(!dir.startsWith('..'))
      assert(files)
      for (const name of Object.keys(files)) {
        assert(!name.startsWith('..'))
      }
    }

    return new Lockfile({ config: json.config, entries, modules })
  }

  serialize() {
    const entries = fileSetToObject(this.entries)
    const modules = []
    const sources = []
    for (const [dir, { name, version, files }] of this.modules) {
      const type = dir.includes('node_modules') ? modules : sources
      const sorted = fromEntries(Object.entries(files).sort((a, b) => sortPaths(a[0], b[0])))
      type.push([dir, { name, version, files: sorted }])
    }
    modules.sort((a, b) => sortPaths(a[0], b[0]))
    sources.sort((a, b) => sortPaths(a[0], b[0]))

    const store = { version: this.version, config: this.config }
    if (this.config.scope === 'full') Object.assign(store, { entries, sources: fromEntries(sources) })
    Object.assign(store, { modules: fromEntries(modules) })
    return JSON.stringify(store, undefined, 2) + '\n'
  }
}
