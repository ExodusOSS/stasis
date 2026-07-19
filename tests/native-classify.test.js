// Unit tests for the native-capture classification/exclusion predicates (stasis-core/util). The
// E2E metro/bundle-cmd suites exercise the DEFAULT (this host = non-Windows) behavior; here we pin
// the pure predicates directly, including the win32-conditional branch a Linux/macOS CI can't hit.

import { test } from 'node:test'

import { classifyNativeCapture, isExcludedNativeDir, isExcludedNativeFile } from '@exodus/stasis-core/util'

const NOT_WIN = { win32: false }
const WIN = { win32: true }

test('isExcludedNativeFile: docs / config / logs / maps are always excluded', (t) => {
  for (const name of [
    'README.md', 'CHANGELOG.md', 'LICENSE', 'license', '.prettierrc', '.gitattributes',
    '.flowconfig', '.eslintignore', '.releaserc', '.clang-format', '.buckconfig', '.watchmanconfig',
    'debug.log', 'bundle.js.map',
  ]) {
    t.assert.equal(isExcludedNativeFile(name, NOT_WIN), true, `${name} excluded off Windows`)
    t.assert.equal(isExcludedNativeFile(name, WIN), true, `${name} excluded on Windows too`)
  }
})

test('isExcludedNativeFile: .bat is excluded off Windows, kept on Windows', (t) => {
  t.assert.equal(isExcludedNativeFile('install.bat', NOT_WIN), true)
  t.assert.equal(isExcludedNativeFile('install.bat', WIN), false)
})

test('isExcludedNativeFile: real build inputs are NOT excluded', (t) => {
  for (const name of [
    'RNThing.podspec', 'hermes-utils.rb', 'build.gradle', 'RNThing.mm', 'Yoga.cpp', 'RNThing.h',
    'package.json', 'AndroidManifest.xml', 'Info.plist', 'PrivacyInfo.xcprivacy', 'CMakeLists.txt',
  ]) {
    t.assert.equal(isExcludedNativeFile(name, NOT_WIN), false, `${name} kept`)
    t.assert.equal(isExcludedNativeFile(name, WIN), false, `${name} kept`)
  }
})

test('isExcludedNativeDir: windows/ is excluded off Windows, kept on Windows; ios/android always kept', (t) => {
  t.assert.equal(isExcludedNativeDir('windows', NOT_WIN), true)
  t.assert.equal(isExcludedNativeDir('windows', WIN), false)
  for (const dir of ['ios', 'android', 'src', 'cpp']) {
    t.assert.equal(isExcludedNativeDir(dir, NOT_WIN), false)
    t.assert.equal(isExcludedNativeDir(dir, WIN), false)
  }
})

test('classifyNativeCapture: excluded files skip; a .bat is win32-conditional', (t) => {
  t.assert.deepEqual(classifyNativeCapture('README.md', NOT_WIN), { action: 'skip' })
  t.assert.deepEqual(classifyNativeCapture('bundle.js.map', NOT_WIN), { action: 'skip' })
  t.assert.deepEqual(classifyNativeCapture('install.bat', NOT_WIN), { action: 'skip' })
  // On Windows a .bat is a build script -> a resource, not skipped.
  t.assert.deepEqual(classifyNativeCapture('install.bat', WIN), { action: 'resource' })
  // A real native source still classifies as code with its language tag, regardless of platform.
  t.assert.deepEqual(classifyNativeCapture('RNThing.mm', NOT_WIN), { action: 'code', format: 'objcpp' })
  // A .sh script is 'shell' code from the one shared vocab (like gradlew), not a resource.
  t.assert.deepEqual(classifyNativeCapture('build-phase.sh', NOT_WIN), { action: 'code', format: 'shell' })
})

test('classifyNativeCapture: an extensionless shell shebang is shell code (content-based)', (t) => {
  const bash = Buffer.from('#!/usr/bin/env bash\nexec gradle "$@"\n')
  t.assert.deepEqual(classifyNativeCapture('run-tool', { win32: false, content: bash }),
    { action: 'code', format: 'shell' })
  // No content -> the shebang rule can't fire, so an extensionless non-build-input is a resource.
  t.assert.deepEqual(classifyNativeCapture('run-tool', NOT_WIN), { action: 'resource' })
  // An extensionless file whose shebang is NOT a shell interpreter stays a resource.
  const nodeScript = Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n')
  t.assert.deepEqual(classifyNativeCapture('run-node', { win32: false, content: nodeScript }),
    { action: 'resource' })
})
