# Downloader Decisions

## StreamSession owns the recording lifecycle (2026-03-22)

One session = one folder. StreamSession owns DiskSession, PlaylistManager, InitTracker, and the retry loop. StreamDownloader is a single download attempt that receives these as inputs — it doesn't create, finalize, or remove anything.

After each download attempt exits, the session calls `provider.shouldRetry(context)` with the exit reason, last master URL, and last live URL. The provider owns the "is this stream still live?" decision because the source of truth differs per platform:

- **SC:** cam API (isCamActive). On any exit, check the API. If still active, build fresh master URL.
- **Tango:** liveUrl is the source of truth (the following feed is stale). On fetch-failed (401 token timing), retry same master URL. On stale-timeout or segment-failed, try the feed for a new URL.
- **FC2:** memberApi (is_publish). If still online, get fresh HLS URL.

**Why:** The old architecture created a new folder for every download attempt. A single CDN edge rotation split one stream into 5+ folders with 30min of lost content. StreaMonitor's bot pattern — download until you can't, check status, retry — avoids this.

## Download loop: no concurrent timers, no shared mutable state

Quality checks are inline. The stale timeout (60s) is the exit condition. On variant 404/403, the loop asks `recoverVariant()` for an alternative (SC tries all 3 TLDs in parallel; tango/fc2 return null). If no recovery, the loop sleeps and retries until stale timeout.

**Why:** The concurrent `StreamQualityMonitor` timer was the root cause of the zombie download bug.

## SegmentFetchResult: timeout vs HTTP error

`fetchSegment` returns `{ data, retryable }`. Timeouts are retryable (skip the segment, continue). HTTP errors are fatal (stop the download). This prevents killing sessions over a single slow CDN response.

**Why:** mei_love's 800-segment session was killed because one segment timed out (30s AbortSignal). The old code treated all null returns as fatal.

## No silent recovery — every transition is logged

Recovery from CDN failures is allowed, but every state change must be visible in logs: EDGE-SWITCH, EDGE-DEDUP, EDGE-GAP, session retry with reason.

**Why:** Three rounds of invisible self-healing masked root causes for weeks.

## Nothing on disk until first byte write

DiskSession defers dir creation to the moment the first segment or init byte is ready to be written. DiskSession owns the DownloadHandle — when the dir is created, live-status.json is updated atomically.

**Why:** The old code created dirs eagerly. If the variant URL was broken, an empty dir existed with no playlist. The frontend showed it as a video, tried to load the playlist, got a 500.

## InitTracker owns mapUri↔file atomicity

The `currentMapUri` state only advances after the init file is confirmed written to disk. The segment count lives in the tracker because it determines init filenames.

**Why:** The old code set `currentMapUri` unconditionally after `writeFile`. A silently failed init write permanently prevented retry (Mio_ecstasy incident).

## PlaylistManager buffers quality changes

Quality changes are buffered via `bufferQualityChange()`, flushed atomically with the header when the first segment is appended.

**Why:** `insertQualityChange` used `appendFile` which created the playlist before the header existed. The header overwrite then destroyed the quality change entries.

## Graceful shutdown: abort + await finalization

On SIGTERM/SIGINT, `DownloadsManager.shutdownAll()` aborts all active sessions and awaits their completion promises. Each session finalizes its playlist before exiting.

**Why:** The old `process.exit(0)` killed downloads mid-write, leaving playlists without `#EXT-X-ENDLIST`. The orphan finalizer was the only recovery, running hours later.

## Server serves, not heals

The HLS route reads the playlist file directly. No `ensurePlaylist`, no `generatePlaylist`, no `fixTargetDuration` at serve time. The downloader owns playlist correctness; the orphan finalizer (in server) owns crash recovery.

**Why:** `ensurePlaylist` was a healer masking bugs. `generatePlaylist` (the fallback for missing playlists) had a 2.0s duration fallback that broke iOS Safari. Both removed.

## SC bulk status uses `isLive`, not `isOnline`

The bulk API returns both. `isOnline` returns `false` for some actively broadcasting streamers. `isLive` is the correct field.

**Why:** Sui_Hcup was live but the downloader skipped it because `isOnline=false`.

## SC skip NAME="source" variant

The "source" variant is the raw broadcaster feed — the CDN restricts it with 403. Select the highest bandwidth transcoded variant instead.

**Why:** mayu_nyann was stuck in an infinite recovery loop on the restricted source variant.

## No token cache — read from disk on every request (2026-03-22)

TokenManager has no watcher, no cache. `getTokens()` reads the session file on every call. The token is always fresh because it was just read.

**Why:** The watcher cached tokens for up to 5s. With 10s TTL, a token read at 4.7s cache age had 0.3s remaining — not enough for network latency. This caused intermittent 401s that the session recovered from but shouldn't have happened. Reading from disk costs one file read per playlist fetch (~15ms on SSD). The network fetch that follows takes 50-200ms. The disk read is negligible.

## Tango API timing: derive from TTL source of truth

`TANGO_STREAM_TOKEN_TTL_S=10` and `TANGO_SESSION_TOKEN_TTL_S=3600` are the external API constants. Refresh cadences derive as half the TTL (5s, 30min). All other Tango timing thresholds derive from these.

**Why:** The old code had 5000ms and 30min hardcoded in multiple packages, diverging silently.

## All timing constants in one file

`common/timing.ts` contains every timing value as a named constant. No inline magic numbers. No config.json. Values are executive decisions, not derived from external sources (except Tango TTLs in shared).

**Why:** Timing values were scattered across 16 files as bare numbers. The same value (30s CDN timeout) was hardcoded independently in 3 providers.

## Flat cooldown, no exponential backoff

20s cooldown after a 0-segment session. Logs "live again after cooldown" when a streamer is detected live immediately after cooldown expiry — this data will show if 20s is too long.

**Why:** Exponential backoff (30s→10min) meant a transient failure at 3am could escalate to 10-minute waits.

## FC2 skip paid streams (fee>0) (2026-03-22)

The memberApi returns `fee>0` for paid streams. Only download `fee=0`.

**Why:** Paid streams pass the `is_publish` check but the WebSocket handshake for HLS URL retrieval fails without payment, causing "online but failed to retrieve HLS URL" warnings every 60s.

## No frontend playlist cache (2026-03-22)

`fetchAndParsePlaylist` reads from the server on every call. No Map cache.

**Why:** Frontend logging showed playlist fetches take 13-45ms on localhost HTTPS (median 18ms). Cache hit rate was 10%. The cache saved 18ms on revisits but froze `isLive` state, causing live streams to appear as VOD.

## Frontend passthrough logging (2026-03-22)

`POST /api/log` accepts `{ event, data }` from the frontend, writes to the server journal with `[Frontend]` tag. Fire-and-forget, no batching.

**Why:** The frontend is a client-side SPA with no logging. Performance claims (cache saves Xms) couldn't be verified without data.

