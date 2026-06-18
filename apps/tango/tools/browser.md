# Browser tool reference (oh-my-pi)

## Failure modes

- **`Tab "X" is busy`** — Two `run` calls were dispatched in parallel on the same tab. Serialize `run` calls when targeting the same tab.
- **`Tab "X" is bound to a different browser`** — Tab name was previously opened with different `app` parameters. Close it first with `close` + `name`, then reopen with new `app` params.

- **`Failed to fetch`** — Either: (a) `fetch` in `run` scope is Node.js `fetch`, not page `fetch` — wrap in `tab.evaluate()`. Or: (b) `tab.evaluate(async () => { ... })` with complex async (multiple awaits, JSON parsing, large responses) — evaluate promise breaks. Split into simple calls. (c) **Specific endpoints** like `/recommendations/following?tags=` fail even with minimal `tab.evaluate()` — the fetch itself never resolves in the evaluate context. These endpoints may be dead or have CORS issues. **Pass**: use XHR via `tab.evaluate()` for problematic endpoints: `new XMLHttpRequest()` with `withCredentials` + `onload` callback instead of `fetch`. (d) `tab.evaluate()` returning large response text (`r.text()`) — the response may be too large for the evaluate bridge, causing truncation/timeout.

- **`Worker has been terminated`** — Chromium process crashed or port conflict. Kill all chromium processes (`pkill -f chromium`) and reopen.

- **`Attempted to use detached Frame`** — The page navigated or was closed while a `tab` was still attached. Reopen the tab with the target page URL.

## Pass patterns

- **Single fetch**: `return await tab.evaluate(async () => { const r = await fetch(url, { credentials: "include" }); return { status: r.status }; });`
- **Single fetch (tango API)**: `return await tab.evaluate(async () => { const r = await fetch(url, { credentials: "include", headers: { "Accept": "application/json; charset=UTF-8" } }); return { status: r.status }; });`
- **Note**: Tango's gateway returns protobuf without `Accept: application/json; charset=UTF-8`. Always include this header.
