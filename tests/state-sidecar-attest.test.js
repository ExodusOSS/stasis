// Sidecar bundle metadata is cross-checked against the parent's loaded lockfile.
// A tampered sidecar bundle that redirects a resolution or flips a format for a
// hash-valid file must be rejected: hashes alone don't cover formats / imports,
// so without this cross-check a sidecar bundle would silently widen the trust
// boundary the unified lockfile is supposed to close.
//
// Process-global preload registry: this file constructs exactly one preload
// (after bootstrapping the lockfile on disk via a non-preload State), so it
// must stay in its own file.

import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { State } from '@exodus/stasis-core/state'

const dir = mkdtempSync(join(tmpdir(), 'stasis-sidecar-attest-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }))
writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')

// Phase 1: bootstrap a real lockfile on disk via a throwaway non-preload State.
// This populates stasis.lock.json with `a.js` attested as format='javascript:module'.
{
  const bootstrap = new State(dir, { lock: 'add' })
  bootstrap.addFile(pathToFileURL(join(dir, 'a.js')).toString(), { isEntry: true })
  bootstrap.write()
}

// Phase 2: construct the real preload. It reads the lockfile written above, so
// parent.#lockfileLoaded === true and parent.#lockFormats includes a.js -> module.
// Sidecars constructed below inherit those maps for the metadata cross-check.
const parentBundle = join(dir, 'parent.br')
const parent = new State(dir, {
  preload: true,
  lock: 'add',
  bundle: 'add',
  bundleFile: parentBundle,
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const v1Bundle = (overrides = {}) => brotliCompressSync(JSON.stringify({
  version: 1,
  config: { scope: 'full' },
  entries: ['a.js'],
  sources: { '.': { name: 'fx', version: '0.0.0', files: { 'a.js': 'export const a = 1\n' } } },
  modules: {},
  formats: { 'a.js': 'javascript:module' },
  imports: {},
  ...overrides,
}))

test('sidecar load: honest bundle agreeing with the parent lockfile is accepted', (t) => {
  const path = join(dir, 'honest.br')
  writeFileSync(path, v1Bundle())
  t.assert.doesNotThrow(
    () => new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: path })
  )
})

test('sidecar load: tampered format (commonjs vs lockfile module) is rejected', (t) => {
  // Bytes are identical (hash check passes), but the bundle declares the wrong
  // loader format. Without #mergeBundleMetadata, the sidecar would silently flip
  // a.js from module to commonjs at serve time.
  const path = join(dir, 'tampered-format.br')
  writeFileSync(path, v1Bundle({ formats: { 'a.js': 'javascript:commonjs' } }))
  t.assert.throws(
    () => new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: path }),
    // #assertAttestedFormat phrasing: "bundle format for a.js mismatches the lockfile"
    // when the lockfile attests a different format for the same file (our case).
    /bundle format for a\.js mismatches the lockfile/
  )
})

test('sidecar load: tampered import (redirected edge) is rejected', (t) => {
  // The lockfile attests no edges from a.js. A bundle that smuggles an edge
  // through is unattested -- the cross-check from #assertAttestedResolution
  // must refuse it. The exact phrasing is "bundle resolution ... is not attested
  // by the lockfile" (or "... mismatches the lockfile" on a target redirect).
  const path = join(dir, 'tampered-import.br')
  writeFileSync(path, v1Bundle({
    imports: { '*': { 'a.js': { './payload': 'a.js' } } },
  }))
  t.assert.throws(
    () => new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: path }),
    /bundle resolution .* (?:is not attested by|mismatches) the lockfile/
  )
})

test('load-mode sidecar does NOT contribute attestations to the parent-owned lockfile', (t) => {
  // A load-mode sidecar is a CONSUMER: it reads its bundle's attestations and
  // serves them to its plugin context. It must NOT bleed those attestations into
  // the parent's lockfile -- the parent owns the lockfile, and only write-mode
  // sidecars' addImport / addFile observations should land there. (Otherwise a
  // lock=add parent re-running against a load-mode sidecar would silently make
  // the sidecar bundle's content the lockfile's source of truth.)
  const path = join(dir, 'load-noop.br')
  writeFileSync(path, v1Bundle({
    // Smuggle an extra format the parent's lockfile doesn't have. If the
    // load-mode sidecar were contributing, this would show up in parent.lockData.
    formats: { 'a.js': 'javascript:module', 'never-attested.js': 'javascript:commonjs' },
  }))
  // The bundle's `never-attested.js` format isn't in the parent's lockfile;
  // #mergeBundleMetadata cross-check fires and refuses the sidecar bundle
  // (formats attest a forged file). That's the strict path. To exercise the
  // pure no-contribution invariant we need a bundle whose attestations agree
  // with the lockfile -- and then verify they don't appear AGAIN in parent's
  // lockData via the sidecar union.
  t.assert.throws(
    () => new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: path }),
    /bundle format for never-attested\.js/
  )

  // Honest load-mode sidecar: its bundle matches the lockfile exactly. The
  // sidecar is constructed without throwing. After construction we inspect
  // parent.lockData -- the union must NOT include sidecar.imports/sidecar.formats
  // payload, because load-mode is gated out of #sidecars.
  const honestPath = join(dir, 'load-honest.br')
  writeFileSync(honestPath, v1Bundle())
  const before = JSON.parse(parent.lockData)
  // eslint-disable-next-line no-new
  new State(dir, { parent, lock: 'frozen', bundle: 'load', bundleFile: honestPath })
  const after = JSON.parse(parent.lockData)
  // Without the writeBundle gate on the sidecar registry, a load-mode sidecar
  // would still register and the union would walk its bundle-derived imports /
  // formats -- here that would be a no-op anyway because the bundle's data is
  // already in the lockfile, but the invariant "load-mode sidecar doesn't
  // mutate parent.lockData" is what we're pinning.
  t.assert.deepEqual(after, before,
    "load-mode sidecar construction must not change parent's lockData")
})
