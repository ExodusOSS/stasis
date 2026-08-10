// Swap in a fetch stub for the duration of one test, recording every call so the request
// (URL, method-less GET, headers) can be asserted alongside the result. `impl` receives the
// current call plus the calls so far, so a stub can answer differently per request.
export const withFetch = (impl, fn) => async (t) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return impl({ url, opts, calls })
  }
  try {
    return await fn(t, calls)
  } finally {
    globalThis.fetch = original
  }
}

export const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
