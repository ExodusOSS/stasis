// Never imported by anything. A forged shard (src/forge.js) tries to get this attested into the
// root's lockfile; the ed25519 signature check must reject the forgery, leaving decoy.js absent.
export const decoy = 'should-not-be-attested'
