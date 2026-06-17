// Reproduces the lockfile-level "Conflict for 'isarray'" the user observed in
// webpack@4 capture mode. The layout mirrors a real install where:
//   - has-binary2 declares its own nested isarray@1 (in its node_modules)
//   - path-to-regexp depends on the top-level isarray@2
// Both packages do bare `require('isarray')` from their own files. Each should
// resolve to its OWN copy. If webpack's resolver caches by request-only (a
// known webpack 4 unsafeCache footgun) the second resolution can return the
// first one's path, and afterResolve fires for path-to-regexp twice -- once
// with each path -- producing the noupsert conflict on (parent, 'isarray').
const a = require('has-binary2')
const b = require('path-to-regexp')
console.log(a, b)
