// Unit tests for the native-capture classification/exclusion predicates (stasis-core/util). The
// E2E metro/bundle-cmd suites exercise the DEFAULT (this host = non-Windows) behavior; here we pin
// the pure predicates directly, including the win32-conditional branch a Linux/macOS CI can't hit.

import { test } from 'node:test'

import { classifyNativeCapture, isDotEnvFile, isExcludedNativeDir, isExcludedNativeFile } from '@exodus/stasis-core/util'

const NOT_WIN = { win32: false }
const WIN = { win32: true }

test('isExcludedNativeFile: docs / config / logs / maps are always excluded', (t) => {
  for (const name of [
    'README.md', 'CHANGELOG.md', 'LICENSE', 'license', 'LICENCE', 'THIRD-PARTY-LICENSES',
    '.prettierrc', '.prettierignore', '.gitattributes', '.flowconfig', '.eslintignore', '.releaserc', '.clang-format',
    '.buckconfig', '.watchmanconfig', '.editorconfig', 'circle.yml', '.swiftlint.yml',
    'yarn.lock', '.project', 'gradle-wrapper.properties',
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
    'gradle.properties', // project build config -- kept, distinct from the excluded gradle-wrapper.properties
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
  // A `*.cmake.in` is a CMake configure_file template (build input) -> cmake code, by compound
  // suffix (pathExt only sees the trailing `.in`).
  t.assert.deepEqual(classifyNativeCapture('ReactABI.cmake.in', NOT_WIN), { action: 'code', format: 'cmake' })
  // ...but only `.cmake.in`, NOT a bare `.in`: a config.h.in isn't cmake (stays a resource).
  t.assert.deepEqual(classifyNativeCapture('config.h.in', NOT_WIN), { action: 'resource' })
})

test('classifyNativeCapture: the whole env family (`.env`, `.env.*`, `*.env`) is skipped', (t) => {
  // Secrets are never swept into an automated native capture: dotenv basenames (any depth) AND
  // any `.env`-extension file (Docker Compose env_file `web.env`, reversed-dotenv `.abc.env`) --
  // the stem carries no safety signal, so the extension family fails closed too.
  for (const name of [
    '.env', '.env.local', '.env.production', 'ios/.env', 'android/app/.env.staging',
    'web.env', '.abc.env', '.dev.env', 'ios/config.env', 'compose/db.env',
  ]) {
    t.assert.equal(isDotEnvFile(name), true, `${name} is in the env family`)
    t.assert.deepEqual(classifyNativeCapture(name, NOT_WIN), { action: 'skip' }, `${name} skipped`)
    t.assert.deepEqual(classifyNativeCapture(name, WIN), { action: 'skip' }, `${name} skipped on Windows too`)
  }
  // Only the FINAL extension counts: an env-like stem with another extension is not in the family.
  t.assert.equal(isDotEnvFile('ios/env.plist'), false)
  t.assert.equal(isDotEnvFile('environment.js'), false)
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
