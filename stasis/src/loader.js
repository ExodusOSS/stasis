// The stasis run-time loader lives in @exodus/stasis-core. Importing this module
// evaluates core's loader (registering Node's module hooks); kept so
// `@exodus/stasis/loader` (and `node --import @exodus/stasis/loader`) keep
// working after the core split. core's loader has no exports, so this re-export
// runs purely for its evaluation side effect.
export * from '@exodus/stasis-core/loader'
