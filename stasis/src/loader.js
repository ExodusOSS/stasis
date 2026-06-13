// Public-export adapter: backs `@exodus/stasis/loader` (and `node --import
// @exodus/stasis/loader`). The loader lives in @exodus/stasis-core; importing
// this evaluates it (registering Node's module hooks) for its side effect.
// Internal code uses `@exodus/stasis-core/loader` directly, so this file exists
// only to back the package's `exports` map.
export * from '@exodus/stasis-core/loader'
