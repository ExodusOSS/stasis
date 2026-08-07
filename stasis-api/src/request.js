// Shared transport for this package's registry clients: make the request and turn both
// failure modes -- fetch itself rejecting, and a non-2xx answer -- into one Error shape,
// `<label> request failed: ...`. Decided once here rather than per client, so every client
// reports an HTTP failure the same way and a new one can't quietly invent a third format.

// Enough of an error body to identify the failure, not enough to dump a page into a log line.
const BODY_SNIPPET = 200

// The package-wide answer to "what is a long request": metadata answers in one round trip,
// a transfer is bounded by its size instead. Every client draws its defaults from these two
// numbers, so the endpoints cannot drift apart on what is a long request.
export const METADATA_TIMEOUT = 30_000
export const TRANSFER_TIMEOUT = 300_000

// The shape of a transport failure that carries a cause. Also for a body that dies mid-read
// after a 2xx (see github/core.js readBody) -- the same failure class, so the same shape.
export const requestFailed = (label, cause) => new Error(`${label} request failed: ${cause.message}`, { cause })

export async function requestOk(label, url, init) {
  let res
  try {
    res = await fetch(url, init)
  } catch (cause) {
    throw requestFailed(label, cause)
  }
  if (!res.ok) {
    // A body that itself fails to read must not mask the status it arrived with.
    const text = await res.text().catch(() => '')
    throw new Error(`${label} request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, BODY_SNIPPET)}` : ''}`)
  }
  return res
}
