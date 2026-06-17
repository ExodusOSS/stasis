// Public-export adapter: backs `@exodus/stasis/metro-transformer`. The transformer
// lives in @exodus/stasis-core alongside State (it drives load-mode getFile directly).
// Wire it as Metro's `transformer.transformerPath` in load mode; see the source for the
// load asymmetry that lets this run per-worker without cross-worker state sync.
export * from '@exodus/stasis-core/metro-transformer'
