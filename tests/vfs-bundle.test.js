import { after, before, describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { Vfs, buildVfsBundle, loadNodeModules, setCacheDir } from '../stasis/src/vfs-bundle.js'

// @exodus/stasis/vfs-bundle builds from a lockfile alone: @preventive/deptree fetches the tarballs
// into a cache, verifies them and lays them out in memory as the package manager would, which is
// then scanned like any other static bundle. The fixtures are one package set, under pnpm's
// default (isolated) layout and under yarn 1's hoisted one, so the oracle is simple: a real
// install + plain `stasis bundle` must produce the byte-identical artifact.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const MANAGERS = {
  pnpm: {
    fixture: join(here, 'fixtures', 'pnpm-bundle'),
    files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src/entry.js'],
    installed: join('node_modules', '.pnpm'),
    install: ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']],
    stats: { projects: 1, snapshots: 86, installed: 86, skipped: 0, tarballs: 86 },
    // An installed lodash, as pnpm lays it out.
    tamper: (vfs) => {
      vfs.mkdir('/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash', { recursive: true })
      vfs.writeFile('/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', 'module.exports = "TAMPERED"\n')
      vfs.symlink('.pnpm/lodash@4.17.21/node_modules/lodash', '/node_modules/lodash')
    },
    lockfile: 'pnpm-lock.yaml',
    integrity: /(ms@2\.1\.3:\n\s+resolution: \{integrity: )sha512-[^}]+/u,
  },
  yarn1: {
    fixture: join(here, 'fixtures', 'yarn1-bundle'),
    files: ['package.json', 'yarn.lock', 'src/entry.js'],
    installed: join('node_modules', '.yarn-integrity'),
    install: ['npx', ['--yes', 'yarn@1.22.22', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']],
    stats: { packages: 86, skipped: 0, installed: 92, links: 0 },
    // An installed lodash, as yarn lays it out.
    tamper: (vfs) => {
      vfs.mkdir('/node_modules/lodash', { recursive: true })
      vfs.writeFile('/node_modules/lodash/lodash.js', 'module.exports = "TAMPERED"\n')
    },
    lockfile: 'yarn.lock',
    integrity: /(ms@2\.1\.3:\n(?: {2}.*\n)*? {2}integrity )sha512-\S+/u,
  },
}

const expectedOutput = `${JSON.stringify([
  ['express.app', true],
  ['lodash.chunk', '[[1,2],[3,4],[5]]'],
  ['chalk.red', true],
  ['debug.fn', true],
  ['semver.gt', true],
  ['uuid.len', 36],
  ['axios.create', true],
  ['dotenv.parse', '{"A":"1","B":"2"}'],
  ['picocolors.green', true],
  ['nanoid.length', 21],
])}\n`

const cleanEnv = (() => {
  const {
    EXODUS_STASIS_LOCK: _l,
    EXODUS_STASIS_SCOPE: _s,
    EXODUS_STASIS_BUNDLE: _b,
    EXODUS_STASIS_BUNDLE_FILE: _bf,
    EXODUS_STASIS_DEBUG: _d,
    EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
    ...rest
  } = process.env
  return { ...rest, EXODUS_STASIS_BROTLI_QUALITY: '5' }
})()

// One tarball cache for the whole file: the first test pays the downloads, the rest read the cache.
// The home and npm's cache are pointed away from the user's too, so nothing a tarball reader could
// consult (npm's or ~/.audit's cached tarballs) comes from this machine.
let cacheRoot
const tarballDir = () => join(cacheRoot, 'stasis', 'npm', 'tarballs')
const isolatedEnv = () => ({ HOME: join(cacheRoot, 'home'), npm_config_cache: join(cacheRoot, 'npm-cache') })

// `node: true` runs node itself on `args` rather than the CLI.
const run = async (args, { node = false, ...opts } = {}) => {
  const child = spawn(process.execPath, node ? args : [cli, ...args], { env: { ...cleanEnv, ...isolatedEnv() }, ...opts })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const withTmp = (fn) => async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-bundle-'))
  try {
    return await fn(t, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Hardlinked clone of the installed fixture (see popular-npm-modules.test.js for why).
const hardlinkCopy = async (src, dst) => {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) await hardlinkCopy(s, d)
    else if (entry.isSymbolicLink()) await symlink(await readlink(s), d)
    else await link(s, d)
  }))
}

const decode = (buf) => brotliDecompressSync(buf).toString('utf-8')

// Each fixture's oracle, from a hardlinked copy of its real install: the files it is built from,
// and the bundle and lockfile plain `stasis bundle` writes there.
const oracles = {}

const environment = Object.fromEntries(['HOME', 'npm_config_cache'].map((key) => [key, process.env[key]]))

before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-cache-'))
  await mkdir(join(cacheRoot, 'home'))
  Object.assign(process.env, isolatedEnv())
  setCacheDir(join(cacheRoot, 'stasis'))
  await Promise.all(Object.entries(MANAGERS).map(async ([packageManager, m]) => {
    if (!existsSync(join(m.fixture, m.installed))) {
      const child = spawn(m.install[0], m.install[1], { cwd: m.fixture })
      const stderrChunks = []
      child.stderr.on('data', (d) => stderrChunks.push(d))
      const [status] = await once(child, 'close')
      if (status !== 0) throw new Error(`Failed to install fixture deps in ${m.fixture}: ${Buffer.concat(stderrChunks).toString('utf-8')}`)
    }
    const files = Object.fromEntries(await Promise.all(m.files.map(async (f) => [f, await readFile(join(m.fixture, f), 'utf8')])))
    const installedCopy = await mkdtemp(join(tmpdir(), `stasis-vfs-bundle-${packageManager}-`))
    await hardlinkCopy(m.fixture, installedCopy)
    const r = await run(['bundle', '--scope=full', `--output=${join(installedCopy, 'real.br')}`, `--lockfile=${join(installedCopy, 'real.lock.json')}`, 'src/entry.js'], { cwd: installedCopy })
    if (r.status !== 0) throw new Error(`Failed to build the ${packageManager} oracle bundle: ${r.stderr}`)
    oracles[packageManager] = { files, installedCopy, bundle: decode(await readFile(join(installedCopy, 'real.br'))), lockfile: await readFile(join(installedCopy, 'real.lock.json'), 'utf-8') }
  }))
})

after(async () => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all([cacheRoot, ...Object.values(oracles).map((o) => o.installedCopy)].map((dir) => dir && rm(dir, { recursive: true, force: true })))
})

// The fixture's files WITHOUT its node_modules, in a Vfs whose `/` is the lockfile's directory,
// with `files` over them.
const projectVfs = (packageManager, files = {}) => {
  const vfs = new Vfs()
  for (const [path, text] of Object.entries({ ...oracles[packageManager].files, ...files })) {
    vfs.mkdir(dirname(`/${path}`), { recursive: true })
    vfs.writeFile(`/${path}`, text)
  }
  return vfs
}

const pick = (stats, keys) => Object.fromEntries(Object.keys(keys).map((key) => [key, stats[key]]))

for (const [packageManager, m] of Object.entries(MANAGERS)) {
  const build = (vfs, options) => buildVfsBundle({ vfs, packageManager, entries: ['src/entry.js'], ...options })

  describe(`buildVfsBundle with ${packageManager}`, { concurrency: 1 }, () => {
    test('builds, from the lockfile alone, the byte-identical bundle + lockfile a real install yields', async (t) => {
      const vfs = projectVfs(packageManager)
      const built = await build(vfs, { scope: 'full' })
      t.assert.ok(built.bundle instanceof Bundle)
      t.assert.equal(built.bundle.serialize(), oracles[packageManager].bundle)
      t.assert.ok(built.lockfile instanceof Lockfile)
      t.assert.equal(built.lockfile.serialize(), oracles[packageManager].lockfile)
      t.assert.deepEqual(pick(built.stats, m.stats), m.stats)
      t.assert.equal(vfs.isDirectory('/node_modules'), false, 'the project\'s Vfs is only read')
    })

    test('packageJSON, mainFields, metro and node_modules scope match the real install too', async (t) => {
      const { installedCopy } = oracles[packageManager]
      const variants = [
        [['--package-json', '--scope=full'], { packageJSON: true, scope: 'full' }],
        [['--mainFields=browser,main'], { mainFields: ['browser', 'main'] }],
        [['--scope=node_modules'], { scope: 'node_modules' }],
        [['--metro', '--platforms=ios,android', '--package-json'], { metro: true, platforms: ['ios', 'android'], packageJSON: true }],
      ]
      const reals = await Promise.all(variants.map(async ([flags]) => {
        const name = flags.join('_').replaceAll(/[^\w]/gu, '_')
        const r = await run(['bundle', ...flags, `--output=${join(installedCopy, `${name}.br`)}`, `--lockfile=${join(installedCopy, `${name}.lock.json`)}`, 'src/entry.js'], { cwd: installedCopy })
        t.assert.equal(r.status, 0, `real ${flags}: ${r.stderr}`)
        return { bundle: decode(await readFile(join(installedCopy, `${name}.br`))), lockfile: await readFile(join(installedCopy, `${name}.lock.json`), 'utf-8') }
      }))
      const builts = await Promise.all(variants.map(([, options]) => build(projectVfs(packageManager), options)))
      for (const [i, [flags]] of variants.entries()) {
        t.assert.equal(builts[i].bundle.serialize(), reals[i].bundle, `bundle for ${flags.join(' ')}`)
        t.assert.equal(builts[i].lockfile.serialize(), reals[i].lockfile, `lockfile for ${flags.join(' ')}`)
      }
    })

    test('the bundle loads (--bundle=load) and its lockfile verifies (--lock=frozen) against the real install', withTmp(async (t, tmp) => {
      const { installedCopy } = oracles[packageManager]
      const { bundle, lockfile } = await build(projectVfs(packageManager), { scope: 'full' })
      await writeFile(join(tmp, 'v.br'), brotliCompressSync(bundle.serialize()))
      const load = await run(['run', '--lock=none', '--bundle=load', `--bundle-file=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: installedCopy })
      t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
      t.assert.equal(load.stdout, expectedOutput)
      await writeFile(join(installedCopy, 'stasis.lock.json'), lockfile.serialize())
      try {
        const frozen = await run(['run', '--lock=frozen', 'src/entry.js'], { cwd: installedCopy })
        t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)
        t.assert.equal(frozen.stdout, expectedOutput)
      } finally {
        await rm(join(installedCopy, 'stasis.lock.json'), { force: true })
      }
    }))

    test('whatever the project holds as installed is ignored: a tampered node_modules does not reach the bundle', async (t) => {
      const vfs = projectVfs(packageManager)
      m.tamper(vfs)
      const text = (await build(vfs, { scope: 'full' })).bundle.serialize()
      t.assert.equal(text, oracles[packageManager].bundle)
      t.assert.doesNotMatch(text, /TAMPERED/u)
    })

    test('a lockfile integrity that does not match the registry tarball fails closed', async (t) => {
      const lock = oracles[packageManager].files[m.lockfile]
      const tampered = lock.replace(m.integrity, `$1sha512-${'A'.repeat(86)}==`)
      t.assert.notEqual(tampered, lock)
      await t.assert.rejects(build(projectVfs(packageManager, { [m.lockfile]: tampered }), { scope: 'full' }), /integrity mismatch for ms@2\.1\.3/u)
    })

    test('over a project held in a Vfs, nothing is read from disk but the tarball cache', withTmp(async (t, tmp) => {
      // node:fs is wrapped before stasis is loaded, so every read through it is seen; a first build
      // loads every module the build does, so what the second reads is data.
      const files = Object.fromEntries(Object.entries(oracles[packageManager].files).map(([f, text]) => [`/${f}`, text]))
      const script = `
        import fs from 'node:fs'
        import { syncBuiltinESMExports } from 'node:module'
        const read = new Set()
        const spy = (obj, name) => {
          const real = obj[name]
          obj[name] = Object.assign(function (p, ...rest) {
            read.add(String(p))
            return real.call(this, p, ...rest)
          }, real)
        }
        for (const name of ['accessSync', 'existsSync', 'lstatSync', 'openSync', 'opendirSync', 'readFileSync', 'readdirSync', 'readlinkSync', 'realpathSync', 'statSync']) spy(fs, name)
        for (const name of ['access', 'lstat', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'stat']) spy(fs.promises, name)
        syncBuiltinESMExports()
        const { Vfs, buildVfsBundle, setCacheDir } = await import(${JSON.stringify(pathToFileURL(join(here, '..', 'stasis', 'src', 'vfs-bundle.js')).href)})
        setCacheDir(${JSON.stringify(join(cacheRoot, 'stasis'))})
        const build = () => {
          const vfs = new Vfs()
          for (const [path, text] of Object.entries(${JSON.stringify(files)})) {
            vfs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
            vfs.writeFile(path, text)
          }
          return buildVfsBundle({ vfs, packageManager: ${JSON.stringify(packageManager)}, entries: ['src/entry.js'], scope: 'full' })
        }
        await build()
        read.clear()
        const { bundle, lockfile } = await build()
        fs.writeFileSync(${JSON.stringify(join(tmp, 'out.json'))}, JSON.stringify({ bundle: bundle.serialize(), lockfile: lockfile.serialize(), read: [...read] }))
      `
      const r = await run(['--input-type=module', '-e', script], { cwd: tmp, node: true })
      t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
      const { bundle, lockfile, read } = JSON.parse(await readFile(join(tmp, 'out.json'), 'utf8'))
      t.assert.equal(bundle, oracles[packageManager].bundle)
      t.assert.equal(lockfile, oracles[packageManager].lockfile)
      t.assert.ok(read.length >= 86, 'the tarballs are read from the cache')
      t.assert.deepEqual(read.filter((p) => !p.startsWith(`${cacheRoot}/`)), [], 'nothing else on disk is read')
    }))
  })
}

describe('buildVfsBundle with pnpm, its cache and its lockfile', { concurrency: 1 }, () => {
  const build = (vfs) => buildVfsBundle({ vfs, packageManager: 'pnpm', entries: ['src/entry.js'], scope: 'full' })

  test('the tree is pnpm\'s, and its tarballs are cached by name and version', async (t) => {
    const cached = await readdir(tarballDir())
    t.assert.ok(cached.every((f) => f.endsWith('.tgz')))
    t.assert.ok(cached.includes('axios@1.7.7.tgz'), 'the cache reads at a glance: name@version.tgz')
    // Paths are pnpm's real virtual-store paths, peer suffixes included.
    const bundle = Bundle.parse(oracles.pnpm.bundle)
    t.assert.ok(bundle.modules.has('node_modules/.pnpm/axios@1.7.7_debug@4.3.6/node_modules/axios'))
    t.assert.ok(bundle.modules.has('node_modules/.pnpm/follow-redirects@1.16.0_debug@4.3.6/node_modules/follow-redirects'))
    const tree = await loadNodeModules({ vfs: projectVfs('pnpm'), packageManager: 'pnpm', cwd: '/src' })
    t.assert.equal(tree.root, '/')
    t.assert.equal(tree.packageManagerVersion, '10.33.4')
    t.assert.equal(tree.vfs.readlink('/node_modules/axios'), '.pnpm/axios@1.7.7_debug@4.3.6/node_modules/axios')
    t.assert.equal(JSON.parse(Buffer.from(tree.vfs.readFile('/node_modules/axios/package.json'))).version, '1.7.7')
  })

  test('a second build is served from the cache; a cache file that no longer matches the lockfile aborts it', async (t) => {
    // A download rewrites its cache file (write-then-rename), so untouched mtimes mean cache hits.
    const mtimes = async () => new Map(await Promise.all((await readdir(tarballDir())).map(async (f) => [f, (await stat(join(tarballDir(), f))).mtimeMs])))
    const stamped = await mtimes()
    const warm = await build(projectVfs('pnpm'))
    t.assert.equal(warm.stats.tarballs, 86)
    t.assert.equal(warm.bundle.serialize(), oracles.pnpm.bundle)
    t.assert.deepEqual(await mtimes(), stamped, 'every tarball was served from the cache')
    // Corrupt one cached tarball: the build stops there, fetches nothing over it, and leaves the
    // file for inspection.
    const cachedMs = join(tarballDir(), 'ms@2.1.3.tgz')
    const pristine = await readFile(cachedMs)
    try {
      await writeFile(cachedMs, 'garbage')
      await t.assert.rejects(build(projectVfs('pnpm')), /integrity mismatch for ms@2\.1\.3 from the cache/u)
      t.assert.equal(await readFile(cachedMs, 'utf-8'), 'garbage', 'the corrupt file is not fetched over')
    } finally {
      await writeFile(cachedMs, pristine)
    }
  })

  test('tarball URLs recorded in the lockfile (lockfileIncludeTarballUrl) must be the registry\'s own', async (t) => {
    // Rewrite every resolution the way `lockfileIncludeTarballUrl: true` records it.
    const withUrls = oracles.pnpm.files['pnpm-lock.yaml'].replaceAll(/^ {2}'?(@?[^'\n]+?)@([^'(\n]+)'?:\n {4}resolution: \{integrity: ([^}]+)\}/gmu, (m, name, version, integrity) => {
      const basename = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
      return `  ${name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`}:\n    resolution: {integrity: ${integrity}, tarball: https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz}`
    })
    t.assert.equal((withUrls.match(/tarball: https:\/\//gu) ?? []).length, 86, 'every package got a URL')
    const workspace = { 'pnpm-workspace.yaml': 'lockfileIncludeTarballUrl: true\n' }
    t.assert.equal((await build(projectVfs('pnpm', { ...workspace, 'pnpm-lock.yaml': withUrls }))).bundle.serialize(), oracles.pnpm.bundle)
    // One URL off the registry, or naming another version's tarball: the build fails before
    // anything is fetched.
    await Promise.all(['https://evil.example/ms/-/ms-2.1.3.tgz', 'https://registry.npmjs.org/ms/-/ms-2.1.2.tgz'].map((url) => {
      const vfs = projectVfs('pnpm', { ...workspace, 'pnpm-lock.yaml': withUrls.replace('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', url) })
      return t.assert.rejects(build(vfs), /"ms@2\.1\.3": only packages from https:\/\/registry\.npmjs\.org\/ are supported/u)
    }))
  })
})

describe('buildVfsBundle with yarn1, its lockfile', { concurrency: 1 }, () => {
  test('the tree is yarn\'s hoisted one', async (t) => {
    const bundle = Bundle.parse(oracles.yarn1.bundle)
    t.assert.ok(bundle.modules.has('node_modules/send/node_modules/debug/node_modules/ms'))
    const tree = await loadNodeModules({ vfs: projectVfs('yarn1'), packageManager: 'yarn1', cwd: '/src' })
    t.assert.equal(tree.root, '/')
    t.assert.equal(tree.packageManagerVersion, '1.22.22', 'as the fixture\'s packageManager pins')
    t.assert.deepEqual(tree.vfs.readdir('/node_modules/express/node_modules'), ['debug', 'ms'])
  })

  test('a resolved URL off the registry is refused', async (t) => {
    const lock = oracles.yarn1.files['yarn.lock']
    const offRegistry = lock.replace('https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz', 'https://evil.example/ms/-/ms-2.1.3.tgz')
    t.assert.notEqual(offRegistry, lock)
    await t.assert.rejects(buildVfsBundle({ vfs: projectVfs('yarn1', { 'yarn.lock': offRegistry }), packageManager: 'yarn1', entries: ['src/entry.js'] }), /"ms@2\.1\.3": only the registry's own tarball of ms@2\.1\.3, https:\/\/registry\.npmjs\.org\/ms\/-\/ms-2\.1\.3\.tgz, is supported/u)
  })
})

test('buildVfsBundle refuses layouts and options it cannot reproduce', async (t) => {
  const build = (options) => buildVfsBundle({ packageManager: 'pnpm', entries: ['src/entry.js'], ...options })
  await t.assert.rejects(build({ vfs: projectVfs('pnpm', { '.npmrc': 'node-linker=hoisted\n' }) }), /\.npmrc:1: node-linker: "hoisted" is not supported/u)
  const noLock = projectVfs('pnpm')
  noLock.rm('/pnpm-lock.yaml')
  await t.assert.rejects(build({ vfs: noLock }), /no pnpm-lock\.yaml found/u)
  await t.assert.rejects(build({ vfs: projectVfs('pnpm'), packageManager: 'yarn1' }), /no yarn\.lock found/u)
  await t.assert.rejects(build({ vfs: new Vfs(), entries: ['a.sol'] }), /^Error: buildVfsBundle: only JS bundles are built with pnpm$/u)
  await t.assert.rejects(build({ vfs: new Vfs(), entries: ['a.js'], metro: true, metroResolver: true, platforms: ['ios'] }), /^Error: buildVfsBundle: metroResolver is not supported/u)
  await t.assert.rejects(build({ entries: ['a.js'] }), /^TypeError: buildVfsBundle: vfs must be a @preventive\/vfs Vfs holding the project/u)
})
