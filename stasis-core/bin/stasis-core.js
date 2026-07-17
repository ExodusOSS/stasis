#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import assert from 'node:assert/strict'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b) // resolve symlinks
assert(basename(jsname) === 'stasis-core' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

function usage(prefix = '') {
  console.error(`${prefix}\nUsage:
 stasis-core run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
 stasis-core prune [path/to/project]
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
  // Unlike --bundle-file (which is inert-but-harmless under --bundle=ignore, so Config allows
  // it), --resources-bundle-file needs an active bundle: Config rejects bundle=none AND ignore
  // (resourcesBundleFile requires an active bundle mode). Front-run that with a clean usage error.
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) usage('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') usage('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') usage('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  // --fs monkey-patches the fs readers (readFileSync/readdirSync + lstatSync/statSync)
  // to capture them into the bundle (add|replace) or serve them from it (load); nothing
  // to record/read without one. The mode argument is required: `sync` patches the sync
  // readers, `async` adds their async (callback + fs.promises) counterparts on top.
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) usage("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) usage('Error: --fs requires --bundle=(add|replace|load)')
  const captureFs = values.fs ?? ''
  // --resources: comma-separated extension/filename allowlist for `--fs` resource captures
  // (e.g. png,svg,LICENSE). The child's Config validates each entry via parseResourcesOption.
  const resources = values.resources ?? ''
  // --brotli-quality: bundle compression quality (0..11; unset = brotli's default 11).
  // `${n}` must round-trip so coercible forms ('5.0', '05', whitespace -> 0) are rejected.
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    const n = Number(values['brotli-quality'])
    if (`${n}` !== values['brotli-quality'] || !Number.isInteger(n) || n < 0 || n > 11) usage(`Error: --brotli-quality must be an integer 0..11 (got '${values['brotli-quality']}')`)
    brotliQuality = n
  }
  // --child-process: forward forked-child (e.g. Metro transform worker) capture to the root
  // via per-pid shards. Opt-in -- it stands up a process-coordination channel, off by default.
  const childProcess = values['child-process'] ? '1' : ''
  console.warn('[stasis-core] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(resourcesBundleFile && { resourcesBundleFile }), ...(childProcess && { childProcess: true }), ...(values.fs && { fs: values.fs }), ...(resources && { resources }), ...(brotliQuality !== undefined && { brotliQuality }) })
  if (debug) console.warn(`[stasis-core] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_RESOURCES_BUNDLE_FILE', resourcesBundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_CHILD_PROCESS', childProcess)
  setEnv('EXODUS_STASIS_FS', captureFs)
  setEnv('EXODUS_STASIS_RESOURCES', resources)
  // Only set when given, so an ambient EXODUS_STASIS_BROTLI_QUALITY still passes through
  // to the child (an unconditional setEnv('') would reject it as a conflict).
  if (brotliQuality !== undefined) setEnv('EXODUS_STASIS_BROTLI_QUALITY', String(brotliQuality))
  const nodeArgs = ['--import', import.meta.resolve('../src/loader.js')]
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code, signal] = await once(child, 'close')
  // code is null when the child died from a signal; report 128+signo (shell convention) instead of the implicit 0
  process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0)
} else if (command === 'prune') {
  if (argv.length > 1) usage('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('../src/prune.js')
  const { removed, validated, minimized } = prune({ root })
  console.warn(`[stasis-core] prune: validated ${validated.length} file(s), removed ${removed.length} file(s), minimized ${minimized.length} package.json file(s)`)
} else {
  usage()
}
