// Bumps a global on every evaluation, so a genuine fresh (uncached) re-require
// returns a higher number while a cached require repeats the last one.
globalThis.__stasisImportFreshCounter = (globalThis.__stasisImportFreshCounter || 0) + 1
module.exports = globalThis.__stasisImportFreshCounter
