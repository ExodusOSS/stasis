import Module, { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { State } from './state.js'
import { installFsHooks } from './fs.js'
import {
  NATIVE_BUILD_FORMATS as NATIVE_SOURCE_FORMATS,
  NODE_FORMATS as NODEJS_FORMATS,
  RESOURCE_FORMATS,
  SOURCE_LANGUAGE_FORMATS as NON_NODE_SOURCE_LANGUAGES,
  STAT_FORMATS,
} from './util.js'

// Snapshot off the namespace so `--fs` can't redirect stasis's own capture/shard reads.
const { mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = fs

const CJS_FORMATS = new Set(['commonjs', 'commonjs-typescript'])

function refuseNonNodeFormat(format, url) {
  if (NON_NODE_SOURCE_LANGUAGES.has(format)) {
    throw new Error(
      `[stasis] cannot execute a '${format}' bundle: ${format} bundles are ` +
      `produced for external analysis, not for 'stasis run --bundle=load' (${url})`
    )
  }
  if (NATIVE_SOURCE_FORMATS.has(format)) {
    throw new Error(
      `[stasis] cannot execute a '${format}' file: native build inputs ` +
      `(podspec/gradle/Java/Kotlin/ObjC++/...) are attested for the CocoaPods/Gradle ` +
      `toolchain, not executable by Node (${url})`
    )
  }
  if (RESOURCE_FORMATS.has(format)) {
    throw new Error(
      `[stasis] cannot import a resource file ('${format}'): asset content is not ` +
      `executable JavaScript. Read it with fs (or your bundler's asset loader) instead (${url})`
    )
  }
  if (format === 'directory') {
    throw new Error(
      `[stasis] cannot import a directory listing ('directory'): a captured ` +
      `fs.readdirSync result is not executable JavaScript. Read it with fs.readdirSync instead (${url})`
    )
  }
  if (STAT_FORMATS.has(format)) {
    throw new Error(
      `[stasis] cannot import '${url}': the bundle carries only a payload-free stat record ` +
      `('${format}', an fs.lstatSync/statSync capture attesting existence and kind) -- ` +
      `not the file's content. Capture a run that reads or imports it to bundle its bytes.`
    )
  }
  throw new Error(
    `[stasis] cannot execute '${url}': attested format '${format}' is not a Node loader ` +
    `format. The bundle may be tampered, produced by a newer stasis, or built for a ` +
    `non-Node consumer.`
  )
}

// node:59666: restores require.cache/require.extensions the ESM->CJS translator's require omits.
const CJS_REQUIRE_REPAIR =
  "try{if(typeof require==='function'&&!require.cache){" +
  "const __stasis_m=require('node:module');" +
  'if(__stasis_m&&__stasis_m.Module){' +
  'require.cache=__stasis_m.Module._cache;' +
  'if(!require.extensions)require.extensions=__stasis_m.Module._extensions;}}}catch{}'

const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// Matches only single-line block comments: a newline-spanning one counts as a line boundary for ASI.
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// A directive string followed by one of these heads a multi-line expression, not a directive (ASI gotcha).
const EXPR_CONTINUATION = new Set(['.', '[', '(', '`', '+', '-', '*', '/', '%', ',', '?', ':', '=', '<', '>', '&', '|', '^'])
const KEYWORD_CONTINUATION = /(?:instanceof|in)\b/uy
function skipSticky(re, source, i) {
  re.lastIndex = i
  re.exec(source)
  return re.lastIndex
}
function newStatementAfterBreak(source, pos) {
  const afterBreak = skipSticky(WS_COMMENTS, source, pos)
  if (afterBreak >= source.length) return true
  if (EXPR_CONTINUATION.has(source[afterBreak])) return false
  KEYWORD_CONTINUATION.lastIndex = afterBreak
  return !KEYWORD_CONTINUATION.test(source)
}

// Insert CJS_REQUIRE_REPAIR AFTER the Directive Prologue with a leading ';', so a `'use strict'`
// stays strict and a leading string EXPRESSION isn't split mid-expression.
function repairCjsRequire(source) {
  if (typeof source !== 'string') return source
  let i = 0
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    i = nl === -1 ? source.length : nl + 1
  }
  for (;;) {
    const afterWs = skipSticky(WS_COMMENTS, source, i)
    STRING_LITERAL.lastIndex = afterWs
    if (STRING_LITERAL.exec(source) === null) break
    const afterStr = STRING_LITERAL.lastIndex
    const afterTrail = skipSticky(TRAILING_SAME_LINE, source, afterStr)
    const c = source[afterTrail]
    let isDirective
    if (c === undefined || c === ';' || c === '}') isDirective = true
    else if (c === '/' && source[afterTrail + 1] === '/') isDirective = true
    // A `/*` here is a newline-spanning block comment: like a line break it can end the directive.
    else if (c === '/' && source[afterTrail + 1] === '*') isDirective = newStatementAfterBreak(source, afterTrail)
    else if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') isDirective = newStatementAfterBreak(source, afterTrail)
    else isDirective = false
    if (!isDirective) break
    i = afterStr
  }
  return `${source.slice(0, i)};${CJS_REQUIRE_REPAIR}${source.slice(i)}`
}

let state
// The root merges/removes ONLY a shard dir it minted and accepts ONLY shards signed under its own key.
let createdShardDir
let createdShardPub
let createdShardPubId
// True once artifacts are written; the load hook asserts on it so a late first load can't ship unattested.
let saved = false
// Serialized shard text a child last wrote, so a second flush skips an identical re-write.
let lastShardWritten
// Set when stasis's own capture/verification rejects something; when set, nothing is written.
let aborted = false
// >0 while Node's loader reads a module's source; the --fs hook skips reads taken then.
let loadingModule = 0
// True until the first non-builtin load hook fires (entry detection).
let entryUnseen = true

// EXODUS_STASIS_PID = the root stasis's pid; on mismatch we're a child and must not write the
// bundle/lockfile (root owns the artifact; a 2nd writer races). A forked child also relaxes assertEntry.
const OWN_PID = String(process.pid)
if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// stasis-core's own package root, so State's backfill captures edges loaded before our hooks registered.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
})()

// Child-process capture forwarding (shards), opt-in via --child-process: a capturing child writes a
// signed per-pid shard the root verifies against its own public key before merging. Trust rests on
// that signature, not the dir being secret; shards carry NO bytes (the root re-reads from disk).

function shardForwardingEnabled() {
  return Boolean(state) && state.config.childProcess && (state.config.writeLockfile || state.config.writeBundle)
}

function writeChildShard() {
  if (!shardForwardingEnabled()) return
  const dir = process.env.EXODUS_STASIS_SHARD_DIR
  const keyB64 = process.env.EXODUS_STASIS_SHARD_KEY
  if (!dir || !keyB64) return
  try {
    // Sign the exact snapshot string, never a re-stringify, so verify is independent of JSON key
    // order; temp + rename so the merge never reads a half-written shard.
    const shard = state.shardSnapshot()
    if (shard === lastShardWritten) return
    const privateKey = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' })
    const pubId = createPublicKey(privateKey).export({ format: 'jwk' }).x
    const signature = sign(null, Buffer.from(shard), privateKey).toString('base64url')
    const unique = `${OWN_PID}-${randomBytes(6).toString('hex')}`
    const tmpPath = join(dir, `.${pubId}-${unique}.tmp`)
    writeFileSync(tmpPath, JSON.stringify({ shard, signature }))
    renameSync(tmpPath, join(dir, `${pubId}-${unique}.json`))
    lastShardWritten = shard
  } catch {
    // Best-effort: a child that can't snapshot/sign/write just doesn't contribute.
  }
}

// Cap shard count + size so a hostile/runaway set can't OOM the root.
const MAX_SHARDS = 4096
const MAX_SHARD_BYTES = 64 * 1024 * 1024

// Merge children's shards from `dir`: verify each envelope against our own PUBLIC key, not one from
// the filename. opendir streams the listing so memory stays bounded.
function mergeChildShards(dir) {
  let handle
  try { handle = opendirSync(dir) } catch { return }
  const prefix = `${createdShardPubId}-`
  let count = 0
  try {
    let dirent
    while ((dirent = handle.readSync()) !== null) {
      const name = dirent.name
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      if (++count > MAX_SHARDS) break
      const path = join(dir, name)
      try {
        if (statSync(path).size > MAX_SHARD_BYTES) continue
        const { shard, signature } = JSON.parse(readFileSync(path, 'utf-8'))
        if (typeof shard !== 'string' || typeof signature !== 'string') continue
        if (!verify(null, Buffer.from(shard), createdShardPub, Buffer.from(signature, 'base64url'))) continue
        state.mergeShard(shard)
      } catch {
        // A malformed/partial shard is skipped; the rest merge.
      }
    }
  } finally {
    try { handle.closeSync() } catch { /* best-effort */ }
  }
}

// Install the --fs reader patches. Must run AFTER stasis's own fs snapshots so they never redirect
// stasis's own reads.
function installFsHooksFromConfig() {
  const fsMode = state.config.fs
  if (!fsMode) return
  installFsHooks({
    async: fsMode === 'async',
    getState: () => state,
    isLoadingModule: () => loadingModule > 0,
    // Warn on the first taint so the silent discard (reads succeed, exit 0, no artifact) has a clue.
    markAborted: (err) => {
      if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
      aborted = true
    },
  })
}

function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })

  installFsHooksFromConfig()

  // Root + opt-in only, before any child can fork: ALWAYS mint our own dir (OS tmpdir, mkdtemp 0700)
  // and keypair, overwriting any inherited/attacker-set env, so we merge only shards we can verify.
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x // base64url(raw public key)
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Rides process.env so every transitive descendant inherits; do NOT scrub it downstream.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Best-effort: clear any inherited (possibly attacker-set) dir/key so descendants don't fall
      // back to a channel we never minted.
      if (createdShardDir) { try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
      createdShardDir = undefined
      createdShardPub = undefined
      createdShardPubId = undefined
      delete process.env.EXODUS_STASIS_SHARD_DIR
      delete process.env.EXODUS_STASIS_SHARD_KEY
    }
  } else if (!isChildProcess) {
    // Non-capturing root: shed any inherited (possibly attacker-set) shard env.
    delete process.env.EXODUS_STASIS_SHARD_DIR
    delete process.env.EXODUS_STASIS_SHARD_KEY
  }

  // Persist on exit unless `aborted` -- deliberately NOT gated on exit code, so a clean capture
  // exiting non-zero still persists. Must stay fully synchronous for `exit` to host it.
  const save = () => {
    const writing = state.config.writeLockfile || state.config.writeBundle
    // A child forwards a shard instead of writing the artifact (root owns it; a 2nd writer races).
    if (isChildProcess) {
      if (writing && !aborted) writeChildShard()
      return
    }
    try {
      if (aborted) return
      if (createdShardDir) mergeChildShards(createdShardDir)
      // write() self-gates the artifact writes, but also VERIFIES in read-only frozen modes, so it
      // must run in every mode.
      state.write()
      // Latch only in write modes: a read-only run persists nothing, so a later first load (e.g. a
      // require() from another exit handler) is still attested and must not trip the load hook.
      if (writing) saved = true
    } finally {
      if (createdShardDir) {
        try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
  }

  // `exit` alone, NOT the beforeExit/exit pair: it runs after every beforeExit handler, so one flush
  // there sees strictly more. A process that never reaches `exit` writes nothing.
  process.on('exit', save)

  // config.shardSignalFlush (opt-in): flush the shard when a capturing CHILD is ended by SIGTERM
  // (jest-worker's forceExit bypasses `exit`), then re-deliver the signal -- unless user code owns
  // SIGTERM, then only flush. `userOwnedSigterm` is snapshotted at registration: a `once` that
  // already ran is invisible to listenerCount. Must fit forceExit's 500ms window.
  if (isChildProcess && shardForwardingEnabled() && state.config.shardSignalFlush) {
    const userOwnedSigterm = process.listenerCount('SIGTERM') > 0
    process.once('SIGTERM', () => {
      try {
        save()
      } finally {
        if (!userOwnedSigterm && process.listenerCount('SIGTERM') === 0) {
          process.kill(process.pid, 'SIGTERM')
        }
      }
    })
  }
}

function load(url, context, nextLoad) {
  assert.equal(typeof url, 'string')

  if (url.startsWith('node:')) {
    const result = nextLoad(url, context)
    assert.equal(result.format, 'builtin')
    return result
  }

  if (state && state.config.loadBundle) {
    // node_modules scope serves only nm deps; gate on inNodeModules(), not a raw substring (symlinks).
    if (!state.config.full && !state.inNodeModules(url)) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // Cross-check format only when the resolve chain set it; the formats map is itself attested
    // against the lockfile at construction.
    if (context.format != null) assert.equal(format, context.format)
    // Trust gate: only serve a file whose attested format Node can execute; everything else fails closed.
    if (!NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    // node:59666: a load-hook-supplied CJS source gets a re-invented require() missing .cache/.extensions.
    if (CJS_FORMATS.has(format)) {
      return { source: repairCjsRequire(source), format, shortCircuit: true }
    }
    return { source, format, shortCircuit: true }
  }

  loadingModule++
  let result
  try {
    result = nextLoad(url, context)
  } finally {
    loadingModule--
  }
  let { source } = result
  const { format } = result
  assert.notEqual(format, 'builtin')

  // Node's CJS loader may return source=null and read from disk itself; capture it for the bundle
  if (source == null && format === 'commonjs') source = readFileSync(fileURLToPath(url))

  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    initState(dirname(pkg))
  }

  assert.equal(saved, false)
  // A rejected capture must never be written, even if user code swallows the throw.
  try {
    state.addFile(url, { source, format, isEntry })
  } catch (err) {
    aborted = true
    throw err
  }

  return result
}

function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier)) {
    const res = nextResolve(specifier)
    assert.equal(res.url, specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    return res
  }

  if (context.importAttributes !== undefined) {
    const expectedAttrs = Object.create(null) // saving not supported yet; enforce expected attrs
    if (extname(specifier) === '.json' && context.importAttributes?.type) expectedAttrs.type = 'json'
    assert.deepStrictEqual(context.importAttributes, expectedAttrs)
  }

  const { parentURL, conditions, importAttributes } = context

  // Full-scope load serves the entry from the bundle, so state must exist before nextResolve.
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') {
    initState(process.cwd())
  }

  if (state && state.config.loadBundle) {
    // nm scope defers non-nm parents to Node's resolver; gate on inNodeModules() to cover symlinks.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) {
      return nextResolve(specifier)
    }
    // A bare specifier with a parent resolves from the recorded import map; otherwise skip
    // nextResolve so the entry needn't be on disk.
    if (parentURL && !specifier.startsWith('file:')) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes })
      // Friendlier error at resolve time; the load gate is the load-bearing one.
      if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    const url = specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    // A forked child's main module isn't a declared CLI entry, so skip assertEntry (getFile still
    // fails closed on anything unattested).
    if (!parentURL && state.config.full && !forkedChild) state.assertEntry(url)
    const format = state.getFormat(url)
    if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  if (state) {
    try {
      state.addImport(parentURL, specifier, url, { conditions, format, importAttributes })
    } catch (err) {
      aborted = true
      throw err
    }
  }
  return res
}

let installed = false

// Exported so plugins.js can detect "under the stasis loader" before the lazy initState fires.
export function isLoaderInstalled() {
  return installed
}

// For plugins.js when a plugin constructor runs ahead of the load hook.
export function ensureStateForLoader() {
  if (state) return
  initState(process.cwd())
}

// Separate from the --import entry points so a host can compose setup before the hooks register.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // The --fs reader patches are deferred to initState (their mode may come from stasis.config.json).
}

// registerHooks doesn't intercept the require() the ESM->CJS translator builds for a CJS module (it
// resolves through Module._resolveFilename against disk), so shim that to resolve from the import map.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        if (state.config.full || state.inNodeModules(parentURL)) {
          const resolved = state.resolveBundled(parentURL, request)
          if (resolved !== undefined) return resolved
        }
      } else if (isAbsolute(request)) {
        // NO parent, absolute request: Node's ESM<->CJS interop re-enters the CJS loader with hooks
        // SKIPPED, so this shim is the only interception point. hasFsFileContent (not a dir/stat
        // record) keeps a listing or payload-free stat from hijacking resolution. Node 24.14-24.17
        // re-resolve here every commonjs-sync eval; the no-parent shape survives on >=24.18 too.
        const url = pathToFileURL(request).toString()
        if ((state.config.full || state.inNodeModules(url)) && state.hasFsFileContent(url)) {
          return resolvePath(request)
        }
      }
    }
    const resolved = original.call(this, request, parent, ...rest)
    // Capture: require.resolve() and some CJS require()s never fire the resolve hook.
    if (state && !loadMode && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      state.observeResolution(pathToFileURL(parent.filename).toString(), request, pathToFileURL(resolved).toString())
    }
    return resolved
  }

  // Capture: Module._load's cache fast path can skip _resolveFilename, so a second require() of the
  // same target goes unrecorded. Force it through the PROPERTY (our shim) to observe the edge.
  const originalLoad = Module._load
  Module._load = function (request, parent, ...rest) {
    if (state && !state.config.loadBundle && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      try { Module._resolveFilename(request, parent, ...rest) } catch { /* original _load raises the real error */ }
    }
    return originalLoad.call(this, request, parent, ...rest)
  }
}
