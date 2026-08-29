import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Next.js convention-entry discovery + the 'use client' boundary check for `stasis bundle
// --nextjs`. Next has no single entry file: the file system IS the entry list (pages/, app/
// special files, middleware, instrumentation), so the static walker enumerates it here. Pure
// name/layout rules -- no Next code is loaded and nothing is parsed.

// Next's default pageExtensions. A custom pageExtensions (mdx etc.) isn't read from the user's
// next.config -- those files need their own toolchain to scan anyway; list them explicitly.
const PAGE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx'])

// app/ router files that become compiler entries; everything else under app/ is reached through
// imports. `default` is the parallel-route fallback; not-found/forbidden/unauthorized are the
// HTTP-access fallbacks and global-error/global-not-found their app-wide twins (Next's
// next-app-loader FILE_TYPES); sitemap/robots/manifest and the icon/image group are the
// code-flavored metadata routes (their static .png/.ico/.txt siblings simply don't match PAGE_EXTS).
const APP_ENTRY_NAMES = new Set([
  'page', 'layout', 'template', 'loading', 'error', 'not-found', 'global-error',
  'global-not-found', 'default', 'route', 'forbidden', 'unauthorized',
  'sitemap', 'robots', 'manifest',
])
// One optional digit exactly, matching Next's metadata-route variantsMatcher: icon1.tsx counts,
// icon12.tsx does not.
const APP_ENTRY_IMAGE = /^(?:icon|apple-icon|opengraph-image|twitter-image)\d?$/u

// Root-level singleton entries, probed at the project root and under src/ (same lookup Next
// does). `proxy` is middleware's newer name. Next matches these against pageExtensions
// (getPossibleMiddlewareFilenames), so the probe list and order mirror PAGE_EXTS -- a
// middleware.tsx counts, a middleware.mjs does not.
const ROOT_ENTRY_NAMES = ['middleware', 'proxy', 'instrumentation', 'instrumentation-client']
const ROOT_ENTRY_EXTS = ['.tsx', '.ts', '.jsx', '.js']

const splitName = (file) => {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? [file, ''] : [file.slice(0, dot), file.slice(dot)]
}

// A .d.ts (or .d.mts/.d.cts) declares types only; Next excludes them from page collection too.
const isDeclaration = (file) => /\.d\.[cm]?ts$/u.test(file)

// Recursively list PAGE_EXTS files under `dirAbs` as posix paths relative to `relBase`.
// Symlinks are skipped (cycle/escape hazard, like every other stasis walk); dot-dirs and
// node_modules never hold routes. `skipUnderscoreDirs` prunes app/'s `_private` folders --
// files under them are opted out of routing, so nothing inside can be an entry.
function walkPages(dirAbs, relBase, { skipUnderscoreDirs }, out) {
  let entries
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return // dir absent -- nothing to discover
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
      if (skipUnderscoreDirs && ent.name.startsWith('_')) continue
      walkPages(join(dirAbs, ent.name), `${relBase}${ent.name}/`, { skipUnderscoreDirs }, out)
      continue
    }
    if (!ent.isFile()) continue
    const [, ext] = splitName(ent.name)
    if (!PAGE_EXTS.has(ext) || isDeclaration(ent.name)) continue
    out.push(`${relBase}${ent.name}`)
  }
}

// Resolve a conventional dir that may live at the root or under src/ (root wins, matching Next,
// which ignores src/<dir> when ./<dir> exists). Returns the project-relative posix prefix or null.
function conventionDir(baseDir, name) {
  for (const rel of [name, `src/${name}`]) {
    try {
      readdirSync(join(baseDir, rel))
      return rel
    } catch {
      // not a readable directory -- try the next location
    }
  }
  return null
}

// Discover the Next.js convention entries under `baseDir`. Returns project-relative posix paths:
// `entries` -- every compiler entry (the bundle's runnable roots), sorted;
// `clientEntries` -- the subset that seeds the CLIENT resolution pass: pages/ routes minus
//   pages/api/** and _document.* (server-only), plus instrumentation-client (browser-run).
//   app/ files are server components until a 'use client' directive says otherwise, so none
//   seed the client pass here -- the resolution passes promote reached directive-carrying
//   files instead (see hasUseClientDirective).
export function discoverNextEntries(baseDir) {
  const entries = []
  const clientEntries = []

  const pagesDir = conventionDir(baseDir, 'pages')
  if (pagesDir) {
    const pages = []
    walkPages(join(baseDir, pagesDir), `${pagesDir}/`, { skipUnderscoreDirs: false }, pages)
    for (const page of pages) {
      entries.push(page)
      const inPages = page.slice(pagesDir.length + 1)
      const [stem] = splitName(inPages)
      // API routes never ship to the browser; _document renders only on the server.
      if (inPages.startsWith('api/') || stem === '_document') continue
      clientEntries.push(page)
    }
  }

  const appDir = conventionDir(baseDir, 'app')
  if (appDir) {
    const files = []
    walkPages(join(baseDir, appDir), `${appDir}/`, { skipUnderscoreDirs: true }, files)
    for (const file of files) {
      const name = file.slice(file.lastIndexOf('/') + 1)
      const [stem] = splitName(name)
      if (APP_ENTRY_NAMES.has(stem) || APP_ENTRY_IMAGE.test(stem)) entries.push(file)
    }
  }

  const isFile = (rel) => {
    try {
      return statSync(join(baseDir, rel)).isFile()
    } catch {
      return false
    }
  }
  for (const name of ROOT_ENTRY_NAMES) {
    for (const prefix of ['', 'src/']) {
      const hit = ROOT_ENTRY_EXTS.map((ext) => `${prefix}${name}${ext}`).find(isFile)
      if (hit) {
        entries.push(hit)
        // instrumentation-client is compiled by the CLIENT compiler (it runs in the browser
        // before hydration), so it seeds the client pass; the other roots resolve server-side.
        if (name === 'instrumentation-client') clientEntries.push(hit)
        break // root beats src/, matching Next's lookup order
      }
    }
  }

  return { entries: entries.toSorted(), clientEntries: clientEntries.toSorted() }
}

// Directive-prologue scan for React's 'use client' boundary marker. The prologue is the leading
// run of string-literal expression statements; whitespace and comments may interleave, and 'use
// client' may follow other directives ('use strict'). No parser: this runs between resolution
// passes over every reached code file, and the prologue grammar is regular enough to scan
// directly. Errs toward true on the absurd corner (`'use client' + x` as the first statement is
// an expression, not a directive) -- over-seeding the client pass only widens the attested set.
export function hasUseClientDirective(source) {
  const s = typeof source === 'string' ? source : source.toString('utf8')
  const len = s.length
  let i = 0
  if (s.charCodeAt(0) === 0xFE_FF) i = 1 // BOM
  if (s.startsWith('#!', i)) {
    const nl = s.indexOf('\n', i)
    if (nl === -1) return false
    i = nl + 1
  }
  // A ';' is consumable only as the terminator of the directive statement just scanned (comments
  // and even line breaks may sit between the closing quote and its ';' -- ExpressionStatement has
  // no restricted production there). A ';' anywhere else is an EmptyStatement, which ends the
  // prologue per the grammar.
  let afterDirective = false
  while (i < len) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === '\u00A0' || c === '\uFEFF') {
      i += 1
    } else if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i)
      if (nl === -1) return false
      i = nl + 1
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end === -1) return false
      i = end + 2
    } else if (c === ';' && afterDirective) {
      afterDirective = false
      i += 1
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let escaped = false
      while (j < len) {
        const d = s[j]
        if (escaped) escaped = false
        else if (d === '\\') escaped = true
        else if (d === c) break
        else if (d === '\n' || d === '\r') return false // unterminated -- not a directive
        j += 1
      }
      if (j >= len) return false
      // Verbatim compare, no escape processing: an escaped spelling ('use\x63lient') is not a
      // directive match for React either.
      if (s.slice(i + 1, j) === 'use client') return true
      i = j + 1
      afterDirective = true
    } else {
      return false // first non-directive token -- prologue over
    }
  }
  return false
}
