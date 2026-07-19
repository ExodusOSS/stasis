#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import assert from 'node:assert/strict'
import { parseBrotliQuality } from '../src/util.js'
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
 stasis-core add path/to/(file|dir) ...
 (adds the listed files to the project's bundle(s) with no dependency resolution;
  a directory expands to its files. Requires a stasis.config.json (all fields optional).)
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
  // --resources-bundle-file needs an active bundle mode; front-run Config's rejection with a clean usage error.
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) usage('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') usage('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') usage('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  // --fs=sync patches the sync fs readers; --fs=async adds their async (callback + fs.promises) counterparts on top.
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) usage("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) usage('Error: --fs requires --bundle=(add|replace|load)')
  const captureFs = values.fs ?? ''
  // --resources: comma-separated ext/filename allowlist for --fs resource captures (e.g. png,svg,LICENSE).
  const resources = values.resources ?? ''
  // --brotli-quality: bundle compression quality (0..11; unset -> stasis default 9).
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      usage(`Error: ${cause.message}`)
    }
  }
  // --child-process: forward forked-child (e.g. Metro worker) capture to the root via per-pid shards; opt-in.
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
  // Only set when given: an unconditional setEnv('') would reject an ambient EXODUS_STASIS_BROTLI_QUALITY as a conflict.
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
} else if (command === 'add') {
  if (argv.length === 0) usage('Nothing to add: no file given')
  if (argv.some((a) => a.startsWith('-'))) usage('Error: add takes no options; its targets and resource allowlist come from stasis.config.json')
  const { addCommand } = await import('../src/add.js')
  // Let addCommand's errors propagate as-is (specific, actionable); don't bury them under the usage block.
  addCommand({ cwd: process.cwd(), entries: argv, logLabel: 'stasis-core' })
} else {
  usage()
}
