import semver from './apis/npm/semver.cjs'

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
export function isCorrectedFile(name, version, rel) {
  for (const { name: pkg, files, range } of CORRECTIONS) {
    if (pkg !== name || !files.has(rel)) continue
    if (semver.valid(version) && semver.satisfies(version, range)) return true
  }
  return false
}
