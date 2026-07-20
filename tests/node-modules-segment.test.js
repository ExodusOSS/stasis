// Unit tests for the segment-aware node_modules classification (stasis-core/util): a bucket lives
// under node_modules only when `node_modules` is a full path SEGMENT, never a bare substring like
// `foo_node_modules`. `splitNodeModulesPath` (bucket derivation) and `hasNodeModulesSegment` (the
// shared includes()-replacement gate) must agree on genuine paths and both reject the impostor.

import { test } from 'node:test'

import { hasNodeModulesSegment, splitNodeModulesPath } from '@exodus/stasis-core/util'

test('splitNodeModulesPath: a `foo_node_modules` prefix is NOT a dependency (segment, not substring)', (t) => {
  // The bug: lastIndexOf('node_modules/') matched inside `foo_node_modules/`, bucketing a source
  // file as the phantom dependency `foo_node_modules/dep`. It must classify as not-a-dependency.
  t.assert.equal(splitNodeModulesPath('foo_node_modules/dep/index.js'), null)
  t.assert.equal(splitNodeModulesPath('foo_node_modules/@scope/pkg/index.js'), null)
  t.assert.equal(splitNodeModulesPath('a/foo_node_modules/dep/index.js'), null)
  t.assert.equal(splitNodeModulesPath('node_modules_backup/dep/index.js'), null)
})

test('splitNodeModulesPath: genuine node_modules paths still split into the right bucket', (t) => {
  t.assert.deepEqual(splitNodeModulesPath('node_modules/dep/index.js'),
    { dir: 'node_modules/dep', rel: 'index.js', name: 'dep' })
  t.assert.deepEqual(splitNodeModulesPath('a/node_modules/dep/index.js'),
    { dir: 'a/node_modules/dep', rel: 'index.js', name: 'dep' })
  t.assert.deepEqual(splitNodeModulesPath('node_modules/dep/lib/nested/file.js'),
    { dir: 'node_modules/dep', rel: 'lib/nested/file.js', name: 'dep' })
})

test('splitNodeModulesPath: scoped packages keep the two-segment name', (t) => {
  t.assert.deepEqual(splitNodeModulesPath('node_modules/@scope/pkg/index.js'),
    { dir: 'node_modules/@scope/pkg', rel: 'index.js', name: '@scope/pkg' })
  t.assert.deepEqual(splitNodeModulesPath('a/node_modules/@scope/pkg/lib/x.js'),
    { dir: 'a/node_modules/@scope/pkg', rel: 'lib/x.js', name: '@scope/pkg' })
})

test('splitNodeModulesPath: nested node_modules resolves to the DEEPEST segment-aligned marker', (t) => {
  t.assert.deepEqual(splitNodeModulesPath('node_modules/a/node_modules/b/c.js'),
    { dir: 'node_modules/a/node_modules/b', rel: 'c.js', name: 'b' })
  // A `foo_node_modules` deeper than a real one is ignored; the file belongs to package `a`, with
  // the impostor directory living inside `a` as part of `rel`.
  t.assert.deepEqual(splitNodeModulesPath('node_modules/a/foo_node_modules/b/c.js'),
    { dir: 'node_modules/a', rel: 'foo_node_modules/b/c.js', name: 'a' })
})

test('splitNodeModulesPath: not-a-dependency shapes return null (unchanged)', (t) => {
  t.assert.equal(splitNodeModulesPath('src/index.js'), null)
  t.assert.equal(splitNodeModulesPath('packages/lib/index.js'), null)
  // A bare package root (marker present but no rel component) is not a splittable file path.
  t.assert.equal(splitNodeModulesPath('node_modules/dep'), null)
  // An empty package-name segment (`node_modules//x`) is rejected.
  t.assert.equal(splitNodeModulesPath('node_modules//x'), null)
})

test('hasNodeModulesSegment: true only when node_modules is a full path segment', (t) => {
  for (const p of [
    'node_modules',
    'node_modules/dep',
    'a/node_modules/dep',
    'node_modules/@scope/pkg',
    'a/node_modules/b/node_modules/c',
    'packages/x/node_modules/dep',
  ]) {
    t.assert.equal(hasNodeModulesSegment(p), true, p)
  }
})

test('hasNodeModulesSegment: false for bare-substring impostors and plain sources', (t) => {
  for (const p of [
    'foo_node_modules',
    'foo_node_modules/dep',
    'node_modules_backup/dep',
    'src/node_modulesx/y',
    'packages/foo',
    'src/index.js',
    '.',
    '',
  ]) {
    t.assert.equal(hasNodeModulesSegment(p), false, p)
  }
})
