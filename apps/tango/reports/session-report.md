# Session Report — 2026-06-18 — Tango Explorer Userscript Fix

## Summary

The tango-explorer userscript had stopped working: no streamers appeared, the API pipeline returned 401 on every call, and the script would silently stop with "No streamers found." The root cause was multi-layered: (1) `fetch()` in the userscript's injected context cannot send HttpOnly cookies like `Tango-ST`, (2) multiple API endpoints had moved or changed format, and (3) the auth flow relied on refreshing the wrong tokens at the wrong time.

We rewired the startup flow to refresh `Tango-ST` before any data calls, switched the transport layer from `fetch` to `XMLHttpRequest` with `withCredentials`, replaced three sequential API calls with two parallel calls to the new recommendator endpoints, and updated the blocklist endpoint to match the new URL and response format. The script went from 98 kB to 91 kB with ~115 lines of dead code removed.

---

## Chronology

### Phase 1 — Initial symptoms

The user reported the script showed no signs of life. Logs revealed:

```
[tango] userscript loaded (document-start)
[tango] app starting…
[tango] fetching initial data…
[tango] Failed to fetch following ids, status: 401
[tango] Failed to fetch recommended streamers, status: 401
[tango] No streamers found or API failed. Stopping script.
```

Two API calls (`MY_FOLLOWINGS` and `RECOMMENDATIONS`) both returned 401. The script stopped with zero streamers.

### Phase 2 — First hypothesis: dead endpoints

We investigated whether the API endpoints had changed. We opened a Chromium instance (with the user's real profile for cookies) and captured the page's own network requests on `tango.me/live/recommended`. This revealed the site had migrated to new endpoints:

| Old (our constants) | New (site uses) |
|---|---|
| `GET /discovery/v3/followings/me/list` | `POST /recommendator/social/v2/list/following?includeAlias=true` |
| `GET /recommendations/following?tags=` | `POST /recommendator/social/v2/list/forYou` |
| `GET /proxycador/.../blockList` | `GET /abregistrar/connection/v1/blocklist` |
| `GET /live/stream/v1/tokenData` | `POST /foreground/web/v1/session-validation` |

**Failure:** We initially assumed the old endpoints were dead. Later testing proved `MY_FOLLOWINGS` still works (200) when proper auth is present. The 401 was an auth issue, not a dead endpoint.

**Lesson:** Don't conflate "my request gets 401" with "the endpoint is dead." Test with known-good auth before declaring endpoints dead.

### Phase 3 — The auth investigation

We traced why 401s happened. The key discovery: Tango uses TWO separate cookie-based auth systems:

| Cookie | Purpose | How it's set | Accessible via JS |
|---|---|---|---|
| `Tango-ST` | API authentication (session token) | `google-login/auth-code/v1/login` response | No (HttpOnly) |
| `Tango-RT` | Refreshes Tango-ST (refresh token, 90-day expiry) | Same login response | No (HttpOnly) |
| `tt` / `tte` / `ttu` | Streaming tokens (video playback, 10-second TTL) | `TOKEN_DATA` endpoint | Yes (document.cookie) |

The userscript's `AuthService.ensureTokens()` was calling `TOKEN_DATA` to refresh `tt`/`tte`/`ttu`. This was irrelevant for API auth — those tokens are for video streaming only. The actual API calls (`MY_FOLLOWINGS`, `RECOMMENDATIONS`) needed `Tango-ST`, which was never being refreshed by our code.

**Failure:** We spent significant time debugging `tt`/`tte`/`ttu` before realizing they don't matter for API calls.

**Lesson:** Understand the auth model before touching it. "Tokens" and "session" are overloaded words — verify what each token actually gates.

### Phase 4 — The transport problem

Even with valid `Tango-ST`, our API calls got 401. We tested `fetch` vs `XMLHttpRequest` from the browser context and discovered a critical difference:

| Method | Scope | Result |
|---|---|---|
| `fetch(url, { credentials: "include" })` | `tab.evaluate()` (CDP) | 200 ✅ |
| `fetch(url, { credentials: "include" })` | Injected `<script>` from userscript | 401 ❌ |
| `new XMLHttpRequest()` + `withCredentials` | `tab.evaluate()` (CDP) | 200 ✅ |
| `new XMLHttpRequest()` + `withCredentials` | Injected `<script>` from userscript | 200 ✅ |

The `fetch` API, even with `credentials: "include"`, cannot send HttpOnly third-party cookies (`gateway.tango.me`) when called from a userscript's injected script context in Chrome. This is a known Chrome+Tampermonkey issue. `XMLHttpRequest` with `withCredentials = true` works correctly.

**This was the single most impactful finding of the session.** Every API call to `gateway.tango.me` needed to switch from `fetch` to XHR.

**Failure:** We cycled through many hypotheses (CORS, SameSite, session headers, interaction-id freshness) before landing on the transport issue. Each hypothesis was tested and eliminated one by one.

**Lesson:** Test the transport layer in isolation first. If `fetch(url, credentials)` doesn't work but XHR does, the transport is the problem, not the auth, not the headers.

### Phase 5 — Session headers: a red herring

The page sends custom headers on every API call:

```
username: <sessionId>
foreground-id: <uuid>
interaction-id: <uuid>
x-app-client-session-id: <uuid>
```

These come from `sessionStorage` and `localStorage`. At `document-start`, the userscript's `waitForSession()` polling found them immediately (0ms) — the session storage persists from the previous page load. We added these headers to our XHR calls via `xhrFetch`.

**Finding:** The session headers were NOT required for `MY_FOLLOWINGS` or `RECOMMENDATIONS`. Our tests showed 200 responses even without them, and 200 with fake values. They appear to be analytics/telemetry headers, not auth requirements.

**Failure:** We spent time building the session header injection system (reading from storage, polling for availability, passing through XHR) before verifying they were necessary.

**Lesson:** Test with and without each header. Don't assume all headers sent by the page are required for the API.

### Phase 6 — The session refresh flow

With the transport fixed (XHR) and the auth model understood (Tango-ST), we needed a way to keep Tango-ST alive at `document-start`. The page refreshes Tango-ST via a background mechanism, but our userscript runs before the page's JavaScript.

We found the refresh flow by examining the video-platform's auth package (`packages/auth`). The refresh endpoint:

```
POST https://gateway.tango.me/session-service/public/v2/session/web/refresh
Body: { "accountId": "<from localStorage>", "sessionId": "<from sessionStorage>" }
```

The browser automatically sends `Tango-RT` cookie (path matches `.tango.me`), the server validates it, and returns a fresh `Tango-ST` via `Set-Cookie`.

We replaced `AuthService.ensureTokens()` — which was calling `TOKEN_DATA` for streaming tokens — with this session refresh call. The streaming tokens (`tt`/`tte`/`ttu`) are still refreshed by `startTokenRefresh()` which runs on a 5-second interval after app initialization.

**Key insight:** `Tango-RT` has a 90-day expiry and is set at login. As long as the user logs in once every 90 days, the session refresh keeps working. `Tango-ST` expires in 1 hour and is refreshed by this endpoint.

### Phase 7 — Collapsing the API calls

The old `fetchStreamers()` flow:

```
fetchFollowingIds() → GET /followings/me/list → returns accountIds only
_fetchBlockList() → GET /blockList → returns blocked IDs

fetchLiveFollowings(ids, blockList) → POST /byEncryptedAccountIds → check which are live
fetchRecommendedStreamers(count, blockList) → GET /recommendations/following → recommendations
fetchAliasesInBatch() → POST /profiles/v2/batch → get names/aliases for display
```

This was 5 API calls, 3 of them sequential (followings → live check → aliases). The recommendations endpoint was dead (network error).

The new flow uses the recommendator endpoints discovered by watching the live site:

```
_fetchBlockList() → GET /abregistrar/connection/v1/blocklist → { users: [...] }

_fetchRecommendator(RECOMMENDATOR_FOLLOWING) → POST /recommendator/.../list/following?includeAlias=true
_fetchRecommendator(RECOMMENDATOR_RECOMMENDATIONS) → POST /recommendator/.../list/following_recommendations
```

The recommendator endpoints return stream data, anchor names/aliases, viewer counts, master playlist URLs — everything in one response. No separate live check, no alias batch fetch needed.

Removed: `fetchLiveFollowings()`, `fetchRecommendedStreamers()`, `liveRecordToStreamer()`, `recommendationToStreamer()`, `RecommendationCategory` interface, `RecommendationDetail` interface, `LiveRecord` interface, `RECOMMENDATIONS` constant, `LIVE_BY_ACCOUNT_IDS` constant.

Kept: `fetchFollowingIds()` (used by `fetchMultiBroadcastStreamers()`), `fetchAliasesInBatch()` and `fetchAlias()` (used by `AliasService` for prefetching), `MY_FOLLOWINGS` constant (still used by multi-broadcast feature).

**Failure:** The new blocklist endpoint returns `{ error_code, error_message, users: [...] }` — an object, not a plain array. Our first deployment crashed with `blockList.includes is not a function` because `_fetchBlockList()` assigned the whole object to `blockList` instead of extracting `.users`.

**Lesson:** Always check the response shape of a new endpoint before wiring it into existing code. A one-line `console.log(body)` would have caught this in seconds.

### Phase 8 — Browser tool failures

Throughout the session, the browser tool (`browser` open/run) failed in several ways:

1. **`Failed to parse JSON`** — `fetch` in `run` scope resolves to Node.js `fetch`, which can't send browser cookies. The response is an HTML error page that fails JSON parsing. Fix: wrap in `tab.evaluate()`.

2. **`Failed to fetch`** — `tab.evaluate(async () => { ... })` with complex async chains fails silently. Fix: split into multiple simple evaluate calls.

3. **`Tab "X" is busy`** — Two `run` calls dispatched in parallel on the same tab. Fix: serialize.

4. **`Tab "X" is bound to a different browser`** — Tab name reused with different `app` params. Fix: close first, then reopen.

5. **`Attempted to use detached Frame`** — Page navigated while tab was attached. Fix: reopen.

6. **`Worker has been terminated`** — Chromium crashed or port conflict. Fix: kill all processes, restart.

7. **Protobuf responses** — Tango's gateway returns protobuf by default. Fix: always include `Accept: application/json; charset=UTF-8`.

These are documented in `tools/browser.md`.

### Phase 9 — Edit tool failures

The edit tool caused several corruptions during the session:

1. **Auto-repair dropping structural delimiters (F6)** — When `SWAP` replaced a method containing `if (!this.defaultInit) { throw ...; }`, the auto-repair dropped the `}` closing the `if` block. The build only caught it on the next method. Fix: always re-read after auto-repair warnings.

2. **Double-injection corruption** — A `SWAP 198.=200` meant for `_fetchRecommendator` landed in `fetchMultiBroadcastStreamers` instead. The line numbers in the stale snapshot happened to match a different method. Fix: re-read between edits, verify the context matches.

Documented in `tools/edit.md`.

---

## Files changed

| File | Change | Net |
|---|---|---|
| `src/core/constants.ts` | Replaced dead endpoints, added recommendator URLs | -2 +3 |
| `src/services/api/auth.service.ts` | Replaced `ensureTokens()` to refresh `Tango-ST` via XHR | ~30 lines new |
| `src/services/api/streamer.service.ts` | Replaced `fetchStreamers()` flow, removed 4 dead methods, updated blocklist extraction | ~-115 +70 |
| `vite.config.ts` | (Reverted, unchanged from original) | 0 |
| `src/core/xhr-fetch.ts` | (Created then removed in test folder) | 0 |

**Net:** 98 kB → 91 kB (7 kB reduction, ~115 lines removed)

---

## What worked

1. **Live network capture** — watching the actual page make API calls was decisive. It revealed the real endpoints, the real headers, and the real response shapes.

2. **CDP-based testing** — `tab.evaluate()` to make isolated API calls let us test each endpoint independently without the userscript's complexity.

3. **XMLHttpRequest with withCredentials** — the reliable transport for cross-origin API calls from userscript context.

4. **Incognito browser** — controlling auth state let us test visitor vs logged-in flows cleanly.

5. **Video-platform auth package** — served as reference for the session refresh endpoint.

6. **The recommendator endpoint** — a single call replaces three, with inline names/aliases/viewers.

---

## What failed

1. **Wrong initial hypothesis** — assumed dead endpoints when the real issue was cookie transport.

2. **Debugging tt/tte/ttu** — spent time on streaming tokens that are irrelevant for API auth.

3. **Session header rabbit hole** — built header injection system for headers that turned out to be non-essential.

4. **Blocklist format assumption** — didn't verify new endpoint's response shape before deploying.

5. **Browser tool misuse** — multiple failures from using Node.js `fetch` instead of page `fetch` in `run` scope.

6. **Edit tool corruption** — auto-repair dropped structural delimiters, wrong method targeted due to stale line numbers.

---

## Process recommendations for next time

### 1. Start with network observation, not code reading

Before changing any code, open the real site, watch the Network tab, and capture every API call. Look at request headers, response bodies, and the order of calls. This answers "what does the site actually do?" faster than reading code.

### 2. Test transport before auth, auth before data

```
Transport: Does fetch() work? Does XHR work? Compare.            ← 5 minutes
Auth:      What cookie/token is needed? How is it refreshed?      ← 10 minutes  
Data:      What endpoints return the data I need? What format?     ← 15 minutes
```

Don't build the data pipeline until transport and auth are verified independently.

### 3. Use incognito to control auth state

An incognito window lets you test every auth state: visitor (no cookies), logged-in (Tango-ST present), expired (Tango-ST timed out). This is impossible in a normal profile where cookies persist.

### 4. Verify response shapes with a single console.log

Before writing a parser, log the raw response. One `console.log(JSON.stringify(body, null, 2))` catches format mismatches instantly.

### 5. Test API calls in isolation via CDP

```js
// In browser tool:
return await tab.evaluate(async () => {
    const r = await fetch(url, { credentials: "include", headers: {...} });
    return { status: r.status, body: await r.json() };
});
```

This tests the endpoint without the userscript's injection mechanism, environment modifications, or other moving parts. If it works here but not in the userscript, the problem is in the userscript's execution context.

### 6. Re-read between edits

Every edit mints a fresh snapshot. Auto-repair warnings mean structural damage is possible. A quick `read path:start-end` after every edit catches corruption before it compounds.

### 7. Query existing working code as reference

The video-platform's auth package had the correct session refresh endpoint and cookie names. Reading working code is faster than reverse-engineering from scratch.
