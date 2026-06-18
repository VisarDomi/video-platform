# Session Report — 2026-06-18

## Problem
Tango-explorer userscript broken: zero streamers, API calls returning 401.

## Root cause chain
1. `fetch()` in userscript injected context doesn't send HttpOnly cookies (`Tango-ST`) → 401
2. `MY_FOLLOWINGS` endpoint still works but only with valid `Tango-ST`
3. `RECOMMENDATIONS` and `LIVE_BY_ACCOUNT_IDS` endpoints dead/replaced by recommendator
4. `BLOCK_LIST` endpoint changed URL + response format

## What we changed
- **`fetch` → `XMLHttpRequest`** with `withCredentials` for session refresh + recommendator calls
- **`ensureTokens()`** now refreshes `Tango-ST` via `POST /session-service/.../refresh`
- **Collapsed 3 calls → 2 parallel**: recommendator following + recommendations replace followings → live check → alias batch
- **Updated endpoints**: blocklist, recommendator
- **Removed ~115 lines** of dead code (methods, interfaces, constants)
- **Net: 98 kB → 91 kB**

## Key findings
| Finding | Source |
|---|---|
| `Tango-ST` is the real API auth cookie (not `tt`/`tte`/`ttu`) | Live network capture |
| `fetch` can't send HttpOnly cookies from userscript context | Repeated testing |
| `XMLHttpRequest` with `withCredentials` works reliably | CDP testing |
| Session refresh: `POST /session-service/.../refresh` with `{ accountId, sessionId }` | Auth package |
| Recommendator returns live + names + aliases in one call | Page network trace |
| Tango API returns protobuf without `Accept: application/json` header | Multiple failures |

## Process — what slowed us down
1. **Reading code before watching network** — should have started with live network capture
2. **Testing fetch vs XHR too late** — should test transport before auth logic
3. **Editing without reading** triggered auto-repair corruption (F6)
4. **Browser tool scope confusion** — `fetch` in `run` is Node.js, not page
5. **Wrong auth assumption** — focused on `tt`/`tte`/`ttu` when `Tango-ST` was the real key

## Faster process for next time
1. **Watch the live site first** — open network tab, observe real API calls, capture headers + responses
2. **Test transport in isolation** — verify your API call mechanism works before building logic around it
3. **Verify endpoint-by-endpoint** — `tab.evaluate(async () => { fetch(url, opts).then(r => r.status) })` for each
4. **Check response shapes** — before parsing, log the actual response structure
5. **Control auth state** — incognito browser lets you test logged-in vs visitor flows
6. **Edit after reading** — always ranged-read the exact lines before editing, re-read after auto-repair warnings
