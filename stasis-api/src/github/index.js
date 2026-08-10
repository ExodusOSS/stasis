// Public face of the GitHub client. The shared plumbing lives in core.js (host, headers,
// auth, slug/ref validation, next-link parsing); each endpoint family is its own module
// beside it. Only what is re-exported here is API of this package -- core.js is internal,
// so it can change without breaking a consumer.

export { asset, latestRelease, release, releases } from './releases.js'
export { subtree } from './subtree.js'
