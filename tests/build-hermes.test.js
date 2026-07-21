import { test, describe } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fullFixture = join(here, 'fixtures', 'esbuild-full')

// drop inherited stasis env so the spawned CLI gets a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  ...cleanEnv
} = process.env

// Same async CLI runner as build-cmd.test.js: spawn() + once('close') so the
// describe-level concurrency below actually overlaps the esbuild subprocesses.
const runCli = async (args, { cwd } = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv })
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

const runNode = (t, file, { cwd } = {}) => {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf-8', cwd })
  t.assert.equal(r.status, 0, `running ${file} failed: ${r.stderr}`)
  return r.stdout
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-build-hermes-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --platform=hermes / --babel resolve Babel from the PROJECT dir (it's the project's dev
// dependency, not stasis's), and the tmp projects live outside this workspace -- so link the
// workspace's own copies in. realpathSync keeps each package's deps resolvable (pnpm store).
const rootModules = join(here, '..', 'node_modules')
const linkBabel = (dir, packages = ['core', 'plugin-transform-block-scoping', 'plugin-transform-classes']) => {
  mkdirSync(join(dir, 'node_modules', '@babel'), { recursive: true })
  for (const name of packages) {
    symlinkSync(realpathSync(join(rootModules, '@babel', name)), join(dir, 'node_modules', '@babel', name), 'dir')
  }
}

const writeBundle = (dir, bundleObj) =>
  writeFileSync(join(dir, 'app.code.br'), brotliCompressSync(JSON.stringify(bundleObj)))

const CONCURRENCY = 4 // matches CI runner cores

describe('stasis build --platform=hermes / --babel (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('hermes build downlevels classes/let/const/arrows/async generators and still runs', withTmp(async (t, tmp) => {
    // One entry exercising everything the hermes pipeline must lower: a TS class with a
    // private field + static field (esbuild pre-transform, then Babel transform-classes),
    // let/const including per-iteration loop closures (Babel transform-block-scoping),
    // arrows and an async generator + for-await (the final esbuild pass), plus a json
    // import that must bypass the transform entirely.
    writeBundle(tmp, {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: {
        '.': {
          name: 'x',
          version: '0.0.0',
          files: {
            'src/entry.js':
              "import { Greeter } from './greeter.ts'\n" +
              "import data from './data.json'\n" +
              "async function* gen() { yield 'x'; yield 'y' }\n" +
              'const main = async () => {\n' +
              '  const fns = []\n' +
              '  for (let i = 0; i < 3; i++) fns.push(() => i)\n' +
              "  let acc = ''\n" +
              '  for await (const v of gen()) acc += v\n' +
              "  console.log(new Greeter(data.name).greet(), fns.map((f) => f()).join(''), acc)\n" +
              '}\n' +
              'main()\n',
            'src/greeter.ts':
              'export class Greeter {\n' +
              '  #name: string\n' +
              "  static punctuation = '!'\n" +
              '  constructor(name: string) { this.#name = name }\n' +
              '  greet(): string { return `hello, ${this.#name}${Greeter.punctuation}` }\n' +
              '}\n',
            'src/data.json': '{ "name": "world" }\n',
          },
        },
      },
      modules: {},
      formats: { 'src/entry.js': 'module', 'src/greeter.ts': 'module-typescript', 'src/data.json': 'json' },
      imports: { '*': { 'src/entry.js': { './greeter.ts': 'src/greeter.ts', './data.json': 'src/data.json' } } },
    })
    linkBabel(tmp)

    const r = await runCli(['build', '--platform=hermes', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(join(tmp, 'out.js'), 'utf-8')
    // --format defaults to iife under hermes, and with arrows unsupported the wrapper is a plain function.
    t.assert.match(out, /^\(function\(\)/)
    t.assert.doesNotMatch(out, /=>/, 'no arrow functions may survive (source or esbuild helpers)')
    t.assert.doesNotMatch(out, /\b(?:let|const)\b/, 'no let/const may survive (source or esbuild helpers)')
    // `class` survives only inside Babel's classCallCheck error string, never as syntax.
    t.assert.doesNotMatch(out.replaceAll('Cannot call a class as a function', ''), /\bclass\b/)
    // The downleveled output still behaves identically (run under Node as a stand-in engine).
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world! 012 xy')
  }))

  test('hermes build works from a lockfile fixture', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    linkBabel(tmp)
    const r = await runCli(['build', '--platform=hermes', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built src\/entry\.js from lockfile/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('hermes rejects --format=esm (Hermes has no import/export)', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--platform=hermes', '--format=esm', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--platform=hermes cannot emit ESM/)
    t.assert.ok(!existsSync(join(tmp, 'out.js')), 'no output on a rejected build')
  }))

  test('hermes allows an explicit --format=cjs', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    linkBabel(tmp)
    const r = await runCli(['build', '--platform=hermes', '--format=cjs', '--output=out.cjs', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), 'hello, world')
  }))

  test('hermes fails with install instructions when Babel is not in the project', withTmp(async (t, tmp) => {
    // No node_modules in the tmp project: Babel must resolve from the PROJECT, not from
    // stasis's own install, so this fails actionably even though the workspace has Babel.
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--platform=hermes', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--platform=hermes needs @babel\/core, @babel\/plugin-transform-block-scoping, @babel\/plugin-transform-classes installed in the project/)
    t.assert.ok(!existsSync(join(tmp, 'out.js')), 'no output on a failed build')
  }))

  // ----- --babel (the project's own babel.config.*) --------------------------------------

  test('--babel transforms every file with the project babel.config.cjs', withTmp(async (t, tmp) => {
    // The config wires a local plugin that rewrites the bare identifier __ANSWER__ to 42;
    // only the project's own config can do that, so the output observably proves the
    // config was read and its plugin resolved relative to the project.
    writeBundle(tmp, {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: { '.': { name: 'x', version: '0.0.0', files: { 'src/entry.js': "console.log('answer:', __ANSWER__)\n" } } },
      modules: {},
      formats: { 'src/entry.js': 'module' },
      imports: { '*': {} },
    })
    writeFileSync(join(tmp, 'answer-plugin.cjs'),
      'module.exports = () => ({\n' +
      '  visitor: {\n' +
      '    Identifier(path) {\n' +
      "      if (path.node.name === '__ANSWER__') path.replaceWith({ type: 'NumericLiteral', value: 42 })\n" +
      '    },\n' +
      '  },\n' +
      '})\n')
    writeFileSync(join(tmp, 'babel.config.cjs'), "module.exports = { plugins: ['./answer-plugin.cjs'] }\n")
    linkBabel(tmp, ['core'])

    // Without --babel the identifier survives to runtime and throws (ReferenceError).
    const plain = await runCli(['build', '--format=cjs', '--output=plain.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(plain.status, 0, plain.stderr)
    t.assert.notEqual(spawnSync(process.execPath, [join(tmp, 'plain.cjs')]).status, 0)

    const r = await runCli(['build', '--babel', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), 'answer: 42')
  }))

  test('--babel skips the esbuild pre-transform: Babel sees the original source', withTmp(async (t, tmp) => {
    // The marker plugin records the exact source Babel receives for the entry. A class
    // field is the tell: the hermes pre-transform would lower it (and append an inline
    // sourcemap) before Babel, while --babel must hand over the attested bytes verbatim.
    const entrySource = 'class A { x = 42 }\nconsole.log(new A().x)\n'
    writeBundle(tmp, {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/app.js'],
      sources: { '.': { name: 'x', version: '0.0.0', files: { 'src/app.js': entrySource } } },
      modules: {},
      formats: { 'src/app.js': 'module' },
      imports: { '*': {} },
    })
    writeFileSync(join(tmp, 'record-plugin.cjs'),
      "const { writeFileSync } = require('node:fs')\n" +
      "const { join } = require('node:path')\n" +
      'module.exports = () => ({\n' +
      '  visitor: {\n' +
      '    Program(path, state) {\n' +
      "      writeFileSync(join(__dirname, 'seen-source.txt'), state.file.code)\n" +
      '    },\n' +
      '  },\n' +
      '})\n')
    writeFileSync(join(tmp, 'babel.config.cjs'), "module.exports = { plugins: ['./record-plugin.cjs'] }\n")
    linkBabel(tmp, ['core'])

    const r = await runCli(['build', '--babel', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(readFileSync(join(tmp, 'seen-source.txt'), 'utf-8'), entrySource, 'Babel must receive the attested source verbatim')
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), '42')
  }))

  test('--babel fails actionably without a babel.config.*', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    linkBabel(tmp, ['core'])
    const r = await runCli(['build', '--babel', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--babel found no babel\.config\.\(js\|cjs\|mjs\|json\)/)
  }))

  test('--babel fails with install instructions when @babel/core is not in the project', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'babel.config.cjs'), 'module.exports = {}\n')
    const r = await runCli(['build', '--babel', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--babel needs @babel\/core installed in the project/)
  }))

  test('--babel composes with --platform=hermes (project config replaces the built-in downlevel)', withTmp(async (t, tmp) => {
    // Under --babel the built-in hermes Babel pass is replaced by the project config, but
    // the final bundle still runs with the hermes feature checks -- block-scoping +
    // classes in the config keep the output Hermes-safe here.
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'babel.config.cjs'),
      "module.exports = { plugins: ['@babel/plugin-transform-block-scoping', '@babel/plugin-transform-classes'] }\n")
    linkBabel(tmp)
    const r = await runCli(['build', '--babel', '--platform=hermes', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(join(tmp, 'out.js'), 'utf-8')
    t.assert.doesNotMatch(out, /=>|\b(?:let|const)\b/)
    t.assert.equal(runNode(t, join(tmp, 'out.js')).trim(), 'hello, world')
  }))

  test('build rejects an invalid --platform', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const r = await runCli(['build', '--platform=v8', '--output=out.js', 'stasis.lock.json'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--platform must be node, browser, neutral, or hermes/)
  }))
})
