#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import assert from 'node:assert/strict'
import { parseBrotliQuality } from '@exodus/stasis-core/util'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b)
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

function usage(prefix = '') {
  console.error(`${prefix}\nUsage:
 stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--mock] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
 stasis bundle [--mapping=path/to/remappings(.txt|.toml)] [--add] [--output=(path|-)] path/to/file.sol ...
 stasis bundle [--add] [--output=(path|-)] path/to/file.php ...
 stasis bundle [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--jsx] [--flow] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts) ...
 stasis bundle --metro --platforms=ios,android [--platforms=web] [--jsx] [--flow] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts) ...
 stasis bundle [--add] [--output=(path|-)] path/to/file.(sh|bash) ...
 stasis bundle [--add] [--output=(path|-)] path/to/file.rs ...
 (writes to stasis.code.br by default; --output=- streams to stdout; --add merges into an
  existing bundle instead of replacing it (not with --output=-); --brotli-quality=0..11, default 9;
  --jsx parses JSX in .js/.cjs/.mjs files, e.g. React Native source (put JSX-in-TS in a .tsx file);
  --flow strips Flow types from .js/.cjs/.mjs sources oxc can't parse (needs the optional flow-remove-types dep))
 stasis add path/to/(file|dir) ...
 (adds the listed files to the project's bundle(s) with no dependency resolution;
  a directory expands to its files. Requires a stasis.config.json (all fields optional).)
 stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral)] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
 stasis extract [--output=path/to/dir] path/to/bundle.stasis.code.br
 stasis diff --stat [--imports] path/to/(lockfile|bundle) path/to/(lockfile|bundle)
 stasis prune [path/to/project]
 stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] path/to/file ...
 (--why lists, per advisory, the cross-module import paths that pull the package in,
  prefixed by the bundle consumer that imports each chain at the top level, e.g. "run: a -> b -> c";
  it skips chains whose full tail is already listed as its own chain -- --why-deep keeps them all;
  --why-full spells every chain out instead of collapsing repeated tails to "a -> b -> ... -> d";
  --reason=consumer shows only advisories related to that consumer, and with --why only its chains)
 stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle) ...
 (streams to stdout by default; --output=- is explicit stdout)
`.trim())
  process.exit(1)
}

function setEnv(name, value) {
  const env = process.env[name]
  if (env && env !== value) throw new Error(`env conflict: ${name}="${env}", effective: "${value}"`)
  process.env[name] = value === undefined ? '' : value
}

const command = argv.shift()

if (command === '-v' || command === '--version') {
  console.log(`v${pkg.version}`)
  process.exit(0)
} else if (command === 'run') {
  const flags = []
  const valueFlags = new Set(['--bundle', '--bundle-file', '--resources-bundle-file', '--lock', '--resources', '--brotli-quality'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }

  const options = {
    lock: { type: 'string', default: 'none' },
    bundle: { type: 'string', default: 'none' },
    'bundle-file': { type: 'string' },
    'resources-bundle-file': { type: 'string' },
    debug: { type: 'boolean' },
    dependencies: { type: 'boolean' },
    'child-process': { type: 'boolean' },
    mock: { type: 'boolean' },
    fs: { type: 'string' },
    resources: { type: 'string' },
    'brotli-quality': { type: 'string' },
  }

  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to run: no path to file given')
  if (!['none', 'ignore', 'add', 'replace', 'frozen'].includes(values.lock)) usage('Error: invalid --lock value')
  const lock = values.lock
  const scope = values.dependencies ? 'node_modules' : 'full'
  const bundle = values.bundle
  const bundleFile = values['bundle-file'] ? resolve(values['bundle-file']) : ''
  const resourcesBundleFile = values['resources-bundle-file'] ? resolve(values['resources-bundle-file']) : ''
  const debug = values.debug ? '1' : ''
  if (!['none', 'ignore', 'add', 'replace', 'load', 'frozen'].includes(bundle)) usage('Error: invalid --bundle value')
  if (bundleFile && bundle === 'none') usage('Error: --bundle-file requires --bundle=(add|replace|load|frozen|ignore)')
  // --resources-bundle-file needs an active bundle mode (unlike --bundle-file, inert under ignore).
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) usage('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') usage('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') usage('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  if (values.mock && bundle === 'load') usage('Error: --mock is for capturing imports while building a bundle; not compatible with --bundle=load')
  // --fs requires a bundle mode (add|replace|load); `sync` patches the sync fs readers,
  // `async` adds their callback + fs.promises counterparts on top.
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) usage("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) usage('Error: --fs requires --bundle=(add|replace|load)')
  const captureFs = values.fs ?? ''
  // --resources: comma-separated extension/filename allowlist for `--fs` captures.
  const resources = values.resources ?? ''
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      usage(`Error: ${cause.message}`)
    }
  }
  // --child-process: forward forked-child (e.g. Metro worker) capture to the root via per-pid shards.
  const childProcess = values['child-process'] ? '1' : ''
  console.warn('[stasis] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(resourcesBundleFile && { resourcesBundleFile }), ...(childProcess && { childProcess: true }), ...(values.mock && { mock: true }), ...(values.fs && { fs: values.fs }), ...(resources && { resources }), ...(brotliQuality !== undefined && { brotliQuality }) })
  if (debug) console.warn(`[stasis] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_RESOURCES_BUNDLE_FILE', resourcesBundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_CHILD_PROCESS', childProcess)
  setEnv('EXODUS_STASIS_FS', captureFs)
  setEnv('EXODUS_STASIS_RESOURCES', resources)
  // Only set when given; an unconditional setEnv('') would conflict with an ambient value.
  if (brotliQuality !== undefined) setEnv('EXODUS_STASIS_BROTLI_QUALITY', String(brotliQuality))
  // --mock: capture imports by running user code with side-effects denied (fail-closed).
  // --permission blocks fs writes/child procs/workers/addons/inspector at the kernel level;
  // src/mock.js neutralizes network + timers in JS (no --allow-* for those). Reads stay open
  // so node_modules resolution works.
  // Node 24 dropped comma-separated --allow-fs-write; repeat the flag instead.
  const nodeArgs = []
  if (values.mock) {
    const writeAllow = [process.cwd()]
    // --allow-fs-write paths must already exist on disk, so for each out-of-cwd bundle target
    // walk up to the nearest existing ancestor and grant write there.
    for (const [flag, file] of [['--bundle-file', bundleFile], ['--resources-bundle-file', resourcesBundleFile]]) {
      if (!file || file.startsWith(`${process.cwd()}/`)) continue
      let p = dirname(file)
      while (!existsSync(p) && dirname(p) !== p) p = dirname(p)
      // Refuse write access to the filesystem root -- it would disable the --permission layer everywhere.
      if (p === dirname(p)) {
        usage(`Error: no existing parent directory for ${flag}=${file}; create one first or choose a path under an existing directory`)
      }
      if (!writeAllow.includes(p)) writeAllow.push(p)
    }
    nodeArgs.push('--permission', '--allow-fs-read=*')
    for (const p of writeAllow) nodeArgs.push(`--allow-fs-write=${p}`)
    // Restore the node-addons resolution condition (dropped by --permission) so the captured
    // import map matches a non-mock run; native addons still can't load (--allow-addons off).
    nodeArgs.push('--conditions=node-addons')
  }
  // --mock uses stasis's loader-mock entry (composes the mock before installing the hooks).
  const loaderEntry = values.mock ? '../src/loader-mock.js' : '@exodus/stasis-core/loader'
  nodeArgs.push('--import', import.meta.resolve(loaderEntry))
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code, signal] = await once(child, 'close')
  // code is null when the child died from a signal; report 128+signo (shell convention) instead of the implicit 0
  process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0)
} else if (command === 'bundle') {
  const flags = []
  const valueFlags = new Set(['--mapping', '--output', '--scope', '--lockfile', '--conditions', '--mainFields', '--platforms', '--brotli-quality', '-o'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  const options = {
    mapping: { type: 'string' },
    output: { type: 'string', short: 'o' },
    scope: { type: 'string' },
    lockfile: { type: 'string' },
    conditions: { type: 'string' },
    mainFields: { type: 'string' },
    metro: { type: 'boolean' },
    platforms: { type: 'string', multiple: true },
    jsx: { type: 'boolean' },
    flow: { type: 'boolean' },
    'brotli-quality': { type: 'string' },
    add: { type: 'boolean' },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to bundle: no entry file given')
  const allSol = argv.every((f) => f.endsWith('.sol'))
  const allPhp = argv.every((f) => f.endsWith('.php'))
  const allJs = argv.every((f) => /\.(?:js|cjs|mjs|ts|cts|mts)$/u.test(f))
  const allBash = argv.every((f) => /\.(?:sh|bash)$/u.test(f))
  const allRust = argv.every((f) => f.endsWith('.rs'))
  if (!allSol && !allPhp && !allJs && !allBash && !allRust) {
    usage('Error: bundle entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts, all be .sh/.bash, or all be .rs')
  }
  if (values.mapping && !allSol) usage('Error: --mapping is only valid for .sol bundles')
  if (values.scope && !allJs) usage('Error: --scope is only valid for JS bundles')
  if (values.scope && !['node_modules', 'full'].includes(values.scope)) {
    usage('Error: --scope must be node_modules or full')
  }
  if (values.lockfile && !allJs) usage('Error: --lockfile is only valid for JS bundles')
  // --mainFields/--metro always emit a full-scope bundle, so they'd silently ignore --scope.
  if (values.scope !== undefined && (values.mainFields !== undefined || values.metro)) {
    usage('Error: --scope is not supported with --mainFields or --metro')
  }
  // --conditions: extra exports/imports resolution conditions merged onto Node's defaults;
  // they don't honour legacy `mainFields` or platform suffixes (see --mainFields).
  if (values.conditions !== undefined && !allJs) usage('Error: --conditions is only valid for JS bundles')
  const conditions = values.conditions === undefined
    ? []
    : values.conditions.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.conditions !== undefined && conditions.length === 0) {
    usage('Error: --conditions must list at least one condition name (e.g. --conditions=react-native,browser)')
  }
  // --flow: strip Flow type syntax (via the optional flow-remove-types dep) before parsing; JS-only.
  if (values.flow && !allJs) usage('Error: --flow is only valid for JS bundles')
  const flow = Boolean(values.flow)
  // --mainFields: legacy package entry fields (e.g. react-native,browser,main) for the non-exports resolver.
  if (values.mainFields !== undefined && !allJs) usage('Error: --mainFields is only valid for JS bundles')
  const mainFields = values.mainFields === undefined
    ? undefined
    : values.mainFields.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.mainFields !== undefined && mainFields.length === 0) {
    usage('Error: --mainFields must list at least one field (e.g. --mainFields=react-native,browser,main)')
  }
  // --metro: resolve like Metro/RN (its own conditions + mainFields, platform suffixes per
  // --platforms target). --platforms is repeatable and/or comma-separated; the values union.
  const metro = Boolean(values.metro)
  const platforms = [...new Set((values.platforms ?? []).flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean))]
  // A platform name becomes an edge key: reject '/' (parsers reject it) and '*' (reserved placeholder).
  for (const p of platforms) {
    if (p === '*' || p.includes('/')) usage(`Error: invalid --platforms value '${p}' (a platform name can't contain '/' or be '*')`)
  }
  if ((metro || platforms.length > 0) && !allJs) usage('Error: --metro is only valid for JS bundles')
  // --jsx: parse React Native's JSX-in-.js source in the static scanner (off by default; oxc,
  // like tsc, only auto-enables JSX for .jsx/.tsx). Orthogonal to the resolver, so it pairs with
  // plain/--mainFields/--metro alike -- JS-only, since no other entry language is scanned.
  const jsx = Boolean(values.jsx)
  if (jsx && !allJs) usage('Error: --jsx is only valid for JS bundles')
  if (metro) {
    if (conditions.length > 0) usage("Error: --conditions can't be combined with --metro (it sets its own conditions)")
    if (mainFields !== undefined) usage("Error: --mainFields can't be combined with --metro (it sets its own mainFields)")
    if (platforms.length === 0) usage('Error: --metro requires --platforms (e.g. --platforms=ios,android)')
  } else if (platforms.length > 0) {
    usage('Error: --platforms is only valid with --metro')
  }
  // --brotli-quality: valid for every entry language (no allJs gate).
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      usage(`Error: ${cause.message}`)
    }
  }
  // --add merges into the existing bundle at --output, so it can't target write-only stdout.
  const add = Boolean(values.add)
  if (add && values.output === '-') usage('Error: --add cannot be combined with --output=-')
  const { bundleCommand } = await import('../src/cmd/bundle.js')
  await bundleCommand({
    cwd: process.cwd(),
    entries: argv,
    mappingFile: values.mapping,
    output: values.output,
    scope: values.scope,
    lockfile: values.lockfile,
    conditions,
    mainFields,
    metro,
    platforms,
    jsx,
    flow,
    brotliQuality,
    add,
  })
} else if (command === 'add') {
  // add packs the listed files (no resolver), taking split targets + resource allowlist from
  // stasis.config.json; it takes no flags.
  if (argv.length === 0) usage('Nothing to add: no file given')
  if (argv.some((a) => a.startsWith('-'))) usage('Error: add takes no options; its targets and resource allowlist come from stasis.config.json')
  const { addCommand } = await import('@exodus/stasis-core/add')
  // Let addCommand's runtime errors propagate as-is; wrapping in usage() would bury the cause.
  addCommand({ cwd: process.cwd(), entries: argv, logLabel: 'stasis' })
} else if (command === 'build') {
  const flags = []
  const valueFlags = new Set(['--output', '-o', '--format', '--platform', '--define', '--external', '--loader'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  const options = {
    output: { type: 'string', short: 'o' },
    format: { type: 'string' },
    platform: { type: 'string' },
    minify: { type: 'boolean' },
    sourcemap: { type: 'boolean' },
    // Repeatable esbuild passthroughs (--define=K=V, --external=PATTERN, --loader=.ext:name).
    define: { type: 'string', multiple: true },
    external: { type: 'string', multiple: true },
    loader: { type: 'string', multiple: true },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to build: no bundle or lockfile given')
  if (argv.length > 2) usage('Error: build takes a bundle or lockfile and an optional entry point')
  // esbuild output knobs; the import graph itself is fixed by the artifact, not these.
  if (values.format !== undefined && !['esm', 'cjs', 'iife'].includes(values.format)) {
    usage('Error: --format must be esm, cjs, or iife')
  }
  if (values.platform !== undefined && !['node', 'browser', 'neutral'].includes(values.platform)) {
    usage('Error: --platform must be node, browser, or neutral')
  }
  if (!values.output) usage('Error: --output is required (a .js/.cjs/.mjs file, or a directory)')
  // build can't stream to stdout; without this, --output=- would create a dir literally named `-`.
  if (values.output === '-') usage('Error: stasis build cannot stream to stdout; --output must be a .js/.cjs/.mjs file or a directory')
  // --define=KEY=VALUE -> esbuild define map; VALUE is forwarded verbatim and must be valid JS
  // (a JSON literal or an identifier), e.g. --define=DEBUG=false.
  const define = {}
  for (const entry of values.define ?? []) {
    const eq = entry.indexOf('=')
    if (eq <= 0) usage(`Error: --define must be KEY=VALUE (got '${entry}')`)
    define[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  // --loader=.ext:NAME -> esbuild loader override for that extension (e.g. --loader=.js:jsx).
  const loader = {}
  for (const entry of values.loader ?? []) {
    const colon = entry.indexOf(':')
    if (colon <= 0 || !entry.startsWith('.')) usage(`Error: --loader must be .EXT:LOADER (got '${entry}')`)
    loader[entry.slice(0, colon)] = entry.slice(colon + 1)
  }
  const { buildCommand } = await import('../src/cmd/build.js')
  await buildCommand({
    cwd: process.cwd(),
    artifact: argv[0],
    entry: argv[1],
    output: values.output,
    format: values.format,
    platform: values.platform,
    minify: values.minify,
    sourcemap: values.sourcemap,
    define,
    external: values.external ?? [],
    loader,
  })
} else if (command === 'extract') {
  const flags = []
  const valueFlags = new Set(['--output', '-o'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  const options = {
    output: { type: 'string', short: 'o' },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to extract: no bundle file given')
  if (argv.length > 1) usage('Error: extract takes exactly one bundle file')
  const { extractCommand } = await import('@exodus/stasis-core/extract')
  extractCommand({ cwd: process.cwd(), bundleFile: argv[0], output: values.output })
} else if (command === 'diff') {
  const flags = []
  while (argv.length > 0 && argv[0].startsWith('-')) flags.push(argv.shift())
  const options = {
    stat: { type: 'boolean' },
    imports: { type: 'boolean' },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  // --stat is required for now (it reports what changed, not the content); bare `stasis diff`
  // is reserved for a future content-level diff.
  if (!values.stat) usage('Error: stasis diff currently requires --stat')
  if (argv.length !== 2) usage('Error: stasis diff takes exactly two files (lockfile or bundle)')
  // --imports also diffs the resolution graphs (added/removed/redirected edges); off by default (verbose).
  const { diffCommand } = await import('../src/cmd/diff.js')
  const { differences } = diffCommand({ cwd: process.cwd(), left: argv[0], right: argv[1], stat: true, imports: values.imports })
  // Exit non-zero when the artifacts differ, so it composes in CI.
  process.exitCode = differences ? 1 : 0
} else if (command === 'prune') {
  if (argv.length > 1) usage('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('@exodus/stasis-core/prune')
  const { removed, validated } = prune({ root })
  console.warn(`[stasis] prune: validated ${validated.length} file(s), removed ${removed.length} file(s)`)
} else if (command === 'audit') {
  const flags = []
  const valueFlags = new Set(['--reason'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options: { why: { type: 'boolean' }, 'why-deep': { type: 'boolean' }, 'why-full': { type: 'boolean' }, reason: { type: 'string' } } }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to audit: no path to file given')
  const { audit, printAuditReport } = await import('../src/audit.js')
  const files = argv.map((f) => resolve(f))
  const report = await audit(files, { why: Boolean(values.why), whyDeep: Boolean(values['why-deep']), whyFull: Boolean(values['why-full']), reason: values.reason })
  printAuditReport(report)
  process.exitCode = report.rows.length === 0 ? 0 : 1
} else if (command === 'sbom') {
  const flags = []
  const valueFlags = new Set(['--format', '--output', '-o'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  const options = {
    format: { type: 'string' },
    output: { type: 'string', short: 'o' },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (!values.format) usage('Error: stasis sbom requires --format=(spdx|cyclonedx)')
  if (!['spdx', 'cyclonedx'].includes(values.format)) usage('Error: --format must be spdx or cyclonedx')
  if (argv.length === 0) usage('Nothing to export: no lockfile or bundle given')
  const { sbomCommand } = await import('../src/cmd/sbom.js')
  sbomCommand({
    cwd: process.cwd(),
    files: argv,
    format: values.format,
    output: values.output,
  })
} else {
  usage()
}
