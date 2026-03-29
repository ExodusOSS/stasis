#!/usr/bin/env node

import { spawn, execFile as execFileCallback } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, realpathSync } from 'node:fs'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir, availableParallelism, homedir } from 'node:os'
import assert from 'node:assert/strict'

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b) // resolve symlinks
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

function usage(prefix = '') {
  console.error(`${prefix}\nUsage:
 stasis run --update [--bundle=(save|load|ignore)] [--full] path/to/file.js ...
 stasis run --frozen [--bundle=(save|load|ignore)] [--full] path/to/file.js ...
 stasis bundle create path/to/lockfile
 statis bundle verify path/to/lockfile
 statis bundle audit path/to/lockfile
`.trim())
  process.exit(1)
}

const command = argv.shift()

if (command === 'run') {
  const flags = []
  while (argv.length > 0 && (argv[0].startsWith('-') || flags.at(-1) === '--bundle')) {
    flags.push(argv.shift())
  }

  const options = {
    update: { type: 'boolean' },
    frozen: { type: 'boolean' },
    bundle: { type: 'string', default: 'none' },
    full: { type: 'boolean' },
  }
  const { values } = parseArgs({ args: flags, options })
  if (argv.length === 0) usage('Nothing to run: no path to file given')
  if (values.update && values.frozen) usage('Error: --update conflicts with --frozen')
  if (!values.update && !values.frozen) usage('Error: --frozen or --update is required')
  const mode = values.update ? 'update' : 'frozen'
  const scope = values.full ? 'full' : 'node_modules'
  const bundle = values.bundle
  if (!['none', 'ignore', 'save', 'load'].includes(bundle)) usage('Error: invalid --bundle value')
  console.warn(`Running stasis with mode=${mode}, scope=${scope}, bundle=${bundle}`)
  // TODO: use config
  const child = spawn('node', ['--import', import.meta.resolve('../src/loader.js'), ...argv], { stdio: 'inherit' })
  const [code] = await once(child, 'close')
  process.exitCode = code
} else if (command === 'bundle') {
  usage('Bundle command is not implemented yet')
} else {
  usage()
}
