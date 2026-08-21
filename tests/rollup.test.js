import { test, describe } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'rollup-run.helper.js')
const fullFixture = join(here, 'fixtures', 'rollup-full')
const nmFixture = join(here, 'fixtures', 'rollup-nm')
const jsonFixture = join(here, 'fixtures', 'rollup-json')
const assetsFixture = join(here, 'fixtures', 'rollup-assets')

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

// Async child-process runner. Blocking spawnSync would stall the node:test event
// loop, collapsing the describe-level `concurrency` below to wall-clock-sequential.
// spawn() + once('close') yields between tests, so the concurrent rollup builds
// actually overlap. Each test still gets its own subprocess -- and thus a fresh
// preload singleton -- so the isolation the spawn model provides is unchanged.
const run = async (entries, { cwd, env = {} }) => {
  const child = spawn(process.execPath, [helper, ...entries], {
    cwd,
    env: { ...cleanEnv, ...env },
  })
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
  const dir = mkdtempSync(join(tmpdir(), 'stasis-rollup-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// node --test already runs test files in parallel (~= CPU count), and each test
// here spawns a build subprocess. Running every test at once would oversubscribe
// CPU/RAM (files-in-parallel x tests-in-file); a small per-file cap keeps the
// total concurrent-subprocess count bounded while capturing most of the speedup.
const CONCURRENCY = 4 // matches the esbuild/webpack suites

describe('StasisRollup (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('lock=add records the entry and its imports', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.config, { scope: 'full' })
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
    t.assert.deepEqual(lock.imports['*']['src/entry.js'], { './hello.js': 'src/hello.js' })
    t.assert.deepEqual(lock.modules, {})
  }))

  test('lock=add is idempotent against the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const after = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
    t.assert.equal(after, before)
  }))

  test('lock=frozen succeeds with the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
  }))

  test('lock=frozen rejects a changed source file', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  test('lock=add rejects a changed source file', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  test('lock=frozen rejects a brand-new entry not listed in the lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

    const r = await run(['src/fresh.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  test('lock=replace rewrites the lockfile after a source change', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockPath = join(tmp, 'stasis.lock.json')
    const before = readFileSync(lockPath, 'utf-8')
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
    const oldHash = JSON.parse(before).sources['.'].files['src/hello.js']
    const newHash = after.sources['.'].files['src/hello.js']
    t.assert.notEqual(newHash, oldHash)
    t.assert.ok(newHash.startsWith('sha512-'))
    t.assert.deepEqual(after.entries, ['src/entry.js'])
  }))

  test('lock=ignore tolerates the committed lockfile and does not touch it', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockPath = join(tmp, 'stasis.lock.json')
    const before = readFileSync(lockPath, 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
  }))

  test('bundle=add writes a bundle whose sources match disk', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))

    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.version, 1)
    t.assert.deepEqual(decoded.config, { scope: 'full' })
    t.assert.deepEqual(decoded.entries, ['src/entry.js'])
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
    t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
    t.assert.equal(decoded.formats['src/entry.js'], 'module')
  }))

  test('bundle=load rejects a tampered source in the bundle', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const save = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

    // tamper: swap hello.js source for an attacker payload
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
    writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

    // re-running with bundle=add (which pre-loads the bundle) must catch the disk/bundle disagreement
    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'frozen',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  test('bundle=load fails closed when an in-scope file is missing from the bundle (does NOT silently fall through to disk)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Tamper: drop src/hello.js from sources. The import-map edge entry.js ->
    // ./hello.js is still attested, so resolveId picks the same path -- but
    // the load hook's state.getFile call must error (no disk fallback) when the
    // source bytes aren't there. The sources stay on disk so silent disk
    // fallback would succeed; the fix is that it must not.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      },
    })
    t.assert.notEqual(r.status, 0, 'load must fail when an in-scope file is missing from the bundle')
    t.assert.match(r.stderr, /hello\.js/)
  }))

  // Fail-closed on the genuinely-new branch: the externals defer must NOT become a disk
  // fallback for an in-scope FILE. The test above drops only the SOURCE (keeping the edge),
  // so getImport still succeeds and never reaches the defer catch. Here we drop BOTH the
  // edge AND the bytes for an in-scope relative import: getImport throws
  // ERR_MODULE_NOT_FOUND -> the catch returns null -> rollup re-resolves ./hello.js from
  // disk -> the load hook's getFile throws (not in bundle). The build MUST fail even though
  // hello.js is present on disk in the load dir.
  test('bundle=load still fails closed when an in-scope edge AND its bytes are dropped (defer is not a disk fallback)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    for (const k of Object.keys(decoded.imports)) delete decoded.imports[k]['src/entry.js']
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })  // full source tree stays on disk
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
      },
    })
    t.assert.notEqual(r.status, 0, 'defer must not silently read the in-scope file from disk')
    t.assert.match(r.stderr, /hello\.js/)
  }))

  test('bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp(async (t, tmp) => {
    // Phase 1 in a capture-side dir (full fixture: sources, lockfile, config).
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ROLLUP_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    // Phase 2 in a clean load-side dir holding nothing but the bundle file and the
    // bare-minimum package.json State needs to anchor its root discovery. NO sources,
    // no lockfile, no stasis.config.json, no pnpm-workspace.yaml -- just the bundle.
    // This is the deployment shape we want to support: ship the bundle, drop it on
    // a host, run the bundler again, get the same output.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')
    t.assert.ok(!existsSync(join(loadDir, 'stasis.lock.json')), 'load dir must not contain a lockfile')

    const outB = join(tmp, 'out-load')
    // lock=none: in this clean-dir scenario the bundle is self-authoritative -- no
    // lockfile is required to verify content (getFile's hash check is gated on useLockfile).
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ROLLUP_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    // Round-trip faithfulness: the bundler's emitted JS bytes must match. Load mode
    // returns the same absolute paths from resolveId as capture mode, so rollup's
    // chunking and naming resolve identically in both runs.
    t.assert.equal(replayOutput, captureOutput)
  }))

  // A Node.js built-in (`node:constants`, `path`, ...) imported by an in-scope file must
  // NOT be looked up in the bundle's import map under bundle=load. Built-ins are never
  // carried in the bundle and never recorded as import edges -- the capture side defers
  // isBuiltin() specifiers before addImport sees them. So the load-mode resolveId hook has
  // to return null for them and let rollup externalize them (with the user's `external`
  // config), exactly as in a build without this plugin.
  test('bundle=load defers Node built-ins to rollup instead of looking them up in the bundle', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "import { O_RDONLY } from 'node:constants'\n" +
      "import { sep } from 'path'\n" +
      "import { greet } from './hello.js'\n" +
      "console.log(greet('world'), O_RDONLY, sep)\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ROLLUP_EXTERNAL: '["node:constants", "path"]',
        STASIS_TEST_ROLLUP_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ROLLUP_EXTERNAL: '["node:constants", "path"]',
        STASIS_TEST_ROLLUP_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /from 'node:constants'/)
    t.assert.match(replayOutput, /from 'path'/)
  }))

  // Generalizes the built-in case to ALL externals: a non-builtin module the user marks
  // `external` is never bundled and never recorded as an import edge. At bundle=load,
  // state.getImport throws ERR_MODULE_NOT_FOUND; the load-mode resolveId hook must treat
  // that miss as "external" and return null so rollup externalizes it, instead of failing
  // the build. The byte-level fail-closed gate (load hook -> getFile) is unaffected.
  test('bundle=load defers user externals (electron) to rollup instead of looking them up in the bundle', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "import { app } from 'electron'\n" +
      "import { greet } from './hello.js'\n" +
      "console.log(greet(typeof app))\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ROLLUP_EXTERNAL: '["electron"]',
        STASIS_TEST_ROLLUP_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ROLLUP_EXTERNAL: '["electron"]',
        STASIS_TEST_ROLLUP_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /from 'electron'/)
  }))

  test('bundle=load: import attributes (with { type: "json" }) round-trip', withTmp(async (t, tmp) => {
    // Edges with `with { type: 'json' }` are stored under a conditions-with-attributes
    // key (state.#conditionsKey). The rollup plugin must forward those attributes both
    // at capture (addImport) and at load (getImport) for the round-trip to find the same
    // key. Without the forwarding, load-mode getImport would use the '*' wildcard and
    // miss the attributed entry.
    const capDir = join(tmp, 'cap')
    cpSync(jsonFixture, capDir, { recursive: true })
    writeFileSync(
      join(capDir, 'src/entry.js'),
      `import data from './data.json' with { type: 'json' }\nconsole.log(\`hello, \${data.who}\`)\n`,
    )
    rmSync(join(capDir, 'stasis.lock.json'))
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-cap')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ROLLUP_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    // Sanity: the captured bundle's imports map keys the edge under the
    // attribute-bearing conditions string.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    const importsKeys = Object.keys(decoded.imports)
    t.assert.ok(
      importsKeys.some((k) => k.includes('"type":"json"')),
      `expected at least one imports key to carry the type=json attribute; got ${JSON.stringify(importsKeys)}`,
    )

    // Load mode: tear down sources, re-run with bundle=load. The plugin's
    // load-mode getImport must pass the same attributes to find the keyed edge.
    rmSync(join(capDir, 'src'), { recursive: true })
    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'frozen',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ROLLUP_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(
      readFileSync(join(outB, 'entry.js'), 'utf-8'),
      readFileSync(join(outA, 'entry.js'), 'utf-8'),
      'with-attributes import must round-trip byte-identically under bundle=load',
    )
  }))

  test('node_modules scope records package files and skips src/', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.config, { scope: 'node_modules' })
    t.assert.equal(lock.entries, undefined)
    t.assert.equal(lock.sources, undefined)
    t.assert.ok(lock.modules['node_modules/fake-esm-pkg'])
    t.assert.ok(lock.modules['node_modules/fake-esm-pkg'].files['index.js'].startsWith('sha512-'))
  }))

  test('node_modules scope lock=frozen rejects a changed node_modules file', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'),
      'export const greet = (n) => `pwned, ${n}`\n'
    )

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  test('node_modules scope lock=frozen tolerates changes to non-tracked src/ files', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    // src/ is outside node_modules scope, so changes here must not affect the lockfile check
    writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'mars'\n")

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  }))

  test('node_modules scope bundle=load serves the package from the bundle after node_modules is deleted', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'ignore',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
        STASIS_TEST_ROLLUP_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // node_modules gone: the attested edge (src/entry.js -> fake-esm-pkg) and the package
    // bytes must both come from the bundle; src/ keeps loading from disk (out of scope).
    rmSync(join(tmp, 'node_modules'), { recursive: true })
    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'ignore',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
        STASIS_TEST_ROLLUP_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(
      readFileSync(join(outB, 'entry.js'), 'utf-8'),
      readFileSync(join(outA, 'entry.js'), 'utf-8'),
      'load output must match capture output with node_modules gone',
    )
  }))

  test('lock=add records a .json import alongside the entry', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/data.json'].startsWith('sha512-'))
    t.assert.equal(lock.formats['src/data.json'], 'json')
  }))

  test('lock=frozen rejects a changed .json import', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'data.json'), '{ "who": "mars" }\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /ERR_ASSERTION|AssertionError/)
  }))

  // ----- Plugin options coverage --------------------------------------------------------

  const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

  test('options.lock=add records the entry like the env path', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add' }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  }))

  test('options.bundle=add with bundleFile writes the bundle at the chosen path', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath }),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('options conflict with env is reported', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Config options can not override stasis env/)
  }))

  test('unknown plugin option is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Unknown StasisRollup options/)
  }))

  test('invalid plugin option value is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Invalid lock/)
  }))

  // ----- Plugin↔preload coordination paths ----------------------------------------------

  const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

  test('rule 1: plugin lockfile without preload is a hard throw', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
  }))

  test('rule 0: plugin with no options, no preload, not under stasis run does nothing', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    // No capture options and not under `stasis run` -> the plugin is inert (Rule 0). Wiring
    // StasisRollup into a config is a no-op on a plain build; it neither throws nor writes.
    const r = await run(['src/entry.js'], { cwd: tmp, env: standalone(withOpts({})) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'inert plugin must not touch the lockfile')
  }))

  test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'noop plugin must not touch the lockfile')
  }))

  test('plugin standalone with bundle writes the bundle via buildEnd', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath), 'plugin must write the bundle when the graph completes')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('failed build does not write the bundle (no clobber)', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './does-not-exist.js'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.equal(existsSync(bundlePath), false, 'failed build must not write the bundle')
  }))

  test('unknown extension throws unless it is in the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    // The plugin must refuse rather than silently widen lockfile coverage to a file the
    // Node loader could never serve back.
    writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test('resources allowlist attests opted-in extensions', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    rmSync(join(tmp, 'stasis.lock.json'))

    // The asset shim stands in for the user's css-loading plugin (rollup core can't
    // parse css); the stasis plugin still attests the raw bytes before deferring to it.
    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: withOpts({ lock: 'add', resources: ['css'] }, { STASIS_TEST_ROLLUP_ASSETS: '1' }),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/styles.css'].startsWith('sha512-'),
      'allowlisted resource is hash-attested')
    t.assert.equal(lock.formats['src/styles.css'], 'resource')
  }))

  test('resources rejects code extensions and malformed entries', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    let r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /resources entry 'js' is a code extension/)

    r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['../etc/passwd'] }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /is not a valid extension/)
  }))

  test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const preloadBundle = join(tmp, 'preload.br')
    const sidecarBundle = join(tmp, 'sidecar.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(preloadBundle), 'preload bundle must be written by loader hooks')
    t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle must be written by the plugin buildEnd hook')
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
  }))

  // ----- Asset plugins: binary resources (png/svg) ---------------------------------------

  test('asset (png/svg) imports throw without the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_ROLLUP_ASSETS: '1' },
    })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test('asset (png/svg) imports are hash-attested with per-file resource formats and edges', withTmp(async (t, tmp) => {
    // The user's asset plugin (the shim, standing in for @rollup/plugin-url) loads the
    // files into the graph; stasis attests the raw bytes and the import edges first.
    cpSync(assetsFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        STASIS_TEST_ROLLUP_ASSETS: '1',
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    // Lockfile attests bytes (sha512 of raw bytes) for all three files.
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
    t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')
    t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
    t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')

    // Bundle: all three files live together; resources are tagged in formats, and the
    // edges are recorded so a tampered/removed asset can't hide from verification.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
    t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
    t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
    t.assert.equal(decoded.imports['*']['src/entry.js']['./logo.png'], 'src/logo.png', 'png edge recorded')
    t.assert.equal(decoded.imports['*']['src/entry.js']['./icon.svg'], 'src/icon.svg', 'svg edge recorded')
  }))

  // Rollup asset plugins read their file from disk inside their own load hook -- there is
  // no seam to hand them attested bytes (unlike esbuild's loader replay or webpack's
  // inputFileSystem), so bundle=load must refuse a resource loudly instead of letting the
  // asset plugin silently read unattested (or missing) disk bytes.
  test("bundle=load refuses resource imports with a clear error (no unattested disk read)", withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(assetsFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        STASIS_TEST_ROLLUP_ASSETS: '1',
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: capBundle, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Clean load dir: only the bundle + a minimal package.json, so a disk fallback could
    // not even pretend to work -- the refusal must name the resource and the reason.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        STASIS_TEST_ROLLUP_ASSETS: '1',
        ...withOpts({ lock: 'none', bundle: 'load', bundleFile: join(loadDir, 'snapshot.br'), resources: ['png', 'svg'] }),
      },
    })
    t.assert.notEqual(r.status, 0, 'load must refuse resource imports')
    t.assert.match(r.stderr, /bundle=load can't serve resource/)
  }))
})
