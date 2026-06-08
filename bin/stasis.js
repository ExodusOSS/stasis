#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import assert from 'node:assert/strict'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b) // resolve symlinks
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

function usage(prefix = '') {
  console.error(`${prefix}\nUsage:
 stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|ignore)] [--bundle-file=path/to/bundle.br] [--dependencies] [--mock] path/to/file.js ...
 stasis bundle [--mapping=path/to/remappings(.txt|.toml)] [--output=path/to/out.stasis.code.br] path/to/file.sol ...
 stasis bundle [--scope=(node_modules|full)] [--lockfile=path/to/stasis.lock.json] [--output=path/to/out.stasis.code.br] path/to/file.js ...
 stasis prune [path/to/project]
 stasis audit path/to/file ...
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
    mock: { type: 'boolean' },
  }

  const { values } = parseArgs({ args: flags, options })
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
  if (values.mock && bundle === 'load') usage('Error: --mock is for capturing imports while building a bundle; not compatible with --bundle=load')
  console.warn('[stasis] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(values.mock && { mock: true }) })
  if (debug) console.warn(`[stasis] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_MOCK', values.mock ? '1' : '')
  // --mock: capture imports by running user code with side-effects denied,
  // fail-closed. Node's permission system blocks fs writes, child processes,
  // worker threads, native addons (no --allow-addons -- addons would bypass
  // the whole model), and the inspector. Network and timers have no
  // --allow-* counterparts, so src/mock.js neutralizes them in JS; loader.js
  // imports mock.js dynamically after stasis's own destructured fs bindings
  // are captured but before registerHooks runs, so the mock's
  // syncBuiltinESMExports() refresh propagates to user-code ESM imports
  // without touching stasis's snapshots. Reads stay open (--allow-fs-read=*)
  // so node_modules resolution works; reads aren't a side effect. Writes are
  // still scoped at the kernel level as defense in depth (the JS layer
  // covers user code, --permission covers anything that bypasses JS, e.g.
  // process.binding or a future leak).
  // Node 24 dropped comma-separated --allow-fs-write; repeat the flag instead.
  const nodeArgs = []
  if (values.mock) {
    const writeAllow = [process.cwd()]
    if (bundleFile && !bundleFile.startsWith(`${process.cwd()}/`)) {
      // --allow-fs-write paths must already exist on disk; granting the bundle
      // file's own path is not enough when state.write()'s mkdirSync has to
      // create the parent chain. Walk up to the nearest existing ancestor and
      // grant write there -- broader than ideal, but the user explicitly chose
      // this location for their bundle.
      // (Note: the cwd check above uses '/' as a separator and is therefore
      //  unix-only; that matches the rest of the project's path handling.)
      let p = dirname(bundleFile)
      while (!existsSync(p) && dirname(p) !== p) p = dirname(p)
      // Refuse to grant write access to the filesystem root: it would
      // effectively disable the --permission layer everywhere, and reaching
      // it means none of the bundle path's ancestors exist -- the user
      // almost certainly didn't intend this. Ask them to create a parent.
      if (p === dirname(p)) {
        usage(`Error: no existing parent directory for --bundle-file=${bundleFile}; create one first or choose a path under an existing directory`)
      }
      writeAllow.push(p)
    }
    nodeArgs.push('--permission', '--allow-fs-read=*')
    for (const p of writeAllow) nodeArgs.push(`--allow-fs-write=${p}`)
    // --permission without --allow-addons removes "node-addons" from resolution
    // conditions, which would change how packages with conditional exports
    // resolve and make the captured import map incompatible with a normal
    // replay. Restore the condition so resolution matches a non-mock run; this
    // doesn't allow native addons to actually load (--allow-addons still off).
    nodeArgs.push('--conditions=node-addons')
  }
  nodeArgs.push('--import', import.meta.resolve('../src/loader.js'))
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code] = await once(child, 'close')
  process.exitCode = code
} else if (command === 'bundle') {
  const flags = []
  const valueFlags = new Set(['--mapping', '--output', '--scope', '--lockfile', '-o'])
  while (argv.length > 0 && (argv[0].startsWith('-') || valueFlags.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  const options = {
    mapping: { type: 'string' },
    output: { type: 'string', short: 'o' },
    scope: { type: 'string' },
    lockfile: { type: 'string' },
  }
  let values
  try {
    ({ values } = parseArgs({ args: flags, options }))
  } catch (cause) {
    usage(`Error: ${cause.message}`)
  }
  if (argv.length === 0) usage('Nothing to bundle: no entry file given')
  const allSol = argv.every((f) => f.endsWith('.sol'))
  const allJs = argv.every((f) => /\.(?:js|cjs|mjs)$/u.test(f))
  if (!allSol && !allJs) usage('Error: bundle entries must all be .sol or all be .js/.cjs/.mjs')
  if (values.mapping && !allSol) usage('Error: --mapping is only valid for .sol bundles')
  if (values.scope && !allJs) usage('Error: --scope is only valid for JS bundles')
  if (values.scope && !['node_modules', 'full'].includes(values.scope)) {
    usage('Error: --scope must be node_modules or full')
  }
  if (values.lockfile && !allJs) usage('Error: --lockfile is only valid for JS bundles')
  const { bundleCommand } = await import('../src/cmd/bundle.js')
  await bundleCommand({
    cwd: process.cwd(),
    entries: argv,
    mappingFile: values.mapping,
    output: values.output,
    scope: values.scope,
    lockfile: values.lockfile,
  })
} else if (command === 'prune') {
  if (argv.length > 1) usage('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('../src/prune.js')
  const { removed, validated } = prune({ root })
  console.warn(`[stasis] prune: validated ${validated.length} file(s), removed ${removed.length} file(s)`)
} else if (command === 'audit') {
  if (argv.length === 0) usage('Nothing to audit: no path to file given')
  const { audit, printAuditReport } = await import('../src/audit.js')
  const files = argv.map((f) => resolve(f))
  const report = await audit(files)
  printAuditReport(report)
  process.exitCode = report.rows.length === 0 ? 0 : 1
} else {
  usage()
}
