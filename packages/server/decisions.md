# Server Decisions

## Finalization is non-destructive and every recording publishes

For every live site, the downloader atomically writes `#EXT-X-ENDLIST` and
renames the recording from `downloaded/.active/` to the hidden
`downloaded/.pending/`. The server watches each `.pending` root directly and
non-recursively (the roots are created at startup), runs a reconciliation scan
after the watches are in place, and repeats it hourly to cover downtime and
missed or coalesced events. Only folders whose playlist ends with ENDLIST are
queued.

Processing a pending recording (`processFinalizedRecording`):

0. NUL bytes in the playlist are removed, and an entry whose file holds no
   bytes (empty, or all zero bytes in its first 4 KiB: a power loss before the
   data reached the disk) leaves the playlist with an `empty-entries` warning.
   Its tags that still apply (a discontinuity, an init map) pass to the next
   entry, which starts after a discontinuity where media resumes. The file
   stays on disk; a missing file is not judged.
1. Finalized AVC fMP4 captures are indexed before publication. An in-band SPS/PPS
   change at an indexed IDR gets its exact already-captured initialization map
   and a discontinuity. Track IDs, clocks/defaults, NAL length and the complete
   audio sample descriptions must match. Without a matching captured map only
   a level-only SPS change can clone its existing initialization. Provider MAPs
   announced late align to the actual change; a MAP announced before an old
   trailing P-frame moves to the proven matching IDR, with continuous decode
   clocks and matching audio required. If the change falls inside a media file/moof,
   sample-copy fragments split it at that video sample and the nearest whole AAC
   packet boundary. Every encoded sample, DTS, duration, composition offset and
   flag is compared before publication; no decoding/re-encoding or retiming.
   Original fragments and initialization files remain byte-identical.
   High-profile avcC chroma/bit-depth fields and indexed SPS-extension NALs are
   validated and retained verbatim; valid extensions are not damage. Malformed
   or unindexed extensions stay unsupported. This matches the record layout in
   [FFmpeg's AVC muxer](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avc.c).
   A closing `mfra` seek-index trailer is inspected as metadata: validate its
   `tfra` record lengths and `mfro` size/footer, with no hidden/unindexed bytes.
   Original trailers remain in their original files; generated sample-copy
   fragments omit obsolete source offsets, just as they omit source sidx indexes.
   Unsupported layouts/configuration changes stay unchanged and receive a
   `decoder-boundary-unrepaired` warning.
2. Provider sequence restarts (a compound segment name whose sequence does not
   increase) are kept; a missing `#EXT-X-DISCONTINUITY` is added before each
   one and the restarts are reported as a `sequence-restart` warning.
3. PlaylistAuthority repairs `#EXTINF`/`#EXT-X-TARGETDURATION` (below).
4. Media files in the folder that the playlist does not reference are listed as
   an `unreferenced-media` warning and left in place.
5. Validation decodes each native run (segments between discontinuities and
   init-map changes; a single-run playlist is decoded directly) with one strict
   ffmpeg pass. If that fails, MPEG-TS segments are decoded one by one, and a
   segment that fails alone is decoded again after its same-run predecessor (a
   segment without its own SPS/PPS is whole there); fMP4 fragments are decoded
   alone and then with a same-epoch neighbor. That attributes the damage.
   Attributed segments stay in the playlist and are listed in
   `invalidSegments` with a `damaged-segments` warning; damage no single
   segment explains is an `unattributed-damage` warning; a playlist the
   validator cannot interpret, or validation that cannot complete for a reason
   in the recording, publishes unvalidated with a `validation-incomplete`
   warning.
6. Each published recording logs one line. It is a warning when the report has
   a finding other than successful lossless splits or damaged segments, or damage beyond 2% of the
   playlist; damage below that comes from the stream itself (some sites' recordings
   carry a few corrupted macroblocks) and is an info line.

Finalization may rewrite `playlist.m3u8` and create lossless sample-copy
fragments/init maps. It never discards captured media or moves/deletes an original.
The original playlist, source fingerprints, generated-file hashes and prepared/
published phase are durably journaled in `finalization_meta` before publication.
Generated files are fsynced and linked exclusively; the playlist is replaced only
after all outputs are durable and source identity is rechecked. Restarting after
either publication boundary completes idempotently. A user-modified playlist or
source is never restored/overwritten. Pending-to-visible rename uses the same
logical journal key. Retained originals are not unexpected unreferenced files.

The report (version 2, validator revision 5) has status `ready` (published,
possibly with `warnings`), `empty` (no playlist entries), or `failed`. `failed`
means only that the validation environment failed: ffmpeg could not start, the
filesystem refused I/O (permission, space, I/O errors), or every segment failed
with a host decoder error. A failed recording stays in `.pending` and is retried
at the next reconciliation. An `empty` recording with no unreferenced media
segments goes to the desktop Trash (`gio trash`); one that still has
unreferenced segments is published. A destructive-repair journal left in the
ledger (`media_repairs`) is cleared without moving files and reported as a
`retired-repair-journal` warning.

Publication is a same-filesystem rename from `.pending/` into the visible
`downloaded/` root followed by directory fsyncs; that rename is the completion
record, and the checkpoint is rewritten under the published path. Pending
recordings are hidden from the video API (only `.active` folders and visible
recordings are listed), so they cannot be moved or edited while being
processed.

**Why:** Captured media cannot be captured again. Dropping or trashing a
segment loses it, and holding back a recording for one bad segment hides all
the rest. Warnings keep the evidence while every recording stays available to
the viewer and the pipeline. An entry whose file holds no bytes has no media to
lose; left in place it stops players (Safari about 70 seconds before it), and a
NUL line reads as a segment name that makes the playlist uninterpretable.

## Finalization checkpoints and stderr handling

Checkpoints live in the central `finalization.sqlite` ledger
(`~/.local/share/video-services/finalization.sqlite`), keyed by recording path
and playlist fingerprint; recording directories get no sidecar. A `ready`
checkpoint for the same fingerprint skips the work; deep scans checkpoint every
25 segments so a restart resumes them.

Validation maps video and audio optionally (`-map 0:v? -map 0:a?`), so audio-only
and video-only media are both valid. Null-muxer "non monotonically increasing
dts" messages are bookkeeping, not corruption: they are filtered while stderr is
streamed, before its bounded 16 KiB capture, so a truncated ignored message
cannot become a false error. Demuxer and decoder errors are failures.

## A recording's checkpoint moves with it

Saving (OK in the viewer and the phone app), trashing and restoring move a recording's folder
with a rename, which keeps its playlist byte for byte, so the validation still holds: the
`ready` checkpoint is written under the destination before the rename, both folders are synced
after it, and only then is the old row cleared. A saved recording is therefore as eligible for
upload as a cut one; a cut writes its own checkpoint by derivation. A power cut at any point
leaves the folder with a checkpoint wherever it is (at worst an extra row for a path that does
not exist, which nothing admits).

**Why:** Until 2026-11-21 a save moved only the folder. Every recording kept with OK lost its
checkpoint and could never be uploaded; 1,117 had piled up since August.

## Finalization exposes work while systemd allocates resources

The pending queue is one deduplicating FIFO with one worker per
`os.availableParallelism()` (cgroup-aware), each pausing 15 seconds between
recordings; PlaylistAuthority probing and the library command use the same
ceiling. This bounds parallel work; it is not a CPU throttle. systemd caps all
processing in `video-processing.slice` (`CPUQuota=600%`, `MemoryHigh=70%`,
`MemoryMax=80%`, no swap) and gives the server `CPUWeight=1000` over the
weight-100 pipeline service and background scopes. Inside the slice Node
reports six available CPUs; outside it, all twelve host CPUs.

FFmpeg receives no thread or priority flags, and the library command has no
`--concurrency` option. Exact `--recording` library finalization runs as
`video-finalize-library-single.scope`, whose systemd drop-in gives it
foreground weight (`CPUWeight=1000`); catalogue finalization runs as
`video-finalize-library.scope` at the default weight.

## PlaylistAuthority derives durations from the media

PlaylistAuthority reads MPEG-TS PTS from the segment bytes and uses the
distance between adjacent video start times for ordinary boundaries. It runs
ffprobe only when the byte probe fails, or when a segment before a
discontinuity or at the tail needs a stream duration the byte probe could not
establish. Where adjacent video PTS cannot provide the timeline, `#EXTINF` is
`max(video duration, audio duration)`; container duration is used only when
neither stream has a positive duration.

**Why:** Some damaged segments contain almost no advancing video while audio
continues, and Safari presents that interval as frozen video with continuing
audio. A video-only duration would make the playlist timeline shorter than what
Safari plays and make time-based editing inaccurate.

For supported fMP4 captures, sample clocks similarly set adjacent video-start
EXTINF values and the actual audio/video end at a provider cut or tail. This
avoids cumulative rounding drift. Real long-duration held frames remain long;
metadata repair cannot create motion absent from the capture. Shared HLS serving
always returns the stored playlist and file bytes without playback-time healing.

## Library finalization is explicit

A server restart never decodes visible recordings: only `.pending` is watched.
Visible recordings are (re)finalized in place by the bounded command:

```bash
npm run finalize-library -w server                    # dry run: counts only
npm run finalize-library -w server -- --apply [--provider <capture site>|all] [--scope downloads|edited|all] [--limit N]
npm run finalize-library -w server -- --recording "/exact/managed/folder" --apply
```

It runs in a systemd scope inside `video-processing.slice` with a stable name,
so a second invocation of the same kind cannot run concurrently and the
operator can stop it by name. Unchanged playlists with a `ready` checkpoint are
skipped; interrupted deep scans resume from their checkpoint. A folder moved without its
checkpoint (by hand, or by a server older than the carrying move) first takes the `ready` one
its folder name has elsewhere with the same playlist, so only recordings that never had one are
decoded. It processes
folders in place and never publishes or trashes them, and it removes any
legacy `.media-integrity.json` sidecar of a ready recording. A complete
`all`/`all` run without failures records the `historical-finalization-v1`
contract the pipeline checks. `--recording` accepts exactly one visible
immediate child of a managed `downloaded` or `edited` root (not a symlink, with
a regular `playlist.m3u8`) and cannot be combined with `--provider`, `--scope`,
or `--limit`.

## Edited recordings skip the validation queue

`.pending` and media validation are capture-only (`downloaded` roots). An edit
is built from an already finalized recording's segments and published directly
into `edited/` with a `ready` checkpoint recorded by derivation
(`trustedDerivation: "edited-from-validated-recording"`). Never route an edit
through the pending finalizer.

## Pipeline trusts the server publication boundary

The pipeline reads only immediate visible `downloaded`/`edited` folders and
ignores the hidden `.active` and `.pending` roots. It requires a `ready`
version-2 checkpoint whose fingerprint matches the current playlist, treats a
report with warnings like any other ready report, and never asks the server to
repair anything.

## Config paths do not create storage trees

Provider storage paths come from `providerFolders()` in `packages/shared`
(`<downloads root>/<provider>/<downloaded|edited|trash>`). Importing the server
config creates no provider storage directories (`test/configPaths.test.mjs`);
it creates only the frontend build directory, the download-lists directory, and
the shared state directory when missing. At startup the finalizer creates the
`downloaded/.pending` root of every capture site it watches. Every other destination is
created by the write that needs it.

## Disk space monitor stops the downloader at 50 GiB

Every minute the server checks the free space of the filesystem holding the
downloads root and runs `systemctl --user stop video-downloader` when less than
50 GiB is available. It never starts the downloader again.

**Why:** A full disk corrupts in-progress recordings. The check lives in the
server so changing it never restarts the downloader.

## The sites registry: one parser per list

The server loads every site in the sites file (`src/sites.ts`, shared plumbing in
`packages/shared/src/siteHost.ts`; a missing or invalid file stops it at startup) and
serves `/api/<site>/{list,add,remove,member,exists,resolve}` for each site with a
catalog. The core owns the list file, its serialized atomic rewrites, the alias
registry and the hourly refresh; the plug-in's catalog parses and formats the lines and
knows the site (name resolution, follow before add, existence, former names, source
links, the names to refresh). Site code lives in the plug-ins only.

The server reads each list with the plug-in's `parseTargetLine`, the downloader's
parser, so the routes see exactly the targets that are recorded. Until 2026-11-19 the
server had parsers of its own that disagreed: they skipped lines the downloader
recorded (bare IDs, `http://` or query-string URLs, tab separators, bare usernames,
subdomains and non-numeric room IDs), so `remove` could not take them
off the list, and accepted some it never recorded. The server parses silently; the
downloader logs malformed lines. An entry without an ID (a username not yet resolved)
is known by its label, as the downloader keys it: `remove` and `member`
match it by that label. New lines are written by `formatTargetLine`, byte-identical to
before (pinned with each plug-in).

## Providers are the sites file's capture sites

The recordings the server serves (`/api/videos`, `/hls`, edits, moves, the library
index, the finalizer's `.pending` roots, `finalize-library`) are those of the sites
file's capture sites, in its order (`configureProviders` at startup; `finalize-library`
loads the sites file itself). A request without a provider means the first one, and the
disk check measures its folder. A
disabled site's recordings are not served.

## Usernames resolved to stable IDs at write time

On a site whose usernames change, adding a streamer resolves the username once (the
catalog's resolution) and stores the stable numeric ID next to it in the list line.
Membership and removal resolve names to IDs. An hourly refresh asks the site for the
current usernames of all listed IDs (in batches) and rewrites changed usernames.

**Why:** Usernames change; IDs don't. Polling by a stale username fails on
every cycle.

## AliasRegistry is server-only

AliasRegistry lives in the server core. Only the server reads and writes
`aliases.json`; catalogs see it as `ctx.aliases` (the SDK's `AliasBook`). The
downloader takes folder names from the site's list, which the server's alias refresh keeps
in sync. `GET /api/<site>/list` returns each listed streamer's ID with its current and
historical aliases (the catalog's `enrichList`), for a site whose catalog keeps history.
The file is not namespaced by site (its format is pinned).

`aliases.json` writes take a directory lock (`aliases.json.lock`,
`services/fileLock.ts`): `mkdir` is atomic, and `holder.json` inside records
the holder's PID and timestamp. A holder older than 30 seconds or whose PID is
not alive (`kill(pid, 0)`) is stale and removed at once. An unreadable or
missing holder is a lock mid-creation, retried every 50 ms up to 5 seconds,
until the lock directory itself is older than 30 seconds: then it is a power cut
between `mkdir` and the holder write, and it is stale too, so it cannot block
every later write. `aliases.json` is replaced through `core/durableFile.ts`
(temporary file, fsync, rename, directory fsync).

## Alias refresh: hourly batch + list sync

`services/aliasRefreshService.ts` runs each catalog's `refreshAliases` at start and
then at its interval (hourly, typically), and rewrites the list with
`renameListedTargets` (`services/listRenames.ts`): a line whose ID has a new current
name is written again by `formatTargetLine`, every other line keeps its bytes.

- A catalog that keeps history (`keepHistory`): its followed accounts plus every listed
  account, their profiles in batches of the API's per-request maximum, persisted to
  `aliases.json`; the list then takes each ID's current alias from the registry. Logged
  by `[AliasRegistry]` (`<list> sync: <id> <old> -> <new>`, `Periodic refresh failed: ...`).
- Any other: every listed ID, in batches; the list takes the usernames this refresh
  returned.

The downloader's target manager picks up the change through its directory watch.

## Download lists are replaced atomically, one change at a time

The +/- routes and the alias syncs all change a list
through `mutateTextFile` (`core/durableFile.ts`). The read, the decision and the
write are one step serialized per file inside the server, and the write replaces
the file: temporary file, fsync, rename, directory fsync. Why: a list torn by a
power cut, or an entry dropped by two concurrent changes, ends that streamer's
live capture, since the downloader finalizes sessions missing from the list. The
An alias sync fetches usernames before taking that step and applies them to the
list as it is then, so an add or remove made during the fetch survives. The
downloader's target managers watch the list's directory, not the file, because
an atomic replacement orphans a watcher on the old file.

## Notes

- File-host downloads (`/api/<host>`, `src/fileHosts.ts`) are a separate, one-at-a-time
  durable byte-copy queue per file host of the sites file (`fileHosts`) into its folder,
  driven by the host's Safari extension (see `packages/sdk/src/fileHost.ts`).
  Jobs are acknowledged only after atomic write/fsync, retain `.part` bytes and
  data-before-metadata checkpoints, and publish only complete flushed files
  without overwriting existing destinations. Power-loss tails are retained and
  resume requires exact entity/range proof. The queue does not join the live
  library or upload campaign.
  The same HTTPS :9998 service exposes each host's local MP4 library through
  `/api/videos?provider=<host>`, `/api/videos/changes?provider=<host>` and
  `/media/<host>/:filename`. A directory watcher and safety scan find published
  files and manual removals; stat-matched duration metadata is cached outside the
  media folder. The original MP4 is streamed with HEAD and byte-range support,
  never buffered whole, transcoded or treated as an HLS recording. Hidden files,
  partials and symbolic links are excluded from listing and playback.
  Native Rename uses `POST /api/<host>/files/:id/rename` with an expected filename.
  IDs are derived from device/inode/birth time and remain stable when a file is
  renamed. `/media/<host>/id/:id` supports seeking without tying an active player
  to its display name; durable aliases preserve older filename URLs. Renames
  create a non-overwriting hard link, flush it, update the matching completed
  download receipts and aliases, then remove only the original link to that same
  file. A durable journal completes interrupted work, and respects removals of
  an already-published destination. Original media bytes are never rewritten.

- The API server uses HTTPS with the mkcert certificate in
  `~/.local/share/mkcert/pwa/` and falls back to HTTP when it is missing.
- The live extensions and the viewer's +/- button drive the download
  lists through the `/api/{provider}/member|exists|add|remove` endpoints; the
  extensions send these requests from their background page, so page security
  policies never apply.
