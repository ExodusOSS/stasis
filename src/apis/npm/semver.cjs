'use strict'

const assert = require('node:assert/strict')
const { basename, dirname, resolve } = require('node:path')

let semver

const argv0 = process.argv[0] // not process.argv0 which lacks path

function getSemver() {
  if (semver) return semver

  // Coherence check that we got Node.js path there
  assert(['node', 'node.exe'].includes(basename(argv0)))
  assert.equal(basename(argv0), basename(process.argv0))

  // Load semver from npm bundled with Node.js
  const semverDir = resolve(dirname(argv0), '../lib/node_modules/npm/node_modules/semver')
  semver = require(semverDir)
  return semver
}

exports.compare = (...a) => getSemver().compare(...a)
exports.gtr = (...a) => getSemver().gtr(...a)
exports.lt = (...a) => getSemver().lt(...a)
exports.lte = (...a) => getSemver().lte(...a)
exports.ltr = (...a) => getSemver().ltr(...a)
exports.satisfies = (...a) => getSemver().satisfies(...a)
exports.validRange = (...a) => getSemver().validRange(...a)

exports.valid = (version, options) => {
  // Fast path for certainly valid versions
  if (
    (options === undefined && typeof version === 'string' && version.length <= 256,
    // 1-15 chars because it must fit in Number.MAX_SAFE_INTEGER
    /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/iu.test(version))
  ) {
    return version
  }

  return getSemver().valid(version, options)
}
