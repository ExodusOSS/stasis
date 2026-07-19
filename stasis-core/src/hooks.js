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

// Snapshot off the namespace so `--fs` (which patches fs.readFileSync then
// syncBuiltinESMExports()s for user code) can't redirect the reads the CJS-source
// capture and shard readers below rely on. Same rationale as state.js / state-util.js.
const { mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = fs

// Warning: only covers code imports, not file reads

// Format-category trust partition, imported from util.js under the loader's historical local
// names. NODEJS_FORMATS (util's NODE_FORMATS) is the trust boundary: a bundle-served file whose
// attested format is outside it is refused at load (and earlier at resolve) -- everything else
// fails closed. The other sets only shape the per-kind message below.

// Executable CommonJS formats (plain CJS + TS-CJS). Kept local -- a sub-partition of
// NODEJS_FORMATS the require-repair below keys off.
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
  // Unknown format string: usually a tampered or forward-incompatible bundle.
  throw new Error(
    `[stasis] cannot execute '${url}': attested format '${format}' is not a Node loader ` +
    `format. The bundle may be tampered, produced by a newer stasis, or built for a ` +
    `non-Node consumer.`
  )
}

// node:59666 workaround (see the load hook). Single-line prelude injected into served
// CommonJS source that restores the `require.cache`/`require.extensions` the ESM->CJS
// translator's re-invented require omits, pointing them at node:module's real
// `Module._cache`/`Module._extensions` so a bundle-served module's require matches a
// disk-loaded one. Guarded (typeof/try) so an odd-shaped require or frozen builtins no-ops.
const CJS_REQUIRE_REPAIR =
  "try{if(typeof require==='function'&&!require.cache){" +
  "const __stasis_m=require('node:module');" +
  'if(__stasis_m&&__stasis_m.Module){' +
  'require.cache=__stasis_m.Module._cache;' +
  'if(!require.extensions)require.extensions=__stasis_m.Module._extensions;}}}catch{}'

// Sticky scanners for the pieces of a Directive Prologue: a run of whitespace and
// line/block comments, a single string literal, and the horizontal space + SAME-LINE block
// comments that may trail a directive. Sticky (`y`) + lastIndex walks the prologue in place
// rather than re-slicing the source each step.
const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// A block comment CONTAINING a line terminator counts as one for ASI, so the trailing run
// stops there (handled as a line boundary below); this matches only single-line block
// comments (body has no line terminators).
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// Tokens that CONTINUE an expression across a line break. If the first token after the
// break following a candidate directive string is one of these, the string heads a
// multi-line expression (`'a,b'\n.split(...)`, `'x'\ninstanceof Y`) not a directive (ASI
// inserts no semicolon before them), so it must NOT be skipped. Punctuators match by first
// char; the keyword operators need `\b` so `in`/`instanceof` don't swallow `index`/`instances`.
const EXPR_CONTINUATION = new Set(['.', '[', '(', '`', '+', '-', '*', '/', '%', ',', '?', ':', '=', '<', '>', '&', '|', '^'])
const KEYWORD_CONTINUATION = /(?:instanceof|in)\b/uy
function skipSticky(re, source, i) {
  re.lastIndex = i
  re.exec(source)
  return re.lastIndex
}
// At a line boundary at `pos` (line terminator or newline-spanning block comment), does the
// next significant token begin a NEW statement -- so the preceding string is a complete
// directive -- rather than continue the expression?
function newStatementAfterBreak(source, pos) {
  const afterBreak = skipSticky(WS_COMMENTS, source, pos)
  if (afterBreak >= source.length) return true
  if (EXPR_CONTINUATION.has(source[afterBreak])) return false
  KEYWORD_CONTINUATION.lastIndex = afterBreak
  return !KEYWORD_CONTINUATION.test(source)
}

// Prepend CJS_REQUIRE_REPAIR to a served CommonJS module's source WITHOUT shifting line
// numbers (the prelude adds no line break) or perturbing the Directive Prologue -- so a
// `'use strict'` keeps strict mode. The prelude is a `try{...}` statement: inserting it
// ahead of a directive would demote that directive to an expression (sloppy mode), so we
// insert AFTER the prologue (shebang, whitespace, comments, string-literal directives). A
// leading ';' makes the insertion self-terminating so it can't fuse `'use strict'try{` into
// a SyntaxError.
//
// A leading string is a directive only when a real statement boundary follows: `;`, `}`, a
// line comment, EOF, or a LINE boundary (line terminator or block comment containing one)
// whose next token doesn't continue the expression. So a module opening with a string
// EXPRESSION (`'x'.toUpperCase()`, `'a' + b`, `'a,b'\n.split()`, `'x'\ninstanceof Y`) is
// left intact rather than split mid-expression (SyntaxError or wrong bytes), while a real
// directive followed by a banner comment still keeps strict mode. Distinguishing the two is
// the ASI problem, so this is a small scan not one regex.
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
    if (STRING_LITERAL.exec(source) === null) break // next token isn't a string: end of prologue
    const afterStr = STRING_LITERAL.lastIndex
    const afterTrail = skipSticky(TRAILING_SAME_LINE, source, afterStr)
    const c = source[afterTrail]
    let isDirective
    if (c === undefined || c === ';' || c === '}') isDirective = true
    else if (c === '/' && source[afterTrail + 1] === '/') isDirective = true // trailing line comment
    // A `/*` here is a newline-spanning block comment (single-line ones consumed above);
    // like a bare line break it terminates the directive when a new statement follows.
    else if (c === '/' && source[afterTrail + 1] === '*') isDirective = newStatementAfterBreak(source, afterTrail)
    else if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') isDirective = newStatementAfterBreak(source, afterTrail)
    else isDirective = false // same-line continuation (`.`, `+`, `,`, ...): a string expression
    if (!isDirective) break
    i = afterStr // past the directive; loop for stacked directives
  }
  return `${source.slice(0, i)};${CJS_REQUIRE_REPAIR}${source.slice(i)}`
}

let state
// The shard dir + per-build ed25519 keypair THIS process created (root only). The PRIVATE key
// is exported to descendants (each capturing child signs its shard with it); the PUBLIC key
// (createdShardPub) verifies every shard's signature, and its base64url form (createdShardPubId)
// prefixes each shard's filename. Tracked so the root merges from / removes ONLY a dir it minted,
// and accepts ONLY shards validly signed under its own keypair -- never an inherited/attacker dir
// or a foreign-signed file.
let createdShardDir
let createdShardPub
let createdShardPubId
// True once the ROOT has written its artifacts at least once (save() re-fires across
// beforeExit/exit; see its comment). Consulted by the load hook's fail-loud assert: a module
// whose BYTES first load after a write may miss the final artifact, so it crashes the capture
// rather than ship unattested. Late resolution EDGES of already-loaded modules are what the
// re-flush exists to pick up.
let saved = false
// Serialized shard text a child last wrote, so the exit firing skips an identical
// re-write instead of dropping a second (equal) shard file for the root to merge.
let lastShardWritten
// Set when stasis's own capture/verification rejects something (see the hooks around
// addFile/addImport below). Distinct from "the run exited non-zero": a clean capture is
// allowed to exit non-zero for its own reasons and still be persisted.
let aborted = false
// >0 while Node's default loader (nextLoad) reads a module's source -- which for CommonJS
// goes through the public fs.readFileSync the --fs hook patches. The module is already
// captured as code via addFile, so the --fs hook skips reads taken while this is set: it
// records the program's OWN fs reads, not Node's module loading.
let loadingModule = 0
// True until the first non-builtin load hook fires; flips to false there. Replaces the
// legacy `!state` entry-detection heuristic, which broke once initState could be triggered
// eagerly by plugins.js via ensureStateForLoader (state set before the entry's load).
let entryUnseen = true

// Child-process handling, WITHOUT intercepting child_process or adding a flag.
// EXODUS_STASIS_PID records the ROOT stasis process's pid -- the first stasis in the tree
// (CLI launch or a direct `node --import`). Unset there, so the root claims the slot with its
// own pid and may write. A child running this loader -- fork() inherits our `--import` via
// process.execArgv, a manual `spawn(node, ['--import', ...])` does so explicitly -- inherits
// EXODUS_STASIS_PID but runs under a different pid. On that mismatch we suppress the
// bundle/lockfile write for ANY child (the root owns the artifact; a second writer would race
// it). We additionally relax the entry-point check for a FORKED child (mismatch AND an IPC
// channel, which only fork() creates): its main module is a fork target, not a declared CLI
// entry, whereas a `node --import` child names its own entry. getFile() still fails closed on
// anything unattested. (A nested `stasis run` inherits the pid, so it's a child too and won't
// write; run stasis at a single level.) Resolved once, before any user code runs.
const OWN_PID = String(process.pid)
if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// Resolve once at module-load: stasis-core's own package root. Passed to State as
// `preloadRoot` so state.write()'s backfill statically captures stasis-core's internal edges
// -- the (state.js -> config.js)-shape relative imports Node loaded BEFORE install()
// registered our hooks, which the live resolve hook never observed.
//
// findPackageJSON is wrapped because bundlers that ship this file don't always have it wired
// up (a metro bundle replaces node:module with a shim lacking the API). Returning undefined
// makes the State constructor's `if (preloadRoot !== undefined)` skip cleanly; the backfill
// is best-effort and degrades gracefully when unset.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
})()

// --- Child-process capture forwarding (shards) --------------------------------------
// A forked child (e.g. a Metro transform worker) runs this loader and captures into its OWN
// State -- including files ONLY it loads, like babel.config.js and the preset/plugins the
// transformer requires per file. But a child must never write the real lockfile/bundle (the
// root owns it; two writers race -- see save()). So each capturing child writes a per-pid
// SHARD -- its shardSnapshot(), a lockfile-shaped record -- into a shared dir the ROOT creates
// and exports as EXODUS_STASIS_SHARD_DIR (inherited by every descendant). Just before writing,
// the root merges every shard back into its State (re-reading each file's bytes from disk), so
// child-only observations are still attested. Best-effort throughout: a missing/partial shard
// or unreadable dir is skipped, never fatal.
//
// OPT-IN: gated behind --child-process (config.childProcess). The shard dir is a
// process-coordination channel, not normal capture, so it exists only when a user explicitly
// enables cross-process capture (e.g. for Metro). A default run never creates it.
//
// TRUST (defense in depth against shard-channel injection):
//   - the channel only exists under the --child-process opt-in;
//   - the dir is minted in the OS tmpdir via mkdtemp (mode 0700, owner-only), so a different-uid
//     process can't read it; but trust rests on the signature gate, not the dir being secret
//     (its path travels to children in env);
//   - the root ALWAYS mints its own dir + per-build ed25519 keypair, overwriting any inherited/
//     attacker-set EXODUS_STASIS_SHARD_DIR/_KEY, and merges from / removes ONLY that dir. Only
//     the PRIVATE key reaches descendants; each child SIGNS its shard, and the root verifies every
//     shard against its own PUBLIC key. The filename carries the public key only to pre-filter --
//     trust comes from the signature, so an unsigned or foreign-signed file is rejected even under
//     the right prefix;
//   - shards carry NO bytes (mergeShard re-reads + re-hashes each file from disk), so a shard can
//     never inject forged CONTENT; it can only over-attest a file already on disk.
//   So a peer who can read the owner-only dir but NOT this process's env cannot forge a shard. The
//   residual: the private key rides in env, so ANY code the build itself runs -- a postinstall
//   script, codegen, a transitive dep -- inherits it and can mint a valid shard; and mergeShard
//   replays a shard's resolution edges via addImport without re-deriving them, so a key-holder can
//   forge edges/formats too. All within the build's own trust domain (that code already runs with
//   the build's privileges) -- the line this opt-in deliberately draws.

function shardForwardingEnabled() {
  return Boolean(state) && state.config.childProcess && (state.config.writeLockfile || state.config.writeBundle)
}

function writeChildShard() {
  if (!shardForwardingEnabled()) return
  const dir = process.env.EXODUS_STASIS_SHARD_DIR
  const keyB64 = process.env.EXODUS_STASIS_SHARD_KEY
  if (!dir || !keyB64) return
  try {
    // Sign the snapshot with the env-passed private key so the root can authenticate it. We sign
    // the exact bytes and store them verbatim beside the signature in an envelope ({ shard,
    // signature }) -- signing the string directly (not a re-stringified parse) makes verification
    // independent of JSON key ordering and robust against a future top-level `signature` key. The
    // PUBLIC key (base64url) names the file <pub>-<pid>-<rand>.json: the prefix lets the root
    // pre-filter to its own build; pid + random avoid collisions even if the OS recycles a worker's
    // pid. Write to a dot-prefixed temp then rename so the merge filter never reads a half-written
    // shard.
    const shard = state.shardSnapshot() // serialized lockfile string
    // save() re-fires on exit after the beforeExit flush (see save's comment). An unchanged
    // snapshot means nothing new to forward -- skip the duplicate rather than make the root
    // merge the same content twice.
    if (shard === lastShardWritten) return
    const privateKey = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' })
    const pubId = createPublicKey(privateKey).export({ format: 'jwk' }).x
    const signature = sign(null, Buffer.from(shard), privateKey).toString('base64url')
    const unique = `${OWN_PID}-${randomBytes(6).toString('hex')}` // pid + random: no collision even on pid reuse
    const tmpPath = join(dir, `.${pubId}-${unique}.tmp`)
    writeFileSync(tmpPath, JSON.stringify({ shard, signature }))
    renameSync(tmpPath, join(dir, `${pubId}-${unique}.json`))
    lastShardWritten = shard
  } catch {
    // A child that can't snapshot/sign/write just doesn't contribute; the root still persists
    // its own capture, and a later frozen run fails closed on anything genuinely missing.
  }
}

// Defense-in-depth bounds on a merge: cap the count + per-shard size so a hostile/runaway set
// of shards can't OOM the root. Generous -- a real toolchain shard is a small lockfile.
const MAX_SHARDS = 4096
const MAX_SHARD_BYTES = 64 * 1024 * 1024

// Merge the shards THIS root's children wrote into `dir`. Pre-filter to filenames carrying our
// public key, then AUTHENTICATE each: the file is an { shard, signature } envelope; verify the
// exact bytes against our own PUBLIC key (createdShardPub, never a key derived from the filename)
// and merge only those. So an unsigned, foreign-signed, or post-signing-tampered file is ignored
// even under our prefix. The caller (save) rm's `dir` in a finally. We iterate with opendir (not
// readdirSync) so the listing streams rather than materializing -- MEMORY stays bounded for a dir
// stuffed with entries -- and stop after MAX_SHARDS matches.
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
        if (statSync(path).size > MAX_SHARD_BYTES) continue // skip an over-large shard
        const { shard, signature } = JSON.parse(readFileSync(path, 'utf-8'))
        if (typeof shard !== 'string' || typeof signature !== 'string') continue // unsigned/malformed: reject
        if (!verify(null, Buffer.from(shard), createdShardPub, Buffer.from(signature, 'base64url'))) continue
        state.mergeShard(shard) // the exact bytes we just verified
      } catch {
        // A malformed/partial shard (a child SIGKILLed mid-write) is skipped; the rest merge.
      }
    }
  } finally {
    try { handle.closeSync() } catch { /* best-effort */ }
  }
}

// `--fs` (EXODUS_STASIS_FS = 'sync' | 'async', or "fs" in stasis.config.json): monkey-patch the
// fs readers -- readFileSync/readdirSync + lstatSync/statSync and the existence/realpath probes,
// plus under 'async' their async (callback + fs.promises) counterparts -- to capture them into the
// bundle (bundle=add|replace) or serve them from it (bundle=load). Driven off the resolved Config
// (state.config.fs), not the raw env var, so the mode can also come from stasis.config.json (read
// only once State is constructed). Called from initState AFTER the lib's own fs snapshots (fs.js /
// state.js / state-util.js) and registerHooks, so the patch never redirects stasis's own reads,
// and only when opted in. `state` is read lazily; installFsHooks is idempotent. A capture conflict
// (a file read twice with diverging bytes) taints the run like an addFile/addImport rejection, so
// nothing inconsistent is written.
function installFsHooksFromConfig() {
  const fsMode = state.config.fs
  if (!fsMode) return
  installFsHooks({
    // 'async' adds the async readers; 'sync' (the only other valid value) is sync-only.
    async: fsMode === 'async',
    getState: () => state,
    // True while Node's default loader reads a module's source: the --fs hook skips those
    // so it captures the program's explicit reads, not module loading (see loadingModule).
    isLoadingModule: () => loadingModule > 0,
    // A capture conflict (a file read twice mid-run with diverging bytes) taints the run
    // like an addFile/addImport rejection -- nothing is written. Warn on the first taint so
    // the discard isn't silent (the reads still succeed, so the run otherwise exits 0 with
    // no bundle/lockfile and no clue).
    markAborted: (err) => {
      if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
      aborted = true
    },
  })
}

function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })

  // Install the --fs reader patches now that Config is resolved (it carries the fs mode,
  // possibly from stasis.config.json). Before any child can fork and before user code runs.
  installFsHooksFromConfig()

  // Root + opt-in: create the shard dir forked children report into, BEFORE any child can fork.
  // Mint it in the OS tmpdir via mkdtemp (mode 0700, owner-only) -- NOT under the project/write
  // tree, where it would pollute an `--fs` readdir and, on a SIGKILL that skips our cleanup,
  // litter the repo (a later `--fs` run could re-capture it); tmpdir also lets the OS reap it if
  // we're hard-killed. The path isn't secret (it travels to children in env); forgery is stopped
  // by the signature, and 0700 keeps a different-uid peer from reading the dir. ALWAYS mint our
  // own dir + per-build ed25519 keypair, overwriting any inherited/attacker-set
  // EXODUS_STASIS_SHARD_DIR/_KEY, so the root only merges from -- and rm's -- a dir it created,
  // and only shards it can authenticate. The PRIVATE key is exported for descendants to sign with;
  // the root keeps the PUBLIC key to verify. Removed on every exit path (see `save`). Only the root
  // mints; a non-opt-in or non-capturing run creates nothing, so children no-op. NB: under
  // os.tmpdir(), capture integrity assumes a trustworthy TMPDIR -- an attacker-controlled (or
  // non-sticky shared) TMPDIR reopens the classic tmpdir symlink race; that's outside the threat
  // model (we defend a dir READER, not a TMPDIR controller), and /tmp's sticky bit defeats it
  // normally.
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x // base64url(raw public key)
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Only the private key travels to children, so the dir holds only public-keyed signed shards
      // and reading it (without this env) can't forge one. Both vars ride process.env, so EVERY
      // transitive descendant inherits them -- a child that itself forks/spawns (or re-invokes a
      // stasis bin) propagates the channel onward, and those grandchildren contribute too. Do NOT
      // scrub them downstream: that would sever capture for subtrees the build legitimately spawns.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Shard reporting is best-effort; capture works without it. If we threw BEFORE overwriting
      // the env, an inherited (possibly attacker-set) dir/key is still there -- clear both so
      // descendants don't fall back to a channel we never minted or validated. If mkdtemp already
      // created the dir before a later step threw, remove it too.
      if (createdShardDir) { try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
      createdShardDir = undefined
      createdShardPub = undefined
      createdShardPubId = undefined
      delete process.env.EXODUS_STASIS_SHARD_DIR
      delete process.env.EXODUS_STASIS_SHARD_KEY
    }
  } else if (!isChildProcess) {
    // Non-capturing root (--lock=frozen, or --child-process off): we never mint or merge a shard
    // dir, so shed any inherited (possibly attacker-set) EXODUS_STASIS_SHARD_DIR/_KEY. Its
    // descendants can't capture either (they inherit our non-writing config), so this severs no
    // legitimate channel -- just drops dead weight.
    delete process.env.EXODUS_STASIS_SHARD_DIR
    delete process.env.EXODUS_STASIS_SHARD_KEY
  }

  // Persist the lockfile/bundle on exit UNLESS a stasis verification rejected something.
  // We deliberately do NOT gate on the exit code: a clean capture that exits non-zero for its
  // own reasons (a server's SIGINT shutdown exiting 130, any script returning non-zero) must
  // still persist. The narrower hazard: addFile records a file's hash *before* a later check --
  // the frozen byte/format/resolution check, or a lock=add conflict -- can reject it, and
  // writing anyway would bake the rejected drift in for a later lock=frozen run to accept. So we
  // skip the write only when `aborted` is set, which the hooks set whenever addFile/addImport
  // throws -- catching a rejection even if user code swallows it and exits 0.
  //
  // An abort NOT from addFile/addImport -- an uncaught module-not-found from Node's resolver, or a
  // user error after a partial-but-clean capture -- does not taint, so files captured so far ARE
  // written: their hashes are accurate and a later lock=frozen run fails closed on anything
  // missing. Unhandled signals (SIGINT/SIGTERM with no handler) bypass exit hooks entirely;
  // servers own that, we don't touch it -- except a capturing CHILD under the
  // EXODUS_STASIS_SHARD_SIGNAL_FLUSH opt-in (see the handler below).
  //
  // save() runs on EVERY beforeExit/exit firing rather than latching after the first. Registered
  // at initState (before user code), so they fire FIRST on each event and a require() from a LATER
  // handler resolves AFTER our write. CLIs commonly log a summary at exit via a lazy require (Babel
  // interop: @react-native-community/cli-tools' logger require()s chalk on first call): the bytes
  // are usually attested via other importers, so a one-shot save drops only that resolution EDGE,
  // surfacing at bundle=load as MODULE_NOT_FOUND for a package the bundle carries. Re-running is
  // cheap -- write() skips unchanged artifacts and the child shard path keeps its own compare --
  // so the exit firing re-flushes what beforeExit missed. Requires from a user 'exit' handler AFTER
  // ours are the residual gap: 'exit' is the last stop, nothing later can flush.
  const save = () => {
    // A child (pid mismatch, fork or not) must never write the real artifact -- the root owns it
    // and a second writer would race. Instead it forwards its capture via a shard the root merges
    // below. writeChildShard no-ops unless the channel is on AND a dir was inherited: a child of a
    // non---child-process run (no dir) contributes nothing; one under --child-process inherits the
    // dir+key and does.
    if (isChildProcess) {
      // An aborted child forwards nothing -- the same fail-stance the root takes when `aborted`.
      // The root re-reads every shard so a partial one couldn't taint it, but there's no value in
      // shipping a rejected capture.
      if (!aborted) writeChildShard()
      return
    }
    try {
      // A rejection (aborted) must NOT write -- it would bake the drift in for a later frozen run
      // to accept (see above). Shard dir is still torn down in the finally.
      if (aborted) return
      // Root: fold in every child's shard before writing, so child-only files/edges (a Metro
      // worker's babel.config.js + preset/plugins) are attested too. Only when we minted a dir;
      // on a re-flush after the dir was removed, the merge no-ops (opendir fails).
      if (createdShardDir) mergeChildShards(createdShardDir)
      state.write()
      saved = true
    } finally {
      // Always remove the shard dir we minted -- clean exit, abort, or a throwing write. This is
      // the single owner of that cleanup (mergeChildShards no longer self-removes). A SIGKILL
      // bypasses exit hooks, but the dir is in the OS tmpdir, so the OS reaps it.
      if (createdShardDir) {
        try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
  }

  process.on('beforeExit', save)
  process.on('exit', save)

  // config.shardSignalFlush (EXODUS_STASIS_SHARD_SIGNAL_FLUSH, opt-in; StasisMetro sets it for
  // its build's children -- see the plugin's constructor): flush the shard when a capturing child
  // is ended BY SIGNAL. Metro's transform workers are routinely killed that way -- jest-worker's
  // end() sends END, waits 500ms for the loop to drain, then forceExit()s (SIGTERM, SIGKILL 500ms
  // later) -- so a worker whose loop doesn't drain in time dies by SIGTERM, bypassing beforeExit/
  // exit. Everything ONLY that worker observed (its fork-target entry jest-worker/processChild.js;
  // babel.config.js + the preset/plugin graph loaded per transform) then vanishes from the capture,
  // surfacing later at bundle=load as "file not attested in bundle". The handler runs the same
  // save() the exit hooks run (child: forward the shard unless aborted) and re-delivers the signal;
  // semantics are preserved:
  //   - the `once` listener is already removed when the handler runs, so with no user listener left
  //     the OS default disposition is restored and the re-kill terminates BY that signal (parent
  //     still sees code=null, signal=SIGTERM); the finally makes re-delivery unconditional even if
  //     a future save() grows a throw path (today it can't on the child branch);
  //   - when user code owns process lifetime we only flush, NOT re-kill. "User code" is detected
  //     two ways, because a `once` listener that ran EARLIER in this emit has removed itself and is
  //     invisible to a post-emit listenerCount: listeners present at REGISTRATION time (a --require
  //     preload's shutdown hook, always before this initState-time registration) are remembered in
  //     `userOwnedSigterm`, and later-added listeners are still attached at handler time. A user
  //     handler that exits normally re-flushes via the exit hooks (lastShardWritten dedups); if a
  //     SECOND signal kills it, capture after this one-shot flush is lost -- accepted residual,
  //     fail-closed at verify. Conservative by design: when in doubt don't re-kill -- worst case is
  //     jest-worker's own SIGKILL 500ms later;
  //   - signal listeners don't ref the event loop, so a cleanly-draining worker still exits (and
  //     writes) as before.
  // NOT a global default: a signal listener changes a process's default-kill disposition, the
  // user's domain in arbitrary children -- the Metro plugin opts in its KNOWN tool workers, where
  // flush-then-redeliver is right. Gated to a CHILD (the root's signal behavior stays untouched)
  // with shard forwarding on; a never-minted channel just makes the flush a no-op via
  // writeChildShard's guard. SIGTERM only -- what jest-worker's forceExit sends. Best-effort
  // residuals, all fail-closed at a later frozen/load run: the flush must fit forceExit's 500ms
  // SIGTERM->SIGKILL window; SIGKILL and other signals (group SIGINT/SIGHUP, a killSignal override)
  // aren't covered; and a child that is itself EVALUATING metro.config.js snapshots its Config
  // before the plugin sets the flag, so only its DESCENDANTS are covered -- see the plugin's KNOWN
  // LIMITATIONS bullet.
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
    // node_modules scope bundles only node_modules deps; everything else -- app/workspace
    // sources, including a workspace package symlinked into node_modules (its real path isn't
    // under node_modules, so inNodeModules() is false) -- is read from disk. Gate on the
    // canonical classification, not a raw '/node_modules/' substring: else such a symlink URL
    // would route to state.getFile and crash on a source deliberately omitted from the bundle.
    if (!state.config.full && !state.inNodeModules(url)) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // context.format may be null when the resolve chain didn't set it (node_modules scope,
    // where non-nm parents go through nextResolve and Node's default doesn't populate it).
    // Only cross-check when the chain provided one. The `formats` map is attested against the
    // lockfile at State construction (#mergeBundleMetadata), so a tampered bundle can't flip
    // module<->commonjs (or a .js to module-typescript, making Node strip `f<string>('x')`-shaped
    // syntax) for a hash-valid file. Without a lockfile the bundle is self-authoritative for
    // formats as for bytes (see getFile's hash carve-out).
    if (context.format != null) assert.equal(format, context.format)
    // Trust gate: only serve a file whose attested format Node can execute. Resource assets,
    // source-language bundles (solidity/php/bash/rust), and any unknown string a tampered or
    // forward-incompatible bundle smuggles through fail closed here with a contextual message,
    // not an opaque assertion. *-typescript formats are allowed: Node's translators strip the
    // types after this hook returns.
    if (!NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    // node:59666 workaround. When a load hook supplies `source` for a CommonJS module, Node's
    // ESM->CJS translator (loadCJSModule) hands it a re-invented require() that sets only
    // `.resolve`/`.main`, omitting `.cache`/`.extensions` -- unlike a disk-loaded CJS module's
    // require (makeRequireFunction, all four). Packages reading those (import-fresh, anything
    // walking require.cache/extensions) then throw or misbehave, but only under bundle=load (the
    // only mode serving CJS via a source override). Repair the two properties from node:module
    // before user code runs. Confined to executable CJS formats; ESM has no require, resources
    // aren't executed.
    if (CJS_FORMATS.has(format)) {
      return { source: repairCjsRequire(source), format, shortCircuit: true }
    }
    return { source, format, shortCircuit: true }
  }

  // nextLoad runs Node's default loader, which reads a CJS module's source through
  // the public fs.readFileSync the --fs hook patches. Mark the window so that hook
  // doesn't re-capture the module as a filesystem read (it's recorded as code below).
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

  // Entry detection: the FIRST non-builtin load through this hook is the entry. `entryUnseen`
  // flips to false here (see its declaration for why it replaced the `!state` heuristic). The
  // flag is module-local, not on State: it's strictly a hook-firing-order signal.
  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    initState(dirname(pkg))
  }

  assert.equal(saved, false)
  // A throw from addFile (frozen byte/format mismatch, unattested file, lock=add conflict, ...)
  // means stasis rejected this capture. Flag it so save() persists nothing, even if user code
  // swallows the rejection and exits cleanly.
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
    const expectedAttrs = Object.create(null) // Saving is not supported yet, so we ensure expected ones
    if (extname(specifier) === '.json' && context.importAttributes?.type) expectedAttrs.type = 'json'
    assert.deepStrictEqual(context.importAttributes, expectedAttrs)
  }

  const { parentURL, conditions, importAttributes } = context

  // In full-scope load mode, the entry point is served from the bundle without touching
  // disk, so state must be initialised before nextResolve runs. node_modules scope reads
  // non-nm sources (including the entry) from disk, so state is initialised later in load().
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') {
    initState(process.cwd())
  }

  if (state && state.config.loadBundle) {
    // node_modules scope defers resolution of non-nm parents to Node: relative imports between
    // non-nm sources resolve to local files, bare specifiers via the on-disk node_modules layout
    // -- but load() still serves the resulting node_modules target from the bundle, so package
    // contents need not be on disk. A workspace source linked into node_modules is a non-nm parent
    // (canonical path outside node_modules), so it's deferred too -- hence inNodeModules() rather
    // than a raw '/node_modules/' substring.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) {
      return nextResolve(specifier)
    }
    // Bare specifier with a parent is the regular ESM import: look up the recorded import map.
    // Otherwise it's a pre-resolved file URL (CLI entries and ESM->CJS translator require()
    // targets both arrive that way) or a bare entry specifier we anchor to cwd -- either way skip
    // nextResolve so the entry file needn't exist on disk.
    if (parentURL && !specifier.startsWith('file:')) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes })
      // Refuse a non-executable target at resolve time too -- the same tampered/asset cases load()
      // catches, but earlier and with the parent's URL in the stack trace. The load gate stays the
      // load-bearing one (a sibling resolver could bypass this branch); this is just a friendlier
      // failure point.
      if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
      return { url, format, importAttributes: undefined, shortCircuit: true }
    }
    const url = specifier.startsWith('file:')
      ? specifier
      : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
    // A forked child's main module is whatever the parent passed to fork(), not a declared
    // CLI entry, so it need not be in the bundle's entries list -- getFile() below still
    // rejects anything the bundle doesn't attest. The root run stays strict.
    if (!parentURL && state.config.full && !forkedChild) state.assertEntry(url)
    const format = state.getFormat(url)
    if (format != null && !NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  // As in load(): a rejected resolution (frozen redirect mismatch, conflict, ...) must keep
  // the captured state from being written, swallowed or not.
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

// True iff install() has run. Exported so plugins.js can detect "we're running under the stasis
// loader" before the lazy initState fires -- a bundler plugin constructed during webpack's
// config-parse can run AHEAD of the first load hook, leaving State.preload null. resolvePluginState
// reads this to force-init State from cwd so the plugin inherits the loader's config rather than
// erroring on the default lock mode.
export function isLoaderInstalled() {
  return installed
}

// Force-initialize state from process.cwd() if not already done. Used by plugins.js's
// resolvePluginState so State.preload is available when the plugin constructor runs ahead of the
// load hook. A later first-load then detects "state already set" and skips its own initState, but
// still marks isEntry via entryUnseen.
export function ensureStateForLoader() {
  if (state) return
  initState(process.cwd())
}

// Register Node's module hooks. Kept separate from the --import entry points (loader.js; the
// @exodus/stasis package's loader and --mock loader) so a host can evaluate this lib --
// snapshotting node:fs/path/etc. for stasis's own use -- and compose extra setup (e.g. --mock
// side-effect denials) via static import order BEFORE the hooks register, with no env-var
// coordination. Idempotent.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // NB: the `--fs` reader patches are NOT installed here. Their mode can come from
  // stasis.config.json (read only once State is constructed), so installation is deferred to
  // initState() (see installFsHooksFromConfig), still before any user code. install() only
  // registers the module hooks the fs patch composes on top of.
}

// registerHooks intercepts the ESM loader and Node's native CommonJS loader, but NOT the require()
// the ESM->CJS translator (node:internal/modules/esm/translators) builds for a CJS module: that
// require resolves through Module._resolveFilename against disk before any hook runs. So a CJS
// module we serve from the bundle (`import chalk from 'chalk'`, chalk being CommonJS) has its
// nested require()s resolved on disk -- and once node_modules is pruned, `require('escape-string-
// regexp')` throws MODULE_NOT_FOUND before our hooks can serve it, i.e. the bundle isn't
// self-contained for a CJS graph. Shim _resolveFilename in load mode to resolve such a target from
// the bundle's import map and return its (possibly disk-absent) path; load() then serves the bytes.
// For an unrecorded edge, or outside load mode, fall back to native resolution.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        // Same scope gate the resolve hook applies (see above): node_modules scope serves only
        // dependency parents from the bundle; workspace/app code is left to native resolution.
        // Without this the shim would take over CJS resolution for app files too.
        if (state.config.full || state.inNodeModules(parentURL)) {
          const resolved = state.resolveBundled(parentURL, request)
          if (resolved !== undefined) return resolved
        }
      } else if (isAbsolute(request)) {
        // NO parent, request already absolute: Node's ESM<->CJS interop re-enters the
        // monkey-patchable CJS loader with the RESOLVED filename, no parent, and registerHooks
        // hooks SKIPPED -- translators.js evaluates an import-linked CJS module via
        // wrapModuleLoad(filename, undefined|null, isMain, kShouldSkipModuleHooks) (the
        // 'commonjs-sync' translator, reached whenever a require() pulls an ESM graph that imports
        // a CJS dep; also createCJSNoSourceModuleWrap), and resolveForCJSWithHooks bypasses the
        // resolve hook -- so this shim is the ONLY interception point. An absolute path can only
        // arrive from a prior successful resolution (ours or Node's), so when the bundle attests
        // that exact FILE under the same scope gate the resolution is the identity (returned
        // path.resolve()d, matching native's normalized cache-key contract). Falling through to
        // native would stat a file the bundle carries but pruned disk may lack -- MODULE_NOT_FOUND
        // on a servable path. hasFsFileContent (byte content, not getFsStat's kind) keeps a
        // --fs-captured directory LISTING or payload-free 'stat:*' record -- whose bytes the bundle
        // can't serve -- from hijacking native resolution. Widens parentless reachability to any
        // attested in-scope file when disk lacks the path, bounded by attestation and the load
        // hook's gates (getFile + NODEJS_FORMATS). Node >=24.18 forwards pre-resolved context,
        // masking the common case; on 24.14-24.17 (our floor) every commonjs-sync eval re-resolves
        // here, and the no-parent shape survives on >=24.18 too (deferred-resolution branch and
        // createCJSNoSourceModuleWrap).
        const url = pathToFileURL(request).toString()
        if ((state.config.full || state.inNodeModules(url)) && state.hasFsFileContent(url)) {
          return resolvePath(request)
        }
      }
    }
    const resolved = original.call(this, request, parent, ...rest)
    // Capture: require.resolve() (and, on some Node versions, CJS require()s)
    // resolve through native Module._resolveFilename WITHOUT firing the resolve
    // hook, so addImport never sees them. Observe the resolution here; write()'s
    // backfill records the ones the hook missed (deduped, in-bundle targets only).
    if (state && !loadMode && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      state.observeResolution(pathToFileURL(parent.filename).toString(), request, pathToFileURL(resolved).toString())
    }
    return resolved
  }

  // Capture: Module._load's fast path (relativeResolveCache, keyed by parent DIRECTORY + request)
  // returns an already-loaded module WITHOUT calling _resolveFilename -- so a SECOND sibling's
  // require() of a target the first already loaded never reaches the observe shim, and the edge is
  // recorded only under the first importer (under-recording). _load runs for EVERY require()
  // including cache hits, so force the resolution here to observe the true per-importer edge;
  // _resolveFilename is cached so this is cheap, and a resolution error is left for the original
  // _load to raise. We call the PROPERTY `Module._resolveFilename` (our shim), not a captured ref,
  // so it routes through observeResolution.
  const originalLoad = Module._load
  Module._load = function (request, parent, ...rest) {
    if (state && !state.config.loadBundle && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      try { Module._resolveFilename(request, parent, ...rest) } catch { /* original _load raises the real error */ }
    }
    return originalLoad.call(this, request, parent, ...rest)
  }
}
