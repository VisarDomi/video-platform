# iPhone break report — v204 vs HEAD (v232)

## Symptom

List shows streamers, but tapping one does not load video. Works on Chrome, broken on iPhone Safari.

## The video loading path

1. `VideoManager.initialize()` → creates 3 `StreamUnit`s → `unit.update(streamer)`
2. `StreamUnit.update()` → `LiveUrlService.fetchAndParseLiveUrl(streamer)` → fetches HLS master playlist → parses URL
3. Returns live URL → `HlsPlayer.loadSource(url)` → HLS.js starts streaming

If step 2 fails, no video loads.

## The breaking change

**`live-url.service.ts:18` — `mode: "cors"` removed**

| v204 | HEAD |
|---|---|
| `fetch(url, { credentials: "include", mode: "cors" })` | `fetch(url, { credentials: "include" })` |

When we removed `defaultInit` from all services, `LiveUrlService` lost `this.defaultInit` which was `{ credentials: "include", mode: "cors" }`. The replacement hardcoded `{ credentials: "include" }` but dropped `mode: "cors"`.

## Why it breaks iPhone Safari

`masterListUrl` points to a CDN domain (e.g. `contentserver.tango.me`) — cross-origin from `www.tango.me`. On Chrome, `credentials: "include"` on a cross-origin request implicitly sets `mode: "cors"`. On iPhone Safari, without explicit `mode: "cors"`, the fetch may silently fail or not send credentials, causing the playlist request to 401/403 or CORS-block. HLS.js can't load the stream without the playlist.

## Fix

Restore `mode: "cors"` in the playlist fetch:

```ts
const liveResponse = await fetch(streamer.masterListUrl, { credentials: "include", mode: "cors" });
```

## Other changes ruled out

| Change | Why not the cause |
|---|---|
| `ensureTokens()` throws | List renders, so startup + API calls work |
| `fetchStreamers()` no catch | List renders, so streamer fetch works |
| Cache save deferred via microtask | Doesn't affect video loading |
| `xhrFetch` replaces `fetch` for API | List renders, so API calls work |
| Getter accessors in VideoManager | Transparent to callers |
| `displayName` arg removed from playlist fetch | Extra arg ignored by JS |
| `setIndexToStreamer` removed | Unused method |
