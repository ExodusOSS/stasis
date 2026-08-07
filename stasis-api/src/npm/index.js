import assert from 'node:assert/strict'

import { METADATA_TIMEOUT, requestOk } from '../request.js'
import semver from './semver.cjs'

const BULK_ADVISORIES_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

const packageNameRegex = /^(@[\da-z-]+\/)?[\w-]+(\.[\w-]+)*$/u

export async function advisories(list, { signal = AbortSignal.timeout(METADATA_TIMEOUT) } = {}) {
  const groups = new Map()
  for (const { name, version } of list) {
    assert(typeof name === 'string' && typeof version === 'string')
    assert(packageNameRegex.test(name), `Unexpected package name: ${name}`)
    assert(semver.valid(version), `Invalid version: ${version}`)
    if (!groups.has(name)) groups.set(name, new Set())
    groups.get(name).add(version)
  }

  const entries = [...groups].map(([k, v]) => [k, [...v].toSorted((a, b) => semver.compare(a, b))])
  const body = Object.fromEntries(entries.toSorted((a, b) => a[0] < b[0] ? -1 : 1))

  const res = await requestOk('npm advisories', BULK_ADVISORIES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  return res.json()
}
