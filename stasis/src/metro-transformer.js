// Public-export adapter: backs `@exodus/stasis/metro-transformer`. The transformer
// lives in @exodus/stasis-plugins (which depends on @exodus/stasis-core for State; it
// drives load-mode getFile directly). Wire it permanently as Metro's top-level
// `transformerPath`; it only acts under bundle=load (transparent pass-through
// otherwise). See the source for the load asymmetry that lets this run per-worker
// without cross-worker state sync.
export * from '@exodus/stasis-plugins/metro-transformer'
