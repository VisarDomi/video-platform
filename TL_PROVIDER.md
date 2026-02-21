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

### 1. First Load (no IndexedDB, no memory)

1. Hit endpoint → get list of `(s, m)` pairs (following + recommended)
2. Add all streamers to the video list
3. Start processing queue top-to-bottom:
   - For each streamer: resolve **l** from **m** (backend parses master m3u8)
   - If resolved → cache **l** in IndexedDB, update store
   - If failed → check IndexedDB for cached **l**. If exists, use it. If not, stream stays without liveUrl (unplayable until next cycle resolves it)
   - Then: fetch co-streamers for this streamer
   - For each unique co-streamer: add to list after parent, resolve its **l**
4. Continue until last stream processed

### 2. Video Playback (organic liveUrl check)

When a video is opened/navigated to:
1. Proxy starts → backend fetches **l** from tango.me to serve the m3u8
2. If tango.me returns **200** → segments are served, video plays
3. If tango.me returns **404** → stream is dead:
   - Backend proxy returns 404 status + `X-TL-LiveUrl-Dead: true` header
   - Frontend detects this via HLS.js error handler
   - Stream is removed from: video list, streamerMap (memory), IndexedDB cache
4. Same logic applies when navigating between videos

### 3. 30-Second Refresh Loop

While on TL provider, every 30 seconds:
1. Hit endpoint → get fresh list of `(s, m)` pairs
2. For each streamer in fresh list:
   - If **duplicate** (same `s` + same `m` already in streamerMap) → skip
   - If **new** (different `s`, or same `s` + different `m`) → add to list, queue for processing
3. Process all new/changed streamers through the same queue as first load (liveUrl + co-streamers)

### 4. Return to TL (after provider switch)

1. Restore in-memory snapshot (instant visual restore)
2. 30s interval continues — next tick picks up any changes

## IndexedDB Cache Rules

Simple:
- **Store**: on successful liveUrl resolution → `putCached(streamerId, masterListUrl, liveUrl)`
- **Never overwrite** a cached liveUrl with null (masterListUrl can 404 while liveUrl still serves)
- **Remove on 404**: when liveUrl confirmed dead on tango.me → `removeCached(streamerId, force=true)`
- **Remove on 24h**: automatic sweep removes entries older than 24 hours
- That's it.

## What Does NOT Trigger Removal

- masterListUrl returning 404 (the cached liveUrl may still serve segments)
- Stream disappearing from the API response momentarily
- Any transient network error
- Only a **true HTTP 404 from tango.me on the liveUrl** removes a stream
