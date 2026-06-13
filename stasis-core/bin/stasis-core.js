#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
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
 stasis-core run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|ignore)] [--bundle-file=path/to/bundle.br] [--dependencies] path/to/file.js ...
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
  const valueFlags = new Set(['--bundle', '--bundle-file', '--lock'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }

  const options = {
    lock: { type: 'string', default: 'none' },
    bundle: { type: 'string', default: 'none' },
    'bundle-file': { type: 'string' },
    debug: { type: 'boolean' },
    dependencies: { type: 'boolean' },
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
  const debug = values.debug ? '1' : ''
  if (!['none', 'ignore', 'add', 'replace', 'load'].includes(bundle)) usage('Error: invalid --bundle value')
  if (bundleFile && bundle === 'none') usage('Error: --bundle-file requires --bundle=(add|replace|load|ignore)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') usage('Error: --bundle=load requires --lock=(frozen|none|ignore)')
  if (lock === 'none' && bundle === 'none') usage('Error: --lock=none requires --bundle=(add|replace|load|ignore)')
  console.warn('[stasis-core] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }) })
  if (debug) console.warn(`[stasis-core] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  const nodeArgs = ['--import', import.meta.resolve('../src/loader.js')]
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code] = await once(child, 'close')
  process.exitCode = code
} else if (command === 'prune') {
  if (argv.length > 1) usage('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('../src/prune.js')
  const { removed, validated } = prune({ root })
  console.warn(`[stasis-core] prune: validated ${validated.length} file(s), removed ${removed.length} file(s)`)
} else {
  usage()
}
