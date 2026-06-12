import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync, gzipSync } from 'node:zlib'

import tar from 'tar-stream'

import { Bundle } from '../src/bundle.js'
import { extractNpmTarball, parseNpmSpec } from '../src/cmd/npm.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'stasis.js')

// Build a gzipped npm-style tarball in memory. Entries may be plain string
// bodies, or { header, body } to control the tar header (e.g. symlinks).
const makeTgz = async (files, { prefix = 'package' } = {}) => {
  const pack = tar.pack()
  const chunks = []
  pack.on('data', (c) => chunks.push(c))
  for (const [name, entry] of Object.entries(files)) {
    if (typeof entry === 'string' || Buffer.isBuffer(entry)) {
      pack.entry({ name: `${prefix}/${name}` }, entry)
    } else {
      pack.entry({ name: `${prefix}/${name}`, ...entry.header }, entry.body)
    }
  }
  pack.finalize()
  await once(pack, 'end')
  return gzipSync(Buffer.concat(chunks))
}

const sri = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`
const sha1hex = (buf) => createHash('sha1').update(buf).digest('hex')

// --- fixture packages ---

// type=module package exercising every entry-point source: exports
// (conditions incl. types/browser/react-native), main, browser map,
// react-native string, wildcard + non-JS exports (skipped), unused files.
const fakePkgFiles = {
  'package.json': JSON.stringify({
    name: 'fake-npm-pkg',
    version: '1.2.3',
    type: 'module',
    main: './main.cjs',
    exports: {
      '.': {
        types: './index.d.ts',
        'react-native': './rn.js',
        browser: './browser.js',
        default: './index.js',
      },
      './extra': './extra.js',
      './styles': './styles.css',
      './pattern/*': './pattern/*.js',
    },
    browser: { './index.js': './browser.js' },
    'react-native': './rn.js',
  }),
  'index.js': "import './shared.js'\nimport 'left-pad'\nexport const main = 'esm'\n",
  'shared.js': 'export const shared = 1\n',
  'browser.js': "import { shared } from './shared.js'\nexport const b = shared\n",
  'rn.js': 'export const rn = true\n',
  'extra.js': 'export const extra = true\n',
  'main.cjs': "module.exports = require('./cjs-dep.cjs')\n",
  'cjs-dep.cjs': 'module.exports = 42\n',
  'index.d.ts': 'export declare const main: string\n',
  'unused.js': 'export const unused = true\n',
  'styles.css': 'body {}\n',
  'pattern/a.js': 'export const a = 1\n',
}

// shasum-only (pre-SRI) metadata variant, reachable via the `beta` dist-tag.
const betaPkgFiles = {
  'package.json': JSON.stringify({ name: 'fake-npm-pkg', version: '2.0.0-beta.1', main: 'index.js' }),
  'index.js': 'module.exports = 1\n',
}

// No exports, extensionless main -> Node's legacy `${main}.js` fallback.
// Packed under a non-"package" prefix: npm strips one component regardless.
const legacyPkgFiles = {
  'package.json': JSON.stringify({ name: 'legacy-pkg', version: '0.5.0', main: 'lib/entry' }),
  'lib/entry.js': "require('./util.js')\nmodule.exports = 1\n",
  'lib/util.js': 'module.exports = 2\n',
}

// Static ESM import of a missing RELATIVE file: must stay fatal even though
// missing bare specifiers are tolerated on the --npm path.
const brokenPkgFiles = {
  'package.json': JSON.stringify({ name: 'broken-pkg', version: '1.0.0', type: 'module', exports: './index.js' }),
  'index.js': "import './missing.js'\n",
}

// Used only by the caching tests so request counts aren't shared with others.
const cachePkgFiles = {
  'package.json': JSON.stringify({ name: 'cache-pkg', version: '1.0.0', main: 'index.js' }),
  'index.js': 'module.exports = 1\n',
}

let server
let baseURL
const hits = new Map() // url path -> request count
const routes = new Map() // url path -> { body, type }

const addPackage = (name, versionsByTag, tgzByVersion, { integrityOverride, shasumOnly } = {}) => {
  const versions = {}
  for (const [version, tgz] of Object.entries(tgzByVersion)) {
    const tarballPath = `/${name}/-/${name}-${version}.tgz`
    routes.set(tarballPath, { body: tgz, type: 'application/octet-stream' })
    const dist = { tarball: `${baseURL}${tarballPath}` }
    if (shasumOnly) dist.shasum = sha1hex(tgz)
    else dist.integrity = integrityOverride ?? sri(tgz)
    versions[version] = { name, version, dist }
  }
  const meta = { name, 'dist-tags': versionsByTag, versions }
  routes.set(`/${name}`, { body: JSON.stringify(meta), type: 'application/json' })
}

before(async () => {
  server = createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1)
    const route = routes.get(req.url)
    if (!route) {
      res.statusCode = 404
      res.end('{"error":"Not found"}')
      return
    }
    res.setHeader('content-type', route.type)
    res.end(route.body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseURL = `http://127.0.0.1:${server.address().port}`

  const fakeTgz = await makeTgz(fakePkgFiles)
  const betaTgz = await makeTgz(betaPkgFiles)
  addPackage('fake-npm-pkg', { latest: '1.2.3' }, { '1.2.3': fakeTgz })
  // merge the shasum-only beta version into the same packument
  {
    const meta = JSON.parse(routes.get('/fake-npm-pkg').body)
    const tarballPath = '/fake-npm-pkg/-/fake-npm-pkg-2.0.0-beta.1.tgz'
    routes.set(tarballPath, { body: betaTgz, type: 'application/octet-stream' })
    meta['dist-tags'].beta = '2.0.0-beta.1'
    meta.versions['2.0.0-beta.1'] = {
      name: 'fake-npm-pkg',
      version: '2.0.0-beta.1',
      dist: { tarball: `${baseURL}${tarballPath}`, shasum: sha1hex(betaTgz) },
    }
    routes.set('/fake-npm-pkg', { body: JSON.stringify(meta), type: 'application/json' })
  }

  addPackage('legacy-pkg', { latest: '0.5.0' }, { '0.5.0': await makeTgz(legacyPkgFiles, { prefix: 'legacy-pkg-0.5.0' }) })
  addPackage('broken-pkg', { latest: '1.0.0' }, { '1.0.0': await makeTgz(brokenPkgFiles) })
  addPackage('cache-pkg', { latest: '1.0.0' }, { '1.0.0': await makeTgz(cachePkgFiles) })
  // metadata advertises an integrity that the served tarball can never match
  addPackage('evil-pkg', { latest: '1.0.0' }, { '1.0.0': await makeTgz(cachePkgFiles) }, {
    integrityOverride: sri(Buffer.from('not the real tarball')),
  })
})

after(() => server.close())

const cleanEnv = (() => {
  const {
    EXODUS_STASIS_LOCK: _l,
    EXODUS_STASIS_SCOPE: _s,
    EXODUS_STASIS_BUNDLE: _b,
    EXODUS_STASIS_BUNDLE_FILE: _bf,
    EXODUS_STASIS_DEBUG: _d,
    ...rest
  } = process.env
  return rest
})()

// Async spawn, NOT spawnSync: the CLI talks to the registry server living in
// THIS process, and spawnSync would block the event loop the server needs to
// answer -- the connection would sit in the accept queue until the timeout.
const runCli = async (args, { cacheDir } = {}) => {
  const child = spawn(process.execPath, [cli, ...args], {
    env: {
      ...cleanEnv,
      EXODUS_STASIS_NPM_REGISTRY: baseURL,
      ...(cacheDir ? { EXODUS_STASIS_CACHE_DIR: cacheDir } : {}),
    },
  })
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
  const dir = mkdtempSync(join(tmpdir(), 'stasis-npm-test-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const decode = (path) => Bundle.parseCode(brotliDecompressSync(readFileSync(path)).toString('utf8'))

// --- unit: spec parsing ---

test('parseNpmSpec splits name and version, defaulting to latest', (t) => {
  t.assert.deepEqual(parseNpmSpec('lodash'), { name: 'lodash', version: 'latest' })
  t.assert.deepEqual(parseNpmSpec('lodash@4.17.21'), { name: 'lodash', version: '4.17.21' })
  t.assert.deepEqual(parseNpmSpec('@scope/pkg'), { name: '@scope/pkg', version: 'latest' })
  t.assert.deepEqual(parseNpmSpec('@scope/pkg@1.0.0'), { name: '@scope/pkg', version: '1.0.0' })
  t.assert.deepEqual(parseNpmSpec('pkg@^2.0.0'), { name: 'pkg', version: '^2.0.0' })
  t.assert.throws(() => parseNpmSpec('pkg@'), /Invalid npm package spec/)
  t.assert.throws(() => parseNpmSpec(''), /Expected an npm package spec/)
})

// --- unit: tarball extraction ---

test('extractNpmTarball strips any top-level prefix and keys files by package-relative path', async (t) => {
  const tgz = await makeTgz({ 'package.json': '{}', 'lib/a.js': 'x' }, { prefix: 'whatever-9.9.9' })
  const files = await extractNpmTarball(tgz)
  t.assert.deepEqual([...files.keys()].toSorted(), ['lib/a.js', 'package.json'])
  t.assert.equal(files.get('lib/a.js').toString(), 'x')
})

test('extractNpmTarball rejects symlink and hardlink entries', async (t) => {
  const sym = await makeTgz({
    'package.json': '{}',
    'link.js': { header: { type: 'symlink', linkname: '../../etc/passwd' } },
  })
  await t.assert.rejects(() => extractNpmTarball(sym), /Refusing symlink entry/)
})

test('extractNpmTarball rejects paths escaping the package root', async (t) => {
  const pack = tar.pack()
  const chunks = []
  pack.on('data', (c) => chunks.push(c))
  pack.entry({ name: 'package/../escape.js' }, 'x')
  pack.finalize()
  await once(pack, 'end')
  const tgz = gzipSync(Buffer.concat(chunks))
  await t.assert.rejects(() => extractNpmTarball(tgz), /escaping the package root/)
})

test('extractNpmTarball rejects non-gzip data', async (t) => {
  await t.assert.rejects(() => extractNpmTarball(Buffer.from('definitely not gzip')), /not valid gzip/)
})

// --- CLI: end-to-end against the local registry ---

test('CLI: bundle --npm <name> fetches latest and derives entries from exports/main/browser/react-native, excluding types', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.stasis.code.br')
  const r = await runCli(['bundle', '--npm', 'fake-npm-pkg', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const parsed = decode(out)
  // Entry points: exports leaves (default/browser/react-native + subpath) and
  // legacy main. NOT the types target, the .css export, or the wildcard pattern.
  t.assert.deepEqual(
    [...parsed.entries].toSorted(),
    ['browser.js', 'extra.js', 'index.js', 'main.cjs', 'rn.js'],
  )

  // The single "." bucket carries the package's own identity.
  t.assert.deepEqual([...parsed.modules.keys()], ['.'])
  const workspace = parsed.modules.get('.')
  t.assert.equal(workspace.name, 'fake-npm-pkg')
  t.assert.equal(workspace.version, '1.2.3')

  // Reachable internal files are bundled; unreachable/type/non-JS files are not.
  const files = Object.keys(workspace.files).toSorted()
  t.assert.deepEqual(files, [
    'browser.js', 'cjs-dep.cjs', 'extra.js', 'index.js', 'main.cjs', 'rn.js', 'shared.js',
  ])
  t.assert.equal(workspace.files['shared.js'], fakePkgFiles['shared.js'])

  t.assert.equal(parsed.formats.get('index.js'), 'module')
  t.assert.equal(parsed.formats.get('main.cjs'), 'commonjs')
  t.assert.equal(parsed.imports.get('*').get('index.js').get('./shared.js'), 'shared.js')

  // The dependency import can't resolve (no dep tree in a lone tarball): it
  // is tolerated with a warning, not fatal.
  t.assert.match(r.stderr, /unresolved import/)
  t.assert.match(r.stderr, /left-pad/)
  t.assert.match(r.stderr, /\[stasis\] Bundled 7 files in 1 package from fake-npm-pkg@1\.2\.3 to /)
}))

test('CLI: bundle --npm name@version, @dist-tag, and @range all resolve through the registry', withTmp(async (t, tmp) => {
  const cacheDir = join(tmp, 'cache')

  const exact = await runCli(['bundle', '--npm', 'fake-npm-pkg@1.2.3', '-o', join(tmp, 'exact.br')], { cacheDir })
  t.assert.equal(exact.status, 0, `stderr: ${exact.stderr}`)
  t.assert.equal(decode(join(tmp, 'exact.br')).modules.get('.').version, '1.2.3')

  // dist-tag -> the shasum-only (pre-SRI) version, exercising the sha1 fallback
  const tag = await runCli(['bundle', '--npm', 'fake-npm-pkg@beta', '-o', join(tmp, 'tag.br')], { cacheDir })
  t.assert.equal(tag.status, 0, `stderr: ${tag.stderr}`)
  t.assert.equal(decode(join(tmp, 'tag.br')).modules.get('.').version, '2.0.0-beta.1')

  const range = await runCli(['bundle', '--npm', 'fake-npm-pkg@^1.0.0', '-o', join(tmp, 'range.br')], { cacheDir })
  t.assert.equal(range.status, 0, `stderr: ${range.stderr}`)
  t.assert.equal(decode(join(tmp, 'range.br')).modules.get('.').version, '1.2.3')
}))

test('CLI: bundle --npm resolves an extensionless legacy main via the .js fallback', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.br')
  const r = await runCli(['bundle', '--npm', 'legacy-pkg', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = decode(out)
  t.assert.deepEqual([...parsed.entries], ['lib/entry.js'])
  t.assert.deepEqual(
    Object.keys(parsed.modules.get('.').files).toSorted(),
    ['lib/entry.js', 'lib/util.js'],
  )
  t.assert.equal(parsed.modules.get('.').name, 'legacy-pkg')
}))

test('CLI: bundle --npm --lockfile writes a lockfile attesting the bundled files', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.br')
  const lockPath = join(tmp, 'stasis.lock.json')
  const r = await runCli(
    ['bundle', '--npm', 'legacy-pkg', `--lockfile=${lockPath}`, '-o', out],
    { cacheDir: join(tmp, 'cache') },
  )
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  t.assert.equal(lock.config.scope, 'full')
  t.assert.deepEqual(lock.entries, ['lib/entry.js'])
  // The package's own files live in the workspace "." bucket, which the
  // lockfile serializes under `sources` (modules is node_modules-only).
  t.assert.deepEqual(lock.modules, {})
  const { name, version, files } = lock.sources['.']
  t.assert.equal(name, 'legacy-pkg')
  t.assert.equal(version, '0.5.0')
  t.assert.deepEqual(Object.keys(files).toSorted(), ['lib/entry.js', 'lib/util.js'])
  for (const hash of Object.values(files)) t.assert.match(hash, /^sha512-/)
}))

test('CLI: bundle --npm fails on a version/package the registry does not have, writing no output', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.br')
  const missingVersion = await runCli(['bundle', '--npm', 'fake-npm-pkg@9.9.9', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.notEqual(missingVersion.status, 0)
  t.assert.match(missingVersion.stderr, /No version matching "9\.9\.9"/)
  t.assert.ok(!existsSync(out))

  const missingPkg = await runCli(['bundle', '--npm', 'no-such-pkg-here', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.notEqual(missingPkg.status, 0)
  t.assert.match(missingPkg.stderr, /Package not found on the npm registry: no-such-pkg-here/)
  t.assert.ok(!existsSync(out))
}))

test('CLI: bundle --npm stays fatal on a broken relative import inside the package', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.br')
  const r = await runCli(['bundle', '--npm', 'broken-pkg', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /JS bundle would be broken at load time/)
  t.assert.match(r.stderr, /\.\/missing\.js/)
  t.assert.ok(!existsSync(out))
}))

test('CLI: bundle --npm caches the tarball and reuses it without re-downloading', withTmp(async (t, tmp) => {
  const cacheDir = join(tmp, 'cache')
  const tgzPath = '/cache-pkg/-/cache-pkg-1.0.0.tgz'
  const tgzHitsBefore = hits.get(tgzPath) ?? 0

  const first = await runCli(['bundle', '--npm', 'cache-pkg', '-o', join(tmp, 'a.br')], { cacheDir })
  t.assert.equal(first.status, 0, `stderr: ${first.stderr}`)
  t.assert.equal(hits.get(tgzPath), tgzHitsBefore + 1)
  const cachedTgz = join(cacheDir, 'npm', 'cache-pkg-1.0.0.tgz')
  t.assert.ok(existsSync(cachedTgz), 'tarball must be cached on disk')

  const second = await runCli(['bundle', '--npm', 'cache-pkg', '-o', join(tmp, 'b.br')], { cacheDir })
  t.assert.equal(second.status, 0, `stderr: ${second.stderr}`)
  t.assert.equal(hits.get(tgzPath), tgzHitsBefore + 1, 'second run must be served from the cache')
}))

test('CLI: bundle --npm re-verifies the cache on load and refetches a corrupted tarball', withTmp(async (t, tmp) => {
  const cacheDir = join(tmp, 'cache')
  const tgzPath = '/cache-pkg/-/cache-pkg-1.0.0.tgz'

  const first = await runCli(['bundle', '--npm', 'cache-pkg', '-o', join(tmp, 'a.br')], { cacheDir })
  t.assert.equal(first.status, 0, `stderr: ${first.stderr}`)

  // Corrupt the cached tarball: the next run must notice (integrity check on
  // every load), refetch, and still succeed.
  const cachedTgz = join(cacheDir, 'npm', 'cache-pkg-1.0.0.tgz')
  writeFileSync(cachedTgz, 'corrupted bytes')
  const tgzHitsBefore = hits.get(tgzPath)

  const second = await runCli(['bundle', '--npm', 'cache-pkg', '-o', join(tmp, 'b.br')], { cacheDir })
  t.assert.equal(second.status, 0, `stderr: ${second.stderr}`)
  t.assert.match(second.stderr, /Cached tarball failed integrity check, refetching/)
  t.assert.equal(hits.get(tgzPath), tgzHitsBefore + 1, 'corrupt cache must trigger a refetch')
  t.assert.notEqual(readFileSync(cachedTgz, 'utf8'), 'corrupted bytes', 'cache must be healed')
}))

test('CLI: bundle --npm rejects a download that does not match the registry integrity', withTmp(async (t, tmp) => {
  const out = join(tmp, 'out.br')
  const r = await runCli(['bundle', '--npm', 'evil-pkg', '-o', out], { cacheDir: join(tmp, 'cache') })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Tarball integrity mismatch/)
  t.assert.ok(!existsSync(out), 'no output may be written for an unverifiable tarball')
  t.assert.ok(!existsSync(join(tmp, 'cache', 'npm', 'evil-pkg-1.0.0.tgz')), 'unverifiable bytes must not be cached')
}))

// --- CLI: flag validation ---

test('CLI: bundle --npm rejects positional entry files', async (t) => {
  const r = await runCli(['bundle', '--npm', 'fake-npm-pkg', 'extra.js'])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--npm takes no entry files/)
})

test('CLI: bundle --npm rejects --scope and --mapping', async (t) => {
  const scoped = await runCli(['bundle', '--npm', 'fake-npm-pkg', '--scope=full'])
  t.assert.equal(scoped.status, 1)
  t.assert.match(scoped.stderr, /--scope is not valid with --npm/)

  const mapped = await runCli(['bundle', '--npm', 'fake-npm-pkg', '--mapping=remappings.txt'])
  t.assert.equal(mapped.status, 1)
  t.assert.match(mapped.stderr, /--mapping is not valid with --npm/)
})

test('CLI: bundle --npm= (empty) prints usage', async (t) => {
  const r = await runCli(['bundle', '--npm='])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /--npm requires a package spec/)
})
