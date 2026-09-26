import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCargoContext, parseCargoManifest } from '../stasis/src/loaders/cargo.js'
import {
  buildModuleTrees,
  buildRustTree,
  collectRustFilesFromDisk,
  crateRoots,
  evalCfg,
  getModuleDir,
  lexRust,
  loadRust,
  parseUseTree,
  resolveExplicitModPath,
  resolveModDecl,
  resolveModPath,
  resolveUsePath,
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

test('scanRustItems records an external mod declared inside inline modules with its inline path', (t) => {
  const { mods } = scanRustItems('mod outer {\n    pub mod inner;\n    mod deep {\n        mod leaf;\n    }\n}\nmod top;\n')
  t.assert.deepEqual(mods.map((m) => [m.name, m.inlinePath]), [['inner', ['outer']], ['leaf', ['outer', 'deep']], ['top', []]])
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
    ['imp', null, true],
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
  // A variant whose predicate can't hold in the build never reaches the resolver: the scanner drops it.
  const src = '#[cfg_attr(unix, path = "sys/unix.rs")]\n#[cfg_attr(test, path = "sys/mock.rs")]\nmod sys;\n'
  t.assert.deepEqual(scanRustItems(src).mods[0].paths, [{ path: 'sys/unix.rs', cfg: 'unix' }])
  t.assert.deepEqual(scanRustItems(src, { test: true }).mods[0].paths, [{ path: 'sys/unix.rs', cfg: 'unix' }, { path: 'sys/mock.rs', cfg: 'test' }])
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
  t.assert.deepEqual(m.package, { name: 'my-app', version: null, versionFromWorkspace: true, edition: '2021' })
  t.assert.deepEqual(m.lib, { name: 'myapp_lib', path: 'src/the_lib.rs' })
  const dep = (k) => {
    const d = m.deps.get(k)
    return { path: d.path, package: d.package, workspace: d.workspace, kinds: [...d.kinds.keys()].toSorted() }
  }
  t.assert.deepEqual([...m.deps.keys()].toSorted(), ['inline_sub', 'nix', 'serde', 'shared', 'tempfile', 'tools', 'util'])
  t.assert.deepEqual(dep('inline_sub'), { path: '../sub', package: null, workspace: false, kinds: ['normal'] })
  t.assert.deepEqual(dep('nix'), { path: '../nix', package: null, workspace: false, kinds: ['normal'] })
  t.assert.deepEqual(dep('serde'), { path: null, package: null, workspace: false, kinds: ['normal'] })
  t.assert.deepEqual(dep('shared'), { path: null, package: null, workspace: true, kinds: ['normal'] })
  t.assert.deepEqual(dep('tempfile'), { path: null, package: null, workspace: false, kinds: ['dev'] })
  t.assert.deepEqual(dep('tools'), { path: '../tools', package: 'dev-tools', workspace: false, kinds: ['normal'] })
  t.assert.equal(m.isWorkspace, true)
  t.assert.equal(m.workspacePackage.version, '0.9.0')
  t.assert.deepEqual([...m.workspaceDeps.keys()], ['shared'])
  t.assert.equal(m.workspaceDeps.get('shared').path, 'crates/shared')
})

test('parseCargoManifest returns no package without a name', (t) => {
  t.assert.equal(parseCargoManifest('[workspace]\nmembers = ["a"]\n').package, null)
  t.assert.equal(parseCargoManifest('[package]\nversion = "1.0.0"\n').package, null)
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
  t.assert.deepEqual(files.get('src/foo/bar.rs'), { root: 'src/main.rs', modulePath: 'crate::foo::bar' })
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

test('resolveUsePath resolves to the deepest matching module', (t) => {
  const tree = new Map([
    ['crate', 'src/main.rs'],
    ['crate::foo', 'src/foo.rs'],
  ])
  // crate::foo::Greeter -> the foo module (Greeter is an item, not a module)
  t.assert.equal(resolveUsePath('crate::foo::Greeter', tree), 'src/foo.rs')
  t.assert.equal(resolveUsePath('crate::missing::Thing', tree), 'src/main.rs')
})

// --- tree ---

test('buildRustTree records mod edges and crate:: use edges', async (t) => {
  const sources = await collectRustFilesFromDisk(join(fixtures, 'use-crate'), ['src/main.rs'])
  const tree = buildRustTree(sources)
  t.assert.deepEqual(Object.keys(tree).toSorted(), ['missing', 'resolutions', 'sources', 'unresolvedCrates'])
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
    'sys::name': 'src/sys/unix.rs',
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
