import semver from './apis/npm/semver.cjs'

// Manual corrections to audit findings: files that must NOT count as evidence
// that a (potentially vulnerable) package's code is present. A module instance
// whose recorded files are all corrected away is skipped by the audit entirely
// -- none of the package's real code ships, so no advisory can apply to it.
//
// Each entry names a package, the audit-irrelevant files (relative to the module
// dir), and `upTo` -- the latest version VERIFIED to match the rationale. The
// correction never applies past `upTo`: a future release could change the file,
// so the bound is bumped only after re-checking it.
const CORRECTIONS = [
  {
    // ws's browser build is a noop stub -- `module.exports = function () { throw
    // new Error('ws does not work in the browser...') }` -- with none of the
    // WebSocket implementation in it. A bundle carrying only this file contains
    // no ws code. Verified against the ws 8.21.1 tarball (latest at the time of
    // writing); re-check browser.js before bumping.
    name: 'ws',
    files: new Set(['browser.js']),
    upTo: '8.21.1',
  },
]

// Is `rel` (a file path relative to the module dir) audit-irrelevant for
// `name@version`? Unknown or unparsable versions are never corrected (fail
// closed: the package stays audited).
export function isCorrectedFile(name, version, rel) {
  for (const { name: pkg, files, upTo } of CORRECTIONS) {
    if (pkg !== name || !files.has(rel)) continue
    if (semver.valid(version) && semver.lte(version, upTo)) return true
  }
  return false
}
