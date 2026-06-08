import { before, describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  link, mkdir, mkdtemp, readdir, readFile, readlink,
  rm, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'popular-npm-modules')

// The 10 top-level popular packages bundled by the fixture's src/entry.js.
// The bundle additionally includes their transitive dependencies — express
// alone pulls in ~30 — but this list pins the explicit set under test.
const popularPackages = [
  'axios', 'chalk', 'debug', 'dotenv', 'express',
  'lodash', 'nanoid', 'picocolors', 'semver', 'uuid',
]

// Deterministic stdout produced by src/entry.js — exercises a representative
// surface of each module so a tampered bundle would diverge here.
const expectedOutput = `${JSON.stringify([
  ['express.app', true],
  ['lodash.chunk', '[[1,2],[3,4],[5]]'],
  ['chalk.red', true],
  ['debug.fn', true],
  ['semver.gt', true],
  ['uuid.len', 36],
  ['axios.create', true],
  ['dotenv.parse', '{"A":"1","B":"2"}'],
  ['picocolors.green', true],
  ['nanoid.length', 21],
])}\n`

const cleanEnv = (() => {
  const {
    EXODUS_STASIS_LOCK: _l,
    EXODUS_STASIS_SCOPE: _s,
    EXODUS_STASIS_BUNDLE: _b,
    EXODUS_STASIS_BUNDLE_FILE: _bf,
    EXODUS_STASIS_DEBUG: _d,
    ...rest
  } = process.env
  // q11 (the default) is ~3.4s on the 10-package payload; q5 is ~50ms for the
  // same input and the same valid .br format. The matrix runs many writes per
  // suite, so override across the board.
  return { ...rest, EXODUS_STASIS_BROTLI_QUALITY: '5' }
})()

// Async child-process runner. Sync I/O would block the node:test event loop,
// reducing describe-level `concurrency: true` to wall-clock-sequential — the
// scheduler can't interleave tests if every spawn/read/write blocks the
// thread. Using spawn() + once('close') yields between tests, so concurrent
// describes actually overlap their stasis subprocess time.
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
  const dir = await mkdtemp(join(tmpdir(), 'stasis-popular-'))
  try {
    return await fn(t, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Hardlinked clone of the fixture: ~40ms vs ~780ms for a real cp of the 13MB
// node_modules tree. Each cell of the lock x bundle matrix gets its own fresh
// clone, and over 22 cells the saved I/O dominates the suite's wall time.
//
// Hardlinks share an inode with the fixture, so a naive writeFile to a cloned
// path would also rewrite the fixture file. Tests that mutate a cloned path
// MUST go through tamper() (below), which unlinks first so the inode share is
// broken before the new bytes land.
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

// Safe write to a hardlinked path: unlink first so the inode share with the
// original fixture file is broken before new bytes are written. Without this,
// writeFile would truncate-and-write into the shared inode, corrupting the
// real fixture on disk.
const tamper = async (path, content) => {
  await unlink(path)
  await writeFile(path, content)
}

const parseLock = (text) => {
  const lock = JSON.parse(text)
  if (lock.config?.scope !== 'node_modules') throw new Error(`unexpected scope: ${JSON.stringify(lock.config)}`)
  if (Object.keys(lock.modules ?? {}).length === 0) throw new Error('lockfile has no modules')
  return lock
}

const decodeBundle = (buf) => {
  const decoded = JSON.parse(brotliDecompressSync(buf).toString('utf-8'))
  if (decoded.version !== 1) throw new Error(`unexpected bundle version: ${decoded.version}`)
  if (decoded.config?.scope !== 'node_modules') throw new Error(`unexpected scope: ${JSON.stringify(decoded.config)}`)
  return decoded
}

// Shared lockfile text + bundle bytes generated once from src/entry.js (all 10
// packages). Reusing these across the matrix + lockfile tests amortises the
// single bundle write across every cell that needs a frozen-attested artifact.
// Both are produced from the same install, so they agree with each other (a
// frozen lockfile cross-checks the bundle's source hashes on load) and with
// the on-disk node_modules in any fresh fixture copy.
let lockText
let bundleBuf

// The fixture pulls real packages from npm via its own pnpm-lock.yaml.
// node_modules is gitignored, so install on demand.
before(async () => {
  if (!existsSync(join(fixture, 'node_modules', 'lodash', 'package.json'))) {
    const child = spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: fixture })
    const stderrChunks = []
    child.stderr.on('data', (d) => stderrChunks.push(d))
    const [status] = await once(child, 'close')
    if (status !== 0) {
      throw new Error(`Failed to install fixture deps in ${fixture}: ${Buffer.concat(stderrChunks).toString('utf-8')}`)
    }
  }

  // Generate the shared lockfile + bundle that the matrix and the lockfile
  // cross-check tests reuse, so we pay the bundle write exactly once.
  const gen = await mkdtemp(join(tmpdir(), 'stasis-popular-gen-'))
  try {
    await hardlinkCopy(fixture, gen)
    const bundlePath = join(gen, 'snap.br')
    const r = await run(
      ['run', '--lock=add', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: gen },
    )
    if (r.status !== 0) throw new Error(`Failed to generate shared artifacts: ${r.stderr}`)
    lockText = await readFile(join(gen, 'stasis.lock.json'), 'utf-8')
    bundleBuf = await readFile(bundlePath)
  } finally {
    await rm(gen, { recursive: true, force: true })
  }
})

// All eight tests are independent — each gets its own hardlinked tmp via
// withTmp + freshCopy, and the shared lockText/bundleBuf are read-only after
// before(). describe({ concurrency: true }) interleaves them: each test runs
// to its first await, suspends, and the next one starts. With async run() the
// stasis subprocesses overlap on CPU and the OS schedules them across cores.
// Measured on a 4-core box: 6.4s parallel vs ~10s sequential.
describe('bundle + lockfile on the 10-package set', { concurrency: true }, () => {

  // --- Headline: the full 10-package set bundles and loads byte-for-byte. ---

  test('bundle=add captures all 10 popular packages; bundle=load reproduces identical output', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const bundlePath = join(tmp, 'snapshot.br')

    const save = await run(
      ['run', '--lock=none', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: tmp },
    )
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
    t.assert.equal(save.stdout, expectedOutput)
    t.assert.ok(existsSync(bundlePath))

    const decoded = decodeBundle(await readFile(bundlePath))
    const names = new Set(Object.values(decoded.modules).map((m) => m.name))
    for (const pkg of popularPackages) {
      t.assert.ok(names.has(pkg), `bundle should include ${pkg}; got ${[...names].toSorted().join(', ')}`)
    }
    for (const [dir, info] of Object.entries(decoded.modules)) {
      t.assert.ok(dir.includes('node_modules'), `module dir must live under node_modules: ${dir}`)
      t.assert.ok(info.name, `module ${dir} must have a name`)
      t.assert.ok(info.version, `module ${dir} must have a version`)
      t.assert.ok(Object.keys(info.files).length > 0, `module ${dir} must have files`)
    }
    // Both ESM and CJS sources must be present: chalk/nanoid/uuid are ESM,
    // express/lodash/debug are CJS. A missing format would break the loader.
    const formats = new Set(Object.values(decoded.formats))
    t.assert.ok(formats.has('module'), `bundle should include ESM-format files; got ${[...formats].join(', ')}`)
    t.assert.ok(formats.has('commonjs'), `bundle should include CJS-format files; got ${[...formats].join(', ')}`)

    const load = await run(
      ['run', '--lock=none', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: tmp },
    )
    t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
    t.assert.equal(load.stdout, expectedOutput)
  }))

  test('bundle=load serves ESM node_modules content from the bundle even if disk is tampered', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const bundlePath = join(tmp, 'snapshot.br')

    const save = await run(
      ['run', '--lock=none', '--dependencies', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: tmp },
    )
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

    // Tamper nanoid (ESM, zero-dep) on disk. In bundle=load the loader serves
    // node_modules from the bundle, so the bundle's bytes must win over disk.
    // tamper() (not writeFile) so the hardlink to the fixture is broken
    // before new bytes land.
    await tamper(
      join(tmp, 'node_modules', 'nanoid', 'index.js'),
      'export const nanoid = () => "TAMPERED-VALUE"\n',
    )

    const load = await run(
      ['run', '--lock=none', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: tmp },
    )
    t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
    t.assert.equal(load.stdout, expectedOutput)
    t.assert.doesNotMatch(load.stdout, /TAMPERED/, 'bundle must override on-disk tampered source')
  }))

  // --- Lockfile generation + integrity across the 10 packages. ---

  test('lock=add records sha512 + name/version for every popular package', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const r = await run(['run', '--lock=add', '--dependencies', '--bundle=none', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, expectedOutput)

    const lock = parseLock(await readFile(join(tmp, 'stasis.lock.json'), 'utf-8'))
    const names = new Set(Object.values(lock.modules).map((m) => m.name))
    for (const pkg of popularPackages) {
      t.assert.ok(names.has(pkg), `lockfile should record ${pkg}`)
    }
    for (const [dir, info] of Object.entries(lock.modules)) {
      t.assert.ok(info.name && info.version, `module ${dir} must carry name+version`)
      for (const [rel, hash] of Object.entries(info.files)) {
        t.assert.ok(hash.startsWith('sha512-'), `${dir}/${rel} must be a sha512 integrity hash`)
      }
    }
  }))

  test('lock=frozen passes against the committed lockfile and never rewrites it', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    await writeFile(join(tmp, 'stasis.lock.json'), lockText)
    const r = await run(['run', '--lock=frozen', '--dependencies', '--bundle=none', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(r.stdout, expectedOutput)
    t.assert.equal(await readFile(join(tmp, 'stasis.lock.json'), 'utf-8'), lockText, 'frozen must not rewrite the lockfile')
  }))

  test('lock=frozen rejects a tampered node_modules file', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    await writeFile(join(tmp, 'stasis.lock.json'), lockText)
    // Tamper a real package file the entry actually imports. lodash/lodash.js is
    // the package's main entry — its bytes are attested by the lockfile and
    // executed at startup, so a single-byte change must fail the hash check.
    // tamper() so the hardlink to the fixture is broken before new bytes land.
    const victim = join(tmp, 'node_modules', 'lodash', 'lodash.js')
    await tamper(victim, `${await readFile(victim, 'utf-8')}\n// tampered\n`)

    const r = await run(['run', '--lock=frozen', '--dependencies', '--bundle=none', 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
  }))

  test('lock=frozen + bundle=load rejects a bundle whose source bytes disagree with the lockfile', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    await writeFile(join(tmp, 'stasis.lock.json'), lockText)

    // Forge a bundle whose source bytes differ from the lockfile-attested hash:
    // pick lodash specifically so the divergence lands on a file the entry runs.
    const decoded = decodeBundle(bundleBuf)
    const lodash = Object.values(decoded.modules).find((m) => m.name === 'lodash')
    lodash.files['lodash.js'] = `${lodash.files['lodash.js']}\n// tampered\n`
    const bundlePath = join(tmp, 'snap.br')
    await writeFile(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

    const r = await run(
      ['run', '--lock=frozen', '--dependencies', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'],
      { cwd: tmp },
    )
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|sha512-/)
    t.assert.doesNotMatch(r.stdout, /tampered/, 'tampered source must not execute')
  }))

  test('lock=add is idempotent against a matching committed lockfile', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const lockPath = join(tmp, 'stasis.lock.json')
    await writeFile(lockPath, lockText)
    const r = await run(['run', '--lock=add', '--dependencies', '--bundle=none', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(await readFile(lockPath, 'utf-8'), lockText, 'lock=add against a matching lockfile must be a no-op')
  }))

  test('lock=replace drops a stale module from the committed lockfile', withTmp(async (t, tmp) => {
    await freshCopy(tmp)
    const lockPath = join(tmp, 'stasis.lock.json')
    const seeded = parseLock(lockText)
    seeded.modules['node_modules/totally-stale-pkg'] = {
      name: 'totally-stale-pkg',
      version: '9.9.9',
      files: { 'index.js': 'sha512-deadbeef' },
    }
    await writeFile(lockPath, `${JSON.stringify(seeded, undefined, 2)}\n`)

    const r = await run(['run', '--lock=replace', '--dependencies', '--bundle=none', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const after = parseLock(await readFile(lockPath, 'utf-8'))
    t.assert.equal(after.modules['node_modules/totally-stale-pkg'], undefined, 'stale module must be dropped')
  }))

})

// --- The full lock x bundle x mock matrix on real packages. ---
//
// Every valid (lock, bundle, mock) triple runs src/entry.js against a fresh
// fixture copy, then we assert the run succeeded, produced the expected
// output, and left the lockfile + bundle in the state the modes promise.
// Invalid combinations are excluded (covered for rejection by cli.test.js):
//   - lock=none + bundle=none
//   - bundle=load with lock not in {frozen, none, ignore}
//   - --mock + bundle=load (the CLI rejects this: --mock is for capture, not
//     replay)
//
// --mock asserts an extra invariant: under it the artifacts must be byte-
// identical to the non-mock equivalent. The entry has no side effects (just
// pure imports + assertions), so a correct --mock implementation produces
// the same bytes -- if it didn't, the import map or formats would have
// diverged silently.

const LOCK_MODES = ['none', 'ignore', 'add', 'replace', 'frozen']
const BUNDLE_MODES = ['none', 'ignore', 'add', 'replace', 'load']
const MOCK_MODES = [false, true]

const isValidCombo = (lock, bundle, mock) => {
  if (lock === 'none' && bundle === 'none') return false
  if (bundle === 'load' && !['frozen', 'none', 'ignore'].includes(lock)) return false
  if (mock && bundle === 'load') return false
  return true
}

describe('lock x bundle x mock matrix', { concurrency: true }, () => {
  for (const lock of LOCK_MODES) {
    for (const bundle of BUNDLE_MODES) {
      for (const mock of MOCK_MODES) {
        if (!isValidCombo(lock, bundle, mock)) continue

        const name = `lock=${lock} bundle=${bundle}${mock ? ' mock' : ''}: runs and leaves the promised lock/bundle state`
        test(name, withTmp(async (t, tmp) => {
          await freshCopy(tmp)
          const lockPath = join(tmp, 'stasis.lock.json')
          const bundlePath = join(tmp, 'snap.br')

          // Every mode except none runs against a committed lockfile: frozen/ignore
          // require/tolerate it, add is idempotent against it, replace rewrites it —
          // and when a bundle is also present, state refuses to "use sources"
          // without a lockfile to attest them unless replacing. none must see none.
          // load/ignore expect a bundle present; add/replace write their own.
          const seedLock = lock !== 'none'
          const seedBundle = bundle === 'load' || bundle === 'ignore'
          if (seedLock) await writeFile(lockPath, lockText)
          if (seedBundle) await writeFile(bundlePath, bundleBuf)

          const args = ['run', `--lock=${lock}`, '--dependencies', `--bundle=${bundle}`]
          if (bundle !== 'none') args.push(`--bundle-file=${bundlePath}`)
          if (mock) args.push('--mock')
          args.push('src/entry.js')

          const r = await run(args, { cwd: tmp })
          t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
          t.assert.equal(r.stdout, expectedOutput)

          // Lockfile side effects. --mock must NOT change what gets written:
          // the lockfile produced under mock is byte-identical to the one we
          // generated up front (lockText), because the entry has no side
          // effects and --conditions=node-addons keeps resolution identical.
          if (lock === 'none') {
            t.assert.ok(!existsSync(lockPath), 'lock=none must not create a lockfile')
          } else if (lock === 'frozen' || lock === 'ignore') {
            t.assert.equal(await readFile(lockPath, 'utf-8'), lockText, `lock=${lock} must not modify the lockfile`)
          } else if (mock) {
            t.assert.equal(await readFile(lockPath, 'utf-8'), lockText, `lock=${lock} --mock must produce the same lockfile as without --mock`)
          } else {
            parseLock(await readFile(lockPath, 'utf-8')) // add/replace: a valid lockfile was written
          }

          // Bundle side effects. Same byte-identity guarantee under --mock.
          if (bundle === 'none') {
            t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')), 'bundle=none must not write a bundle')
          } else if (bundle === 'load' || bundle === 'ignore') {
            t.assert.deepEqual(await readFile(bundlePath), bundleBuf, `bundle=${bundle} must not modify the bundle`)
          } else if (mock) {
            t.assert.deepEqual(await readFile(bundlePath), bundleBuf, `bundle=${bundle} --mock must produce the same bundle as without --mock`)
          } else {
            decodeBundle(await readFile(bundlePath)) // add/replace: a valid bundle was written
          }
        }))
      }
    }
  }
})
