import { test } from 'node:test'

import { Config, assertOptionsMatchConfig, validatePluginOptions } from '../src/config.js'

// Save/restore EXODUS_STASIS_* across tests so env-driven tests don't leak.
const ENV_KEYS = [
  'EXODUS_STASIS_SCOPE',
  'EXODUS_STASIS_LOCK',
  'EXODUS_STASIS_BUNDLE',
  'EXODUS_STASIS_BUNDLE_FILE',
  'EXODUS_STASIS_DEBUG',
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
  t.assert.throws(() => new Config({ lock: 'add', bundle: 'load' }), /bundle=load requires lock/)
  // valid combinations should not throw
  for (const lock of ['frozen', 'none', 'ignore']) {
    t.assert.ok(new Config({ lock, bundle: 'load' }))
  }
})

test('Config(options) enforces lock=none requires a bundle', (t) => {
  t.assert.throws(() => new Config({ lock: 'none' }), /lock=none requires bundle/)
  for (const bundle of ['add', 'replace', 'load', 'ignore']) {
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
    t.assert.throws(() => new Config({ lock: 'add' }), /Plugin options can not override stasis env/)
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
    t.assert.throws(() => new Config({ debug: true }), /Plugin options can not override stasis env/)
  }
))

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
