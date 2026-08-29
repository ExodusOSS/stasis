// Public-export adapter: backs `@exodus/stasis/nextjs`. The Next.js wrapper lives in
// @exodus/stasis-plugins (which depends on @exodus/stasis-core for State /
// resolvePluginState). Internal code uses `@exodus/stasis-plugins/nextjs` directly;
// this file exists only to back the package's `exports` map.
export * from '@exodus/stasis-plugins/nextjs'
