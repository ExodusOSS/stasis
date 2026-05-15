#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import assert from 'node:assert/strict'

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b) // resolve symlinks
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

function usage(prefix = '') {
  console.error(`${prefix}\nUsage:
 stasis run --update [--bundle=(save|load|ignore)] [--bundle-file=path/to/bundle.br] [--full] path/to/file.js ...
 stasis run --frozen [--bundle=(save|load|ignore)] [--bundle-file=path/to/bundle.br] [--full] path/to/file.js ...
 stasis bundle create path/to/lockfile
 statis bundle verify path/to/lockfile
 statis advisories path/to/lockfile
`.trim())
  process.exit(1)
}

function setEnv(name, value) {
  const env = process.env[name]
  if (env && env !== value) throw new Error(`env conflict: ${name}="${env}", effective: "${value}"`)
  process.env[name] = value === undefined ? '' : value
}

const command = argv.shift()

if (command === 'run') {
  const flags = []
  const valueFlags = new Set(['--bundle', '--bundle-file'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }

  const options = {
    update: { type: 'boolean' },
    frozen: { type: 'boolean' },
    bundle: { type: 'string', default: 'none' },
    'bundle-file': { type: 'string' },
    debug: { type: 'boolean' },
    full: { type: 'boolean' },
  }

  const { values } = parseArgs({ args: flags, options })
  if (argv.length === 0) usage('Nothing to run: no path to file given')
  if (values.update && values.frozen) usage('Error: --update conflicts with --frozen')
  if (!values.update && !values.frozen) usage('Error: --frozen or --update is required')
  const mode = values.update ? 'update' : 'frozen'
  const scope = values.full ? 'full' : 'node_modules'
  const bundle = values.bundle
  const bundleFile = values['bundle-file'] ? resolve(values['bundle-file']) : ''
  const debug = values.debug ? '1' : ''
  if (!['none', 'ignore', 'save', 'load'].includes(bundle)) usage('Error: invalid --bundle value')
  if (bundleFile && bundle === 'none') usage('Error: --bundle-file requires --bundle=(save|load|ignore)')
  console.warn('[stasis] Running stasis with config:', { mode, scope, bundle, ...(bundleFile && { bundleFile }) })
  if (debug) console.warn(`[stasis] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_MODE', mode)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  const child = spawn('node', ['--import', import.meta.resolve('../src/loader.js'), ...argv], { stdio: 'inherit' })
  const [code] = await once(child, 'close')
  process.exitCode = code
} else if (command === 'run-bundle') {
  usage('bundle-run command is not implemented yet')
} else if (command === 'bundle') {
  usage('bundle command is not implemented yet')
} else {
  usage()
}
