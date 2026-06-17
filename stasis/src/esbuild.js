// Public-export adapter: backs `@exodus/stasis/esbuild`. The plugin lives in
// @exodus/stasis-core alongside State (it's tightly coupled to resolvePluginState /
// isTrackedPath). Internal code uses `@exodus/stasis-core/esbuild` directly; this
// file exists only to back the package's `exports` map.
export * from '@exodus/stasis-core/esbuild'
