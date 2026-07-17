import Module, { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { State } from './state.js'
import { installFsHooks } from './fs.js'

// Snapshot off the namespace so `--fs` (which patches fs.readFileSync and then
// syncBuiltinESMExports()s for user code) can't redirect the read the CJS-source
// capture below relies on. Same rationale as state.js / state-util.js. The shard
// readers/writers below are snapshotted for the same reason (and writes aren't patched
// by --fs anyway, but reads are).
const { mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = fs

// Warning: only covers code imports, not file reads

// Formats Node's module loader recognizes (and either executes, like `module`/
// `commonjs`/typescript variants, or imports as data, like `json`). The runtime
// loader treats this as the trust boundary -- a file served from the bundle whose
// attested format is outside this allowlist is refused at load time (and earlier
// at resolve, where applicable) with a contextual message. Adding a tag here
// means "Node can handle it"; everything else (resource/asset content,
// source-language bundles, an unknown string from a tampered or newer bundle)
// fails closed.
const NODEJS_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])

// Per-kind messages for the few categories we recognize; everything else gets a
// generic "unrecognized format" message. Kept separate from NODEJS_FORMATS so
// the allowlist stays the single trust gate and the message is just UX.
const NON_NODE_SOURCE_LANGUAGES = new Set(['solidity', 'php', 'bash', 'rust'])
const RESOURCE_FORMATS = new Set(['resource', 'resource:base64'])
const STAT_FORMATS = new Set(['stat:file', 'stat:directory'])
// The executable CommonJS formats (plain CJS + TS-CJS). Named like the sets above so
// "which formats are CJS" lives in one place; the require-repair below keys off it.
const CJS_FORMATS = new Set(['commonjs', 'commonjs-typescript'])

function refuseNonNodeFormat(format, url) {
  if (NON_NODE_SOURCE_LANGUAGES.has(format)) {
    throw new Error(
      `[stasis] cannot execute a '${format}' bundle: ${format} bundles are ` +
      `produced for external analysis, not for 'stasis run --bundle=load' (${url})`
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

// node:59666 workaround (see the load hook). A single-line prelude, injected
// into served CommonJS source, that restores the `require.cache` and
// `require.extensions` the ESM->CJS translator's re-invented require omits.
// `require` here is the module wrapper's own parameter; node:module's CJS
// loader owns the real `Module._cache` / `Module._extensions`, so pointing the
// two properties at those makes a bundle-served module's require match a
// disk-loaded one's shape. Guarded (typeof/try) so a require without the usual
// shape, or a frozen builtins object, degrades to a no-op rather than throwing.
const CJS_REQUIRE_REPAIR =
  "try{if(typeof require==='function'&&!require.cache){" +
  "const __stasis_m=require('node:module');" +
  'if(__stasis_m&&__stasis_m.Module){' +
  'require.cache=__stasis_m.Module._cache;' +
  'if(!require.extensions)require.extensions=__stasis_m.Module._extensions;}}}catch{}'

// Sticky scanners for the pieces of a Directive Prologue: a run of whitespace and
// line/block comments, a single string literal, and the run of horizontal space and
// SAME-LINE block comments that may trail a directive before its terminator. Sticky (`y`)
// + lastIndex so the prologue is walked in place, never by re-slicing the source each step.
const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// A block comment that CONTAINS a line terminator counts as a line terminator for ASI, so
// the trailing run stops at one (it's handled as a line boundary below); this matches only
// single-line block comments (comment body has no line terminators).
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// Tokens that CONTINUE an expression across a line break. If the first token after the
// break following a candidate directive string is one of these, the string heads a
// multi-line expression (`'a,b'\n.split(...)`, `'x'\ninstanceof Y`), not a directive
// (ASI does not insert a semicolon before them), so it must NOT be skipped. Punctuators
// are matched by first char; the two keyword operators need a `\b` so `in`/`instanceof`
// don't swallow identifiers like `index`/`instances`.
const EXPR_CONTINUATION = new Set(['.', '[', '(', '`', '+', '-', '*', '/', '%', ',', '?', ':', '=', '<', '>', '&', '|', '^'])
const KEYWORD_CONTINUATION = /(?:instanceof|in)\b/uy
function skipSticky(re, source, i) {
  re.lastIndex = i
  re.exec(source)
  return re.lastIndex
}
// At a line boundary at `pos` (a line terminator or a newline-spanning block comment), does
// the next significant token begin a NEW statement -- so the preceding string is a complete
// directive -- rather than continue the expression?
function newStatementAfterBreak(source, pos) {
  const afterBreak = skipSticky(WS_COMMENTS, source, pos)
  if (afterBreak >= source.length) return true
  if (EXPR_CONTINUATION.has(source[afterBreak])) return false
  KEYWORD_CONTINUATION.lastIndex = afterBreak
  return !KEYWORD_CONTINUATION.test(source)
}

// Prepend CJS_REQUIRE_REPAIR to a served CommonJS module's source WITHOUT shifting line
// numbers (the prelude adds no line break) and WITHOUT perturbing the module's Directive
// Prologue -- so a `'use strict'` directive keeps strict mode. The prelude is a `try{...}`
// statement: inserting it ahead of a directive would demote that directive to a plain
// expression (dropping the module to sloppy mode), so we insert AFTER the prologue --
// shebang, then whitespace, comments, and string-literal directive STATEMENTS. A leading
// ';' makes the insertion self-terminating so it can never fuse `'use strict'try{` into a
// SyntaxError.
//
// A leading string counts as a directive only when a real statement boundary follows it:
// `;`, `}`, a line comment, EOF, or a LINE boundary -- a line terminator OR a block comment
// containing one -- whose next token does not continue the expression. So a module that
// opens with a string EXPRESSION (`'x'.toUpperCase()`, `'a' + b`, `'a,b'` newline-then-
// `.split()`, `'x'` newline-then-`instanceof Y`) is left intact instead of being split
// mid-expression (a SyntaxError, or silently wrong bytes), while a real directive followed
// by a multi-line banner comment still keeps strict mode. Distinguishing the two is the ASI
// problem, so this is a small scan rather than one regex.
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
    // A `/*` here is a newline-spanning block comment (single-line ones were consumed
    // above); like a bare line break it terminates the directive when a new statement follows.
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
// is exported to descendants via env (each capturing child signs its shard with it); the PUBLIC
// key (createdShardPub, a KeyObject) is what the root verifies every shard's signature against,
// and its base64url form (createdShardPubId) prefixes each shard's filename. Tracked so the root
// merges from / removes ONLY a dir it minted, and accepts ONLY shards that carry a valid
// signature under the keypair it minted -- never an inherited/attacker dir or a foreign-signed file.
let createdShardDir
let createdShardPub
let createdShardPubId
// True once the ROOT has written its artifacts at least once (save() is re-entrant across
// beforeExit/exit firings and re-flushes late-observed resolution edges; see its comment).
// Consulted by the load hook's fail-loud assert: a module whose BYTES first load after a
// write may miss the final artifact entirely, so it must crash the capture rather than
// silently ship unattested. Late resolution EDGES of already-loaded modules, by contrast,
// are what the re-flush exists to pick up.
let saved = false
// Serialized shard text a child last wrote, so the exit firing skips an identical
// re-write instead of dropping a second (equal) shard file for the root to merge.
let lastShardWritten
// Set when stasis's own capture/verification rejects something (see the hooks around
// addFile/addImport below). Distinct from "the run exited non-zero": a clean capture is
// allowed to exit non-zero for its own reasons and still be persisted.
let aborted = false
// >0 while Node's default loader (nextLoad) is reading a module's source -- which for
// CommonJS goes through the public fs.readFileSync the --fs hook patches. The module is
// already captured as code via addFile, so the --fs capture hook skips reads taken
// while this is set: it records the program's OWN fs reads, not Node's module loading.
let loadingModule = 0
// True until the first non-builtin load hook fires. Replaces the legacy
// `!state` heuristic for entry detection, which broke once initState could
// be triggered eagerly by plugins.js via ensureStateForLoader (state set
// before the entry's load).
let entryUnseen = true

// Child-process handling, WITHOUT intercepting child_process or adding a flag.
// EXODUS_STASIS_PID records the ROOT stasis process's pid -- the first stasis process in the
// tree (the one the CLI launches, or a direct `node --import`). It is unset there, so the
// root claims the slot with its own pid and is allowed to write. A process that ends up
// running this loader as a child -- child_process.fork() inherits our `--import` via
// process.execArgv automatically; a manual `spawn(node, ['--import', <loader>, ...])` does so
// explicitly -- inherits EXODUS_STASIS_PID through the environment but runs under a different
// pid. On that mismatch we suppress the bundle/lockfile write for ANY child, fork or not --
// the root owns the artifact, and a second writer to the same path would race it. We
// additionally relax the entry-point check for a FORKED child specifically (mismatch AND an
// IPC channel, which fork() always creates and a non-fork child lacks): its main module is a
// fork target, not a declared CLI entry, whereas a `node --import` child names its own entry.
// getFile() still fails closed on anything unattested. (A `stasis run` nested inside an
// already-running stasis process inherits the pid and is thus treated as a child too -- it
// won't write; run stasis at a single level.) Resolved once, before any user code runs.
const OWN_PID = String(process.pid)
if (!process.env.EXODUS_STASIS_PID) process.env.EXODUS_STASIS_PID = OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// Resolve once at module-load: stasis-core's own package root. Passed to State
// as `preloadRoot` so state.write()'s backfill statically captures stasis-core's
// internal edges -- the (state.js -> config.js)-shape relative imports that
// were loaded by Node BEFORE install() registered our hooks and that the live
// resolve hook therefore never observed.
//
// `findPackageJSON` is wrapped because bundlers that ship this file as part
// of a captured bundle don't always have it mocked / wired up -- e.g. a
// metro-built bundle replaces node:module with its own shim where the API
// is absent. Returning undefined on failure makes the State constructor's
// `if (preloadRoot !== undefined)` skip cleanly; the backfill that consumes
// preloadRoot is a best-effort feature and falls through gracefully when
// it's unset.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
})()

// --- Child-process capture forwarding (shards) --------------------------------------
// A forked child (e.g. a Metro transform worker) runs this loader and captures into its OWN
// State -- including files ONLY it loads, like babel.config.js and the babel preset/plugins
// the transformer requires per file. But a child must never write the real lockfile/bundle
// (the root owns it; two writers race -- see save()). So each capturing child instead writes
// a per-pid SHARD -- its shardSnapshot(), a lockfile-shaped record of what it captured -- into
// a shared dir the ROOT creates and exports as EXODUS_STASIS_SHARD_DIR (inherited through the
// env by every descendant). Just before the root writes, it merges every shard back into its
// State (re-reading each file's bytes from disk), so observations only a child made are still
// attested. Best-effort throughout: a missing/partial shard (a child killed mid-write) or an
// unreadable dir is skipped, never fatal -- the root's own capture is unaffected.
//
// OPT-IN: gated behind --child-process (config.childProcess). The shard dir is a
// process-coordination channel, not part of normal capture, so it exists only when a user
// explicitly enables cross-process capture (e.g. for Metro). A default run never creates it.
//
// TRUST (defense in depth against shard-channel injection):
//   - the channel only exists under the --child-process opt-in;
//   - the dir is minted in the OS tmpdir via mkdtemp, which creates it mode 0700 (owner-only), so
//     a different-uid process can't read its contents; trust does NOT rest on the dir being secret
//     (its path travels to children in env) -- it rests on the signature gate below;
//   - the root ALWAYS mints its own dir + a per-build ed25519 keypair, overwriting any
//     inherited/attacker-set EXODUS_STASIS_SHARD_DIR/_KEY, and merges from / removes ONLY
//     that dir. Only the PRIVATE key reaches descendants (via env); each child SIGNS its shard
//     with it, and the root verifies every shard against its own PUBLIC key, accepting only a
//     valid signature. The filename carries the public key (non-secret) purely to pre-filter;
//     trust comes from the signature, NOT the filename -- a file signed by some other keypair,
//     or unsigned, is rejected even if it's named with the right public-key prefix;
//   - shards carry NO bytes -- mergeShard re-reads each file from disk and re-hashes -- so a shard
//     can never inject forged file CONTENT (bytes); it can only over-attest a file already on disk.
//   Because the dir holds only public-keyed, signed shards, a peer who can read the (owner-only)
//   dir but NOT this process's env cannot forge one. The residual is broader than a /proc snooper:
//   the private key rides in the environment, so ANY code the build itself executes -- a postinstall
//   script, codegen, a transitive dependency -- inherits it and can mint a valid shard. And a valid
//   shard does more than over-attest bytes: mergeShard replays its resolution edges via addImport
//   WITHOUT re-deriving them on disk, so a key-holder can also forge resolution edges (and formats).
//   All of that is within the build's own trust domain -- that code already runs with the build's
//   privileges -- which is the line this opt-in deliberately draws.

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
    // the snapshot's exact bytes and store them verbatim next to the signature in an envelope
    // ({ shard, signature }) -- signing the string directly, rather than mutating + re-stringifying
    // the parsed object, makes verification independent of JSON key ordering and robust against a
    // future top-level `signature` lockfile key. The PUBLIC key (base64url) names the file --
    // <base64url(public)>-<pid>-<rand>.json: the public prefix lets the root cheaply pre-filter to
    // its own build; the pid + random suffix keep workers from colliding even if the OS recycles an
    // exited worker's pid within one build. Write to a dot-prefixed temp then rename: the merge
    // filter ignores the temp, so the root never reads a half-written shard.
    const shard = state.shardSnapshot() // serialized lockfile string
    // save() re-fires on exit after the beforeExit flush (late-observed resolution edges;
    // see save's comment). An unchanged snapshot means nothing new to forward -- skip the
    // duplicate shard file rather than make the root merge the same content twice.
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

// Merge the shards THIS root's children wrote into `dir` (the dir we created). We pre-filter to
// filenames carrying our public key, then AUTHENTICATE each: the file is an { shard, signature }
// envelope; verify the shard's exact bytes against our own PUBLIC key (createdShardPub -- never a
// key derived from the filename) and merge only those verified bytes. So a file that's unsigned,
// foreign-signed, or tampered after signing (e.g. dropped by a non-descendant that doesn't hold
// the private key) is ignored even if it's named with our prefix. The caller (save) removes `dir`
// afterward in a finally, so a partial read here never leaves it behind. We iterate with opendir
// (not readdirSync) so the listing is streamed, never materialized -- MEMORY stays bounded even for
// a dir stuffed with entries -- and stop parsing/verifying after MAX_SHARDS matching shards.
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
// and under 'async' their async (callback + fs.promises) counterparts -- to capture them into the
// bundle (bundle=add|replace) or serve them from it (bundle=load). Driven off the resolved Config
// (state.config.fs) rather than the raw env var, so the mode can also come from stasis.config.json
// -- which isn't read until State is constructed. Called from initState (which fires on the first
// load/resolve hook, before any user code runs), AFTER the lib's own fs snapshots (fs.js /
// state.js / state-util.js, all taken at module-eval) and after registerHooks -- so the patch
// never redirects stasis's own reads, and only when the user opted in. `state` is read lazily
// (per call); installFsHooks is internally idempotent. A capture-side conflict (a file read twice
// with diverging bytes) taints the run the same way an addFile/addImport rejection does, so
// nothing inconsistent is written.
function installFsHooksFromConfig() {
  const fsMode = state.config.fs
  if (!fsMode) return
  installFsHooks({
    // 'async' adds the async readers; 'sync' (the only other valid value) is sync-only.
    async: fsMode === 'async',
    getState: () => state,
    // True while Node's default loader is reading a module's source: the --fs hook
    // skips those so it captures the program's explicit reads, not module loading.
    isLoadingModule: () => loadingModule > 0,
    // A genuine capture conflict (a file read twice mid-run with diverging bytes)
    // taints the run like an addFile/addImport rejection -- nothing is written.
    // Warn on the first taint so the discard isn't silent (the user's reads still
    // succeed, so the run otherwise exits 0 with no bundle/lockfile and no clue).
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

  // Root + opt-in: create the shard dir forked children report into, BEFORE any child can fork
  // (initState fires on the first load, ahead of user code spawning workers). Mint it in the OS
  // tmpdir via mkdtemp (mode 0700, owner-only) -- NOT under the project/write-target tree, where a
  // dir would pollute an `--fs` readdir of the root and, on a SIGKILL that skips our exit cleanup,
  // litter the repo (a later `--fs` run could even re-capture it). tmpdir keeps the scaffolding out
  // of the captured tree and lets the OS reap it if we're hard-killed. The location is not a secret
  // (its path travels to children in env); forgery is stopped by the signature, and the 0700 mode
  // keeps a different-uid peer from reading the dir's contents. ALWAYS mint our own dir + per-build
  // ed25519 keypair, overwriting any inherited/attacker-set EXODUS_STASIS_SHARD_DIR/_KEY, so the
  // root only ever merges from -- and rm's -- a dir it created, and only shards it can
  // authenticate. The PRIVATE key is exported so descendants inherit it and sign their shards; the
  // root keeps the PUBLIC key to verify. The dir is removed on every exit path (see `save`). Only
  // the root mints (children are isChildProcess); a non-opt-in or non-capturing run creates
  // nothing, so children no-op. NB: the dir lives under os.tmpdir(), so capture integrity assumes a
  // trustworthy TMPDIR -- a TMPDIR an attacker controls (or a non-sticky shared one) reopens the
  // classic tmpdir symlink race; that is outside the threat model (we defend a dir READER, not a
  // TMPDIR controller), and /tmp's sticky bit defeats it in the normal case.
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x // base64url(raw public key)
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Only the private key travels to children: the dir then holds only public-keyed, signed
      // shards, so reading the dir (without this env) is not enough to forge one. These two vars
      // ride process.env, so EVERY transitive descendant inherits them -- a child that itself
      // forks/spawns a subprocess (or re-invokes a stasis bin) propagates the channel onward, and
      // those grandchildren contribute shards too. Do NOT scrub them anywhere downstream: that would
      // sever capture for whole subtrees the build legitimately spawns.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Shard reporting is a best-effort enhancement; capture still works without it. If we threw
      // BEFORE overwriting the env, an inherited (possibly attacker-set) dir/key is still in it --
      // clear both so descendants don't fall back to a channel we never minted or validated. If
      // mkdtemp already created the dir before a later step threw, remove the (empty) dir too.
      if (createdShardDir) { try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
      createdShardDir = undefined
      createdShardPub = undefined
      createdShardPubId = undefined
      delete process.env.EXODUS_STASIS_SHARD_DIR
      delete process.env.EXODUS_STASIS_SHARD_KEY
    }
  } else if (!isChildProcess) {
    // Non-capturing root (--lock=frozen, or --child-process off): we never mint or merge a shard
    // dir, so shed any inherited (possibly attacker-set) EXODUS_STASIS_SHARD_DIR/_KEY rather than
    // leave them in our env. A non-capturing root's descendants can't capture either (they inherit
    // our non-writing config), so this severs no legitimate channel -- it just drops dead weight.
    delete process.env.EXODUS_STASIS_SHARD_DIR
    delete process.env.EXODUS_STASIS_SHARD_KEY
  }

  // Persist the lockfile/bundle on exit UNLESS a stasis verification rejected something.
  // We deliberately do NOT gate on the exit code: a clean capture that exits non-zero for
  // its own reasons -- a server running its own SIGINT shutdown and exiting 130, or any
  // script that returns non-zero -- must still persist what it captured. The hazard we
  // guard is narrower: addFile records a file's hash (which lock=add/replace then
  // serializes) *before* a later check -- the frozen bundle's byte/format/resolution
  // check, or a lock=add conflict against an existing lockfile -- can reject it. Writing
  // that would bake the rejected drift into the lockfile/bundle, so a subsequent
  // lock=frozen run would accept it. So we skip the write only when `aborted` is set, which
  // the hooks set whenever addFile/addImport throws -- catching a stasis rejection even if
  // user code swallows it (try/catch around a dynamic import) and exits 0.
  //
  // An abort that does NOT originate in addFile/addImport -- an uncaught module-not-found
  // (thrown by Node's resolver), or a user error after a partial-but-clean capture -- does
  // not taint, so the files captured so far ARE still written. That is intentional and
  // safe: those recorded hashes are accurate (nothing drifted is baked in), and a later
  // lock=frozen run fails closed on anything missing. Unhandled signals (SIGINT/SIGTERM
  // with no handler) bypass exit hooks entirely; servers own that behavior, we don't touch it.
  //
  // save() runs on EVERY beforeExit/exit firing rather than latching after the first.
  // These handlers were registered at initState -- before any user code ran -- so they fire
  // FIRST on each event, and a require() issued by a LATER handler on the same event
  // resolves AFTER our write. CLIs commonly log a summary at exit through a lazy require
  // (Babel lazy interop: @react-native-community/cli-tools' logger require()s chalk on
  // its first call): the target's bytes are usually attested via other importers, so a
  // one-shot save silently dropped only that resolution EDGE, surfacing at bundle=load
  // as MODULE_NOT_FOUND for a package the bundle carries. Re-running is cheap -- write()
  // compares each artifact's serialized text and skips unchanged outputs, and the child
  // shard path keeps its own last-written compare -- so the exit firing re-flushes
  // whatever the beforeExit firing missed. Requires issued by a user 'exit' handler
  // AFTER ours are the residual gap: 'exit' is the last stop, nothing later can flush.
  const save = () => {
    // A child process (pid mismatch) must never write the real artifact -- fork OR a non-fork
    // child that inherited our loader: the root owns the lockfile/bundle, and a second writer
    // would race it. Instead it forwards what it captured via a shard the root merges below.
    // writeChildShard no-ops unless the channel is on AND a shard dir was inherited: a child of a
    // non---child-process run (no dir minted) contributes nothing, while a child under
    // --child-process (forked or a spawned `node --import` loader) inherits the dir+key and does.
    if (isChildProcess) {
      // An aborted child (its own addFile/addImport rejected something) forwards nothing -- the
      // same fail-stance the root takes when `aborted`. The root re-reads + noupserts every shard
      // so a partial one couldn't taint it, but there's no value in shipping a rejected capture.
      if (!aborted) writeChildShard()
      return
    }
    try {
      // A stasis rejection (addFile/addImport threw -> aborted) must NOT write -- that would bake
      // the rejected drift into the lockfile/bundle, so a later frozen run would accept it. We
      // still tear down the shard dir in the finally below.
      if (aborted) return
      // Root: fold in every forked child's shard before writing, so files/edges only a child
      // observed (e.g. a Metro worker's babel.config.js + preset/plugins) are attested too. Only
      // when we minted a shard dir (opt-in + capturing); merges from that dir alone. On a
      // re-flush after the dir was already removed below, the merge no-ops (opendir fails).
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
}

function load(url, context, nextLoad) {
  assert.equal(typeof url, 'string')

  if (url.startsWith('node:')) {
    const result = nextLoad(url, context)
    assert.equal(result.format, 'builtin')
    return result
  }

  if (state && state.config.loadBundle) {
    // node_modules scope only bundles node_modules deps; everything else -- app/workspace
    // sources, including a workspace package symlinked into node_modules (its real path is
    // not under node_modules, so inNodeModules() is false) -- is read from disk via Node's
    // default loader. Gate on the canonical classification, not a raw '/node_modules/'
    // substring: otherwise such a symlink URL would be routed to state.getFile and crash,
    // since the file is a source deliberately omitted from the node_modules-scope bundle.
    if (!state.config.full && !state.inNodeModules(url)) {
      return nextLoad(url, context)
    }
    const { source, format } = state.getFile(url)
    // context.format may be null when the resolve chain didn't set it (e.g. node_modules
    // scope, where non-nm parents go through nextResolve and Node's default doesn't
    // populate format for the load hook). Only cross-check when the chain provided one.
    // The `formats` map this value comes from is attested against the lockfile at State
    // construction (#mergeBundleMetadata) when a lockfile is loaded -- so a tampered
    // bundle can't flip module<->commonjs (or a .js file to module-typescript, which
    // would make Node strip type-argument-shaped syntax like `f<string>('x')`) for a
    // hash-valid file. Without a lockfile the bundle is self-authoritative for formats
    // just as it is for bytes (see getFile's hash carve-out).
    if (context.format != null) assert.equal(format, context.format)
    // Trust gate: the loader will only serve a file whose attested format Node
    // can actually execute. Resource assets (`resource`, `resource:base64`),
    // source-language bundles (solidity/php/bash/rust), and any unknown string
    // a tampered or forward-incompatible bundle might smuggle through all fail
    // closed here with a contextual message -- never as an opaque assertion.
    // *-typescript formats are in the allowlist: Node's own translators strip
    // the types after this hook returns.
    if (!NODEJS_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    // node:59666 workaround. When a load hook supplies `source` for a CommonJS
    // module, Node's ESM->CJS translator (loadCJSModule) hands the module a
    // *re-invented* require() that sets only `.resolve`/`.main` and omits
    // `.cache` and `.extensions` -- unlike the require a disk-loaded CJS module
    // gets (makeRequireFunction, which sets all four). Packages that read those
    // (import-fresh, and anything walking require.cache / require.extensions)
    // then throw `Cannot read properties of undefined` or misbehave -- but only
    // under bundle=load, because that's the only mode that serves CJS via a
    // source override. Repair the two missing properties from node:module
    // before user code runs. Confined to executable CJS formats; ESM has no
    // require and resources are not executed.
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

  // Entry detection: the FIRST non-builtin load through this hook is the
  // entry. `entryUnseen` (set true on every state init) flips to false after
  // the first load fires here. The pre-existing heuristic was `!state` --
  // tight while initState was lazy, but a plugin-driven `ensureStateForLoader`
  // path now eager-inits from cwd before the first load, so `!state` would
  // miss the entry. The flag lives module-local rather than on State because
  // it's strictly a hook-firing-order signal.
  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) {
    const pkg = findPackageJSON(url)
    assert.equal(basename(pkg), 'package.json')
    initState(dirname(pkg))
  }

  assert.equal(saved, false)
  // A throw from addFile -- a frozen byte/format mismatch, an unattested file, a lock=add
  // conflict against an existing lockfile, ... -- means stasis rejected this capture. Flag
  // it so save() persists nothing, even if user code swallows the rejection (a try/catch
  // around a dynamic import) and the process then exits cleanly.
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
    // node_modules scope defers resolution of non-nm parents to Node. Relative imports
    // between non-nm sources then resolve to local files, and bare specifiers resolve via
    // the on-disk node_modules layout -- but the load() hook still serves the resulting
    // node_modules target from the bundle, so package contents need not be on disk. A
    // workspace source linked into node_modules is a non-nm parent (its canonical path is
    // outside node_modules), so it too is deferred -- hence inNodeModules() rather than a
    // raw '/node_modules/' substring on parentURL.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) {
      return nextResolve(specifier)
    }
    // Bare specifier with a parent is the regular ESM import: look up the recorded
    // import map. Otherwise we have either a pre-resolved file URL (CLI entries and
    // ESM-to-CJS translator require() targets both arrive that way) or a bare entry
    // specifier we anchor to cwd -- either way, skip nextResolve so the entry file
    // doesn't need to exist on disk.
    if (parentURL && !specifier.startsWith('file:')) {
      const { url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes })
      // Refuse a non-executable target at resolve time too. Catches the same
      // tampered/asset cases load() catches, just earlier and with the parent
      // module's URL in the stack trace for easier diagnosis. The load gate
      // remains the load-bearing one (a sibling resolver could deliver a target
      // that bypasses this branch); we throw here as a friendlier failure point.
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

// True iff install() has run. Exported so plugins.js can detect "we're
// running under the stasis loader" even before the lazy initState fires --
// a bundler plugin constructed during webpack's config-parse can run
// AHEAD of the first user-file load hook, leaving State.preload null.
// resolvePluginState reads this to force-init State from cwd in that
// window so the plugin inherits the loader's config rather than erroring
// on the default lock mode.
export function isLoaderInstalled() {
  return installed
}

// Force-initialize state from process.cwd() if it hasn't been initialized
// yet. Used by plugins.js's resolvePluginState to ensure State.preload is
// available when the plugin constructor runs ahead of the load hook. A
// subsequent first-load through the load hook detects "state already set"
// and skips its own lazy initState, but still marks isEntry correctly via
// the entryUnseen flag.
export function ensureStateForLoader() {
  if (state) return
  initState(process.cwd())
}

// Register Node's module hooks. Kept separate from the --import entry points
// (loader.js here; the @exodus/stasis package's loader and --mock loader) so a
// host can evaluate this lib -- snapshotting node:fs/path/etc. for stasis's own
// use -- and compose extra setup (e.g. the tooling package's --mock side-effect
// denials) via static import order BEFORE the hooks are registered, with no
// env-var coordination. Idempotent.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // NB: the `--fs` reader patches are NOT installed here. Their mode can come from
  // stasis.config.json, which isn't read until State is constructed, so installation is
  // deferred to initState() (see installFsHooksFromConfig) -- which still runs before any
  // user code. install() only registers the module hooks the fs patch composes on top of.
}

// registerHooks intercepts the ESM loader and Node's native CommonJS loader, but
// NOT the require() the ESM->CJS translator (node:internal/modules/esm/translators)
// builds when it evaluates a CJS module: that require resolves through
// Module._resolveFilename against disk before any hook runs. So a CJS module we
// serve from the bundle (`import chalk from 'chalk'`, chalk being CommonJS) has
// its nested require()s resolved on disk -- and once node_modules is pruned or
// shipped-without, `require('escape-string-regexp')` throws MODULE_NOT_FOUND
// before our hooks can serve it, i.e. the bundle isn't self-contained for a CJS
// dependency graph. Shim _resolveFilename in load mode to resolve such a target
// from the bundle's recorded import map and return its (possibly non-existent on
// disk) path; the load() hook then serves the bytes. For an edge the bundle
// doesn't record, or outside load mode, fall back to Node's native resolution.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        // Same scope gate the resolve hook applies (see above): node_modules scope
        // only serves dependency parents from the bundle; workspace/app code is left
        // to Node's native resolution (read from disk). Without this the shim would
        // silently take over CJS resolution for app files too.
        if (state.config.full || state.inNodeModules(parentURL)) {
          const resolved = state.resolveBundled(parentURL, request)
          if (resolved !== undefined) return resolved
        }
      } else if (isAbsolute(request)) {
        // NO parent, request already an absolute path: Node's ESM<->CJS interop re-enters
        // the monkey-patchable CJS loader with the RESOLVED filename, no parent module, and
        // the registerHooks hooks SKIPPED -- translators.js evaluates an import-linked CJS
        // module via wrapModuleLoad(filename, undefined|null, isMain, kShouldSkipModuleHooks)
        // (the 'commonjs-sync' translator, reached whenever a require() pulls in an ESM graph
        // that imports a CJS dep; also createCJSNoSourceModuleWrap). resolveForCJSWithHooks
        // then bypasses the resolve hook entirely, so this shim is the ONLY interception
        // point. An absolute path can only arrive here from a prior successful resolution
        // (ours, from the bundle -- or Node's own), so when the bundle attests that exact
        // FILE under the same scope gate, the resolution is the identity (returned in
        // path.resolve()d form, matching native's normalized cache-key contract). Falling
        // through to native would stat a file the bundle carries but disk (pruned /
        // never-shipped node_modules) may not -- MODULE_NOT_FOUND on a servable path.
        // hasFsFileContent (byte content, not getFsStat's kind) keeps a --fs-captured
        // directory LISTING -- and a payload-free 'stat:*' record, whose bytes the
        // bundle can NOT serve -- from hijacking native disk resolution. This widens
        // parentless reachability to any attested in-scope file when disk lacks the path;
        // that is bounded by attestation and the load hook's gates (getFile +
        // NODEJS_FORMATS), which remain the load-bearing checks.
        // Node >=24.18 forwards pre-resolved context for hook-resolved modules, masking the
        // common case; on 24.14-24.17 (our supported floor) every commonjs-sync evaluation
        // re-resolves through here, and the no-parent shape survives on >=24.18 too (the
        // deferred-resolution branch and createCJSNoSourceModuleWrap still take it).
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

  // Capture: Module._load's fast path (relativeResolveCache, keyed by the parent
  // DIRECTORY + request) returns an already-loaded module WITHOUT calling
  // _resolveFilename -- so a SECOND sibling importer's require() of a target the first
  // sibling already loaded never reaches the observe shim above, and the edge is
  // recorded only under the first importer (under-recording). _load runs for EVERY
  // require() including cache hits, so force the resolution here to observe the true
  // per-importer edge; _resolveFilename is itself cached, so this is cheap, and a
  // resolution error is left for the original _load to raise (behavior unchanged).
  // We call the PROPERTY `Module._resolveFilename` (our shim above), not a captured
  // reference, so the call routes through observeResolution.
  const originalLoad = Module._load
  Module._load = function (request, parent, ...rest) {
    if (state && !state.config.loadBundle && typeof request === 'string'
        && !isBuiltin(request) && typeof parent?.filename === 'string') {
      try { Module._resolveFilename(request, parent, ...rest) } catch { /* original _load raises the real error */ }
    }
    return originalLoad.call(this, request, parent, ...rest)
  }
}
