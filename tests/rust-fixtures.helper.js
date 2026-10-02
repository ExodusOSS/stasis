import { isUtf8 } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

// The Rust fixture projects the loader tests read from disk, held in one file,
// tests/fixtures/rust-bundle.json.br: brotli-compressed JSON of project name -> project-relative
// path -> the file's text, or `{ base64 }` for one that isn't UTF-8.
//
// - `includes`: a crate with every include form, its assets and a build script.
// - `cargo-recorded`: @preventive/lockfile's Cargo workspace fixture with the builds cargo
//   recorded for it (from PreventiveMeasures/libraries#56, MIT).
//
// To edit them: `node tests/rust-fixtures.helper.js unpack <dir>`, change the files under
// `<dir>/<project>/`, then `node tests/rust-fixtures.helper.js pack <dir>`.

const archive = fileURLToPath(new URL('fixtures/rust-bundle.json.br', import.meta.url))

const read = () => JSON.parse(brotliDecompressSync(readFileSync(archive)).toString('utf8'))
const write = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'))
  }
}

// The directory holding fixture project `name`, written out once per process (and removed when it
// exits) for the tests to read; never to be written to.
let projects = null
let root = null
const written = new Map()
export function rustFixture(name) {
  if (!written.has(name)) {
    projects ??= read()
    if (!Object.hasOwn(projects, name)) throw new Error(`No Rust fixture project ${name} in ${archive}`)
    if (root === null) {
      root = mkdtempSync(join(tmpdir(), 'stasis-rust-fixtures-'))
      process.on('exit', () => rmSync(root, { recursive: true, force: true }))
    }
    write(join(root, name), projects[name])
    written.set(name, join(root, name))
  }
  return written.get(name)
}

// `<dir>/<project>/…` -> the archive, every file of every project, in sorted order.
function pack(dir) {
  const projectsOut = {}
  for (const name of readdirSync(dir).toSorted()) {
    const files = {}
    const walk = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(at, entry.name)
        if (entry.isDirectory()) walk(path)
        else {
          const buf = readFileSync(path)
          files[relative(join(dir, name), path).split('\\').join('/')] = isUtf8(buf) ? buf.toString('utf8') : { base64: buf.toString('base64') }
        }
      }
    }
    walk(join(dir, name))
    projectsOut[name] = files
  }
  writeFileSync(archive, brotliCompressSync(`${JSON.stringify(projectsOut, null, 1)}\n`, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2)
  if (command === 'pack' && dir) pack(dir)
  else if (command === 'unpack' && dir) for (const [name, files] of Object.entries(read())) write(join(dir, name), files)
  else {
    console.error('usage: node tests/rust-fixtures.helper.js (pack|unpack) <dir>')
    process.exitCode = 1
  }
}
