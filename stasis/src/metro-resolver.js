// Public-export adapter: backs `@exodus/stasis/metro-resolver`. The resolver lives in
// @exodus/stasis-plugins (which depends on @exodus/stasis-core for State; it replays
// load-mode resolveBundled edges directly). Wire it permanently as Metro's
// `resolver.resolveRequest` (nested under `resolver`), alongside the worker
// transformer; it only acts under bundle=load (transparent pass-through otherwise).
// See the source for why resolution is served in Metro's main process while bytes
// are served per-worker.
export * from '@exodus/stasis-plugins/metro-resolver'
