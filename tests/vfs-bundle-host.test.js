import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { Vfs, createVfsHost, loadNodeModules } from '../stasis/src/vfs-bundle.js'
import { createNodeResolver } from '../stasis/src/resolve-node.js'
import { loadTsconfigPaths } from '../stasis/src/resolve-typescript.js'

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-vfs-bundle-host-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const write = (vfs, files) => {
  for (const [path, text] of Object.entries(files)) {
    vfs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
    vfs.writeFile(path, typeof text === 'string' ? text : JSON.stringify(text))
  }
  return vfs
}

test('a Vfs host follows the store\'s symlinks, reports stats as fs does, and resolves through them', (t) => {
  // A tree as @preventive/deptree lays one out, beside the project it links back into.
  const vfs = write(new Vfs(), {
    '/package.json': { name: 'proj', version: '1.0.0' },
    '/src/entry.js': 'require("dep")',
    '/packages/ws/package.json': { name: 'ws', version: '1.0.0', main: 'lib.js' },
    '/packages/ws/lib.js': 'ws',
    '/node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': { name: 'dep', version: '1.0.0', exports: { require: './r.js', import: './i.mjs' } },
    '/node_modules/.pnpm/dep@1.0.0/node_modules/dep/i.mjs': 'i',
  })
  vfs.writeFile('/node_modules/.pnpm/dep@1.0.0/node_modules/dep/r.js', 'r', { mode: 0o755 })
  vfs.symlink('../../../../packages/ws', '/node_modules/.pnpm/dep@1.0.0/node_modules/ws')
  vfs.symlink('.pnpm/dep@1.0.0/node_modules/dep', '/node_modules/dep')
  vfs.symlink('loop2', '/node_modules/loop')
  vfs.symlink('loop', '/node_modules/loop2')
  t.assert.throws(() => createVfsHost(new Map()), /^TypeError: createVfsHost: vfs must be a @preventive\/vfs Vfs/u)

  const host = createVfsHost(vfs)
  const store = '/node_modules/.pnpm'
  t.assert.equal(host.realpath('/node_modules/dep/r.js'), `${store}/dep@1.0.0/node_modules/dep/r.js`)
  t.assert.equal(host.realpath(`${store}/dep@1.0.0/node_modules/ws/lib.js`), '/packages/ws/lib.js', 'a link out of the store lands in the project')
  t.assert.equal(host.readFile(`${store}/dep@1.0.0/node_modules/ws/lib.js`).toString(), 'ws')
  const r = host.readFile('/node_modules/dep/r.js')
  t.assert.ok(Buffer.isBuffer(r), 'the host hands out Buffers over the Vfs bytes')
  t.assert.equal(r.toString(), 'r')
  t.assert.equal(host.stat('/node_modules/dep/r.js').mode, 0o100755, 'S_IFREG on top of the Vfs mode')
  t.assert.equal(host.stat('/node_modules/dep/r.js').isFile(), true)
  t.assert.equal(host.stat('/node_modules/dep').isDirectory(), true)
  t.assert.equal(host.stat('/node_modules/dep').mode, 0o40755)
  t.assert.equal(host.readlink('/node_modules/dep'), '.pnpm/dep@1.0.0/node_modules/dep')
  t.assert.equal(host.readlink('/node_modules/dep/r.js'), null, 'through the link, a plain file')
  t.assert.equal(host.stat('/node_modules/missing'), null)
  t.assert.equal(host.stat('/node_modules/dep/r.js/below-a-file'), null)
  t.assert.throws(() => host.realpath('/node_modules/loop/x'), { code: 'ELOOP' })
  t.assert.deepEqual(host.readdir('/node_modules').map((d) => `${d.name}${d.isSymbolicLink() ? '@' : '/'}`), ['.pnpm/', 'dep@', 'loop@', 'loop2@'])
  t.assert.throws(() => host.readFile('/node_modules/dep'), { code: 'EISDIR' })
  t.assert.equal(host.findPackageJSON('/node_modules/dep/r.js'), `${store}/dep@1.0.0/node_modules/dep/package.json`, 'from the file\'s real path, as Node\'s')
  t.assert.equal(host.findPackageJSON('/src/entry.js'), '/package.json')
  // A trailing slash names a directory, as on disk.
  for (const file of ['/node_modules/dep/r.js', '/package.json']) {
    t.assert.equal(host.stat(`${file}/`), null)
    t.assert.equal(host.stat(`${file}/.`), null)
    t.assert.throws(() => host.readFile(`${file}/`), { code: 'ENOTDIR' })
    t.assert.throws(() => host.readlink(`${file}/`), { code: 'ENOTDIR' })
  }
  t.assert.equal(host.stat('/node_modules/dep/').isDirectory(), true)
  t.assert.equal(host.readlink('/node_modules/dep/'), null, 'the link followed, as lstat follows it')
  t.assert.throws(() => host.readlink('/node_modules/missing/'), { code: 'ENOENT' })

  // Resolution honours exports conditions and realpaths into the store.
  t.assert.equal(host.resolve('/src/entry.js', 'dep', new Set(['require', 'node'])), `${store}/dep@1.0.0/node_modules/dep/r.js`)
  t.assert.equal(host.resolve('/src/entry.js', 'dep', new Set(['import', 'node'])), `${store}/dep@1.0.0/node_modules/dep/i.mjs`)
  t.assert.equal(host.resolve(`${store}/dep@1.0.0/node_modules/dep/r.js`, 'ws', new Set(['require'])), '/packages/ws/lib.js')
  t.assert.throws(() => host.resolve('/src/entry.js', 'missing', new Set(['require'])), { code: 'MODULE_NOT_FOUND' })
  // Without conditions, require.resolve's own.
  t.assert.equal(host.resolve('/src/entry.js', 'dep'), `${store}/dep@1.0.0/node_modules/dep/r.js`)
  t.assert.equal(host.resolve('/src/entry.js', 'dep', ['import', 'node']), `${store}/dep@1.0.0/node_modules/dep/i.mjs`)
})

// A workspace whose lockfile locks no registry package: its tree is the projects' links alone.
const LOCKFILE = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', '  .:', '    dependencies:', '      base:', '        specifier: link:vendor/base', '        version: link:vendor/base', '      ws:', '        specifier: workspace:*', '        version: link:packages/ws', '', '  packages/ws: {}', ''].join('\n')
const workspace = () => write(new Vfs(), {
  '/p/package.json': { name: 'proj', version: '1.0.0', dependencies: { base: 'link:vendor/base', ws: 'workspace:*' } },
  '/p/pnpm-lock.yaml': LOCKFILE,
  '/p/pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  '/p/src/entry.js': 'require("ws")',
  '/p/packages/ws/package.json': { name: 'ws', version: '1.0.0', main: 'lib.js' },
  '/p/packages/ws/lib.js': 'ws',
  '/p/vendor/base/package.json': { name: 'base', version: '1.0.0' },
})

test('the host loadNodeModules gives serves each pnpm project\'s node_modules from the tree alone', async (t) => {
  const vfs = write(workspace(), {
    '/p/node_modules/installed/index.js': '',
    '/p/packages/ws/node_modules/wsdep/index.js': '',
    '/p/src/node_modules/vendored/index.js': '',
    '/node_modules/above/index.js': '',
  })
  const { root, projects, host } = await loadNodeModules({ vfs, packageManager: 'pnpm', cwd: '/p/src' })
  t.assert.equal(root, '/p')
  t.assert.deepEqual([...projects], ['.', 'packages/ws'])
  t.assert.equal(host.stat('/p/node_modules/installed/index.js'), null, 'what is installed in the project is invisible')
  t.assert.equal(host.stat('/p/packages/ws/node_modules/wsdep/index.js'), null, 'in every project')
  t.assert.equal(host.stat('/p/src/node_modules/vendored/index.js').isFile(), true, 'a node_modules pnpm never manages is the project\'s')
  t.assert.equal(host.stat('/node_modules/above/index.js'), null, 'and one above the root is none')
  t.assert.deepEqual(host.readdir('/').map((d) => d.name), ['p'])
  t.assert.deepEqual(host.readdir('/p').map((d) => d.name), ['node_modules', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src', 'vendor'], 'the project lists the tree\'s node_modules')
  t.assert.deepEqual(host.readdir('/p/node_modules').map((d) => d.name), ['.pnpm', 'base', 'ws'])
  t.assert.equal(host.realpath('/p/node_modules/ws/lib.js'), '/p/packages/ws/lib.js', 'a link out of the tree lands in the project')
  t.assert.equal(host.resolve('/p/src/entry.js', 'ws'), '/p/packages/ws/lib.js')
  t.assert.equal(host.stat('/p/package.json/'), null)
  t.assert.equal(host.readlink('/p/node_modules/ws/'), null)

  // A lockfile's directory named through a symlink lays out the same tree, by its real path.
  vfs.symlink('p', '/alias')
  const aliased = await loadNodeModules({ vfs, packageManager: 'pnpm', cwd: '/alias/src' })
  t.assert.equal(aliased.root, '/p')
  t.assert.equal(aliased.host.stat('/alias/node_modules/ws/lib.js').isFile(), true)
  t.assert.equal(aliased.host.stat('/alias/node_modules/installed/index.js'), null)
})

test('a Vfs of another copy of @preventive/vfs, its errors of classes of its own, is read as one', async (t) => {
  const vfs = workspace()
  const rethrow = (fn) => (...args) => {
    try {
      return fn(...args)
    } catch (err) {
      throw Object.assign(new Error(err.message), { code: err.code })
    }
  }
  const foreign = Object.fromEntries(['lstat', 'readdir', 'readFile', 'readlink'].map((method) => [method, rethrow(vfs[method].bind(vfs))]))
  const { host } = await loadNodeModules({ vfs: foreign, packageManager: 'pnpm', cwd: '/p/src' })
  t.assert.equal(host.resolve('/p/src/entry.js', 'ws'), '/p/packages/ws/lib.js')
  t.assert.equal(host.stat('/p/src/missing.js'), null)
  t.assert.equal(createVfsHost(foreign).stat('/p/src/missing.js'), null)
  t.assert.throws(() => createVfsHost({ lstat() {} }), /^TypeError: createVfsHost: vfs must be a @preventive\/vfs Vfs holding the project/u)
})

test('with yarn1, the installed node_modules of the root and of each workspace are the tree\'s alone', async (t) => {
  const vfs = write(new Vfs(), {
    '/package.json': { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] },
    '/yarn.lock': '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n',
    '/packages/a/package.json': { name: 'a', version: '1.0.0' },
    '/packages/a/index.js': '',
    '/packages/b/package.json': { name: 'b', version: '1.0.0', dependencies: { a: '1.0.0' } },
    '/packages/b/index.js': 'require("a")',
    '/node_modules/installed/index.js': '',
    '/packages/b/node_modules/a/index.js': 'installed',
    '/src/node_modules/vendored/index.js': '',
  })
  const { host } = await loadNodeModules({ vfs, packageManager: 'yarn1' })
  t.assert.equal(host.stat('/node_modules/installed/index.js'), null)
  t.assert.equal(host.stat('/packages/b/node_modules/a/index.js'), null)
  t.assert.equal(host.stat('/src/node_modules/vendored/index.js').isFile(), true)
  t.assert.deepEqual(host.readdir('/node_modules').map((d) => `${d.name}${d.isSymbolicLink() ? '@' : '/'}`), ['a@', 'b@'])
  t.assert.equal(host.resolve('/packages/b/index.js', 'a'), '/packages/a/index.js')
})

test('a Vfs host reads the Vfs alone, and a manifest that is no JSON object is refused as Node refuses it', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'on-disk.js'), '')
  const vfs = new Vfs()
  vfs.mkdir('/src', { recursive: true })
  vfs.writeFile('/package.json', '{"name":"p","version":"1.0.0","type":"module"}')
  vfs.writeFile('/src/a.js', 'import "dep"')
  vfs.mkdir('/node_modules/dep', { recursive: true })
  vfs.writeFile('/node_modules/dep/package.json', '{"name":"dep","version":"1.0.0","main":"i.js"}')
  vfs.writeFile('/node_modules/dep/i.js', '')
  vfs.mkdir('/bad', { recursive: true })
  vfs.writeFile('/bad/package.json', '[]')
  vfs.writeFile('/bad/b.js', '')
  const host = createVfsHost(vfs)
  t.assert.equal(host.stat('/src/a.js').isFile(), true)
  t.assert.equal(host.stat(join(tmp, 'on-disk.js')), null, 'nothing on disk is there')
  t.assert.equal(host.stat('/src/a.js/'), null)
  t.assert.equal(host.stat('/src/').isDirectory(), true)
  t.assert.throws(() => host.readFile('/src/a.js/'), { code: 'ENOTDIR' })
  // It reads the Vfs as it is at each call, and a relative path from its `/`.
  t.assert.equal(host.stat('/src/later.js'), null)
  vfs.writeFile('/src/later.js', 'module.exports = 1')
  t.assert.equal(host.stat('/src/later.js').isFile(), true)
  t.assert.equal(host.resolve('/src/a.js', './later', new Set(['require'])), '/src/later.js')
  t.assert.equal(host.stat('src/a.js').isFile(), true)
  t.assert.equal(host.readFile('src/a.js').toString(), 'import "dep"')
  t.assert.equal(host.findPackageJSON('/src/a.js'), '/package.json')
  t.assert.equal(host.resolve('/src/a.js', 'dep', new Set(['require', 'node'])), '/node_modules/dep/i.js')
  t.assert.throws(() => host.findPackageJSON('/bad/b.js'), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
}))

test('a tsconfig extends a base in node_modules through the tree, never the one installed', async (t) => {
  const vfs = write(workspace(), {
    '/p/tsconfig.json': { extends: 'base/tsconfig.json' },
    '/p/vendor/base/tsconfig.json': { compilerOptions: { paths: { '@virtual/*': ['./virtual/*'] } } },
    '/p/node_modules/base/tsconfig.json': { compilerOptions: { paths: { '@installed/*': ['./installed/*'] } } },
  })
  const { host } = await loadNodeModules({ vfs, packageManager: 'pnpm', cwd: '/p' })
  const paths = loadTsconfigPaths('/p/tsconfig.json', host)
  t.assert.deepEqual(paths.matchPaths('@virtual/a'), ['/p/vendor/base/virtual/a'])
  t.assert.deepEqual(paths.matchPaths('@installed/a'), [])
  t.assert.deepEqual(loadTsconfigPaths('/p/tsconfig.json', createVfsHost(vfs)).matchPaths('@installed/a'), ['/p/node_modules/base/installed/a'], 'the project\'s Vfs alone holds the installed one')
})

test('a package.json that is there but can\'t be read is refused as Node refuses it, and one that leads nowhere is none, on disk and in a Vfs', withTmp((t, tmp) => {
  const conditions = new Set(['require'])
  const outcome = (f) => {
    try {
      return f()
    } catch (err) {
      return err.code
    }
  }
  // On disk, beside Node's own resolver: a link loop, a loop through directories, a link to nothing.
  writeFileSync(join(tmp, 'package.json'), '{"name":"outer"}')
  writeFileSync(join(tmp, 'main.js'), '')
  for (const dir of ['loop', 'dirloop', 'dangling']) {
    mkdirSync(join(tmp, dir))
    writeFileSync(join(tmp, dir, 'index.js'), '')
  }
  symlinkSync('package.json', join(tmp, 'loop/package.json'))
  symlinkSync('b', join(tmp, 'dirloop/a'))
  symlinkSync('a', join(tmp, 'dirloop/b'))
  symlinkSync('a/x.json', join(tmp, 'dirloop/package.json'))
  symlinkSync('gone.json', join(tmp, 'dangling/package.json'))
  const ours = createNodeResolver(diskHost)
  const node = createRequire(join(tmp, 'main.js'))
  const resolve = (dir) => outcome(() => ours.resolve(join(tmp, 'main.js'), `./${dir}`, conditions))
  // Node refuses a package.json it can't read since 24.21 and 26.8 (nodejs/node#65223); before, it
  // took one for none and resolved past it. Ours refuses it on every Node. A link to nothing is none
  // to each.
  const theirs = Object.fromEntries(['loop', 'dirloop', 'dangling'].map((dir) => [dir, outcome(() => node.resolve(`./${dir}`))]))
  const unreadable = theirs.loop === 'ERR_INVALID_PACKAGE_CONFIG' ? () => 'ERR_INVALID_PACKAGE_CONFIG' : (dir) => join(tmp, dir, 'index.js')
  t.assert.deepEqual(theirs, { loop: unreadable('loop'), dirloop: unreadable('dirloop'), dangling: join(tmp, 'dangling', 'index.js') }, `Node ${process.version}`)
  t.assert.equal(resolve('loop'), 'ERR_INVALID_PACKAGE_CONFIG')
  t.assert.equal(resolve('dirloop'), 'ERR_INVALID_PACKAGE_CONFIG')
  t.assert.equal(resolve('dangling'), theirs.dangling)
  // In a Vfs, as on disk.
  const vfs = write(new Vfs(), { '/package.json': '{"name":"outer"}', '/main.js': '', '/loop/index.js': '', '/dangling/index.js': '' })
  vfs.symlink('package.json', '/loop/package.json')
  vfs.symlink('gone.json', '/dangling/package.json')
  const host = createVfsHost(vfs)
  t.assert.throws(() => host.findPackageJSON('/loop/index.js'), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
  t.assert.throws(() => host.resolve('/main.js', './loop', conditions), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
  t.assert.equal(host.findPackageJSON('/dangling/index.js'), '/package.json')
  t.assert.equal(host.resolve('/main.js', './dangling', conditions), '/dangling/index.js')
}))

test('the disk host resolves exactly like require.resolve, including through symlinks', withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'real'))
  writeFileSync(join(tmp, 'real', 'z.js'), '')
  symlinkSync(join(tmp, 'real'), join(tmp, 'link'))
  writeFileSync(join(tmp, 'main.cjs'), '')
  t.assert.equal(diskHost.resolve(join(tmp, 'main.cjs'), './link/z', new Set(['require'])), join(tmp, 'real', 'z.js'))
  t.assert.equal(createNodeResolver(diskHost).resolve(join(tmp, 'main.cjs'), './link/z', new Set(['require'])), join(tmp, 'real', 'z.js'))
}))

test('a Solidity bundle read through a Vfs host holds a dependency to its own files, as on disk', async (t) => {
  const { buildSolidityBundle } = await import('../stasis/src/cmd/bundle.js')
  const vfs = write(new Vfs(), {
    '/foundry.toml': '[profile.default]\n',
    '/.env': 'PRIVATE_KEY=0xabc\n',
    '/src/A.sol': 'import "evil/E.sol";\n',
    '/lib/evil/src/E.sol': 'import "./Evil.sol";\n',
  })
  // A link the dependency planted out of itself, to the project's .env.
  vfs.symlink('../../../.env', '/lib/evil/src/Evil.sol')
  const host = createVfsHost(vfs)
  const build = () => buildSolidityBundle({ cwd: '/', entries: ['src'], env: {}, host })
  const warn = console.warn
  console.warn = () => {}
  try {
    await t.assert.rejects(build, (err) => err.message.includes('refused: lib/evil/src/Evil.sol is a link out of the dependency lib/evil'))
    vfs.unlink('/lib/evil/src/Evil.sol')
    vfs.writeFile('/lib/evil/src/Evil.sol', 'contract Evil {}\n')
    t.assert.deepEqual([...(await build()).sources.keys()].toSorted(), ['lib/evil/src/E.sol', 'lib/evil/src/Evil.sol', 'src/A.sol'])
  } finally {
    console.warn = warn
  }
})
