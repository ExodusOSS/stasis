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

// Re-exported so `@exodus/stasis/cmd/build` keeps surfacing the lockfile->bundle
// reconstruction alongside the command; the implementation lives in its own module.
export { bundleFromLockfile }

// JS/TS entry extensions esbuild can build. esbuild handles JSX/TSX natively (loader
// 'jsx'/'tsx', derived from the extension by the load plugin), and stasis-core already
// classifies .jsx/.tsx as code (CODE_EXTENSIONS), so a bundle/lockfile captured by the
// esbuild/webpack plugins can carry them as entries.
const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])

// Allowlist (NOT a blocklist) of per-file formats `stasis build` accepts in an artifact:
// the JS/TS/JSON code formats esbuild builds, plus the non-code payload formats
// (resource/directory) that are inert unless the SELECTED entry imports them. An allowlist
// so a new language format added to `stasis bundle` later (e.g. a future `go`) is rejected
// here by default, rather than slipping through to a cryptic esbuild failure in the build.
const BUILDABLE_FORMATS = new Set([
  'module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
  'resource', 'resource:base64', 'directory',
])

// esbuild is an OPTIONAL peer dependency: `stasis build` is the only command that
// needs a bundler, so we don't force every stasis install to pull one in. Resolve it
// from the local install first (a peer dep hoisted into the project's node_modules, or
// an npx-provided copy), then fall back to a global install, with an actionable error
// if neither is present.
async function importEsbuild() {
  let mod
  try {
    mod = await import('esbuild')
  } catch (cause) {
    // Only a genuine "not installed" miss falls through to the global lookup; a
    // different failure (a corrupt install, a syntax error in esbuild) is surfaced.
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
  // esbuild ships a CJS module exposing named exports (build, context, ...); Node's
  // interop surfaces them directly. A globally-imported CJS copy may instead land its
  // exports on `default` -- accept both shapes.
  return typeof mod.build === 'function' ? mod : mod.default
}

// Locate a globally-installed esbuild via the package managers' "global root" commands.
// Returns the absolute path to esbuild's entry, or undefined when none is installed.
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
      continue // package manager not installed
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
        // keep probing
      }
    }
  }
  return undefined
}

// Validate that an artifact is something esbuild can build: full scope (node_modules
// scope omits the entry and workspace code, so it can't be built on its own), at least
// one entry, all entries JS/TS, and only buildable per-file formats (see BUILDABLE_FORMATS).
function assertBuildable(artifact, label) {
  if (artifact.config.scope !== 'full') {
    throw new Error(
      `stasis build requires a full-scope artifact; ${label} is scope='${artifact.config.scope}'. ` +
      `node_modules-scope artifacts omit the entry and workspace code, so there is nothing to build.`
    )
  }
  const entries = [...artifact.entries]
  if (entries.length === 0) {
    throw new Error(`stasis build: ${label} declares no entries to build`)
  }
  for (const entry of entries) {
    if (!JS_EXTS.has(extname(entry))) {
      throw new Error(`stasis build only builds JavaScript/TypeScript entries (esbuild); got non-JS entry '${entry}' in ${label}`)
    }
  }
  // artifact.formats is a Map (Bundle) or may be null on a legacy lockfile (an absent map
  // is fine -- nothing to check). Reject any format outside the allowlist: the non-JS
  // LANGUAGE bundlers' formats (Solidity/PHP/Bash/Rust) and anything added later.
  //
  // NOTE: resource formats are IN the allowlist -- deliberately NOT rejected here. A resource
  // is recorded as a FILE but never as an import EDGE, so whether a build hits one depends on
  // the SELECTED entry's own source, not the artifact as a whole -- a code-only entry must
  // build even when the artifact carries assets for OTHER entries. An entry that does import
  // an asset fails at build time (esbuild can't resolve the un-graphed resource).
  for (const [file, format] of artifact.formats ?? new Map()) {
    if (!BUILDABLE_FORMATS.has(format)) {
      throw new Error(`stasis build only supports JavaScript/TypeScript bundles (esbuild); ${label} carries a '${format}' file (${file})`)
    }
  }
}

// Pick which recorded entry to build. The build produces exactly one entry's bundle;
// `entryArg` selects it. With a single recorded entry the selector is optional (that
// entry is used); with several it is required, and an absent or unknown one is rejected
// with the available list. The selector is matched against the artifact's recorded
// (project-relative) entries -- only those are attested as graph roots, and the load
// plugin's assertEntry rejects anything else -- accepting the recorded path verbatim, a
// leading `./` stripped, or a cwd-relative path normalized into the project root.
function selectEntry(entryArg, entries, { cwd, root, label }) {
  const recorded = [...entries]
  const list = recorded.map((e) => `  ${e}`).join('\n')
  if (entryArg === undefined) {
    if (recorded.length === 1) return recorded[0]
    // length === 0 is impossible here (assertBuildable required >= 1 entry).
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

// Build a bundle-load State that serves an in-memory Bundle -- the same shape StasisEsbuild's
// load path reads from (state.sources / state.resources / state.formats / state.imports /
// state.entries). skipDiscovery anchors the State at `root` and does NO filesystem discovery:
// no package.json walk, no on-disk config, no stray stasis.code.br read. bundle=load +
// lock=ignore serve the bundle's own bytes (self-attesting -- the lockfile path already
// SHA-512-verified them in bundleFromLockfile). We mirror State's on-disk load (split
// sources/resources by format) and fill the maps from `bundle`.
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
  // Not state.modules: the load path (getImport/getFile/getFormat/assertEntry) never reads
  // it -- it's only written by the capture paths. The State's empty-Map default stands.
  return state
}

// Run the `stasis build` CLI command end-to-end: take a stasis artifact (a `stasis.code.br`
// bundle, or a `stasis.lock.json` lockfile whose attested files are read + verified from
// disk) and an entry point, and run esbuild over that one entry, following the artifact's
// recorded import graph EXACTLY rather than esbuild's own resolver.
//
// `entry` selects which recorded entry to build (see selectEntry): optional when the
// artifact records one, required when it records several. `output` is required: a path
// ending in `.js`/`.cjs`/`.mjs` writes a single file, anything else a directory.
//
// The build runs entirely in memory off the artifact -- no temp files, and no package.json
// required. The artifact's relative paths anchor at the artifact's OWN directory: a bundle is
// self-contained (root is just a keying prefix; nothing is read from disk), and a lockfile
// records its paths relative to where it sits (its project root), so its sources are read +
// verified from there. A project stasis.config.json is not consulted -- the build is driven
// by the artifact, not by `stasis run` config.
//
// The recorded graph is forced via the stasis esbuild plugin in bundle-load mode: each import
// resolves to the edge stasis recorded (a specifier the artifact doesn't record is handed back
// to esbuild, which externalizes it like a built-in/`external`), and each module's bytes come
// from the artifact -- so the output reflects what stasis attested, not what's on disk.
//
// `format` (esm/cjs/iife, default esm), `platform` (node/browser/neutral, default node),
// `minify`, `sourcemap`, `define` (an esbuild define map), `external` (an array of esbuild
// external patterns), and `loader` (an esbuild extension->loader map, e.g. { '.js': 'jsx' }
// to parse JSX in .js files) are forwarded to esbuild; the import graph is fixed by the artifact.
//
// `external` is esbuild's native option: it only steers specifiers esbuild itself would
// resolve -- i.e. the ones the bundle does NOT record (handed back to esbuild as a miss,
// typically the externals that existed at capture time). It re-declares those so esbuild
// leaves them as runtime imports instead of trying (and failing) to resolve them on disk.
// A specifier the artifact DOES record is still followed from the artifact -- the recorded
// graph wins, so `external` never silently un-inlines an attested edge.
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
  assertBuildable(parsed, artifact)

  // Anchor the artifact's relative paths at the artifact's OWN directory. A bundle is
  // self-contained (root is just a keying prefix; nothing is read from disk), and a lockfile
  // records its paths relative to where it sits -- its project root -- so its sources are
  // read + verified from there. No package.json discovery, no project stasis.config.json.
  const root = dirname(artifactAbs)
  const selectedEntry = selectEntry(entry, parsed.entries, { cwd, root, label: artifact })

  // The Bundle the load State serves, entirely in memory. A bundle artifact is already a
  // parsed Bundle; a lockfile is reconstructed into one by reading + SHA-512-verifying its
  // attested files from disk (bundleFromLockfile). The plugin drives off the in-memory State.
  const bundle = kind === 'lockfile' ? bundleFromLockfile(parsed, { root }) : parsed
  const state = loadStateForBundle(root, bundle)
  // The selected entry is project-relative in the artifact; make it absolute against the
  // State's root so esbuild's entry resolution is independent of the process cwd.
  const entryPoint = resolve(state.root, selectedEntry)

  const esbuild = await importEsbuild()
  const outAbs = resolve(cwd, output)
  // A `.js`/`.cjs`/`.mjs` --output names a single output file; anything else is a directory.
  const asFile = /\.[cm]?js$/u.test(output)
  // Absolute paths the artifact attests -- esbuild must NEVER overwrite one. A stray
  // `--output=src/x.js` (or `--output=src`/`.` whose computed output basename collides with a
  // recorded source) would otherwise destroy an attested file: esbuild's own "refusing to
  // overwrite input file" check fires only AFTER it has written, and for a lockfile that
  // permanently breaks the file's hash. So we build with write:false and write the outputs
  // ourselves, refusing -- before touching disk -- to clobber any recorded file.
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
      // Per-extension loader overrides drive the stasis plugin's load-mode loader choice
      // (the plugin serves and labels every in-bundle file, so esbuild's own `loader`
      // option never sees them). e.g. { '.js': 'jsx' } to parse JSX in .js files.
      plugins: [new StasisEsbuild(state, { loaders: new Map(Object.entries(loader)) })],
    })
  } catch (err) {
    // esbuild rejects with a BuildFailure carrying a formatted `.errors` array under
    // logLevel:'silent'. Surface those (rather than the bare wrapper) so the user sees the
    // actual resolve/load failure -- including an entry that imports an un-buildable asset
    // -- then fail the command.
    if (Array.isArray(err?.errors) && err.errors.length > 0) {
      const formatted = await esbuild.formatMessages(err.errors, { kind: 'error', color: false })
      for (const line of formatted) process.stderr.write(line)
      throw new Error(`stasis build failed: esbuild reported ${err.errors.length} error(s)`, { cause: err })
    }
    throw err
  }

  // The build succeeded. Refuse to clobber an attested source -- checked against esbuild's
  // ACTUAL output paths (so it covers both `--output` file and directory), BEFORE any write,
  // so a rejected build leaves every recorded file intact.
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
