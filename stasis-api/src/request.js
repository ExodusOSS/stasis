// Shared transport for this package's registry clients: make the request and turn both
// failure modes -- fetch itself rejecting, and a non-2xx answer -- into one Error shape,
// `<label> request failed: ...`. Decided once here rather than per client, so every client
// reports an HTTP failure the same way and a new one can't quietly invent a third format.

// Enough of an error body to identify the failure, not enough to dump a page into a log line.
const BODY_SNIPPET = 200

export async function requestOk(label, url, init) {
  let res
  try {
    res = await fetch(url, init)
  } catch (cause) {
    throw new Error(`${label} request failed: ${cause.message}`, { cause })
  }
  if (!res.ok) {
    // A body that itself fails to read must not mask the status it arrived with.
    const text = await res.text().catch(() => '')
    throw new Error(`${label} request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, BODY_SNIPPET)}` : ''}`)
  }
  return res
}
