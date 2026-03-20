# Downloader Decisions

## SC: `||` not `??` for streamName fallback

`data.cam?.streamName || roomId` — the SC API sometimes returns `streamName: ""` (empty string). `??` only catches null/undefined, not empty string. StreaMonitor uses Python's `.get("streamName", self.room_id)` which catches any falsy value.

## SC: roomId is cached, streamName is always fresh

roomId never changes for a username — safe to cache permanently. streamName is session-volatile and must be fetched fresh before each download attempt. This matches StreaMonitor's pattern where `getVideoUrl()` calls `getStatus()` to refresh `lastInfo` before every download.

## SC: isCamAvailable/isCamActive gate

The bulk API returns `isOnline` but the per-user `/cam` endpoint has `isCamAvailable` and `isCamActive`. A streamer can be `status: "public"` + `isOnline: true` in bulk but have `isCamAvailable: false` during transitional states (going live/ending). `refreshStreamName` rejects these to avoid wasted CDN requests.

## SC: mouflon decryption

Segments are encrypted with mouflon. Keys are stored in `stripchat_mouflon_keys.json`. The decrypt algorithm: reverse base64, pad with `==`, XOR with cycling SHA256 hash of the decryption key. Mouflon params come from `#EXT-X-MOUFLON:` tags in the m3u8. If psch is `v1`, use the key from the tag. Otherwise fall back to first available key with `v2`.

## SC: master playlist error logs include response body

When the CDN returns errors (Cloudflare challenge pages, 403s, empty responses), the first 500 chars of the body are logged. Without this, debugging CDN issues requires reproducing the failure.

## SC: session reset on CDN failure (discovery path only)

When a master playlist fetch fails or returns no mouflon key, the HTTP session (cookies) is reset on the discovery/API path. Stale Cloudflare cookies accumulate over hours and can cause persistent failures. Download-path fetches (variant playlists, segments) use their own isolated cookie jar via `IDownloadSession` — a 403 on one download cannot nuke cookies for other concurrent downloads.

## FC2: quality selection ported from FC2LiveDL.py

Mode = Quality + Latency. Quality values: 150Kbps=10, 400Kbps=20, 1.2Mbps=30, 2Mbps=40, 3Mbps=50, sound=90. Latency values: low=0, high=1, mid=2. Target: 3Mbps + mid = mode 52. Selection: exact match → best matching latency → highest available.

## FC2: WebSocket session lifecycle

FC2 streams require a WebSocket connection for HLS URL negotiation and heartbeats. Sessions are cleaned up after 60s without access. The `_touchSession` method extracts channel ID from URLs to keep sessions alive during downloads.

## FC2: parseMasterPlaylist receives pre-resolved URLs

The `masterUrl` passed to StreamDownloader is already the variant URL from `getHlsUrl` (WebSocket handshake). If it already contains `.m3u8`, return it directly. Otherwise treat as master playlist.

## Tango: tango.txt is optional

If `tango.txt` has no entries (or doesn't exist), all followed streamers are downloaded. If it has entries, only those streamer IDs are downloaded. Format: `https://tango.me/{accountId} {alias}` — the alias after the space is for human readability only, accountId is the stable identifier.

## Tango: 360x640 resolution is corrupt

Tango sometimes serves segments at 360x640 resolution which are corrupt/unwatchable. These are rejected during validation.

## Stale stream timeout: 60s

Increased from default to 60s to prevent premature SC disconnects during buffering/transcoding lags on the CDN side.

## fMP4 segment validation: sidx box parsing, not ffprobe

SC uses fMP4 segments which can't be ffprobed standalone (no container header in each segment). Duration is extracted by parsing sidx boxes directly from the binary data. Sums durations per timescale (track), returns the max across tracks.

## fMP4 segment renaming

fMP4 streams have non-numeric segment names (hashes). These are renamed to sequential numbers (`{startSequence + count}.ts`) for playlist consistency.

## Playlist tag ownership

When copying segments from live playlists to local playlists, only EXTINF and DISCONTINUITY tags are kept. Live-stream-owned tags (PROGRAM-DATE-TIME, MOUFLON, etc.) are dropped — they belong to the source, not our recording.

## Deferred playlist header write

The playlist header (including TARGETDURATION) is not written until the first segment arrives, so the actual segment duration can be used instead of guessing.

## Quality upgrade: new init segment per switch

When StreamQualityMonitor detects a better variant, a new init segment is downloaded with a numbered name (`init_1.mp4`, `init_2.mp4`). A `#EXT-X-DISCONTINUITY` + `#EXT-X-MAP` marker is inserted in the playlist. The pending upgrade is applied via a flag checked at the top of the download loop to avoid race conditions with the async quality monitor.

## Quality monitor: adaptive polling with exponential backoff

Starts at 10s interval. Doubles on each poll with no upgrade, caps at 5 minutes. Resets to initial interval when an upgrade is detected.

## Orphan stream finalizer: two-pass boot cleanup

First pass runs immediately on boot (catches crashes from before restart). Second pass runs 5 minutes later (catches folders that were too fresh on the first pass — 1 hour age threshold). Then every 24 hours. Orphan playlists missing `#EXT-X-ENDLIST` are rebuilt from files on disk and finalized. Empty folders (no .ts segments) are deleted.

## Orphan stream finalizer: MAP header dedup

When rebuilding orphan playlists, the first `#EXT-X-MAP` tag goes in the header. Subsequent MAP tags (from quality changes) are treated as segment metadata and kept inline with their segments.

## Disk space monitor: 50GB threshold

When available space drops below 50GB, the service stops itself via systemd and creates a marker file (`no-more-space-{date}.txt`) to prevent restart loops.

## RetryCooldown: provider-agnostic backoff

All three discovery services (SC, FC2, Tango) compose with RetryCooldown. Exponential backoff: 30s → 60s → 120s → ... → 10min cap. Cleared on successful download start.

## DownloadResult: return type closes the ownership gap

StreamDownloader.start() returns `{ exitReason, segmentCount }`. Discovery consumes this to decide retry policy. "error" (0 segments) triggers cooldown. "completed" (stream ended naturally) and "aborted" (caller stopped) need no action. This prevents the fire-and-forget pattern where failure info was lost when the handle was dropped.

## Ephemeral downloads (API server, /tmp)

The API server wraps IStreamProvider to redirect downloads to `/tmp/Videos/downloads/tl/{alias}/`. Uses a heartbeat-based cleanup: client reports wanted aliases via POST /api/download/active. If no heartbeat arrives within 60s, all downloads are stopped and directories cleaned up.

## IDownloadSession: per-download HTTP isolation

`IStreamProvider` owns discovery (API calls, master playlist, session management). Download-path HTTP (variant playlists, segments) is owned by `IDownloadSession`, created per download via `createDownloadSession()`. Each download gets its own cookie jar and fetch context. This prevents the root cause of 403 death spirals: `resetSession()` on one download nuking cookies for all concurrent downloads sharing the same `ScClient`. Matches StreaMonitor's pattern of creating a fresh `requests.Session()` per download in `hls.py`.

The `reconnect` mechanism was removed entirely — discovery retries from scratch on failure, and the stale stream timer handles natural stream endings. Quality monitoring continues to work via the provider's discovery methods.

Provider-specific download session behavior:
- **SC**: own cookie jar, mouflon decryption, no session resets — fail-fast on errors
- **Tango**: gets fresh auth tokens per request (already stateless)
- **FC2**: calls `_touchSession` to keep WebSocket alive during downloads
