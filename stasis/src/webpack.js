// Public-export adapter: backs `@exodus/stasis/webpack`. The plugin lives in
// @exodus/stasis-core alongside State (it's tightly coupled to resolvePluginState /
// isTrackedPath). Internal code uses `@exodus/stasis-core/webpack` directly; this
// file exists only to back the package's `exports` map.
export * from '@exodus/stasis-core/webpack'
