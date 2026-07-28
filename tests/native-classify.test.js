// Unit tests for the native-capture classification/exclusion predicates (stasis-core/util). The
// E2E metro/bundle-cmd suites exercise the DEFAULT (this host = non-Windows) behavior; here we pin
// the pure predicates directly, including the win32-conditional branch a Linux/macOS CI can't hit.

import { test } from 'node:test'

import { classifyNativeCapture, isAppleSliceDir, isBinaryPlist, isDotEnvFile, isExcludedNativeDir, isExcludedNativeFile, isTypeDeclaration, stripTypeDeclaration } from '@exodus/stasis-core/util'

const NOT_WIN = { win32: false }
const WIN = { win32: true }

test('isExcludedNativeFile: docs / config / logs / maps are always excluded', (t) => {
  for (const name of [
    'README.md', 'CHANGELOG.md', 'LICENSE', 'license', 'LICENCE', 'THIRD-PARTY-LICENSES',
    '.prettierrc', '.prettierignore', '.prettierrc.js', '.gitattributes', '.flowconfig', '.eslintignore', '.releaserc', '.clang-format',
    '.buckconfig', '.watchmanconfig', '.editorconfig', 'circle.yml', '.swiftlint.yml',
    'documentation.yml', // documentation.js config
    'yarn.lock', '.project', 'gradle-wrapper.properties',
    'debug.log', 'bundle.js.map',
    'index.js.flow', 'Thing.js.flow', // Flow declaration sidecars (the `.d.ts` analog)
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
    'other.yml', 'buildkite.yml', // only documentation.yml/circle.yml/.swiftlint.yml are excluded BY NAME, not all YAML
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

test('isAppleSliceDir: per-arch prebuilt slice dirs are matched; real source dirs are not', (t) => {
  // The payload dirs of a prebuilt binary framework -- compiled output, not source. Deps that ship
  // them LOOSE (outside a `*.xcframework`, which isNativeArtifact already skips) need this.
  for (const dir of [
    'ios-arm64', 'ios-arm64_x86_64-simulator', 'ios-arm64e', 'ios-arm64_x86_64-maccatalyst',
    'tvos-arm64_x86_64-simulator', 'watchos-arm64_32_armv7k', 'macos-arm64_x86_64', 'xros-arm64',
  ]) {
    t.assert.equal(isAppleSliceDir(dir), true, `${dir} is a slice dir`)
  }
  // Keyed on `<platform>-<arch>[_<arch>...][-variant]`, so ordinary dirs can't collide.
  for (const dir of ['ios', 'android', 'src', 'cpp', 'React', 'ios-helpers', 'iossupport', 'arm64', 'ios-']) {
    t.assert.equal(isAppleSliceDir(dir), false, `${dir} is NOT a slice dir`)
  }
})

test('isTypeDeclaration / stripTypeDeclaration: types-only files, and their runtime stem', (t) => {
  for (const name of ['index.d.ts', 'dist/index.d.ts', 'types.d.mts', 'x.d.cts', 'Foo.D.TS']) {
    t.assert.equal(isTypeDeclaration(name), true, `${name} is a declaration`)
  }
  // A `.ts`/`.tsx` is real source, and a stem merely ending in `d` is not a declaration.
  for (const name of ['index.ts', 'foo.tsx', 'notd.ts', 'index.js']) {
    t.assert.equal(isTypeDeclaration(name), false, `${name} is not a declaration`)
  }
  // The stem a resolver probes instead, so `main: "dist/index.d.ts"` lands on dist/index.js.
  t.assert.equal(stripTypeDeclaration('dist/index.d.ts'), 'dist/index')
  t.assert.equal(stripTypeDeclaration('types.d.mts'), 'types')
  t.assert.equal(stripTypeDeclaration('x.d.cts'), 'x')
  t.assert.equal(stripTypeDeclaration('dist/index.js'), 'dist/index.js') // not a declaration -> unchanged
})

test('isBinaryPlist: a bplist is detected by bytes, so callers can route it off the code path', (t) => {
  // Apple's `bplist00` format: a real build input whose bytes aren't UTF-8, so it can't ride the
  // text/code path a `.plist` classifies onto (that combination failed every capture). Each caller
  // then treats it as NOT code, so its own `resources` allowlist gate decides.
  const binary = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0xff, 0xfe, 0x00])])
  t.assert.equal(isBinaryPlist('Info.plist', binary), true)
  t.assert.equal(isBinaryPlist('ios/PrivacyInfo.plist', binary), true)
  // A TEXT (XML) plist is unaffected -- it stays on the code path as 'xml'.
  t.assert.equal(isBinaryPlist('Info.plist', Buffer.from('<?xml version="1.0"?>\n<plist/>\n')), false)
  t.assert.deepEqual(classifyNativeCapture('Info.plist', NOT_WIN), { action: 'code', format: 'xml' })
  // Only a `.plist` counts: other binary bytes are handled by their own rules.
  t.assert.equal(isBinaryPlist('logo.png', binary), false)
  // Needs the bytes: a name alone can't tell a binary plist from a text one.
  t.assert.equal(isBinaryPlist('Info.plist', undefined), false)
})

test('classifyNativeCapture: TypeScript source (.ts/.tsx/.d.ts) is skipped -- Metro owns the JS graph', (t) => {
  // A native dep's TS is its JS-side implementation, carried by Metro's module graph when reached --
  // it is never a native build input, so the native capture never emits it (a .ts is not expected to
  // cross the node_modules boundary as a build input). The type-only .d.ts is skipped too.
  for (const name of ['index.ts', 'src/index.ts', 'Widget.tsx', 'types/index.d.ts', 'global.d.ts']) {
    t.assert.deepEqual(classifyNativeCapture(name, NOT_WIN), { action: 'skip' }, `${name} skipped`)
    t.assert.deepEqual(classifyNativeCapture(name, WIN), { action: 'skip' }, `${name} skipped on Windows too`)
  }
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
