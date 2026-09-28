import { satisfies, valid } from '@preventive/upstream/semver.js'

// Manual corrections to audit findings: files that must NOT count as evidence
// that a (potentially vulnerable) package's code is present. An import edge whose
// target is one of these files is not evidence the package is really used, so a
// package pulled in only through corrected files is skipped by the audit (see
// collectPackagesFromFile) -- none of its real code ships, so no advisory applies.
//
// Each entry names a package, the audit-irrelevant files (relative to the module
// dir), and `range` -- the semver range VERIFIED to match the rationale. The
// correction never applies outside it: a release could change the file, so the
// range is widened only after re-checking the file in the new versions.
const CORRECTIONS = [
  {
    // ws's browser build is a noop stub -- `module.exports = function () { throw
    // new Error('ws does not work in the browser...') }` -- with none of the
    // WebSocket implementation in it. Verified against the ws 8.21.1 tarball
    // (latest at the time of writing); re-check browser.js before widening.
    name: 'ws',
    files: new Set(['browser.js']),
    range: '<=8.21.1',
  },
  {
    // node-fetch's browser build re-exports the environment's native fetch
    // (`module.exports = globalObject.fetch`, plus Headers/Request/Response) --
    // none of the node-fetch implementation, where its advisories live, is in it.
    // browser.js ships only through 2.7.0 (3.x dropped it); verified 2.6.13/2.7.0.
    name: 'node-fetch',
    files: new Set(['browser.js']),
    range: '<=2.7.0',
  },
]

// Is `rel` (a file path relative to the module dir) audit-irrelevant for
// `name@version`? Unknown or unparsable versions are never corrected (fail
// closed: the package stays audited).
function isCorrectedFile(name, version, rel) {
  for (const { name: pkg, files, range } of CORRECTIONS) {
    if (pkg !== name || !files.has(rel)) continue
    if (valid(version) && satisfies(version, range)) return true
  }
  return false
}

// A `package.json` manifest (top-level or nested) is never code: the resolution
// graph records resolver/metadata reads of them as edges (react-native scans
// sibling packages' manifests for Haste/asset resolution) and consumers record
// them alongside bundled files, but no package code ships through one.
const isManifest = (rel) => rel === 'package.json' || rel.endsWith('/package.json')

// Outside npm a package's real code is its language's sources -- a vendored crate's `.rs`, a
// Composer package's `.php`, a GitHub-hosted Solidity library's `.sol` -- never the manifests and
// configs a bundle carries beside them (Cargo.toml, composer.json, foundry.toml, remappings.txt).
const CODE_FILE = { cargo: /\.rs$/u, composer: /\.php$/u, github: /\.sol$/u }

// Is `rel` evidence that `ecosystem`'s `name@version`'s REAL code is present? This is the one
// rule every audit surface shares -- package presence, the reason column, and the --why chain
// graph all count a file (or an edge targeting it) only when it passes. npm manifests never do,
// nor corrected files within their verified range; elsewhere only source files do.
export function isEvidenceFile(ecosystem, name, version, rel) {
  if (ecosystem !== 'npm') return CODE_FILE[ecosystem]?.test(rel) === true
  return !isManifest(rel) && !isCorrectedFile(name, version, rel)
}

// Ecosystems with an advisory source besides npm: RustSec and Packagist through OSV, and the
// repository's own published advisories for a GitHub-hosted dependency. Soldeer has none.
const AUDITED = new Set(['cargo', 'composer', 'github'])

// The ecosystem a module bucket is audited in, or null for one that is not. npm's are its
// node_modules buckets, tagged or not (artifacts from before the per-bucket `ecosystem` field tag
// none); any other bucket counts only when tagged as a dependency -- an untagged one is
// first-party code, which must not be sent to a public database (leaks names, adds noise).
export function auditedEcosystem(dir, ecosystem = 'npm') {
  if (ecosystem === 'npm') return dir.includes('node_modules') ? 'npm' : null
  return AUDITED.has(ecosystem) ? ecosystem : null
}

// A package's identity across the audit surfaces: `name@version`, prefixed with the ecosystem
// outside npm, so a crate never merges with an npm package of the same name and version.
export const packageKey = (ecosystem, name, version) => `${ecosystem === 'npm' ? '' : `${ecosystem}:`}${name}@${version}`
