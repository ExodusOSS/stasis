import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Test-only: drop a FORGED shard (claiming src/decoy.js, which the root must NOT attest) to prove
// the signature gate rejects it. FORGE_SHARD selects the rejection path. These run IN the root
// process for test convenience, so they CAN read the private key from env -- only 'foreign' models
// a truly keyless attacker; 'unsigned'/'tampered' construct specific bad envelopes to exercise the
// gate's typeof and byte-coverage checks (which a keyless attacker hits too):
//   '1' (foreign) -- a valid signature, but from a DIFFERENT keypair (the attacker has no private key)
//   'unsigned'    -- no `signature` field at all
//   'tampered'    -- a genuine root signature over a decoy-free payload, reused over a decoy-bearing one
// We name the file with the root's own public-key prefix so it passes the pre-filter; the
// signature check (against the root's public key, over the exact shard bytes) is what rejects it.
const mode = process.env.FORGE_SHARD
const dir = process.env.EXODUS_STASIS_SHARD_DIR
const keyB64 = process.env.EXODUS_STASIS_SHARD_KEY
if (dir && keyB64) {
  const rootPriv = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' })
  const pubId = createPublicKey(rootPriv).export({ format: 'jwk' }).x
  const lock = (files) => JSON.stringify({
    version: 0,
    config: { scope: 'full' },
    entries: [],
    sources: { '.': { name: 'stasis-cli-run-fork-shard', version: '0.0.0', files } },
    modules: {},
  })
  const shard = lock({ 'src/decoy.js': 'sha512-AAAA' })
  let envelope
  if (mode === 'unsigned') {
    envelope = { shard } // no signature -> rejected by the typeof check
  } else if (mode === 'tampered') {
    // A genuine root signature, but over a DIFFERENT (decoy-free) payload -- proves verify covers
    // the bytes, not merely key identity: the swapped decoy-bearing shard fails verification.
    const signature = sign(null, Buffer.from(lock({})), rootPriv).toString('base64url')
    envelope = { shard, signature }
  } else {
    const { privateKey: attackerKey } = generateKeyPairSync('ed25519') // NOT the root's key
    const signature = sign(null, Buffer.from(shard), attackerKey).toString('base64url')
    envelope = { shard, signature }
  }
  writeFileSync(join(dir, `${pubId}-77777.json`), JSON.stringify(envelope))
  console.log(`FORGE wrote a forged shard (${mode}) for src/decoy.js`)
}
