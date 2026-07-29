# Monorepo Decisions

## Ownership: Video is a self-contained unit (2026-04-05)

Every piece of state about a video belongs to the video itself. The `Video` type carries `provider` alongside `filename`, `type`, `duration`, `size`, `isLive`. Operations derive context from the video object — no threading `provider` through function args from external stores.

**Backend:** `VideoRef` (`filename`, `provider`, `type`, `dirPath`) is resolved once at the API boundary via `resolveVideo(filename, provider)`. Services receive the ref, never re-resolve. No cross-provider directory search — `findVideoPath()` (global 12-dir search) was replaced with provider-scoped resolution.

**Frontend:** `fetchVideos` stamps `provider` on each video at fetch time. `playerStore`, `videoActions`, `VideoEngine`, and `hls.ts` read provider from the video itself.

**Why:** The old `findVideoPath()` searched all providers. A tango video could match an fc2 path. The frontend threaded `videoListStore.selectedProvider` through 5 layers of function calls — fragile and easy to desync.

## Ownership: Per-unit UI overlay (2026-04-05, updated 2026-07-29)

Each of the 3 carousel player slots is a self-contained `PlayerUnit`: a wrapper
containing its `<video>` and imperative `OverlayView`. The overlay is a child of
the unit's DOM, so the video and its UI move together during vertical navigation.

The original Svelte-specific implementation of this ownership rule is retained
in `packages/app/src_old` as migration reference only.

**Why:** The old architecture had one shared overlay separate from the video elements. During peek swipe, the overlay required manual transform sync, hide/show coordination, and caused UI jank (stale data flash on navigation commit). The tango userscript's `StreamUnit` pattern proved that each slot should own its complete UI.

## Ownership: Each unit feeds its own state (2026-04-05)

Each unit's `timeupdate` handler writes to its own `PlayerOverlayState` at 4Hz, regardless of active/inactive status. Preloaded units show real time/duration data during peek.

The active-only gate remains for: localStorage progress save (global), engine's gesture-facing fields (`_currentTime`, `_duration`, `_seekableEnd`).

**Why:** The old active-only gate was from the shared-overlay era where only one set of time values existed. With per-unit state, each unit should feed its own data.

## Ownership: No shadow state — derive from the slot (2026-04-05)

`VideoEngine` has no `currentFilename` field. Whether a video changed is derived from `unit.video.dataset.loadedFilename` — the actual content loaded in the slot. The slot is the source of truth.

**Why:** The old `currentFilename` shadow field diverged from reality after carousel rotation. Going back to list and re-opening the same video showed a different video because `currentFilename` matched but the slot had rotated to different content.

## Frontend diagnostic logging removed (2026-07-29)

The frontend `LogService`, watchdog/sentinel events, and server `/api/log`
passthrough are removed. Recovery now responds directly to `pagehide`,
`pageshow`, visibility, and connectivity events. Browser console errors remain
available for development without maintaining a persistent application logging
subsystem.

## HLS routes include provider (2026-04-05)

`/hls/:provider/:filename/playlist.m3u8` instead of `/hls/:filename/playlist.m3u8`. The server resolves within the provider's directories only.

**Why:** The old route searched all providers. The frontend already knew the provider but threw it away at the API boundary.

## Cross-process resource ownership

Single writer per resource, no cross-process write contention.

| Resource | Writer | Readers |
|---|---|---|
| `aliases.json` | server (AliasRegistry.refresh, hourly) | server only (frontend via /api/tango/list) |
| `tango.txt` | server (routes + AliasRegistry.syncTangoTxt) | downloader TangoTargetManager |
| `live-status.json` | downloader (DownloadsManager) | server (orphan finalizer) |
| session tokens on disk | auth daemon | server + downloader (shared readTokens()) |

## Frontend gestures preserve Safari navigation ownership (2026-07-29)

Safari owns leading-edge Back and tab/history navigation. The viewer owns only
gestures that begin outside the browser edge zone and have been classified as
vertical video navigation, horizontal seek, controls, or zoom.

- Do not call `preventDefault()` for a touch beginning in the leading-edge zone.
- Call `preventDefault()` only after an application-owned axis is known.
- Keep `touchcancel` handling and animation locks so gesture state cannot get stuck.
- Rotate three complete player units for vertical video navigation.
- Commit viewer-to-viewer navigation with `history.replaceState()`, preserving
  the list as the previous history entry.

**Why:** Browser navigation and bfcache restoration now replace the old custom
edge-back and SPA view-state machinery.

## Video lists use the full native document (2026-07-29)

Render every provider-list row as an ordinary anchor in normal document flow.
There is no virtualizer, spacer, fixed row-height calculation, filter, or scroll
correction. Safari owns scrolling and bfcache scroll restoration.

On a bfcache `pageshow`, immediately refetch and reconcile the list without
moving the viewport, then resume exactly one poller. Highlight the last-viewed
filename but do not scroll to it.

## Edit cuts are audited as WYSIWYG marker mapping (2026-05-10)

Cut/edit behavior has two owners:

- Frontend owns WYSIWYG marker intent. Markers are browser playback times from the visible player. When the browser's playable duration differs from playlist `#EXTINF` duration, the frontend maps marker times onto playlist time before choosing `.ts` segment names.
- Backend owns file operations. It accepts explicit segment names, verifies they exist, moves exactly those files, and derives the edited playlist from the original playlist plus the requested segment set.

Evidence from logs on 2026-05-10 showed browser duration can diverge from playlist duration near the tail. Examples:

- `2026-05-10 070628 elliiieeee`: playlist `497.87s`, browser ended at `481.529s`.
- `2026-05-10 014252 nektarinka`: playlist `824.078s`, browser ended at `795.053s`.
- `2026-05-09 235946 nektarinka`: playlist `480.314s`, observed ended positions varied around `476.884s` to `480.214s`.

For historical cuts, backend execution matched the frontend request: frontend calculated segment count, API request count, backend matched count, and derived playlist kept count all agreed. The missing evidence was user intent: old logs had `timeMarkers` count, first/last kept segment, and count, but not the raw marker times. New `edit-segments-calculated` logs must include `markerTimes`, `playbackDuration`, `playbackToPlaylistScale`, and `scaledRanges` so future investigations can answer whether the frontend request matched what the user marked visually.

Do not move WYSIWYG time interpretation into the backend unless the API contract changes to accept marker ranges plus playback duration. Under the current contract, backend should remain a segment-file executor, not a second timeline interpreter.

The visible current segment name belongs to the same timeline ownership boundary. Playlist parsing produces ordered segment metadata (`name`, `start`, `end`); `PlaybackTimeline` maps browser playback time to playlist time and current segment; `PlayerOverlay` only renders `currentSegmentName`. Do not make the overlay parse manifests or infer segment names from filename numbering.

## Ownership: Playlist timeline decides terminal playback state (2026-05-11)

For VOD playback, parsed `playlist.m3u8` duration and segment intervals are the frontend source of truth once available. Native media fields such as `duration` and `ended` are observations, not authority, because native HLS can collapse `media.duration` to the current playhead and fire `ended` while `seekableEnd` and the playlist still prove playable media remains.

`PlaybackTimeline` owns terminal classification through `assessNativeEnded()`. It compares the native ended event against playlist/seekable truth and returns an explicit verdict:

- `playback-ended-confirmed` when the playlist authority is exhausted, or when no playlist/seekable authority exists.
- `native-ended-rejected` when native HLS reports ended but playlist/seekable truth still has remaining media.

`VideoEngine` only wires browser events into this authority and emits the verdict. It must not self-heal by nudging currentTime, auto-resuming, or masking the native failure. If native HLS rejects terminal state, the error is surfaced in logs with current segment, playlist time, terminal time, remaining time, media duration, and seekable end.

## Ownership: playlist.m3u8 is the HLS media timeline authority (2026-05-11)

`playlist.m3u8` is the canonical timeline artifact for HLS VOD folders. Do not add a sidecar timeline file for segment durations. If a playlist cannot be trusted, repair or reject the playlist itself and surface the reason in logs/API output.

The root bug was treating MPEG-TS container duration as playback truth. Safari/iOS follows the media timeline, not the TS container span. A global frontend scale between browser duration and playlist duration can align endpoints while still assigning intermediate frames to the wrong `.ts`; segment identity and edit cuts must be grounded in one canonical playlist timeline.

Safari/iOS mismatch evidence from `2026-05-10 235819 milkyway999` showed the old `#EXTINF` values matched ffprobe `format.duration`, but that was the wrong clock:

- Old playlist/format total: `2247.684252s`.
- Video stream total: `2127.746011s`.
- Audio stream total: `2123.703008s`.
- Rewritten playlist total using video PTS advancement: `2127.729645s`.
- The edit discontinuity `433.ts -> #EXT-X-DISCONTINUITY -> 438.ts` was preserved.
- After rewrite, frontend logs showed `playlist-fetch totalDuration=2127.729645`, native duration/seekable end around `2127.729s`, playback reached `2137.ts`, and terminal verdict changed from rejected early-ended events with `9-12s` remaining to `playback-ended-confirmed`.

The correct duration source is the media timeline Safari plays, not the MPEG-TS container span. `PlaylistAuthority` repairs historical playlists by probing segments and writing `#EXTINF` from video PTS advancement within each continuity section, falling back to stream duration at discontinuities/tails. It recomputes `#EXT-X-TARGETDURATION` and publishes via temp file + rename.

Future downloader writes must use media stream duration for `accurateDuration`. Tango/FC2 segment validation must not pass `format.duration` to `PlaylistManager`; the preferred order is video stream duration, audio stream duration, then format duration only as a fallback. Edit playlists inherit canonical `#EXTINF` from the source playlist, so historical source playlists should be repaired before editing old recordings.

For `.ts` historical repair, `PlaylistAuthority` should parse MPEG-TS bytes before spawning ffprobe. The common-case duration is `firstVideoPts(next segment) - firstVideoPts(current segment)`, read from PES PTS timestamps. This matched the ffprobe-derived good playlist for `2026-05-10 235819 milkyway999` exactly across `2126` adjacent segment boundaries and reduced that repair from thousands of ffprobe calls to byte probes plus two ffprobe fallbacks. ffprobe remains the fallback for boundaries that TS bytes cannot define alone, such as the segment before a discontinuity and the final tail segment.

fMP4 is not part of the MPEG-TS repair. Playlists with `#EXT-X-MAP` are skipped with `skipped:true`, `skipReason:"fmp4-map"`, and zero byte/ffprobe probes. SC already writes fMP4 durations from `sidx` parsing, so the TS repairer must not touch it unless there is a separate SC-specific bug.

Historical batch results:

- FC2 `scope=all` ran on 2026-05-11 from `11:43:28` to `11:51:24`; repaired `120` playlists, processed `337823` segments, failed `0`, and removed about `9087.536333s` from playlists.
- Tango `scope=all` ran on 2026-05-11 from `11:53:50` to `13:11:52`; repaired `3014` playlists plus one already-correct long sample, processed `2101775` segments, failed `0`, and removed about `81544.660632s` from playlists.
- Active downloader folders are skipped from downloader-scope batch repair via `live-status.json`.

Operational behavior:

- Repair is idempotent: rerunning a fixed playlist should produce `changedDurationCount:0` and `wrotePlaylist:false`.
- Repair is crash-safe per playlist: writes use temp file + rename, so power loss leaves either the old playlist or the complete repaired playlist.
- Batch repair is not checkpointed. If interrupted, rerun is safe but starts scanning from the beginning.

Ownership boundary:

- Downloader owns active playlist append for new live captures and writes media-duration `#EXTINF` when each segment is accepted.
- Server `PlaylistAuthority` owns historical/batch repair and any operational rewrite of finalized playlists.
- HLS routes serve playlists read-only and must not silently heal on GET.
- Frontend timeline code reads the playlist authority and logs mismatches; it must not hide native playback errors with auto-resume behavior.

Remaining hardening:

- Add tests for `PlaylistAuthority` parser/serializer, discontinuity handling, fMP4 skip behavior, and byte-derived PTS duration.
- Consider a checkpointed background repair job if future migrations are large enough that rerunning from the beginning is wasteful.
- Consider hls.js fragment events if exact decoded-fragment identity is needed at segment boundaries.
