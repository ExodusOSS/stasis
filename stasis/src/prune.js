// Public-export adapter: backs `@exodus/stasis/prune`. The implementation lives in
// @exodus/stasis-core; internal tooling and tests import `@exodus/stasis-core/prune`
// directly, so this file exists only to back the package's `exports` map.
export * from '@exodus/stasis-core/prune'
