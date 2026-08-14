# Monorepo Decisions

## Active recording folders are the durable downloader/server boundary (2026-08-12)

The downloader owns mutable `<provider>/downloader/.active/<recording>/`
folders. After writing `#EXT-X-ENDLIST`, it atomically renames the directory to
the hidden `.pending/` sibling. That rename is a durable handoff, not
publication. The server owns `.pending`, runs cleanup, canonical playlist
repair, strict decode and attributable corrupt-segment repair there, and alone
atomically renames a successful recording into the visible downloader root.
Visible root membership therefore means server integrity passed.

`live-status.json` remains informational and is not completion authority. No
per-recording manifest or `.media-integrity.json` is required. Power-loss
checkpoints and failed diagnostics live centrally in
`~/.local/share/video-services/finalization.sqlite`; filesystem location remains
the lifecycle authority.

New media filenames are
`{monotonic-local-number}_{recording-identity}_{provider-sequence}.ts`. Recording
identity is Tango `streamId`, FC2 `start_time`, and Stripchat
`statusChangedAt`. Within one recording identity, the downloader persists and
resumes from the highest accepted HLS media-sequence number. It accepts only
higher sequence numbers, so arbitrarily large overlapping live windows cannot
redownload old media and the deduplication state remains constant-sized. FC2
may reset the number embedded in a segment URI (for example `2555.ts` followed
by `0.ts`), but that is not an HLS media-sequence reset: the semantic sequence
continues by playlist position and is what the compound filename stores. A
genuine regression of the HLS media sequence for the same broadcast identity
is therefore rejected instead of guessed to be new media. Writes must never
overwrite a media file. Historical numeric names remain valid and are never
migrated.

As a publication backstop for MPEG-TS recordings using compound names, server
finalization removes any entry whose HLS media sequence does not exceed the
highest earlier entry, then moves the newly unreferenced owned segment files to
desktop Trash before strict validation. This repairs overlap accidentally
accepted by a downloader defect; it does not sort media or reinterpret legacy
numeric filenames.

Folder timestamps use the operator's local clock. Provider-supplied UTC
recording identities retain their `Z` standard but omit colon punctuation for
safe visible filenames: `2026-08-12T09:08:47Z` becomes
`2026-08-12T090847Z`, both when written and when compared during recovery. URI
percent escapes must not be stored in disk filenames because HTTP clients and
Express decode them at the request boundary.

The provider snapshot loops, not HLS transport failures, decide lifecycle. An
upstream ENDLIST or a different recording identity is immediately terminal. An
absent/non-public result is terminal only after at least two successful
observations span 60 seconds with no media progress. Provider/API unavailability
does not start or advance terminal confirmation. FC2 uses exactly the adult
channel-list endpoint and starts requests no more often than every 30 seconds.
Shutdown and power loss leave `.active` recordings unfinished for restart
reconciliation; they do not append ENDLIST.

The server uses Linux-backed Node filesystem watches on the hidden downloader
and edited `.pending` roots. It registers watches before a non-recursive
startup reconciliation and performs a rare safety reconciliation for missed or
coalesced events. No one-second tree scan or Rust/Go watcher is needed. One
idempotent post-ENDLIST processor replaces orphan finalization and overlapping
repair/finalization scripts while reusing PlaylistAuthority and the bounded
media-integrity queue. Edited output is likewise built under a hidden path,
handed to `.pending`, validated, and only then published into `editor/edited`.

**Why:** Active capture, finalized local media, and postprocessing need explicit
single-writer ownership that survives either process losing power. Filesystem
state and atomic rename provide that boundary without another service protocol,
while provider recording identity prevents a reconnect from joining two
broadcasts or overwriting a reused provider sequence.

## Ownership: ENDLIST hands media integrity to the server (2026-08-11)

The downloader owns a recording while its directory is under `.active`.
Atomically writing `#EXT-X-ENDLIST` and renaming into `.pending` hands it to the
server. The server owns media integrity and canonical playlist repair and is the
only component permitted to publish into a finalized root.

Tango and FC2 no longer launch ffprobe for every downloaded segment. Their live
loop performs only the transport-level nonempty-file check and preserves the
upstream EXTINF while capture is active. The server observes completed folders,
runs one strict whole-playlist ffmpeg decode, and performs the expensive
per-segment decode only when that recording-level check fails. Failed MPEG-TS
playlists with exact fragment attribution are repaired automatically: corrupt
entries are removed, the playlist is made canonical, the files are moved to
desktop Trash, and a strict decode must then pass. Failed fMP4 playlists are
scanned with their active initialization map. A fragment is attributable only
when it fails alone, its adjacent fragments pass alone, and every available
overlapping two-fragment context still fails. Repair drops that exact fragment,
renews both discontinuity and map before the next fragment, moves the dropped
file to desktop Trash, and requires a clean full decode. Initialization damage,
adjacent failures, and boundary-only failures remain blocked because they do
not establish a uniquely safe discard.

Completed recordings enter one deduplicating FIFO queue. Normal live operation
processes one recording at a time and gives its whole-playlist decoder half the
host's logical CPUs; fMP4 attribution uses the same budget as parallel
single-fragment checks. This makes a lone stream completion use the intended
capacity while additional completions wait durably instead of multiplying
resource demand. The historical catalog command instead parallelizes
single-threaded decodes across its operator-selected `--concurrency`. FFmpeg
runs at nice priority 10 and the live queue waits 15 seconds between recordings.
The `video-processing.slice` shared by the server and manual/future pipeline
workers has `CPUQuota=600%` on the current 12-CPU host, `MemoryHigh=70%`,
`MemoryMax=80%`, and `MemorySwapMax=0`. The server and explicit single-recording
finalization scopes have `CPUWeight=1000`, while backlog remux, descriptor, and
all-library catalogue scopes use weight 100. Thus just-ended livestream
finalization, its on-demand test equivalent, and API work win CPU time under
contention without preventing background work from using otherwise idle
capacity. Downloader and auth remain outside the processing slice. Segment scans checkpoint every 25
segments in the central SQLite ledger, so service restarts resume from the last
checkpoint. Harmless null-muxer DTS diagnostics are filtered before bounded
stderr capture, and FFmpeg repeat compression is disabled. A legacy compressed
`Last message repeated` summary is ignored only when it directly follows an
ignored DTS line, preventing both truncation and repeat summaries from turning
them into false corruption. Failed checkpoints carry a validator revision;
after validation semantics change, older failures are retried once while
current genuine failures remain durable and do not loop on hourly reconciliation.

When an automatic or explicit failed-integrity repair is requested, attributable
MPEG-TS segments or conservatively isolated fMP4 fragments are removed from the
playlist, the required discontinuity (and fMP4 map) is inserted before the next
good segment, canonical durations are recalculated where supported, and the
exact corrupt files are moved to desktop Trash. A fresh strict decode must pass
before the recording becomes pipeline-eligible. Desktop Trash and the video library are on
the same filesystem on this host, so the move is atomic and the operator can
recover files until intentionally emptying Trash. fMP4 failures without exact
fragment attribution remain blocked.

PlaylistAuthority prefers adjacent MPEG-TS video PTS and invokes ffprobe only
for boundaries those timestamps cannot define, such as discontinuities and the
final tail. It runs as part of the unified post-ENDLIST processor before strict
validation and again after any corrupt entries are removed.

**Why:** Metadata-only ffprobe accepted the corrupt MPEG-TS segments that later
froze video during playback. Fully decoding every segment in the live loop
wastes power and gives the downloader destructive semantic authority. A single
post-ENDLIST validation is cheap for clean streams, while corrupt streams can
be inspected precisely with the whole recording available. Earlier explicit
quarantine used `/tmp` as the intentional discard destination. Corrupt-media
discard now uses desktop Trash instead because it provides a visible recovery
and deliberate emptying workflow without a copy. Detection itself remains
nondestructive; exact MPEG-TS attribution authorizes the idempotent repair step.

## Upload packaging is one recording per artifact and non-destructive (2026-08-11)

The server owns upload eligibility and final-artifact validation. Provider facts
live in `packages/shared/src/uploadPolicy.ts`; the server re-exports them and the
pipeline consumes the same policy instead of copying limits into descriptor,
converter, and uploader workers.

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

`server_ready -> remuxed -> artifact_valid -> described -> metadata_ready -> xvideos_admitted -> xvideos_uploading -> xvideos_uploaded -> xvideos_verified -> cleanup_eligible`

An identifier that cannot be resolved after description branches to
`provenance_review_required` and returns to `described` after a reusable manual
override. An upload whose metadata submission may have succeeded branches to
`xvideos_uncertain`; it is adopted when the authenticated uploads list contains
the stable match key, or returns to `metadata_ready` only after the full
24-hour absence window.

Before the global historical-finalization contract is complete, an operator may
prepare one explicitly selected historical recording only when the central
server ledger has a matching successful checkpoint for its current playlist.
`pipeline remux-one` stream-copies that source into the durable staging root,
fully decodes the MP4, probes it, hashes it, and stops at `artifact_valid`; it
does not invoke descriptor or upload. The source HLS folder is never modified.

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

## Historical playlist repair was folded into finalization (2026-08-11, superseded 2026-08-12)

The retired `npm run fix-playlists` command called the same canonical
PlaylistAuthority used by the server instead of maintaining a second
per-segment-duration rule.
For MPEG-TS it reads adjacent video PTS from bytes and uses the longest positive
audio/video stream duration only at discontinuities, tails, or failed byte
probes; fMP4 is skipped. The CLI retains SQLite checkpoints, live-folder guards,
CPU admission, dry-run, and power-loss-safe atomic writes. Rule version
`media-timeline-v2` deliberately invalidates checkpoints made by the obsolete
`max-av-v1` implementation.

The applied playlist-only all-provider/all-scope migration completed on 2026-08-12 after
11,565.628 seconds: 2,820 playlists processed, 1,940 written, 880 unchanged,
2,318,421 segments inspected, and zero failures. This closes that historical
batch only. The standalone fixer and failed-integrity CLI were then removed so
there is only one production finalization engine. The server now owns canonical
repair and strict integrity before publication. A bounded
`npm run finalize-library -w server` migration
uses that exact production processor to establish the same invariant across the
historical roots and removes obsolete per-recording integrity sidecars only
after each recording passes.

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

## Durable pipeline foundation is separate and network-disabled (2026-08-12)

Months-long processing does not run inside the Express server. The standalone
`packages/pipeline` package owns an isolated SQLite WAL/FULL ledger containing
recordings, append-only state events, expiring worker leases, remux outputs,
validated artifact hashes, description evidence, upload reservations/attempts,
actual transmitted-byte events, and remote verification evidence. It is not a
systemd service and is not started by the monorepo start command.

Production discovery considers only immediate entries in `editor/edited` and
never admits raw downloader recordings. Every candidate needs an exact current
`ready` checkpoint in the server finalization ledger; root membership or an old
whole-catalog contract does not authorize a changed edit. Hidden `.active` and
`.pending` directories remain undiscoverable. A one-time bounded historical
finalization pass must complete before the campaign is enabled.

The local stages use non-overwriting stream-copy MP4 publication, then decode,
probe, and SHA-256 the exact artifact before describing it. Descriptor is now a
library entry point with a manual single-artifact command; it retains automatic
duration and token-budget FPS selection and persists the prompt hash with every result.
Artifact-hash/prompt-hash evidence paths allow a restarted worker to adopt a
completed description rather than spend the model work twice. Stages commit one
durable transition at a time, recover expired leases, and restore explicit
manual retries to the exact failed stage.

The 600,000,000,000-byte calendar-month ledger uses `Europe/Tirane` by default.
Reservations include expected request overhead; actual bytes from failed and
retried attempts are append-only. A lost response after sending a body enters
`xvideos_uncertain` and requires reconciliation rather than a blind duplicate
upload. Dry-run upload planning mutates neither quota nor state.

At this foundation stage there was deliberately no real XVideos transport. The
2026-08-13 decision below supersedes that implementation detail while retaining
the separate-service, durable-ledger, disabled-cleanup, and default-off network
boundaries.

## XVideos browser uploader is implemented but production-disabled (2026-08-13)

Authenticated discovery established the XVideos Google OAuth, Friendly Captcha,
local-file upload, metadata, model, and uploads-list flows. The pipeline now has
a visible persistent-Chromium adapter, but a real upload requires both an
explicit `upload-one --apply` command and `VIDEO_PIPELINE_NETWORK_UPLOADS=1`.
There is still no pipeline systemd service. Friendly Captcha and unexpected
Google/account challenges fail closed and require operator action; the adapter
does not click or bypass human verification.

Recording provenance uses the same shared provider target parsing and membership
identifiers as the server's `+ / -` download-list control. Tango may resolve an
old folder alias through API-provided alias history. FC2 uses its channel ID.
Stripchat uses only the current username/room-ID target relationship; no local
Stripchat alias history is invented. Failed resolutions enter durable review.
An operator override is keyed by `(provider, observed folder identifier)` and
therefore resolves every matching recording instead of requiring per-recording
decisions. The resolved ID, alias, and source URLs are snapshotted into pipeline
SQLite, so later target-list removal cannot erase upload provenance.

The descriptor remains responsible only for evidence-derived title,
description, and tags. The pipeline metadata composer adds a stable per-recording
title match key, recording time, streamer-ID URL, and alias URL when known. It
enforces the authenticated form's limits: title 255, description 1000, and 20
tags. Descriptor descriptions are capped at 750 characters to reserve suffix
room. Default tags are the public provider name (`tango`, `fc2`, or
`stripchat`) followed by `live`; normalized descriptor tags follow with stable
deduplication. Fixed form choices are explicit, Straight + Solo Girls, XVideos
only, Direct link, no translations, no blocked countries, and no commercial
communication.

Streamer models are a separate durable mapping keyed by `(provider,
streamerId)`. `upload-one` always requires that mapping. The supervised browser
searches the configured stage name but never chooses a suggestion by name:
XVideos may return several ambiguous people and does not know the source
provider ID. The operator manually selects the correct result or opens create.
When create is opened, the adapter fills the configured stage name, gender,
professional-model explanation, and profile picture, then waits for operator
review/submission. A captured XVideos model ID is reused only by the future
unattended campaign. Test environment values are never global defaults for an
unrelated streamer.

Remote success means the authenticated `/account/uploads` list contains the
stable title match key and exposes a numeric XVideos ID and video URL. Public
moderation states such as Online, Blocked, or Edit required are stored as
informational observations and do not change upload success. The adapter uses
the list's search control, so reconciliation does not depend on the entry being
on the first page.

Upload attempts checkpoint file-transfer progress, `file_uploaded`, and
`metadata_submitting` boundaries in SQLite. Interrupted transfer or pre-submit
work is charged to the byte ledger and becomes immediately retryable. Once
metadata submission may have occurred, the job becomes uncertain, receives a
durable `confirm_after = recovery/submission time + 24 hours`, and cannot retry
during that interval. The due reconciliation searches the authenticated list;
a found entry is adopted regardless of moderation status, while absence after
the full grace period returns the recording to `metadata_ready`. Every transfer
and retry consumes the calendar-month byte budget.

Production activation still has three independent blockers: the historical
server-finalization contract must be complete, descriptor model/prompt output
must be approved, and one controlled upload must actually save metadata so the
final submit response plus uploads-list reconciliation are validated. Source
and artifact cleanup remain disabled.

## Upload work is supervised first and a durable campaign later (2026-08-14)

Descriptor output exists only for upload metadata. During development,
`remux-one`, `describe-one`, and `upload-one` select one exact recording.
Manual remux accepts either a managed downloader or edited folder and invokes
the production single-recording server finalizer when its exact checkpoint is
missing. Durable description metadata and production uploads are edited-only;
the descriptor package retains a separate arbitrary-MP4 prompt experiment.

The eventual campaign persists paused/running intent, an
`all|tango|fc2|sc` filter, strict oldest-first ordering, and the monthly byte
limit in SQLite. Eligibility comes from exact server checkpoints; capture order
comes from the timestamp in the edited folder name, not finalizer scan time.
The worker advances one durable stage at a time and rereads pause intent between
stages. Missing provenance/models, stale edits, monthly quota exhaustion,
authentication challenges, and uncertain uploads remain explicit recoverable
boundaries.

Systemd will own worker lifetime while SQLite owns intent and progress. The
worker and controls are implemented, but no unit is installed or enabled until
the catalog, descriptor, authenticated uploader verification, and temporary-MP4
retention decisions are complete. All cleanup remains disabled.

## The monorepo owns its systemd user configuration (2026-08-13)

Versioned user units, the aggregate processing slice, and service drop-ins live
under `systemd/user`. `npm run systemd:check` detects drift from installed files;
`npm run systemd:sync` atomically installs only the declared video-platform
files and reloads the user manager. Unit templates use a `{{HOME}}` parameter
that the synchronizer expands for the invoking user, keeping machine-specific
usernames out of version control. Synchronization never restarts, starts, stops,
enables, or disables a service implicitly. Chezmoi must not maintain a second
divergent copy of these units.

**Why:** The resource hierarchy and CPU priority determine production behavior
as directly as the queue implementation. Leaving them as unversioned machine
state makes concurrency tests irreproducible and permits deployment drift.

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
| `live-status.json` | downloader (DownloadsManager) | informational/debug consumers only |
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
- Active downloader folders live one level below `.active`, while the historical
  fixer scans only immediate non-hidden finalized folders.

Operational behavior:

- Repair is idempotent: rerunning a fixed playlist should produce `changedDurationCount:0` and `wrotePlaylist:false`.
- Repair is crash-safe per playlist: writes use temp file + rename, so power loss leaves either the old playlist or the complete repaired playlist.
- Batch repair is not checkpointed. If interrupted, rerun is safe but starts scanning from the beginning.

Ownership boundary:

- Downloader owns `.active` playlist append for new live captures and retains upstream `#EXTINF` until completion.
- ENDLIST plus `.active` to `.pending` handoff transfers ownership to the server; only the server may promote a validated recording into a visible finalized root.
- HLS routes serve playlists read-only and must not silently heal on GET.
- Frontend timeline code reads the playlist authority and logs mismatches; it must not hide native playback errors with auto-resume behavior.

Remaining hardening:

- Add tests for `PlaylistAuthority` parser/serializer, discontinuity handling, fMP4 skip behavior, and byte-derived PTS duration.
- Consider a checkpointed background repair job if future migrations are large enough that rerunning from the beginning is wasteful.
- Consider hls.js fragment events if exact decoded-fragment identity is needed at segment boundaries.
