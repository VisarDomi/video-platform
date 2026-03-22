# Downloader Decisions

## Download loop must be boring (2026-03-21, updated 2026-03-22)

The download loop has no concurrent timers, no shared mutable state. Quality checks are inline. Segment failure stops the download. The stale timeout (60s with no new segments) is the only exit condition for transient failures.

On variant playlist failure (404/403), the loop asks the provider to find an alternative via `recoverVariant()` instead of dying. SC tries all 3 CDN TLDs in parallel; tango/fc2 return null (no multi-edge CDN). If no recovery is found, the loop sleeps and retries until the stale timeout exits. This replaced the old "one failure = death = new folder" behavior that split single streams into dozens of directories on CDN edge rotations.

**Why (original):** The concurrent `StreamQualityMonitor` timer caused zombie downloads. The 0o_NON_o0 incident ran for over an hour with only 16 segments.

**Why (update):** The "any failure = stop" rule correctly killed zombie downloads but also killed healthy downloads on transient CDN edge rotations. The akaneppi_ session was split into 5 folders with 30min of lost content because each 404 created a new directory. The recovery is provider-scoped (not generic self-healing) and every transition is logged (EDGE-SWITCH, EDGE-DEDUP, EDGE-GAP).

## No silent recovery — every transition is logged

Recovery from CDN failures is allowed, but every state change must be visible in logs. No silent catches, no fallback-to-success on failure, no counter resets on non-download events.

**Why:** Three rounds of "fixes" added self-healing that masked symptoms. The distinction: the old self-healing was invisible (reset counters, swallow errors). The new recovery is explicit — EDGE-SWITCH logs the old and new edge, EDGE-DEDUP logs each skipped segment with its PROGRAM-DATE-TIME, EDGE-GAP logs content loss duration.

## Room IDs are the source of truth for SC

The stable identifier is the numeric room ID, not the username. Usernames can be renamed. Room IDs are resolved once at add-time by the server, persisted in sc.txt, and never re-resolved during polling.

**Why:** Four accounts were 404-ing on every 5-second poll (16 warn lines/minute) because they were renamed/deleted. The old code resolved usernames to room IDs on every poll cycle — if the username was stale, it failed silently and the streamer was never monitored.

## Flat 20s cooldown, no exponential backoff

**Why:** Exponential backoff (30s→10min) meant a transient 403 at 3am could escalate to 10-minute waits, missing the stream entirely. StreaMonitor uses a flat 20s sleep. If the stream is gone, the bulk status check prevents downloads — the backoff doesn't need to gate retries.

## CDN TLD round-robin, not random

**Why:** Random pick from 3 TLDs has 33% chance of hitting the same one that just rejected us. Round-robin guarantees a different edge on each retry.

## Quality monitoring is inline, not concurrent

The quality check runs inside the download loop on the same thread. No timer, no shared mutable field, no races.

**Why:** The concurrent `StreamQualityMonitor` timer was the root cause of the zombie download bug. It wrote to `pendingUpgrade` which the download loop consumed — but TLD flips triggered phantom quality changes every 10 seconds, each resetting failure counters and the stale timeout.

## Segment failure stops the download

**Why:** The previous behavior (break inner loop, continue outer loop) meant a persistently failing segment was retried every second for 60 seconds. StreaMonitor stops immediately — if a segment can't be fetched, the session is probably dead.

## Fetch timeout on all HTTP calls (30s)

**Why:** Node's fetch has no default timeout. A CDN that accepts a TCP connection but never responds hangs the download forever — no heartbeats, no exit, no recovery. The absence of log output is impossible to notice at 3am.

## No cookie accumulation across API calls

**Why:** The old cookie jar merged Set-Cookie headers from all API calls for all 43 streamers. A bad Cloudflare cookie from one request poisoned every subsequent request. StreaMonitor's `_reset_session()` works by dropping all cookies; we achieve the same by never accumulating them.

## SC mouflon decryption returns null, not raw content

**Why:** The old code returned the encrypted playlist as-is when decryption failed. The download loop parsed it as HLS, found encrypted gibberish URIs, and tried to fetch them — producing generic "segment download failed" logs with no hint that decryption was the root cause.

## SC streamName uses `||` not `??`

**Why:** The API sometimes returns `streamName: ""`. Nullish coalescing doesn't catch empty strings.

## SC bulk status uses `isLive`, not `isOnline` (2026-03-22)

The bulk API (`/api/front/models/list`) returns both `isOnline` and `isLive`. Use `isLive`. The old code used `isOnline` which returns `false` for some streamers that are actively broadcasting (`status=public`, `isLive=true`, cam API confirms `isCamAvailable=true`). The cam API's `isCamActive` is the per-streamer confirmation; the bulk API's `isLive` is the bulk equivalent.

**Why:** Sui_Hcup was live and visible in the browser but the downloader skipped it because `isOnline=false`. The `/cam` endpoint confirmed the stream was active. `isOnline` appears to track a different concept (possibly account online status vs active broadcast).

## SC isCamAvailable/isCamActive gate before download

**Why:** A streamer can be `public` + `isLive` in the bulk API but have `isCamAvailable: false` during transitional states. Downloading during this window wastes CDN requests that will fail.

## fMP4 duration from sidx boxes, not ffprobe

**Why:** SC fMP4 segments can't be ffprobed standalone — they have no container header.

## Tango 360x640 rejected

**Why:** Tango sometimes serves corrupt/unwatchable segments at this resolution.

## InitTracker owns mapUri↔file atomicity (2026-03-22)

The `currentMapUri` state only advances after the init file is confirmed written to disk. If the download or write fails, the tracker stays at the previous mapUri and the next loop iteration retries. The segment count lives in the tracker (not a bare variable in the loop) because it determines init filenames.

**Why:** The old code set `currentMapUri` unconditionally after `writeFile`. A silently failed init write left the tracker thinking the file existed, permanently preventing retry. Combined with `insertQualityChange` writing to the playlist before the header existed, this produced playlists starting with `#EXT-X-DISCONTINUITY` instead of `#EXTM3U` (Mio_ecstasy incident).

## PlaylistManager buffers quality changes (2026-03-22)

Quality changes are buffered via `bufferQualityChange()`, not appended directly to the playlist file. They're flushed atomically with the header when the first segment is appended.

**Why:** `insertQualityChange` used `appendFile` which created the playlist file if it didn't exist. If a quality change happened before any segment was appended, the file started with DISCONTINUITY+MAP. When the first segment was later appended, `writeFile` (overwrite) for the header destroyed the quality change entries.

## Auth health via file mtime, not token TTL (2026-03-22)

The downloader checks the session file's mtime to detect whether the auth service is alive. If the file is older than 15s (3 missed auth cycles), it logs once. It does NOT inspect or validate token TTL values.

**Why:** The auth service owns the tokens. The 10s TTL stream tokens normally have 2-7s remaining when the downloader reads them (5s auth write cycle, 5s downloader read cycle, random alignment). A `MIN_TTL_SECONDS=3` check treated this normal operation as an error, causing force-reloads and warning spam on every token read.

## SC edge failover via parallel TLD resolution (2026-03-22)

On variant 404/403, `ScClient.recoverVariant()` fetches the master playlist from all 3 TLDs (.org/.com/.net) in parallel. Returns the best variant from whichever TLD responds. Different TLDs can disagree on stream availability — proven from logs where .org returned 404 while .com returned 200 for the same stream.

Edge switch within the same session uses PROGRAM-DATE-TIME-based dedup to skip segments already downloaded from the previous edge. Quality change on edge switch is handled naturally by InitTracker (different MAP URI triggers new init). A new download session is created on recovery — the old session's CDN connection state is stale.

**Unverified claim (defensive):** Different SC CDN edges share the same broadcast PROGRAM-DATE-TIME for the same content moment. Logs (EDGE-DEDUP, EDGE-GAP) will prove or disprove this on the next edge rotation.

## Disk space monitor stops the service at 50GB

**Why:** Prevents the disk from filling completely, which would corrupt in-progress recordings and potentially the OS. A marker file prevents restart loops.
