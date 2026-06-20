// stasis-core's run-time loader entry. Evaluating it -- `stasis-core run`, or
// `node --import @exodus/stasis-core/loader` -- snapshots the lib's
// node:fs/path/etc. bindings, eagerly builds the preload State (reading any bundle
// with strict async decompression), and registers the module hooks.
//
// The eager `await` is the whole reason this entry exists as a module with top-level
// await: `registerHooks` installs SYNCHRONOUS load/resolve hooks, so the bundle read
// can't be async from inside them. Doing it here -- before install() -- means the
// State is ready by the time the first module loads, and the sync hooks just serve.
import { install, initStateAsync } from './hooks.js'

await initStateAsync()
install()
