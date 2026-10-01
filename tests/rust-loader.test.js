import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCargoContext, evalCfg, parseCargoManifest } from '../stasis/src/loaders/cargo.js'
import {
  buildModuleTrees,
  buildRustTree,
  collectRustFilesFromDisk,
  crateRoots,
  getModuleDir,
  lexRust,
  loadRust,
  parseUseTree,
  resolveExplicitModPath,
  resolveModDecl,
  resolveModPath,
  resolveVendoredCrate,
  scanRustItems,
} from '../stasis/src/loaders/rust.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rust-bundle')

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

const modNames = (content) => scanRustItems(content).mods.map((m) => m.name)
const refSpecs = (content) => scanRustItems(content).refs.map((r) => r.spec)
const edges = (specMap) => Object.fromEntries([...specMap].map(([s, t]) => [s, t instanceof Map ? Object.fromEntries(t) : t]))

// --- lexing ---

test('lexRust blanks nested block comments as one comment', (t) => {
  const src = 'a /* x /* y */ mod ghost; */ b\nmod real;\n'
  const { code } = lexRust(src)
  t.assert.equal(code.length, src.length)
  t.assert.equal(code.replaceAll(/ +/gu, ' '), 'a b\nmod real;\n')
})

test('lexRust keeps `//` inside a string and ignores `/*` inside a line comment', (t) => {
  const src = 'const U: &str = "https://x.y"; mod a;\n// see handlers/* for more\nmod b;\n/// doc */ tail\nmod c;\n'
  const { code, masked } = lexRust(src)
  t.assert.match(code, /"https:\/\/x\.y"; mod a;/u)
  t.assert.match(masked, /"           "; mod a;/u)
  t.assert.match(code, /\nmod b;\n/u)
  t.assert.match(code, /\nmod c;\n/u)
  t.assert.doesNotMatch(code, /handlers|doc/u)
})

test('lexRust handles raw strings, byte strings, char literals and lifetimes', (t) => {
  const src = "let r = r#\"a // b \"# ; let b = b\"x\"; let q = '\"'; let n = '\\n'; fn f<'a>(x: &'a str) {} mod z;"
  const { code, masked } = lexRust(src)
  t.assert.equal(code, src) // no comments: the code view is untouched
  t.assert.match(masked, /r#"       "#/u) // raw string contents blanked, delimiters kept
  t.assert.match(masked, /b" "/u)
  t.assert.match(masked, /' '; let n = '  '/u) // char literals blanked (a `"` inside one opens no string)
  t.assert.match(masked, /<'a>\(x: &'a str\)/u) // lifetimes untouched
  t.assert.match(masked, /mod z;$/u)
})

test('lexRust keeps UTF-16 offsets aligned across astral chars in strings and comments', (t) => {
  // An emoji is two UTF-16 units: blanking it as one space would shift every later offset.
  const src = 'const S: &str = "😀 smile"; // 🎉\nuse serde::Serialize;\n#[path = "x.rs"]\nmod m;\n'
  const { code, masked } = lexRust(src)
  t.assert.equal(code.length, src.length)
  t.assert.equal(masked.length, src.length)
  t.assert.match(masked, /"        "; {6}\nuse serde::Serialize;/u)
  const items = scanRustItems(src)
  t.assert.deepEqual(items.refs.map((r) => r.spec), ['serde::Serialize'])
  t.assert.deepEqual(items.mods[0].paths, [{ path: 'x.rs', cfg: null }])
})

// --- use trees ---

test('parseUseTree flattens brace groups (incl. nested and multi-line) into one path each', (t) => {
  t.assert.deepEqual(parseUseTree(' crate::{a::B, c::D}').map((p) => p.spec), ['crate::a::B', 'crate::c::D'])
  t.assert.deepEqual(parseUseTree('\n  crate::{\n    a::{B, C},\n    d,\n  }').map((p) => p.spec), ['crate::a::B', 'crate::a::C', 'crate::d'])
})

test('parseUseTree handles globs, `self` in a group, `as` renames, leading `::` and raw identifiers', (t) => {
  t.assert.deepEqual(parseUseTree(' a::b::*').map((p) => p.spec), ['a::b'])
  t.assert.deepEqual(parseUseTree(' foo::{self, Bar}').map((p) => p.spec), ['foo', 'foo::Bar'])
  t.assert.deepEqual(parseUseTree(' crate::util::helper as help').map((p) => p.spec), ['crate::util::helper'])
  const abs = parseUseTree(' ::serde::Serialize')
  t.assert.deepEqual(abs.map((p) => [p.spec, p.absolute]), [['::serde::Serialize', true]])
  t.assert.deepEqual(parseUseTree(' crate::r#type::X').map((p) => p.segments), [['crate', 'type', 'X']])
})

// --- item scanning ---

test('scanRustItems finds external mod declarations (incl. pub / pub(crate)) and skips inline ones', (t) => {
  t.assert.deepEqual(modNames('mod foo;\npub mod bar;\npub(crate) mod baz;\nmod inline {\n    pub fn x() {}\n}\nmod real;\n'),
    ['foo', 'bar', 'baz', 'real'])
})

test('scanRustItems records an external mod declared inside inline modules with its inline path, and the directories those stand for', (t) => {
  const { mods } = scanRustItems('mod outer {\n    pub mod inner;\n    mod deep {\n        mod leaf;\n    }\n}\nmod top;\n')
  t.assert.deepEqual(mods.map((m) => [m.name, m.inlinePath, m.inlineDirs]), [['inner', ['outer'], ['outer']], ['leaf', ['outer', 'deep'], ['outer', 'deep']], ['top', [], []]])
  // solana-program: `#[path = ""] mod non_bpf_modules { mod account_keys; }` puts account_keys.rs
  // beside the file; a non-empty path names the directory in the module name's stead.
  const solana = scanRustItems('#[cfg(not(target_os = "solana"))]\n#[path = ""]\nmod non_bpf_modules {\n    mod account_keys;\n    #[path = "thread_files"]\n    mod thread { mod local_data; }\n}\n')
  t.assert.deepEqual(solana.mods.map((m) => [m.name, m.inlinePath, m.inlineDirs]), [
    ['account_keys', ['non_bpf_modules'], ['']],
    ['local_data', ['non_bpf_modules', 'thread'], ['', 'thread_files']],
  ])
})

test('scanRustItems takes `use` for an import only when a use tree follows it', (t) => {
  // syn: `Token![use]` in macro input; serde_derive: `quote! { use #path as _serde; }`, a template
  // for generated code; a macro_rules! template interpolating a metavariable. None imports anything.
  const src = [
    'fn parse(input: ParseStream) -> Result<Self> {',
    '    if input.peek(Token![use]) { let precise_capture_begin = input.parse::<Token![use]>()?; }',
    '    Ok(true)',
    '}',
    'fn wrap(path: &Path) -> TokenStream { quote! { use #path as _serde; #[allow(unused)] use _serde::__private::Ok; } }',
    'macro_rules! m { ($m:ident, $trait:ident) => { use $m::Thing; use $crate::real::Item; use ::libc::c_int; $trait::fmt(self); $crate::util::go(); } }',
    'pub use crate::{r#ref::*, split_at::SplitAt};', // zerocopy: a raw identifier is no interpolation
    'use std::io::{self, Read};',
  ].join('\n')
  const { refs, imports, bindings } = scanRustItems(src)
  t.assert.deepEqual(refs.filter((r) => r.fromUse).map((r) => r.spec), ['crate::real::Item', '::libc::c_int', 'crate::ref', 'crate::split_at::SplitAt', 'std::io', 'std::io::Read'])
  t.assert.deepEqual(refs.filter((r) => !r.fromUse).map((r) => r.spec), ['crate::util::go']) // `$trait::fmt` is a metavariable's
  t.assert.deepEqual(imports.map((im) => im.binding), ['Item', 'c_int', null, 'SplitAt', 'io', 'Read'])
  t.assert.deepEqual([...bindings], ['Item', 'c_int', 'SplitAt', 'io', 'Read'])
})

test('scanRustItems gates the declarations inside a cfg-gated block or inline module on its cfg', (t) => {
  const src = [
    'cfg_if::cfg_if! {',
    '    if #[cfg(unix)] { #[path = "u.rs"] mod imp; } else if #[cfg(windows)] { mod imp; } else { mod imp; }',
    '}',
    '#[cfg(feature = "std")] mod outer { mod a; #[cfg(unix)] mod b; }',
    'cfg_has_atomic! { mod atomic; }',
    'mod plain;',
  ].join('\n')
  // A later `cfg_if!` branch applies only when the earlier ones' cfgs don't hold.
  t.assert.deepEqual(scanRustItems(src).mods.map((m) => [m.name, m.cfg, m.conditional, m.macro]), [
    ['imp', 'unix', true, 'cfg_if'],
    ['imp', 'all(not(unix), windows)', true, 'cfg_if'],
    ['imp', 'all(not(unix), not(windows))', true, 'cfg_if'],
    ['a', 'feature = "std"', true, null],
    ['b', 'all(feature = "std", unix)', true, null],
    ['atomic', null, true, 'cfg_has_atomic'],
    ['plain', null, false, null],
  ])
  // With the feature on, `outer`'s scope is as firm as none; a dead one skips the whole block.
  t.assert.deepEqual(scanRustItems(src, { features: new Set(['std']) }).mods.filter((m) => m.inlinePath.length > 0).map((m) => [m.name, m.cfg, m.conditional]), [['a', 'feature = "std"', false], ['b', 'all(feature = "std", unix)', true]])
  t.assert.deepEqual(scanRustItems(src, { features: new Set() }).mods.map((m) => m.name), ['imp', 'imp', 'imp', 'atomic', 'plain'])
})

test('buildRustTree keeps every file of same-name mods a cfg_if! or cfg macros declare, keyed by branch cfg or macro', (t) => {
  // tokio's atomic_u64: `cfg_has_atomic_u64! { #[path = "native.rs"] mod imp; }` beside
  // `cfg_not_has_atomic_u64! { #[path = "as_mutex.rs"] mod imp; }`, the second file with modules
  // and paths of its own.
  const sources = new Map([
    ['src/lib.rs', 'mod atomic;\nmod sys;\n'],
    ['src/atomic.rs', 'cfg_has_atomic_u64! {\n    #[path = "atomic_native.rs"]\n    mod imp;\n}\ncfg_not_has_atomic_u64! {\n    #[path = "atomic_as_mutex.rs"]\n    mod imp;\n}\npub(crate) use imp::AtomicU64;\n'],
    ['src/atomic_native.rs', 'pub struct AtomicU64;\n'],
    ['src/atomic_as_mutex.rs', 'cfg_has_const_mutex_new! {\n    #[path = "static_const_new.rs"]\n    mod static_macro;\n}\ncfg_not_has_const_mutex_new! {\n    #[path = "static_once_cell.rs"]\n    mod static_macro;\n}\npub(crate) use static_macro::StaticAtomicU64;\npub struct AtomicU64;\n'],
    ['src/static_const_new.rs', 'pub struct StaticAtomicU64;\n'],
    ['src/static_once_cell.rs', 'pub struct StaticAtomicU64;\n'],
    ['src/sys.rs', 'cfg_if::cfg_if! {\n    if #[cfg(unix)] { #[path = "sys/unix.rs"] mod imp; } else { #[path = "sys/other.rs"] mod imp; }\n}\npub use imp::*;\n'],
    ['src/sys/unix.rs', 'pub fn name() {}\n'],
    ['src/sys/other.rs', 'pub fn name() {}\n'],
  ])
  const { resolutions, missing, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([missing, [...unresolvedCrates]], [[], []]) // `static_macro` is a module, not a crate
  // No definition of the gate macros here: which variant a path means is each's, under its gate.
  t.assert.deepEqual(edges(resolutions.get('src/atomic.rs')), {
    'mod imp': { 'cfg_has_atomic_u64!': 'src/atomic_native.rs', 'cfg_not_has_atomic_u64!': 'src/atomic_as_mutex.rs' },
    'imp::AtomicU64': { 'cfg_has_atomic_u64!': 'src/atomic_native.rs', 'cfg_not_has_atomic_u64!': 'src/atomic_as_mutex.rs' },
  })
  // The second variant's own declarations and paths resolve: it is in the module tree.
  t.assert.deepEqual(edges(resolutions.get('src/atomic_as_mutex.rs')), {
    'mod static_macro': { 'cfg_has_const_mutex_new!': 'src/static_const_new.rs', 'cfg_not_has_const_mutex_new!': 'src/static_once_cell.rs' },
    'static_macro::StaticAtomicU64': { 'cfg_has_const_mutex_new!': 'src/static_const_new.rs', 'cfg_not_has_const_mutex_new!': 'src/static_once_cell.rs' },
  })
  // The `else` branch is keyed by what it means: the earlier cfg not holding.
  t.assert.deepEqual(edges(resolutions.get('src/sys.rs')), { 'mod imp': { unix: 'src/sys/unix.rs', 'not(unix)': 'src/sys/other.rs' }, imp: 'src/sys/unix.rs' })
})

test('buildRustTree resolves an include!d file\'s mods beside that file, and anchors its paths in the including module', (t) => {
  // rustc: `mod bar;` in an `include!`d file looks for `bar.rs` beside the included file (its
  // directory, as for a `#[path]`-loaded file: no `<stem>/` step), and `bar` is the includer's
  // child module -- checked against rustc 1.94.
  const sources = new Map([
    ['src/lib.rs', 'mod net;\npub struct Top;\n'],
    ['src/net/mod.rs', 'include!("gen/list.rs");\npub struct Conn;\n'],
    ['src/net/gen/list.rs', 'mod codes;\nuse self::codes::Code;\nuse super::Top;\nfn f() { crate::net::Conn::new(); codes::lookup(); }\n'],
    ['src/net/gen/codes.rs', 'pub struct Code;\npub fn lookup() {}\npub mod sub;\nuse crate::net::codes::Code as C;\n'],
    ['src/net/gen/codes/sub.rs', ''],
    ['src/net/codes.rs', 'pub struct Decoy;\n'],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  t.assert.deepEqual(edges(resolutions.get('src/net/gen/list.rs')), {
    'mod codes': 'src/net/gen/codes.rs', // beside the included file, not src/net/codes.rs nor src/net/gen/list/codes.rs
    'self::codes::Code': 'src/net/gen/codes.rs',
    'super::Top': 'src/lib.rs', // `super` of `crate::net`, the module these tokens are in, is the root
    'crate::net::Conn::new': 'src/net/mod.rs',
    'codes::lookup': 'src/net/gen/codes.rs',
  })
  t.assert.deepEqual(edges(resolutions.get('src/net/gen/codes.rs')), { 'mod sub': 'src/net/gen/codes/sub.rs' }) // `crate::net::codes::Code` is this file: no self edge
})

test('scanRustItems keeps a file whose macro body holds a false inner #![cfg]', (t) => {
  const items = scanRustItems('m!(\n    #![cfg(test)]\n    mod x;\n);\nmod real;\n')
  t.assert.deepEqual(items.mods.map((m) => m.name), ['x', 'real'])
})

test('scanRustItems reads every include argument form, and counts the ones it cannot follow', (t) => {
  const items = scanRustItems([
    'const A: &str = include_str!("with \\"quote\\" and \\\\ back.txt");',
    'const B: &str = include_str!(r#"raw "quoted".txt"#);',
    'const C: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/blob.bin"));',
    'const D: &str = include_str!(concat!("../", "x.txt"));',
    'const E: &str = include_str!(concat!(env!("OUT_DIR"), "/gen.rs"));',
    'macro_rules! doc { () => { include_str!("../README.md") } }',
  ].join('\n'))
  t.assert.deepEqual(items.includes, [
    { kind: 'include_str', path: 'with "quote" and \\ back.txt', base: 'file', conditional: false },
    { kind: 'include_str', path: 'raw "quoted".txt', base: 'file', conditional: false },
    { kind: 'include_bytes', path: 'data/blob.bin', base: 'manifest', conditional: false },
  ])
  t.assert.equal(items.unfollowed, 1) // `concat!("../", "x.txt")`; the OUT_DIR one is build output
  // The include in a macro body is the macro's: resolved relative to whichever file invokes it.
  t.assert.deepEqual(items.macros.map(({ name, exported, includes }) => ({ name, exported, includes })), [{ name: 'doc', exported: false, includes: [{ kind: 'include_str', path: '../README.md', base: 'file' }] }])
})

test('buildRustTree resolves an include in a macro_rules! body relative to each invoking file, and a manifest-relative one from the package root', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\nmod deep;\nconst B: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/blob.bin"));\n'],
    ['src/macros.rs', 'macro_rules! doc_of { () => { include_str!("data.txt") } }\n'],
    ['src/deep/mod.rs', 'pub fn show() -> &\'static str { doc_of!() }\n'],
    ['src/deep/data.txt', 'from deep\n'],
    ['src/data.txt', 'from src\n'],
    ['data/blob.bin', 'x'],
  ])
  const formats = new Map([['src/deep/data.txt', 'resource'], ['src/data.txt', 'resource'], ['data/blob.bin', 'resource']])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'], formats })
  t.assert.deepEqual(edges(resolutions.get('src/deep/mod.rs')), { 'doc_of!': 'src/macros.rs', 'include_str data.txt': 'src/deep/data.txt' })
  t.assert.equal(resolutions.get('src/macros.rs').size, 0) // not relative to the defining file
  // Without a Cargo context the package root is unknown: the manifest-relative include is not placed.
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'mod macros': 'src/macros.rs', 'mod deep': 'src/deep/mod.rs' })
})

test('buildRustTree gives a bare macro call an edge only to a macro in its textual scope', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\nmod other;\nmod user;\n'],
    ['src/macros.rs', 'macro_rules! ready { () => {} }\n'],
    ['src/other.rs', 'macro_rules! vec { () => {} }\n#[macro_export]\nmacro_rules! exported { () => {} }\n'],
    ['src/user.rs', 'fn f() { ready!(); vec![1]; exported!(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  // `vec!` is std's: other.rs's private `macro_rules! vec` is not in scope here. Nor is its
  // exported one by bare name -- rustc: "cannot find macro `exported` in this scope … have you
  // added the `#[macro_use]` on the module?" -- though `crate::exported!` and the root file see it.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'ready!': 'src/macros.rs' })
})

test('buildRustTree finds the modules of an inline module with its own #[path]', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'pub mod message;\n'],
    ['src/message/mod.rs', '#[cfg(not(target_os = "solana"))]\n#[path = ""]\nmod non_bpf_modules {\n    mod account_keys;\n    mod versions;\n    pub use {account_keys::*, versions::*};\n}\n#[cfg(not(target_os = "solana"))]\npub use non_bpf_modules::*;\n'],
    ['src/message/account_keys.rs', 'pub struct AccountKeys;\n'],
    ['src/message/versions/mod.rs', 'pub enum VersionedMessage {}\n'],
    ['src/user.rs', ''],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  t.assert.deepEqual(edges(resolutions.get('src/message/mod.rs')), {
    'mod non_bpf_modules::account_keys': 'src/message/account_keys.rs',
    'mod non_bpf_modules::versions': 'src/message/versions/mod.rs',
    account_keys: 'src/message/account_keys.rs', // `pub use {account_keys::*, …}` inside the inline module
    versions: 'src/message/versions/mod.rs',
    // `pub use non_bpf_modules::*` names the inline module, which lives in this very file: no edge.
  })
})

test('scanRustItems marks #[cfg]-gated modules (and those inside a gated inline module) conditional, with their predicate', (t) => {
  const { mods } = scanRustItems([
    '#[cfg(feature = "x")]', 'mod featured;',
    '#[cfg_attr(feature = "x", allow(unused))]', 'mod not_gated;', // cfg_attr applying a non-cfg attribute gates nothing
    '#[cfg_attr(feature = "x", cfg(feature = "y"))]', 'mod gated_by_cfg_attr;',
    '#[cfg(not(test))]', 'mod always;', // decidable: always built
    '#[cfg(unix)]', '#[cfg(feature = "z")]', 'mod both;',
    'mod real;',
    '#[cfg(unix)]', 'mod sys {', '    mod imp;', '}',
  ].join('\n'))
  t.assert.deepEqual(mods.map((m) => [m.name, m.cfg, m.conditional]), [
    ['featured', 'feature = "x"', true],
    ['not_gated', null, false],
    // `cfg_attr(x, cfg(y))`: gated on y only when x holds -- compiled unless x && !y
    ['gated_by_cfg_attr', 'any(not(feature = "x"), feature = "y")', true],
    ['always', 'not(test)', false],
    ['both', 'all(unix, feature = "z")', true],
    ['real', null, false],
    ['imp', 'unix', true], // gated by the inline module it sits in
  ])
  // With x off the cfg_attr never applies its cfg: the module is unconditional, not skipped.
  const off = scanRustItems('#[cfg_attr(feature = "x", cfg(feature = "y"))]\nmod m;\n', { features: new Set() }).mods
  t.assert.deepEqual(off.map((m) => [m.name, m.conditional]), [['m', false]])
  // With x on and y off it is dead.
  t.assert.deepEqual(scanRustItems('#[cfg_attr(feature = "x", cfg(feature = "y"))]\nmod m;\n', { features: new Set(['x']) }).mods, [])
})

test('scanRustItems skips a dead field, variant, tuple field or match arm without running past its enclosing block', (t) => {
  const src = [
    'pub struct Config {', '    #[cfg(feature = "tls")]', '    tls: bool,', '    pub name: String,', '}', 'pub mod client;',
    'mod imp {', '    pub struct Inner {', '        #[cfg(feature = "tls")]', '        tls: bool', '    }', '    pub mod server;', '}',
    'pub enum Kind { A, #[cfg(feature = "tls")] Secure(u8, u8), C }', 'mod after_enum;',
    'pub struct Tuple(#[cfg(feature = "tls")] u8, pub u16);', 'mod after_tuple;',
    'fn pick(n: u8) -> u8 { match n { #[cfg(feature = "tls")] 1 => { 10 } _ => 0 } }', 'mod after_fn;',
    '#[cfg(feature = "tls")] fn tls_only() { client::connect() }', 'mod last;',
  ].join('\n')
  const { mods } = scanRustItems(src, { features: new Set() })
  t.assert.deepEqual(mods.map((m) => [...m.inlinePath, m.name].join('::')), ['client', 'imp::server', 'after_enum', 'after_tuple', 'after_fn', 'last'])
})

test('scanRustItems compiles a test target with cfg(test): #[test] fns and #[cfg(test)] items are live', (t) => {
  const src = '#[cfg(test)]\nmod helpers;\n#[test]\nfn t() { quickcheck::quickcheck(1); }\n'
  t.assert.deepEqual(scanRustItems(src).mods, [])
  const live = scanRustItems(src, { test: true })
  t.assert.deepEqual(live.mods.map((m) => [m.name, m.conditional]), [['helpers', false]])
  t.assert.deepEqual(live.refs.map((r) => r.spec), ['quickcheck::quickcheck'])
})

test('evalCfg decides test/doc-only predicates and leaves target/feature ones unknown', (t) => {
  t.assert.equal(evalCfg('test'), false)
  t.assert.equal(evalCfg('doctest'), false)
  t.assert.equal(evalCfg('doc'), false)
  t.assert.equal(evalCfg('not(test)'), true)
  t.assert.equal(evalCfg('all(test, feature = "x")'), false)
  t.assert.equal(evalCfg('any(test, doc)'), false)
  t.assert.equal(evalCfg('any(test, feature = "x")'), null)
  t.assert.equal(evalCfg('all(unix, not(test))'), null)
  t.assert.equal(evalCfg('not(any(test, feature = "x"))'), null)
  t.assert.equal(evalCfg('unix'), null)
  t.assert.equal(evalCfg('all()'), true)
  t.assert.equal(evalCfg('any()'), false)
  // the boolean literals (rustc 1.88), and a raw identifier as the name it spells
  t.assert.equal(evalCfg('true'), true)
  t.assert.equal(evalCfg('not(false)'), true)
  t.assert.equal(evalCfg('all(unix, false)'), false)
  t.assert.equal(evalCfg('r#test'), false)
  t.assert.equal(evalCfg('r#unix', { target: new Set(['unix']) }), true)
  t.assert.equal(evalCfg('r#true'), null) // a cfg named `true`, not the literal
})

test('evalCfg decides a predicate an unknown leaf repeats in when it holds, or fails, whatever that leaf is', (t) => {
  // zerocopy: `#[cfg(any(test, kani))] mod tests { #[cfg(not(kani))] mod compatibility { use rand::…; } }`
  t.assert.equal(evalCfg('all(any(test, kani), not(kani))'), false)
  t.assert.equal(evalCfg('any(unix, not(unix))'), true)
  t.assert.equal(evalCfg('all(target_os = "linux", not(target_os="linux"))'), false)
  t.assert.equal(evalCfg('any(all(a, b), all(a, not(b)))'), null) // `a`: not decided
  t.assert.equal(evalCfg('all(unix, windows)'), null) // two leaves, each once: left to the ranking (cfgExclusive)
  t.assert.equal(evalCfg('all(feature = "x", not(feature = "x"), kani)', { features: null }), false)
  const { refs } = scanRustItems('#[cfg(any(test, kani))]\nmod tests {\n    #[cfg(not(kani))]\n    mod compatibility {\n        pub(super) use rand::Rng;\n    }\n    use proptest::prelude::*;\n}\n')
  t.assert.deepEqual(refs.map((r) => r.spec), ['proptest::prelude']) // under kani, which may be set
})

test('evalCfg decides target predicates against a target cfg set, profile and custom ones never', (t) => {
  const target = new Set(['unix', 'target_os="linux"', 'target_family="unix"', 'target_arch="x86_64"', 'target_pointer_width="64"', 'target_feature="sse2"', 'target_has_atomic="64"', 'debug_assertions', 'panic="unwind"'])
  t.assert.equal(evalCfg('unix', { target }), true)
  t.assert.equal(evalCfg('windows', { target }), false)
  t.assert.equal(evalCfg('target_os = "linux"', { target }), true)
  t.assert.equal(evalCfg('target_os="macos"', { target }), false)
  t.assert.equal(evalCfg('all(unix, target_pointer_width = "64")', { target }), true)
  t.assert.equal(evalCfg('any(windows, target_arch = "aarch64")', { target }), false)
  t.assert.equal(evalCfg('not(target_os = "windows")', { target }), true)
  t.assert.equal(evalCfg('all(unix, feature = "std")', { target }), null) // the feature is undecided without a feature set
  t.assert.equal(evalCfg('all(unix, feature = "std")', { target, features: new Set() }), false)
  // Target features are the build's to add (`-C target-cpu=native`) or take away (`-C
  // target-feature=-crt-static`): undecided either way, as is `target_thread_local`, which a
  // stable rustc never prints.
  t.assert.equal(evalCfg('target_feature = "sse2"', { target }), null)
  t.assert.equal(evalCfg('target_feature = "avx2"', { target }), null)
  t.assert.equal(evalCfg('not(target_feature = "avx2")', { target }), null)
  t.assert.equal(evalCfg('target_thread_local', { target }), null)
  // Profile cfgs are printed by rustc but set by the build; custom cfgs are anyone's.
  t.assert.equal(evalCfg('debug_assertions', { target }), null)
  t.assert.equal(evalCfg('panic = "unwind"', { target }), null)
  t.assert.equal(evalCfg('loom', { target }), null)
  t.assert.equal(evalCfg('target_os = "linux"'), null) // no target: undecided, as before
})

test('scanRustItems drops target-gated items and cfg_attr path variants for another target', (t) => {
  const src = [
    '#[cfg(windows)]', 'mod win;',
    '#[cfg(unix)]', 'mod nix;',
    '#[cfg_attr(unix, path = "sys/unix.rs")]', '#[cfg_attr(windows, path = "sys/windows.rs")]', 'mod sys;',
    '#[cfg(target_os = "linux")] use libc::epoll_create1;',
    '#[cfg(target_os = "macos")] use libc::kqueue;',
    'mod plain;',
  ].join('\n')
  const linux = new Set(['unix', 'target_os="linux"', 'target_family="unix"'])
  const items = scanRustItems(src, { target: linux })
  t.assert.deepEqual(items.mods.map((m) => [m.name, m.conditional, m.paths]), [
    ['nix', false, []], // decidably on: as firm as no cfg
    ['sys', false, [{ path: 'sys/unix.rs', cfg: null }]], // the variant that holds is the `#[path]`
    ['plain', false, []],
  ])
  t.assert.deepEqual(items.refs.map((r) => r.spec), ['libc::epoll_create1'])
  // Without a target both variants and both modules stay, undecided.
  t.assert.deepEqual(scanRustItems(src).mods.map((m) => [m.name, m.conditional]), [['win', true], ['nix', true], ['sys', false], ['plain', false]])
})

test('scanRustItems skips a dead item that starts with no word: a block, a pattern arm, a tuple type, a `*` statement', (t) => {
  const src = [
    'fn f(x: &str) -> String {',
    '    #[cfg(feature = "std")]',
    '    { std_only::init(); }',
    '    #[cfg(feature = "std")]',
    '    *counter::GLOBAL.lock() += 1;',
    '    match x {',
    '        #[cfg(feature = "json")]',
    '        "json" => serde_json::to_string(x).unwrap(),',
    '        #[cfg(feature = "yaml")]',
    '        &"yaml" => serde_yaml::to_string(x).unwrap(),',
    '        #[cfg(feature = "pair")]',
    '        (a, b) => pair::join(a, b),',
    '        #[cfg(feature = "slice")]',
    '        [first, ..] => slice::first(first),',
    '        #[cfg(feature = "num")]',
    '        1 => num::one(),',
    '        _ => live::fallback(x),',
    '    }',
    '}',
    'struct Tuple(#[cfg(feature = "pair")] (A, pair::B), live::C);',
    'mod after;',
  ].join('\n')
  const { mods, refs } = scanRustItems(src, { features: new Set() })
  t.assert.deepEqual(mods.map((m) => m.name), ['after'])
  t.assert.deepEqual(refs.map((r) => r.spec).toSorted(), ['live::C', 'live::fallback'])
})

test('scanRustItems skips a dead item whole whatever commas its generics or where clause hold, and a dead field through its generic type', (t) => {
  const src = [
    '#[cfg(feature = "serde")]',
    "fn deser<'de, D>(d: D) -> Result<UniformInt<u32>, D::Error>",
    'where',
    "    D: serde::Deserializer<'de>,",
    '{',
    '    let s = <UniformInt<u32> as serde::Deserialize>::deserialize(d)?;',
    '}',
    '#[cfg(feature = "serde")]',
    "impl<'de, A: Array> Deserialize<'de> for SmallVec<A> { fn f() { use serde::de::Error; } }",
    '#[cfg(all(tokio_unstable, feature = "tracing"))]',
    "pub struct Builder<'a, T> { builder: super::Builder<'a>, x: T }",
    'pub struct Live {',
    '    map: HashMap<K, V>,',
    '    #[cfg(feature = "serde")] extra: Option<Box<dyn serde::Serialize>>,',
    '    next: u8,',
    '}',
    'mod after;',
    'fn live() -> Result<(), E> { crate::real::go(); }',
  ].join('\n')
  const { mods, refs } = scanRustItems(src, { features: new Set() })
  t.assert.deepEqual(mods.map((m) => m.name), ['after'])
  t.assert.deepEqual(refs.map((r) => r.spec), ['crate::real::go'])
})

test('scanRustItems blanks the attributes of a dead item and a cfg_attr whose predicate never holds', (t) => {
  const src = [
    '#[cfg(feature = "serde")]',
    '#[derive(serde::Serialize, serde::Deserialize)]',
    'pub struct Gated;',
    '#[cfg_attr(feature = "serde", derive(serde::Serialize))]',
    '#[derive(Clone)]',
    'pub struct Live;',
    '#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]',
    'pub struct Fuzzed;',
  ].join('\n')
  const off = scanRustItems(src, { features: new Set(['arbitrary']) })
  // Only the `cfg_attr` whose feature is on names anything live.
  t.assert.deepEqual(off.refs.map((r) => r.spec), ['arbitrary::Arbitrary'])
  // Undecided features keep the attribute's paths (the crate may well be compiled with them).
  t.assert.deepEqual(scanRustItems(src).refs.map((r) => r.spec).toSorted(), ['arbitrary::Arbitrary', 'serde::Deserialize', 'serde::Serialize'])
})

test('scanRustItems records use imports with their visibility, macro_rules! definitions and inline modules', (t) => {
  const items = scanRustItems([
    'pub mod __private {',
    '    pub use serde_core as serde;',
    '    use secret::Thing;',
    '    pub(super) use crate::x::Y;',
    '    pub(in crate::__private) use crate::x::Z;',
    '}',
    'pub use external::*;',
    'pub(crate) use crate::a::{B, c as d};',
    'pub(self) extern crate serde_core as s;',
    'extern crate self as me;',
    '#[macro_export]',
    '#[doc(hidden)]',
    'macro_rules! exported { () => {} }',
    '#[macro_export(local_inner_macros)]',
    'macro_rules! exported_too { () => {} }',
    '#[cfg_attr(feature = "std", macro_export)]',
    'macro_rules! exported_when { () => {} }',
    '#[cfg_attr(feature = "std", macro_export)]',
    '#[cfg(not(feature = "std"))]',
    'macro_rules! never { () => {} }',
    'macro_rules! local { () => {} }',
  ].join('\n'), { features: new Set(['std']) })
  t.assert.deepEqual(items.imports.map((r) => [r.inlinePath.join('::'), r.segments.join('::'), r.absolute, r.binding, r.glob, r.vis]), [
    ['__private', 'serde_core', false, 'serde', false, 'crate'],
    ['__private', 'secret::Thing', false, 'Thing', false, null],
    ['__private', 'crate::x::Y', false, 'Y', false, 'super'],
    ['__private', 'crate::x::Z', false, 'Z', false, 'in crate::__private'],
    ['', 'external', false, null, true, 'crate'],
    ['', 'crate::a::B', false, 'B', false, 'crate'],
    ['', 'crate::a::c', false, 'd', false, 'crate'],
    ['', 'serde_core', true, 's', false, 'self'], // `extern crate x as y` is `use ::x as y`
    ['', 'crate', false, 'me', false, null], // `extern crate self as me` is `use crate as me`
  ])
  t.assert.deepEqual(items.macros.map(({ name, exported, includes }) => ({ name, exported, includes })), [
    { name: 'exported', exported: true, includes: [] },
    { name: 'exported_too', exported: true, includes: [] },
    { name: 'exported_when', exported: true, includes: [] },
    { name: 'local', exported: false, includes: [] },
  ])
  t.assert.ok(items.macros.every((m) => Number.isInteger(m.offset)) && items.macros[0].offset < items.macros[1].offset)
  t.assert.deepEqual(items.inlineModules, [['__private']])
})

test('scanRustItems marks an invoked path as a macro call', (t) => {
  const { refs } = scanRustItems('fn f() { $crate::span!(1); crate::span::Span::new(); if crate::flag::x != 1 { crate::m! { } } }\n')
  t.assert.deepEqual(refs.map((r) => [r.spec, r.macroCall]), [['crate::span', true], ['crate::span::Span::new', false], ['crate::flag::x', false], ['crate::m', true]])
})

test('scanRustItems records include macros with a literal path and bare macro invocations, and honours an inner #![cfg]', (t) => {
  const items = scanRustItems([
    'include!("generated/consts.rs");',
    'const T: &str = include_str!("../data/table.txt");',
    'const B: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/blob.bin"));',
    'fn f() { ready!(x); println!("{}", a != b); }',
    'mod dead { #![cfg(feature = "never")] mod ghost; use phantom::X; }',
    'mod live;',
  ].join('\n'), { features: new Set() })
  t.assert.deepEqual(items.includes, [
    { kind: 'include', path: 'generated/consts.rs', base: 'file', conditional: false },
    { kind: 'include_str', path: '../data/table.txt', base: 'file', conditional: false }, // the build-output one is no literal
  ])
  t.assert.equal(items.unfollowed, 0) // `OUT_DIR` is build output: nothing to warn about
  // Inside attributes: the module's own `#![doc = …]`, a live item's `#[doc = …]`, not a dead item's.
  const attrs = scanRustItems([
    '#![doc = include_str!("../README.md")]',
    '#[doc = include_str!("docs/live.md")]',
    'pub fn live() {}',
    '#[cfg(feature = "never")]',
    '#[doc = include_str!("docs/dead.md")]',
    'pub fn dead() {}',
  ].join('\n'), { features: new Set() })
  t.assert.deepEqual(attrs.includes.map((inc) => inc.path), ['../README.md', 'docs/live.md'])
  t.assert.deepEqual([...items.invocations].toSorted(), ['concat', 'env', 'include', 'include_bytes', 'include_str', 'println', 'ready']) // `a != b` is no invocation
  t.assert.deepEqual(items.mods.map((m) => m.name), ['live']) // the inline module's inner cfg can't hold: emptied
  t.assert.deepEqual(items.refs.map((r) => r.spec), [])
  // At the top of a file such an inner cfg empties the whole file.
  const gated = scanRustItems('#![cfg(feature = "never")]\nmod ghost;\nuse phantom::X;\n', { features: new Set() })
  t.assert.deepEqual([gated.mods, gated.refs], [[], []])
  t.assert.deepEqual(scanRustItems('#![cfg(feature = "never")]\nmod ghost;\n').mods.map((m) => m.name), ['ghost']) // undecided: kept
})

test('scanRustItems skips test/doc-only items whole: their mods, uses and paths are never recorded', (t) => {
  const { mods, refs, externCrates } = scanRustItems([
    '#[cfg(test)]', 'mod tests;',
    '#[cfg(test)]', 'mod prop {', '    use proptest::prelude::*;', '    mod strategies;', '    #[test] fn t() { crate::real::go(); }', '}',
    '#[test]', 'fn smoke() { quickcheck::quickcheck(real::go as fn()); }',
    '#[cfg(doc)]', 'pub mod doc_only;',
    '#[cfg(test)] extern crate serde_test;',
    '#[cfg(test)] use std::collections::HashMap;',
    '#[cfg(all(test, unix))]', 'const X: u8 = 1;',
    'mod real;',
    'fn keep() { real::go(); }',
  ].join('\n'))
  t.assert.deepEqual(mods.map((m) => m.name), ['real'])
  t.assert.deepEqual(refs.map((r) => r.spec), ['real::go'])
  t.assert.deepEqual(externCrates, [])
})

test('scanRustItems reports the names a file\'s use items and extern-crate aliases bind, not a crate imported under its own name', (t) => {
  const { bindings } = scanRustItems('use std::io;\nuse crate::{config::Config, util::helper as help};\nuse foo::*;\nuse bar::_x as _;\nextern crate alpha as a;\nuse serde_json;\nuse rand::{self, Rng};\nuse tokio as tk;\n')
  // `serde_json` and `rand` name the crates themselves; `tk` is an alias for one (so `tk::…` is not a crate lookup)
  t.assert.deepEqual([...bindings].toSorted(), ['Config', 'Rng', 'a', 'help', 'io', 'tk'])
})

test('scanRustItems matches a mod with its attribute on the same line', (t) => {
  const { mods } = scanRustItems('#[macro_use] mod macros;\n#[cfg(unix)] mod unix;\n#[doc(hidden)] pub mod hidden;\n')
  t.assert.deepEqual(mods.map((m) => [m.name, m.conditional]), [['macros', false], ['unix', true], ['hidden', false]])
})

test('scanRustItems marks a mod inside a macro invocation body conditional (cfg_if!, generate_guide!, macro_rules!)', (t) => {
  const { mods } = scanRustItems([
    'cfg_if::cfg_if! {', '    if #[cfg(unix)] {', '        mod imp_unix;', '    } else {', '        mod imp_other;', '    }', '}',
    'generate_guide! {', '    pub mod guide {', '        @code pub mod feature_flags;', '        pub mod serde_as;', '    }', '}',
    'macro_rules! templated { () => { mod from_template; }; }',
    'let x = !flag; if !(a || b) { mod not_a_macro; }',
    'mod real;',
  ].join('\n'))
  t.assert.deepEqual(mods.map((m) => [m.name, m.inlinePath, m.conditional]), [
    ['imp_unix', [], true],
    ['imp_other', [], true],
    ['feature_flags', ['guide'], true], // the macro's `pub mod guide {` still nests like an inline module
    ['serde_as', ['guide'], true],
    ['from_template', [], true],
    ['not_a_macro', [], false], // a unary `!` is not a macro invocation
    ['real', [], false],
  ])
})

test('scanRustItems extracts #[path] and #[cfg_attr(…, path)] targets', (t) => {
  const { mods } = scanRustItems([
    '#[doc(hidden)]', '#[path = "private/mod.rs"]', 'pub mod __private;',
    '#[cfg_attr(unix, path = "sys/unix.rs")]', '#[cfg_attr(all(windows, not(target_env = "msvc")), path = "sys/win.rs")]', 'mod sys;',
  ].join('\n'))
  t.assert.deepEqual(mods[0].paths, [{ path: 'private/mod.rs', cfg: null }])
  t.assert.equal(mods[0].conditional, false)
  t.assert.deepEqual(mods[1].paths, [
    { path: 'sys/unix.rs', cfg: 'unix' },
    { path: 'sys/win.rs', cfg: 'all(windows, not(target_env = "msvc"))' },
  ])
  t.assert.equal(mods[1].conditional, false) // the module itself is unconditional; only its file varies
})

test('scanRustItems ignores commented-out declarations and `mod` inside strings', (t) => {
  const src = '/*\nmod blockgone;\n*/\n// mod linegone;\n// use crate::gone::X;\nconst S: &str = "mod strgone;";\nmod real;\nuse crate::foo::Y;\n'
  t.assert.deepEqual(modNames(src), ['real'])
  t.assert.deepEqual(refSpecs(src), ['crate::foo::Y'])
})

test('scanRustItems collects use paths (flattened), expression paths, and their inline module', (t) => {
  const { refs } = scanRustItems('use crate::{a::B, c::D};\nfn f() { let _ = crate::e::run(); super::g(); }\nmod tests {\n    use super::*;\n}\n')
  t.assert.deepEqual(refs.map((r) => [r.spec, r.inlinePath, r.fromUse]), [
    ['crate::a::B', [], true],
    ['crate::c::D', [], true],
    ['super', ['tests'], true],
    ['crate::e::run', [], false],
    ['super::g', [], false],
  ])
})

test('scanRustItems does not re-scan a use item as expression paths', (t) => {
  // `parse::Parse` inside the group is syn's module, not a local one; only the tree parser sees it.
  t.assert.deepEqual(refSpecs('use syn::{parse::Parse, Ident};\n'), ['syn::parse::Parse', 'syn::Ident'])
})

test('scanRustItems finds `extern crate`, with an `as` alias', (t) => {
  const { externCrates } = scanRustItems('extern crate alpha as a;\npub extern crate beta;\nextern "C" { fn c(); }\n')
  t.assert.deepEqual(externCrates.map((e) => e.name), ['alpha', 'beta'])
})

// --- module files ---

test('getModuleDir places submodules of crate roots / mod.rs as siblings', (t) => {
  t.assert.equal(getModuleDir('src/main.rs'), 'src')
  t.assert.equal(getModuleDir('src/lib.rs'), 'src')
  t.assert.equal(getModuleDir('src/foo/mod.rs'), 'src/foo')
  t.assert.equal(getModuleDir('main.rs'), '')
})

test('getModuleDir places submodules of other files under a stem subdir, unless the file is a root by role', (t) => {
  t.assert.equal(getModuleDir('src/foo.rs'), 'src/foo')
  t.assert.equal(getModuleDir('src/a/b.rs'), 'src/a/b')
  t.assert.equal(getModuleDir('src/bin/tool.rs', { root: true }), 'src/bin')
  t.assert.equal(getModuleDir('tests/it.rs', { root: true }), 'tests')
})

test('resolveModPath resolves to <dir>/<name>.rs then <dir>/<name>/mod.rs (knownSources)', (t) => {
  const known = new Map([['src/foo.rs', ''], ['src/bar/mod.rs', '']])
  t.assert.equal(resolveModPath('foo', 'src/main.rs', { knownSources: known }), 'src/foo.rs')
  t.assert.equal(resolveModPath('bar', 'src/main.rs', { knownSources: known }), 'src/bar/mod.rs')
  t.assert.equal(resolveModPath('absent', 'src/main.rs', { knownSources: known }), null)
})

test('resolveModPath resolves against the filesystem in walk mode', (t) => {
  const baseDir = join(fixtures, 'mod-rs')
  // src/foo.rs does not exist, but src/foo/mod.rs does.
  t.assert.equal(resolveModPath('foo', 'src/main.rs', { baseDir }), 'src/foo/mod.rs')
  t.assert.equal(resolveModPath('nope', 'src/main.rs', { baseDir }), null)
})

test('resolveModPath treats a root-by-role entry as a crate root (siblings), with the stem rule as fallback', (t) => {
  const known = new Map([['src/bin/helper.rs', ''], ['src/other/util.rs', '']])
  const roots = new Set(['src/bin/tool.rs', 'src/other.rs'])
  t.assert.equal(resolveModPath('helper', 'src/bin/tool.rs', { knownSources: known, roots }), 'src/bin/helper.rs')
  t.assert.equal(resolveModPath('helper', 'src/bin/tool.rs', { knownSources: known }), null) // not a root: src/bin/tool/helper.rs
  t.assert.equal(resolveModPath('util', 'src/other.rs', { knownSources: known, roots }), 'src/other/util.rs')
})

test('resolveModPath places a mod declared inside inline modules under their directories', (t) => {
  const known = new Map([['src/outer/inner.rs', ''], ['src/a/outer/deep/leaf.rs', '']])
  t.assert.equal(resolveModPath('inner', 'src/main.rs', { knownSources: known, inlinePath: ['outer'] }), 'src/outer/inner.rs')
  t.assert.equal(resolveModPath('leaf', 'src/a.rs', { knownSources: known, inlinePath: ['outer', 'deep'] }), 'src/a/outer/deep/leaf.rs')
})

test('resolveExplicitModPath follows rustc: relative to the file dir, or to the module dir + inline path', (t) => {
  const known = new Map([['src/discouraged.rs', ''], ['src/de/seed.rs', ''], ['src/raw/mod.rs', ''], ['src/a/b/x/other.rs', '']])
  // syn: `#[path = "discouraged.rs"]` in src/parse.rs names the sibling, not src/parse/discouraged.rs
  t.assert.equal(resolveExplicitModPath('discouraged.rs', 'src/parse.rs', { knownSources: known }), 'src/discouraged.rs')
  t.assert.equal(resolveExplicitModPath('de/seed.rs', 'src/lib.rs', { knownSources: known }), 'src/de/seed.rs')
  // hashbrown: `pub mod raw { #[path = "mod.rs"] mod inner; }` in src/lib.rs -> src/raw/mod.rs
  t.assert.equal(resolveExplicitModPath('mod.rs', 'src/lib.rs', { knownSources: known, inlinePath: ['raw'] }), 'src/raw/mod.rs')
  // non-mod-rs file: the stem dir comes first
  t.assert.equal(resolveExplicitModPath('other.rs', 'src/a/b.rs', { knownSources: known, inlinePath: ['x'] }), 'src/a/b/x/other.rs')
})

test('resolveExplicitModPath refuses absolute and root-escaping paths', (t) => {
  const known = new Map([['outside.rs', ''], ['src/x.rs', '']])
  t.assert.equal(resolveExplicitModPath('/etc/passwd', 'src/main.rs', { knownSources: known }), null)
  t.assert.equal(resolveExplicitModPath('../../outside.rs', 'src/main.rs', { knownSources: known }), null)
  t.assert.equal(resolveExplicitModPath('../outside.rs', 'src/main.rs', { knownSources: known }), 'outside.rs') // stays inside the root
  t.assert.equal(resolveExplicitModPath('./x.rs', 'src/main.rs', { knownSources: known }), 'src/x.rs')
})

test('resolveModDecl lists cfg_attr variants under their predicate plus the default file as fallback', (t) => {
  const known = new Map([['src/sys/unix.rs', ''], ['src/sys/windows.rs', ''], ['src/sys/mock.rs', ''], ['src/sys.rs', '']])
  const decl = { name: 'sys', inlinePath: [], conditional: false, paths: [{ path: 'sys/unix.rs', cfg: 'unix' }, { path: 'sys/windows.rs', cfg: 'windows' }, { path: 'sys/nope.rs', cfg: 'wasi' }] }
  t.assert.deepEqual(resolveModDecl(decl, 'src/lib.rs', { knownSources: known }), [
    { cfg: 'unix', file: 'src/sys/unix.rs', explicit: true },
    { cfg: 'windows', file: 'src/sys/windows.rs', explicit: true },
    { cfg: null, file: 'src/sys.rs', explicit: false },
  ])
  // A variant whose predicate can't hold is the scanner's to drop, for the build it scans under.
  const src = '#[cfg_attr(unix, path = "sys/unix.rs")]\n#[cfg_attr(test, path = "sys/mock.rs")]\nmod sys;\n'
  t.assert.deepEqual(scanRustItems(src).mods[0].paths, [{ path: 'sys/unix.rs', cfg: 'unix' }])
  // rustc applies the first variant whose predicate holds. One that holds in the scanned build ends
  // the list and rules out the default lookup; it is the `#[path]` outright only when nothing
  // undecided precedes it.
  const inTest = scanRustItems(src, { test: true }).mods[0]
  t.assert.deepEqual([inTest.paths, inTest.noDefault], [[{ path: 'sys/unix.rs', cfg: 'unix' }, { path: 'sys/mock.rs', cfg: 'test' }], true])
  t.assert.deepEqual(resolveModDecl(inTest, 'src/lib.rs', { knownSources: known }).map((x) => x.file), ['src/sys/unix.rs', 'src/sys/mock.rs'])
  const mockFirst = scanRustItems('#[cfg_attr(test, path = "sys/mock.rs")]\n#[cfg_attr(unix, path = "sys/unix.rs")]\nmod sys;\n', { test: true }).mods[0]
  t.assert.deepEqual([mockFirst.paths, mockFirst.noDefault], [[{ path: 'sys/mock.rs', cfg: null }], true])
  t.assert.equal(scanRustItems(src).mods[0].noDefault, false)
  // an unconditional #[path] is authoritative: no default lookup
  const explicit = { name: 'seed', inlinePath: [], conditional: false, paths: [{ path: 'sys/unix.rs', cfg: null }] }
  t.assert.deepEqual(resolveModDecl(explicit, 'src/lib.rs', { knownSources: known }), [{ cfg: null, file: 'src/sys/unix.rs', explicit: true }])
})

test('resolveModPath treats a #[path]-loaded file like mod.rs: its submodules sit beside it', (t) => {
  const known = new Map([['src/de/extra.rs', ''], ['src/de/seed/extra.rs', '']])
  const pathLoaded = new Set(['src/de/seed.rs'])
  t.assert.equal(resolveModPath('extra', 'src/de/seed.rs', { knownSources: known, pathLoaded }), 'src/de/extra.rs')
  t.assert.equal(resolveModPath('extra', 'src/de/seed.rs', { knownSources: known }), 'src/de/seed/extra.rs') // a plain module file
})

// --- Cargo manifests ---

test('parseCargoManifest reads package, lib, dependencies in every shape, and workspace tables', (t) => {
  const m = parseCargoManifest([
    '[package]', 'name = "my-app" # the crate', 'version.workspace = true', 'edition = "2021"',
    '[lib]', 'name = "myapp_lib"', 'path = "src/the_lib.rs"',
    '[dependencies]', 'serde = "1"', 'util = { path = "../util", features = ["x"] }', 'tools = { package = "dev-tools", path = "../tools" }', 'shared = { workspace = true }',
    '[dependencies.inline-sub]', 'path = "../sub"',
    "[target.'cfg(unix)'.dependencies]", 'nix = { path = "../nix" }',
    '[dev-dependencies]', 'tempfile = "3"',
    '[workspace]', 'members = ["crates/*"]',
    '[workspace.package]', 'version = "0.9.0"',
    '[workspace.dependencies]', 'shared = { path = "crates/shared" }',
  ].join('\n'))
  t.assert.deepEqual(m.package, { name: 'my-app', version: '0.9.0', edition: '2021', build: null }) // the version its own [workspace] gives
  t.assert.deepEqual(m.lib, { name: 'myapp_lib', path: 'src/the_lib.rs', procMacro: false })
  const dep = (k) => {
    const d = m.deps.get(k)
    const [r] = d.kinds.values() // one table each here: a dependency's identity is its table's
    return { path: r.path, package: r.package, renamed: r.renamed, inherited: r.inherited, kinds: [...d.kinds.keys()].toSorted() }
  }
  t.assert.deepEqual([...m.deps.keys()].toSorted(), ['inline_sub', 'nix', 'serde', 'shared', 'tempfile', 'tools', 'util'])
  t.assert.deepEqual(dep('inline_sub'), { path: '../sub', package: 'inline-sub', renamed: false, inherited: false, kinds: ['normal'] })
  t.assert.deepEqual(dep('nix'), { path: '../nix', package: 'nix', renamed: false, inherited: false, kinds: ['normal@cfg(unix)'] }) // a target table: its own request
  t.assert.deepEqual(dep('serde'), { path: null, package: 'serde', renamed: false, inherited: false, kinds: ['normal'] })
  t.assert.deepEqual(dep('shared'), { path: 'crates/shared', package: 'shared', renamed: false, inherited: true, kinds: ['normal'] }) // relative to the workspace root
  t.assert.deepEqual(dep('tempfile'), { path: null, package: 'tempfile', renamed: false, inherited: false, kinds: ['dev'] })
  t.assert.deepEqual(dep('tools'), { path: '../tools', package: 'dev-tools', renamed: true, inherited: false, kinds: ['normal'] })
  t.assert.equal(m.isWorkspace, true)
  t.assert.deepEqual(m.cargo.workspace.members, ['crates/*'])
})

test('parseCargoManifest returns no package for a virtual manifest, and refuses a package without a name', (t) => {
  t.assert.equal(parseCargoManifest('[workspace]\nmembers = ["a"]\n').package, null)
  t.assert.throws(() => parseCargoManifest('[package]\nversion = "1.0.0"\n', 'Cargo.toml'), { name: 'LockfileError', message: 'Cargo.toml: package.name: expected a string, found nothing' })
})

test('createCargoContext identifies the owning package, resolving version.workspace through the root', (t) => {
  const cargo = createCargoContext(join(fixtures, 'workspace'))
  t.assert.deepEqual(cargo.packageInfo('crates/app/src/main.rs'), { dir: 'crates/app', name: 'app', version: '0.3.0' })
  t.assert.deepEqual(cargo.packageInfo('crates/util/src/detail.rs'), { dir: 'crates/util', name: 'util', version: '0.2.0' })
  t.assert.equal(cargo.packageInfo('Cargo.toml'), null) // the workspace root has no [package]
  t.assert.equal(createCargoContext(join(fixtures, 'basic')).packageInfo('src/main.rs'), null)
})

test('createCargoContext resolves path deps (workspace-inherited, renamed, [lib] path) to their lib root', (t) => {
  const cargo = createCargoContext(join(fixtures, 'workspace'))
  t.assert.equal(cargo.resolveCrate('util', 'crates/app/src/main.rs'), 'crates/util/src/util_lib.rs')
  t.assert.equal(cargo.resolveCrate('tools', 'crates/app/src/main.rs'), 'crates/tools/src/lib.rs')
  t.assert.equal(cargo.resolveCrate('serde', 'crates/app/src/main.rs'), null) // registry dep, not in-tree
  t.assert.equal(cargo.resolveCrate('util', 'crates/tools/src/lib.rs'), null) // not a dep of that package
})

test('createCargoContext resolves the package\'s own crate name to its lib, and vendored crates', (t) => {
  const own = createCargoContext(join(fixtures, 'lib-bin'))
  t.assert.equal(own.resolveCrate('my_app', 'src/main.rs'), 'src/lib.rs')
  t.assert.equal(own.resolveCrate('my_app', 'tests/smoke.rs'), 'src/lib.rs')
  t.assert.equal(own.resolveCrate('my_app', 'src/lib.rs'), null) // never itself
  const vendored = createCargoContext(join(fixtures, 'vendored-transitive'))
  t.assert.equal(vendored.resolveCrate('alpha', 'src/main.rs'), 'vendor/alpha/src/lib.rs')
  t.assert.equal(vendored.resolveCrate('beta_lib', 'vendor/alpha/src/lib.rs'), 'vendor/beta-lib/src/lib.rs') // hyphenated dir
  t.assert.equal(vendored.resolveCrate('missing_crate', 'src/main.rs'), null)
})

test('resolveVendoredCrate finds a vendored root among known sources, either spelling', (t) => {
  const known = new Map([['vendor/beta-lib/src/lib.rs', ''], ['vendor/gamma/src/lib.rs', '']])
  t.assert.equal(resolveVendoredCrate('beta_lib', { knownSources: known }), 'vendor/beta-lib/src/lib.rs')
  t.assert.equal(resolveVendoredCrate('gamma', { knownSources: known }), 'vendor/gamma/src/lib.rs')
  t.assert.equal(resolveVendoredCrate('delta', { knownSources: known }), null)
})

// --- walk ---

test('collectRustFilesFromDisk walks mod declarations from the entry', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'basic'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk follows nested mods into stem subdirectories', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'nested'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo.rs', 'src/foo/bar.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk follows mod.rs-style submodules', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'mod-rs'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/foo/bar.rs', 'src/foo/mod.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk does not follow inline mods or absent mods', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'inline-mod'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/main.rs', 'src/real.rs'])
})

test('collectRustFilesFromDisk does not pull in external crates that are not in-tree', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'external-crate'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/local.rs', 'src/main.rs'])
})

test('collectRustFilesFromDisk treats every entry as a crate root (src/bin, tests) and pulls the own lib in', async (t) => {
  const bin = await collectRustFilesFromDisk(join(fixtures, 'lib-bin'), ['src/bin/tool.rs'])
  t.assert.deepEqual([...bin.keys()].toSorted(), ['src/bin/helper.rs', 'src/bin/tool.rs', 'src/cli.rs', 'src/config.rs', 'src/lib.rs'])
  // tests/smoke.rs is a test target: its `#[cfg(test)] mod helpers;` is live
  const it = await collectRustFilesFromDisk(join(fixtures, 'lib-bin'), ['tests/smoke.rs'])
  t.assert.deepEqual([...it.keys()].toSorted(), ['src/cli.rs', 'src/config.rs', 'src/lib.rs', 'tests/common/mod.rs', 'tests/helpers.rs', 'tests/smoke.rs'])
})

test('collectRustFilesFromDisk honours #[path] in every position and inline-nested mods', async (t) => {
  // src/de/seed.rs is loaded via #[path]: its own `mod extra;` is src/de/extra.rs, beside it, like a mod.rs
  const paths = await collectRustFilesFromDisk(join(fixtures, 'path-attr'), ['src/lib.rs'])
  t.assert.deepEqual([...paths.keys()].toSorted(), [
    'src/de.rs', 'src/de/extra.rs', 'src/de/seed.rs', 'src/discouraged.rs', 'src/documented.rs', 'src/lib.rs', 'src/parse.rs', 'src/private/mod.rs',
    'src/raw/mod.rs', 'src/sys.rs', 'src/sys/unix.rs', 'src/sys/windows.rs',
  ])
  const inline = await collectRustFilesFromDisk(join(fixtures, 'inline-nested'), ['src/main.rs'])
  t.assert.deepEqual([...inline.keys()].toSorted(), ['src/main.rs', 'src/outer/deep/leaf.rs', 'src/outer/inner.rs'])
})

test('collectRustFilesFromDisk follows path deps and vendored crates transitively (`extern crate … as` too)', async (t) => {
  // util's `std` is a default feature; app's `default-features = false` on the inherited entry is ignored
  // (the workspace entry keeps defaults), so std_impl.rs is in.
  const ws = await collectRustFilesFromDisk(join(fixtures, 'workspace'), ['crates/app/src/main.rs'])
  t.assert.deepEqual([...ws.keys()].toSorted(), [
    'crates/app/src/local.rs', 'crates/app/src/main.rs', 'crates/tools/src/lib.rs', 'crates/util/src/detail.rs', 'crates/util/src/std_impl.rs', 'crates/util/src/util_lib.rs',
  ])
  // `use gamma;` and `use delta::{self, D};` name the crates themselves: followed like any other import
  const vendored = await collectRustFilesFromDisk(join(fixtures, 'vendored-transitive'), ['src/main.rs'])
  t.assert.deepEqual([...vendored.keys()].toSorted(), [
    'src/main.rs', 'vendor/alpha/src/inner.rs', 'vendor/alpha/src/lib.rs', 'vendor/beta-lib/src/lib.rs', 'vendor/delta/src/lib.rs', 'vendor/gamma/src/lib.rs',
  ])
})

test('collectRustFilesFromDisk keeps the modules after a dead field, variant or arm, in and out of inline modules', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'dead-fields'), ['src/lib.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), [
    'src/after_enum.rs', 'src/after_fn.rs', 'src/after_tuple.rs', 'src/client.rs', 'src/imp/server.rs', 'src/last.rs', 'src/lib.rs',
  ])
  const { missing, resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'], baseDir: join(fixtures, 'dead-fields') })
  t.assert.deepEqual(missing, [])
  t.assert.equal(resolutions.get('src/lib.rs').get('mod imp::server'), 'src/imp/server.rs')
})

// --- module trees ---

test('crateRoots is every main.rs/lib.rs first, then the loaded entries', (t) => {
  const sources = new Map([['src/bin/tool.rs', ''], ['src/lib.rs', ''], ['src/util.rs', ''], ['vendor/x/src/lib.rs', ''], ['vendor/x/src/main.rs', '']])
  t.assert.deepEqual([...crateRoots(sources, ['src/bin/tool.rs', 'gone.rs'])], ['src/lib.rs', 'vendor/x/src/lib.rs', 'vendor/x/src/main.rs', 'src/bin/tool.rs'])
})

test('buildModuleTrees lets a named root claim a glob-listed module file before that file claims itself', (t) => {
  // `stasis bundle src/*.rs` lists src/util.rs as an entry although lib.rs declares it: its
  // `crate::` paths must still resolve in lib's tree, not against a one-file tree of its own.
  const sources = new Map([
    ['src/lib.rs', 'pub mod util;\npub const VERSION: u8 = 1;\n'],
    ['src/util.rs', 'use crate::VERSION;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/util.rs', 'src/lib.rs'] })
  t.assert.equal(resolutions.get('src/util.rs').get('crate::VERSION'), 'src/lib.rs')
})

test('buildModuleTrees maps module paths to files per crate root, and files back to their module', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'nested'), ['src/main.rs'])
  const { resolutions } = buildRustTree(sources)
  const { trees, files } = buildModuleTrees(sources, resolutions, crateRoots(sources))
  const tree = trees.get('src/main.rs')
  t.assert.equal(tree.get('crate'), 'src/main.rs')
  t.assert.equal(tree.get('crate::foo'), 'src/foo.rs')
  t.assert.equal(tree.get('crate::foo::bar'), 'src/foo/bar.rs')
  t.assert.deepEqual(files.get('src/foo/bar.rs'), { root: 'src/main.rs', modulePath: 'crate::foo::bar', leaves: [], parent: 'src/foo.rs', roots: new Set(['src/main.rs']) })
})

test('buildModuleTrees keeps a lib and a bin apart (no shared `crate` key) whatever the entry order', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'pub mod abc;\npub const VERSION: u8 = 1;\n'],
    ['src/abc.rs', 'use crate::VERSION;\n'],
    ['src/main.rs', 'mod cli;\nuse crate::cli::run;\n'],
    ['src/cli.rs', 'pub fn run() {}\n'],
  ])
  for (const roots of [['src/lib.rs', 'src/main.rs'], ['src/main.rs', 'src/lib.rs']]) {
    const { resolutions } = buildRustTree(sources, { roots })
    t.assert.equal(resolutions.get('src/abc.rs').get('crate::VERSION'), 'src/lib.rs', `roots ${roots}`)
    t.assert.equal(resolutions.get('src/main.rs').get('crate::cli::run'), 'src/cli.rs', `roots ${roots}`)
  }
})

test('buildModuleTrees handles a pathologically deep mod chain without overflowing the stack', (t) => {
  // A crafted crate with a very deep linear `mod` chain must not crash the
  // bundler — recursive descent RangeErrors around ~10k frames. The walk is
  // iterative and depth-bounded.
  const N = 20_000
  const sources = new Map([['main.rs', '']])
  const resolutions = new Map([['main.rs', new Map([['mod m0', 'm0.rs']])]])
  for (let i = 0; i < N; i++) {
    sources.set(`m${i}.rs`, '')
    resolutions.set(`m${i}.rs`, i + 1 < N ? new Map([[`mod m${i + 1}`, `m${i + 1}.rs`]]) : new Map())
  }
  const { trees } = buildModuleTrees(sources, resolutions, new Set(['main.rs'])) // must not throw
  const tree = trees.get('main.rs')
  t.assert.equal(tree.get('crate'), 'main.rs')
  t.assert.ok(tree.size <= 1002, `module-tree depth should be capped, got ${tree.size}`)
})

// --- tree ---

test('buildRustTree records mod edges and crate:: use edges', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'use-crate'), ['src/main.rs'])
  const tree = buildRustTree(sources)
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources', 'unresolvedCrates', 'wantedRoots', 'wantedUnits'])
  t.assert.deepEqual(tree.wantedRoots, [])
  t.assert.deepEqual(tree.missing, [])
  t.assert.deepEqual([...tree.unresolvedCrates], [])

  const main = tree.resolutions.get('src/main.rs')
  t.assert.equal(main.get('mod foo'), 'src/foo.rs')
  t.assert.equal(main.get('mod bar'), 'src/bar.rs')
  t.assert.equal(main.get('crate::foo::Greeter'), 'src/foo.rs')
  t.assert.equal(main.get('bar::run'), 'src/bar.rs') // a relative path to a child module, in expression position

  // bar.rs uses crate::foo::Greeter -> foo.rs
  t.assert.equal(tree.resolutions.get('src/bar.rs').get('crate::foo::Greeter'), 'src/foo.rs')
  t.assert.equal(tree.resolutions.get('src/foo.rs').size, 0)
})

test('buildRustTree records an edge per path of a brace-grouped / multi-line use', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'use-groups'), ['src/main.rs'])
  const { resolutions, missing } = buildRustTree(sources)
  t.assert.deepEqual(missing, [])
  const main = edges(resolutions.get('src/main.rs'))
  t.assert.equal(main['crate::config::Config'], 'src/config.rs')
  t.assert.equal(main['crate::errors::AppError'], 'src/errors.rs')
  t.assert.equal(main['crate::net::client::Client'], 'src/net/client.rs')
  t.assert.equal(main['crate::util::helper'], 'src/util.rs')
  t.assert.equal(main['crate::net::server::Server'], 'src/net/server.rs')
  t.assert.equal(main['crate::a'], 'src/a.rs') // `pub use crate::a::*`
})

test('buildRustTree follows pub use re-exports and #[macro_export] macros, so `$crate::` paths land where the item lives', (t) => {
  // bitflags' layout: a root `__private` module re-exporting each module's `__private`, `pub use
  // external::*` at the root, and `#[macro_export]` macros in external.rs invoking each other as
  // `$crate::name!` and naming `$crate::__private::serde::…` / `$crate::serde::…`.
  const sources = new Map([
    ['src/lib.rs', [
      'pub mod __private {',
      '    pub use crate::{external::__private::*, traits::__private::*};',
      '}',
      'pub use external::*;',
      'mod external;',
      'mod traits;',
    ].join('\n')],
    ['src/external.rs', [
      'pub(crate) mod __private {',
      '    pub use serde_core as serde;',
      '}',
      'pub mod serde;',
      '#[macro_export]',
      'macro_rules! __impl_external {',
      '    () => {',
      '        $crate::__impl_external_serde! {}',
      '        impl $crate::__private::serde::Serialize for X { fn f() { $crate::serde::serialize() } }',
      '        $crate::__private::core::result::Result::Ok(())',
      '    };',
      '}',
      '#[macro_export]',
      'macro_rules! __impl_external_serde { () => {} }',
    ].join('\n')],
    ['src/external/serde.rs', 'pub fn serialize() {}\n'],
    ['src/traits.rs', 'pub(crate) mod __private {\n    pub use core;\n}\n'],
    ['vendor/serde_core/src/lib.rs', 'pub trait Serialize {}\n'],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  t.assert.deepEqual(edges(resolutions.get('src/external.rs')), {
    'mod serde': 'src/external/serde.rs',
    'crate::serde::serialize': 'src/external/serde.rs', // through the root's `pub use external::*`
    'use serde_core': 'vendor/serde_core/src/lib.rs', // `crate::__private::serde::Serialize`, through two re-exports
    // `$crate::__private::core::…`: `core` is bound by traits.rs's `pub use core;`, reached through the
    // root's glob; the sysroot item lives there as far as the bundle knows. The root's `__private`
    // module the path went through is lib.rs, the crate root: never recorded as a via edge.
    'crate::__private::core::result::Result::Ok': 'src/traits.rs',
    // `$crate::__impl_external_serde!` is defined in this very file: a self edge, dropped.
  })
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), {
    'crate::external::__private': 'src/external.rs',
    'crate::traits::__private': 'src/traits.rs',
    external: 'src/external.rs',
    'mod external': 'src/external.rs',
    'mod traits': 'src/traits.rs',
  })
})

test('buildRustTree keeps a path whose re-export chain leaves the bundle on the last module that bound it', (t) => {
  // serde: `$crate::__private::Result` in macros.rs; private/mod.rs re-exports it from the `lib`
  // module, which re-exports `core`. The item is core's; the bundle's files hold the chain of
  // imports that name it, and the path depends on each.
  const sources = new Map([
    ['src/lib.rs', ['mod lib {', '    mod core { pub use core::*; }', '    pub use self::core::result;', '}', '#[path = "private/mod.rs"]', 'pub mod __private;', 'mod macros;', 'mod other;'].join('\n')],
    ['src/private/mod.rs', 'pub use crate::lib::result::Result::{self, Err, Ok};\npub use thiserror_impl::Error;\n'],
    ['src/macros.rs', 'macro_rules! forward { () => { $crate::__private::Result::Ok(()); $crate::__private::Error } }\n'],
    ['src/other.rs', 'fn f() -> crate::__private::Result<()> { todo!() }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/macros.rs')), {
    // `Result` is bound by the `lib` module's `pub use self::core::result` (its `core::*` glob into
    // the sysroot can't place `result`): an item of lib.rs, as far as the bundle knows …
    'crate::__private::Result::Ok': 'src/lib.rs',
    // … and `Error` by private/mod.rs's import from a crate that isn't vendored: an item there.
    'crate::__private::Error': 'src/private/mod.rs',
  })
  // With nothing else pointing at private/mod.rs, the `__private` module the path went through is recorded.
  t.assert.deepEqual(edges(resolutions.get('src/other.rs')), { 'crate::__private::Result': 'src/lib.rs', 'crate::__private': 'src/private/mod.rs' })
})

test('buildRustTree records the module a path went through when its import leads on elsewhere and nothing else points there', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod util;\nmod types;\nmod user;\nmod other;\n'],
    ['src/util.rs', 'pub use serde_core as serde;\npub use crate::types::Thing;\npub fn helper() {}\n'],
    ['src/types.rs', 'pub struct Thing;\n'],
    ['src/user.rs', 'use crate::util::serde::Serialize;\nuse crate::util::Thing;\n'],
    ['src/other.rs', 'use crate::util::Thing;\nuse crate::util::helper;\n'],
    ['vendor/serde_core/src/lib.rs', 'pub trait Serialize {}\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'use serde_core': 'vendor/serde_core/src/lib.rs', // where `util::serde` leads
    'crate::util::Thing': 'src/types.rs', // where `util::Thing` leads
    'crate::util': 'src/util.rs', // and the module both went through, which nothing else here names
  })
  // `crate::util::helper` already points at util.rs: no prefix edge needed.
  t.assert.deepEqual(edges(resolutions.get('src/other.rs')), { 'crate::util::Thing': 'src/types.rs', 'crate::util::helper': 'src/util.rs' })
})

test('buildRustTree records include edges and edges to the file defining a macro invoked by bare name', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\ninclude!("generated/consts.rs");\nconst T: &str = include_str!("../data/table.txt");\nfn f() { ready!(1); local!(); vec![1]; }\nmacro_rules! local { () => {} }\n'],
    ['src/macros.rs', 'macro_rules! ready { ($e:expr) => { $e } }\n'],
    ['src/generated/consts.rs', 'pub const LIMIT: u32 = 3;\n'],
    ['data/table.txt', 'a,b\n'],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'], formats: new Map([['data/table.txt', 'resource']]) })
  t.assert.deepEqual(missing, [])
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), {
    'mod macros': 'src/macros.rs',
    'include generated/consts.rs': 'src/generated/consts.rs',
    'include_str ../data/table.txt': 'data/table.txt',
    'ready!': 'src/macros.rs', // `local!` is defined in this very file, `vec!` nowhere in the crate: no edges
  })
  t.assert.ok(!resolutions.has('data/table.txt')) // an asset is carried, not scanned
})

test('collectRustFilesFromDisk follows include!, carries include_str!/include_bytes! assets with their format, and leaves a dead include alone', async (t) => {
  const baseDir = join(fixtures, 'includes')
  const formats = new Map()
  const sources = await collectRustFilesFromDisk(baseDir, ['src/lib.rs'], { formats })
  t.assert.deepEqual([...sources.keys()].toSorted(), ['README.md', 'data/blob.bin', 'data/table.txt', 'src/gated.rs', 'src/generated/consts.rs', 'src/lib.rs', 'src/macros.rs'])
  t.assert.deepEqual([...formats].toSorted(), [['README.md', 'resource'], ['data/blob.bin', 'resource:base64'], ['data/table.txt', 'resource']])
  t.assert.equal(sources.get('data/blob.bin'), Buffer.from([0, 0xff, 0xfe, 1]).toString('base64'))
  t.assert.equal(sources.get('data/table.txt'), 'a,b\n1,2\n')
  // src/gated.rs opens with `#![cfg(feature = "never")]`: carried, but its `mod ghost;` and its
  // `use phantom_crate::…` are compiled out, so nothing is missing or unresolved.
  const { missing, unresolvedCrates, resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'], baseDir, formats })
  t.assert.deepEqual([missing, [...unresolvedCrates]], [[], []])
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), {
    'include_str ../README.md': 'README.md', // the crate docs' `#![doc = include_str!(…)]`
    'mod macros': 'src/macros.rs',
    'mod gated': 'src/gated.rs',
    'include generated/consts.rs': 'src/generated/consts.rs',
    'include_str ../data/table.txt': 'data/table.txt',
    'include_bytes ../data/blob.bin': 'data/blob.bin',
    'ready!': 'src/macros.rs',
  })
})

test('buildRustTree lets a glob provide a name only from a module of this crate that has it', (t) => {
  // A glob into the sysroot or into a crate that isn't in-tree can't be told what it brings in:
  // it claims nothing, so the file's crate edges and unresolved reports stay, and a `crate::Name`
  // nothing places stays on the module reached.
  const sources = new Map([
    ['src/lib.rs', ['mod a;', 'mod b;', 'mod c;', 'mod user;', 'pub use a::*;', 'pub use b::*;', 'pub use std::io::prelude::*;', 'pub use rayon::prelude::*;'].join('\n')],
    ['src/a.rs', 'pub mod inner;\npub use crate::c::Item;\npub struct Own;\n'],
    ['src/a/inner.rs', 'pub fn f() {}\n'],
    ['src/b.rs', 'use core::arch::x86_64::*;\nfn f() { serde::to_string(); _mm_pause(); }\nmod imp { use super::*; use serde_json::json; }\n'],
    ['src/c.rs', 'pub struct Item;\n'],
    ['src/user.rs', 'use crate::Item;\nuse crate::inner::f;\nuse crate::Own;\nuse crate::Read;\nuse serde::Serialize;\n'],
    ['vendor/serde/src/lib.rs', 'pub trait Serialize {}\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/b.rs')), { 'use serde': 'vendor/serde/src/lib.rs' }) // `use core::arch::x86_64::*` hides nothing
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::Item': 'src/c.rs', // through `pub use a::*`, then a's `pub use crate::c::Item`
    'crate::inner::f': 'src/a/inner.rs', // through `pub use a::*`: a child module of a
    'crate::Own': 'src/a.rs', // through `pub use a::*`: a struct a.rs defines
    'crate::Read': 'src/lib.rs', // from the sysroot, through `pub use std::io::prelude::*`
    'use serde': 'vendor/serde/src/lib.rs',
  })
  t.assert.deepEqual([...unresolvedCrates].toSorted(), ['rayon', 'serde_json'])
})

test('buildRustTree places an item a module defines behind a glob, before a later glob\'s re-export of the name', (t) => {
  // libc: every platform module is glob re-exported from the root; `crate::sigset_t` is the struct
  // the first such module defines (inside its `s! { … }`), not a later platform's `pub use` of it.
  const sources = new Map([
    ['src/lib.rs', 'mod fuchsia;\nmod unix;\nmod user;\npub use crate::fuchsia::*;\npub use crate::unix::*;\n'],
    ['src/fuchsia.rs', 's! { pub struct sigset_t { bits: u64 } }\npub type c_int = i32;\nfn f() { crate::sigset_t::default(); }\n'],
    ['src/unix.rs', 'pub use self::generic::sigset_t;\nmod generic;\npub const X: crate::c_int = 1;\n'],
    ['src/unix/generic.rs', 'pub struct sigset_t;\n'],
    ['src/user.rs', 'use crate::sigset_t;\nuse crate::c_int;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::sigset_t': 'src/fuchsia.rs', 'crate::c_int': 'src/fuchsia.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/unix.rs')), { 'mod generic': 'src/unix/generic.rs', 'self::generic::sigset_t': 'src/unix/generic.rs', 'crate::c_int': 'src/fuchsia.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/fuchsia.rs')), {}) // its own struct: no self edge
})

test('buildRustTree keeps a private mod and an impl\'s associated items out of what a glob brings in', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod user;\npub use a::*;\n'],
    ['src/a.rs', 'mod inner;\npub mod shown;\npub struct S;\nimpl S { pub fn len(&self) -> usize { 0 } pub const N: u8 = 1; type Out = u8; }\nextern "C" { pub fn getpid() -> i32; }\nfn helper() { fn local() {} }\n'],
    ['src/a/inner.rs', 'pub struct Hidden;\n'],
    ['src/a/shown.rs', ''],
    ['src/user.rs', 'use crate::inner::Hidden;\nuse crate::shown;\nuse crate::len;\nuse crate::N;\nuse crate::getpid;\nuse crate::local;\nuse crate::helper;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::inner::Hidden': 'src/lib.rs', // `mod inner` is private to a: not re-exported by `pub use a::*`
    'crate::shown': 'src/a/shown.rs',
    'crate::len': 'src/lib.rs', // a method, not an item of a
    'crate::N': 'src/lib.rs',
    'crate::getpid': 'src/a.rs', // an `extern "C"` block's fn is the module's
    'crate::local': 'src/lib.rs', // a fn's local item is not
    'crate::helper': 'src/lib.rs', // private
  })
})

test('buildRustTree resolves a fn call at the root through a glob before an exported macro of that name, and `use log` as the crate', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod facade;\nmod macros;\nmod user;\npub use facade::*;\nuse log::info;\n'],
    ['src/facade.rs', 'pub fn helper() {}\n'],
    ['src/macros.rs', '#[macro_export]\nmacro_rules! helper { () => {} }\nmacro_rules! log { () => {} }\n'],
    ['src/user.rs', 'fn f() { crate::helper(); $crate::helper!(); }\nuse log;\nuse log::debug;\n'],
    ['vendor/log/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::helper': 'src/facade.rs', // the fn call: the glob's re-export
    'crate::helper!': 'src/macros.rs', // the invocation: the macro, under a spec of its own
    'use log': 'vendor/log/src/lib.rs', // a private `macro_rules! log` in macros.rs is not what `use log` names
  })
  t.assert.equal(edges(resolutions.get('src/lib.rs'))['use log'], 'vendor/log/src/lib.rs')
})

test('buildRustTree does not report a lead a glob into another crate may provide', (t) => {
  // syn: `use syn::*;` brings syn's `punctuated` module in; `use punctuated::Punctuated` names no crate.
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\n'],
    ['src/a.rs', 'use syn::*;\nuse punctuated::Punctuated;\nuse missing_crate::X;\nmod inner { use super::*; use token::Comma; }\n'],
    ['src/b.rs', 'use std::io::prelude::*;\nuse Kind::*;\nuse other_missing::Y;\nenum Kind { A }\n'],
    ['src/c.rs', 'use proc_macro2::*;\nuse unseen::Z;\n'],
    ['vendor/syn/src/lib.rs', 'pub mod punctuated;\npub mod token;\n'],
    ['vendor/syn/src/punctuated.rs', ''],
    ['vendor/syn/src/token.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  // syn is in-tree, so what its glob brings in is known: `punctuated` and `token`, not
  // `missing_crate` (tracing's `use tracing_core::*;` must not hide its `tracing_attributes`). A
  // glob into a crate that isn't (proc_macro2 here) may bring anything in, `unseen` included; a
  // sysroot glob or an enum's brings in no crate-like lead.
  t.assert.deepEqual([...unresolvedCrates].toSorted(), ['missing_crate', 'other_missing', 'proc_macro2'])
  t.assert.deepEqual(edges(resolutions.get('src/a.rs')), { 'use syn': 'vendor/syn/src/lib.rs' })
})

test('buildRustTree follows the crate root\'s `extern crate … as` alias from any module', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'extern crate serde_core as s;\nextern crate missing_dep as md;\nmod a;\n'],
    ['src/a.rs', 'use s::Value;\nfn f() { s::to_value(); md::x(); }\nuse md::Y;\n'],
    ['vendor/serde_core/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/a.rs')), { 'use serde_core': 'vendor/serde_core/src/lib.rs' })
  t.assert.deepEqual([...unresolvedCrates], ['missing_dep']) // by its crate name, not the alias
})

test('buildRustTree resolves `self::` paths and glob-provided names in a cfg-variant file through that file\'s own imports', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[cfg_attr(unix, path = "sys/unix.rs")]\n#[cfg_attr(windows, path = "sys/windows.rs")]\nmod sys;\nmod u;\nmod w;\n'],
    ['src/sys/unix.rs', 'use crate::u::Handle;\nuse crate::u::*;\nfn f() { self::Handle::new(); self::helper::go(); }\n'],
    ['src/sys/windows.rs', 'use crate::w::Handle;\nuse crate::w::*;\nfn f() { self::Handle::new(); self::helper::go(); }\n'],
    ['src/u.rs', 'pub struct Handle;\npub mod helper { pub fn go() {} }\n'],
    ['src/w.rs', 'pub struct Handle;\npub mod helper { pub fn go() {} }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/sys/unix.rs')), { 'crate::u::Handle': 'src/u.rs', 'crate::u': 'src/u.rs', 'self::Handle::new': 'src/u.rs', 'self::helper::go': 'src/u.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/sys/windows.rs')), { 'crate::w::Handle': 'src/w.rs', 'crate::w': 'src/w.rs', 'self::Handle::new': 'src/w.rs', 'self::helper::go': 'src/w.rs' })
})

test('buildRustTree prefers a mod file to an inline module of the same name whatever the declaration order, nested mods included', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[cfg(not(unix))]\nmod imp { mod inner; pub fn f() {} }\n#[cfg(unix)]\nmod imp;\nmod user;\n'],
    ['src/imp.rs', 'pub fn f() {}\n'],
    ['src/imp/inner.rs', ''],
    ['src/user.rs', 'use crate::imp::f;\n'],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  // The file is the module in the tree; the path means either, each under its cfg.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::imp::f': { unix: 'src/imp.rs', 'not(unix)': 'src/lib.rs' } })
})

test('scanRustItems skips the else branches of a dead `if`, and takes a bare macro call after a single `:` for one', (t) => {
  const items = scanRustItems([
    'fn f() {',
    '    #[cfg(feature = "never")]',
    '    if a { serde::to_string(); } else if b { serde_json::json!(1); } else { toml::from_str(); }',
    '    let s = S { a:helper!(), b: other!() };',
    '    let p = std::path::Path::new("x");',
    '}',
  ].join('\n'), { features: new Set() })
  t.assert.deepEqual(items.refs.map((r) => r.spec), [])
  t.assert.deepEqual([...items.invocations].toSorted(), ['helper', 'other'])
})

test('buildRustTree resolves through several globs of one module, and through each import under its own cfg', (t) => {
  const sources = new Map([
    ['src/lib.rs', ['mod foo;', 'mod b;', 'mod user;', 'pub use foo::a::*;', 'pub use foo::b::*;', '#[cfg(unix)]', 'pub use notvendored::X;', '#[cfg(windows)]', 'pub use crate::b::X;'].join('\n')],
    ['src/foo.rs', 'pub mod a;\npub mod b;\n'],
    ['src/foo/a.rs', 'pub struct A;\n'],
    ['src/foo/b.rs', 'pub mod deep;\n'],
    ['src/foo/b/deep.rs', ''],
    ['src/b.rs', 'pub struct X;\n'],
    ['src/user.rs', 'use crate::deep::D;\nuse crate::X;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::deep::D': 'src/foo/b/deep.rs', // `deep` through the second glob
    // Under unix the `pub use notvendored::X` binds it -- a crate that isn't in-tree, so the name
    // is lib.rs's as far as the bundle knows -- under windows `crate::b::X`.
    'crate::X': { unix: 'src/lib.rs', windows: 'src/b.rs' },
  })
})

test('buildRustTree prefers a mod file to an inline module of the same name, and the variant an import was followed in', (t) => {
  const sources = new Map([
    ['src/lib.rs', ['#[cfg(unix)]', 'mod imp;', '#[cfg(not(unix))]', 'mod imp { pub fn f() {} }', '#[cfg_attr(unix, path = "sys/unix.rs")]', '#[cfg_attr(windows, path = "sys/windows.rs")]', 'mod sys;', 'mod user;', 'mod u;', 'mod w;'].join('\n')],
    ['src/imp.rs', 'pub fn f() {}\n'],
    ['src/sys/unix.rs', 'pub use crate::u::Handle;\nfn f() { helper::go(); }\nuse crate::u::helper;\n'],
    ['src/sys/windows.rs', 'pub use crate::w::Handle;\npub use crate::w::Other;\nfn f() { helper::go(); }\nuse crate::w::helper;\n'],
    ['src/u.rs', 'pub struct Handle;\npub mod helper { pub fn go() {} }\n'],
    ['src/w.rs', 'pub struct Handle;\npub struct Other;\npub mod helper { pub fn go() {} }\n'],
    ['src/user.rs', 'use crate::imp::f;\nuse crate::sys::Handle;\nuse crate::sys::Other;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs'))['mod sys'], { unix: 'src/sys/unix.rs', windows: 'src/sys/windows.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::imp::f': { unix: 'src/imp.rs', 'not(unix)': 'src/lib.rs' },
    'crate::sys::Handle': { unix: 'src/u.rs', windows: 'src/w.rs' }, // each variant's import, under its cfg
    'crate::sys': 'src/sys/unix.rs', // the module the paths went through, in the file whose import was followed first
    'crate::sys::Other': 'src/w.rs', // only windows.rs binds `Other`: its import is the one followed
  })
  // A path anchored on the module's own import names no module of its own: no edge for the module,
  // whichever variant holds the import.
  t.assert.deepEqual(edges(resolutions.get('src/sys/windows.rs')), { 'crate::w::Handle': 'src/w.rs', 'crate::w::Other': 'src/w.rs', 'helper::go': 'src/w.rs', 'crate::w::helper': 'src/w.rs' })
})

test('buildRustTree names a macro by path only as the final segment of an invocation or at the crate root', (t) => {
  const sources = new Map([
    ['src/lib.rs', ['mod macros;', 'mod span;', 'mod facade;', 'mod user;', 'pub use facade::*;', 'use log::debug;'].join('\n')],
    ['src/macros.rs', '#[macro_export]\nmacro_rules! span { () => {} }\n#[macro_export]\nmacro_rules! helper { () => {} }\n#[macro_export]\nmacro_rules! log { () => {} }\n'],
    ['src/span.rs', 'pub struct Span;\n'],
    ['src/facade.rs', 'pub fn helper() {}\n'],
    ['src/user.rs', 'fn f() { $crate::span!(); crate::span::Span::new(); $crate::helper!(); crate::helper(); }\nuse log::info;\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::span!': 'src/macros.rs', // `$crate::span!()`: the macro, not the module of that name
    'crate::span::Span::new': 'src/span.rs',
    'crate::helper!': 'src/macros.rs', // the invocation: the exported macro
    'crate::helper': 'src/facade.rs', // the path: the glob's re-export
  })
  t.assert.deepEqual([...unresolvedCrates], ['log']) // `use log::debug` names the crate, not the crate's own `log!` macro
})

test('buildRustTree follows a `use` of a macro_rules! macro defined in the crate, not a crate of that name', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'macro_rules! cfg_if { () => {} }\npub(crate) use cfg_if;\nmod util;\nmod user;\n'],
    ['src/util.rs', 'macro_rules! helper { () => {} }\npub(crate) use helper;\nfn f() { helper!(); }\n'],
    ['src/user.rs', 'use crate::cfg_if;\nuse crate::util::helper;\nfn f() { cfg_if! {} helper!(); }\n'],
    ['vendor/cfg-if/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'mod util': 'src/util.rs', 'mod user': 'src/user.rs' }) // `use cfg_if` is the macro above, not vendor/cfg-if
  t.assert.deepEqual(edges(resolutions.get('src/util.rs')), {})
  // The bare `cfg_if!` call also sees lib.rs's `macro_rules!` textually (an ancestor file, defined
  // before `mod user;`); `helper!` lives in a sibling file, and reaches this one through the `use`.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::cfg_if': 'src/lib.rs', 'crate::util::helper': 'src/util.rs', 'cfg_if!': 'src/lib.rs', 'helper!': 'src/util.rs' })
})

test('buildRustTree answers through an import cycle the same whichever side is asked first', (t) => {
  // a and b glob each other; each also names one item. Asking b for X walks b → a → (b again:
  // cut) → a's `X`; the a-closure settled while b was still open must not be saved short of b, or
  // the later `a::Y` (found only through b) would miss.
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\nmod d;\nmod first;\nmod second;\n'],
    ['src/a.rs', 'pub use crate::b::*;\npub use crate::c::X;\n'],
    ['src/b.rs', 'pub use crate::a::*;\npub use crate::d::Y;\n'],
    ['src/c.rs', 'pub struct X;\n'],
    ['src/d.rs', 'pub struct Y;\n'],
    ['src/first.rs', 'use crate::b::X;\nuse crate::a::Y;\nuse crate::a::X;\nuse crate::b::Y;\n'],
    ['src/second.rs', 'use crate::a::Y;\nuse crate::b::X;\n'],
  ])
  // (`crate::a` / `crate::b`: the modules the paths went through, which nothing else here names.)
  const want = { 'crate::b::X': 'src/c.rs', 'crate::a::Y': 'src/d.rs', 'crate::a::X': 'src/c.rs', 'crate::b::Y': 'src/d.rs', 'crate::b': 'src/b.rs', 'crate::a': 'src/a.rs' }
  t.assert.deepEqual(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/first.rs')), want)
  // The other order of first questions: swap which user file the walk meets first.
  const swapped = new Map([...sources].map(([p, c]) => [p, p === 'src/lib.rs' ? c.replace('mod first;\nmod second;', 'mod second;\nmod first;') : c]))
  t.assert.deepEqual(edges(buildRustTree(swapped, { roots: ['src/lib.rs'] }).resolutions.get('src/first.rs')), want)
  // Three modules in a ring, the item two hops away.
  const ring = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\nmod user;\n'],
    ['src/a.rs', 'pub use crate::b::*;\npub struct A;\n'],
    ['src/b.rs', 'pub use crate::c::*;\npub struct B;\n'],
    ['src/c.rs', 'pub use crate::a::*;\npub struct C;\n'],
    ['src/user.rs', 'use crate::b::A;\nuse crate::a::C;\nuse crate::c::B;\nuse crate::a::B;\nuse crate::b::C;\nuse crate::c::A;\n'],
  ])
  t.assert.deepEqual(edges(buildRustTree(ring, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs')), {
    'crate::b::A': 'src/a.rs', 'crate::a::C': 'src/c.rs', 'crate::c::B': 'src/b.rs', 'crate::a::B': 'src/b.rs', 'crate::b::C': 'src/c.rs', 'crate::c::A': 'src/a.rs',
  })
  // A name found only around the cycle: `a::X` through b, whose glob comes back through a.
  const around = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\nmod user;\n'],
    ['src/a.rs', 'pub use crate::b::*;\npub use crate::c::*;\n'],
    ['src/b.rs', 'pub use crate::a::inner::*;\n'],
    ['src/c.rs', 'pub mod inner { pub struct X; }\n'],
    ['src/user.rs', 'use crate::a::X;\nuse crate::b::X as Y;\n'],
  ])
  t.assert.deepEqual(edges(buildRustTree(around, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs')), { 'crate::a::X': 'src/c.rs', 'crate::b::X': 'src/c.rs', 'crate::a': 'src/a.rs', 'crate::b': 'src/b.rs' })
})

test('buildRustTree survives a `use log;` or `use x::{self}` in a module spread over platform files', (t) => {
  // A one-segment import in a file whose module has other (cfg-variant) files asks its own
  // module for the name, which is that very import: no recursion.
  const sources = new Map([
    ['src/lib.rs', '#[cfg_attr(unix, path = "u.rs")]\n#[cfg_attr(windows, path = "w.rs")]\nmod sys;\nmod x;\n'],
    ['src/u.rs', 'use log;\nuse crate::x::{self, Y};\nfn f() { log::info!("x"); x::g(); }\n'],
    ['src/w.rs', 'use crate::x::Y;\n'],
    ['src/x.rs', 'pub struct Y;\npub fn g() {}\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/u.rs')), { 'crate::x': 'src/x.rs', 'crate::x::Y': 'src/x.rs', 'x::g': 'src/x.rs' })
  t.assert.deepEqual([...unresolvedCrates], ['log'])
})

test('buildRustTree keeps a path under one platform out of the other platforms\' files', (t) => {
  // libc: each platform module is glob re-exported from the root in a `cfg_if!` branch. A file
  // under `unix` asking `crate::c_int` means unix's, not fuchsia's or windows'; a platform-neutral
  // file gets the first branch's.
  const sources = new Map([
    ['src/lib.rs', ['mod user;', 'cfg_if! {', '  if #[cfg(windows)] { mod windows; pub use windows::*; }', '  else if #[cfg(target_os = "fuchsia")] { mod fuchsia; pub use fuchsia::*; }', '  else if #[cfg(unix)] { mod unix; pub use unix::*; }', '}'].join('\n')],
    ['src/windows.rs', 'pub type c_int = i32;\npub struct sigset_t;\n'],
    ['src/fuchsia.rs', 'pub type c_int = i32;\ns! { pub struct sigset_t { x: u8 } }\n'],
    ['src/unix.rs', 'pub type c_int = i32;\nmod linux;\npub use self::linux::sigset_t;\nfn f() { crate::sigset_t::default(); }\n'],
    ['src/unix/linux.rs', 'pub struct sigset_t;\nuse crate::c_int;\n'],
    ['src/user.rs', 'use crate::c_int;\nuse crate::sigset_t;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/unix/linux.rs')), { 'crate::c_int': 'src/unix.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/unix.rs')), { 'mod linux': 'src/unix/linux.rs', 'self::linux::sigset_t': 'src/unix/linux.rs', 'crate::sigset_t::default': 'src/unix/linux.rs' })
  // A file under no platform cfg: every platform's, each under its cfg -- not the first written.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::c_int': { windows: 'src/windows.rs', 'target_os = "fuchsia"': 'src/fuchsia.rs', unix: 'src/unix.rs' },
    'crate::sigset_t': { windows: 'src/windows.rs', 'target_os = "fuchsia"': 'src/fuchsia.rs', unix: 'src/unix/linux.rs' },
  })
  // mio: two `pub use … Waker` in one file, in exclusive `cfg_if!` branches; a file mounted in one
  // branch means that branch's.
  const mio = new Map([
    ['src/lib.rs', 'mod sys;\n'],
    ['src/sys.rs', '#[cfg_attr(unix, path = "sys/unix/mod.rs")]\n#[cfg_attr(windows, path = "sys/windows/mod.rs")]\nmod imp;\npub use self::imp::*;\n'],
    ['src/sys/unix/mod.rs', ['cfg_if! {', '  if #[cfg(mio_unsupported_force_poll_poll)] { mod selector_poll; pub use self::selector_poll::Waker; }', '  else { mod selector_epoll; mod waker; pub use self::waker::Waker; }', '}'].join('\n')],
    ['src/sys/unix/selector_poll.rs', 'pub struct Waker;\n'],
    ['src/sys/unix/selector_epoll.rs', 'use crate::sys::Waker;\n'],
    ['src/sys/unix/waker.rs', 'pub struct Waker;\n'],
    ['src/sys/windows/mod.rs', 'pub struct Waker;\n'],
  ])
  t.assert.deepEqual(edges(buildRustTree(mio, { roots: ['src/lib.rs'] }).resolutions.get('src/sys/unix/selector_epoll.rs')), { 'crate::sys::Waker': 'src/sys/unix/waker.rs', 'crate::sys': 'src/sys.rs' })
  // tokio: a file under one macro-keyed variant of `mod imp` means that variant's items.
  const tokio = new Map([
    ['src/lib.rs', 'mod atomic;\n'],
    ['src/atomic.rs', 'cfg_has_atomic_u64! {\n    #[path = "atomic_native.rs"]\n    mod imp;\n}\ncfg_not_has_atomic_u64! {\n    #[path = "atomic_as_mutex.rs"]\n    mod imp;\n}\n'],
    ['src/atomic_native.rs', 'pub struct AtomicU64;\n'],
    ['src/atomic_as_mutex.rs', 'mod static_macro;\npub struct AtomicU64;\n'],
    ['src/atomic_as_mutex/static_macro.rs', 'use super::AtomicU64;\nfn f() { crate::atomic::imp::AtomicU64::new(); }\n'],
  ])
  t.assert.deepEqual(edges(buildRustTree(tokio, { roots: ['src/lib.rs'] }).resolutions.get('src/atomic_as_mutex/static_macro.rs')), { 'super::AtomicU64': 'src/atomic_as_mutex.rs', 'crate::atomic::imp::AtomicU64::new': 'src/atomic_as_mutex.rs' })
})

test('buildRustTree takes a one-segment root path for an exported macro when no crate has the name', (t) => {
  // anyhow: `pub use anyhow as format_err;` beside `#[macro_export] macro_rules! anyhow` in macros.rs.
  const sources = new Map([
    ['src/lib.rs', 'mod macros;\npub use anyhow as format_err;\n'],
    ['src/macros.rs', '#[macro_export]\nmacro_rules! anyhow { () => {} }\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'mod macros': 'src/macros.rs', anyhow: 'src/macros.rs' })
})

test('scanRustItems leaves template items, `static ref`, fn-body items and template imports out of what a module defines', (t) => {
  const items = scanRustItems([
    'macro_rules! m { () => { pub struct FromTemplate; use $crate::a::*; } }',
    'lazy_static! { static ref TABLE: u8 = 1; }',
    'extern "C" fn cb() { struct Local; fn inner() {} }',
    'extern "C" { pub fn getpid() -> i32; }',
    'pub struct Real;',
  ].join('\n'))
  t.assert.deepEqual(items.defined.map((d) => d.name), ['TABLE', 'cb', 'getpid', 'Real'])
  t.assert.deepEqual(items.imports.map((im) => [im.segments.join('::'), im.glob, im.macro]), [['crate::a', true, 'macro_rules']]) // recorded, but not as this module's (buildRustTree skips it)
})

test('scanRustItems skips a quote!-family body wherever it comes from, unless the file defines that macro itself', (t) => {
  const own = scanRustItems('macro_rules! quote { ($($t:tt)*) => {} }\nfn f() { quote! { crate::a::b() } }\n')
  t.assert.deepEqual(own.refs.map((r) => r.spec), ['crate::a::b'])
  const ext = scanRustItems('fn f() { quote::quote! { crate::a::b() } ::quote::quote_spanned! { crate::c::d() } }\n')
  t.assert.deepEqual(ext.refs.map((r) => r.spec), [])
})

test('buildRustTree flattens a mod whose every cfg names the same file', (t) => {
  // libc's `mod primitives` under a dozen cfgs: one file, one edge.
  const sources = new Map([
    ['src/lib.rs', '#[cfg(unix)] mod primitives;\n#[cfg(windows)] mod primitives;\n#[cfg(target_os = "fuchsia")] mod primitives;\n'],
    ['src/primitives.rs', ''],
  ])
  t.assert.deepEqual(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/lib.rs')), { 'mod primitives': 'src/primitives.rs' })
})

test('scanRustItems takes a dead `let` or arm\'s else branches with it, and the branches after a cfg_if! branch that holds', (t) => {
  const target = new Set(['unix', 'target_os="linux"', 'target_family="unix"'])
  const items = scanRustItems([
    'fn f() {',
    '  #[cfg(feature = "x")] let v = if a { dead_a::f() } else { dead_b::g() };',
    '  match k {',
    '    #[cfg(feature = "x")] 1 => if a { dead_c::h() } else { dead_d::i() },',
    '    _ => live::j(),',
    '  }',
    '}',
    'cfg_if! { if #[cfg(unix)] { mod u; use live_u::X; } else if #[cfg(windows)] { mod w; use dead_w::Y; } else { mod o; use dead_o::Z; } }',
  ].join('\n'), { features: new Set(), target })
  t.assert.deepEqual(items.refs.map((r) => r.spec).toSorted(), ['live::j', 'live_u::X'])
  t.assert.deepEqual(items.mods.map((m) => m.name), ['u'])
  // Without a target the branches stay, each under what it means.
  t.assert.deepEqual(scanRustItems('cfg_if! { if #[cfg(unix)] { mod u; } else if #[cfg(windows)] { mod w; } else { mod o; } }').mods.map((m) => [m.name, m.cfg]), [['u', 'unix'], ['w', 'all(not(unix), windows)'], ['o', 'all(not(unix), not(windows))']])
})

test('buildRustTree gives a bare macro call its textual scope: definitions before the mounting mod, a #[macro_use] mod\'s within its module', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod early;\nmacro_rules! late { () => {} }\nmod a;\nmod b;\nmod later;\n'],
    ['src/early.rs', 'fn f() { late!(); }\n'],
    ['src/later.rs', 'fn f() { late!(); }\n'],
    ['src/a.rs', '#[macro_use]\nmod inner_macros;\nmod uses;\nfn f() { nested!(); }\n'],
    ['src/a/inner_macros.rs', 'macro_rules! nested { () => {} }\n'],
    ['src/a/uses.rs', 'fn f() { nested!(); }\n'],
    ['src/b.rs', 'fn f() { nested!(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/early.rs')), {}) // `late!` is defined after `mod early;`
  t.assert.deepEqual(edges(resolutions.get('src/later.rs')), { 'late!': 'src/lib.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/a.rs')), { 'mod inner_macros': 'src/a/inner_macros.rs', 'mod uses': 'src/a/uses.rs', 'nested!': 'src/a/inner_macros.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/a/uses.rs')), { 'nested!': 'src/a/inner_macros.rs' }) // mounted after the `#[macro_use] mod`
  t.assert.deepEqual(edges(resolutions.get('src/b.rs')), {}) // a's `#[macro_use]` reaches a, not the crate
})

test('scanRustItems reads a manifest-relative include inside a doc attribute', (t) => {
  const items = scanRustItems('#![doc = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/README.md"))]\n#[doc = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/docs/a.md"))]\npub struct S;\n')
  t.assert.deepEqual(items.includes, [
    { kind: 'include_str', path: 'README.md', base: 'manifest', conditional: false },
    { kind: 'include_str', path: 'docs/a.md', base: 'manifest', conditional: false },
  ])
})

test('buildRustTree honours restricted visibility on re-exports', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\n'],
    ['src/a.rs', 'pub mod inner;\npub mod other;\npub(self) use crate::c::Priv;\npub(super) use crate::c::ToParent;\npub(in crate::a) use crate::c::InA;\nfn f() { Priv::new(); }\n'],
    ['src/a/inner.rs', 'use super::InA;\nuse super::Priv;\nuse crate::a::ToParent;\n'],
    ['src/a/other.rs', 'use super::InA;\n'],
    ['src/b.rs', 'use crate::a::ToParent as T;\nuse crate::a::InA as I;\nuse crate::a::Priv as P;\n'],
    ['src/c.rs', 'pub struct Priv;\npub struct ToParent;\npub struct InA;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  // Inside `a`: everything (and `super`, the module whose imports the paths went through).
  t.assert.deepEqual(edges(resolutions.get('src/a/inner.rs')), { 'super::InA': 'src/c.rs', 'super::Priv': 'src/c.rs', 'crate::a::ToParent': 'src/c.rs', super: 'src/a.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/a/other.rs')), { 'super::InA': 'src/c.rs', super: 'src/a.rs' })
  // From b (a sibling of a, inside the crate root): only what `pub(super)` -- the root -- lets out;
  // the other two names are a's own, as far as b can see.
  t.assert.deepEqual(edges(resolutions.get('src/b.rs')), { 'crate::a::ToParent': 'src/c.rs', 'crate::a::InA': 'src/a.rs', 'crate::a::Priv': 'src/a.rs' })
})

test('buildRustTree follows `extern crate … as` like a use, and `extern crate self` to the crate root', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'pub extern crate serde_json as json;\nextern crate self as me;\nmod util;\nmod user;\n'],
    ['src/util.rs', 'pub fn f() {}\n'],
    ['src/user.rs', 'extern crate serde_core as s;\nfn f() { s::Value::Null; crate::json::Value::Null; me::util::f(); }\n'],
    ['vendor/serde_json/src/lib.rs', ''],
    ['vendor/serde_core/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'use serde_core': 'vendor/serde_core/src/lib.rs', // `s::Value`, through the alias
    'use serde_json': 'vendor/serde_json/src/lib.rs', // `crate::json::Value`, through the root's `pub extern crate … as json`
    'me::util::f': 'src/util.rs', // `crate::util::f`: the root's `extern crate self as me` is in the extern prelude
  })
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'use serde_json': 'vendor/serde_json/src/lib.rs', 'mod util': 'src/util.rs', 'mod user': 'src/user.rs' })
})

test('buildRustTree records no via edge for the crate root, however the path reaches it', (t) => {
  // quote's ext.rs: `use super::ToTokens;` with `pub use to_tokens::ToTokens;` in lib.rs.
  const sources = new Map([
    ['src/lib.rs', 'mod to_tokens;\nmod ext;\nmod runtime;\npub use to_tokens::ToTokens;\npub mod __private { pub use crate::runtime::push_ident; }\n'],
    ['src/to_tokens.rs', 'pub trait ToTokens {}\n'],
    ['src/runtime.rs', 'pub fn push_ident() {}\n'],
    ['src/ext.rs', 'use super::ToTokens;\nuse crate::__private::push_ident;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/ext.rs')), { 'super::ToTokens': 'src/to_tokens.rs', 'crate::__private::push_ident': 'src/runtime.rs' })
})

test('buildRustTree anchors a path on the module\'s own imports: a `use`d name, or one a glob re-export provides', (t) => {
  // typenum: `pub use crate::{gen::consts}; pub use consts::*;` -- libc: `pub use linux_uapi::*;
  // pub use linux::types::*;` where `linux` is a module of linux_uapi. Neither `consts` nor
  // `linux` is a crate, and nothing is reported as one.
  const sources = new Map([
    ['src/lib.rs', ['mod gen;', 'mod uapi;', 'mod user;', 'pub use gen::consts;', 'pub use consts::*;', 'pub use uapi::*;', 'pub use linux::types::*;'].join('\n')],
    ['src/gen.rs', 'pub mod consts;\n'],
    ['src/gen/consts.rs', 'pub struct U1;\n'],
    ['src/uapi.rs', 'pub(crate) mod linux;\n'],
    ['src/uapi/linux.rs', 'pub mod types;\n'],
    ['src/uapi/linux/types.rs', 'pub type Foo = u8;\n'],
    ['src/user.rs', 'use crate::consts::U1;\nuse crate::linux::types::Foo;\nuse crate::U1 as Root;\n'],
  ])
  const { resolutions, missing, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), {
    'mod gen': 'src/gen.rs',
    'mod uapi': 'src/uapi.rs',
    'mod user': 'src/user.rs',
    'gen::consts': 'src/gen/consts.rs',
    consts: 'src/gen/consts.rs', // through this module's own `pub use gen::consts`
    uapi: 'src/uapi.rs',
    'linux::types': 'src/uapi/linux/types.rs', // `linux` through `pub use uapi::*`
  })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::consts::U1': 'src/gen/consts.rs',
    'crate::linux::types::Foo': 'src/uapi/linux/types.rs',
    'crate::U1': 'src/gen/consts.rs', // an item behind a glob: the module defining it, through `pub use consts::*`
  })
})

test('buildRustTree resolves the submodules of a file mounted both through #[path] and a plain mod', (t) => {
  // rustc mounts src/b.rs twice: as `crate::b` (its `mod c;` is src/b/c.rs) and as `crate::alias`
  // (its `mod c;` would be src/c.rs). The loader keeps one resolution: whichever file exists.
  const sources = new Map([
    ['src/lib.rs', 'mod b;\n#[path = "b.rs"]\nmod alias;\n'],
    ['src/b.rs', 'mod c;\n'],
    ['src/b/c.rs', ''],
  ])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  t.assert.equal(resolutions.get('src/b.rs').get('mod c'), 'src/b/c.rs')
})

test('buildRustTree rescans a file whose content changed in a reused sources map', (t) => {
  const sources = new Map([['src/lib.rs', 'mod a;\n'], ['src/a.rs', ''], ['src/b.rs', '']])
  t.assert.deepEqual([...buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/lib.rs').keys()], ['mod a'])
  sources.set('src/lib.rs', 'mod a;\nmod b;\n')
  t.assert.deepEqual([...buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/lib.rs').keys()], ['mod a', 'mod b'])
})

test('buildRustTree resolves super:: and self:: paths against the module tree', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'use-groups'), ['src/main.rs'])
  const { resolutions } = buildRustTree(sources)
  t.assert.deepEqual(edges(resolutions.get('src/util.rs')), { 'super::config::Config': 'src/config.rs', super: 'src/main.rs' })
  t.assert.equal(resolutions.get('src/net/mod.rs').get('self::client::Client'), 'src/net/client.rs')
  t.assert.deepEqual(edges(resolutions.get('src/net/client.rs')), { 'super::server::Server': 'src/net/server.rs' })
  // `use super::*` inside `mod tests { }` names the enclosing file itself: no self edge.
  t.assert.ok(![...resolutions.get('src/util.rs').values()].includes('src/util.rs'))
})

test('buildRustTree keys a mod inside inline modules by its inline path, and resolves paths into it', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'inline-nested'), ['src/main.rs'])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/main.rs'] })
  t.assert.deepEqual(missing, []) // `mod fixtures;` under #[cfg(test)] with no file is tolerated
  const main = edges(resolutions.get('src/main.rs'))
  t.assert.equal(main['mod outer::inner'], 'src/outer/inner.rs')
  t.assert.equal(main['mod outer::deep::leaf'], 'src/outer/deep/leaf.rs')
  t.assert.equal(main['outer::inner::go'], 'src/outer/inner.rs')
  t.assert.equal(main['outer::deep::leaf::x'], 'src/outer/deep/leaf.rs')
  // `use super::inner::go` inside `outer::tests` -> outer::inner
  t.assert.equal(main['super::inner::go'], 'src/outer/inner.rs')
})

test('buildRustTree records #[cfg_attr(…, path)] variants as a cfg-keyed map with the default under "*"', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'path-attr'), ['src/lib.rs'])
  const { resolutions, missing } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(missing, [])
  const lib = edges(resolutions.get('src/lib.rs'))
  t.assert.equal(lib['mod __private'], 'src/private/mod.rs')
  t.assert.equal(lib['mod seed'], 'src/de/seed.rs')
  t.assert.equal(lib['mod raw::inner'], 'src/raw/mod.rs')
  t.assert.equal(lib.inner, 'src/raw/mod.rs') // `pub use inner::*` inside `raw`
  t.assert.deepEqual(lib['mod sys'], { unix: 'src/sys/unix.rs', windows: 'src/sys/windows.rs', '*': 'src/sys.rs' })
  t.assert.ok(!('mod exotic' in lib)) // platform-gated with nothing on disk: omitted, not missing
  t.assert.equal(lib['mod documented'], 'src/documented.rs')
  t.assert.equal(resolutions.get('src/parse.rs').get('mod discouraged'), 'src/discouraged.rs')
  t.assert.deepEqual(edges(resolutions.get('src/de.rs')), { 'crate::__private::helper': 'src/private/mod.rs', 'super::seed::Seed': 'src/de/seed.rs' })
  t.assert.equal(resolutions.get('src/de/seed.rs').get('mod extra'), 'src/de/extra.rs') // the #[path]-loaded file owns its dir
})

test('buildRustTree follows a mod inside a macro body when its file exists and tolerates it when it does not', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'macro-mods'), ['src/main.rs'])
  // cfg_if!'s modules are bundled; serde_with's guide "modules" have only .md docs, never .rs files.
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/imp_other.rs', 'src/imp_unix.rs', 'src/main.rs', 'src/real.rs'])
  const { result: tree, warnings } = captureWarnings(() => buildRustTree(sources, { roots: ['src/main.rs'] }))
  t.assert.deepEqual(tree.missing, [])
  t.assert.deepEqual(warnings, [])
  const main = edges(tree.resolutions.get('src/main.rs'))
  t.assert.equal(main['mod imp_unix'], 'src/imp_unix.rs')
  t.assert.equal(main['mod imp_other'], 'src/imp_other.rs')
  t.assert.equal(main['mod real'], 'src/real.rs')
  t.assert.ok(!('mod guide::feature_flags' in main))
})

test('buildRustTree records an unresolvable mod declaration in `missing`', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'missing-mod'), ['src/main.rs'])
  t.assert.deepEqual([...sources.keys()].toSorted(), ['src/main.rs', 'src/real.rs'])
  const { result: tree, warnings } = captureWarnings(() => buildRustTree(sources))
  const main = tree.resolutions.get('src/main.rs')
  t.assert.equal(main.get('mod real'), 'src/real.rs')
  t.assert.ok(!main.has('mod gone'))
  t.assert.deepEqual(tree.missing, [{ spec: 'mod gone', from: 'src/main.rs' }])
  t.assert.ok(warnings.some((w) => w.includes('Missing module') && w.includes('gone')))
})

test('buildRustTree flags an unconditional #[path] that escapes the bundle root as missing', (t) => {
  const { result: tree } = captureWarnings(() => buildRustTree(new Map([['src/main.rs', '#[path = "../../outside.rs"]\nmod evil;\n']])))
  t.assert.deepEqual(tree.missing, [{ spec: 'mod evil', from: 'src/main.rs' }])
})

test('buildRustTree does not flag a cfg-gated mod with no file as missing', (t) => {
  // #[cfg(feature = "x")] mod extra; with no extra.rs must not fail the bundle.
  const tree = buildRustTree(new Map([['src/lib.rs', '#[cfg(feature = "x")]\nmod extra;\npub fn f() {}\n']]))
  t.assert.deepEqual(tree.missing, [])
  t.assert.equal(tree.resolutions.get('src/lib.rs').size, 0)
})

test('buildRustTree flags an unconditional mod under a non-gating cfg_attr as missing, and one under not(test) too', (t) => {
  const { result: tree } = captureWarnings(() => buildRustTree(new Map([['src/lib.rs', '#[cfg_attr(docsrs, doc(cfg(feature = "x")))]\npub mod gone;\n#[cfg(not(test))]\nmod also_gone;\n']])))
  t.assert.deepEqual(tree.missing, [{ spec: 'mod gone', from: 'src/lib.rs' }, { spec: 'mod also_gone', from: 'src/lib.rs' }])
})

test('buildRustTree skips test/doc-only code: no files, no edges, no dev-dep pull-in', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'cfg-test'), ['src/lib.rs'])
  // maybe.rs sits behind `any(test, feature = "extra")`: `extra` is declared and off, so it is dead too.
  t.assert.deepEqual([...sources.keys()].toSorted(), [
    'src/backend.rs', 'src/lib.rs', 'src/real.rs', 'src/sys/unix.rs', 'src/sys/windows.rs', 'vendor/serde/src/lib.rs',
  ])
  const { result: tree, warnings } = captureWarnings(() => buildRustTree(sources, { roots: ['src/lib.rs'], baseDir: join(fixtures, 'cfg-test') }))
  t.assert.deepEqual(tree.missing, [])
  t.assert.deepEqual(warnings, [])
  t.assert.deepEqual([...tree.unresolvedCrates], []) // proptest/quickcheck are reached from test code only
  const lib = edges(tree.resolutions.get('src/lib.rs'))
  t.assert.deepEqual(lib, {
    'use serde': 'vendor/serde/src/lib.rs',
    'mod real': 'src/real.rs',
    'mod sys': { unix: 'src/sys/unix.rs', windows: 'src/sys/windows.rs' }, // same-name cfg-exclusive declarations, merged
    'mod backend': 'src/backend.rs', // the `test` path variant is dropped
    'real::go': 'src/real.rs',
    'sys::name': { unix: 'src/sys/unix.rs', windows: 'src/sys/windows.rs' },
    'backend::b': 'src/backend.rs',
  })
})

test('buildRustTree does not take a name a file imported for a crate', (t) => {
  // `use std::io; io::stdin()` names no crate `io`; `extern crate alpha as a; a::run()` no crate `a`.
  const sources = new Map([
    ['src/main.rs', 'use std::io;\nuse io::Result;\nextern crate alpha as a;\nfn main() -> Result<()> { a::run(); io::stdin(); Ok(()) }\n'],
    ['vendor/io/src/lib.rs', ''], ['vendor/a/src/lib.rs', ''], ['vendor/alpha/src/lib.rs', ''],
  ])
  const tree = buildRustTree(sources, { roots: ['src/main.rs'] })
  const main = edges(tree.resolutions.get('src/main.rs'))
  t.assert.deepEqual(main, { 'use alpha': 'vendor/alpha/src/lib.rs' })
  t.assert.deepEqual([...tree.unresolvedCrates], [])
})

test('buildRustTree ignores mod declarations inside comments, and a `//` inside a string is not a comment', (t) => {
  const tree = buildRustTree(new Map([
    ['src/main.rs', '/*\nmod blockgone;\n*/\n// mod linegone;\nconst U: &str = "http://x"; mod real;\nfn main() {}\n'],
    ['src/real.rs', ''],
  ]))
  t.assert.deepEqual(tree.missing, [])
  t.assert.equal(tree.resolutions.get('src/main.rs').get('mod real'), 'src/real.rs')
})

test('buildRustTree resolves crate references to in-tree roots and reports the rest in unresolvedCrates', async (t) => {
  const vendored = await collectRustFilesFromDisk(join(fixtures, 'vendored-transitive'), ['src/main.rs'])
  const tree = buildRustTree(vendored, { roots: ['src/main.rs'], baseDir: join(fixtures, 'vendored-transitive') })
  t.assert.equal(tree.resolutions.get('src/main.rs').get('use alpha'), 'vendor/alpha/src/lib.rs')
  t.assert.equal(tree.resolutions.get('src/main.rs').get('use gamma'), 'vendor/gamma/src/lib.rs') // `use gamma;`
  t.assert.equal(tree.resolutions.get('src/main.rs').get('use delta'), 'vendor/delta/src/lib.rs') // `use delta::{self, D};`
  const alpha = edges(tree.resolutions.get('vendor/alpha/src/lib.rs'))
  t.assert.equal(alpha['use beta_lib'], 'vendor/beta-lib/src/lib.rs') // vendored -> vendored
  t.assert.equal(alpha['crate::inner::x'], 'vendor/alpha/src/inner.rs') // a vendored crate's own tree
  t.assert.deepEqual([...tree.unresolvedCrates], ['missing_crate'])

  const none = await collectRustFilesFromDisk(join(fixtures, 'no-vendor'), ['src/main.rs'])
  const { unresolvedCrates } = buildRustTree(none, { roots: ['src/main.rs'], baseDir: join(fixtures, 'no-vendor') })
  t.assert.deepEqual([...unresolvedCrates].toSorted(), ['serde', 'syn']) // not std, not the local module `a`
})

test('buildRustTree without baseDir still resolves vendored crates among the loaded sources', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'with-vendored-crate'), ['src/main.rs'])
  const { resolutions } = buildRustTree(sources)
  t.assert.equal(resolutions.get('src/main.rs').get('use cool_lib'), 'vendor/cool-lib/src/lib.rs')
})

// --- listing ---

test('loadRust reads a .rs.txt listing and walks the crate', async (t) => {
  const tree = await loadRust(join(fixtures, 'listing/list.rs.txt'))
  t.assert.deepEqual([...tree.sources.keys()].toSorted(), ['src/foo.rs', 'src/main.rs'])
  t.assert.equal(tree.resolutions.get('src/main.rs').get('mod foo'), 'src/foo.rs')
})

test('loadRust rejects an empty listing', async (t) => {
  await t.assert.rejects(() => loadRust(join(fixtures, 'listing-empty/list.rs.txt')), /Empty Rust listing/)
})

test('loadRust rejects a listing with non-.rs lines', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-nonrust/list.rs.txt')),
    /must only contain \.rs files/,
  )
})

test('loadRust rejects an entry path that escapes the listing dir', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-escape/list.rs.txt')),
    /Entry path escapes baseDir/,
  )
})

test('loadRust rejects an absolute entry path in the listing', async (t) => {
  await t.assert.rejects(
    () => loadRust(join(fixtures, 'listing-absolute/list.rs.txt')),
    /Entry path must not be absolute/,
  )
})

// --- fifth review: two platform files with the same import, namespaces, cfg precision, order ---

test('buildRustTree follows the same `use log;` in two platform files of one module without looping', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod sys;\n'],
    ['src/sys.rs', '#[cfg(unix)] #[path = "sys/u.rs"] mod imp;\n#[cfg(windows)] #[path = "sys/w.rs"] mod imp;\npub use self::imp::*;\n'],
    ['src/sys/u.rs', 'use log;\npub fn u() { log::info!("u"); }\n'],
    ['src/sys/w.rs', 'use log;\npub fn w() { log::info!("w"); }\n'],
    ['vendor/log/src/lib.rs', ''],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/sys/u.rs')), { 'use log': 'vendor/log/src/lib.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/sys/w.rs')), { 'use log': 'vendor/log/src/lib.rs' })
  // The same through cfg_if! branches both importing the crate.
  const chain = new Map([
    ['src/lib.rs', 'cfg_if! { if #[cfg(unix)] { use libc; mod u; } else { use libc; mod w; } }\n'],
    ['src/u.rs', 'fn f() { libc::getpid(); }\n'],
    ['src/w.rs', ''],
    ['vendor/libc/src/lib.rs', ''],
  ])
  const r = buildRustTree(chain, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(r.resolutions.get('src/u.rs')), { 'use libc': 'vendor/libc/src/lib.rs' })
})

test('buildRustTree resolves a glob written in a platform file beside a glob of its parent', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod sys;\n'],
    ['src/sys.rs', 'mod helpers;\n#[cfg(unix)] #[path = "sys/u.rs"] mod imp;\n#[cfg(windows)] #[path = "sys/w.rs"] mod imp;\npub use self::imp::*;\n'],
    ['src/sys/helpers.rs', 'pub struct Thing;\n'],
    ['src/sys/u.rs', 'use super::*;\npub use helpers::*;\npub fn u() -> helpers::Thing { helpers::Thing }\n'],
    ['src/sys/w.rs', 'pub fn w() {}\n'],
    ['src/user.rs', ''],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/sys/u.rs')), { super: 'src/sys.rs', helpers: 'src/sys/helpers.rs', 'helpers::Thing': 'src/sys/helpers.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/sys/w.rs')), {})
})

test('buildRustTree never lets a value item lead a path: `fn log` and `*const libc::c_char` beside the crates', (t) => {
  const items = scanRustItems('extern "C" { pub fn f(p: *const libc::c_char) -> *mut libc::c_void; }\nfn g(p: *const libc::c_char) {}\nfn log() {}\nstatic S: u8 = 0;\nconst C: u8 = 0;\nstruct T;\nuse log::info;\n')
  t.assert.deepEqual(items.defined.map((d) => [d.name, d.ns]), [['f', 'value'], ['g', 'value'], ['log', 'value'], ['S', 'value'], ['C', 'value'], ['T', 'type']])
  const sources = new Map([
    ['src/lib.rs', 'mod net;\n'],
    ['src/net.rs', 'use libc;\nfn g(p: *const libc::c_char) {}\nfn log() {}\nuse log::info;\n'],
    ['vendor/libc/src/lib.rs', ''],
    ['vendor/log/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/net.rs')), { 'use libc': 'vendor/libc/src/lib.rs', 'use log': 'vendor/log/src/lib.rs' })
  t.assert.deepEqual([...unresolvedCrates], [])
  // A one-segment path may still name the fn (`log()` is `crate::log`).
  const own = buildRustTree(new Map([['src/lib.rs', 'mod net;\nmod user;\n'], ['src/net.rs', 'pub fn log() {}\n'], ['src/user.rs', 'fn f() { crate::net::log(); }\n']]), { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(own.resolutions.get('src/user.rs')), { 'crate::net::log': 'src/net.rs' })
})

test('buildRustTree gives the same answers whatever order the sources come in', (t) => {
  const files = {
    'src/lib.rs': 'mod sys;\nmod user;\n',
    'src/sys.rs': '#[cfg(unix)] #[path = "sys/u.rs"] mod imp;\n#[cfg(windows)] #[path = "sys/w.rs"] mod imp;\npub use self::imp::*;\n',
    'src/sys/u.rs': 'pub struct Thing;\n',
    'src/sys/w.rs': 'pub struct Thing;\n',
    'src/user.rs': 'use crate::sys::Thing;\n',
  }
  const answers = new Set()
  const keys = Object.keys(files)
  for (let i = 0; i < keys.length; i++) {
    const order = [...keys.slice(i), ...keys.slice(0, i)]
    const { resolutions } = buildRustTree(new Map(order.map((k) => [k, files[k]])), { roots: ['src/lib.rs'] })
    answers.add(JSON.stringify([...resolutions].toSorted().map(([f, m]) => [f, edges(m)])))
  }
  t.assert.equal(answers.size, 1)
  const [only] = answers
  t.assert.deepEqual(JSON.parse(only).find(([f]) => f === 'src/user.rs')[1]['crate::sys::Thing'], { unix: 'src/sys/u.rs', windows: 'src/sys/w.rs' }) // each variant, under its cfg
})

test('buildRustTree keeps a file mounted under several cfgs under any of them, and an any(…) branch out of another target_os', (t) => {
  // libc: `mod linux_l4re_shared` in both the linux and the l4re branch; aix's `crate::T` is aix's.
  const sources = new Map([
    ['src/lib.rs', 'cfg_if! { if #[cfg(target_os = "linux")] { mod shared; pub use shared::*; } else if #[cfg(target_os = "l4re")] { mod shared; pub use shared::*; } else if #[cfg(target_os = "aix")] { mod aix; pub use aix::*; mod user_aix; } }\ncfg_if! { if #[cfg(any(target_os = "linux", target_os = "l4re"))] { mod either; pub use either::*; } else if #[cfg(target_os = "aix")] { mod user2; } }\n'],
    ['src/shared.rs', 'pub struct T;\npub struct U;\n'],
    ['src/either.rs', 'pub struct T;\n'],
    ['src/aix.rs', 'pub struct T;\npub struct U;\n'],
    ['src/user_aix.rs', 'fn f() { crate::T; crate::U; }\n'],
    ['src/user2.rs', 'fn f() { crate::T; }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user_aix.rs')), { 'crate::T': 'src/aix.rs', 'crate::U': 'src/aix.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/user2.rs')), { 'crate::T': 'src/aix.rs' })
})

test('buildRustTree keeps a module two glob paths reach under either path\'s cfg', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\nmod shared;\n#[cfg(target_os = "linux")] pub use a::*;\n#[cfg(target_os = "macos")] pub use b::*;\n#[cfg(target_os = "aix")] pub use c::*;\n#[cfg(target_os = "aix")] mod user;\n'],
    ['src/a.rs', 'pub use crate::shared::*;\n'],
    ['src/b.rs', 'pub use crate::shared::*;\n'],
    ['src/c.rs', 'pub struct T;\n'],
    ['src/shared.rs', 'pub struct T;\n'],
    ['src/user.rs', 'fn f() { crate::T; }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::T': 'src/c.rs' })
})

test('buildRustTree checks every hop of an import chain against the asking file\'s cfgs', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod mid;\nmod u;\nmod w;\npub use mid::X;\n#[cfg(unix)] mod user;\n'],
    ['src/mid.rs', '#[cfg(windows)] pub use crate::w::X;\n#[cfg(unix)] pub use crate::u::X;\n'],
    ['src/u.rs', 'pub struct X;\n'],
    ['src/w.rs', 'pub struct X;\n'],
    ['src/user.rs', 'fn f() { crate::X; }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::X': 'src/u.rs' })
})

test('scanRustItems keeps a nested cfg_if! chain apart from the chain around it', (t) => {
  const src = 'cfg_if! { if #[cfg(unix)] { cfg_if! { if #[cfg(target_os = "linux")] { mod l; } else { mod o; } } mod after; } else { mod w; } }\ncfg_if! { if #[cfg(a)] { mod x; } else { mod y; } }\n'
  t.assert.deepEqual(scanRustItems(src).mods.map((m) => [m.name, m.cfg]), [
    ['l', 'all(unix, target_os = "linux")'],
    ['o', 'all(unix, not(target_os = "linux"))'],
    ['after', 'unix'],
    ['w', 'not(unix)'],
    ['x', 'a'],
    ['y', 'not(a)'],
  ])
})

test('buildRustTree shadows macros in source order: a #[macro_use] mod and the file\'s own definitions alike', (t) => {
  const first = new Map([
    ['src/lib.rs', 'macro_rules! tri { () => {} }\n#[macro_use]\nmod macros;\nmod user;\n'],
    ['src/macros.rs', 'macro_rules! tri { () => {} }\n'],
    ['src/user.rs', 'fn f() { tri!(); }\n'],
  ])
  t.assert.deepEqual(edges(buildRustTree(first, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs')), { 'tri!': 'src/macros.rs' })
  const second = new Map([...first, ['src/lib.rs', '#[macro_use]\nmod macros;\nmacro_rules! tri { () => {} }\nmod user;\n']])
  t.assert.deepEqual(edges(buildRustTree(second, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs')), { 'tri!': 'src/lib.rs' })
})

test('buildRustTree puts what a macro_rules! template declares where the macro is invoked', (t) => {
  // serde: `crate_root! { … macro_rules! tri { … } … pub mod de; … }` invoked in lib.rs after `#[macro_use] mod m;`.
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod m;\nmod before;\nmacro_rules! root { () => { macro_rules! tri { () => {} } mod de; } }\nroot!();\nmod later;\n'],
    ['src/m.rs', 'macro_rules! tri { () => {} }\n'],
    ['src/before.rs', 'fn f() { tri!(); }\n'],
    ['src/de.rs', 'fn f() { tri!(); }\n'],
    ['src/later.rs', 'fn f() { tri!(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/before.rs')), { 'tri!': 'src/m.rs' }) // mounted before the invocation
  t.assert.deepEqual(edges(resolutions.get('src/de.rs')), { 'tri!': 'src/lib.rs' }) // `tri` stands before `mod de` in the template
  t.assert.deepEqual(edges(resolutions.get('src/later.rs')), { 'tri!': 'src/lib.rs' })
  const items = scanRustItems(sources.get('src/lib.rs'))
  const call = sources.get('src/lib.rs').indexOf('root!()')
  t.assert.deepEqual(items.mods.filter((m) => m.name === 'de').map((m) => [m.template, m.offset === call]), [['root', true]])
  t.assert.deepEqual(items.macros.map((m) => [m.name, m.template, m.offset === call]), [['root', null, false], ['tri', 'root', true]])
})

test('buildRustTree takes a one-segment path for an exported macro only at the crate root', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod macros;\nmod child;\npub use anyhow as format_err;\n'],
    ['src/macros.rs', '#[macro_export]\nmacro_rules! anyhow { () => {} }\n'],
    ['src/child.rs', 'use anyhow;\nuse crate::anyhow as also;\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'mod macros': 'src/macros.rs', 'mod child': 'src/child.rs', anyhow: 'src/macros.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/child.rs')), { 'crate::anyhow': 'src/macros.rs' }) // `use anyhow;` in a child names the crate
  t.assert.deepEqual([...unresolvedCrates], ['anyhow'])
})

test('buildRustTree lets a glob into an in-tree crate explain the names of the module it names there', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'use tokio::sync::*;\nuse mpsc::channel;\nuse nothere::x;\nmod deep;\n'],
    ['src/deep.rs', 'use tokio::*;\nuse oneshot::Sender;\n'], // through tokio's root's own glob
    ['vendor/tokio/src/lib.rs', 'pub mod sync;\npub use sync::*;\n'],
    ['vendor/tokio/src/sync/mod.rs', 'pub mod mpsc;\npub use inner::*;\nmod inner;\n'],
    ['vendor/tokio/src/sync/mpsc.rs', 'pub fn channel() {}\n'],
    ['vendor/tokio/src/sync/inner.rs', 'pub mod oneshot;\n'],
    ['vendor/tokio/src/sync/inner/oneshot.rs', 'pub struct Sender;\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'use tokio': 'vendor/tokio/src/lib.rs', 'mod deep': 'src/deep.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/deep.rs')), { 'use tokio': 'vendor/tokio/src/lib.rs' })
  t.assert.deepEqual([...unresolvedCrates], ['nothere'])
})

test('buildRustTree reads a quote!-family body as macro input throughout a package that defines the macro itself', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod m;\nmod a;\nmod user;\n'],
    ['src/m.rs', 'macro_rules! quote { ($($t:tt)*) => {} }\n'],
    ['src/a.rs', 'pub fn b() {}\n'],
    ['src/user.rs', 'fn f() { quote! { crate::a::b() } }\n'],
    ['vendor/other/src/lib.rs', 'fn g() { quote! { crate::a::b() } }\n'], // another package: a template, skipped
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs', 'vendor/other/src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::a::b': 'src/a.rs', 'quote!': 'src/m.rs' })
  t.assert.deepEqual(edges(resolutions.get('vendor/other/src/lib.rs')), {})
  t.assert.deepEqual([...scanRustItems(sources.get('src/user.rs')).skipped], ['quote'])
})

// --- sixth review: unknown gates, cycles' cached answers, imported values, reached-again modules ---

test('buildRustTree reads a #[cfg] on a macro invocation as gating its body, and a cfg_<x>! body as a gate of its own', (t) => {
  const items = scanRustItems('#[cfg(any(unix, target_os = "hermit"))]\ncfg_os_poll! {\n    mod unix;\n    pub use self::unix::*;\n}\n#[cfg(windows)]\ncfg_os_poll! {\n    mod windows;\n}\ncfg_not_os_poll! {\n    mod shell;\n    pub(crate) use self::shell::*;\n}\n#[cfg(feature = "x")]\nmacro_rules! m { () => { mod inner; } }\n')
  t.assert.deepEqual(items.mods.map((m) => [m.name, m.cfg, m.macro]), [['unix', 'any(unix, target_os = "hermit")', 'cfg_os_poll'], ['windows', 'windows', 'cfg_os_poll'], ['shell', null, 'cfg_not_os_poll'], ['inner', null, 'macro_rules']])
  t.assert.deepEqual(items.imports.map((im) => [im.segments.join('::'), im.cfg, im.macro]), [['self::unix', 'any(unix, target_os = "hermit")', 'cfg_os_poll'], ['self::shell', null, 'cfg_not_os_poll']])
  // mio: a unix waker's `crate::sys::Selector` is its own platform's selector, not the windows
  // one (whose `#[cfg(windows)]` sits on the `cfg_os_poll!` invocation) nor the shell one (under
  // `cfg_not_os_poll!`, whose definition wraps items in the negation of the waker's gate).
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\nmod sys;\n'],
    ['src/macros.rs', 'macro_rules! cfg_os_poll { ($($i:item)*) => { $( #[cfg(feature = "os-poll")] $i )* } }\nmacro_rules! cfg_not_os_poll { ($($i:item)*) => { $( #[cfg(not(feature = "os-poll"))] $i )* } }\n'],
    ['src/sys/mod.rs', '#[cfg(any(unix, target_os = "hermit"))]\ncfg_os_poll! {\n    mod unix;\n    pub use self::unix::*;\n}\n#[cfg(windows)]\ncfg_os_poll! {\n    mod windows;\n    pub use self::windows::*;\n}\ncfg_not_os_poll! {\n    mod shell;\n    pub(crate) use self::shell::*;\n}\n'],
    ['src/sys/unix/mod.rs', 'cfg_os_poll! {\n    #[cfg_attr(target_os = "linux", path = "selector/epoll.rs")]\n    #[cfg_attr(target_os = "macos", path = "selector/kqueue.rs")]\n    mod selector;\n    pub(crate) use self::selector::*;\n    #[cfg_attr(target_os = "linux", path = "waker/eventfd.rs")]\n    #[cfg_attr(target_os = "macos", path = "waker/kqueue.rs")]\n    mod waker;\n    pub(crate) use self::waker::Waker;\n}\n'],
    ['src/sys/unix/selector/epoll.rs', 'pub struct Selector;\n'],
    ['src/sys/unix/selector/kqueue.rs', 'pub struct Selector;\n'],
    ['src/sys/unix/waker/eventfd.rs', 'use crate::sys::Selector;\npub struct Waker;\n'],
    ['src/sys/unix/waker/kqueue.rs', 'use crate::sys::Selector;\npub struct Waker;\n'],
    ['src/sys/windows/mod.rs', 'mod selector;\npub use selector::Selector;\n'],
    ['src/sys/windows/selector.rs', 'pub struct Selector;\n'],
    ['src/sys/shell/mod.rs', 'mod selector;\nmod waker;\npub use self::selector::Selector;\n'],
    ['src/sys/shell/selector.rs', 'pub struct Selector;\n'],
    ['src/sys/shell/waker.rs', 'use crate::sys::Selector;\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.equal(edges(resolutions.get('src/sys/unix/waker/eventfd.rs'))['crate::sys::Selector'], 'src/sys/unix/selector/epoll.rs')
  t.assert.equal(edges(resolutions.get('src/sys/unix/waker/kqueue.rs'))['crate::sys::Selector'], 'src/sys/unix/selector/kqueue.rs')
  t.assert.equal(edges(resolutions.get('src/sys/shell/waker.rs'))['crate::sys::Selector'], 'src/sys/shell/selector.rs')
})

test('buildRustTree drops the answers imports gave on top of a short closure when the cycle is resolved', (t) => {
  // A1 through a named import at the root: `pub use child::run;` asked first, while child's glob
  // closure was still short of the cycle through b.
  const sources = new Map([
    ['src/lib.rs', 'mod child;\nmod b;\nmod c;\npub use child::run;\nmod user;\n'],
    ['src/child.rs', 'pub use crate::b::*;\npub use crate::c::*;\n'],
    ['src/b.rs', 'pub use crate::child::inner::*;\n'],
    ['src/c.rs', 'pub mod inner { pub fn run() {} }\n'],
    ['src/user.rs', 'fn f() { crate::run(); crate::child::run(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::run': 'src/c.rs', 'crate::child::run': 'src/c.rs', 'crate::child': 'src/child.rs' })
})

test('buildRustTree lets a name imported as a value still lead a path to the crate of that name', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod util;\nmod user;\n'],
    ['src/util.rs', 'pub fn log() {}\npub static TABLE: u8 = 0;\npub mod real { pub struct Formatter; }\n'],
    ['src/user.rs', 'use crate::util::log;\nuse crate::util::TABLE;\nuse crate::util::real as fmt;\nfn f() { log::info!("x"); log(); fmt::Formatter; }\n'],
    ['vendor/log/src/lib.rs', ''],
  ])
  const { resolutions, unresolvedCrates, wantedRoots } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::util::log': 'src/util.rs', 'crate::util::TABLE': 'src/util.rs', 'crate::util::real': 'src/util.rs', 'use log': 'vendor/log/src/lib.rs', 'fmt::Formatter': 'src/util.rs' })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(wantedRoots, [])
  // The crate's root not among the sources (the walk took `log` for the fn): asked for.
  const without = new Map([...sources].filter(([f]) => f !== 'vendor/log/src/lib.rs'))
  const r = buildRustTree(without, { roots: ['src/lib.rs'], baseDir: join(fixtures, 'use-crate') })
  t.assert.deepEqual(edges(r.resolutions.get('src/user.rs'))['use log'], undefined)
})

test('buildRustTree walks on from a module a second glob path reaches under another cfg', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod mid;\nmod deep;\n#[cfg(target_os = "linux")] pub use a::*;\n#[cfg(target_os = "aix")] pub use b::*;\n#[cfg(target_os = "aix")] mod user;\n'],
    ['src/a.rs', 'pub use crate::mid::*;\n'],
    ['src/b.rs', 'pub use crate::mid::*;\n'],
    ['src/mid.rs', 'pub use crate::deep::*;\n'],
    ['src/deep.rs', 'pub struct T;\n'],
    ['src/user.rs', 'fn f() { crate::T; }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  // deep is reached through mid under linux first, then under aix: under either, so the aix user finds T there.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::T': 'src/deep.rs' })
})

test('buildRustTree puts a mod a template declares at the invocation in another file, for textual macro scope', (t) => {
  // serde: core/crate_root.rs's `crate_root! { … pub mod de; … }` is invoked in lib.rs after
  // `#[macro_use] mod macros;`, so de sees `forward_to_deserialize_any!` -- and is lib.rs's
  // module, found beside lib.rs (src/de.rs), not beside crate_root.rs (src/core/de.rs).
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\n#[path = "core/crate_root.rs"]\nmod crate_root;\n#[macro_use]\n#[path = "core/macros.rs"]\nmod macros;\ncrate_root!();\n'],
    ['src/core/crate_root.rs', 'macro_rules! crate_root { () => { pub mod de; } }\n'],
    ['src/core/macros.rs', 'macro_rules! forward_to_deserialize_any { () => {} }\n'],
    ['src/de.rs', 'fn f() { forward_to_deserialize_any!(); }\n'],
    ['src/core/de.rs', ''],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.equal(resolutions.get('src/lib.rs').get('mod de'), 'src/de.rs')
  t.assert.equal(resolutions.get('src/core/crate_root.rs').get('mod de'), undefined)
  t.assert.deepEqual(edges(resolutions.get('src/de.rs')), { 'forward_to_deserialize_any!': 'src/core/macros.rs' })
})

test('buildRustTree decides a bare macro call\'s scope at the call: a later definition in the file does not shadow it', (t) => {
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod m;\nmod user;\n'],
    ['src/m.rs', 'macro_rules! x { () => {} }\n'],
    ['src/user.rs', 'fn f() { x!(); }\nmacro_rules! x { () => {} }\nfn g() { x!(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'x!': 'src/m.rs' })
  t.assert.deepEqual([...scanRustItems(sources.get('src/user.rs')).calls], [['x', [9, 54]]])
})

test('buildRustTree takes a candidate under a custom cfg only after one under none: `loom` is off in a default build', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod user;\n#[cfg(loom)] pub use a::X;\n#[cfg(not(loom))] pub use b::X;\n#[cfg(any(loom, target_os = "aix"))] pub use a::Y;\n#[cfg(unix)] pub use b::Y;\n'],
    ['src/a.rs', 'pub struct X;\npub struct Y;\n'],
    ['src/b.rs', 'pub struct X;\npub struct Y;\n'],
    ['src/user.rs', 'fn f() { crate::X; crate::Y; }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  // `any(loom, target_os = "aix")` may hold on aix: no target, so a's Y is one of two.
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'crate::X': 'src/b.rs', 'crate::Y': { 'any(loom, target_os = "aix")': 'src/a.rs', unix: 'src/b.rs' } })
})

test('scanRustItems reads the cfg a gate macro\'s definition wraps items in; buildRustTree ranks by it', (t) => {
  const macros = [
    'macro_rules! cfg_rt { ($($item:item)*) => { $( #[cfg(feature = "rt")] #[cfg_attr(docsrs, doc(cfg(feature = "rt")))] $item )* } }',
    'macro_rules! cfg_not_rt { ($($item:item)*) => { $( #[cfg(not(feature = "rt"))] $item )* } }',
    'macro_rules! cfg_both { ($($item:item)*) => { $( #[cfg(unix)] #[cfg(feature = "rt")] $item )* } }',
    'macro_rules! cfg_plain { ($($item:item)*) => { $( $item )* } }', // wraps nothing in a cfg: unreadable
    'macro_rules! cfg_not_plain { ($($item:item)*) => { $( $item )* } }',
  ].join('\n')
  t.assert.deepEqual(scanRustItems(macros).macros.map((m) => [m.name, m.gate]), [
    ['cfg_rt', 'feature = "rt"'], ['cfg_not_rt', 'not(feature = "rt")'], ['cfg_both', 'all(feature = "rt", unix)'], ['cfg_plain', null], ['cfg_not_plain', null],
  ])
  const sources = new Map([
    ['src/lib.rs', `#[macro_use]\nmod macros;\nmod a;\nmod b;\nmod user;\ncfg_rt! { pub use a::X; }\ncfg_not_rt! { pub use b::X; }\ncfg_plain! { pub use a::Y; }\ncfg_not_plain! { pub use b::Y; }\n`],
    ['src/macros.rs', macros],
    ['src/a.rs', 'pub struct X;\npub struct Y;\n'],
    ['src/b.rs', 'pub struct X;\npub struct Y;\n'],
    ['src/user.rs', 'fn f() { crate::X; crate::Y; }\n'],
  ])
  // No features known: either, each under its gate's cfg; `rt` off: `cfg_not_rt!`'s is what the
  // build compiles, and it is taken though written second.
  t.assert.deepEqual(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['crate::X'], { 'feature = "rt"': 'src/a.rs', 'not(feature = "rt")': 'src/b.rs' })
  // A context's features are settled once resolved (builds are interned per context): one each.
  const cargoWith = (features) => ({ packageInfo: () => ({ dir: '.' }), isTestTarget: () => false, isVendored: () => false, featuresFor: () => features, maybeFeaturesFor: () => null, platformOf: () => null, cfgsSetFor: () => null, resolveCrate: () => null, isLibRoot: () => false, unitOfCrate: (_, u) => u })
  t.assert.equal(edges(buildRustTree(sources, { roots: ['src/lib.rs'], cargo: cargoWith(new Set()) }).resolutions.get('src/user.rs'))['crate::X'], 'src/b.rs')
  t.assert.equal(edges(buildRustTree(sources, { roots: ['src/lib.rs'], cargo: cargoWith(new Set(['rt'])) }).resolutions.get('src/user.rs'))['crate::X'], 'src/a.rs')
})

test('buildRustTree takes `cfg_x!` and `cfg_not_x!` for each other\'s negation only when their definitions say so', (t) => {
  // A file under `cfg_x!` asks for a name only `cfg_not_x!`'s body provides: exclusive by name, it
  // was never taken; the definitions say `feature = "x"` and `feature = "y"`, which may hold together.
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\ncfg_x! { mod user; }\ncfg_not_x! { mod b; pub use b::Z; }\n'],
    ['src/macros.rs', 'macro_rules! cfg_x { ($($i:item)*) => { $( #[cfg(feature = "x")] $i )* } }\nmacro_rules! cfg_not_x { ($($i:item)*) => { $( #[cfg(feature = "y")] $i )* } }\n'],
    ['src/b.rs', 'pub struct Z;\n'],
    ['src/user.rs', 'fn f() { crate::Z; }\n'],
  ])
  t.assert.equal(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['crate::Z'], 'src/b.rs')
  // Written as the negation: exclusive, as the two cfgs are -- the path stays on the module it reached.
  sources.set('src/macros.rs', 'macro_rules! cfg_x { ($($i:item)*) => { $( #[cfg(feature = "x")] $i )* } }\nmacro_rules! cfg_not_x { ($($i:item)*) => { $( #[cfg(not(feature = "x"))] $i )* } }\n')
  t.assert.equal(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['crate::Z'], 'src/lib.rs')
})

test('buildRustTree resolves a template\'s bare calls where the macro is invoked, and a recursive arm is no invocation', (t) => {
  // `outer!(a)` in user.rs expands `outer!(b)`, then `inner!()`: both resolved in user.rs's scope
  // at that call, where m2's `inner` is in scope -- not in m1.rs, where the template is written.
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod m1;\n#[macro_use]\nmod m2;\nmod user;\n'],
    ['src/m1.rs', 'macro_rules! outer { (a) => { outer!(b); }; (b) => { inner!(); }; }\n'],
    ['src/m2.rs', 'macro_rules! inner { () => {}; }\n'],
    ['src/user.rs', 'fn f() { outer!(a); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'outer!': 'src/m1.rs', 'inner!': 'src/m2.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/m1.rs')), {})
  // What a template emits stands at the file's real invocation, not at a recursive arm's call
  // inside the definition: `made` is in scope in late.rs, not in early.rs.
  const made = new Map([
    ['src/lib.rs', 'macro_rules! make { () => { make!(@go); }; (@go) => { macro_rules! made { () => {} } }; }\nmod early;\nmake!();\nmod late;\n'],
    ['src/early.rs', 'fn f() { made!(); }\n'],
    ['src/late.rs', 'fn f() { made!(); }\n'],
  ])
  const tree = buildRustTree(made, { roots: ['src/lib.rs'] }).resolutions
  t.assert.deepEqual([edges(tree.get('src/early.rs'))['made!'], edges(tree.get('src/late.rs'))['made!']], [undefined, 'src/lib.rs'])
})

test('buildRustTree resolves a template\'s mod beside the files invoking the macro, else beside its definition', (t) => {
  // lib.rs defines `decl!`, a.rs invokes it: `mod gm1` is a's (src/a/gm1.rs), and what `use
  // a::*;` brings the root. `lone!` is invoked nowhere by bare name (`crate::lone!()` only): its
  // `mod solo;` stays beside the definition.
  const sources = new Map([
    ['src/lib.rs', '#[macro_export]\nmacro_rules! lone { () => { mod solo; } }\nmacro_rules! decl { () => { pub mod gm1; } }\nmod a;\nuse a::*;\nuse gm1::X;\ncrate::lone!();\n'],
    ['src/a.rs', 'decl!();\n'],
    ['src/a/gm1.rs', 'pub struct X;\n'],
    ['src/gm1.rs', ''],
    ['src/solo.rs', ''],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/a.rs')), { 'decl!': 'src/lib.rs', 'mod gm1': 'src/a/gm1.rs' })
  t.assert.equal(resolutions.get('src/lib.rs').get('gm1::X'), 'src/a/gm1.rs')
  t.assert.equal(resolutions.get('src/lib.rs').get('mod gm1'), undefined)
  t.assert.equal(resolutions.get('src/lib.rs').get('mod solo'), 'src/solo.rs')
})

test('buildRustTree lets a child module under a custom cfg give way to an import of its name, but not for an asker under that cfg', (t) => {
  // serde: `mod de` only under docsrs (its crate_root.rs), `pub use serde_core::de` otherwise.
  const sources = new Map([
    ['src/lib.rs', '#[cfg(docsrs)]\npub mod de;\n#[cfg(not(docsrs))]\npub use serde_core::de;\nmod private;\n#[cfg(docsrs)]\nmod docs;\n'],
    ['src/de.rs', 'pub trait Error {}\n'],
    ['src/private.rs', 'use crate::de::Error;\n'],
    ['src/docs.rs', 'use crate::de::Error;\n'],
    ['vendor/serde_core/src/lib.rs', 'pub mod de { pub trait Error {} }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/private.rs')), { 'use serde_core': 'vendor/serde_core/src/lib.rs' })
  t.assert.deepEqual(edges(resolutions.get('src/docs.rs')), { 'crate::de::Error': 'src/de.rs' })
})

test('buildRustTree ranks a module\'s own items with its imports, one leading out of the bundle included', (t) => {
  const gate = (name, cfg) => `macro_rules! ${name} {\n    ($($item:item)*) => {\n        $(\n            #[cfg(${cfg})]\n            $item\n        )*\n    }\n}\n`
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\nmod atomic_u64;\nmod trace;\nmod user;\n'],
    ['src/macros.rs', gate('cfg_has_atomic_u64', 'target_has_atomic = "64"') + gate('cfg_not_has_atomic_u64', 'not(target_has_atomic = "64")') + gate('cfg_taskdump', 'test') + gate('cfg_not_taskdump', 'not(test)')],
    // tokio: std's `AtomicU64` re-exported in one variant file, a mutex-based one defined in the other.
    ['src/atomic_u64.rs', 'cfg_has_atomic_u64! {\n    #[path = "native.rs"]\n    mod imp;\n}\ncfg_not_has_atomic_u64! {\n    #[path = "as_mutex.rs"]\n    mod imp;\n}\npub(crate) use imp::AtomicU64;\n'],
    ['src/native.rs', 'pub(crate) use std::sync::atomic::{AtomicU64, Ordering};\n'],
    ['src/as_mutex.rs', 'pub(crate) struct AtomicU64;\n'],
    // tokio's `mod trace`: an import under a gate that is off (`taskdump`; here `test`), the fn
    // defined under its negation.
    ['src/trace.rs', 'cfg_taskdump! {\n    pub(crate) use crate::user::trace_leaf;\n}\ncfg_not_taskdump! {\n    pub(crate) fn trace_leaf() {}\n}\n'],
    ['src/user.rs', 'use crate::atomic_u64::AtomicU64;\npub(crate) fn trace_leaf() {}\nfn f() { crate::trace::trace_leaf(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), {
    'crate::atomic_u64::AtomicU64': { 'target_has_atomic = "64"': 'src/native.rs', 'not(target_has_atomic = "64")': 'src/as_mutex.rs' },
    'crate::trace::trace_leaf': 'src/trace.rs',
    'crate::atomic_u64': 'src/atomic_u64.rs',
  })
})

test('buildRustTree reads `extern crate self as x;` as the crate root from every module: no crate `x` to report', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'extern crate self as gm1;\nmod b;\npub struct X;\n'],
    ['src/b.rs', 'use gm1::X;\nmod inner { use gm1::X; }\n'],
  ])
  const { resolutions, unresolvedCrates } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual([...unresolvedCrates], [])
  t.assert.deepEqual(edges(resolutions.get('src/b.rs')), { 'gm1::X': 'src/lib.rs' })
})

test('buildRustTree places a template\'s mod at an invocation in its own crate, never in another crate\'s file', (t) => {
  // Only the app invokes `a`'s `decl!`, with a `helper` of its own in scope: the `x` resolved
  // beside a's lib.rs is still `a`'s module, where `a`'s helper is in scope -- not one standing in
  // the app's file.
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nextern crate a;\nmacro_rules! helper { () => {} }\ndecl!();\n'],
    ['vendor/a/src/lib.rs', 'macro_rules! helper { () => {} }\n#[macro_export]\nmacro_rules! decl { () => { mod x; } }\n'],
    ['vendor/a/src/x.rs', 'fn f() { helper!(); }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.equal(edges(resolutions.get('vendor/a/src/x.rs'))['helper!'], 'vendor/a/src/lib.rs')
})

// --- eighth review: nested macro_rules!, glob-provided names against local ones, cfg strings ---

test('buildRustTree keeps a template\'s calls and includes with the template when it defines a macro_rules! of its own', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'macro_rules! helper { () => {} }\nmacro_rules! outer { () => { macro_rules! inner { () => {} } fn f() -> &\'static str { helper!(); include_str!("data.txt") } } }\nmod user;\n'],
    ['src/user.rs', 'outer!();\n'],
    ['src/data.txt', 'x'],
  ])
  const items = scanRustItems(sources.get('src/lib.rs'))
  t.assert.deepEqual(items.macros.map((m) => [m.name, m.includes.map((i) => i.path), [...m.calls]]), [['helper', [], []], ['outer', ['data.txt'], ['helper', 'include_str']], ['inner', [], []]])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.deepEqual(edges(resolutions.get('src/user.rs')), { 'outer!': 'src/lib.rs', 'include_str data.txt': 'src/data.txt', 'helper!': 'src/lib.rs' })
})

test('buildRustTree lets a local module under a custom cfg give way to a glob or a binding of the module, as a doubtful candidate does', (t) => {
  const base = [
    ['src/lib.rs', 'mod other;\n#[cfg(docsrs)]\nmod util;\nuse other::*;\nfn f() { util::g(); }\n'],
    ['src/other.rs', 'pub mod util;\n'],
    ['src/other/util.rs', 'pub fn g() {}\n'],
    ['src/util.rs', 'pub fn g() {}\n'],
  ]
  const r = (sources) => edges(buildRustTree(new Map(sources), { roots: ['src/lib.rs'] }).resolutions.get('src/lib.rs'))['util::g']
  // a default build has no `mod util`: the glob's `util` is the name (rustc builds it with the glob's)
  t.assert.equal(r(base), 'src/other/util.rs')
  t.assert.equal(r(base.filter(([f]) => f !== 'src/other.rs' && f !== 'src/other/util.rs').concat([['src/other.rs', '']])), 'src/util.rs') // nothing else of the name: the module
  // serde: the docsrs-only module beside the `pub use` of every other build.
  t.assert.equal(r([...base, ['src/lib.rs', 'mod other;\n#[cfg(docsrs)]\nmod util;\n#[cfg(not(docsrs))]\nuse other::util;\nfn f() { util::g(); }\n']]), 'src/other/util.rs')
})

test('buildRustTree looks a macro call up among macros: a fn or module of the name is no `m!`', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod macros;\nmod user;\nmod m {}\n'],
    ['src/macros.rs', 'macro_rules! m { () => {} }\npub(crate) use m;\n'],
    ['src/user.rs', 'use crate::macros::*;\nfn m() {}\nfn f() { m!(); }\n'],
  ])
  t.assert.equal(edges(buildRustTree(sources, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['m!'], 'src/macros.rs')
  const viaRoot = new Map([...sources, ['src/user.rs', 'use crate::*;\nfn f() { m!(); }\n'], ['src/lib.rs', 'mod macros;\nmod user;\nmod m {}\npub(crate) use macros::*;\n']])
  t.assert.equal(edges(buildRustTree(viaRoot, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['m!'], 'src/macros.rs')
  const besideModule = new Map([...sources, ['src/user.rs', 'use crate::macros::*;\nmod m;\nfn f() { m!(); }\n'], ['src/user/m.rs', '']])
  t.assert.equal(edges(buildRustTree(besideModule, { roots: ['src/lib.rs'] }).resolutions.get('src/user.rs'))['m!'], 'src/macros.rs')
})

test('evalCfg and buildRustTree keep cfg values that differ only in spaces apart', (t) => {
  t.assert.equal(evalCfg('all(my = "a b", not(my = "ab"))'), null)
  t.assert.equal(evalCfg('all(my = "a  b", not(my = "a b"))'), null)
  t.assert.equal(evalCfg('all(my="a b", not(my = "a b"))'), false) // the same leaf, spaced differently
  for (const cfg of ['all(my = "a b", not(my = "ab"))', 'all(my = "a  b", not(my = "a b"))']) {
    const { resolutions } = buildRustTree(new Map([['src/lib.rs', `#[cfg(${cfg})]\nmod x;\n`], ['src/x.rs', '']]), { roots: ['src/lib.rs'] })
    t.assert.deepEqual(edges(resolutions.get('src/lib.rs')), { 'mod x': 'src/x.rs' })
  }
})

// --- tenth review: macros of other crates, nested templates ---

test('buildRustTree gives a macro of another crate an edge, through an import, an alias, a path and #[macro_use] extern crate', (t) => {
  const sources = new Map([
    ['src/lib.rs', 'mod a;\nmod b;\nmod c;\nmod prelude;\nuse prelude::*;\nfn f() { pm!(); }\n'],
    ['src/a.rs', 'use dep::mac;\nfn f() { mac!(); }\n'],
    ['src/b.rs', 'use dep::other as o;\nfn f() { o!(); }\n'],
    ['src/c.rs', 'fn f() { dep::other!(); }\n'],
    ['src/prelude.rs', 'pub use dep::mac as pm;\n'],
    ['tool/main.rs', '#[macro_use]\nextern crate dep;\nfn main() { other!(); }\n'],
    ['vendor/dep/src/lib.rs', '#[macro_use]\nmod macros;\n#[macro_export]\nmacro_rules! mac { () => {} }\n'],
    ['vendor/dep/src/macros.rs', '#[macro_export]\nmacro_rules! other { () => {} }\n'],
  ])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs', 'tool/main.rs'] })
  t.assert.equal(resolutions.get('src/a.rs').get('mac!'), 'vendor/dep/src/lib.rs')
  t.assert.equal(resolutions.get('src/b.rs').get('o!'), 'vendor/dep/src/macros.rs') // the macro the alias names, in the file defining it
  t.assert.equal(resolutions.get('src/c.rs').get('dep::other!'), 'vendor/dep/src/macros.rs')
  t.assert.equal(resolutions.get('src/lib.rs').get('pm!'), 'vendor/dep/src/lib.rs') // through the prelude glob
  t.assert.equal(resolutions.get('tool/main.rs').get('other!'), 'vendor/dep/src/macros.rs')
})

test('buildRustTree resolves an include in a nested macro_rules! where that macro is invoked, not where the outer one is', (t) => {
  const nested = 'macro_rules! outer { () => { macro_rules! inner { () => { include_str!("data.txt") } } } }\n'
  const sources = new Map([
    ['src/lib.rs', '#[macro_use]\nmod macros;\nouter!();\npub mod sub;\n'],
    ['src/macros.rs', nested],
    ['src/sub/mod.rs', 'pub mod user;\n'],
    ['src/sub/user.rs', 'pub fn f() -> &\'static str { inner!() }\n'],
    ['src/sub/data.txt', 'sub'],
    ['src/data.txt', 'a decoy rustc never reads'],
  ])
  const items = scanRustItems(nested)
  t.assert.deepEqual(items.macros.map((m) => [m.name, m.includes.map((i) => i.path)]), [['outer', []], ['inner', ['data.txt']]])
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.equal(resolutions.get('src/sub/user.rs').get('include_str data.txt'), 'src/sub/data.txt')
  t.assert.equal(resolutions.get('src/lib.rs').get('include_str data.txt'), undefined)
})

test('buildRustTree resolves through a dense cycle of cfg-gated globs in time: each module globbing every other', (t) => {
  // every path through the cycle a distinct `any(…)` of cfgs: kept to the ones that tell anything apart
  const N = 6
  const sources = new Map([['src/lib.rs', `${Array.from({ length: N }, (_, k) => `pub mod m${k};\n`).join('')}${Array.from({ length: N * N }, (_, i) => `pub use crate::m${Math.floor(i / N)}::item${i % N} as u${i};\n`).join('')}`]])
  for (let k = 0; k < N; k++) sources.set(`src/m${k}.rs`, `${Array.from({ length: N }, (_, j) => (j === k ? '' : `#[cfg(feature = "f${k}_${j}")]\npub use crate::m${j}::*;\n`)).join('')}pub fn item${k}() {}\n`)
  const started = performance.now()
  const { resolutions } = buildRustTree(sources, { roots: ['src/lib.rs'] })
  t.assert.ok(performance.now() - started < 10_000, `${Math.round(performance.now() - started)} ms`)
  t.assert.equal(resolutions.get('src/lib.rs').get('crate::m0::item0'), 'src/m0.rs')
})
