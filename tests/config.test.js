import { test } from 'node:test'

import { Config } from '../src/config.js'

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
  t.assert.equal(c.loadBundle, false)
  t.assert.deepEqual(c.values, { scope: 'full' })
})

test('Config json output has trailing newline and stable shape', (t) => {
  const c = new Config()
  const out = c.json
  t.assert.equal(out.at(-1), '\n')
  t.assert.deepEqual(JSON.parse(out), { scope: 'full', mode: 'update', bundle: 'none' })
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

test('loadConfig with mode=frozen', (t) => {
  const c = new Config()
  c.loadConfig(json({ mode: 'frozen' }))
  t.assert.equal(c.frozen, true)
})

test('loadConfig bundle=save -> writeBundle, bundle truthy', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'save' }))
  t.assert.equal(c.bundle, true)
  t.assert.equal(c.writeBundle, true)
  t.assert.equal(c.loadBundle, false)
  t.assert.equal(c.ignoreBundle, false)
})

test('loadConfig bundle=load requires mode=frozen', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ bundle: 'load' })), RangeError)
})

test('loadConfig bundle=load works with mode=frozen', (t) => {
  const c = new Config()
  c.loadConfig(json({ bundle: 'load', mode: 'frozen' }))
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

test('loadConfig rejects invalid mode', (t) => {
  const c = new Config()
  t.assert.throws(() => c.loadConfig(json({ mode: 'thawed' })))
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
  c.loadConfig(json({ scope: 'node_modules', mode: 'frozen', bundle: 'load' }))
  t.assert.deepEqual(JSON.parse(c.json), {
    scope: 'node_modules',
    mode: 'frozen',
    bundle: 'load',
  })
})

test('loadConfig can be called twice and applies the latest values', (t) => {
  const c = new Config()
  c.loadConfig(json({ scope: 'node_modules' }))
  t.assert.equal(c.scope, 'node_modules')
  c.loadConfig(json({ scope: 'full' }))
  t.assert.equal(c.scope, 'full')
})
