// stasis's `--mock` loader entry. The import order is load-bearing:
//   1. the core hooks lib -- evaluating it snapshots stasis's own fs bindings off the *real*
//      builtins, so stasis keeps reading/writing through real fs;
//   2. ./mock.js -- neutralizes the network/timer builtins and fs writers, then calls
//      syncBuiltinESMExports() so user code's later ESM imports resolve to the mocks.
// Only THEN install() the hooks (so mock.js never goes through them / becomes the bundle entry).
import { install } from '@exodus/stasis-core/hooks'
// `export *` (mock.js has no exports) rather than a bare side-effect import, to satisfy the
// no-unassigned-import lint rule; ESM still evaluates it here in source order.
export * from './mock.js'

install()
