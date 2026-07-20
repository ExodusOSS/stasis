import { test, describe } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { bundleFromLockfile } from '../stasis/src/cmd/build.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fullFixture = join(here, 'fixtures', 'esbuild-full')
const nmFixture = join(here, 'fixtures', 'esbuild-nm')
const solFixture = join(here, 'fixtures', 'solidity-bundle', 'basic')
const assetsFixture = join(here, 'fixtures', 'esbuild-assets')

// drop inherited stasis env so the spawned CLI gets a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  ...cleanEnv
} = process.env

// Async runner for the (esbuild-backed) `stasis build` command -- the expensive
// spawn. Blocking spawnSync would stall the node:test event loop and collapse the
// describe-level `concurrency` below; spawn() + once('close') yields so the builds
// overlap. Each test still spawns its own process.
const runCli = async (args, { cwd } = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv })
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

// Run a built output file with Node and return its stdout (asserts a clean exit).
// Kept synchronous: it just executes a tiny already-built bundle (fast), and it's
// used inline as an expression, so it doesn't meaningfully hold up the event loop.
const runNode = (t, file, { cwd } = {}) => {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf-8', cwd })
  t.assert.equal(r.status, 0, `running ${file} failed: ${r.stderr}`)
  return r.stdout
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-build-cmd-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// node --test runs test files in parallel; each test here spawns a `stasis build`
// (esbuild) subprocess. A small per-file cap bounds the total concurrent-subprocess
// count while capturing most of the speedup.
const CONCURRENCY = 4 // matches CI runner cores

describe('stasis build (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('build from a full-scope bundle produces a runnable output', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundled = await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(bundled.status, 0, bundled.stderr)

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.ok(existsSync(join(tmp, 'out.js')))
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build from a lockfile reads and verifies sources from disk', withTmp(async (t, tmp) => {
    // The fixture ships a committed lockfile (graph + per-file digests, no content).
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built src\/entry\.js from lockfile/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build from a bundle is self-contained (no sources on disk)', withTmp(async (t, tmp) => {
    // Phase 1: bundle in a source dir.
    const cap = join(tmp, 'cap')
    cpSync(fullFixture, cap, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: cap })).status, 0)

    // Phase 2: a clean dir holding only the bundle + a minimal package.json -- the
    // deployment shape. No src/, no lockfile, no config.
    const load = join(tmp, 'load')
    mkdirSync(load)
    cpSync(join(cap, 'app.code.br'), join(load, 'app.code.br'))
    writeFileSync(join(load, 'package.json'), '{ "name": "x", "version": "0.0.0", "private": true, "type": "module" }')
    t.assert.ok(!existsSync(join(load, 'src')), 'load dir must not contain src/')

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: load })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(load, 'out.js')).trim(), 'hello, world')
  }))

  test('build follows the bundle\'s recorded bytes, not whatever is on disk', withTmp(async (t, tmp) => {
    const cap = join(tmp, 'cap')
    cpSync(fullFixture, cap, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: cap })).status, 0)

    // Build dir with the bundle but DIFFERENT source bytes on disk. A faithful build
    // must use the bundle's recorded bytes; disk must not leak in.
    const build = join(tmp, 'build')
    mkdirSync(build)
    cpSync(join(cap, 'app.code.br'), join(build, 'app.code.br'))
    writeFileSync(join(build, 'package.json'), '{ "name": "x", "version": "0.0.0", "private": true, "type": "module" }')
    mkdirSync(join(build, 'src'))
    writeFileSync(join(build, 'src', 'hello.js'), 'export const greet = (n) => `DISK-VERSION ${n}`\n')
    writeFileSync(join(build, 'src', 'entry.js'), "import { greet } from './hello.js'\nconsole.log(greet('world'))\n")

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: build })
    t.assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(join(build, 'out.js'), 'utf-8')
    t.assert.match(out, /hello, /, 'output must use the bundle\'s recorded source')
    t.assert.doesNotMatch(out, /DISK-VERSION/, 'output must not pick up the disk source')
  }))

  test('build from a lockfile fails closed when a source was changed on disk', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `pwned, ${n}`\n')

    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /does not match the lockfile/)
    t.assert.ok(!existsSync(join(tmp, 'out.js')), 'no output on a failed build')
  }))

  test('build rejects a node_modules-scope artifact', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    // The fixture ships a node_modules-scope lockfile (no entry, no workspace code).
    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /full-scope artifact/)
  }))

  test('build rejects a non-JS (Solidity) bundle', withTmp(async (t, tmp) => {
    cpSync(solFixture, tmp, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=s.code.br', 'src/A.sol'], { cwd: tmp })).status, 0)

    const r = await runCli(['build', '--output=out.js', 's.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /JavaScript\/TypeScript/)
  }))

  test('build of an entry that imports an asset fails (assets are not buildable yet)', withTmp(async (t, tmp) => {
    // The fixture's only entry imports a .png + .svg. Assets aren't recorded as import edges,
    // so esbuild can't resolve them -- the build fails. (NOT blocked artifact-wide; see the
    // next test: a code-only entry in an asset-carrying artifact still builds.)
    cpSync(assetsFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /\.(png|svg)|esbuild reported|loader|unsupported|resolve/i)
  }))

  test('build a code-only entry from an artifact that also carries assets for another entry', withTmp(async (t, tmp) => {
    // The asset belongs to a DIFFERENT entry (src/app.js). A resource-free entry (src/code.js)
    // must still build -- resources affect only the entry that actually imports them.
    writeFileSync(join(tmp, 'package.json'), '{ "name": "x", "version": "0.0.0", "private": true, "type": "module" }')
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/app.js', 'src/code.js'],
      sources: {
        '.': {
          name: 'x',
          version: '0.0.0',
          files: {
            'src/app.js': "import logo from './logo.svg'\nconsole.log(logo)\n",
            'src/code.js': "import { greet } from './greet.js'\nconsole.log(greet('world'))\n",
            'src/greet.js': 'export const greet = (n) => `hello, ${n}`\n',
            'src/logo.svg': '<svg></svg>\n',
          },
        },
      },
      modules: {},
      // logo.svg is a resource (for app.js); code.js -> greet.js is the only recorded edge.
      formats: { 'src/logo.svg': 'resource' },
      imports: { '*': { 'src/code.js': { './greet.js': 'src/greet.js' } } },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    const r = await runCli(['build', '--output=out.js', 'app.code.br', 'src/code.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build is artifact-driven: a conflicting project stasis.config.json is ignored', withTmp(async (t, tmp) => {
    // The fixture ships a full-scope lockfile. A node_modules-scoped (and frozen) run config
    // must NOT make build reject it -- the build is governed by the artifact, not the config.
    // (skipDiscovery means the serving State never reads stasis.config.json at all.)
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'stasis.config.json'), '{ "scope": "node_modules", "lock": "frozen" }')

    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build a bundle in a bare dir with no package.json (self-contained, anchors at the artifact dir)', withTmp(async (t, tmp) => {
    // A bundle is self-contained; build anchors at the artifact's own directory and reads
    // nothing else from disk -- so no package.json is required (the deployment shape).
    const cap = join(tmp, 'cap')
    cpSync(fullFixture, cap, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: cap })).status, 0)

    const bare = join(tmp, 'bare')
    mkdirSync(bare)
    cpSync(join(cap, 'app.code.br'), join(bare, 'app.code.br'))
    t.assert.ok(!existsSync(join(bare, 'package.json')), 'bare dir must have no package.json')

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: bare })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(bare, 'out.js')).trim(), 'hello, world')
  }))

  test('build ignores a stray stasis.code.br in the tree (no disk bundle discovery)', withTmp(async (t, tmp) => {
    // Regression: a stray default-named bundle of a DIFFERENT scope used to be read during
    // State construction and abort the build of an unrelated artifact. skipDiscovery reads no
    // disk bundle, so the in-memory artifact is authoritative and the stray is inert.
    const cap = join(tmp, 'cap')
    cpSync(fullFixture, cap, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: cap })).status, 0)

    const build = join(tmp, 'build')
    mkdirSync(build)
    cpSync(join(cap, 'app.code.br'), join(build, 'app.code.br'))
    writeFileSync(join(build, 'package.json'), '{ "name": "x", "version": "0.0.0", "private": true, "type": "module" }')
    // A stray node_modules-scope bundle at the default name (e.g. left by `stasis bundle
  // --scope=node_modules`): previously read + scope-asserted during construction.
    const stray = { version: 1, config: { scope: 'node_modules' }, modules: {}, formats: {}, imports: {} }
    writeFileSync(join(build, 'stasis.code.br'), brotliCompressSync(JSON.stringify(stray)))

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: build })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(build, 'out.js')).trim(), 'hello, world')
  }))

  test('build forwards --format and --minify to esbuild', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await runCli(['build', '--format=cjs', '--minify', '--output=out.cjs', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(join(tmp, 'out.cjs'), 'utf-8')
    // Minified output drops esbuild's per-file `// src/...` path banners.
    t.assert.doesNotMatch(out, /\/\/ src\//, 'minified output should not carry path-banner comments')
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), 'hello, world')
  }))

  test('build forwards --sourcemap (emits a .map alongside the output)', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--sourcemap', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.ok(existsSync(join(tmp, 'out.js.map')), 'a .map file is written next to out.js')
    t.assert.match(readFileSync(join(tmp, 'out.js'), 'utf-8'), /sourceMappingURL=out\.js\.map/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build writes into a directory --output (esbuild names the file from the entry)', withTmp(async (t, tmp) => {
    // A non-.js/.cjs/.mjs --output is a directory; esbuild's outdir names the output from the
    // entry (src/entry.js -> entry.js), and stasis writes it (auto-creating the dir).
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--output=dist', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.ok(existsSync(join(tmp, 'dist', 'entry.js')), 'esbuild writes dist/entry.js')
    t.assert.equal(runNode(t, join(tmp, 'dist', 'entry.js')).trim(), 'hello, world')
  }))

  // ----- output safety (no clobber of attested sources) ---------------------------------

  test('build refuses to overwrite a source the artifact records (no data loss)', withTmp(async (t, tmp) => {
    // Regression: esbuild's own "refusing to overwrite input file" check is POST-write, so a
    // stray --output colliding with a recorded source would destroy it (and permanently break a
    // lockfile, whose sha512 no longer matches). stasis builds with write:false and refuses
    // BEFORE touching disk, leaving the recorded file intact.
    cpSync(fullFixture, tmp, { recursive: true })
    const helloPath = join(tmp, 'src', 'hello.js')
    const original = readFileSync(helloPath, 'utf-8')

    const r = await runCli(['build', '--output=src/hello.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /refusing to write|records/i)
    t.assert.equal(readFileSync(helloPath, 'utf-8'), original, 'the recorded source must be untouched')
  }))

  // ----- esbuild passthroughs (--define / --external) -----------------------------------

  test('build forwards --define to esbuild', withTmp(async (t, tmp) => {
    // The entry branches on a bare identifier esbuild can statically substitute.
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: { '.': { name: 'x', version: '0.0.0', files: { 'src/entry.js': "console.log(__DEV__ ? 'DEV' : 'PROD')\n" } } },
      modules: {},
      formats: { 'src/entry.js': 'module' },
      imports: { '*': {} },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    const r = await runCli(['build', '--define=__DEV__=false', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    // __DEV__ -> false, so the constant branch folds to 'PROD'.
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'PROD')
  }))

  test('build rejects a malformed --define', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--define=NOPE', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--define must be KEY=VALUE/)
  }))

  test('build externalizes a non-recorded specifier only when --external names it', withTmp(async (t, tmp) => {
    // The entry imports `ext-pkg`, which the artifact does NOT record (a capture-time
    // external). esbuild can't resolve it on disk (bare build dir), so the build fails --
    // unless --external re-declares it, leaving it as a runtime import.
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: {
        '.': {
          name: 'x',
          version: '0.0.0',
          files: {
            'src/entry.js': "import ext from 'ext-pkg'\nimport { greet } from './hello.js'\nconsole.log(greet(typeof ext))\n",
            'src/hello.js': "export const greet = (n) => 'hello, ' + n\n",
          },
        },
      },
      modules: {},
      formats: { 'src/entry.js': 'module', 'src/hello.js': 'module' },
      // ext-pkg is intentionally absent from the graph; only the local edge is recorded.
      imports: { '*': { 'src/entry.js': { './hello.js': 'src/hello.js' } } },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    // Without --external: the unresolved `ext-pkg` import fails the build.
    const fail = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(fail.status, 0)
    t.assert.match(fail.stderr, /ext-pkg|Could not resolve|esbuild reported/)

    // With --external=ext-pkg: esbuild leaves it as a runtime require and the build succeeds.
    const ok = await runCli(['build', '--format=cjs', '--external=ext-pkg', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(ok.status, 0, ok.stderr)
    const out = readFileSync(join(tmp, 'out.cjs'), 'utf-8')
    t.assert.match(out, /require\(["']ext-pkg["']\)/, 'the external must survive as a runtime require')
    t.assert.match(out, /hello, /, 'the recorded local edge must still be inlined')
  }))

  test('build forwards --loader to enable JSX in a .js file', withTmp(async (t, tmp) => {
    // JSX in a .js file (the React Native convention) needs esbuild's jsx loader; the default
    // .js loader rejects it ("The JSX syntax extension is not currently enabled"). --loader
    // overrides the plugin's load-mode loader for that extension.
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/app.js'],
      sources: {
        '.': {
          name: 'x',
          version: '0.0.0',
          files: {
            'src/app.js': "/** @jsx h */\nconst h = (t, _p, ...k) => `<${t}>${k.join('')}</${t}>`\nconst App = () => <p>hi</p>\nconsole.log(App())\n",
          },
        },
      },
      modules: {},
      formats: { 'src/app.js': 'module' },
      imports: { '*': {} },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    // Without --loader: the .js loader can't parse JSX.
    const fail = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(fail.status, 0)
    t.assert.match(fail.stderr, /JSX syntax|loader|esbuild reported/)

    // With --loader=.js:jsx: builds and runs.
    const ok = await runCli(['build', '--format=cjs', '--loader=.js:jsx', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(ok.status, 0, ok.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), '<p>hi</p>')
  }))

  test('build rejects a malformed --loader', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--loader=jsx', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--loader must be \.EXT:LOADER/)
  }))

  // ----- entry-point selection ----------------------------------------------------------

  test('build defaults to the sole entry when the artifact has one', withTmp(async (t, tmp) => {
    // Covered implicitly elsewhere, but assert the no-entry-arg path explicitly.
    cpSync(fullFixture, tmp, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js'], { cwd: tmp })).status, 0)

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built src\/entry\.js/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build accepts an explicit entry for a single-entry artifact', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--output=out.js', 'stasis.lock.json', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build requires an entry when the artifact has several, and lists them', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    // Bundle two entry points (hello.js is a valid module entry of its own).
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js', 'src/hello.js'], { cwd: tmp })).status, 0)

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /has 2 entry points/)
    t.assert.match(r.stderr, /src\/entry\.js/)
    t.assert.match(r.stderr, /src\/hello\.js/)
  }))

  test('build builds the selected entry from a multi-entry artifact', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js', 'src/hello.js'], { cwd: tmp })).status, 0)

    const r = await runCli(['build', '--output=out.js', 'app.code.br', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built src\/entry\.js/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build rejects an entry that is not an entry point of the artifact', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    t.assert.equal((await runCli(['bundle', '--output=app.code.br', 'src/entry.js', 'src/hello.js'], { cwd: tmp })).status, 0)

    const r = await runCli(['build', '--output=out.js', 'app.code.br', 'src/nope.js'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /is not an entry point/)
    t.assert.match(r.stderr, /src\/entry\.js/)
  }))

  test('build requires an artifact and takes at most one entry', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    let r = await runCli(['build'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Nothing to build/)

    r = await runCli(['build', 'a.code.br', 'b.js', 'c.js'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /optional entry point/)
  }))

  // ----- JSX / TSX ----------------------------------------------------------------------

  test('build supports JSX/TSX entries', withTmp(async (t, tmp) => {
    // No `stasis bundle` path produces .jsx/.tsx (the static scanner is JS/TS only), but
    // the esbuild/webpack capture plugins classify them as code, so a bundle can carry
    // them. Hand-craft such a bundle: a .tsx entry (TypeScript + JSX, via the @jsx pragma
    // so esbuild's default classic runtime resolves the factory) importing a .jsx helper.
    writeFileSync(join(tmp, 'package.json'), '{ "name": "jsx-app", "version": "0.0.0", "private": true, "type": "module" }')
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/app.tsx'],
      sources: {
        '.': {
          name: 'jsx-app',
          version: '0.0.0',
          files: {
            'src/app.tsx':
              '/** @jsx h */\n' +
              "import { greet } from './greet.jsx'\n" +
              'const h = (tag: string, _props: unknown, ...kids: string[]) => `<${tag}>${kids.join(\'\')}</${tag}>`\n' +
              "const who: string = 'world'\n" +
              'console.log(<p>{greet(who)}</p>)\n',
            'src/greet.jsx': 'export const greet = (name) => `hello, ${name}`\n',
          },
        },
      },
      modules: {},
      formats: {},
      imports: { '*': { 'src/app.tsx': { './greet.jsx': 'src/greet.jsx' } } },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    const r = await runCli(['build', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    // esbuild stripped the TS types and transformed the JSX (both extensions handled).
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), '<p>hello, world</p>')
  }))

  // ----- CommonJS default-import interop (known limitation) -----------------------------

  test('build uses esbuild bundler-convention CJS interop, NOT Node\'s (known limitation)', withTmp(async (t, tmp) => {
    // CHARACTERIZATION TEST -- pins a known divergence from Node so an esbuild upgrade that
    // changes it is noticed (and doc/build.md's "CommonJS default-import interop" note can
    // be revisited). When an ESM module does `import d from 'cjs-dep'` and the CJS dep marks
    // itself `__esModule`, the two interop conventions disagree:
    //   * Node (and `stasis run` via the Node loader): d === the whole module.exports, so
    //     d.default === 'THE-DEFAULT' and d.__esModule === true.   -> 'MODULE-EXPORTS'
    //   * esbuild's bundler convention: d is unwrapped to module.exports.default.  -> 'THE-DEFAULT'
    // `stasis build` gets the bundler convention. ROOT CAUSE: the plugin serves every file's
    // bytes through onLoad, and esbuild's plugin API exposes no way to declare a loaded
    // file's module type -- so esbuild detects CJS from syntax and emits `__toESM(x)` with no
    // isNodeMode flag (vs `__toESM(x, 1)` when esbuild reads the file off disk itself and sees
    // the package.json/extension). This is consistent with how the esbuild/webpack capture
    // plugins bundle (they serve via onLoad too), so a plugin-captured bundle round-trips
    // faithfully; it only diverges from Node and from a plain on-disk esbuild build.
    writeFileSync(join(tmp, 'package.json'), '{ "name": "interop-app", "version": "0.0.0", "private": true, "type": "module" }')
    const bundleObj = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: {
        '.': {
          name: 'interop-app',
          version: '0.0.0',
          files: {
            'src/entry.js':
              "import d from 'dep'\n" +
              "console.log(d && d.__esModule === true && d.default === 'THE-DEFAULT' ? 'MODULE-EXPORTS' : 'UNWRAPPED:' + JSON.stringify(d))\n",
          },
        },
      },
      modules: {
        'node_modules/dep': {
          name: 'dep',
          version: '1.0.0',
          files: { 'index.js': "exports.__esModule = true\nexports.default = 'THE-DEFAULT'\n" },
        },
      },
      formats: { 'src/entry.js': 'module', 'node_modules/dep/index.js': 'commonjs' },
      imports: { '*': { 'src/entry.js': { dep: 'node_modules/dep/index.js' } } },
    }
    writeFileSync(join(tmp, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

    const r = await runCli(['build', '--output=out.mjs', '--format=esm', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    // esbuild emits the bundler-convention helper (no isNodeMode arg), so the default import
    // is unwrapped to module.exports.default -- the documented divergence from Node.
    const out = readFileSync(join(tmp, 'out.mjs'), 'utf-8')
    t.assert.match(out, /__toESM\(require_dep\(\)\)/)
    t.assert.doesNotMatch(out, /__toESM\(require_dep\(\), 1\)/)
    t.assert.equal(runNode(t, join(tmp, 'out.mjs')).trim(), 'UNWRAPPED:"THE-DEFAULT"')
  }))

  test('build rejects an invalid --format', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--format=umd', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--format must be esm, cjs, or iife/)
  }))

  // ----- bundleFromLockfile (the lockfile -> verified in-memory Bundle step) -------------

  test('bundleFromLockfile reconstructs a Bundle whose sources match disk', async (t) => {
    const lockfile = Lockfile.parse(readFileSync(join(fullFixture, 'stasis.lock.json'), 'utf-8'))
    const bundle = bundleFromLockfile(lockfile, { root: fullFixture })

    t.assert.ok(bundle instanceof Bundle)
    t.assert.deepEqual(bundle.config, { scope: 'full' })
    t.assert.deepEqual([...bundle.entries], ['src/entry.js'])
    // Content is read back from disk verbatim.
    t.assert.equal(bundle.sources.get('src/entry.js'), readFileSync(join(fullFixture, 'src/entry.js'), 'utf-8'))
    t.assert.equal(bundle.sources.get('src/hello.js'), readFileSync(join(fullFixture, 'src/hello.js'), 'utf-8'))
    // Graph + formats carry across from the lockfile.
    t.assert.equal(bundle.formats.get('src/entry.js'), 'module')
    t.assert.equal(bundle.imports.get('*').get('src/entry.js').get('./hello.js'), 'src/hello.js')
  })

  test('bundleFromLockfile throws when an attested file is missing on disk', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'src', 'hello.js'))
    const lockfile = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.throws(() => bundleFromLockfile(lockfile, { root: tmp }), /missing on disk: src\/hello\.js/)
  }))

  test('bundleFromLockfile requires a recorded import graph', async (t) => {
    // A lockfile predating resolution attestation carries imports === null. build can't
    // faithfully follow a graph that isn't there, so reconstruction fails closed.
    const lockfile = new Lockfile({ config: { scope: 'full' } })
    t.assert.equal(lockfile.imports, null)
    t.assert.throws(() => bundleFromLockfile(lockfile, { root: here }), /no recorded import graph/)
  })
})
