import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Vfs, buildVfsBundle, setCacheDir, suggestedEntries } from '../stasis/src/vfs-bundle.js'
import { loadTree, vfsHost } from '../stasis/src/vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle with Soldeer. The fixture's project depends on stasis-sol-lib, a package
// of its own whose zip (registry/) was served as Soldeer's registry serves one, to a real `soldeer
// install` (0.12.0): that wrote the project's soldeer.lock and remappings.txt, and the dependencies
// folder beside it. The zip is seeded into the cache, so nothing is fetched. The oracle: that
// dependencies folder in the project + plain `stasis bundle` must produce the byte-identical bundle.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'soldeer-bundle')
const FILES = ['foundry.toml', 'soldeer.lock', 'remappings.txt', 'src/Counter.sol', 'test/Counter.t.sol', 'script/Counter.s.sol']
const ENTRIES = ['src', 'test', 'script']

let cacheRoot
let installed
let files
const oracles = {}

// The fixture's project WITHOUT its dependencies folder, in a Vfs whose `/` is its root, with
// `extra` over it (an undefined one left out).
const projectVfs = (extra = {}) => {
  const vfs = new Vfs()
  for (const [path, text] of Object.entries({ ...files, ...extra })) {
    if (text === undefined) continue
    vfs.mkdir(posix.dirname(`/${path}`), { recursive: true })
    vfs.writeFile(`/${path}`, text)
  }
  return vfs
}

const build = (options) => buildVfsBundle({ vfs: projectVfs(), packageManager: 'soldeer', entries: ENTRIES, ...options })

const bundleOnDisk = async (cwd, args) => {
  const { FOUNDRY_PROFILE: _p, FOUNDRY_REMAPPINGS: _r, DAPP_REMAPPINGS: _d, ...env } = process.env
  const child = spawn(process.execPath, [cli, 'bundle', ...args, ...ENTRIES], { cwd, env })
  const stderr = []
  child.stderr.on('data', (d) => stderr.push(d))
  const [status] = await once(child, 'close')
  if (status !== 0) throw new Error(`Failed to build the oracle bundle: ${Buffer.concat(stderr)}`)
}

// path -> what a dependencies folder holds there: a directory, or a file's mode and bytes.
function listDisk(dir, rel = '') {
  const out = {}
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = posix.join(rel, entry.name)
    if (entry.isDirectory()) Object.assign(out, { [path]: 'directory' }, listDisk(dir, path))
    else out[path] = { mode: statSync(join(dir, path)).mode & 0o777, data: readFileSync(join(dir, path)).toString('base64') }
  }
  return out
}

function listVfs(vfs, dir) {
  const out = {}
  for (const name of vfs.readdir(dir)) {
    const path = posix.join(dir, name)
    const node = vfs.lstat(path)
    const key = path.slice(dir.length + 1)
    if (node.type === 'directory') Object.assign(out, { [key]: 'directory' }, Object.fromEntries(Object.entries(listVfs(vfs, path)).map(([p, v]) => [`${name}/${p}`, v])))
    else out[key] = { mode: node.mode, data: Buffer.from(vfs.readFile(path)).toString('base64') }
  }
  return out
}

before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-soldeer-cache-'))
  // Where @preventive/upstream caches a Soldeer zip: by its name and version.
  await mkdir(join(cacheRoot, 'soldeer', 'zips'), { recursive: true })
  await cp(join(fixture, 'registry', 'stasis-sol-lib-1.0.0.zip'), join(cacheRoot, 'soldeer', 'zips', 'stasis-sol-lib@1.0.0.zip'))
  setCacheDir(cacheRoot)
  files = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await readFile(join(fixture, 'project', f), 'utf8')])))
  installed = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-soldeer-'))
  await cp(join(fixture, 'project'), installed, { recursive: true })
  await cp(join(fixture, 'dependencies'), join(installed, 'dependencies'), { recursive: true })
  await Promise.all([['plain', []], ['manifests', ['--manifests']]].map(async ([name, args]) => {
    await bundleOnDisk(installed, [`--output=${join(installed, `${name}.br`)}`, ...args])
    oracles[name] = brotliDecompressSync(await readFile(join(installed, `${name}.br`))).toString('utf8')
  }))
})

after(() => Promise.all([cacheRoot, installed].map((dir) => dir && rm(dir, { recursive: true, force: true }))))

test('soldeer: lays out, into a Vfs of its own, the dependencies folder a real install makes', async (t) => {
  const vfs = projectVfs()
  const tree = await loadTree({ project: vfsHost(vfs), packageManager: 'soldeer', cwd: '/src' })
  t.assert.deepEqual([tree.root, [...tree.projects], tree.packageManagerVersion], ['/', ['.'], '0.12.0'])
  t.assert.deepEqual(tree.stats, { dependencies: 1, files: 6, bytes: 637 })
  t.assert.deepEqual(listVfs(tree.vfs, '/dependencies'), listDisk(join(fixture, 'dependencies')))
  t.assert.deepEqual(tree.vfs.readdir('/'), ['dependencies'])
  t.assert.equal(vfs.isDirectory('/dependencies'), false, 'the project\'s Vfs is only read')
  t.assert.deepEqual(tree.host.readdir('/').map((d) => d.name), ['dependencies', 'foundry.toml', 'remappings.txt', 'script', 'soldeer.lock', 'src', 'test'])
  t.assert.equal(tree.host.stat('/dependencies/stasis-sol-lib-1.0.0/script/deploy.sh').mode & 0o777, 0o755)
})

test('buildVfsBundle builds, from soldeer.lock alone, the byte-identical bundle a real install yields', async (t) => {
  const built = await build()
  t.assert.equal(built.bundle.serialize(), oracles.plain)
  t.assert.equal(built.lockfile, undefined, 'a Solidity bundle has no lockfile')
  t.assert.deepEqual(built.stats, { dependencies: 1, files: 6, bytes: 637 })
  t.assert.equal((await build({ manifests: true })).bundle.serialize(), oracles.manifests, 'with the manifests too')
})

test('buildVfsBundle detects Soldeer from soldeer.lock, and refuses to choose beside another lockfile', async (t) => {
  const built = await build({ packageManager: undefined })
  t.assert.equal(built.packageManager, 'soldeer')
  t.assert.equal(built.bundle.serialize(), oracles.plain)
  await t.assert.rejects(build({ packageManager: undefined, vfs: projectVfs({ 'yarn.lock': '# yarn lockfile v1\n' }) }), /^Error: buildVfsBundle: no packageManager given, and more than one lockfile installs \/: \/yarn\.lock \(yarn1\), \/soldeer\.lock \(soldeer\)$/u)
})

test('buildVfsBundle builds with the default profile and no remappings from the environment, whatever env says', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const toml = files['foundry.toml'].replace('[profile.default]', '[profile.ci]\nremappings = ["stasis-sol-lib/=src/"]\n\n[profile.default]')
  const built = await build({ vfs: projectVfs({ 'foundry.toml': toml }), env: { FOUNDRY_PROFILE: 'ci', FOUNDRY_REMAPPINGS: 'stasis-sol-lib/=src/', DAPP_REMAPPINGS: 'stasis-sol-lib/=src/' } })
  t.assert.equal(built.bundle.serialize(), (await build({ vfs: projectVfs({ 'foundry.toml': toml }) })).bundle.serialize())
  t.assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]).filter((line) => /environment/u.test(line)), [])
})

test('suggestedEntries suggests the .sol entry points, not its tests or scripts, which build the bundle src/ does', async (t) => {
  const entries = await suggestedEntries({ vfs: projectVfs() })
  t.assert.deepEqual(entries, ['src/Counter.sol'])
  t.assert.equal((await build({ entries })).bundle.serialize(), (await build({ entries: ['src'] })).bundle.serialize())
})

test('whatever the project holds as installed is ignored: a tampered dependencies folder does not reach the bundle', async (t) => {
  const tampered = { 'dependencies/stasis-sol-lib-1.0.0/src/Lib.sol': 'library Lib {} // TAMPERED\n', 'dependencies/other-1.0.0/src/X.sol': '' }
  t.assert.equal((await build({ vfs: projectVfs(tampered) })).bundle.serialize(), oracles.plain)
  // Nor a node_modules another package manager installed: Soldeer reproduces none.
  const imported = projectVfs({ 'node_modules/@evil/pkg/X.sol': 'library X {}\n', 'src/Counter.sol': files['src/Counter.sol'].replace('import {Lib}', 'import "@evil/pkg/X.sol";\nimport {Lib}') })
  await t.assert.rejects(build({ vfs: imported }), /Unresolved import: @evil\/pkg\/X\.sol from src\/Counter\.sol/u)
})

test('soldeer: writes the remappings.txt `soldeer install` leaves, and refuses a foundry.toml it would edit', async (t) => {
  // Each remappings.txt here is the one a real `soldeer install` (0.12.0) left.
  const served = async (extra) => {
    const { host } = await loadTree({ project: vfsHost(projectVfs(extra)), packageManager: 'soldeer', cwd: '/' })
    return host.stat('/remappings.txt') === null ? null : host.readFile('/remappings.txt').toString()
  }
  const toml = (edit) => ({ 'foundry.toml': edit(files['foundry.toml']) })
  const settled = 'stasis-sol-lib/=dependencies/stasis-sol-lib-1.0.0/\n'
  t.assert.equal(await served(), settled)
  t.assert.equal(await served({ 'remappings.txt': undefined }), settled)
  t.assert.equal(await served({ 'remappings.txt': 'zzz/=lib/zzz/\nstasis-sol-lib/=dependencies/stasis-sol-lib-0.9.0/src/\r\nno-equals-line\nalpha/=src/\n' }), 'alpha/=src/\nstasis-sol-lib/=dependencies/stasis-sol-lib-0.9.0/src/\nstasis-sol-lib/=dependencies/stasis-sol-lib-1.0.0/\nzzz/=lib/zzz/\n')
  t.assert.equal(await served({ 'remappings.txt': 'other/=lib/stasis-sol-lib-1.0.0/src/\n' }), 'other/=dependencies/stasis-sol-lib-1.0.0/src/\n')
  t.assert.equal(await served({ 'remappings.txt': undefined, ...toml((text) => text.replace('remappings_version = false', 'remappings_version = true\nremappings_prefix = "@"')) }), '@stasis-sol-lib-1.0.0/=dependencies/stasis-sol-lib-1.0.0/\n')
  t.assert.equal(await served({ 'remappings.txt': 'zzz/=lib/zzz/\n', ...toml((text) => text.replace('remappings_version = false', 'remappings_version = false\nremappings_regenerate = true')) }), settled)
  // The bundle is built over it, as over the real install's.
  t.assert.equal((await build({ vfs: projectVfs({ 'remappings.txt': undefined }), manifests: true })).bundle.serialize(), oracles.manifests)

  // What it would edit in foundry.toml, which is not written here, is refused.
  await t.assert.rejects(served(toml((text) => text.replace('libs = ["dependencies"]\n', ''))), /^Error: \/foundry\.toml: \[profile\.default\] libs holds no "dependencies", which `soldeer install` adds$/u)
  const config = (text) => text.replace('remappings_version = false', 'remappings_version = false\nremappings_location = "config"')
  await t.assert.rejects(served({ 'remappings.txt': undefined, ...toml(config) }), /^Error: \/foundry\.toml: \[profile\.default\] remappings are not as `soldeer install` leaves them$/u)
  t.assert.equal(await served({ 'remappings.txt': undefined, ...toml((text) => config(text).replace('libs = ["dependencies"]', 'libs = ["dependencies"]\nremappings = ["stasis-sol-lib/=dependencies/stasis-sol-lib-1.0.0/"]')) }), null)
  await t.assert.rejects(served(toml(config)), /^Error: \/remappings\.txt: `soldeer install` removes it, as remappings_location is "config"$/u)
  // As is a remapping only Rust's semver could tell Soldeer rewrites.
  await t.assert.rejects(served({ 'remappings.txt': 'x/=dependencies/stasis-sol-lib-0.9.0/\n', ...toml((text) => text.replace('stasis-sol-lib = "1.0.0"', 'stasis-sol-lib = "^1.0.0"')) }), /"x\/=dependencies\/stasis-sol-lib-0\.9\.0\/" names stasis-sol-lib-0\.9\.0, which `soldeer install` may rewrite to dependencies\/stasis-sol-lib-1\.0\.0$/u)
})

test('a zip that does not match soldeer.lock\'s checksum fails closed', async (t) => {
  const lockfile = files['soldeer.lock'].replace(/checksum = "[\da-f]+"/u, `checksum = "${'0'.repeat(64)}"`)
  await t.assert.rejects(build({ vfs: projectVfs({ 'soldeer.lock': lockfile }) }), /dependencies\["stasis-sol-lib"\]: getZip: integrity mismatch/u)
})

test('soldeer: installs from the nearest foundry.toml or soldeer.toml, never above the git repository\'s root', async (t) => {
  const vfs = new Vfs()
  for (const [path, text] of Object.entries({ '/foundry.toml': files['foundry.toml'], '/soldeer.lock': files['soldeer.lock'], '/repo/sub/src/A.sol': '' })) {
    vfs.mkdir(posix.dirname(path), { recursive: true })
    vfs.writeFile(path, text)
  }
  t.assert.equal((await loadTree({ project: vfsHost(vfs), packageManager: 'soldeer', cwd: '/repo/sub/src' })).root, '/')
  // Soldeer reads no package.json: one between cwd and the root makes no project of its own.
  vfs.writeFile('/repo/sub/package.json', '{"name":"sub","version":"1.0.0"}\n')
  t.assert.equal((await loadTree({ project: vfsHost(vfs), packageManager: 'soldeer', cwd: '/repo/sub/src' })).root, '/')
  vfs.mkdir('/repo/.git')
  await t.assert.rejects(loadTree({ project: vfsHost(vfs), packageManager: 'soldeer', cwd: '/repo/sub/src' }), (err) => err.message === 'no soldeer.lock found in /repo, where /repo/sub/src is installed from')
})

test('buildVfsBundle with soldeer refuses, naming the file, what it cannot reproduce, and checks its entries first', async (t) => {
  const rev = '0123456789abcdef0123456789abcdef01234567'
  const git = {
    'soldeer.lock': `[[dependencies]]\nname = "stasis-sol-lib"\nversion = "1.0.0"\ngit = "https://github.com/ExodusOSS/stasis-sol-lib.git"\nrev = "${rev}"\n`,
    'foundry.toml': files['foundry.toml'].replace('stasis-sol-lib = "1.0.0"', `stasis-sol-lib = { version = "1.0.0", git = "https://github.com/ExodusOSS/stasis-sol-lib.git", rev = "${rev}" }`),
  }
  await t.assert.rejects(build({ vfs: projectVfs(git), entries: ['src/Typo.sol'] }), /^Error: entry not found: \/src\/Typo\.sol/u)
  await t.assert.rejects(build({ vfs: projectVfs(git) }), /dependencies\["stasis-sol-lib"\]: a git dependency, which Soldeer clones with its history, is not supported/u)
  await t.assert.rejects(build({ vfs: projectVfs({ 'soldeer.lock': git['soldeer.lock'] }) }), (err) => err.message === '/soldeer.lock: config.dependencies["stasis-sol-lib"]: a registry dependency, whose entry is a git one')
  await t.assert.rejects(build({ vfs: projectVfs({ 'soldeer.lock': '[[dependencies]\n' }) }), (err) => err.message.startsWith('/soldeer.lock: ') && err.cause?.name === 'TomlError')
  await t.assert.rejects(build({ packageManagerVersion: '0.11.0' }), /host\.soldeer: Soldeer "0\.11\.0" is not supported/u)
  const { 'soldeer.lock': _, ...unlocked } = files
  const vfs = new Vfs()
  for (const [path, text] of Object.entries(unlocked)) {
    vfs.mkdir(posix.dirname(`/${path}`), { recursive: true })
    vfs.writeFile(`/${path}`, text)
  }
  await t.assert.rejects(buildVfsBundle({ vfs, packageManager: 'soldeer', entries: ENTRIES }), (err) => err.message === 'no soldeer.lock found in /, where / is installed from')
})

test('buildVfsBundle with soldeer puts `repo` on the Bundle', async (t) => {
  const repo = { github: 'ExodusOSS/stasis', directory: 'tests/fixtures/soldeer-bundle/project', commit: 'a'.repeat(40) }
  t.assert.deepEqual((await build({ repo })).bundle.repo, repo)
  t.assert.equal((await build()).bundle.repo, undefined)
})
