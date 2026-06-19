// Test harness: drives the StasisMetro plugin against the cwd as the project root,
// then writes stasis state. Driven by tests/metro.test.js via spawnSync, so each
// test gets a fresh State per process (which keeps the preload-singleton invariant
// happy across cases).
//
// Metro is not a dependency of this repo, and -- like webpack/esbuild -- the plugin
// never imports its bundler; it only consumes the module graph Metro hands a
// serializer. So instead of running a real Metro build, this helper builds a
// FAITHFUL MOCK of Metro's ReadOnlyGraph from a JSON manifest and feeds it to the
// plugin exactly as Metro's serializer would. The mock mirrors the real shape the
// plugin reads: `graph.dependencies` (Map<absPath, Module>), `graph.entryPoints`
// (Set<absPath>), per-module `path` / `dependencies` (Map<opaqueKey, { absolutePath,
// data: { name } }>) / `getSource()` / `output`, and the separate `preModules` array
// the customSerializer receives.
//
// Like the webpack/esbuild helpers, a preload State is constructed first (mirroring
// the plugin's options) so resolvePluginState lands in the reuse path; set
// STASIS_TEST_PRELOAD=0 to exercise the standalone / noop / hard-throw paths.
//
// Usage: node tests/metro-run.helper.js <entry> [<entry>...]
// STASIS_TEST_METRO_GRAPH (JSON, required) -- the module graph manifest:
//     { "modules": [ { "path": "src/entry.js", "deps": [["./hello.js","src/hello.js"]] }, ... ],
//       "preModules": [ { "path": "runtime/polyfill.js", "deps": [] }, ... ] }
//   `path` and each dep target are project-relative and resolved against cwd; each
//   dep is a [specifier, targetRelativePath] pair (target null = unresolved/virtual edge).
//   `preModules` (optional) models Metro's prepended polyfills/runtime.
// STASIS_TEST_METRO_MODE -- 'hook' (default) | 'customSerializer' | 'withStasis'.
// STASIS_TEST_PLUGIN_OPTIONS (JSON)  -- routes through the plugin's options.
// STASIS_TEST_PRELOAD_OPTIONS (JSON) -- overrides what the preload sees (sidecar/rule 6).
// STASIS_TEST_PRELOAD=0              -- disables the preload State entirely.

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

import { State } from '@exodus/stasis-core/state'

const entries = process.argv.slice(2)
if (entries.length === 0) {
  console.error('Usage: metro-run.helper.js <entry> [...]')
  process.exit(2)
}

const graphRaw = process.env.STASIS_TEST_METRO_GRAPH
if (!graphRaw) {
  console.error('metro-run.helper.js requires STASIS_TEST_METRO_GRAPH')
  process.exit(2)
}
const manifest = JSON.parse(graphRaw)

const pluginOptionsRaw = process.env.STASIS_TEST_PLUGIN_OPTIONS
const pluginOptions = pluginOptionsRaw ? JSON.parse(pluginOptionsRaw) : undefined

const KNOWN_OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'debug', 'resources']
const preloadOptionsRaw = process.env.STASIS_TEST_PRELOAD_OPTIONS
const preloadOverrides = preloadOptionsRaw ? JSON.parse(preloadOptionsRaw) : undefined
const preloadOptions = { preload: true }
const sourceForPreload = preloadOverrides ?? pluginOptions
if (sourceForPreload) {
  for (const k of KNOWN_OPTION_KEYS) {
    if (sourceForPreload[k] !== undefined) preloadOptions[k] = sourceForPreload[k]
  }
}
const preloadDisabled = process.env.STASIS_TEST_PRELOAD === '0'
const _preload = preloadDisabled ? undefined : new State(process.cwd(), preloadOptions)

const { StasisMetro, withStasis } = await import('../stasis/src/metro.js')

// Build the Metro-shaped mock modules from the manifest.
const abs = (rel) => resolve(process.cwd(), rel)
const buildModule = (mod) => {
  const modPath = abs(mod.path)
  const deps = new Map()
  let depIndex = 0
  for (const [specifier, targetRel] of mod.deps ?? []) {
    // A null target models an unresolved/virtual edge (no absolutePath). Real Metro
    // (>=0.72) keys module.dependencies by an OPAQUE hash, not the specifier -- key by a
    // synthetic non-specifier value so the plugin can't accidentally come to rely on the
    // key (it must read dep.data.name for the specifier and iterate .values()).
    const absolutePath = targetRel == null ? undefined : abs(targetRel)
    deps.set(`dep${depIndex++}`, { absolutePath, data: { name: specifier } })
  }
  return {
    path: modPath,
    dependencies: deps,
    getSource: () => readFileSync(modPath),
    output: [{ type: 'js/module', data: { code: '/* mock */', lineCount: 1, map: [] } }],
  }
}

const dependencies = new Map()
for (const mod of manifest.modules) {
  const m = buildModule(mod)
  dependencies.set(m.path, m)
}
const preModules = (manifest.preModules ?? []).map(buildModule)
const graph = {
  dependencies,
  entryPoints: new Set(entries.map((e) => abs(e))),
  transformOptions: { platform: 'ios', dev: false, type: 'module' },
}
const delta = { added: dependencies, modified: new Map(), deleted: new Set(), reset: true }

// A mock base serializer (Metro's customSerializer contract): records what it received so
// tests can confirm delegation + that preModules were forwarded, and returns {code, map}.
const baseSerializer = (entryPoint, pre, g, _options) =>
  ({ code: `// stasis base: ${g.dependencies.size} modules, ${pre.length} preModules\n`, map: '' })

const entryAbs = abs(entries[0])
const mode = process.env.STASIS_TEST_METRO_MODE || 'hook'
const stasis = new StasisMetro(pluginOptions)

if (mode === 'customSerializer') {
  const out = stasis.customSerializer(baseSerializer)(entryAbs, preModules, graph, {})
  process.stdout.write(typeof out === 'string' ? out : out.code)
} else if (mode === 'withStasis') {
  // withStasis builds its OWN StasisMetro(pluginOptions) (which reuses the preload) and
  // wires it onto the config's customSerializer, wrapping the base we provide.
  const config = withStasis({ serializer: { customSerializer: baseSerializer } }, pluginOptions ?? {})
  const out = config.serializer.customSerializer(entryAbs, preModules, graph, {})
  process.stdout.write(typeof out === 'string' ? out : out.code)
} else {
  // experimentalSerializerHook signature: (graph, delta) -- no preModules.
  stasis.serializerHook(graph, delta)
}

if (State.preload) State.preload.write()
