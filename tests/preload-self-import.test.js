// Regression: when app code imports the SAME stasis-core that the preload
// loaded -- e.g. a build script that uses `State` directly, or a bundler
// plugin that pulls in `@exodus/stasis-plugins/plugins` -- the resolve hook
// fires for the import edge but Node's module cache short-circuits the
// load hook (the URL was loaded by Node BEFORE install() registered our
// hooks). Pre-fix: addFile never ran for those URLs, so the bundle's
// `modules` map was missing files the `imports` map referenced, producing
// a structurally inconsistent lockfile/bundle. The fix backfills addFile
// at save() time (the beforeExit / exit handler that runs just before
// state.write()) for any URL referenced in state.imports but absent from
// state.sources/resources -- see stasis-core/src/hooks.js, initState's
// save() closure.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const stasisCoreDir = join(here, '..', 'stasis-core')

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-self-import-'))
  try { return fn(t, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Drop inherited stasis env; the spawned child sets its own.
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  ...cleanEnv
} = process.env

const setupProject = (tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'self-import-repro', version: '0.0.0', private: true, type: 'module' }))
  // Place stasis-core under node_modules so its URLs resolve INSIDE state.root.
  // A symlink to /home/user/stasis/stasis-core would land outside the tmp root
  // and state.relative() would reject it; copying keeps the in-scope invariant.
  cpSync(stasisCoreDir, join(tmp, 'node_modules', '@exodus', 'stasis-core'), { recursive: true })
}

const run = (tmp, entryName, env) => {
  const loader = join(tmp, 'node_modules', '@exodus', 'stasis-core', 'src', 'loader.js')
  return spawnSync(process.execPath, ['--import', `file://${loader}`, entryName], {
    encoding: 'utf-8',
    cwd: tmp,
    env: { ...cleanEnv, ...env },
  })
}

test('app code importing stasis-core (preload-cached) gets its files captured in the bundle', withTmp((t, tmp) => {
  setupProject(tmp)
  writeFileSync(join(tmp, 'entry.js'),
    "import { State } from '@exodus/stasis-core/state'\n" +
    "if (!State.preload) throw new Error('expected preload State')\n"
  )
  const bundlePath = join(tmp, 'snapshot.br')

  const r = run(tmp, 'entry.js', {
    EXODUS_STASIS_LOCK: 'add',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'add',
    EXODUS_STASIS_BUNDLE_FILE: bundlePath,
  })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  // The bundle's `imports` records an edge to stasis-core's state.js (the resolve
  // hook captured it). The `modules` map must ALSO carry that file's content --
  // pre-fix it was empty for the stasis-core bucket because the load hook never
  // fired for preload-cached URLs.
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)).toString())
  const scoreEdge = bundle.imports?.['node, import, module-sync, node-addons']?.['entry.js']?.['@exodus/stasis-core/state']
  t.assert.equal(scoreEdge, 'node_modules/@exodus/stasis-core/src/state.js',
    'capture must record the import edge to stasis-core/state')

  const stasisBucket = bundle.modules?.['node_modules/@exodus/stasis-core']
  t.assert.ok(stasisBucket, 'bundle must include a module bucket for stasis-core (the file the import edge references)')
  t.assert.ok(stasisBucket.files?.['src/state.js'], 'bundle must carry state.js content (the load hook never fired for it -- backfill must)')

  // Same check via the lockfile: every file referenced in `imports` must also be
  // attested in `modules[*].files`. Pre-fix: the lockfile had dangling references.
  const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
  const lockEdge = lock.imports?.['node, import, module-sync, node-addons']?.['entry.js']?.['@exodus/stasis-core/state']
  t.assert.equal(lockEdge, 'node_modules/@exodus/stasis-core/src/state.js')
  t.assert.ok(lock.modules?.['node_modules/@exodus/stasis-core']?.files?.['src/state.js']?.startsWith('sha512-'),
    'lockfile must hash state.js (no dangling import reference)')

  // stasis-core's INTERNAL edges (state.js -> ./config.js, etc.) must also be
  // recorded. Pre-fix: state.js was loaded by Node BEFORE our hooks registered,
  // so the resolve hook never observed its own imports -- the lockfile/bundle
  // ended up with state.js's bytes but no edges originating from it. The
  // static-parse backfill in state.write() recovers them.
  const stasisEdges = bundle.imports?.['node, import, module-sync, node-addons']?.['node_modules/@exodus/stasis-core/src/state.js']
  t.assert.ok(stasisEdges, 'state.js must have outgoing edges recorded')
  t.assert.equal(stasisEdges['./config.js'], 'node_modules/@exodus/stasis-core/src/config.js',
    'state.js -> ./config.js must be in the bundle')
  t.assert.equal(stasisEdges['./state-util.js'], 'node_modules/@exodus/stasis-core/src/state-util.js',
    'state.js -> ./state-util.js must be in the bundle')

  // The user-reported case: config.js -> ./state-util.js was missing pre-fix.
  const configEdges = bundle.imports?.['node, import, module-sync, node-addons']?.['node_modules/@exodus/stasis-core/src/config.js']
  t.assert.ok(configEdges, 'config.js must have outgoing edges recorded')
  t.assert.equal(configEdges['./state-util.js'], 'node_modules/@exodus/stasis-core/src/state-util.js',
    'config.js -> ./state-util.js must be in the bundle (the user-reported missing edge)')

  // The version-shim chain must be captured too: state.js statically imports
  // ./package.cjs (a CJS re-export of package.json so reading the version survives
  // bundling), and package.cjs require()s ../package.json. The backfill recovers BOTH
  // edges and BOTH files (the `.cjs` and `require('../package.json')` arms), so a
  // self-import bundle stays complete rather than dangling a reference.
  t.assert.equal(stasisEdges['./package.cjs'], 'node_modules/@exodus/stasis-core/src/package.cjs',
    'state.js -> ./package.cjs (version shim) must be in the bundle')
  const cjsEdges = bundle.imports?.['node, import, module-sync, node-addons']?.['node_modules/@exodus/stasis-core/src/package.cjs']
  t.assert.ok(cjsEdges, 'package.cjs must have outgoing edges recorded')
  t.assert.equal(cjsEdges['../package.json'], 'node_modules/@exodus/stasis-core/package.json',
    'package.cjs -> ../package.json must be in the bundle')

  // The transitively-reachable internal files (config.js, state-util.js, bundle.js,
  // lockfile.js, util.js, brotli.js, the package.cjs version shim + package.json) must
  // all be captured.
  const stasisBucketFiles = Object.keys(bundle.modules['node_modules/@exodus/stasis-core'].files).toSorted()
  for (const expected of ['src/config.js', 'src/state.js', 'src/state-util.js', 'src/package.cjs', 'package.json']) {
    t.assert.ok(stasisBucketFiles.includes(expected),
      `stasis-core bucket must include ${expected} (transitively reachable from state.js); got ${stasisBucketFiles.join(', ')}`)
  }
}))

// Round-trip the captured bundle through bundle=load + lock=frozen. Pre-fix
// the bundle was missing stasis-core's content for any edge the imports map
// referenced; once that bundle is shipped to a clean machine and re-loaded,
// every check that consults the bundle for stasis-core's bytes would fail.
// Now that capture is complete, the round-trip must succeed.
test('bundle=load + lock=frozen round-trip across a stasis-core self-import', withTmp((t, tmp) => {
  setupProject(tmp)
  writeFileSync(join(tmp, 'entry.js'),
    "import { State } from '@exodus/stasis-core/state'\n" +
    "if (!State.preload) throw new Error('expected preload State')\n"
  )
  const bundlePath = join(tmp, 'snapshot.br')

  const cap = run(tmp, 'entry.js', {
    EXODUS_STASIS_LOCK: 'add',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'add',
    EXODUS_STASIS_BUNDLE_FILE: bundlePath,
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // Frozen re-run against the captured bundle + lockfile -- any missing-byte
  // attestation surfaces as a fail-closed throw. Pre-fix: state.js's content
  // wasn't in the bundle so this would reject.
  const replay = run(tmp, 'entry.js', {
    EXODUS_STASIS_LOCK: 'frozen',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'frozen',
    EXODUS_STASIS_BUNDLE_FILE: bundlePath,
  })
  t.assert.equal(replay.status, 0, `frozen replay stderr: ${replay.stderr}`)
}))

// A bundle missing stasis-core's bytes (the pre-fix shape) must fail-closed
// under bundle=frozen, NOT silently fall through to disk. This pins the
// upgrade-time gotcha the commit message calls out: a pre-fix bundle is
// structurally incomplete and a post-fix frozen run will refuse it.
test('bundle=frozen rejects a bundle missing stasis-core bytes for an attested edge', withTmp((t, tmp) => {
  setupProject(tmp)
  writeFileSync(join(tmp, 'entry.js'),
    "import { State } from '@exodus/stasis-core/state'\n" +
    "if (!State.preload) throw new Error('expected preload State')\n"
  )
  const bundlePath = join(tmp, 'snapshot.br')

  // Capture a complete bundle, then strip stasis-core's bucket out of it to
  // simulate the pre-fix shape (imports edge present, modules content absent).
  const cap = run(tmp, 'entry.js', {
    EXODUS_STASIS_LOCK: 'add',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'add',
    EXODUS_STASIS_BUNDLE_FILE: bundlePath,
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)).toString())
  t.assert.ok(decoded.modules['node_modules/@exodus/stasis-core'], 'sanity: bucket should be there before tamper')
  delete decoded.modules['node_modules/@exodus/stasis-core']
  // Drop the lockfile too, so the rejection comes from the frozen-bundle gate
  // (not from a lockfile attestation cross-check).
  rmSync(join(tmp, 'stasis.lock.json'))
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

  const r = run(tmp, 'entry.js', {
    EXODUS_STASIS_LOCK: 'none',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'frozen',
    EXODUS_STASIS_BUNDLE_FILE: bundlePath,
  })
  t.assert.notEqual(r.status, 0, 'frozen-bundle run must refuse a bundle missing referenced files')
}))
