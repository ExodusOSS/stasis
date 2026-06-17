// Public-export adapter: backs `@exodus/stasis/metro`. The plugin lives in
// @exodus/stasis-core alongside State (it's tightly coupled to resolvePluginState /
// isTrackedPath). Internal code uses `@exodus/stasis-core/metro` directly; this
// file exists only to back the package's `exports` map.
export * from '@exodus/stasis-core/metro'
