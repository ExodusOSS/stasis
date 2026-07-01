import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { StasisWebpack } from '@exodus/stasis-plugins/webpack'
import { State } from '@exodus/stasis-core/state'

// StasisWebpack writes a sidecar/standalone bundle on compiler.hooks.done. webpack fires that
// hook once PER CHILD COMPILER, so a MultiCompiler with N targets sharing one plugin instance
// would re-serialize + brotli-compress (quality 11, super-linear in size) the whole, ever-growing
// bundle N times. The fix defers ONLY that multi-compiler one-shot case to a single
// beforeExit/exit flush (one write of the final bundle); a single compiler and watch mode keep the
// immediate write-on-`done`. No real webpack here -- a fake compiler exposing the hooks the plugin
// taps (normalModuleFactory, watchRun, done) drives the completion logic; afterResolve lets a test
// feed the plugin a real source file so the deferred write's CONTENT can be checked.
//
// Test 1 (single) and Test 2 (multi) are the regression guards: revert the fix to a direct
// write()-in-`done` and Test 2's "deferred until flush" assertions fail. The remaining cases pin
// the fix's other properties (exit-path durability, retry-after-throw, watch immediacy, failed
// builds, byte content).

// Minimal tapable-style hook: collects tapped fns, `call` invokes them in order.
const mkHook = () => {
  const fns = []
  return { tap: (_name, fn) => fns.push(fn), call: (...args) => fns.forEach((fn) => fn(...args)) }
}

function fakeCompiler() {
  const nmf = { hooks: { beforeResolve: mkHook(), afterResolve: mkHook() } }
  const hooks = { normalModuleFactory: mkHook(), watchRun: mkHook(), done: mkHook() }
  return {
    hooks,
    inputFileSystem: {},
    // apply() then deliver the normalModuleFactory the plugin taps, mirroring webpack.
    applyTo(plugin) { plugin.apply(this); hooks.normalModuleFactory.call(nmf) },
    // Feed the plugin's afterResolve a resolved entry file (no issuer -> isEntry), as webpack
    // would for an entry module, so the State actually captures `absPath`'s bytes.
    captureEntry(absPath) {
      nmf.hooks.afterResolve.call({
        createData: { resourceResolveData: { path: absPath }, rawRequest: absPath },
        dependencies: [],
        contextInfo: {},
      })
    },
  }
}

const CLEAN = { hasErrors: () => false }
const FAILED = { hasErrors: () => true }

// Construct a standalone (no-preload) writing plugin anchored at a throwaway project dir.
// resolvePluginState reads process.cwd(), so chdir for the construction then restore.
//
// The plugin's deferred flush registers process 'beforeExit'/'exit' listeners. Emitting the real
// events disturbs node:test's event-loop accounting, so a scoped process.on spy CAPTURES both
// listener kinds (without registering them on the real process) and exposes flushBeforeExit() /
// flushExit() -- the in-test stand-ins for each exit path. opts.throwWritesUntil makes the first N
// State.write() calls throw, to exercise the retry-after-failure path.
const withPlugin = (t, opts = {}) => {
  const { throwWritesUntil = 0 } = opts
  const dir = mkdtempSync(join(tmpdir(), 'stasis-defer-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }))
  const bundleFile = join(dir, 'sources.br')

  // Count State.write() calls precisely (the plugin's State is private), and restore after.
  const origWrite = State.prototype.write
  let writes = 0
  State.prototype.write = function patchedWrite(...args) {
    writes += 1
    if (writes <= throwWritesUntil) throw new Error('simulated write failure')
    return origWrite.apply(this, args)
  }

  // Capture the plugin's exit listeners by kind; pass everything else through to the real on().
  const captured = { beforeExit: [], exit: [] }
  const origOn = process.on.bind(process)
  process.on = (event, fn) => {
    if (event === 'beforeExit' || event === 'exit') { captured[event].push(fn); return process }
    return origOn(event, fn)
  }

  const cwd = process.cwd()
  process.chdir(dir)
  let plugin
  try {
    plugin = new StasisWebpack({ lock: 'none', bundle: 'add', bundleFile })
  } finally {
    process.chdir(cwd)
  }

  t.after(() => {
    process.on = origOn
    State.prototype.write = origWrite
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    plugin,
    dir,
    bundleFile,
    writes: () => writes,
    flushBeforeExit: () => captured.beforeExit.forEach((fn) => fn()),
    flushExit: () => captured.exit.forEach((fn) => fn()),
  }
}

test('single compiler one-shot: writes immediately on `done` (not deferred)', (t) => {
  const { plugin, bundleFile, writes, flushBeforeExit } = withPlugin(t)
  const c = fakeCompiler()
  c.applyTo(plugin)

  c.hooks.done.call(CLEAN)
  t.assert.equal(writes(), 1, 'a lone compiler keeps the old write-by-`done` durability')
  t.assert.ok(existsSync(bundleFile), 'bundle on disk by the time run() would resolve')

  flushBeforeExit() // no deferral was armed, so exit is a no-op
  t.assert.equal(writes(), 1, 'no extra write at exit for the single-compiler case')
})

test('multi-compiler one-shot: N child `done`s coalesce into ONE deferred write at exit', (t) => {
  const { plugin, bundleFile, writes, flushBeforeExit } = withPlugin(t)

  // One shared instance applied to four child compilers (the MultiCompiler shape).
  const compilers = [fakeCompiler(), fakeCompiler(), fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)

  for (const c of compilers) c.hooks.done.call(CLEAN)
  t.assert.equal(writes(), 0, 'no write during the four child-compiler completions (deferred)')
  t.assert.ok(!existsSync(bundleFile), 'bundle not written until the deferred flush')

  flushBeforeExit()
  t.assert.equal(writes(), 1, 'exactly one write at process exit, not one per target')
  t.assert.ok(existsSync(bundleFile), 'bundle written by the beforeExit flush')

  flushBeforeExit() // dirty guard: nothing changed since the flush
  t.assert.equal(writes(), 1, 'no re-write on a second beforeExit')
})

test('multi-compiler one-shot: the `exit` backstop flushes when beforeExit never fires', (t) => {
  // process.exit() skips beforeExit; the exit listener must be the writer. (Regression guard for
  // the previously-untested exit path: dropping process.on('exit', flush) would fail this.)
  const { plugin, bundleFile, writes, flushExit } = withPlugin(t)
  const compilers = [fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)
  for (const c of compilers) c.hooks.done.call(CLEAN)

  t.assert.equal(writes(), 0)
  flushExit() // simulate process.exit() with no prior beforeExit
  t.assert.equal(writes(), 1, 'exit alone flushes the deferred write')
  t.assert.ok(existsSync(bundleFile))
})

test('deferred write that throws on beforeExit is retried by the exit backstop (not lost)', (t) => {
  const { plugin, bundleFile, writes, flushBeforeExit, flushExit } = withPlugin(t, { throwWritesUntil: 1 })
  const compilers = [fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)
  for (const c of compilers) c.hooks.done.call(CLEAN)

  // First flush: write() throws. The dirty flag must stay set (cleared only after success).
  t.assert.throws(() => flushBeforeExit(), /simulated write failure/)
  t.assert.ok(!existsSync(bundleFile), 'nothing written when the first flush failed')

  // Exit backstop retries; this write succeeds.
  flushExit()
  t.assert.equal(writes(), 2, 'the failed write was retried, not silently dropped')
  t.assert.ok(existsSync(bundleFile), 'bundle written on the retry')
})

test('watch mode: writes immediately on every `done`, never deferred', (t) => {
  const { plugin, bundleFile, writes, flushBeforeExit } = withPlugin(t)
  // Two compilers so captureApplyCount > 1 -- proving it is watch, not the single-compiler path,
  // that forces the immediate write.
  const compilers = [fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)
  for (const c of compilers) c.hooks.watchRun.call({}) // entering watch marks each compiler

  compilers[0].hooks.done.call(CLEAN)
  t.assert.equal(writes(), 1, 'watch rebuild writes right away (no beforeExit)')
  t.assert.ok(existsSync(bundleFile))

  compilers[1].hooks.done.call(CLEAN) // another rebuild writes again (compare-and-skip keeps it cheap)
  t.assert.equal(writes(), 2)

  flushBeforeExit() // watch never armed a deferred flush
  t.assert.equal(writes(), 2, 'no deferred flush in watch mode')
})

test('failed build schedules no deferred write', (t) => {
  const { plugin, bundleFile, writes, flushBeforeExit, flushExit } = withPlugin(t)
  const compilers = [fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)

  for (const c of compilers) c.hooks.done.call(FAILED)
  flushBeforeExit()
  flushExit()
  t.assert.equal(writes(), 0, 'a build with errors never writes, even at exit')
  t.assert.ok(!existsSync(bundleFile))
})

test('the deferred multi-compiler write produces the correct final bundle bytes', (t) => {
  const { plugin, dir, bundleFile, flushBeforeExit } = withPlugin(t)
  const entry = join(dir, 'entry.js')
  const source = 'export const answer = 42\n'
  writeFileSync(entry, source)

  const compilers = [fakeCompiler(), fakeCompiler()]
  for (const c of compilers) c.applyTo(plugin)
  compilers[0].captureEntry(entry) // one child resolves the entry module
  for (const c of compilers) c.hooks.done.call(CLEAN)

  flushBeforeExit()
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundleFile)).toString('utf-8'))
  t.assert.equal(decoded.version, 1, 'deferred write emits a v1 bundle')
  t.assert.equal(decoded.config.scope, 'full')
  t.assert.equal(decoded.sources['.'].files['entry.js'], source, 'captured entry content round-trips')
  t.assert.deepEqual(decoded.entries, ['entry.js'], 'the entry is recorded')
  // Sanity: the URL the plugin keyed addFile by matches the file we wrote.
  t.assert.ok(pathToFileURL(entry).toString().endsWith('/entry.js'))
})
