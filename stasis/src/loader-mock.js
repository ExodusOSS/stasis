// stasis's `--mock` run-time loader entry (used by `stasis run --mock`). The
// import order is load-bearing:
//   1. the @exodus/stasis-core hooks lib -- evaluating it snapshots stasis's own
//      node:fs/path/etc. bindings off the *real* builtins (state.js destructures
//      them at module-eval time), so stasis keeps reading/writing through real fs;
//   2. ./mock.js -- which neutralizes the network/timer builtins and fs writers in
//      JS and calls module.syncBuiltinESMExports() so user code's later ESM imports
//      resolve to the mocked builtins.
// Only THEN install() the hooks. Running mock.js before registration keeps it from
// going through the hooks (so it never becomes the bundle entry), and running it
// after the lib's snapshots leaves stasis's own bindings untouched. This static
// composition is what lets core stay mock-agnostic with no env-var coordination.
import { install, initStateAsync } from '@exodus/stasis-core/hooks'
// `export *` (mock.js has no exports) rather than a bare side-effect import only
// to satisfy the no-unassigned-import lint rule; ESM still evaluates it here, in
// source order, after the hooks lib above and before install() below.
export * from './mock.js'

// Eager async State init (strict bundle decompression) before install(), matching the
// non-mock loader. State reads through its own real-fs snapshot, so it is unaffected by
// mock.js neutralizing the fs writers above.
await initStateAsync()
install()
