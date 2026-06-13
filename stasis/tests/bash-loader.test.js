import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildBashTree,
  collectBashFilesFromDisk,
  extractBashCalls,
  loadBash,
  resolveBashCall,
} from '../src/loaders/bash.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bash-bundle')

const captureWarnings = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

const captureWarningsAsync = async (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const result = await fn()
    return { result, warnings }
  } finally {
    console.warn = original
  }
}

test('extractBashCalls finds `source ./file` references', (t) => {
  t.assert.deepEqual(extractBashCalls('#!/usr/bin/env bash\nsource ./lib.sh\n'), ['./lib.sh'])
})

test('extractBashCalls finds `bash`/`sh` exec references', (t) => {
  t.assert.deepEqual(extractBashCalls('bash ./worker.sh\nsh helper.sh\n'), ['./worker.sh', 'helper.sh'])
})

test('extractBashCalls finds direct `./script.sh` invocations', (t) => {
  t.assert.deepEqual(extractBashCalls('#!/usr/bin/env bash\n./worker.sh --flag\n'), ['./worker.sh'])
})

test('extractBashCalls finds `# Depends on:` comment hints (.sh and .bash)', (t) => {
  t.assert.deepEqual(extractBashCalls('# Depends on: helper.sh\n'), ['helper.sh'])
  t.assert.deepEqual(extractBashCalls('# Depends on: helper.bash\n'), ['helper.bash'])
})

test('extractBashCalls reads a `# shellcheck source=` directive (and drops the $VAR source line)', (t) => {
  const src = '# shellcheck source=../lib/config.sh\nsource "${LIB_DIR}/config.sh"\n'
  t.assert.deepEqual(extractBashCalls(src), ['../lib/config.sh'])
})

test('extractBashCalls reads source= alongside other shellcheck directives, ignores /dev/null', (t) => {
  t.assert.deepEqual(extractBashCalls('# shellcheck disable=SC1091 source=lib/x.sh\n'), ['lib/x.sh'])
  t.assert.deepEqual(extractBashCalls('# shellcheck source=/dev/null\nsource "$x"\n'), [])
})

test('extractBashCalls skips variable-expansion and flag references', (t) => {
  // `$DIR/lib.sh` is a dynamic path; `-c` is a flag — neither is a file.
  t.assert.deepEqual(extractBashCalls('source "$DIR/lib.sh"\nbash -c "echo hi"\n'), [])
})

test('extractBashCalls captures a script in a command substitution without the closing delimiter', (t) => {
  t.assert.deepEqual(extractBashCalls('result=$(bash ./worker.sh)\n'), ['./worker.sh'])
  t.assert.deepEqual(extractBashCalls('`source ./config.sh`\n'), ['./config.sh'])
})

test('extractBashCalls finds scripts run via an absolute interpreter path', (t) => {
  t.assert.deepEqual(extractBashCalls('/bin/sh ./run.sh\n'), ['./run.sh'])
  t.assert.deepEqual(extractBashCalls('/usr/bin/bash ./deploy.sh\n'), ['./deploy.sh'])
})

test('extractBashCalls does not treat a trailing bare `.` (current dir) as a source', (t) => {
  // `grep -rn x .` ends in a bare dot that is NOT a `.`-source command.
  t.assert.deepEqual(extractBashCalls('grep -rn "TODO" .\n'), [])
})

test('resolveBashCall resolves relative paths against the calling file (validation deferred)', (t) => {
  const knownFiles = new Set(['main.sh', 'lib.sh'])
  t.assert.equal(resolveBashCall('./lib.sh', 'main.sh', { knownFiles }), 'lib.sh')
  // Slash-bearing relative paths are computed even when not (yet) in the set.
  t.assert.equal(resolveBashCall('./nope.sh', 'main.sh', { knownFiles }), 'nope.sh')
})

test('resolveBashCall resolves `../` across directories', (t) => {
  const knownFiles = new Set(['bin/main.sh', 'lib/helper.sh'])
  t.assert.equal(resolveBashCall('../lib/helper.sh', 'bin/main.sh', { knownFiles }), 'lib/helper.sh')
})

test('resolveBashCall returns null when relative traversal escapes the root', (t) => {
  t.assert.equal(resolveBashCall('../x.sh', 'main.sh', { knownFiles: new Set() }), null)
  t.assert.equal(resolveBashCall('../../x.sh', 'src/main.sh', { knownFiles: new Set() }), null)
})

test('resolveBashCall matches a bare name by basename in knownFiles mode', (t) => {
  const knownFiles = new Set(['main.sh', 'sub/helper.sh'])
  t.assert.equal(resolveBashCall('helper.sh', 'main.sh', { knownFiles }), 'sub/helper.sh')
})

test('resolveBashCall prefers a sibling over a basename match for bare names', (t) => {
  const knownFiles = new Set(['sub/main.sh', 'sub/helper.sh', 'helper.sh'])
  t.assert.equal(resolveBashCall('helper.sh', 'sub/main.sh', { knownFiles }), 'sub/helper.sh')
})

test('resolveBashCall treats absolute paths as project-relative, only if present', (t) => {
  t.assert.equal(resolveBashCall('/opt/x.sh', 'main.sh', { knownFiles: new Set(['opt/x.sh']) }), 'opt/x.sh')
  t.assert.equal(resolveBashCall('/etc/passwd.sh', 'main.sh', { knownFiles: new Set(['main.sh']) }), null)
})

test('resolveBashCall returns null for bare names with no validation context', (t) => {
  t.assert.equal(resolveBashCall('helper.sh', 'main.sh', {}), null)
})

test('resolveBashCall validates bare names against the filesystem in walk mode', (t) => {
  const baseDir = join(fixtures, 'comment')
  t.assert.equal(resolveBashCall('helper.sh', 'main.sh', { baseDir }), 'helper.sh')
  t.assert.equal(resolveBashCall('grep', 'main.sh', { baseDir }), null)
})

test('collectBashFilesFromDisk walks `source` references from the entry', async (t) => {
  const sources = await collectBashFilesFromDisk(join(fixtures, 'basic'), ['main.sh'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['lib.sh', 'main.sh'])
})

test('collectBashFilesFromDisk follows a multi-level source chain', async (t) => {
  const sources = await collectBashFilesFromDisk(join(fixtures, 'nested'), ['main.sh'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['a.sh', 'b.sh', 'main.sh'])
})

test('collectBashFilesFromDisk loads a shared file once across entries', async (t) => {
  const sources = await collectBashFilesFromDisk(join(fixtures, 'shared'), ['a.sh', 'b.sh'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['a.sh', 'b.sh', 'shared.sh'])
})

test('collectBashFilesFromDisk does not follow PATH commands or non-script refs', async (t) => {
  const sources = await collectBashFilesFromDisk(join(fixtures, 'external'), ['main.sh'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['lib.sh', 'main.sh'])
})

test('collectBashFilesFromDisk warns and skips a reference missing on disk', async (t) => {
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectBashFilesFromDisk(join(fixtures, 'missing-dep'), ['main.sh']),
  )
  t.assert.deepEqual([...sources.keys()], ['main.sh'])
  t.assert.ok(warnings.some((w) => w.includes('Missing file') && w.includes('gone.sh')))
})

test('collectBashFilesFromDisk skips a reference that resolves to a directory (no EISDIR crash)', async (t) => {
  // `source ./libs` where ./libs is a directory: readFile throws EISDIR, which
  // must be skipped, not propagated out of the walk.
  const { result: sources, warnings } = await captureWarningsAsync(() =>
    collectBashFilesFromDisk(join(fixtures, 'dir-ref'), ['main.sh']),
  )
  t.assert.deepEqual([...sources.keys()], ['main.sh'])
  t.assert.ok(warnings.some((w) => w.includes('directory reference') && w.includes('libs')))
})

test('buildBashTree records resolutions among the collected scripts', async (t) => {
  const sources = await collectBashFilesFromDisk(join(fixtures, 'basic'), ['main.sh'])
  const tree = buildBashTree(sources)
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources'])
  t.assert.equal(tree.resolutions.get('main.sh').get('./lib.sh'), 'lib.sh')
  t.assert.equal(tree.resolutions.get('lib.sh').size, 0)
  t.assert.deepEqual(tree.missing, [])
})

test('buildBashTree records an unresolved relative .sh reference as missing', (t) => {
  const { result: tree, warnings } = captureWarnings(() =>
    buildBashTree(new Map([['main.sh', 'source ./gone.sh\n']])),
  )
  t.assert.equal(tree.resolutions.get('main.sh').size, 0)
  t.assert.deepEqual(tree.missing, [{ spec: './gone.sh', from: 'main.sh' }])
  t.assert.ok(warnings.some((w) => w.includes('Missing file') && w.includes('./gone.sh')))
})

test('buildBashTree tolerates an unresolved bare .sh reference (ambiguous: PATH vs runtime cwd)', (t) => {
  const tree = buildBashTree(new Map([['main.sh', 'bash helper.sh\n']]))
  t.assert.deepEqual(tree.missing, [])
})

test('buildBashTree tolerates unresolved absolute, escaping, and extensionless references', (t) => {
  // /etc/x.sh is an external system path; ../outside.sh escapes the root;
  // ./env and `config` aren't .sh files — none is a bundlable local script.
  const tree = buildBashTree(new Map([
    ['main.sh', 'source /etc/x.sh\nsource ../outside.sh\nsource ./env\nsource config\n'],
  ]))
  t.assert.deepEqual(tree.missing, [])
})

test('buildBashTree drops self-references without reporting them missing', (t) => {
  const tree = buildBashTree(new Map([['main.sh', 'source ./main.sh\n']]))
  t.assert.equal(tree.resolutions.get('main.sh').size, 0)
  t.assert.deepEqual(tree.missing, [])
})

test('loadBash reads a .sh.txt listing and resolves among the listed files', async (t) => {
  const tree = await loadBash(join(fixtures, 'listing/list.sh.txt'))
  t.assert.deepEqual([...tree.sources.keys()].toSorted(), ['lib.sh', 'main.sh'])
  t.assert.equal(tree.resolutions.get('main.sh').get('./lib.sh'), 'lib.sh')
})

test('loadBash rejects an empty listing', async (t) => {
  await t.assert.rejects(() => loadBash(join(fixtures, 'listing-empty/list.sh.txt')), /Empty bash listing/)
})

test('loadBash rejects a listing with non-.sh/.bash lines', async (t) => {
  await t.assert.rejects(
    () => loadBash(join(fixtures, 'listing-nonbash/list.sh.txt')),
    /must only contain \.sh\/\.bash files/,
  )
})

test('loadBash rejects an entry path that escapes the listing dir', async (t) => {
  await t.assert.rejects(
    () => loadBash(join(fixtures, 'listing-escape/list.sh.txt')),
    /Entry path escapes baseDir/,
  )
})

test('loadBash rejects an absolute entry path in the listing', async (t) => {
  await t.assert.rejects(
    () => loadBash(join(fixtures, 'listing-absolute/list.sh.txt')),
    /Entry path must not be absolute/,
  )
})
