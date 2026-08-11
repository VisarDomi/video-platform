# Monorepo Decisions

## Ownership: ENDLIST hands media integrity to the server (2026-08-11)

The downloader owns an MPEG-TS recording while its playlist is live. Writing
`#EXT-X-ENDLIST` is the durable live-to-finalized handoff: after that line is
present and the folder leaves `live-status.json`, the server owns media
integrity and canonical playlist repair.

Tango and FC2 no longer launch ffprobe for every downloaded segment. Their live
loop performs only the transport-level nonempty-file check and preserves the
upstream EXTINF while capture is active. The server observes completed folders,
runs one strict whole-playlist ffmpeg decode, and performs the expensive
per-segment decode only when that recording-level check fails. This automatic
scan is strictly nondestructive: it writes only `.media-integrity.json`; it does
not move, copy, delete, or rewrite media segments or playlists. Failed MPEG-TS
playlists report the exact invalid segments for manual action. Failed fMP4
playlists remain failed without per-fragment attribution because individual
fragments require initialization/context.

Completed recordings enter one deduplicating FIFO queue with a worker count of
half the host's logical CPUs. Each worker runs one single-threaded ffmpeg at nice
priority 10 and waits 15 seconds between recordings, providing about 50% of
aggregate CPU capacity while yielding to interactive work. The systemd service
also has `CPUQuota=600%` on the current 12-CPU host, `MemoryHigh=70%`,
`MemoryMax=80%`, and `MemorySwapMax=0`. Segment scans checkpoint every 25
segments, so service restarts resume from the last checkpoint. Harmless
null-muxer DTS diagnostics are filtered before bounded stderr capture,
preventing truncation from turning them into false corruption.

PlaylistAuthority prefers adjacent MPEG-TS video PTS and invokes ffprobe only
for boundaries those timestamps cannot define, such as discontinuities and the
final tail. Automatic integrity validation does not call PlaylistAuthority or
rewrite durations; repair remains a separate explicit operation.

**Why:** Metadata-only ffprobe accepted the corrupt MPEG-TS segments that later
froze video during playback. Fully decoding every segment in the live loop
wastes power and gives the downloader destructive semantic authority. A single
post-ENDLIST validation is cheap for clean streams, while corrupt streams can
be inspected precisely with the whole recording available. The earlier
quarantine implementation moved source segments to `/tmp`; a reboot cleared
those bytes, proving that even recoverable-looking automatic mutation violates
the recording ownership boundary.

## Upload packaging is one recording per artifact and non-destructive (2026-08-11)

The server owns upload eligibility and final-artifact validation. Provider facts
live in `packages/server/src/services/upload/uploadPolicy.ts`; the shared policy
is derived from them instead of copying limits into descriptor, converter, and
uploader workers.

XVideos private uploads are the only active destination. It contributes a
7,200-second duration maximum and a 50,000,000,000-byte file maximum. Bunkr is
recorded as unavailable because registrations are closed until further notice;
it is not part of the active/shared policy and its 2 GB limit must not constrain
XVideos artifacts. XVideos' minimum duration, accepted container/codecs, and
metadata limits remain explicitly unresolved until manual authenticated tests.
The upload page is not publicly indexed, so those authenticated observations
cannot be independently confirmed by a public search.

Every recording is planned independently. No minimum-duration skip is active
while the XVideos minimum is unknown. Once manually verified, changing that one
provider value derives the shared minimum; recordings below it will be marked
`skipped_too_short` with a manual-action notification. Recordings over two hours
are marked `blocked_too_long`, and oversized final artifacts are marked
`blocked_too_large`. No decision moves, deletes, edits, or concatenates source
files. Concatenation is intentionally not part of the fresh pipeline and must be
a separate future decision if ever added.

**Why:** The old uploader's 15-minute concatenation rule destroyed the
one-recording boundary and moved source files after grouping. Most recordings
can be described, converted, and uploaded without taking that risk; exceptional
short or oversized recordings should remain visible for manual handling.

## Backlog pipeline is quota-led and uses one heavy worker (2026-08-11)

The eligible downloader + edited library measures 1,230,560,053,106 bytes in
3,372 recordings and 3,875,924 seconds (44.86 days) of playlist time. Trash is
not eligible. At the observed 2.54 Mbps average media bitrate, the operator's
rough 1.1 TB / 2,222 kbps estimate is about 46 days, not five days: stored bytes
must be multiplied by eight before dividing by bits per second.

The working monthly ledger is 1.0 TB download, 0.6 TB upload, and 0.4 TB held
in reserve. New media is approximately 0.2 TB/month. With one XVideos upload per
artifact, using the full allowance drains the measured 1.23 TB backlog at about
0.4 TB/month, or roughly 3.1 months. The selected six-month pace processes the
existing backlog plus approximately 1.2 TB of new media at about 0.405 TB/month
(13.5 GB/day), leaving about 0.195 TB/month of upload headroom.

The uploader must account actual transmitted bytes, including failed/retried
transfers, and stop admitting jobs when the calendar-month upload ledger reaches
600,000,000,000 bytes. Evenly spending the full allowance averages about 1.85
Mbps; the six-month target averages about 1.25 Mbps. The hard byte ledger, not
the rolling rate, remains authority.

The durable per-recording state machine is:

`discovered -> playlist_repaired -> integrity_ready -> remuxed -> artifact_valid -> described -> xvideos_admitted -> xvideos_uploaded -> xvideos_verified -> cleanup_eligible`

Blocked/failed states retain the source and the diagnostic. A stream-copy MP4
remux is the default final artifact; transcode is destination-specific and only
used when codecs or an active destination's size limit require it. Of the
measured library, no folder exceeds XVideos' 50 GB limit. After manual trimming,
none exceeds XVideos' two-hour limit; the current longest playlist is 6,983.065
seconds (1:56:23). Descriptor runs on the exact validated artifact that will be
uploaded. Future items over two hours are blocked and surfaced for manual
trimming; the pipeline does not split or transcode them merely to satisfy
duration policy.

Local cleanup is per recording, never an end-of-migration sweep. With XVideos
as the sole remote copy, source deletion is a separate risk decision and remains
disabled until explicitly enabled. If enabled, eligibility requires completed
XVideos processing/playback verification, persisted remote ID/URL, a stored
local artifact hash, and a seven-day grace period. Cleanup must target exact
manifest-owned source/artifact paths; no broad directory deletion is allowed.
Without source cleanup the pipeline limits temporary staging to one artifact,
but uploading alone does not reduce the existing local library.

One orchestrator and one durable SQLite job/byte ledger own all providers. It
uses one global artifact staging root, created only when the pipeline is
enabled; provider config must not invent converter/uploader directory trees.
There is one GPU descriptor request at a time and no concurrent CPU-heavy
transcode. Light remux/upload work may overlap. The scheduler pauses new heavy
work above the host CPU threshold and the eventual systemd processing slice
must cap aggregate memory at 80% with swap denied. Resource utilization controls
job admission and concurrency, not descriptor evidence quality.

The descriptor uses duration-tiered quality ceilings: 4 FPS below seven
minutes, 2 FPS from seven to below fifteen minutes, and 1 FPS thereafter. The
115,000-token video budget may lower FPS inside any tier and remains
authoritative. A live scan of 3,382 eligible finished recordings measured 44.79
media-days. Using the successful near-two-hour benchmark as a conservative
per-frame cost, the current library plus six months of projected new media is
about 88.47 media-days and 45.42 full-speed descriptor-days: 25.2% duty across
the 180-day schedule. At 50% duty the descriptor can process approximately
0.803 TB/month, above the 0.6 TB/month upload ceiling, so description is not the
pipeline bottleneck.

At a 1:1 stream-copy artifact ratio, the six-month plan transfers 2.43056 TB,
or 405.09 GB/month (1.25 Mbps average), leaving 194.91 GB/month below the upload
cap. The byte ledger can absorb an aggregate 1.481x size/retry multiplier; with
10% reserved for retries, final artifacts may average at most 1.346x source
size. Stream-copy remux is therefore comfortably inside both compute and byte
limits. If XVideos forces a full transcode, descriptor and transcode remain
serialized heavy jobs: a converter only needs 0.657x real-time throughput to
finish within six months at unrestricted duty, but approximately 1.984x
real-time to keep their combined heavy-worker duty at 50%. A 1x real-time
converter would finish but raise combined duty to about 74.4%.

## Provider paths are declarative, not startup side effects (2026-08-11)

Importing server config must not create provider storage trees.
`getProviderPaths()` describes paths only. Write operations create their
specific destination on demand. The unsupported flat-file `mp4` provider and
its routes/services were removed; this does not affect fMP4 HLS playlists,
`#EXT-X-MAP`, or `init.mp4` fragment serving. Converter and other undecided
pipeline folders are not created merely because a provider is listed in
configuration. Existing empty/legacy folders are left untouched.

## Historical playlist CLI uses PlaylistAuthority (2026-08-11)

`npm run fix-playlists` builds and calls the same canonical PlaylistAuthority
used by the server instead of maintaining a second per-segment-duration rule.
For MPEG-TS it reads adjacent video PTS from bytes and uses the longest positive
audio/video stream duration only at discontinuities, tails, or failed byte
probes; fMP4 is skipped. The CLI retains SQLite checkpoints, live-folder guards,
CPU admission, dry-run, and power-loss-safe atomic writes. Rule version
`media-timeline-v2` deliberately invalidates checkpoints made by the obsolete
`max-av-v1` implementation.

## Descriptor uses duration-tiered FPS ceilings with token-budget adaptation (2026-08-12)

Native-video description requests use up to 4 FPS below seven minutes, up to 2
FPS from seven to below fifteen minutes, and up to 1 FPS thereafter. For any
recording that would exceed the 115,000-token video budget, the descriptor
lowers FPS as `budget / measuredTokensPerFrame / duration`. Full 4 FPS fits
through 407.8 seconds (6:48), full 2 FPS through 815.6 seconds (13:36), and full
1 FPS through 1,631.2 seconds (27:11). Longer videos receive approximately
1,631 sampled frames regardless of duration: about 0.453 FPS at one hour and
0.2266 FPS at two hours. A two-hour video therefore samples one frame every
4.41 seconds while preserving room for instructions and output.

Fixed 0.5/1/4 FPS comparisons on 12.35-second and 176.27-second recordings found
that 1 FPS retained useful setting, clothing, and action specificity with about
one quarter of the 4 FPS prompt tokens. Sampling at 0.5 FPS remained useful but
lost some clothing/action specificity on the longer recording. Four FPS did not
produce a consistent quality improvement. Invalid sampling inputs fail before
a model request is sent.

The spare descriptor capacity is deliberately spent on denser evidence for
short recordings. The token budget safely tapers FPS near each tier boundary,
so this quality increase cannot overflow the model context.

**Why:** Frame rate is an evidence-quality and context-cost choice, not a model
memory workaround. One FPS is the measured normal-quality point; duration-based
reduction preserves support for long recordings without making short videos
needlessly sparse.

## Ownership: Video is a self-contained unit (2026-04-05)

Every piece of state about a video belongs to the video itself. The `Video` type carries `provider` alongside `filename`, `type`, `duration`, `size`, `isLive`. Operations derive context from the video object — no threading `provider` through function args from external stores.

**Backend:** `VideoRef` (`filename`, `provider`, `type`, `dirPath`) is resolved once at the API boundary via `resolveVideo(filename, provider)`. Services receive the ref, never re-resolve. No cross-provider directory search — `findVideoPath()` (global 12-dir search) was replaced with provider-scoped resolution.

**Frontend:** `fetchVideos` stamps `provider` on each video at fetch time. `playerStore`, `videoActions`, `VideoEngine`, and `hls.ts` read provider from the video itself.

**Why:** The old `findVideoPath()` searched all providers. A tango video could match an fc2 path. The frontend threaded `videoListStore.selectedProvider` through 5 layers of function calls — fragile and easy to desync.

## Ownership: Shared settled-selection overlay (updated 2026-07-29)

Each of the three `PlayerUnit`s owns its video, playback timeline, and media
lifecycle. A single imperative `OverlayView` belongs to the settled viewer
selection and remains stationary while the native document scrolls.

The overlay disables mutations while unsettled and switches atomically when an
adjacent video contains the visual viewport's exact midpoint pixel. After
`scrollend + 100ms`, the viewer returns to its resting presentation.
Its fixed box is transparent and may touch the viewport boundaries. Only the
controls paint pixels; a full-box background or backdrop makes Safari's browser
chrome opaque.

**Why:** Moving per-unit overlays require viewport-bound fixed/transformed player
geometry, which makes Safari's top and bottom chrome opaque. Native scrolling
keeps videos edge-to-edge while one stationary UI gives editing controls stable
geometry.

## Ownership: Only settled media feeds shared UI (updated 2026-07-29)

Each unit maintains its own playback timeline. Only the current unit feeds the
shared overlay and progress persistence. Adjacent videos remain playing muted
and become current only when they contain the visual viewport midpoint.

**Why:** The stationary overlay must continue to describe the last committed
selection while videos move underneath it.

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

Tango alias reconciliation belongs to the server. Its hourly refresh covers
the union of followed account IDs and account IDs in `tango.txt`, merges the
complete Tango alias snapshot into `aliases.json`, and rewrites stale labels in
`tango.txt`. Adding a Tango download target checks the follow list and follows
the resolved account only when needed, before the server writes the target. The
downloader watches and consumes `tango.txt`; it never rewrites aliases or
mutates the Tango follow list.

## Frontend gestures preserve Safari navigation ownership (2026-07-29)

Safari owns leading-edge Back, tab/history navigation, vertical viewer
scrolling, and pinch zoom. The viewer owns horizontal seek and controls.

- Do not call `preventDefault()` for a touch beginning in the leading-edge zone.
- Do not call `preventDefault()` or apply transforms for multi-touch sequences.
- Call `preventDefault()` only after an application-owned axis is known.
- Do not prevent native vertical touch movement.
- At rest, park the previous video at the top of its 10k scope and the next
  video at the bottom of its 10k scope so only the current video is visible.
- On recognized vertical intent, bring both adjacent videos next to the current
  scope and rotate roles immediately when one contains the viewport midpoint.
- Park the adjacent videos again after `scrollend + 100ms`.
- Commit viewer-to-viewer navigation with `history.replaceState()`, preserving
  the list as the previous history entry.

**Why:** Browser navigation and bfcache restoration now replace the old custom
edge-back and SPA view-state machinery.

## Video lists use the full native document (2026-07-29)

Render every provider-list row as an ordinary anchor in normal document flow.
There is no virtualizer, spacer, fixed row-height calculation, filter, or scroll
correction. Safari owns scrolling and bfcache scroll restoration.

On a bfcache `pageshow`, immediately refetch and reconcile the list without
moving Safari's restored viewport, then resume exactly one poller. A normal
list load or page refresh centers an existing highlight in the visual viewport.
Polling does not move the viewport.

The last current filename is stored in `localStorage` per provider. It persists
across tabs and Safari sessions, and every viewer selection updates it.

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

For finalized recordings, Tango/FC2 duration repair must use the longest positive
media-stream duration, `max(video duration, audio duration)`, when adjacent video
PTS cannot provide the timeline; `format.duration` is only a fallback when
neither media stream has a usable duration. The downloader no longer probes each
live segment and therefore leaves upstream EXTINF provisional until ENDLIST
hands the playlist to the server. This preserves audible presentation time when
video ends early or freezes without paying the probe cost throughout capture.
Edit playlists inherit canonical `#EXTINF` from the source playlist, so
historical source playlists should be repaired before editing old recordings.

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

- Downloader owns active playlist append for new live captures and retains upstream `#EXTINF` until completion.
- ENDLIST transfers ownership to the server; MediaIntegrityFinalizer validates nondestructively and `PlaylistAuthority` owns explicit canonical duration repair plus historical/batch repair.
- HLS routes serve playlists read-only and must not silently heal on GET.
- Frontend timeline code reads the playlist authority and logs mismatches; it must not hide native playback errors with auto-resume behavior.

Remaining hardening:

- Add tests for `PlaylistAuthority` parser/serializer, discontinuity handling, fMP4 skip behavior, and byte-derived PTS duration.
- Consider a checkpointed background repair job if future migrations are large enough that rerunning from the beginning is wasteful.
- Consider hls.js fragment events if exact decoded-fragment identity is needed at segment boundaries.
