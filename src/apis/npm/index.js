import assert from 'node:assert/strict'

import semver from './semver.cjs'

const packageNameRegex = /^(@[\da-z-]+\/)?[\w-]+(\.[\w-]+)*$/u

export async function advisories(list) {
  const groups = new Map()
  for (const { name, version } of list) {
    assert(name && version && typeof name === 'string' && typeof version === 'string')
    assert(packageNameRegex.test(name), `Unexpected package name: ${name}`)
    assert(semver.valid(version), `Invalid version: ${version}`)
    if (!groups.has(name)) groups.set(name, new Set())
    groups.get(name).add(version)
  }

  const entries = [...groups].map(([k, v]) => [k, [...v].sort((a, b) => semver.compare(a, b))])
  const body = Object.fromEntries(entries.sort((a, b) => a[0] < b[0] ? -1 : 1))

  const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  assert(res.ok)
  return res.json()
}
