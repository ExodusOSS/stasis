// Public-export adapter: backs `@exodus/stasis/metro`. The plugin lives in
// @exodus/stasis-plugins (which depends on @exodus/stasis-core for State /
// resolvePluginState). Internal code uses `@exodus/stasis-plugins/metro` directly;
// this file exists only to back the package's `exports` map.
export * from '@exodus/stasis-plugins/metro'
