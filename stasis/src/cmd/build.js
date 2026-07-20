import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { StasisEsbuild } from '@exodus/stasis-plugins/esbuild'
import { bundleFromLockfile } from '../bundle-from-lockfile.js'
import { parseFileWithKind } from '../parse.js'

export { bundleFromLockfile }

const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])

// Allowlist (not blocklist) of per-file formats `stasis build` accepts, so a bundle
// format added later fails closed here rather than in a cryptic esbuild error.
const BUILDABLE_FORMATS = new Set([
  'module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
  'resource', 'resource:base64', 'directory', 'stat:file', 'stat:directory',
])

// esbuild is an optional peer dep; resolve it from the local install, else fall back
// to a global one.
async function importEsbuild() {
  let mod
  try {
    mod = await import('esbuild')
  } catch (cause) {
    // Only a genuine "not installed" miss falls through to the global lookup; surface other failures.
    if (cause?.code !== 'ERR_MODULE_NOT_FOUND' && cause?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw cause
    }
    const globalMain = resolveGlobalEsbuild()
    if (!globalMain) {
      throw new Error(
        'stasis build requires esbuild, which could not be found.\n' +
        'Install it as a dev dependency (npm i -D esbuild / pnpm add -D esbuild / yarn add -D esbuild) ' +
        'or globally (npm i -g esbuild).',
        { cause }
      )
    }
    mod = await import(pathToFileURL(globalMain).href)
  }
  // A globally-imported CJS copy may land its exports on `default` -- accept both shapes.
  return typeof mod.build === 'function' ? mod : mod.default
}

function resolveGlobalEsbuild() {
  const probes = [
    ['npm', ['root', '-g']],
    ['pnpm', ['root', '-g']],
    ['yarn', ['global', 'dir']],
  ]
  for (const [cmd, args] of probes) {
    let out
    try {
      out = spawnSync(cmd, args, { encoding: 'utf8' })
    } catch {
      continue
    }
    if (!out || out.status !== 0 || !out.stdout) continue
    const base = out.stdout.trim()
    if (!base) continue
    // `npm/pnpm root -g` print the global node_modules dir; `yarn global dir` prints a
    // dir whose node_modules holds the packages. Try both shapes.
    for (const nm of [base, join(base, 'node_modules')]) {
      if (!existsSync(join(nm, 'esbuild', 'package.json'))) continue
      try {
        return createRequire(join(nm, 'noop.js')).resolve('esbuild')
      } catch {
      }
    }
  }
  return undefined
}

// Artifact-wide preconditions, independent of which entry we build: full scope (a
// node_modules-scope artifact omits the entry + workspace code) and at least one recorded
// entry (so selectEntry has something to choose). The per-entry / per-file language checks
// are deferred to assertBuildableEntry, once the entry to build is known.
function assertBuildableArtifact(artifact, label) {
  if (artifact.config.scope !== 'full') {
    throw new Error(
      `stasis build requires a full-scope artifact; ${label} is scope='${artifact.config.scope}'. ` +
      `node_modules-scope artifacts omit the entry and workspace code, so there is nothing to build.`
    )
  }
  if (artifact.entries.size === 0) {
    throw new Error(`stasis build: ${label} declares no entries to build`)
  }
}

// The set of files the build will actually touch: the entry plus everything reachable from
// it through the artifact's recorded import graph (walked across every conditions bucket; a
// --metro edge's per-platform targets are all followed). esbuild follows this same graph, so
// nothing outside it reaches the build -- which is why the language checks below scope to it.
function reachableFiles(entry, imports) {
  const seen = new Set([entry])
  const stack = [entry]
  while (stack.length > 0) {
    const parent = stack.pop()
    for (const [, byParent] of imports) {
      const specifiers = byParent.get(parent)
      if (specifiers === undefined) continue
      for (const [, target] of specifiers) {
        // A plain edge records a file string; a --metro edge records a {platform: file} Map.
        const targets = typeof target === 'string' ? [target] : [...target.values()]
        for (const file of targets) {
          if (!seen.has(file)) {
            seen.add(file)
            stack.push(file)
          }
        }
      }
    }
  }
  return seen
}

// Language checks scoped to the ONE entry we build: the entry itself must be JS/TS, and every
// file reachable from it must have a buildable format. An unrelated non-JS file elsewhere in
// the artifact -- a second entry's subtree, or a file attested with `stasis add` -- is never
// reached from this entry, so it does not block the build. `imports`/`formats` may be null on
// a legacy lockfile (an empty graph; bundleFromLockfile then fails closed on the missing graph).
function assertBuildableEntry(artifact, entry, label) {
  if (!JS_EXTS.has(extname(entry))) {
    throw new Error(`stasis build only builds JavaScript/TypeScript entries (esbuild); got non-JS entry '${entry}' in ${label}`)
  }
  const reachable = reachableFiles(entry, artifact.imports ?? new Map())
  // Resource formats stay in the allowlist deliberately: assets are files, never import edges,
  // so a reachable-only check never even sees them (an entry that imports one fails at build time).
  for (const [file, format] of artifact.formats ?? new Map()) {
    if (!reachable.has(file)) continue
    if (!BUILDABLE_FORMATS.has(format)) {
      throw new Error(`stasis build only supports JavaScript/TypeScript bundles (esbuild); ${label} carries a '${format}' file (${file})`)
    }
  }
}

// Pick which recorded entry to build; required only when several are recorded. Matched
// against the recorded project-relative entries (verbatim, `./`-stripped, or cwd-relative).
function selectEntry(entryArg, entries, { cwd, root, label }) {
  const recorded = [...entries]
  const list = recorded.map((e) => `  ${e}`).join('\n')
  if (entryArg === undefined) {
    if (recorded.length === 1) return recorded[0]
    // length === 0 is impossible here (assertBuildableArtifact required >= 1 entry).
    throw new Error(`stasis build: ${label} has ${recorded.length} entry points; pass one as the second argument:\n${list}`)
  }
  const candidates = new Set([
    entryArg,
    entryArg.replace(/^\.\//u, ''),
    relative(root, resolve(cwd, entryArg)).split(sep).join('/'),
  ])
  const match = recorded.find((e) => candidates.has(e))
  if (match === undefined) {
    throw new Error(`stasis build: '${entryArg}' is not an entry point of ${label}; available:\n${list}`)
  }
  return match
}

// Build a bundle-load State that serves an in-memory Bundle. skipDiscovery does NO
// filesystem discovery (no package.json walk, no on-disk config, no stray stasis.code.br).
function loadStateForBundle(root, bundle) {
  const state = new State(root, { bundle: 'load', lock: 'ignore', scope: bundle.config.scope, skipDiscovery: true })
  const sources = new Map()
  const resources = new Map()
  for (const [file, content] of bundle.sources) {
    if (Bundle.isResourceFormat(bundle.formats.get(file))) resources.set(file, content)
    else sources.set(file, content)
  }
  state.sources = sources
  state.resources = resources
  state.formats = bundle.formats
  state.imports = bundle.imports
  state.entries = new Set(bundle.entries)
  // Not state.modules: the load path never reads it (only the capture paths write it).
  return state
}

// Run `stasis build`: run esbuild over one recorded entry, following the artifact's
// recorded import graph EXACTLY (not esbuild's resolver). A specifier the artifact records
// is always followed from the artifact; `external` only steers the specifiers it doesn't.
export async function buildCommand({
  cwd = process.cwd(),
  artifact,
  entry,
  output,
  format = 'esm',
  platform = 'node',
  minify = false,
  sourcemap = false,
  define = {},
  external = [],
  loader = {},
} = {}) {
  if (!artifact) throw new Error('stasis build: an artifact (bundle or lockfile) is required')
  if (!output) throw new Error('stasis build: --output is required (a .js/.cjs/.mjs file, or a directory)')
  if (!Array.isArray(external)) throw new Error('stasis build: external must be an array of esbuild patterns')
  const artifactAbs = resolve(cwd, artifact)
  const { kind, artifact: parsed } = parseFileWithKind(artifactAbs)
  assertBuildableArtifact(parsed, artifact)

  // Anchor artifact-relative paths at the artifact's own directory; a lockfile's sources
  // are read + verified from there.
  const root = dirname(artifactAbs)
  const selectedEntry = selectEntry(entry, parsed.entries, { cwd, root, label: artifact })
  // Language checks run against the SELECTED entry only: other entries (and their non-JS
  // subtrees) are not our concern when building this one.
  assertBuildableEntry(parsed, selectedEntry, artifact)

  const bundle = kind === 'lockfile' ? bundleFromLockfile(parsed, { root }) : parsed
  const state = loadStateForBundle(root, bundle)
  // Make the entry absolute against the State's root so resolution is independent of process cwd.
  const entryPoint = resolve(state.root, selectedEntry)

  const esbuild = await importEsbuild()
  const outAbs = resolve(cwd, output)
  const asFile = /\.[cm]?js$/u.test(output)
  // Never overwrite a file the artifact attests: esbuild's own overwrite check fires only
  // after writing (corrupting a lockfile's hash), so we build write:false and refuse to
  // clobber any recorded file before touching disk.
  const attested = new Set([...state.sources.keys(), ...state.resources.keys()].map((f) => resolve(state.root, f)))

  let result
  try {
    result = await esbuild.build({
      entryPoints: [entryPoint],
      absWorkingDir: state.root,
      bundle: true,
      write: false,
      platform,
      format,
      logLevel: 'silent',
      ...(minify ? { minify: true } : {}),
      ...(sourcemap ? { sourcemap: true } : {}),
      ...(external.length > 0 ? { external } : {}),
      ...(Object.keys(define).length > 0 ? { define } : {}),
      ...(asFile ? { outfile: outAbs } : { outdir: outAbs }),
      // Loader overrides go through the plugin: it serves every in-bundle file, so esbuild's
      // own `loader` option never sees them. e.g. { '.js': 'jsx' } to parse JSX in .js files.
      plugins: [new StasisEsbuild(state, { loaders: new Map(Object.entries(loader)) })],
    })
  } catch (err) {
    // Under logLevel:'silent' esbuild puts the real errors on err.errors; surface them, then fail.
    if (Array.isArray(err?.errors) && err.errors.length > 0) {
      const formatted = await esbuild.formatMessages(err.errors, { kind: 'error', color: false })
      for (const line of formatted) process.stderr.write(line)
      throw new Error(`stasis build failed: esbuild reported ${err.errors.length} error(s)`, { cause: err })
    }
    throw err
  }

  // Refuse to clobber an attested source, checked against esbuild's actual output paths before any write.
  for (const file of result.outputFiles) {
    if (attested.has(file.path)) {
      throw new Error(
        `stasis build: refusing to write '${relative(cwd, file.path)}' -- it is a source the artifact records; ` +
        `choose an --output path outside the artifact's own files`
      )
    }
  }

  if (result.warnings.length > 0) {
    const formatted = await esbuild.formatMessages(result.warnings, { kind: 'warning', color: false })
    for (const line of formatted) process.stderr.write(line)
  }

  for (const file of result.outputFiles) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents)
  }

  console.warn(`[stasis] Built ${selectedEntry} from ${kind} ${artifact} to ${output}`)
  return { entry: selectedEntry, dir: asFile ? undefined : outAbs, outfile: asFile ? outAbs : undefined }
}
