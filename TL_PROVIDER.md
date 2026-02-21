# TL Provider — Architecture & Flow

## Core Principle

**liveUrl is the source of truth.** A stream is only removed from the list, memory, and IndexedDB when its liveUrl returns a **404 from tango.me**. Nothing else triggers removal.

## Data Model

The `/recommended` endpoint returns streamers with:
- **s** — `streamerId` (unique identifier)
- **m** — `masterListUrl` (HLS master playlist URL on tango.me)

From **m** we resolve:
- **l** — `liveUrl` (720p sub-playlist URL on tango.me) — cached in IndexedDB

### Duplicate vs New

- **Duplicate**: same `s` AND same `m` as an existing entry → skip, don't re-process
- **New**: different `s`, OR same `s` with different `m` (stream restarted) → process

## Flows

### 1. First Load

1. Start queue → **Phase 0**: process all IndexedDB entries. For each cached liveUrl, `checkLiveUrl` against tango.me. If 404 → remove from IDB. This cleans stale entries from a previous session (app killed by OS).
2. Hit endpoint → get list of `(s, m)` pairs (following + recommended)
3. Add all streamers to the video list
4. Process queue top-to-bottom:
   - For each streamer: resolve **l** from **m** (backend parses master m3u8)
   - If resolved → cache **l** in IndexedDB, update store
   - If failed → check IndexedDB for cached **l**. If exists, use it. If not, stream stays without liveUrl (unplayable until next cycle resolves it)
   - Then: fetch co-streamers for this streamer
   - For each unique co-streamer: add to list after parent, resolve its **l**
5. Continue until last stream processed, then enter the queue loop

### 2. Video Playback (HLS error handling)

When a video is opened/navigated to:
1. Proxy starts → backend fetches **l** from tango.me to serve the m3u8
2. If tango.me returns **200** → segments are served, video plays
3. If tango.me returns **404** → HLS.js gets a fatal 404 error:
   - For TL: HLS instance is destroyed. The processing queue handles removal.
   - For non-TL providers: stream is immediately removed from the video list.
4. VideoPlayer watches the video list reactively — when the queue removes a stream that is currently playing, the player automatically navigates to the next available video.

### 3. Processing Queue (continuous loop)

The queue runs continuously while on TL provider. No artificial delays between cycles — the queue paces itself via `LIVE_URL_RESOLVE_DELAY_MS` (200ms) between each item.

**Phase 0 — IDB cleanup (on start only):**
1. Read all IndexedDB entries with a liveUrl
2. For each: `checkLiveUrl` against tango.me → if 404, remove from IDB
3. Ensures clean slate after app restart (OS killed the app, stale cache remains)

**Phase 1 — Endpoint fetch + process new:**
1. Hit endpoint → get fresh list of `(s, m)` pairs
2. For each streamer in fresh list:
   - If **duplicate** (same `s` + same `m` already in streamerMap) → skip
   - If **new** (different `s`, or same `s` + different `m`) → add to list, process
3. Process all new/changed streamers: resolve liveUrl + discover co-streamers
4. Fire-and-forget: refresh liveFilenames, listIdentifiers, sweep orphans

**Phase 2 — Reprocess existing:**
1. For each existing streamer NOT just processed in Phase 1:
2. Check **cached liveUrl** against tango.me (`checkLiveUrl`):
   - If alive → done, stream stays
   - If dead → try resolving new liveUrl from **masterListUrl** (`resolveLiveUrl`)
3. If new liveUrl obtained, check **it** against tango.me:
   - If alive → update cache + store, stream stays
   - If dead → **both confirmed 404** → remove from list, memory, IndexedDB
4. If `resolveLiveUrl` fails (null) → can't confirm both dead → keep for 24h
5. If no cached liveUrl exists → try to resolve from masterListUrl (not a removal candidate)

**Then back to Phase 1.** No waiting — the natural processing time + 200ms per-item delay provides pacing.

### 4. Return to TL (after provider switch)

1. Restore in-memory snapshot (instant visual restore)
2. Queue starts with Phase 0 (IDB cleanup) then enters the loop

## IndexedDB Cache Rules

Simple:
- **Store**: on successful liveUrl resolution → `putCached(streamerId, masterListUrl, liveUrl)`
- **Never overwrite** a cached liveUrl with null (masterListUrl can 404 while liveUrl still serves)
- **Remove on confirmed dead**: when BOTH cached liveUrl AND endpoint liveUrl are 404 on tango.me → `removeCached(streamerId, force=true)`
- **Remove on 24h**: automatic sweep removes entries older than 24 hours
- That's it.

## What Does NOT Trigger Removal

- masterListUrl returning 404 (the cached liveUrl may still serve segments)
- Stream disappearing from the API response momentarily
- Any transient network error
- `resolveLiveUrl` returning null (can't confirm dead)
- Only when **BOTH** cached liveUrl AND endpoint liveUrl are confirmed 404 on tango.me
