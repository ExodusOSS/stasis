'use strict'

// Minimal stand-in for `metro-transform-worker`, used by the StasisMetro transformer
// tests (Metro isn't a dependency). It implements the transformer contract Metro's
// worker calls -- `transform(config, projectRoot, filename, data, options)` and
// `getCacheKey(config)` -- and simply echoes back the bytes it was handed, so a test
// can assert WHICH bytes the stasis transformer fed it (the on-disk bytes it was
// given, vs. the bundle-attested bytes it should substitute in load mode).
exports.transform = (config, projectRoot, filename, data, _options) => ({
  received: Buffer.isBuffer(data) ? data.toString('utf8') : String(data),
  filename,
})

exports.getCacheKey = () => 'mock-base-cache-key'
