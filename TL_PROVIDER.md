# TL Provider — Architecture & Flow

## Core Principle

**liveUrl is the source of truth.** A stream is only removed from the list, memory, and IndexedDB when its liveUrl returns a **404 from tango.me**. Nothing else triggers removal.

## Data Model

The `/recommended` endpoint returns streamers with:
- **s** — `streamerId` (unique identifier)
- **m** — `masterListUrl` (HLS master playlist URL on tango.me)

From **m** we resolve:
- **l** — `liveUrl` (720p sub-playlist URL on tango.me) — cached in IndexedDB

### IndexedDB Schema (v3)

Each `CachedStreamer` entry stores all fields needed to reconstruct a full `TlStreamer`:
- `streamerId`, `streamId`, `alias`, `firstName`, `masterListUrl`, `isFollowing`, `parentAlias`, `liveUrl`, `cachedAt`

This allows leftover IDB entries (not in endpoint) to be reconstituted into full streamers for costreamer logic.

### Duplicate vs New

- **Duplicate**: same `s` AND same `m` as an existing entry → skip, don't re-process
- **New**: different `s`, OR same `s` with different `m` (stream restarted) → process

## Flows

### 1. First Load

1. Hit endpoint → get list of `(s, m)` pairs (following + recommended)
2. Add all streamers to the video list with `liveUrl=null`
3. Process each streamer via `resolveStreamerLiveUrl` (IDB-first):
   - Check IDB cache → if cached liveUrl exists → `checkLiveUrl` on tango.me
     - Alive → use cached liveUrl, update store
     - Dead → fall through to masterListUrl
   - Resolve from masterListUrl → success → cache + update store
   - Both cached liveUrl AND masterListUrl failed → remove from IDB
   - Then: fetch co-streamers, resolve each the same way
4. After endpoint list fully consumed → **consume leftover IDB entries**:
   - `getAllCached()` → filter out entries already in streamerMap (by alias)
   - For each leftover: `resolveStreamerLiveUrl` → only add to list if alive
   - If alive: add to list, discover co-streamers (same logic as endpoint entries)
   - If dead: already removed from IDB by `resolveStreamerLiveUrl`
5. Enter the queue loop

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

**`resolveStreamerLiveUrl` — shared resolution helper (IDB-first):**
1. `getCached(streamerId)` → if cached liveUrl → `checkLiveUrl` on tango.me
   - Alive → `putCached(streamer, cachedLiveUrl)`, return
   - Dead → mark `cachedWasDead`, fall through
2. `resolveLiveUrl(masterListUrl)`
   - Success → `putCached(streamer, liveUrl)`, return
   - Fail + cachedWasDead → `removeCached(streamerId, true)`, return null
   - Fail + no cache existed → return null

**Phase 1 — Endpoint fetch + process new:**
1. Hit endpoint → get fresh list of `(s, m)` pairs
2. For each streamer in fresh list:
   - If **duplicate** (same `s` + same `m` already in streamerMap) → skip
   - If **new** (different `s`, or same `s` + different `m`) → add to list, process
3. Process all new/changed streamers: `resolveStreamerLiveUrl` + discover co-streamers
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
2. Queue starts (no Phase 0 — IDB checked inline per-streamer) then enters the loop

### Endpoint vs IDB Leftover Behavior

| Aspect | Endpoint entries | IDB leftover entries |
|--------|-----------------|---------------------|
| When added to list | Immediately with liveUrl=null | Only after liveUrl confirmed alive |
| Resolution | IDB-first → masterListUrl fallback | Same |
| Costreamer logic | Yes | Yes (same) |
| Both 404 | Remove from IDB, stays in list with null | Remove from IDB, never added to list |

## IndexedDB Cache Rules

Simple:
- **Store**: on successful liveUrl resolution → `putCached(streamer, liveUrl)` (stores all streamer fields)
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
