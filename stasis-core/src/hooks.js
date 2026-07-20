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

// Warning: only covers code imports, not file reads

// NODEJS_FORMATS (util's NODE_FORMATS) is the trust boundary: a served file whose attested format
// is outside it is refused at load (and earlier at resolve); everything else fails closed.

// Executable CommonJS formats (plain CJS + TS-CJS) the require-repair below keys off.
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

// node:59666 workaround (see load hook): prelude restoring require.cache/require.extensions the
// ESM->CJS translator's re-invented require omits, from node:module. Guarded so it no-ops on failure.
const CJS_REQUIRE_REPAIR =
  "try{if(typeof require==='function'&&!require.cache){" +
  "const __stasis_m=require('node:module');" +
  'if(__stasis_m&&__stasis_m.Module){' +
  'require.cache=__stasis_m.Module._cache;' +
  'if(!require.extensions)require.extensions=__stasis_m.Module._extensions;}}}catch{}'

// Sticky scanners for a Directive Prologue: whitespace+comments, a string literal, trailing
// same-line space+block-comments. Sticky+lastIndex walks the prologue in place.
const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// Matches only single-line block comments: a newline-spanning one counts as a line boundary for ASI.
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// Tokens that continue an expression across a line break: a directive string followed by one of
// these heads a multi-line expression, not a directive, so must NOT be skipped (ASI gotcha).
const EXPR_CONTINUATION = new Set(['.', '[', '(', '`', '+', '-', '*', '/', '%', ',', '?', ':', '=', '<', '>', '&', '|', '^'])
const KEYWORD_CONTINUATION = /(?:instanceof|in)\b/uy
function skipSticky(re, source, i) {
  re.lastIndex = i
  re.exec(source)
  return re.lastIndex
}
// At a line boundary, does the next token begin a new statement (directive complete) vs continue the expression?
function newStatementAfterBreak(source, pos) {
  const afterBreak = skipSticky(WS_COMMENTS, source, pos)
  if (afterBreak >= source.length) return true
  if (EXPR_CONTINUATION.has(source[afterBreak])) return false
  KEYWORD_CONTINUATION.lastIndex = afterBreak
  return !KEYWORD_CONTINUATION.test(source)
}

// Insert CJS_REQUIRE_REPAIR AFTER the Directive Prologue (not before) with a leading ';', so a
// `'use strict'` stays strict and a leading string EXPRESSION isn't split mid-expression. The
// directive-vs-expression distinction is the ASI problem, hence a scan not one regex.
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
// Shard dir + per-build ed25519 keypair this root minted: root merges/removes ONLY a dir it minted
// and accepts ONLY shards signed under its own keypair. Private key -> children; public verifies.
let createdShardDir
let createdShardPub
let createdShardPubId
// True once the root has written artifacts; the load hook asserts on it so a module whose bytes
// first load after a write crashes rather than ship unattested.
let saved = false
// Serialized shard text a child last wrote, so the exit firing skips an identical re-write.
let lastShardWritten
// Set when stasis's own capture/verification rejects something; distinct from a non-zero exit.
// When set, nothing is written (a rejected capture must never persist).
let aborted = false
// >0 while Node's loader reads a module's source; the --fs hook skips reads taken then (the module
// is captured as code, not as a program fs read).
let loadingModule = 0
// True until the first non-builtin load hook fires (entry detection); replaced the `!state`
// heuristic, which broke once plugins.js could init state before the entry's load.
let entryUnseen = true

// EXODUS_STASIS_PID = the root stasis's pid; a child inherits it but runs under a different pid,
// so on mismatch we suppress the bundle/lockfile write (root owns the artifact; a 2nd writer races).
// A forked child (mismatch + IPC channel) also relaxes the entry-point check; getFile() still fails closed.
const OWN_PID = String(process.pid)
if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// stasis-core's own package root, passed to State as `preloadRoot` so write()'s backfill captures
// stasis-core's internal edges Node loaded before our hooks registered. Wrapped because a bundler's
// node:module shim may lack findPackageJSON; undefined makes State skip the (best-effort) backfill.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
})()

// Child-process capture forwarding (shards), opt-in via --child-process (config.childProcess): a
// capturing child (e.g. a Metro worker) writes a signed per-pid shard into a root-minted dir; the
// root merges them before writing. Trust rests on the ed25519 signature (root verifies each shard
// against its own public key), not the dir being secret; shards carry NO bytes (re-read from disk),
// so a shard can over-attest an on-disk file but never inject forged content -- all within the
// build's own trust domain (code the build runs already holds the build's privileges).

function shardForwardingEnabled() {
  return Boolean(state) && state.config.childProcess && (state.config.writeLockfile || state.config.writeBundle)
}

function writeChildShard() {
  if (!shardForwardingEnabled()) return
  const dir = process.env.EXODUS_STASIS_SHARD_DIR
  const keyB64 = process.env.EXODUS_STASIS_SHARD_KEY
  if (!dir || !keyB64) return
  try {
    // Sign the exact snapshot bytes, stored verbatim in a { shard, signature } envelope (signing the
    // string, not a re-stringify, makes verify independent of JSON key order). Write to a temp then
    // rename so the merge filter never reads a half-written shard.
    const shard = state.shardSnapshot() // serialized lockfile string
    // Unchanged snapshot: nothing new to forward, skip the duplicate.
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

// Merge this root's children's shards from `dir`: authenticate each { shard, signature } envelope
// against our own PUBLIC key (never one derived from the filename) and merge only those. opendir
// streams the listing so memory stays bounded; stop after MAX_SHARDS.
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

// Install the --fs reader patches from the resolved Config (state.config.fs, so the mode may come
// from stasis.config.json). Called from initState AFTER stasis's own fs snapshots, so the patch
// never redirects stasis's own reads. Idempotent; state read lazily.
function installFsHooksFromConfig() {
  const fsMode = state.config.fs
  if (!fsMode) return
  installFsHooks({
    async: fsMode === 'async',
    getState: () => state,
    // True while Node's loader reads module source: the --fs hook skips those (see loadingModule).
    isLoadingModule: () => loadingModule > 0,
    // A capture conflict taints the run -- nothing is written. Warn on the first taint so the
    // silent discard (reads still succeed, run exits 0 with no artifact) has a clue.
    markAborted: (err) => {
      if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
      aborted = true
    },
  })
}

function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })

  // Install the --fs reader patches now Config is resolved, before any fork and user code.
  installFsHooksFromConfig()

  // Root + opt-in only: mint the shard dir (children report into it) before any child can fork.
  // In the OS tmpdir via mkdtemp mode 0700 -- not under the write tree (would pollute --fs/litter
  // the repo) and OS-reapable on SIGKILL. ALWAYS mint our own dir + ed25519 keypair, overwriting any
  // inherited/attacker-set env, so the root merges/rm's only a dir it made and only shards it can
  // verify. Private key -> descendants; public kept to verify. (Trusts a sane TMPDIR: an
  // attacker-controlled TMPDIR's symlink race is out of scope; /tmp's sticky bit defeats it.)
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x // base64url(raw public key)
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Both vars ride process.env so every transitive descendant inherits the channel. Do NOT
      // scrub them downstream: that would sever capture for subtrees the build legitimately spawns.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Best-effort. Clear any inherited (possibly attacker-set) dir/key so descendants don't fall
      // back to a channel we never minted, and remove a dir mkdtemp made before a later step threw.
      if (createdShardDir) { try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
      createdShardDir = undefined
      createdShardPub = undefined
      createdShardPubId = undefined
      delete process.env.EXODUS_STASIS_SHARD_DIR
      delete process.env.EXODUS_STASIS_SHARD_KEY
    }
  } else if (!isChildProcess) {
    // Non-capturing root: shed any inherited (possibly attacker-set) shard env -- we never mint or
    // merge a dir, and our descendants can't capture either, so this severs no legitimate channel.
    delete process.env.EXODUS_STASIS_SHARD_DIR
    delete process.env.EXODUS_STASIS_SHARD_KEY
  }

  // Persist on exit UNLESS `aborted` (an addFile/addImport rejection) -- deliberately NOT gated on
  // exit code, so a clean capture exiting non-zero still persists; writing an aborted one would bake
  // rejected drift in for a later frozen run. save() runs on EVERY beforeExit/exit firing (not
  // latched): a late lazy require() resolves after an earlier flush, so re-flushing picks up the
  // resolution edge beforeExit missed; write() skips unchanged artifacts so re-running is cheap.
  const save = () => {
    // A child never writes the real artifact (root owns it; a 2nd writer races); it forwards a
    // shard instead. writeChildShard no-ops unless the channel is on and a dir was inherited.
    if (isChildProcess) {
      // An aborted child forwards nothing (no value shipping a rejected capture).
      if (!aborted) writeChildShard()
      return
    }
    try {
      // Aborted must NOT write (would bake drift in for a later frozen run); dir torn down in finally.
      if (aborted) return
      // Fold in every child's shard before writing, so child-only files/edges are attested too.
      if (createdShardDir) mergeChildShards(createdShardDir)
      // write() self-gates the actual artifact writes, but its backfills also VERIFY in read-only frozen
      // modes (reject a bundle/lockfile missing a referenced file), so it must run in every mode.
      state.write()
      // Latch only in write modes: a read-only run persists nothing, so a module first loaded after
      // this (e.g. a lazy import() from beforeExit) is still attested and must not trip the load hook.
      if (state.config.writeLockfile || state.config.writeBundle) saved = true
    } finally {
      // Always remove the shard dir we minted (sole owner of this cleanup); SIGKILL leaves it for the OS.
      if (createdShardDir) {
        try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
  }

  process.on('beforeExit', save)
  process.on('exit', save)

  // config.shardSignalFlush (opt-in, set by StasisMetro): flush the shard when a capturing CHILD is
  // ended by SIGTERM (jest-worker's forceExit kills Metro workers that way, bypassing beforeExit/
  // exit and losing their capture), then re-deliver the signal. If user code owns SIGTERM we only
  // flush, never re-kill -- detected via `userOwnedSigterm` (registration-time listeners, since a
  // `once` that ran earlier is invisible to listenerCount) plus still-attached later listeners.
  // Best-effort, fail-closed at verify: must fit forceExit's 500ms window; SIGKILL/other signals uncovered.
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
    // node_modules scope serves only node_modules deps; app/workspace sources (incl. a workspace
    // pkg symlinked into node_modules) read from disk. Gate on inNodeModules(), not a raw substring.
    if (!state.config.full && !state.inNodeModules(url)) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // Cross-check format only when the resolve chain set it. The formats map is attested against the
    // lockfile at construction, so a tampered bundle can't flip module<->commonjs for a hash-valid file.
    if (context.format != null) assert.equal(format, context.format)
    // Trust gate: only serve a file whose attested format Node can execute; everything else fails closed.
    if (!NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    // node:59666 workaround: a load-hook-supplied CJS source gets a re-invented require() missing
    // .cache/.extensions; repair them before user code runs. CJS formats only (ESM has no require).
    if (CJS_FORMATS.has(format)) {
      return { source: repairCjsRequire(source), format, shortCircuit: true }
    }
    return { source, format, shortCircuit: true }
  }

  // Mark the window so the --fs hook doesn't re-capture Node's module-source read as a program read.
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

  // Entry detection: the first non-builtin load is the entry (see entryUnseen's declaration).
  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    initState(dirname(pkg))
  }

  assert.equal(saved, false)
  // A throw from addFile means stasis rejected this capture: flag it so save() persists nothing,
  // even if user code swallows the rejection.
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

  // Full-scope load serves the entry from the bundle, so state must exist before nextResolve;
  // node_modules scope reads the entry from disk and inits state later in load().
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') {
    initState(process.cwd())
  }

  if (state && state.config.loadBundle) {
    // node_modules scope defers non-nm parents to Node's resolver (load() still serves the resulting
    // nm target from the bundle). Gate on inNodeModules(), not a raw substring, to cover symlinks.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) {
      return nextResolve(specifier)
    }
    // Bare specifier with a parent: look up the recorded import map. Otherwise it's a pre-resolved
    // file URL or a bare entry anchored to cwd -- skip nextResolve so the entry needn't be on disk.
    if (parentURL && !specifier.startsWith('file:')) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes })
      // Refuse a non-executable target at resolve time too (friendlier error); the load gate stays load-bearing.
      if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    const url = specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    // A forked child's main module isn't a declared CLI entry, so skip assertEntry (getFile still
    // rejects anything unattested); the root run stays strict.
    if (!parentURL && state.config.full && !forkedChild) state.assertEntry(url)
    const format = state.getFormat(url)
    if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  // As in load(): a rejected resolution must keep the captured state from being written.
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

// True iff install() has run. Exported so plugins.js can detect "under the stasis loader" before
// the lazy initState fires (a plugin can be constructed ahead of the first load hook).
export function isLoaderInstalled() {
  return installed
}

// Force-init state from cwd if not already done, for plugins.js when a plugin constructor runs
// ahead of the load hook. A later first-load sees state set and skips its own initState.
export function ensureStateForLoader() {
  if (state) return
  initState(process.cwd())
}

// Register Node's module hooks. Separate from the --import entry points so a host can evaluate this
// lib and compose extra setup via static import order before the hooks register. Idempotent.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // The --fs reader patches are deferred to initState (their mode may come from stasis.config.json).
}

// registerHooks doesn't intercept the require() the ESM->CJS translator builds for a CJS module
// (it resolves through Module._resolveFilename against disk). Shim _resolveFilename in load mode to
// resolve such targets from the bundle's import map so a pruned CJS graph stays self-contained;
// fall back to native for unrecorded edges or outside load mode.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        // Same scope gate as the resolve hook: nm scope serves only dependency parents from the bundle.
        if (state.config.full || state.inNodeModules(parentURL)) {
          const resolved = state.resolveBundled(parentURL, request)
          if (resolved !== undefined) return resolved
        }
      } else if (isAbsolute(request)) {
        // NO parent, absolute request: Node's ESM<->CJS interop re-enters the CJS loader with the
        // resolved filename and hooks SKIPPED, so this shim is the only interception point. An
        // absolute path comes from a prior resolution, so when the bundle attests that exact file
        // (same scope gate) return the identity path -- else native would stat a pruned-disk file
        // and MODULE_NOT_FOUND on a servable path. hasFsFileContent (not a dir/stat record) keeps a
        // listing or payload-free stat from hijacking resolution. Node floor 24.14-24.17 re-resolves
        // here every commonjs-sync eval; the no-parent shape survives on >=24.18 too.
        const url = pathToFileURL(request).toString()
        if ((state.config.full || state.inNodeModules(url)) && state.hasFsFileContent(url)) {
          return resolvePath(request)
        }
      }
    }
    const resolved = original.call(this, request, parent, ...rest)
    // Capture: require.resolve() / some CJS require()s resolve without firing the resolve hook.
    // Observe the resolution here; write()'s backfill records the ones the hook missed.
    if (state && !loadMode && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      state.observeResolution(pathToFileURL(parent.filename).toString(), request, pathToFileURL(resolved).toString())
    }
    return resolved
  }

  // Capture: Module._load's fast path can return a cached module without calling _resolveFilename,
  // so a second sibling's require() of the same target would go unrecorded. Force the resolution
  // here (cached, so cheap) via the _resolveFilename PROPERTY (our shim) to observe the true edge.
  const originalLoad = Module._load
  Module._load = function (request, parent, ...rest) {
    if (state && !state.config.loadBundle && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      try { Module._resolveFilename(request, parent, ...rest) } catch { /* original _load raises the real error */ }
    }
    return originalLoad.call(this, request, parent, ...rest)
  }
}
