// Public-export adapter: backs `@exodus/stasis/bundle`. The implementation lives in
// @exodus/stasis-core; internal tooling and tests import `@exodus/stasis-core/bundle`
// directly, so this file exists only to back the package's `exports` map.
export * from '@exodus/stasis-core/bundle'
