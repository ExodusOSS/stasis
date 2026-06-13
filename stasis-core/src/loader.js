// stasis-core's run-time loader entry. Evaluating it -- `stasis-core run`, or
// `node --import @exodus/stasis-core/loader` -- snapshots the lib's
// node:fs/path/etc. bindings and registers the module hooks.
import { install } from './hooks.js'

install()
