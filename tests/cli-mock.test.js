import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-run-effects')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_RESOURCES_BUNDLE_FILE: _rbf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, ...opts })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// Async-aware: the cli.test.js withTmp drops `await` and would wipe the dir
// before an async body resolves.
const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-mock-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('run --mock denies fs/child_process/network side-effects (fail closed) while capturing the import graph', withTmp((t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const bundlePath = join(tmp, 'snapshot.br')
  // Sentinel lives *outside* the project's allowed-write tree: writes inside cwd
  // are intentionally permitted (that's where the bundle/lockfile go).
  // Two sentinels exercise the two deny layers independently:
  //  - outside-cwd: the kernel layer (--permission) blocks writeFileSync; the
  //    JS fs mock also blocks but the kernel wins by going first.
  //  - inside-cwd: cwd is on --allow-fs-write so the kernel allows the write.
  //    Only the JS denyFnAsync mock prevents writeFileAsync from landing.
  //    A broken JS layer would silently no-op (file absent) OR crash the run
  //    (status != 0) -- the assertions below catch both modes.
  const sentinel = join(dirname(tmp), `mock-test-sentinel-${process.pid}.txt`)
  const incwdSentinel = join(tmp, 'incwd-sentinel.txt')
  rmSync(sentinel, { force: true })

  const r = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, '--mock', 'src/entry.js'],
    {
      cwd: tmp,
      env: {
        ...cleanEnv,
        STASIS_MOCK_SENTINEL: sentinel,
        STASIS_MOCK_INCWD_SENTINEL: incwdSentinel,
      },
    }
  )
  // status 0 also proves the unhandledRejection trap swallowed the fire-and-forget
  // `void fetch(beacon)` denial -- otherwise the run would crash before exit.
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stderr, /mock: true/)

  // JS-mock fs layer: the destructured `import { writeFileSync }` snapshot in
  // user code resolves to the mock (loader-mock.js refreshed the ESM wrapper via
  // syncBuiltinESMExports after mock mutated the CJS object). --permission is
  // still on as defense in depth -- it would also deny the same write.
  t.assert.match(r.stdout, /fs-destructured blocked ERR_STASIS_MOCK_BLOCKED/)
  // child_process and worker_threads are denied at BOTH layers (--permission
  // and JS mock) as defense in depth. The JS mock fires first, so the user
  // sees the clean attributable error code rather than the kernel's
  // ERR_ACCESS_DENIED.
  t.assert.match(r.stdout, /spawn blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /worker blocked ERR_STASIS_MOCK_BLOCKED/)
  // JS-mock network: every callable on http/https/http2/net/dgram/tls/dns
  // is a thrower, so factory, constructor, and connection paths all surface
  // the same attributable error code.
  t.assert.match(r.stdout, /http blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /net blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.match(r.stdout, /ws blocked ERR_STASIS_MOCK_BLOCKED/)
  // process method denials (chdir is selected by the fixture; mock.js also
  // covers kill/umask/dlopen/setUid/...).
  t.assert.match(r.stdout, /chdir blocked ERR_STASIS_MOCK_BLOCKED/)
  t.assert.doesNotMatch(r.stdout, /NOT BLOCKED/)
  // Sanity: user code ran up to the never-resolving timer await...
  t.assert.match(r.stdout, /hello, world/)
  // ...and nothing past the await printed (the awaiter is silently ignored,
  // the loader's beforeExit still writes the bundle when the loop drains).
  t.assert.doesNotMatch(r.stdout, /UNREACHABLE/)

  t.assert.ok(!existsSync(sentinel), 'fs write outside cwd must be blocked')
  // The JS-only layer's job: cwd is kernel-allowed, so this sentinel's
  // absence proves the denyFnAsync mock (not --permission) caught the write.
  t.assert.ok(!existsSync(incwdSentinel), 'JS fs/promises mock must block writes even when --allow-fs-write would permit them')

  // The import graph is captured despite every side effect being denied.
  t.assert.ok(existsSync(bundlePath), 'bundle should be written by stasis (allowed path)')
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  t.assert.deepEqual(decoded.entries, ['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/entry.js'])
  t.assert.ok(decoded.sources['.'].files['src/hello.js'])
  t.assert.equal(decoded.formats['src/entry.js'], 'module')
  t.assert.equal(decoded.formats['src/hello.js'], 'module')
  // The runtime loader keys imports by a conditions string, not "*"; assert the
  // entry->hello edge was captured regardless of which conditions key holds it.
  const captured = Object.values(decoded.imports)
    .some((m) => m['src/entry.js']?.['./hello.js'] === 'src/hello.js')
  t.assert.ok(captured, 'import edge src/entry.js -> ./hello.js must be captured')
}))

test('run --mock with --bundle=load is rejected (mock is for capture, not replay)', (t) => {
  const r = run(['run', '--lock=frozen', '--bundle=load', '--bundle-file=/tmp/x.br', '--mock', 'a.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--mock is for capturing imports/)
})

test('run --mock refuses a --bundle-file whose ancestors do not exist', (t) => {
  // Granting --allow-fs-write for an ancestor walk that terminates at "/"
  // would effectively disable --permission for the whole filesystem. Refuse
  // instead and ask the user to pre-create a parent.
  const r = run([
    'run', '--lock=frozen', '--bundle=add',
    '--bundle-file=/zzz-no-such-toplevel-9999/foo.br', '--mock', 'a.js',
  ])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /no existing parent directory for --bundle-file/)
})

test('run --mock refuses a --resources-bundle-file whose ancestors do not exist', (t) => {
  // The dual-target write-grant loop must walk the *resources* target too (not just
  // --bundle-file) and name the offending flag correctly in the refusal. --bundle-file
  // here has an existing parent (/tmp) so the loop reaches and rejects the resources arg.
  const r = run([
    'run', '--lock=frozen', '--bundle=add',
    '--bundle-file=/tmp/stasis-mock-code.br',
    '--resources-bundle-file=/zzz-no-such-toplevel-9998/res.br', '--mock', 'a.js',
  ])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /no existing parent directory for --resources-bundle-file/)
})

test('run --mock writes a --bundle-file under a not-yet-existing directory outside cwd', withTmp(async (t, tmp) => {
  // Regression: --allow-fs-write needs an *existing* path; granting just the
  // bundle file's own path isn't enough when state.write()'s mkdirSync has
  // to create the parent chain. bin/stasis.js walks up to the nearest
  // existing ancestor.
  cpSync(fixture, tmp, { recursive: true })
  const outside = join(dirname(tmp), `stasis-mock-outside-${process.pid}`)
  rmSync(outside, { recursive: true, force: true })
  const bundlePath = join(outside, 'nested', 'dir', 'snap.br')
  const sentinel = join(dirname(tmp), `mock-sentinel-${process.pid}.txt`)

  const r = run(
    ['run', '--lock=none', '--bundle=add', `--bundle-file=${bundlePath}`, '--mock', 'src/entry.js'],
    { cwd: tmp, env: { ...cleanEnv, STASIS_MOCK_SENTINEL: sentinel } }
  )
  try {
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath), 'bundle should be written under the freshly-created parent dirs')
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(sentinel, { force: true })
  }
}))
