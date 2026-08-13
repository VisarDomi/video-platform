# Downloader Decisions

## `.active` plus recording identity owns restart recovery

The downloader writes new recordings under
`<provider>/downloader/.active/<timestamp alias>/`. Shutdown and transport/API
failure leave the directory active without ENDLIST. Provider snapshots decide
whether the recording resumes or ends: the same recording identity resumes,
a different identity or upstream ENDLIST ends immediately, and successful
absent/non-public observations must span 60 seconds with no media progress.
Unavailable provider responses never finalize media.

After ENDLIST is atomically published, the directory is atomically moved to the
provider's hidden `.pending` root for server ownership. `live-status.json` is
only runtime display state. New segment names contain monotonic local number,
provider recording identity, and HLS media sequence. Within one recording
identity, the downloader accepts only a sequence above its constant-sized
high-water mark, reconstructed from the playlist on restart. FC2 segment URI
numbers may reset while their semantic HLS sequence continues by playlist
position; URI resets therefore remain accepted without treating an overlapping
old HLS window as new media. Legacy numeric filenames remain readable but are
not guessed as resumable identities.

FC2 discovery uses one adult all-channel-list request no more often than every
30 seconds. Tango `streamId`, FC2 `start_time`, and Stripchat
`statusChangedAt` are the respective recording identities.

Folder names retain local timestamps chosen by the application. UTC identities
supplied by a provider retain the provider's `Z` standard while omitting time
colons: `2026-08-12T09:08:47Z` is stored visibly as
`2026-08-12T090847Z`. Provider snapshots and parsed filenames use the same UTC
canonicalizer. URI percent escapes are not stored in media filenames.

## ENDLIST transfers finalized-media ownership to the server

The downloader owns transport and active playlist append only. Tango/FC2 write
the received bytes, reject only an empty/unreadable file, and do not spawn
ffprobe per media segment. Upstream EXTINF remains provisional while the stream
is live.

`PlaylistManager.finalizePlaylist()` atomically writes `#EXT-X-ENDLIST` before
the `.active` directory is moved into the provider's hidden `.pending` root.
That rename is the durable handoff to the server. The server owns publication,
strict decoding, failed-segment repair, desktop-Trash discard, discontinuity
insertion, and authoritative duration repair after capture.

**Why:** Transport success and media decodability are separate concerns.
Metadata-only per-segment probing did not detect the corrupt packets that froze
playback, and full decoding belongs after the stream is complete.

## StreamSession owns the recording lifecycle

One session = one folder. StreamSession owns DiskSession, PlaylistManager, InitTracker, and the retry loop. StreamDownloader is a single download attempt that receives these as inputs — it doesn't create, finalize, or remove anything.

After each download attempt exits, the session may use the latest successful
provider snapshot to resolve a fresh URL, but it does not infer completion from
transport failure. Shared snapshot reconciliation owns the recording lifecycle:

- **SC:** bulk public/live status plus `statusChangedAt` from the cam detail API.
- **Tango:** bulk account lookup with `streamId`.
- **FC2:** the adult all-channel list with `start_time`, requested no more than once per 30 seconds.

**Why:** The old architecture created a new folder for every download attempt. A single CDN edge rotation split one stream into 5+ folders with 30min of lost content.

## Discovery normalizes to session candidates

Provider discovery code owns only provider-specific knowledge: target parsing, status APIs, public/paid rules, stream-name refresh, and master URL derivation. Once a provider has `{ streamerId, alias, masterPlaylistUrl }`, `startStreamSession` owns the common lifecycle: add to `DownloadsManager`, create `StreamSession`, register abort/completion, and update zero-segment cooldown state.

**Why:** Tango, SC, and FC2 had repeated session-start code with subtly different logs. The shared helper keeps one writer for download lifecycle registration while preserving provider ownership of discovery decisions. Runtime proof after the change: Tango account lookup started public targets from `tango.txt`, FC2 started a live target after `fc2.txt` changed, and SC continued to start public active targets through its cam API path.

## Download loop: no concurrent timers, no shared mutable state

Quality checks are inline. The stale timeout (60s) is the exit condition. On variant 404/403, the loop asks `recoverVariant()` for an alternative. If no recovery, the loop sleeps and retries until stale timeout.

**Why:** The concurrent `StreamQualityMonitor` timer was the root cause of the zombie download bug.

## SegmentFetchResult: timeout vs HTTP error

`fetchSegment` returns `{ data, retryable }`. Timeouts are retryable (skip the segment, continue). HTTP errors are fatal (stop the download).

**Why:** An 800-segment session was killed because one segment timed out (30s AbortSignal). The old code treated all null returns as fatal.

## No silent recovery — every transition is logged

Recovery from CDN failures is allowed, but every state change must be visible in logs: EDGE-SWITCH, EDGE-DEDUP, EDGE-GAP, session retry with reason.

**Why:** Three rounds of invisible self-healing masked root causes for weeks.

## Nothing on disk until first byte write

DiskSession defers dir creation to the moment the first segment or init byte is
ready to be written. DiskSession owns the DownloadHandle; when the dir is
created, the informational `live-status.json` view is updated. Lifecycle and
completion never depend on that JSON file.

**Why:** The old code created dirs eagerly. If the variant URL was broken, an empty dir existed with no playlist. The frontend showed it as a video, tried to load the playlist, got a 500.

## InitTracker owns mapUri-file atomicity

The `currentMapUri` state only advances after the init file is confirmed written to disk. The segment count lives in the tracker because it determines init filenames.

**Why:** The old code set `currentMapUri` unconditionally after `writeFile`. A silently failed init write permanently prevented retry.

## PlaylistManager buffers quality changes

Quality changes are buffered via `bufferQualityChange()`, flushed atomically with the header when the first segment is appended.

**Why:** `insertQualityChange` used `appendFile` which created the playlist before the header existed. The header overwrite then destroyed the quality change entries.

## Graceful shutdown: abort without finalization

On SIGTERM/SIGINT, `DownloadsManager.shutdownAll()` aborts all active sessions
and awaits their completion promises. The folders remain under `.active`
without ENDLIST so the next process can compare recording identity and resume.

**Why:** Process shutdown is not evidence that the remote broadcast ended.

## Server serves active playlists and publishes validated recordings

The HLS route reads the playlist file directly. No `ensurePlaylist`, no
`generatePlaylist`, no `fixTargetDuration` at serve time. The downloader owns
active append correctness. Once ENDLIST is written and the directory is handed
to `.pending`, the server's idempotent finalized-recording processor owns crash
recovery, validation, corruption repair, canonical playlist repair, and final
publication.

ENDLIST moves the directory only from `.active` to hidden `.pending`. This is a
handoff, not final publication. The server alone moves a validated `.pending`
recording into the visible downloader root.

**Why:** `ensurePlaylist` was a healer masking bugs. `generatePlaylist` (the fallback for missing playlists) had a 2.0s duration fallback that broke iOS Safari. Both removed.

## Finalized MPEG-TS duration includes the longest media stream

The server's finalized-playlist repair uses `max(video duration, audio
duration)` for playlist `#EXTINF` when adjacent video PTS cannot provide the
timeline. Container duration is used only when neither media stream has a
positive duration. During capture, Tango and FC2 retain upstream EXTINF without
probing every segment.

**Why:** Some botched segments contain almost no advancing video while audio
continues. Safari presents that interval as frozen video with continuing audio.
Using only video duration made the playlist timeline shorter than the media
Safari actually presented and made time-based editing inaccurate.

## SC bulk status uses `isLive`, not `isOnline`

The bulk API returns both. `isOnline` returns `false` for some actively broadcasting streamers. `isLive` is the correct field.

## SC skip NAME="source" variant

The "source" variant is the raw broadcaster feed — the CDN restricts it with 403. Select the highest bandwidth transcoded variant instead.

## No token cache — read from disk on every request

TokenManager has no watcher, no cache. `getTokens()` reads the session file on every call.

**Why:** The watcher cached tokens for up to 5s. With 10s TTL, a token read at 4.7s cache age had 0.3s remaining — not enough for network latency. Reading from disk costs ~15ms on SSD; the network fetch that follows takes 50-200ms.

## Tango API timing: derive from TTL source of truth

`TANGO_STREAM_TOKEN_TTL_S=10` and `TANGO_SESSION_TOKEN_TTL_S=3600` are the external API constants. Refresh cadences derive as half the TTL. All other Tango timing thresholds derive from these.

## All timing constants in one file

`common/timing.ts` contains every timing value as a named constant. No inline magic numbers.

**Why:** Timing values were scattered across 16 files as bare numbers.

## Flat cooldown, no exponential backoff

20s cooldown after a 0-segment session.

**Why:** Exponential backoff (30s-10min) meant a transient failure at 3am could escalate to 10-minute waits.

## FC2 skip paid streams from the adult channel list

The adult channel-list endpoint marks paid streams with `pay != 0`. Only
download entries with `pay == 0`.

**Why:** A paid broadcast can be live while its HLS WebSocket handshake remains
unavailable without payment.
