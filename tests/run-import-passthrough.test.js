// `stasis run --import <module>` passthrough: extra preloads ride to the spawned node AFTER
// stasis's own loader import. A preload's module graph evaluates before the entry and is runner
// infrastructure -- exempt from capture, like the loader itself -- while app code still
// round-trips capture -> frozen -> bundle=load. With `--import tsx` the transformer's hooks sit
// ABOVE stasis's (registered later => outer), so stasis keeps seeing the RAW on-disk TypeScript:
// the artifacts attest the on-disk bytes and the on-disk 'module-typescript' format while tsx
// resolves/serves the file as its post-erasure 'module' family at run time.

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
})
