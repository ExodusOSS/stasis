import { hash } from 'node:crypto'

// pnpm's dependency-path conventions (lockfileVersion 9): a package is keyed `name@version` in
// `packages` and `name@version(peer@ver)(...)` in `snapshots` (the peer suffix distinguishes
// instances resolved against different peers). The virtual store directory a snapshot is unpacked
// into is derived from that key by `depPathToFilename`, reproduced here byte-for-byte so a bundle
// built from the lockfile records the same `node_modules/.pnpm/<dir>/node_modules/<name>/...` paths
// a real `pnpm install` lays down (and so `stasis run --bundle=load`/`--lock=frozen` line up with it).

// `name@version(peers)` -> { name, version, peersSuffix }. Mirrors @pnpm/dependency-path's parse():
// the name ends at the first `@` after index 0 (scoped names start with `@`); a trailing `(...)`
// group is the peer suffix. `version` may be a non-semver spec (`file:../x`, a tarball URL).
export function parseDepPath(depPath) {
  if (typeof depPath !== 'string') throw new TypeError(`pnpm dep path must be a string, got ${typeof depPath}`)
  const sep = depPath.indexOf('@', 1)
  if (sep === -1) throw new Error(`Malformed pnpm dep path (no version): '${depPath}'`)
  const name = depPath.slice(0, sep)
  let version = depPath.slice(sep + 1)
  let peersSuffix = ''
  if (version.includes('(') && version.endsWith(')')) {
    const at = version.indexOf('(')
    peersSuffix = version.slice(at)
    version = version.slice(0, at)
  }
  if (!name || !version) throw new Error(`Malformed pnpm dep path: '${depPath}'`)
  return { name, version, peersSuffix }
}

// The `packages` key for a snapshot key: the peer suffix dropped.
export function stripPeerSuffix(depPath) {
  const { name, version } = parseDepPath(depPath)
  return `${name}@${version}`
}

// A dependency reference (the value under a snapshot's/importer's `dependencies`) to the snapshot
// key it names, or null for a `link:` (a workspace symlink, not a package). A reference is a bare
// version (`1.2.3`, `1.2.3(peer@1)`, `file:../x`) to be prefixed with the alias, unless it already
// spells `name@version` (an aliased dep: `string-width-cjs: string-width@4.2.3`). Mirrors
// @pnpm/dependency-path's refToRelative().
export function refToDepPath(alias, ref) {
  if (typeof ref !== 'string' || ref === '') throw new Error(`Malformed pnpm dependency reference for '${alias}': ${JSON.stringify(ref)}`)
  if (ref.startsWith('link:')) return null
  const paren = ref.indexOf('(')
  const head = paren === -1 ? ref : ref.slice(0, paren)
  if (head.indexOf('@', 1) !== -1) return ref
  return `${alias}@${ref}`
}

// RFC 4648 base32, unpadded.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

// pnpm 9's @pnpm/crypto.base32-hash: base32(md5(str)), lowercase, unpadded (26 chars).
export function createBase32Hash(str) {
  return base32(hash('md5', str, 'buffer')).toLowerCase()
}

// pnpm 10's @pnpm/crypto.hash createShortHash: the first 32 hex chars of sha256(str).
export function createShortHash(str) {
  return hash('sha256', str, 'hex').slice(0, 32)
}

// Default `virtual-store-dir-max-length` (pnpm >= 9).
export const DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH = 120

// The two directory-name hashing schemes pnpm has shipped: pnpm 10 (`sha256`, verified against a
// real install) and pnpm 9 (`md5-base32`). Both keep `<prefix>_<hash>` within maxLengthWithoutHash.
const HASH_SCHEMES = {
  sha256: { suffixLength: 33, hash: createShortHash },
  'md5-base32': { suffixLength: 27, hash: createBase32Hash },
}

// The directory name under the virtual store (`node_modules/.pnpm/`) for a snapshot key. Mirrors
// @pnpm/dependency-path's depPathToFilename(): path separators and other filesystem-hostile
// characters become `+`, the peer suffix's parentheses become `_` separators, and a name that is
// too long -- or carries uppercase (case-insensitive filesystems) -- is truncated and suffixed with
// a hash of the escaped name.
export function depPathToFilename(depPath, maxLengthWithoutHash = DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH, { hashScheme = 'sha256' } = {}) {
  const scheme = HASH_SCHEMES[hashScheme]
  if (!scheme) throw new Error(`Unknown pnpm dir hash scheme '${hashScheme}'`)
  let unescaped = depPath
  if (unescaped.startsWith('file:')) unescaped = unescaped.replace(':', '+')
  else if (unescaped.startsWith('/')) unescaped = unescaped.slice(1)
  let filename = unescaped.replaceAll(/[\\/:*?"<>|]/gu, '+')
  if (filename.includes('(')) {
    filename = filename.replace(/\)$/u, '').replaceAll(/(\)\()|\(|\)/gu, '_')
  }
  if (filename.length > maxLengthWithoutHash || (filename !== filename.toLowerCase() && !filename.startsWith('file+'))) {
    return `${filename.slice(0, Math.max(0, maxLengthWithoutHash - scheme.suffixLength))}_${scheme.hash(filename)}`
  }
  return filename
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

// The registry tarball URL for a package when the lockfile records none (`lockfileIncludeTarballUrl`
// off): `<registry>/<name>/-/<basename>-<version>.tgz`, the npm registry's fixed layout.
export function registryTarballUrl(name, version, registry = DEFAULT_REGISTRY) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const basename = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return `${base}${name}/-/${basename}-${version}.tgz`
}
