// `stasis run --import <module>` passthrough: extra preloads ride to the spawned node AFTER
// stasis's own loader import. A preload's module graph evaluates before the entry and is runner
// infrastructure -- exempt from capture, like the loader itself -- while app code still
// round-trips capture -> frozen -> bundle=load. With `--import tsx` the transformer's hooks sit
// ABOVE stasis's (registered later => outer), so stasis keeps seeing the RAW on-disk TypeScript:
// the artifacts attest the on-disk bytes and the on-disk 'module-typescript' format while tsx
// resolves/serves the file as its post-erasure 'module' family at run time.
//
// The exemption is graph-scoped, not blanket: a module BOTH the preload phase and the app graph
// reach is promoted into the capture with the bytes that executed; a file executed through a
// preload-transplanted require() pipeline (tsx's CJS '.ts' handler, babel-register-style '.js'
// wrappers) is reconciled at write time; and under --bundle=load a preload-cached instance is
// served only when its bytes match the attested ones. Eval entries keep failing closed.

import { before, describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'cli-run-import-tsx')

// The deterministic stdout of both fixture entries (the enum transpiles to Color.Green === 2).
const expectedOutput = 'color:2\n'

// strip any inherited stasis env vars so the CLI's env-conflict guard doesn't trip
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_RESOURCES_BUNDLE_FILE: _rbf,
  EXODUS_STASIS_RESOURCES: _r,
  EXODUS_STASIS_FS: _fs,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
  EXODUS_STASIS_CHILD_PROCESS: _cp,
  EXODUS_STASIS_PACKAGE_JSON: _pj,
  EXODUS_STASIS_SHARD_DIR: _sd,
  EXODUS_STASIS_SHARD_KEY: _sk,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  ...cleanEnv
} = process.env

// Async child-process runner (see cli.test.js): spawn() + once('close') yields between tests so
// the describe-level concurrency actually overlaps the CLI subprocess time.
const run = async (args, opts = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { env: cleanEnv, ...opts })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const withTmp = (fn) => async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stasis-import-tsx-'))
  try {
    return await fn(t, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Hardlinked clone of the fixture (see popular-npm-modules.test.js): node_modules carries tsx +
// esbuild, so a real cp would dominate the suite's wall time. Hardlinks share an inode with the
// fixture -- tests that mutate a cloned path MUST go through tamper() below.
const hardlinkCopy = async (src, dst) => {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) await hardlinkCopy(s, d)
    else if (entry.isSymbolicLink()) await symlink(await readlink(s), d)
    else await link(s, d)
  }))
}

const freshCopy = async (dir) => {
  await hardlinkCopy(fixture, dir)
  await rm(join(dir, 'stasis.lock.json'), { force: true })
  await rm(join(dir, 'stasis.code.br'), { force: true })
}

// Safe write to a hardlinked path: unlink first so the inode share with the original fixture file
// is broken before new bytes land (a naive writeFile would corrupt the real fixture on disk).
const tamper = async (path, content) => {
  await unlink(path)
  await writeFile(path, content)
}

const readLock = async (dir) => JSON.parse(await readFile(join(dir, 'stasis.lock.json'), 'utf-8'))
const readBundle = async (dir) => JSON.parse(brotliDecompressSync(await readFile(join(dir, 'stasis.code.br'))).toString('utf-8'))
// Flatten the per-conditions imports buckets: the exact condition set is Node's business.
const flatImports = (artifact) => Object.assign({}, ...Object.values(artifact.imports ?? {}))

// The fixture pulls the real tsx from npm via its own pnpm-lock.yaml. node_modules is gitignored,
// so install on demand (CI pre-installs it; this is the local-dev fallback).
before(async () => {
  if (!existsSync(join(fixture, 'node_modules', 'tsx', 'package.json'))) {
    const child = spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: fixture })
    const stderrChunks = []
    child.stderr.on('data', (d) => stderrChunks.push(d))
    const [status] = await once(child, 'close')
    if (status !== 0) {
      throw new Error(`pnpm install failed in ${fixture}: ${Buffer.concat(stderrChunks)}`)
    }
  }
})

describe('stasis run --import passthrough (spawned, concurrent)', { concurrency: 4 }, () => {

  test('--import tsx runs a TS entry (enum) and captures only app files, as raw on-disk bytes', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const r = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, expectedOutput)
    t.assert.match(r.stderr, /import: \[ 'tsx' \]/)

    const lock = await readLock(tmp)
    t.assert.deepEqual(lock.entries, ['src/entry.ts'])
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.ts', 'src/hello.ts'])
    // tsx's own module graph (and esbuild's) is runner infrastructure: no node_modules buckets.
    t.assert.equal(Object.keys(lock.modules ?? {}).length, 0, 'the preload graph must not be captured')
    // The attested format is the on-disk one, not the 'module' tsx serves at run time.
    t.assert.equal(lock.formats['src/entry.ts'], 'module-typescript')
    t.assert.equal(lock.formats['src/hello.ts'], 'module-typescript')
    t.assert.equal(flatImports(lock)['src/entry.ts']?.['./hello.ts'], 'src/hello.ts')

    // The bundle carries the RAW TypeScript (pre-transform): tsx transpiles enums away at run
    // time, so finding one attests the on-disk bytes, not tsx's output.
    const bundle = await readBundle(tmp)
    t.assert.match(bundle.sources['.'].files['src/hello.ts'], /export enum Color/)
    t.assert.equal(Object.keys(bundle.modules ?? {}).length, 0)

    // Idempotent re-add: a second identical capture must not change the artifacts.
    const lockText = await readFile(join(tmp, 'stasis.lock.json'), 'utf-8')
    const again = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(again.status, 0, `stderr: ${again.stderr}`)
    t.assert.equal(await readFile(join(tmp, 'stasis.lock.json'), 'utf-8'), lockText)
  }))

  test('frozen replay passes under tsx; a disk tamper is rejected', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

    const frozen = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)
    t.assert.equal(frozen.stdout, expectedOutput)

    await tamper(join(tmp, 'src', 'hello.ts'),
      'export enum Color { Red = 1, Green = 2 }\nexport const greet = (c: Color): string => `TAMPERED:${c}`\n')
    const rejected = await run(['run', '--lock=frozen', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.notEqual(rejected.status, 0, 'a frozen run must reject tampered sources under a transforming preload too')
  }))

  test('bundle=load with tsx serves the attested raw TS over a tampered disk', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

    await tamper(join(tmp, 'src', 'hello.ts'),
      'export enum Color { Red = 1, Green = 2 }\nexport const greet = (c: Color): string => `TAMPERED:${c}`\n')
    const replay = await run(['run', '--lock=frozen', '--bundle=load', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(replay.stdout, expectedOutput, 'the bundle bytes must win over disk')
  }))

  test('bundle=load without tsx fails closed on the non-erasable syntax', withTmp(async (t, tmp) => {
    // The capture attests 'module-typescript'; replayed WITHOUT the transformer, Node's own
    // strip-only TypeScript mode gets the raw source and must refuse the enum -- proving the
    // bundle serves the raw on-disk TS (not tsx's transpiled output) with its on-disk format.
    await freshCopy(tmp)
    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

    const replay = await run(['run', '--lock=frozen', '--bundle=load', 'src/entry.ts'], { cwd: tmp })
    t.assert.notEqual(replay.status, 0)
    t.assert.match(replay.stderr, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
  }))

  test('an extensionless specifier round-trips through tsx\'s resolver rewrite', withTmp(async (t, tmp) => {
    // tsx resolves `./hello` (Node alone can't) and calls into stasis's inner hook with the
    // rewritten `./hello.ts`, so that's the edge the artifacts record -- and the edge the replay
    // resolves through when tsx retries its candidates against the recorded import map.
    await freshCopy(tmp)
    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry-extensionless.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
    t.assert.equal(cap.stdout, expectedOutput)

    const lock = await readLock(tmp)
    t.assert.equal(flatImports(lock)['src/entry-extensionless.ts']?.['./hello.ts'], 'src/hello.ts',
      'the recorded specifier is the resolver-rewritten one')

    const replay = await run(['run', '--lock=frozen', '--bundle=load', '--import', 'tsx', 'src/entry-extensionless.ts'], { cwd: tmp })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(replay.stdout, expectedOutput)
  }))

  test('a non-transforming relative preload evaluates but stays out of the capture', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const r = await run(
      ['run', '--lock=add', '--import', './local-preload/index.mjs', '--import', 'tsx', 'src/entry.ts'],
      { cwd: tmp }
    )
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, expectedOutput)
    t.assert.match(r.stderr, /\[local-preload\] loaded/)
    t.assert.match(r.stderr, /import: \[ '\.\/local-preload\/index\.mjs', 'tsx' \]/)

    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.ts', 'src/hello.ts'],
      'neither preload may enter the workspace bucket')
    t.assert.equal(Object.keys(lock.modules ?? {}).length, 0)
  }))

  test('--import with an empty value is a usage error', async (t) => {
    const r = await run(['run', '--lock=add', '--import=', 'a.js'])
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, /--import requires a module specifier/)
  })

  // tsx compiles CJS-flavored .ts through its own require.extensions handler, which reads and
  // compiles files WITHOUT the load hook chain ever firing: the executed-file reconciliation
  // (Module._load shim + write-time backfill) is what attests these.
  test('CJS-flavored TS: hook-bypassing tsx requires are still attested and frozen-verified', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const pkg = JSON.parse(await readFile(join(tmp, 'package.json'), 'utf-8'))
    pkg.type = 'commonjs'
    await tamper(join(tmp, 'package.json'), JSON.stringify(pkg, null, 2))

    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
    t.assert.equal(cap.stdout, expectedOutput)

    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.ts', 'src/hello.ts'],
      'a require() executed through the transplanted .ts pipeline must not escape the capture')
    t.assert.equal(lock.formats['src/entry.ts'], 'commonjs-typescript')
    t.assert.equal(lock.formats['src/hello.ts'], 'commonjs-typescript')
    t.assert.equal(flatImports(lock)['src/entry.ts']?.['./hello.ts'], 'src/hello.ts')

    const frozen = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)

    await tamper(join(tmp, 'src', 'hello.ts'),
      'export enum Color { Red = 1, Green = 2 }\nexport const greet = (c: Color): string => `TAMPERED:${c}`\n')
    const rejected = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.notEqual(rejected.status, 0,
      'write-time reconciliation must reject a tampered hook-bypassed source')

    // The attested bytes still win over the tampered disk when replayed from the bundle: the
    // short-circuited resolve routes CJS-flavored .ts through the hook-served translator lane.
    const replay = await run(['run', '--lock=frozen', '--bundle=load', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(replay.stdout, expectedOutput)
  }))

  test('a no-`type` package attests the on-disk -typescript format, not tsx\'s post-erasure view', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const pkg = JSON.parse(await readFile(join(tmp, 'package.json'), 'utf-8'))
    delete pkg.type
    await tamper(join(tmp, 'package.json'), JSON.stringify(pkg, null, 2))

    const cap = await run(['run', '--lock=add', '--import', 'tsx', 'src/entry.ts'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
    const lock = await readLock(tmp)
    // tsx defaults a no-`type` .ts to commonjs and reports the post-erasure 'commonjs': the
    // attestation must upgrade that to the '-typescript' variant, never a plain-JS format.
    t.assert.equal(lock.formats['src/entry.ts'], 'commonjs-typescript')
    t.assert.equal(lock.formats['src/hello.ts'], 'commonjs-typescript')

    // Stacks may honestly disagree about a no-`type` .ts (Node syntax-detects this one as ESM):
    // replaying WITHOUT tsx must surface that as a loud format flip, not silent re-attestation.
    const native = await run(['run', '--lock=add', 'src/entry.ts'], { cwd: tmp })
    t.assert.notEqual(native.status, 0)
    t.assert.match(native.stderr, /format flip for src\/entry\.ts: lockfile attests 'commonjs-typescript', observed 'module-typescript'/)
  }))

  // An app module the preload ALREADY imported: its load hook can never re-fire (cached), so the
  // capture must promote it -- bytes, hash, and its own transitive edges -- or the artifact ships
  // a dangling edge no frozen replay ever verifies.
  test('a module shared by the preload and the app is promoted into the capture, transitively', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"shared-preload-app","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'preload.mjs'), "import './src/shared.mjs'\n")
    await writeFile(join(tmp, 'src', 'shared.mjs'), "import { d } from './dep.mjs'\nexport const v = `CLEAN:${d}`\n")
    await writeFile(join(tmp, 'src', 'dep.mjs'), "export const d = 'D'\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "import { v } from './shared.mjs'\nconsole.log('entry sees:', v)\n")

    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
    t.assert.equal(cap.stdout, 'entry sees: CLEAN:D\n')

    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/dep.mjs', 'src/entry.mjs', 'src/shared.mjs'],
      'the shared module AND its own imports must be attested')
    t.assert.equal(flatImports(lock)['src/shared.mjs']?.['./dep.mjs'], 'src/dep.mjs', 'promoted edges replay transitively')
    // The preload itself stays out: nothing but the entry imported it.
    t.assert.equal(lock.sources['.'].files['preload.mjs'], undefined)

    const frozen = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)

    await writeFile(join(tmp, 'src', 'shared.mjs'), "import { d } from './dep.mjs'\nexport const v = `TAMPERED:${d}`\n")
    const rejected = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.notEqual(rejected.status, 0)
    t.assert.doesNotMatch(rejected.stdout, /TAMPERED/, 'promotion must reject the tamper BEFORE the entry runs it')
  }))

  test('bundle=load refuses a preload-cached module whose disk bytes diverge from the bundle', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"shared-preload-app","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'preload.mjs'), "import './src/shared.mjs'\n")
    await writeFile(join(tmp, 'src', 'shared.mjs'), "export const v = 'CLEAN'\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "import { v } from './shared.mjs'\nconsole.log('entry sees:', v)\n")

    const cap = await run(['run', '--lock=ignore', '--bundle=replace', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

    // Identical bytes: the cached instance IS the attested content, so the replay passes.
    const clean = await run(['run', '--lock=ignore', '--bundle=load', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(clean.status, 0, `clean replay stderr: ${clean.stderr}`)
    t.assert.equal(clean.stdout, 'entry sees: CLEAN\n')

    // Tampered disk + preload: the preload executed the tampered copy before the entry, and the
    // cached instance would shadow the attested bytes -- refuse before the entry consumes it.
    await writeFile(join(tmp, 'src', 'shared.mjs'), "export const v = 'TAMPERED'\n")
    const poisoned = await run(['run', '--lock=ignore', '--bundle=load', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.notEqual(poisoned.status, 0)
    t.assert.match(poisoned.stderr, /divergent cached instance/)
    t.assert.doesNotMatch(poisoned.stdout, /TAMPERED/)

    // Without the preload the bundle serves the attested bytes; the tampered disk is irrelevant.
    const noPreload = await run(['run', '--lock=ignore', '--bundle=load', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(noPreload.status, 0, `no-preload replay stderr: ${noPreload.stderr}`)
    t.assert.equal(noPreload.stdout, 'entry sees: CLEAN\n')
  }))

  test('a deferred dynamic import from the preload stays out of the capture', withTmp(async (t, tmp) => {
    // The exemption is graph-scoped, not a time gate: infrastructure that lazy-loads AFTER the
    // entry started must not pollute the artifact (its timing would make captures depend on it).
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"deferred-preload","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'pre.mjs'), "setTimeout(() => import('./toolchain-helper.mjs'), 30)\n")
    await writeFile(join(tmp, 'toolchain-helper.mjs'), "console.error('[helper] loaded')\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "console.log('entry ran')\nawait new Promise((r) => setTimeout(r, 150))\n")

    const r = await run(['run', '--lock=add', '--import', './pre.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stderr, /\[helper\] loaded/, 'the deferred import must still evaluate')

    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files), ['src/entry.mjs'])
    t.assert.deepEqual(flatImports(lock), {}, 'no infra edges may be recorded')
  }))

  test('an eval entry under the loader still fails closed in capture mode', withTmp(async (t, tmp) => {
    // A -e script's imports carry an [eval] parent -- runner-infrastructure passthrough must not
    // swallow them into a silent no-op capture (a spawn()ed `node -e` child under
    // --child-process would otherwise execute entirely unobserved).
    await writeFile(join(tmp, 'package.json'), '{"name":"eval-entry","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'dep.mjs'), "console.log('dep ran')\n")

    const loader = join(here, '..', 'stasis-core', 'src', 'loader.js')
    const env = { ...cleanEnv, EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_BUNDLE: 'none' }
    const child = spawn(process.execPath, ['--import', `file://${loader}`, '-e', "await import('./dep.mjs')"], { cwd: tmp, env })
    const stderrChunks = []
    const stdoutChunks = []
    child.stdout.on('data', (d) => stdoutChunks.push(d))
    child.stderr.on('data', (d) => stderrChunks.push(d))
    const [status] = await once(child, 'close')
    t.assert.notEqual(status, 0)
    t.assert.match(Buffer.concat(stderrChunks).toString(), /assert\.ok\(state\)/)
    t.assert.doesNotMatch(Buffer.concat(stdoutChunks).toString(), /dep ran/)
    t.assert.equal(existsSync(join(tmp, 'stasis.lock.json')), false, 'no artifact may be written')
  }))

  // babel-register-style: a preload replacing require.extensions['.js'] loads files itself, so
  // the load hook never fires -- the same reconciliation as tsx's CJS pipeline must cover it.
  test('a transplanted .js require pipeline is reconciled in capture and refused under bundle=load', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"transplant","version":"1.0.0","private":true,"type":"commonjs"}\n')
    await writeFile(join(tmp, 'transplant.mjs'),
      "import Module from 'node:module'\nimport { readFileSync } from 'node:fs'\n" +
      "Module._extensions['.js'] = (mod, filename) => { mod._compile(readFileSync(filename, 'utf8'), filename) }\n")
    await writeFile(join(tmp, 'src', 'entry.js'), "const { v } = require('./dep.js')\nconsole.log('entry sees:', v)\n")
    await writeFile(join(tmp, 'src', 'dep.js'), "module.exports = { v: 'CLEAN' }\n")

    const cap = await run(['run', '--lock=add', '--bundle=add', '--import', './transplant.mjs', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
    t.assert.equal(cap.stdout, 'entry sees: CLEAN\n')
    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/dep.js', 'src/entry.js'])

    await writeFile(join(tmp, 'src', 'dep.js'), "module.exports = { v: 'TAMPERED' }\n")
    const rejected = await run(['run', '--lock=frozen', '--bundle=frozen', '--import', './transplant.mjs', 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(rejected.status, 0)

    // Under bundle=load (disk still tampered) exactly two outcomes are sound, and WHICH one
    // depends on the Node minor: when the commonjs-sync pipeline routes the require through the
    // hooks (24.14), the attested bytes simply win; when it consults require.extensions (24.19+),
    // the transplanted handler reads DISK and the run must be refused -- never a silent tamper.
    const replay = await run(['run', '--lock=frozen', '--bundle=load', '--import', './transplant.mjs', 'src/entry.js'], { cwd: tmp })
    if (replay.status === 0) {
      t.assert.equal(replay.stdout, 'entry sees: CLEAN\n', 'an exit-0 replay must have served the attested bytes')
    } else {
      t.assert.match(replay.stderr, /bypassing the attested bundle/)
      t.assert.doesNotMatch(replay.stdout, /TAMPERED/)
    }
  }))

  test('a wrapper preload importing the entry itself still yields a correct capture', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"wrapper-entry","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'wrapper.mjs'), "import './src/entry.mjs'\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "import { v } from './dep.mjs'\nconsole.log('entry sees:', v)\n")
    await writeFile(join(tmp, 'src', 'dep.mjs'), "export const v = 'CLEAN'\n")

    const r = await run(['run', '--lock=add', '--import', './wrapper.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = await readLock(tmp)
    t.assert.deepEqual(lock.entries, ['src/entry.mjs'], 'the promoted module is attested as the ENTRY, not misfiled')
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/dep.mjs', 'src/entry.mjs'])
    t.assert.equal(flatImports(lock)['src/entry.mjs']?.['./dep.mjs'], 'src/dep.mjs')
  }))

  test('--mock warns about --import preloads and still runs a non-transforming one', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"mock-preload","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'pre.mjs'), "console.error('[pre] loaded')\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "console.log('entry ran')\n")

    const r = await run(['run', '--lock=add', '--mock', '--import', './pre.mjs', 'src/entry.mjs'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stderr, /--import preloads run under --mock's side-effect denials/)
    t.assert.match(r.stderr, /\[pre\] loaded/)
    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files), ['src/entry.mjs'])
  }))

  test('the stasis-core CLI forwards --import with the same promotion semantics', withTmp(async (t, tmp) => {
    await mkdir(join(tmp, 'src'))
    await writeFile(join(tmp, 'package.json'), '{"name":"core-parity","version":"1.0.0","private":true,"type":"module"}\n')
    await writeFile(join(tmp, 'preload.mjs'), "import './src/shared.mjs'\n")
    await writeFile(join(tmp, 'src', 'shared.mjs'), "export const v = 'CLEAN'\n")
    await writeFile(join(tmp, 'src', 'entry.mjs'), "import { v } from './shared.mjs'\nconsole.log('entry sees:', v)\n")

    const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')
    const child = spawn(process.execPath, [coreCli, 'run', '--lock=add', '--import', './preload.mjs', 'src/entry.mjs'], { cwd: tmp, env: cleanEnv })
    const stderrChunks = []
    child.stderr.on('data', (d) => stderrChunks.push(d))
    const [status] = await once(child, 'close')
    t.assert.equal(status, 0, `stderr: ${Buffer.concat(stderrChunks)}`)
    t.assert.match(Buffer.concat(stderrChunks).toString(), /import: \[ '\.\/preload\.mjs' \]/)
    const lock = await readLock(tmp)
    t.assert.deepEqual(Object.keys(lock.sources['.'].files).toSorted(), ['src/entry.mjs', 'src/shared.mjs'])
  }))
})
