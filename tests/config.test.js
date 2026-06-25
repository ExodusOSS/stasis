import { test } from 'node:test'

import { Config, assertOptionsMatchConfig, validatePluginOptions } from '@exodus/stasis-core/config'

// Save/restore EXODUS_STASIS_* across tests so env-driven tests don't leak.
const ENV_KEYS = [
  'EXODUS_STASIS_SCOPE',
  'EXODUS_STASIS_LOCK',
  'EXODUS_STASIS_LOCK_FILE',
  'EXODUS_STASIS_BUNDLE',
  'EXODUS_STASIS_BUNDLE_FILE',
  'EXODUS_STASIS_RESOURCES_BUNDLE_FILE',
  'EXODUS_STASIS_RESOURCES',
  'EXODUS_STASIS_DEBUG',
  'EXODUS_STASIS_CHILD_PROCESS',
  'EXODUS_STASIS_FS',
]
const withEnv = (vars, fn) => (t) => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(vars)) process.env[k] = v
  try {
    return fn(t)
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const json = (obj) => JSON.stringify(obj)

test('Config defaults', (t) => {
  const c = new Config()
  t.assert.equal(c.scope, 'full')
  t.assert.equal(c.full, true)
  t.assert.equal(c.frozen, false)
  t.assert.equal(c.debug, false)
  t.assert.equal(c.bundle, false)
  t.assert.equal(c.ignoreBundle, false)
  t.assert.equal(c.writeBundle, false)
  t.assert.equal(c.replaceBundle, false)
  t.assert.equal(c.loadBundle, false)
  t.assert.equal(c.lock, 'add')
  t.assert.equal(c.writeLockfile, true)
  t.assert.equal(c.replaceLockfile, false)
  t.assert.deepEqual(c.values, { scope: 'full' })
})

test('Config json output has trailing newline and stable shape', (t) => {
  const c = new Config()
  const out = c.json
  t.assert.equal(out.at(-1), '\n')
  t.assert.deepEqual(JSON.parse(out), { scope: 'full', lock: 'add', bundle: 'none' })
})

test('loadConfig accepts empty object and keeps defaults', (t) => {
  const c = new Config()
  c.loadConfig('{}')
  t.assert.equal(c.scope, 'full')
  t.assert.equal(c.frozen, false)
  t.assert.equal(c.bundle, false)
})

test('loadConfig with scope=node_modules', (t) => {
  const c = new Config()
  c.loadConfig(json({ scope: 'node_modules' }))
  t.assert.equal(c.scope, 'node_modules')
  t.assert.equal(c.full, false)
  t.assert.deepEqual(c.values, { scope: 'node_modules' })
})

test('Config resources: option parses to a Set of extensions/filenames', (t) => {
  const c = new Config({ resources: ['.PNG', 'svg', 'LICENSE'] })
  t.assert.ok(c.resources instanceof Set)
  t.assert.deepEqual([...c.resources].toSorted(), ['license', 'png', 'svg'])
})

test('Config resources: empty by default and omitted from json', (t) => {
  const c = new Config()
  t.assert.equal(c.resources.size, 0)
  t.assert.equal(JSON.parse(c.json).resources, undefined, 'no resources key when empty')
})

test('Config resources: round-trips through json (sorted) and back via loadConfig', (t) => {
  const c = new Config({ resources: ['svg', 'png', 'LICENSE'] })
  t.assert.deepEqual(JSON.parse(c.json).resources, ['license', 'png', 'svg'])
  const c2 = new Config()
  c2.loadConfig(c.json)
  t.assert.deepEqual([...c2.resources].toSorted(), ['license', 'png', 'svg'])
})

test('Config resources: env var parses (comma-separated) and a matching option agrees', withEnv({ EXODUS_STASIS_RESOURCES: 'png, svg' }, (t) => {
  t.assert.deepEqual([...new Config().resources].toSorted(), ['png', 'svg'])
  t.assert.deepEqual([...new Config({ resources: ['svg', 'png'] }).resources].toSorted(), ['png', 'svg'])
}))

test('Config resources: an option conflicting with the env var throws', withEnv({ EXODUS_STASIS_RESOURCES: 'png' }, (t) => {
  t.assert.throws(() => new Config({ resources: ['png', 'svg'] }), /can not override stasis env/)
}))

test('Config resources: stasis.config.json conflicting with the env var throws', withEnv({ EXODUS_STASIS_RESOURCES: 'png' }, (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ resources: ['svg'] })), /can not override stasis\.config\.json/)
}))

test('Config resources: rejects a code extension', (t) => {
  t.assert.throws(() => new Config({ resources: ['js'] }), /is a code extension/)
})

test('loadConfig with lock=frozen', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'frozen' }))
  t.assert.equal(c.frozen, true)
  t.assert.equal(c.useLockfile, true)
  t.assert.equal(c.writeLockfile, false)
})

test('loadConfig with lock=none requires bundle non-none', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ lock: 'none' })), RangeError)
})

test('loadConfig with lock=none and bundle=add', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'none', bundle: 'add' }))
  t.assert.equal(c.lock, 'none')
  t.assert.equal(c.frozen, false)
  t.assert.equal(c.useLockfile, false)
  t.assert.equal(c.writeLockfile, false)
  t.assert.equal(c.writeBundle, true)
})

test('loadConfig with lock=none and bundle=load', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'none', bundle: 'load' }))
  t.assert.equal(c.lock, 'none')
  t.assert.equal(c.frozen, false)
  t.assert.equal(c.useLockfile, false)
  t.assert.equal(c.loadBundle, true)
})

test('loadConfig bundle=add -> writeBundle, bundle truthy, not replace', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'add' }))
  t.assert.equal(c.bundle, true)
  t.assert.equal(c.writeBundle, true)
  t.assert.equal(c.replaceBundle, false)
  t.assert.equal(c.loadBundle, false)
  t.assert.equal(c.ignoreBundle, false)
})

test('loadConfig bundle=replace -> writeBundle and replaceBundle', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'replace' }))
  t.assert.equal(c.bundle, true)
  t.assert.equal(c.writeBundle, true)
  t.assert.equal(c.replaceBundle, true)
  t.assert.equal(c.loadBundle, false)
})

test('loadConfig lock=replace -> writeLockfile and replaceLockfile', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'replace' }))
  t.assert.equal(c.lock, 'replace')
  t.assert.equal(c.useLockfile, true)
  t.assert.equal(c.writeLockfile, true)
  t.assert.equal(c.replaceLockfile, true)
  t.assert.equal(c.frozen, false)
})

test('loadConfig bundle=load rejects lock=add', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ bundle: 'load' })), RangeError)
})

test('loadConfig bundle=load rejects lock=replace', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ bundle: 'load', lock: 'replace' })), RangeError)
})

test('loadConfig bundle=load works with lock=frozen', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'load', lock: 'frozen' }))
  t.assert.equal(c.bundle, true)
  t.assert.equal(c.loadBundle, true)
  t.assert.equal(c.writeBundle, false)
  t.assert.equal(c.frozen, true)
})

test('loadConfig bundle=ignore', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'ignore' }))
  t.assert.equal(c.bundle, false)
  t.assert.equal(c.ignoreBundle, true)
  t.assert.equal(c.writeBundle, false)
  t.assert.equal(c.loadBundle, false)
})

test('loadConfig lock=ignore', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'ignore' }))
  t.assert.equal(c.lock, 'ignore')
  t.assert.equal(c.useLockfile, false)
  t.assert.equal(c.ignoreLockfile, true)
  t.assert.equal(c.writeLockfile, false)
  t.assert.equal(c.replaceLockfile, false)
  t.assert.equal(c.frozen, false)
})

test('loadConfig bundle=load works with lock=ignore', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'load', lock: 'ignore' }))
  t.assert.equal(c.loadBundle, true)
  t.assert.equal(c.ignoreLockfile, true)
})

test('loadConfig bundle=none', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'none' }))
  t.assert.equal(c.bundle, false)
  t.assert.equal(c.ignoreBundle, false)
})

test('loadConfig bundle=frozen -> frozenBundle, bundle truthy, never writes/loads/replaces', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'none', bundle: 'frozen' }))
  t.assert.equal(c.bundleMode, 'frozen')
  t.assert.equal(c.frozenBundle, true)
  t.assert.equal(c.bundle, true) // content is in play (addFile records + verifies)
  t.assert.equal(c.writeBundle, false) // frozen never rewrites the bundle
  t.assert.equal(c.loadBundle, false) // reads from disk, doesn't serve bundle bytes
  t.assert.equal(c.replaceBundle, false)
  t.assert.equal(c.ignoreBundle, false)
})

test('loadConfig bundle=frozen needs no lockfile: composes with lock=none', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'none', bundle: 'frozen' }))
  t.assert.equal(c.lock, 'none')
  t.assert.equal(c.useLockfile, false)
  t.assert.equal(c.frozenBundle, true)
})

test('loadConfig bundle=frozen composes with every lock mode (unlike load)', (t) => {
  for (const lock of ['none', 'ignore', 'add', 'replace', 'frozen']) {
    const c = new Config()
    c.loadConfig(json({ lock, bundle: 'frozen' }))
    t.assert.equal(c.frozenBundle, true)
    t.assert.equal(c.lock, lock)
  }
})

test('json reflects bundle=frozen', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'none', bundle: 'frozen' }))
  t.assert.deepEqual(JSON.parse(c.json), { scope: 'full', lock: 'none', bundle: 'frozen' })
})

test('loadConfig debug=true', (t) => {
  const c = new Config()
  c.loadConfig(json({ debug: true }))
  t.assert.equal(c.debug, true)
})

test('loadConfig rejects invalid scope', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ scope: 'whatever' })))
})

test('loadConfig rejects invalid lock', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ lock: 'thawed' })))
})

test('loadConfig rejects invalid bundle', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ bundle: 'maybe' })))
})

// --- resourcesBundleFile (split-bundle layout) ----------------------------------

test('resourcesBundleFile defaults to undefined', (t) => {
  const c = new Config({ bundle: 'add', bundleFile: '/tmp/code.br' })
  t.assert.equal(c.resourcesBundleFile, undefined)
})

test('resourcesBundleFile is exposed via the getter', (t) => {
  const c = new Config({ bundle: 'add', bundleFile: '/tmp/code.br', resourcesBundleFile: '/tmp/res.br' })
  t.assert.equal(c.resourcesBundleFile, '/tmp/res.br')
})

test('resourcesBundleFile picks up EXODUS_STASIS_RESOURCES_BUNDLE_FILE', withEnv(
  { EXODUS_STASIS_RESOURCES_BUNDLE_FILE: '/env/res.br' },
  (t) => {
    const c = new Config({ bundle: 'add', bundleFile: '/tmp/code.br' })
    t.assert.equal(c.resourcesBundleFile, '/env/res.br')
  }))

test('env and option must agree on resourcesBundleFile', withEnv(
  { EXODUS_STASIS_RESOURCES_BUNDLE_FILE: '/env/res.br' },
  (t) => {
    t.assert.throws(() => new Config({ bundle: 'add', bundleFile: '/tmp/code.br', resourcesBundleFile: '/other/res.br' }),
      /Config options can not override stasis env/)
  }))

test('resourcesBundleFile requires an active bundle mode', (t) => {
  // Default bundle is 'none' -- the split is silently inert there, so refuse the misconfig.
  t.assert.throws(() => new Config({ lock: 'add', resourcesBundleFile: '/tmp/res.br' }),
    /resourcesBundleFile requires an active bundle mode/)
  t.assert.throws(() => new Config({ lock: 'add', bundle: 'ignore', resourcesBundleFile: '/tmp/res.br' }),
    /resourcesBundleFile requires an active bundle mode/)
})

test('resourcesBundleFile must differ from bundleFile (raw same path)', (t) => {
  t.assert.throws(() => new Config({ bundle: 'add', bundleFile: '/tmp/x.br', resourcesBundleFile: '/tmp/x.br' }),
    /resourcesBundleFile '\/tmp\/x\.br' targets the same file as bundleFile/)
})

test('resourcesBundleFile must differ from bundleFile (path normalization: ./x vs x)', (t) => {
  // Lexically-different but canonically-same paths must collide. The Config-level
  // canonicalization (resolve() + realpathSync) closes the silent-clobber on write.
  t.assert.throws(() => new Config({
    bundle: 'add',
    bundleFile: '/tmp/sub/x.br',
    resourcesBundleFile: '/tmp/sub/./x.br',
  }), /targets the same file as bundleFile/)
})

test('lockFile must differ from bundleFile and resourcesBundleFile', (t) => {
  // Without this check, State.write() would emit brotli bundle bytes to the same path
  // as the JSON lockfile -- the bundle write happens second, silently clobbering the
  // lockfile under lock=add + bundle=add.
  t.assert.throws(() => new Config({
    lock: 'add', lockFile: '/tmp/x.br',
    bundle: 'add', bundleFile: '/tmp/x.br',
  }), /bundleFile '\/tmp\/x\.br' targets the same file as lockFile/)
  t.assert.throws(() => new Config({
    lock: 'add', lockFile: '/tmp/x.br',
    bundle: 'add', bundleFile: '/tmp/y.br', resourcesBundleFile: '/tmp/x.br',
  }), /resourcesBundleFile '\/tmp\/x\.br' targets the same file as lockFile/)
})

test('validatePluginOptions accepts resourcesBundleFile, rejects non-string', (t) => {
  t.assert.doesNotThrow(() => validatePluginOptions('Plug', { resourcesBundleFile: '/tmp/r.br' }))
  t.assert.throws(() => validatePluginOptions('Plug', { resourcesBundleFile: 42 }),
    /resourcesBundleFile must be a string/)
})

test('assertOptionsMatchConfig catches a resourcesBundleFile mismatch with the active Config', (t) => {
  const c = new Config({ bundle: 'add', bundleFile: '/tmp/code.br', resourcesBundleFile: '/tmp/res.br' })
  t.assert.doesNotThrow(() => assertOptionsMatchConfig(c, { resourcesBundleFile: '/tmp/res.br' }))
  t.assert.throws(() => assertOptionsMatchConfig(c, { resourcesBundleFile: '/tmp/other.br' }),
    /Plugin options conflict with active stasis state/)
})

// --- lockFile (independent-lockfile layout) -------------------------------------

test('lockFile defaults to undefined', (t) => {
  const c = new Config({ lock: 'add' })
  t.assert.equal(c.lockFile, undefined)
})

test('lockFile is exposed via the getter', (t) => {
  const c = new Config({ lock: 'add', lockFile: '/tmp/my.lock.json' })
  t.assert.equal(c.lockFile, '/tmp/my.lock.json')
})

test('lockFile picks up EXODUS_STASIS_LOCK_FILE', withEnv(
  { EXODUS_STASIS_LOCK_FILE: '/env/my.lock.json' },
  (t) => {
    const c = new Config({ lock: 'add' })
    t.assert.equal(c.lockFile, '/env/my.lock.json')
  }))

test('env and option must agree on lockFile', withEnv(
  { EXODUS_STASIS_LOCK_FILE: '/env/my.lock.json' },
  (t) => {
    t.assert.throws(() => new Config({ lock: 'add', lockFile: '/other/my.lock.json' }),
      /Config options can not override stasis env/)
  }))

test('lockFile requires an active lock mode', (t) => {
  // bundle=load + lock=none is otherwise valid; lockFile on top makes no sense.
  t.assert.throws(() => new Config({ lock: 'none', bundle: 'load', bundleFile: '/tmp/x.br', lockFile: '/tmp/my.lock.json' }),
    /lockFile requires an active lock mode/)
  t.assert.throws(() => new Config({ lock: 'ignore', lockFile: '/tmp/my.lock.json' }),
    /lockFile requires an active lock mode/)
})

test('validatePluginOptions rejects lockFile (not a plugin option; the lockfile is always shared)', (t) => {
  // lockFile was removed as a plugin option: a plugin shares the ambient stasis lockfile
  // and can never point at its own (the path stays a Config/CLI/env concern). It is now
  // just an unknown plugin option, caught by the generic check regardless of its type.
  t.assert.throws(() => validatePluginOptions('Plug', { lockFile: '/tmp/my.lock.json' }),
    /Unknown Plug options: lockFile/)
  t.assert.throws(() => validatePluginOptions('Plug', { lockFile: 42 }),
    /Unknown Plug options: lockFile/)
})

test('assertOptionsMatchConfig catches an option mismatch with the active Config', (t) => {
  const c = new Config({ lock: 'add', lockFile: '/tmp/my.lock.json' })
  t.assert.doesNotThrow(() => assertOptionsMatchConfig(c, { lock: 'add' }))
  t.assert.throws(() => assertOptionsMatchConfig(c, { lock: 'frozen' }),
    /Plugin options conflict with active stasis state/)
})

test('loadConfig rejects non-boolean debug', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ debug: 1 })))
  t.assert.throws(() => c.loadConfig(json({ debug: 'true' })))
})

test('loadConfig rejects unknown keys', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ extra: 1 })))
})

test('loadConfig rejects malformed JSON', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig('not json'))
})

test('json reflects loaded values', (t) => {
  const c = new Config()
  c.loadConfig(json({ scope: 'node_modules', lock: 'frozen', bundle: 'load' }))
  t.assert.deepEqual(JSON.parse(c.json), {
    scope: 'node_modules',
    lock: 'frozen',
    bundle: 'load',
  })
})

test('json reflects replace modes', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'replace', bundle: 'replace' }))
  t.assert.deepEqual(JSON.parse(c.json), {
    scope: 'full',
    lock: 'replace',
    bundle: 'replace',
  })
})

test('loadConfig can be called twice and applies the latest values', (t) => {
  const c = new Config()
  c.loadConfig(json({ scope: 'node_modules' }))
  t.assert.equal(c.scope, 'node_modules')
  c.loadConfig(json({ scope: 'full' }))
  t.assert.equal(c.scope, 'full')
})

// Constructor-options coverage. Each option is consumed by the constructor and surfaces on
// the getters in the same way a stasis.config.json value would after loadConfig.

test('Config(options) sets scope', (t) => {
  const c = new Config({ scope: 'node_modules' })
  t.assert.equal(c.scope, 'node_modules')
  t.assert.equal(c.full, false)
})

test('Config(options) sets lock', (t) => {
  const c = new Config({ lock: 'frozen' })
  t.assert.equal(c.lock, 'frozen')
  t.assert.equal(c.frozen, true)
  t.assert.equal(c.useLockfile, true)
})

test('Config(options) sets bundle and exposes bundleMode', (t) => {
  const c = new Config({ lock: 'frozen', bundle: 'load' })
  t.assert.equal(c.bundleMode, 'load')
  t.assert.equal(c.loadBundle, true)
  t.assert.equal(c.bundle, true)
})

test('Config(options) sets bundle=frozen and exposes frozenBundle', (t) => {
  const c = new Config({ lock: 'none', bundle: 'frozen' })
  t.assert.equal(c.bundleMode, 'frozen')
  t.assert.equal(c.frozenBundle, true)
  t.assert.equal(c.bundle, true)
  t.assert.equal(c.writeBundle, false)
})

test('Config(options) sets bundleFile', (t) => {
  const c = new Config({ bundleFile: '/tmp/snapshot.br' })
  t.assert.equal(c.bundleFile, '/tmp/snapshot.br')
})

test('Config(options) sets debug', (t) => {
  const c = new Config({ debug: true })
  t.assert.equal(c.debug, true)
})

test('Config(options) rejects unknown keys', (t) => {
  t.assert.throws(() => new Config({ bogus: 'x' }), /Unknown Config options/)
})

test('Config(options) rejects invalid scope', (t) => {
  t.assert.throws(() => new Config({ scope: 'bogus' }), /Invalid scope/)
})

test('Config(options) rejects invalid lock', (t) => {
  t.assert.throws(() => new Config({ lock: 'bogus' }), /Invalid lock/)
})

test('Config(options) rejects invalid bundle', (t) => {
  t.assert.throws(() => new Config({ bundle: 'bogus' }), /Invalid bundle/)
})

test('Config(options) rejects non-string bundleFile', (t) => {
  t.assert.throws(() => new Config({ bundleFile: 42 }), /bundleFile must be a string/)
})

test('Config(options) rejects non-boolean debug', (t) => {
  t.assert.throws(() => new Config({ debug: 'yes' }), /debug must be a boolean/)
})

test('Config(options) enforces bundle=load requires frozen|none|ignore lock', (t) => {
  t.assert.throws(() => new Config({ lock: 'add', bundle: 'load' }), /bundle=load is incompatible with lock/)
  // valid combinations should not throw
  for (const lock of ['frozen', 'none', 'ignore']) {
    t.assert.ok(new Config({ lock, bundle: 'load' }))
  }
})

test('Config(options) enforces lock=none requires a bundle', (t) => {
  t.assert.throws(() => new Config({ lock: 'none' }), /needs a lockfile or a bundle/)
  for (const bundle of ['add', 'replace', 'load', 'frozen', 'ignore']) {
    t.assert.ok(new Config({ lock: 'none', bundle }))
  }
})

// Env coverage. The constructor reads EXODUS_STASIS_* at construction time; options that
// disagree must throw, and matching options are accepted.

test('Config reads env vars at construction time', withEnv(
  { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
  (t) => {
    const c = new Config()
    t.assert.equal(c.lock, 'frozen')
    t.assert.equal(c.scope, 'node_modules')
  }
))

test('Config rejects options that conflict with env', withEnv(
  { EXODUS_STASIS_LOCK: 'frozen' },
  (t) => {
    t.assert.throws(() => new Config({ lock: 'add' }), /Config options can not override stasis env/)
  }
))

test('Config accepts options that agree with env', withEnv(
  { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
  (t) => {
    const c = new Config({ lock: 'frozen', scope: 'node_modules' })
    t.assert.equal(c.lock, 'frozen')
    t.assert.equal(c.scope, 'node_modules')
  }
))

test('Config debug env "0" is falsy', withEnv(
  { EXODUS_STASIS_DEBUG: '0' },
  (t) => { t.assert.equal(new Config().debug, false) }
))

test('Config debug env "1" is true', withEnv(
  { EXODUS_STASIS_DEBUG: '1' },
  (t) => { t.assert.equal(new Config().debug, true) }
))

test('Config debug=true option conflicts with env debug=0', withEnv(
  { EXODUS_STASIS_DEBUG: '0' },
  (t) => {
    t.assert.throws(() => new Config({ debug: true }), /Config options can not override stasis env/)
  }
))

// childProcess mirrors debug: a boolean, env EXODUS_STASIS_CHILD_PROCESS, not serialized. These
// pin the validation/parse/conflict paths the --child-process feature added across Config's surface
// (previously covered end-to-end via the CLI/metro suites, but never at the Config unit level).
test('loadConfig rejects non-boolean childProcess', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ childProcess: 1 })), /childProcess must be a boolean/)
  t.assert.throws(() => c.loadConfig(json({ childProcess: 'true' })), /childProcess must be a boolean/)
})

test('loadConfig childProcess=true', (t) => {
  const c = new Config()
  c.loadConfig(json({ childProcess: true }))
  t.assert.equal(c.childProcess, true)
})

test('Config(options) sets childProcess', (t) => {
  t.assert.equal(new Config({ childProcess: true }).childProcess, true)
})

test('Config defaults childProcess to false', (t) => {
  t.assert.equal(new Config().childProcess, false)
})

test('Config(options) rejects non-boolean childProcess', (t) => {
  t.assert.throws(() => new Config({ childProcess: 'yes' }), /childProcess must be a boolean/)
})

test('validatePluginOptions rejects non-boolean childProcess', (t) => {
  t.assert.throws(() => validatePluginOptions('StasisFoo', { childProcess: 1 }), /childProcess must be a boolean/)
})

test('Config childProcess env "0" is falsy', withEnv(
  { EXODUS_STASIS_CHILD_PROCESS: '0' },
  (t) => { t.assert.equal(new Config().childProcess, false) }
))

test('Config childProcess env "1" is true', withEnv(
  { EXODUS_STASIS_CHILD_PROCESS: '1' },
  (t) => { t.assert.equal(new Config().childProcess, true) }
))

test('Config childProcess=true option conflicts with env childProcess=0', withEnv(
  { EXODUS_STASIS_CHILD_PROCESS: '0' },
  (t) => {
    t.assert.throws(() => new Config({ childProcess: true }), /Config options can not override stasis env/)
  }
))

// fs mirrors lock/bundle: a 'sync'|'async' enum read from --fs / EXODUS_STASIS_FS / "fs" in
// stasis.config.json, requiring an active read/write bundle mode (add|replace|load), and -- like
// debug/childProcess -- NOT serialized. The runtime loader installs the fs reader patches from
// config.fs on State init. Like lockFile, it's a loader/CLI concern, not a plugin option.
test('Config defaults fs to undefined', (t) => {
  t.assert.equal(new Config().fs, undefined)
})

test('Config(options) sets fs=sync (requires a bundle mode)', (t) => {
  t.assert.equal(new Config({ bundle: 'add', fs: 'sync' }).fs, 'sync')
})

test('Config(options) sets fs=async', (t) => {
  t.assert.equal(new Config({ bundle: 'load', lock: 'frozen', fs: 'async' }).fs, 'async')
})

test('Config(options) rejects invalid fs', (t) => {
  t.assert.throws(() => new Config({ bundle: 'add', fs: 'maybe' }), /Invalid fs: maybe/)
})

test('Config(options) fs requires bundle=(add|replace|load)', (t) => {
  // default bundle is 'none'; 'ignore'/'frozen' likewise have nothing to capture into / serve from.
  for (const bundle of [undefined, 'none', 'ignore', 'frozen']) {
    t.assert.throws(() => new Config({ lock: 'add', ...(bundle && { bundle }), fs: 'sync' }),
      /fs requires bundle=\(add\|replace\|load\)/)
  }
  // the three read/write bundle modes are accepted
  t.assert.equal(new Config({ bundle: 'add', fs: 'sync' }).fs, 'sync')
  t.assert.equal(new Config({ bundle: 'replace', fs: 'sync' }).fs, 'sync')
  t.assert.equal(new Config({ lock: 'frozen', bundle: 'load', fs: 'sync' }).fs, 'sync')
})

test('loadConfig fs=sync', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'add', fs: 'sync' }))
  t.assert.equal(c.fs, 'sync')
})

test('loadConfig fs=async', (t) => {
  const c = new Config()
  c.loadConfig(json({ lock: 'frozen', bundle: 'load', fs: 'async' }))
  t.assert.equal(c.fs, 'async')
})

test('loadConfig rejects invalid fs', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ bundle: 'add', fs: 'maybe' })), /Invalid fs: maybe/)
})

test('loadConfig fs requires an active read/write bundle mode', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ fs: 'sync' })), /fs requires bundle=\(add\|replace\|load\)/)
  t.assert.throws(() => c.loadConfig(json({ lock: 'none', bundle: 'frozen', fs: 'sync' })),
    /fs requires bundle=\(add\|replace\|load\)/)
})

test('fs is not serialized into json (a how-to-run flag, like debug/childProcess)', (t) => {
  const c = new Config({ bundle: 'add', fs: 'async' })
  t.assert.equal(JSON.parse(c.json).fs, undefined, 'no fs key in the serialized config')
})

test('Config reads EXODUS_STASIS_FS at construction time', withEnv(
  { EXODUS_STASIS_FS: 'async', EXODUS_STASIS_BUNDLE: 'add' },
  (t) => { t.assert.equal(new Config().fs, 'async') }
))

test('Config fs option conflicting with the env var throws', withEnv(
  { EXODUS_STASIS_FS: 'sync', EXODUS_STASIS_BUNDLE: 'add' },
  (t) => {
    t.assert.throws(() => new Config({ fs: 'async' }), /Config options can not override stasis env/)
  }
))

test('Config fs option agreeing with the env var is accepted', withEnv(
  { EXODUS_STASIS_FS: 'sync', EXODUS_STASIS_BUNDLE: 'add' },
  (t) => { t.assert.equal(new Config({ fs: 'sync' }).fs, 'sync') }
))

test('Config fs: stasis.config.json conflicting with the env var throws', withEnv(
  { EXODUS_STASIS_FS: 'sync', EXODUS_STASIS_BUNDLE: 'add' },
  (t) => {
    const c = new Config()
    t.assert.throws(() => c.loadConfig(json({ fs: 'async' })), /can not override stasis\.config\.json/)
  }
))

test('loadConfig keeps an env-set fs when the file omits the key', withEnv(
  { EXODUS_STASIS_FS: 'sync', EXODUS_STASIS_BUNDLE: 'add' },
  (t) => {
    // The interaction the feature enables: --fs/env set the mode, a stasis.config.json without
    // an `fs` key must preserve it (fs = this.#fs default) and the env cross-check must still pass.
    const c = new Config()
    t.assert.equal(c.fs, 'sync')
    c.loadConfig(json({ scope: 'node_modules' }))
    t.assert.equal(c.fs, 'sync', 'env-set fs survives a config load that omits it')
    t.assert.equal(c.scope, 'node_modules')
  }
))

test('loadConfig fs agreeing with the constructor option is accepted', (t) => {
  // Exercises the explicit-option cross-check's pass branch (config agrees with new Config({fs})).
  const c = new Config({ bundle: 'add', fs: 'sync' })
  c.loadConfig(json({ fs: 'sync' }))
  t.assert.equal(c.fs, 'sync')
})

test('validatePluginOptions rejects fs (not a plugin option; --fs is a loader/CLI concern)', (t) => {
  // Like lockFile: the fs reader patches are a `stasis run` loader feature, never a plugin's to
  // set, so fs is an unknown plugin option caught by the generic check regardless of its value.
  t.assert.throws(() => validatePluginOptions('Plug', { fs: 'sync' }), /Unknown Plug options: fs/)
  t.assert.throws(() => validatePluginOptions('Plug', { fs: 42 }), /Unknown Plug options: fs/)
})

// validatePluginOptions: standalone helper for plugin constructors. Mirrors Config's per-field
// validation without side effects.

test('validatePluginOptions accepts an empty object', () => {
  validatePluginOptions('Test', {})
})

test('validatePluginOptions accepts every supported key', () => {
  validatePluginOptions('Test', {
    scope: 'node_modules',
    lock: 'frozen',
    bundle: 'load',
    bundleFile: '/tmp/x.br',
    debug: true,
  })
})

test('validatePluginOptions accepts bundle=frozen', () => {
  validatePluginOptions('Test', { bundle: 'frozen' })
})

test('validatePluginOptions rejects unknown keys with the label', (t) => {
  t.assert.throws(() => validatePluginOptions('StasisFoo', { bogus: 1 }), /Unknown StasisFoo options: bogus/)
})

test('validatePluginOptions rejects invalid scope/lock/bundle', (t) => {
  t.assert.throws(() => validatePluginOptions('T', { scope: 'bogus' }), /Invalid scope/)
  t.assert.throws(() => validatePluginOptions('T', { lock: 'bogus' }), /Invalid lock/)
  t.assert.throws(() => validatePluginOptions('T', { bundle: 'bogus' }), /Invalid bundle/)
})

test('validatePluginOptions rejects wrong-typed bundleFile/debug', (t) => {
  t.assert.throws(() => validatePluginOptions('T', { bundleFile: 1 }), /bundleFile must be a string/)
  t.assert.throws(() => validatePluginOptions('T', { debug: 'yes' }), /debug must be a boolean/)
})

// assertOptionsMatchConfig: compares plugin-provided options against an already-constructed
// Config and surfaces disagreements with a stable wrapper error.

test('assertOptionsMatchConfig accepts when every provided option matches', () => {
  const c = new Config({ lock: 'frozen', bundle: 'load', scope: 'node_modules', bundleFile: '/x', debug: true })
  assertOptionsMatchConfig(c, { lock: 'frozen', bundle: 'load' })
  assertOptionsMatchConfig(c, { scope: 'node_modules', bundleFile: '/x', debug: true })
})

test('assertOptionsMatchConfig accepts empty options', () => {
  const c = new Config({ lock: 'frozen' })
  assertOptionsMatchConfig(c, {})
})

test('assertOptionsMatchConfig wraps a lock mismatch', (t) => {
  const c = new Config({ lock: 'frozen' })
  t.assert.throws(
    () => assertOptionsMatchConfig(c, { lock: 'add' }),
    /Plugin options conflict with active stasis state/
  )
})

test('assertOptionsMatchConfig wraps a bundle/scope/bundleFile/debug mismatch', (t) => {
  const c = new Config({ lock: 'frozen', bundle: 'load', scope: 'node_modules', bundleFile: '/x', debug: true })
  for (const opt of [
    { bundle: 'add' },
    { scope: 'full' },
    { bundleFile: '/y' },
    { debug: false },
  ]) {
    t.assert.throws(
      () => assertOptionsMatchConfig(c, opt),
      /Plugin options conflict with active stasis state/
    )
  }
})
