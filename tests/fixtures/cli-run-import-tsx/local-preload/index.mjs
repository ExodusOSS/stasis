// A non-transforming extra preload (`--import ./local-preload/index.mjs`): must evaluate before
// the entry and stay OUT of the capture (runner infrastructure, like stasis's own loader).
console.error('[local-preload] loaded')
