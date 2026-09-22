import { before, describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { buildBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'

// `stasis bundle --pnpm` builds from pnpm-lock.yaml alone: tarballs fetched into a cache and
// verified, unpacked in memory, laid out as pnpm's isolated node_modules, then scanned like any
// other static bundle. The fixture is the popular-npm-modules package set under pnpm's DEFAULT
// (isolated) layout, so the oracle is simple: a real `pnpm install` + plain `stasis bundle` must
// produce the byte-identical artifact.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixture = join(here, 'fixtures', 'pnpm-bundle')

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
    STASIS_PNPM_CACHE: _c,
    ...rest
  } = process.env
  return { ...rest, EXODUS_STASIS_BROTLI_QUALITY: '5' }
})()

const run = async (args, opts = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { env: cleanEnv, ...opts })
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
  const dir = await mkdtemp(join(tmpdir(), 'stasis-pnpm-bundle-'))
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

// The lockfile-side project: the fixture WITHOUT its node_modules (nothing installed at all).
const bareCopy = async (dir) => {
  await mkdir(dir, { recursive: true })
  await Promise.all([
    ...['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((f) => cp(join(fixture, f), join(dir, f))),
    cp(join(fixture, 'src'), join(dir, 'src'), { recursive: true }),
  ])
}

const decode = (buf) => brotliDecompressSync(buf).toString('utf-8')

// One tarball cache for the whole file: the first test pays the downloads, the rest read the cache.
let cacheDir
let installedCopy
let realBundle
let realLock

before(async () => {
  if (!existsSync(join(fixture, 'node_modules', '.pnpm'))) {
    const child = spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], { cwd: fixture })
    const stderrChunks = []
    child.stderr.on('data', (d) => stderrChunks.push(d))
    const [status] = await once(child, 'close')
    if (status !== 0) throw new Error(`Failed to install fixture deps in ${fixture}: ${Buffer.concat(stderrChunks).toString('utf-8')}`)
  }
  cacheDir = await mkdtemp(join(tmpdir(), 'stasis-pnpm-cache-'))
  // The oracle: the plain static bundle over the real isolated install.
  installedCopy = await mkdtemp(join(tmpdir(), 'stasis-pnpm-installed-'))
  await hardlinkCopy(fixture, installedCopy)
  const r = await run(['bundle', '--scope=full', `--output=${join(installedCopy, 'real.br')}`, `--lockfile=${join(installedCopy, 'real.lock.json')}`, 'src/entry.js'], { cwd: installedCopy })
  if (r.status !== 0) throw new Error(`Failed to build the oracle bundle: ${r.stderr}`)
  realBundle = decode(await readFile(join(installedCopy, 'real.br')))
  realLock = await readFile(join(installedCopy, 'real.lock.json'), 'utf-8')
})

describe('stasis bundle --pnpm', { concurrency: 1 }, () => {
  test('builds, from the lockfile alone, the byte-identical bundle + lockfile a real pnpm install yields', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    t.assert.ok(!existsSync(join(tmp, 'node_modules')), 'nothing is installed on the lockfile side')
    const r = await run(['bundle', '--pnpm', `--pnpm-cache=${cacheDir}`, '--scope=full', `--output=${join(tmp, 'virtual.br')}`, `--lockfile=${join(tmp, 'virtual.lock.json')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stderr, /\[stasis\] pnpm: 86 snapshots in pnpm-lock\.yaml, 86 tarballs to verify/u)
    t.assert.match(r.stderr, /all integrity-verified/u)
    t.assert.match(r.stderr, /Bundled 299 files in 87 packages/u)
    t.assert.equal(decode(await readFile(join(tmp, 'virtual.br'))), realBundle)
    t.assert.equal(await readFile(join(tmp, 'virtual.lock.json'), 'utf-8'), realLock)
    // The tree stayed in memory: no node_modules appeared, and the cache holds only tarballs.
    t.assert.ok(!existsSync(join(tmp, 'node_modules')))
    const cached = await readdir(join(cacheDir, 'sha512'))
    t.assert.equal(cached.length, 86)
    t.assert.ok(cached.every((f) => f.endsWith('.tgz')))
    // Paths are pnpm's real virtual-store paths, peer suffixes included.
    const bundle = Bundle.parse(realBundle)
    t.assert.ok(bundle.modules.has('node_modules/.pnpm/axios@1.7.7_debug@4.3.6/node_modules/axios'))
    t.assert.ok(bundle.modules.has('node_modules/.pnpm/follow-redirects@1.16.0_debug@4.3.6/node_modules/follow-redirects'))
  }))

  test('a second build is served from the cache, also --pnpm-offline; an empty cache offline fails closed', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    const warm = await run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${cacheDir}`, '--scope=full', `--output=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.equal(warm.status, 0, `stderr: ${warm.stderr}`)
    t.assert.match(warm.stderr, /pnpm: 0 downloaded, 86 from cache/u)
    t.assert.equal(decode(await readFile(join(tmp, 'v.br'))), realBundle)
    const cold = await run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${join(tmp, 'empty-cache')}`, '--scope=full', `--output=${join(tmp, 'v2.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(cold.status, 0)
    t.assert.match(cold.stderr, /is not in the tarball cache .* and --pnpm-offline forbids downloading it/u)
    t.assert.ok(!existsSync(join(tmp, 'v2.br')), 'no bundle is written when a tarball is missing')
  }))

  test('--package-json, --mainFields, --metro and node_modules scope match the real install too', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    const variants = [['--package-json', '--scope=full'], ['--mainFields=browser,main'], ['--scope=node_modules'], ['--metro', '--platforms=ios,android', '--package-json']]
    await Promise.all(variants.map(async (variant) => {
      const name = variant.join('_').replaceAll(/[^\w]/gu, '_')
      const [real, virtual] = await Promise.all([
        run(['bundle', ...variant, `--output=${join(installedCopy, `${name}.br`)}`, `--lockfile=${join(installedCopy, `${name}.lock.json`)}`, 'src/entry.js'], { cwd: installedCopy }),
        run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${cacheDir}`, ...variant, `--output=${join(tmp, `${name}.br`)}`, `--lockfile=${join(tmp, `${name}.lock.json`)}`, 'src/entry.js'], { cwd: tmp }),
      ])
      t.assert.equal(real.status, 0, `real ${variant}: ${real.stderr}`)
      t.assert.equal(virtual.status, 0, `virtual ${variant}: ${virtual.stderr}`)
      const [vb, rb, vl, rl] = await Promise.all([
        readFile(join(tmp, `${name}.br`)), readFile(join(installedCopy, `${name}.br`)),
        readFile(join(tmp, `${name}.lock.json`), 'utf-8'), readFile(join(installedCopy, `${name}.lock.json`), 'utf-8'),
      ])
      t.assert.equal(decode(vb), decode(rb), `bundle for ${variant.join(' ')}`)
      t.assert.equal(vl, rl, `lockfile for ${variant.join(' ')}`)
    }))
  }))

  test('the lockfile-built bundle loads (--bundle=load) and its lockfile verifies (--lock=frozen) against the real install', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    const r = await run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${cacheDir}`, '--scope=full', `--output=${join(tmp, 'v.br')}`, `--lockfile=${join(tmp, 'v.lock.json')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const load = await run(['run', '--lock=none', '--bundle=load', `--bundle-file=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: installedCopy })
    t.assert.equal(load.status, 0, `load stderr: ${load.stderr}`)
    t.assert.equal(load.stdout, expectedOutput)
    await writeFile(join(installedCopy, 'stasis.lock.json'), await readFile(join(tmp, 'v.lock.json')))
    try {
      const frozen = await run(['run', '--lock=frozen', 'src/entry.js'], { cwd: installedCopy })
      t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)
      t.assert.equal(frozen.stdout, expectedOutput)
    } finally {
      await rm(join(installedCopy, 'stasis.lock.json'), { force: true })
    }
  }))

  test('whatever is installed on disk is ignored: a tampered node_modules does not reach the bundle', withTmp(async (t, tmp) => {
    await hardlinkCopy(fixture, tmp)
    const victim = join(tmp, 'node_modules', '.pnpm', 'lodash@4.17.21', 'node_modules', 'lodash', 'lodash.js')
    await unlink(victim) // break the hardlink before writing
    await writeFile(victim, 'module.exports = "TAMPERED"\n')
    const r = await run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${cacheDir}`, '--scope=full', `--output=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const text = decode(await readFile(join(tmp, 'v.br')))
    t.assert.equal(text, realBundle)
    t.assert.doesNotMatch(text, /TAMPERED/u)
  }))

  test('a lockfile integrity that does not match the registry tarball fails closed and writes nothing', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    const lock = await readFile(join(tmp, 'pnpm-lock.yaml'), 'utf-8')
    const bogus = `sha512-${'A'.repeat(86)}==`
    const tampered = lock.replace(/(ms@2\.1\.3:\n\s+resolution: \{integrity: )sha512-[^}]+/u, `$1${bogus}`)
    t.assert.notEqual(tampered, lock)
    await writeFile(join(tmp, 'pnpm-lock.yaml'), tampered)
    const r = await run(['bundle', '--pnpm', `--pnpm-cache=${cacheDir}`, '--scope=full', `--output=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /integrity mismatch for ms@2\.1\.3/u)
    t.assert.ok(!existsSync(join(tmp, 'v.br')))
  }))

  test('the programmatic API takes the same options', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    const bundle = await buildBundle({ cwd: tmp, entries: ['src/entry.js'], scope: 'full', pnpm: true, pnpmCache: cacheDir, pnpmOffline: true })
    t.assert.ok(bundle instanceof Bundle)
    t.assert.equal(bundle.serialize(), realBundle)
    await bundleCommand({ cwd: tmp, entries: ['src/entry.js'], scope: 'full', pnpm: true, pnpmCache: cacheDir, pnpmOffline: true, output: join(tmp, 'api.br'), lockfile: join(tmp, 'api.lock.json'), brotliQuality: 5 })
    t.assert.equal(decode(await readFile(join(tmp, 'api.br'))), realBundle)
    t.assert.ok(Lockfile.parse(await readFile(join(tmp, 'api.lock.json'), 'utf-8')).modules.size > 80)
  }))

  test('rejects layouts and flag combinations it cannot reproduce', withTmp(async (t, tmp) => {
    await bareCopy(tmp)
    await writeFile(join(tmp, '.npmrc'), 'node-linker=hoisted\n')
    const hoisted = await run(['bundle', '--pnpm', '--pnpm-offline', `--pnpm-cache=${cacheDir}`, `--output=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(hoisted.status, 0)
    t.assert.match(hoisted.stderr, /node-linker=hoisted is not supported/u)
    await rm(join(tmp, '.npmrc'))
    await rm(join(tmp, 'pnpm-lock.yaml'))
    const noLock = await run(['bundle', '--pnpm', `--output=${join(tmp, 'v.br')}`, 'src/entry.js'], { cwd: tmp })
    t.assert.notEqual(noLock.status, 0)
    t.assert.match(noLock.stderr, /no pnpm-lock\.yaml found/u)
    t.assert.ok(!existsSync(join(tmp, 'v.br')))

    const sol = await run(['bundle', '--pnpm', 'a.sol'])
    t.assert.equal(sol.status, 1)
    t.assert.match(sol.stderr, /--pnpm is only valid for JS bundles/u)
    const cache = await run(['bundle', '--pnpm-cache=/x', 'a.js'])
    t.assert.equal(cache.status, 1)
    t.assert.match(cache.stderr, /--pnpm-cache is only valid with --pnpm/u)
    const offline = await run(['bundle', '--pnpm-offline', 'a.js'])
    t.assert.equal(offline.status, 1)
    t.assert.match(offline.stderr, /--pnpm-offline is only valid with --pnpm/u)
    const metroResolver = await run(['bundle', '--pnpm', '--metro', '--metro-resolver', '--platforms=ios', 'a.js'])
    t.assert.equal(metroResolver.status, 1)
    t.assert.match(metroResolver.stderr, /--metro-resolver is not supported with --pnpm/u)
    await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['a.sol'], pnpm: true }), /--pnpm is only valid for JS bundles/u)
    await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['a.js'], pnpmCache: '/x' }), /--pnpm-cache is only valid with --pnpm/u)
    await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['a.js'], pnpm: true, metro: true, metroResolver: true, platforms: ['ios'] }), /--metro-resolver is not supported with --pnpm/u)
  }))
})
